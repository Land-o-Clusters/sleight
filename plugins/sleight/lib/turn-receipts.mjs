import { lineCommentEnd, isLineTerminator } from './code-line-terminators.mjs';
// Keep references on the call path. All parsing, comparison, redaction and disk I/O happen at turn end.
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, lstatSync, writeFileSync, openSync, closeSync, fstatSync, readdirSync, unlinkSync, constants } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve, parse, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowFromText, GUARD_MARK, GUARD_OMIT_MARK, GUARD_END } from './document-scope.mjs';
import { isLeaseRead } from './input-lease.mjs';
import { withoutSecureFields, fieldObservation, compareFields, renderFields } from './unsaved-review.mjs';

const METHODS = new Set(['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText']);
const keyOf = window => JSON.stringify([window.app, window.title, window.url]);
const redacted = value => ({ redacted: true, length: typeof value === 'string' ? value.length : null });
const namedKey = /^(?:return|enter|escape|tab|space|backspace|delete|left|right|up|down|home|end|pageup|pagedown|f\d{1,2})$/i;
function ownerNames() {
  const names = [userInfo().username];
  // Once per enabled journal, never per call. Failure still leaves title redaction on.
  try { names.push(execFileSync('/usr/bin/id', ['-F'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch {}
  return names;
}
const digest = value => createHash('sha256').update(value).digest('base64');
function documentName(window) {
  try { return window?.url?.startsWith('file://') ? basename(fileURLToPath(window.url)) : undefined; } catch { return undefined; }
}

// A small lexer, never eval: opaque expressions remain unknown. Strings and comments are masked
// before finding method calls, so text containing JavaScript cannot invent an action in a receipt.
function lex(code) {
  const literals = new Map();
  let mask = '', i = 0;
  while (i < code.length) {
    const start = i, ch = code[i];
    if (ch === '/' && code[i + 1] === '/') {
      i = lineCommentEnd(code, i);
    } else if (ch === '/' && code[i + 1] === '*') {
      i = code.indexOf('*/', i + 2); i = i < 0 ? code.length : i + 2;
    } else if (ch === '/' && (!mask.trimEnd() || /[=(:,!&|?{};\[]$/.test(mask.trimEnd()) || /\b(?:return|throw|case)$/.test(mask.trimEnd()))) {
      i++;
      let bracket = false;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (isLineTerminator(code[i])) break;
        if (code[i] === '[') bracket = true;
        if (code[i] === ']') bracket = false;
        if (code[i++] === '/' && !bracket) break;
      }
      while (/[a-z]/i.test(code[i] ?? '') && i < code.length) i++;
    } else if ('"\'`'.includes(ch)) {
      i++;
      let value = '', known = true;
      while (i < code.length && code[i] !== ch) {
        if (ch === '`' && code[i] === '$' && code[i + 1] === '{') known = false;
        if (code[i] !== '\\') {
          if (ch === '`' && code[i] === '\r') { i++; if (code[i] === '\n') i++; value += '\n'; }
          else value += code[i++];
          continue;
        }
        const next = code[++i]; i++;
        if (isLineTerminator(next)) { if (next === '\r' && code[i] === '\n') i++; continue; }

        if (next === 'u' || next === 'x') {
          const braces = next === 'u' && code[i] === '{';
          const end = braces ? code.indexOf('}', i) : i + (next === 'u' ? 4 : 2);
          if (end < i || end > code.length) { known = false; i = code.length; break; }
          const hex = code.slice(i + (braces ? 1 : 0), end);
          if (/^[\da-f]+$/i.test(hex) && Number.parseInt(hex, 16) <= 0x10ffff) value += String.fromCodePoint(Number.parseInt(hex, 16));
          else known = false;
          i = end + (braces ? 1 : 0);
        } else value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\n': '' })[next] ?? next ?? '';
      }
      if (code[i] === ch) i++; else known = false;
      literals.set(start, known ? value : undefined);
    } else { mask += ch; i++; continue; }
    mask += ' '.repeat(i - start);
  }
  return { mask, literals };
}

function actionsOf(code, secrets) {
  const { mask, literals } = lex(code);
  const actions = [];
  for (const match of mask.matchAll(/\.\s*(\w+)\s*\(/g)) {
    const action = match[1];
    if (!METHODS.has(action)) continue;
    const start = match.index + match[0].length;
    let end = start, depth = 1;
    while (end < mask.length && depth) { if (mask[end] === '(') depth++; if (mask[end] === ')') depth--; end++; }
    const args = code.slice(start, end - 1);
    const values = [...literals].filter(([at]) => at >= start && at < end).map(([, value]) => value);
    const entry = { action, result: 'unknown' };
    if (['typeText', 'paste', 'selectText', 'setValue'].includes(action)) {
      const value = action === 'setValue' ? values.at(-1) : values[0];
      entry.input = redacted(value);
      if (typeof value === 'string' && value.length) secrets.add(value);
    }
    if (action === 'pressKey') {
      const key = values[0];
      const shortcut = typeof key === 'string' && /^(?:(?:super|cmd|command|ctrl|control|alt|option|shift)\+)+(.+)$/i.exec(key);
      // Shift or Option with a printable key types a character (a capital, an accent), so it's text.
      const command = shortcut && /(?:^|\+)(?:super|cmd|command|ctrl|control)\+/i.test(key);
      entry.key = typeof key === 'string' && (namedKey.test(key) || (shortcut && (namedKey.test(shortcut[1]) || (command && /^[^\p{C}]$/u.test(shortcut[1])))))
        ? key : redacted(key);
    }
    if (['click', 'setValue', 'scroll', 'performSecondaryAction', 'drag'].includes(action)) {
      const number = /^\s*(\d+)\s*(?:,|$)/.exec(args);
      const point = /^\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/.exec(args);
      entry.target = number ? { element: Number(number[1]) }
        : point ? { position: point.slice(1).map(Number) } : { expression: 'redacted', length: args.length };
    }
    actions.push(entry);
  }
  return actions;
}

function observation(content, review) {
  let text = typeof content === 'string' ? content : (content ?? []).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
  // Prefer the existing guard's final full tree to intermediate output or the engine's diff.
  const marker = text.lastIndexOf(GUARD_OMIT_MARK) > text.lastIndexOf(GUARD_MARK) ? GUARD_OMIT_MARK : GUARD_MARK;
  const mark = text.lastIndexOf(marker);
  if (mark >= 0) {
    const end = text.indexOf(GUARD_END, mark + marker.length);
    if (end < 0) return undefined;
    text = text.slice(mark + marker.length, end);
  }
  const window = windowFromText(text);
  if (!window) return undefined;
  const safe = withoutSecureFields(text);
  text = safe.text;
  const lines = text.split('\n');
  const full = lines.filter(line => /^\t*\d+ /.test(line));
  const diff = lines.filter(line => /^[+~\-] ?\t*\d+ /.test(line));
  // Keep comparison hashes and fixed control labels, not document text between turns.
  const revert = [...new Set(full.filter(line => !/disabled/i.test(line)).flatMap(line =>
    /^\t*\d+ (?:menu item|button) (?:Description: )?(Revert [Tt]o Saved|Undo(?: Typing| Paste| Cut| Delete)?)(?=,|$)/.exec(line)?.[1] ?? []))];
  const fields = review && !safe.selectionInvalid ? fieldObservation(text, safe.excluded, safe.selection) : undefined;
  return { window, ...(review ? { fields } : {}), full: full.map(line => digest(line.replace(/^(\t*)\d+ /, '$1'))),
    values: fields ? fields.fields.flatMap(field => Object.values(field.properties).map(value => value.fingerprint))
      : [...full.filter(line => /\bValue:/.test(line)).map(digest), ...(safe.selection ? [safe.selection.fingerprint] : [])], diff: diff.length, revert,
    unchanged: /sleight: no change since the last full tree/.test(text),
    modified: /\b(?:Edited|Modified|Unsaved)\b/i.test(window.title) || /\b(?:AXDocumentEdited|DocumentEdited|modified): (?:true|1)/i.test(text) };
}

function compare(before, after) {
  if (!before || !after || keyOf(before.window) !== keyOf(after.window)) return { change: 'unknown', detail: 'No matching before and after window observation.' };
  if (after.diff) return { change: 'changed', detail: `${after.diff} changed accessibility lines.` };
  if (!before.full.length || !after.full.length) {
    if (after.unchanged) return { change: 'unchanged', detail: 'The last result reports no UI change.' };
    return { change: 'unknown', detail: 'The result has no comparable full tree.' };
  }
  const a = before.full, b = after.full;
  const changed = a.filter((line, i) => line !== b[i]).length + Math.max(0, b.length - a.length);
  const beforeValues = before.values, afterValues = after.values;
  const valueChanges = afterValues.filter((line, i) => line !== beforeValues[i]);
  return { change: changed || valueChanges.length ? 'changed' : 'unchanged', detail: `${changed} accessibility lines changed; ${valueChanges.length} value fields changed (contents redacted).` };
}

export class TurnJournal {
  constructor({ home = homedir(), ownerNames: names = ownerNames(), redactTitles = true, limit = 2000 } = {}) {
    this.home = home; this.ownerNames = names; this.redactTitles = redactTitles; this.limit = limit;
    this.events = []; this.calls = new Map(); this.last = undefined; this.omitted = 0; this.count = 0;
  }
  request(msg) {
    if (msg.method !== 'tools/call' || msg.params?.name === 'turn_ended') return;
    if (this.count >= this.limit) { this.omitted++; return; }
    this.count++;
    const call = { id: msg.id, name: msg.params?.name, code: msg.params?.arguments?.code, args: msg.params?.arguments };
    this.calls.set(msg.id, call); this.events.push({ call });
  }
  // A reconnect ends the turn under a call it is about to replay: take the call out before finish() and put it back after.
  take(id) {
    const call = this.calls.get(id);
    if (!call) return undefined;
    this.calls.delete(id); this.events = this.events.filter(event => event.call !== call); this.count--;
    return call;
  }
  put(call) { if (call) { this.count++; this.calls.set(call.id, call); this.events.push({ call }); } }
  observe(id, text) { const call = this.calls.get(id); if (call) call.text = text; }
  reply(msg) {
    const call = this.calls.get(msg.id);
    if (!call || msg.method !== undefined) return;
    this.calls.delete(msg.id);
    call.reply = { failed: !!(msg.error || msg.result?.isError) };
    if (call.text === undefined) call.content = msg.result?.content;
    this.events.push({ call, response: true });
  }
  finish({ session, turn, review = false } = {}) {
    const events = this.events, calls = events.filter(event => !event.response).map(event => event.call), omitted = this.omitted;
    this.events = []; this.calls = new Map(); this.omitted = 0; this.count = 0;
    const secrets = new Set(), summaries = [], windows = new Map(), baselines = new Map();
    let current = this.last, pending = 0;
    const overlaps = new Set();
    for (const event of events) {
      const { call } = event;
      if (!event.response) {
        const code = call.code ?? '';
        const actions = call.name === 'js' ? actionsOf(code, secrets) : [{ action: ['drag', 'hover', 'menu_bar', 'select_window', 'notifications'].includes(call.name) ? call.name : 'opaque tool call', target: { expression: 'redacted' }, result: 'unknown' }];
        const args = call.args ?? {};
        const read = call.name === 'js' ? isLeaseRead(code) : ['read', 'list', 'apps'].includes(args.op);
        call.summary = { tool: call.name === 'js' ? 'js' : actions[0].action, app: current?.window.app ?? null, window: current?.window.title ?? null, document: documentName(current?.window),
          actions: actions.length ? actions : [{ action: read ? 'read' : 'opaque JavaScript', result: 'unknown' }], result: 'pending; outcome unknown', change: 'unknown' };
        call.before = !read && /\bcua\.(?:getApp|getTab)\(/.test(lex(code).mask) ? undefined : current;
        if (call.name !== 'js') {
          call.localTarget = { app: typeof args.app === 'string' ? args.app : null, title: typeof args.windowTitle === 'string' ? args.windowTitle : null, url: null };
          call.before = current?.window.app === args.app && (!args.windowTitle || args.windowTitle === current.window.title) ? current : undefined;
          call.summary.app = call.localTarget.app; call.summary.window = call.localTarget.title;
          const point = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) ? value : undefined;
          const endpoint = (value, from) => point(value) || (value && typeof value === 'object' && Object.keys(value).length === 1 &&
            typeof value.line === 'string' ? { line: redacted(value.line) } : undefined) || (Number.isSafeInteger(value) && value >= 0 ? value :
            from && value === 'the current text selection' ? value :
              !from && typeof value === 'string' && /^end of line [1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.slice(12))) ? value : undefined);
          actions[0].target = { ...(endpoint(args.from, true) !== undefined ? { from: endpoint(args.from, true) } : {}),
            ...(endpoint(args.to, false) !== undefined ? { to: endpoint(args.to, false) } : {}),
            ...(point(args.at) ? { position: point(args.at) } : {}), ...(Number.isInteger(args.element) ? { element: args.element } : {}),
            ...(Array.isArray(args.path) ? { path: args.path.map(redacted) } : {}) };
          for (const name of ['text', 'value']) if (typeof args[name] === 'string') { actions[0].input = redacted(args[name]); if (args[name].length) secrets.add(args[name]); }
        }
        delete call.code; delete call.args;
        call.mutating = !read;
        call.overlap = pending > 0;
        if (pending) { overlaps.add(call); for (const other of calls.values()) if (other.started && !other.completed) overlaps.add(other); }
        pending++; call.started = true;
        summaries.push(call.summary);
        continue;
      }
      if (call.completed) continue;
      call.completed = true; pending--;
      const failed = call.reply.failed;
      const after = observation(call.text ?? call.content, review);
      delete call.text; delete call.content;
      const before = call.before;
      const summary = call.summary;
      const target = call.mutating ? before?.window ?? call.localTarget ?? after?.window : call.localTarget ?? after?.window;
      if (target) { summary.app = target.app; summary.window = target.title; summary.document = documentName(target); }
      summary.result = failed ? 'error; actions may have run' : 'returned';
      const difference = failed || overlaps.has(call) ? { change: 'unknown', detail: failed ? 'Call failed; partial input is possible.' : 'Overlapping calls prevent attribution.' } : compare(before, after);
      summary.change = difference.change;
      summary.detail = difference.detail;
      if (call.mutating && target) {
        const key = keyOf(target), entry = windows.get(key) ?? { before: baselines.get(key) ?? before, after: before, uncertain: false, window: target };
        entry.after = after; entry.uncertain ||= failed || overlaps.has(call) || !after || keyOf(after.window) !== key;
        windows.set(key, entry);
      } else if (call.mutating) {
        windows.set(`unknown-${summaries.indexOf(summary)}`, { window: { app: null, title: null }, uncertain: true });
      }
      if (!call.mutating && (failed || overlaps.has(call) || !after)) {
        const entry = before && windows.get(keyOf(before.window));
        if (entry) { entry.uncertain = true; entry.after = undefined; }
        current = undefined;
      }
      if (after && !failed && !overlaps.has(call)) {
        const key = keyOf(after.window);
        if (!baselines.has(key)) baselines.set(key, call.mutating ? before : after);
        if (!call.mutating && windows.has(key)) windows.get(key).after = after;
        current = after;
      }
      else if (call.mutating) current = undefined;
    }
    for (const call of calls.values()) if (!call.completed && call.mutating) {
      const window = call.before?.window ?? call.localTarget ?? { app: null, title: null };
      windows.set(keyOf(window), { window, before: call.before, uncertain: true });
    }
    if (omitted) {
      for (const entry of windows.values()) entry.uncertain = true;
      windows.set('omitted', { window: { app: null, title: null }, uncertain: true });
    }
    this.last = omitted ? undefined : current;
    for (const call of calls) { delete call.text; delete call.content; delete call.before; delete call.localTarget; }
    const changes = [...windows.values()].map((entry, index) => {
      const difference = entry.uncertain ? { change: 'unknown', detail: 'No trustworthy final observation; changes may have occurred.' } : compare(entry.before, entry.after);
      const controls = entry.uncertain ? [] : entry.after?.revert ?? [];
      return { app: entry.window.app, window: entry.window.title, document: documentName(entry.window), ...difference, modified: entry.after?.modified ?? false, revert: controls,
        ...(review ? { reviewWindow: index + 1, fields: compareFields(entry.before?.fields, entry.after?.fields,
          !entry.uncertain && entry.before && entry.after && keyOf(entry.before.window) === keyOf(entry.after.window)) } : {}) };
    });
    // A name echoes typed text whole (a Save panel names a file what was typed), so redact a value
    // only as the whole name or a whole word in one; a substring match shredded TextEdit itself.
    const nameSecrets = [...secrets].sort((a, b) => b.length - a.length).map(secret => {
      const source = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\uD800-\uDFFF]/g, unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
      return { pattern: new RegExp(`(^|[^\\p{L}\\p{N}])${source}(?=$|[^\\p{L}\\p{N}])`, 'gu'), marker: `[redacted ${secret.length} chars]` };
    });
    const owners = this.ownerNames.filter(Boolean).sort((a, b) => b.length - a.length)
      .map(owner => new RegExp(owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'));
    const scrub = (value, field) => {
      if (typeof value === 'string') {
        let clean = value;
        if (['window', 'app', 'document'].includes(field)) for (const { pattern, marker } of nameSecrets) clean = clean.replace(pattern, `$1${marker}`);
        clean = clean.replaceAll(this.home, '~');
        for (const owner of owners) clean = clean.replace(owner, '[owner]');
        return clean;
      }
      if (Array.isArray(value)) return value.map(item => scrub(item, field));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        key === 'window' && this.redactTitles && typeof item === 'string' ? redacted(item) : scrub(item, key)]));
      return value;
    };
    // Render the review after title redaction too; the prose never contains a hidden title.
    const receipt = scrub({ version: 1, session, turn, at: new Date().toISOString(), calls: summaries, windows: changes, omitted });
    if (review) receipt.review = (omitted ? `Partial review: ${omitted} calls omitted; final state is unknown.\n` : '') +
      (receipt.windows.map(w =>
        `Window ${w.reviewWindow}, ${w.app ?? 'Unknown app'}, ${this.redactTitles ? '[redacted window]' : JSON.stringify(w.window)}: ${w.change}${w.modified ? ', modified' : ''}. ${w.detail}\n${renderFields(w.fields)}\nLeave it as it is${w.revert.length ? `, or use ${w.revert.join(' / ')} in that app` : '; no native revert control was observed'}.`).join('\n') || 'No changed or modified windows observed in this turn.');
    return receipt;
  }
}

export function writeReceipt(receipt, { directory = join(homedir(), 'Library', 'Logs', 'sleight', 'receipts'), now = Date.now() } = {}) {
  // Check every existing parent so a symlink cannot redirect private receipt output.
  const absolute = resolve(directory), parts = absolute.slice(parse(absolute).root.length).split('/');
  let parent = parse(absolute).root;
  for (const part of parts) {
    parent = join(parent, part);
    try { if (!lstatSync(parent).isDirectory()) throw new Error('Receipt directory is not an ordinary directory (symlink refused)'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { mkdirSync(parent, { mode: 0o700 }); }
      catch (creation) {
        if (creation.code !== 'EEXIST') throw creation;
        if (!lstatSync(parent).isDirectory()) throw new Error('Receipt directory is not an ordinary directory (symlink refused)');
      }
    }
  }
  const stat = lstatSync(absolute);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Receipt directory must be user-owned and private (0700)');
  const path = join(absolute, `turn-${now}-${randomUUID()}.json`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (fstatSync(fd).uid !== process.getuid()) throw new Error('Receipt file has a different owner');
    writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n');
  } finally { closeSync(fd); }
  const files = [];
  for (const name of readdirSync(absolute)) {
    const match = /^turn-(\d+)-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.json$/.exec(name);
    if (!match) continue;
    const candidate = join(absolute, name);
    try {
      const stat = lstatSync(candidate);
      if (stat.isFile() && stat.uid === process.getuid()) files.push({ path: candidate, at: Number(match[1]) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; } // Another writer pruned it.
  }
  files.sort((a, b) => b.at - a.at || b.path.localeCompare(a.path));
  for (const [index, file] of files.entries()) {
    if (index < 200 && file.at >= now - 7 * 86400000) continue;
    try {
      const stat = lstatSync(file.path);
      if (stat.isFile() && stat.uid === process.getuid()) unlinkSync(file.path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path;
}
