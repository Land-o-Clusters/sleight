// The window guard reads the whole tree with diffing off after every js action,
// so the lease can check the window header (document-scope.mjs guardedCode).
// That read is also the engine's new diff baseline. Sending it whole costs
// tokens on every click: a browser page resends its sidebar each time.
//
// The relay keeps, per window, the last full tree it forwarded to Claude, and
// replaces a guard read with the lines that changed since then. Claude's view
// stays the latest full tree (what it saw plus every change since), which is
// the engine's baseline, so the engine's next diff starts from what Claude
// knows. Any full tree Claude reads itself also becomes the copy.
//
// Pages that load content renumber every element after the new ones. Lines
// are matched by their text without the element number, and elements whose
// only change is their number are left out and counted. Their old numbers are
// stale, so the relay tracks which numbers Claude has seen since its last full
// read and refuses actions on any other (staleIndex).

import { GUARD_END, GUARD_MARK, documentKey, windowFromText, hasIdentifier, hasLabel } from './document-scope.mjs';
import { pathToFileURL } from 'node:url';

export { GUARD_END, GUARD_MARK };
const MAX_LINES = 3000; // above this, the line diff costs more than it saves
const MAX_SHARE = 0.6; // a diff longer than this share of the tree is sent whole
const ELEMENT = /^(\t*)(\d+) (.*)$/;

// number -> text without the number, for every element line.
const numbered = lines => lines.map(parse).filter(l => l.num !== undefined).map(l => [l.num, l.key]);

// An element line's number and its text without the number.
function parse(line) {
  const m = ELEMENT.exec(line);
  return m ? { num: Number(m[2]), key: `${m[1]}${m[3]}` } : { num: undefined, key: line };
}

// Under load Calculator can return `button Two` instead of its description and ID.
// Fold only a button's unique ID, never a lost value, state, indentation or guessed label.
function degradedButton(full, bare) {
  const m = /^(\t*)button ([^,:]+)$/.exec(bare);
  return !!m && full.startsWith(m[1] + 'button ') && !/\(|\bValue:/.test(full) &&
    full !== bare && hasIdentifier(full, m[2]);
}
const bareButtonId = key => /^\t*button ([^,:]+)$/.exec(key)?.[1];
const buttonHasId = (key, id) => /^\t*button /.test(key) &&
  (bareButtonId(key) === id || hasIdentifier(key, id));

// The alignment of two trees by longest common subsequence of their keys,
// after trimming the shared head and tail: [beforeIndex, afterIndex] pairs,
// with -1 where a line has no partner.
export function alignLines(before, after, key = line => line) {
  const a = before.map(key), b = after.map(key);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail, m = b.length - head - tail;
  if (n > MAX_LINES || m > MAX_LINES) return undefined;
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[head + i] === b[head + j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const pairs = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) { pairs.push([head + i, head + j]); i++; j++; }
    else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) pairs.push([head + i++, -1]);
    else pairs.push([-1, head + j++]);
  }
  for (let k = 0; k < tail; k++) pairs.push([a.length - tail + k, b.length - tail + k]);
  return pairs;
}

export function lineDiff(before, after) {
  return alignLines(before, after)?.filter(([i, j]) => i < 0 || j < 0)
    .map(([i, j]) => (j < 0 ? '- ' + before[i] : '+ ' + after[j]));
}

// Recognize literal native calls without treating strings or comments as actions. This is
// advisory, like the window headers themselves; computed methods and aliases are not receipts.
function actionKind(code, before) {
  if (typeof code !== 'string') return undefined;
  const masked = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    value => ' '.repeat(value.length));
  const calls = [...masked.matchAll(/\.\s*(click|setValue|selectText|performSecondaryAction|scroll|drag|pressKey|typeText|paste)\s*\(/g)];
  if (!calls.length) return undefined;
  const receiver = call => /([A-Za-z_$][\w$]*)\s*$/.exec(masked.slice(0, call.index))?.[1];
  const literal = args => /^\s*['"]([^'"\\]*)['"]\s*(?:,|$)/.exec(args)?.[1];
  const savePanel = /\b(?:sheet|dialog)\b.*\b(?:save-panel|save)\b/i.test(before?.root ?? '');
  let save = false, opens = false, navigates = false, deletes = false, saveCall, saveHandle;
  let folderHandle, folder, fileName, nameHandle;
  for (const call of calls) {
    const args = code.slice(call.index + call[0].length).split(')')[0];
    let isSave = false;
    if (call[1] === 'pressKey') {
      const key = literal(args) ?? '';
      isSave = /^(?:super|cmd|command)\+s$/i.test(key) ||
        (/^(?:return|enter)$/i.test(key) && savePanel);
      deletes ||= /^(?:fn\+)?(?:delete|backspace|forwarddelete)$/i.test(key);
      if (savePanel && /^(?:super|cmd|command)\+shift\+g$/i.test(key)) folderHandle = receiver(call);
      opens ||= key.includes('+') || /^(?:return|enter|escape|esc)$/i.test(key);
      navigates ||= !isSave && /^(?:(?:super|cmd|command)\+(?:[a-z]+\+)*[now]|return|enter|escape|esc)$/i.test(key);
    }
    if (call[1] === 'click') {
      opens = true;
      const number = /^\s*(\d+)\s*(?:,|$)/.exec(args)?.[1];
      const line = number && before?.lines.find(line => parse(line).num === Number(number));
      isSave = (!!line && hasLabel(parse(line).key.trim(), 'Save')) ||
        /^\s*\{\s*(?:label|id|line)\s*:\s*['"](?:Save|button Save)['"]\s*\}/.test(args);
      navigates ||= !isSave;
    }
    if (savePanel && call[1] === 'typeText' && folderHandle && receiver(call) === folderHandle) {
      const value = literal(args); if (value?.startsWith('/')) folder = value;
    }
    if (savePanel && call[1] === 'setValue') {
      const named = /^\s*(\{\s*id\s*:\s*['"]saveAsNameTextField['"]\s*\}|\d+)\s*,([\s\S]*)/.exec(args);
      const line = named && /^\d+$/.test(named[1]) && before.lines.find(line => parse(line).num === Number(named[1]));
      if (named && (named[1].startsWith('{') || (line && hasIdentifier(line, 'saveAsNameTextField')))) {
        fileName = literal(named[2]); nameHandle = receiver(call);
      }
    }
    if (isSave) { save = true; saveCall = call; saveHandle = receiver(call); }
  }
  const otherRead = save && [...masked.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*(?:getAXState|getAXStateAndScreenshot|getScreenshot)\s*\(/g)]
    .some(read => read[1] !== saveHandle);
  const acquisitionAfterSave = save && [...masked.matchAll(/\bcua\s*\.\s*getApp\s*\(/g)].some(read => read.index > saveCall.index);
  const namedURL = save && folder && fileName && !/[\/]/.test(fileName) && !['.', '..'].includes(fileName) &&
    folderHandle === saveHandle && nameHandle === saveHandle ? pathToFileURL(folder + '/' + fileName).href : undefined;
  return { save, opens, deletes, namedURL, mixedSave: save && (navigates || calls.at(-1) !== saveCall || otherRead || acquisitionAfterSave ||
    calls.some(call => receiver(call) !== saveHandle)) };
}

// Compare state itself, so losing Help or renaming an unselected row cannot become a value change.
function stateFields(line) {
  const fields = [];
  for (const pattern of [/\bValue: ?(.*?)(?=, (?:Secondary Actions|ID|Help|Description):|$)/,
    /;value:([^,]*)/, /\bSelected text: (.*?)(?=, (?:Secondary Actions|ID|Help|Description):|$)/]) {
    const match = pattern.exec(line); if (match) fields.push(match[0].startsWith('Selected') ? 'text:' + match[1] : 'value:' + match[1]);
  }
  const flags = /\(([^)]*)\)/.exec(line)?.[1] ?? '';
  if (/\b(?:selected|selectable)\b/.test(flags)) fields.push('selected:' + /\bselected\b/.test(flags));
  if (/\b(?:checked|checkable)\b/.test(flags)) fields.push('checked:' + /\bchecked\b/.test(flags));
  return fields;
}
const attributes = line => (line.match(/\b(?:Help|Description|ID):/g) ?? []).length;
const panel = line => /(?:^|\t)(?:sheet|dialog)\b/.test(line);
const edited = title => /(?: — | - )Edited$/.test(title);
const withoutValue = line => line.replace(/(?:, )?Value: ?.*?(?=, (?:Secondary Actions|ID|Help|Description):|$)/, '')
  .replace(/, (?=(?:Secondary Actions|ID|Help|Description):)/g, ' ').replace(/ +/g, ' ').trimEnd();

function resultNote(action, after, failed) {
  const before = action.before;
  const invalidRead = after?.invalid;
  if (invalidRead) after = undefined;
  let reason = failed ? 'call failed' : action.overlap ? 'overlapping calls' : !after ? invalidRead ?? 'no read after input'
    : !before ? 'no earlier read' : before.window.app !== after.window.app ? 'another app' : undefined;
  const windowChanged = !reason && action.opens &&
    (before.window.title !== after.window.title || before.window.url !== after.window.url);
  let ui = windowChanged ? 'UI changed (window)' : undefined;
  const incomplete = before?.incomplete || after?.incomplete;
  const sameDocument = before && after && /^standard window\b/.test(before.root) &&
    before.window.url?.startsWith('file://') && before.window.url === after.window.url;
  const modifiedCleared = sameDocument && /\b(?:Modified|Edited): true\b/i.test(before.root) &&
    /\b(?:Modified|Edited): false\b/i.test(after.root);
  const degraded = after?.delta?.degraded || (after?.delta?.lostState && !(action.deletes && after.delta.clearedValue));
  if (!ui) {
    reason ||= incomplete ? 'incomplete read' : degraded ? 'degraded read'
      : after?.delta?.baseline !== before ? 'comparison unavailable' : undefined;
    if (!reason && after.delta.panel) ui = 'UI changed (sheet or dialog)';
    if (!reason && (after.delta.semantic || (action.deletes && after.delta.clearedValue))) ui = 'UI changed (value)';
    if (!reason && action.save && modifiedCleared) ui = 'UI changed (modified state)';
    if (!reason && after.delta.element) ui ||= 'UI changed (element)';
    if (reason) ui = `UI unverified (${reason})`;
  }
  let saved;
  if (action.save) {
    const unavailable = failed ? 'call failed' : action.overlap ? 'overlapping calls' : action.mixedSave ? 'mixed save targets' : !after ? invalidRead ?? 'no read after input'
      : !before ? 'no earlier read' : before.window.app !== after.window.app ? 'another app'
        : incomplete ? 'incomplete read' : degraded ? 'degraded read' : undefined;
    const document = after && /^standard window\b/.test(after.root) && !/\b(?:save|open)-panel\b/.test(after.root);
    const editedTitleCleared = sameDocument && edited(before.window.title) && !edited(after.window.title) &&
      before.window.title.replace(/(?: — | - )Edited$/, '') === after.window.title && before.window.url === after.window.url;
    const named = action.namedURL && action.namedURL === after?.window.url;
    saved = unavailable ? `not confirmed (${unavailable})` : !document ? 'not confirmed (no document save state change seen)'
      : !sameDocument && !named ? `not confirmed (${after.window.url ? 'different document' : 'document identity unavailable'})`
      : modifiedCleared || editedTitleCleared ? `observed ${JSON.stringify(after.window.url)} (modified state cleared; cause unknown)`
      : named ? `observed ${JSON.stringify(after.window.url)} (named file URL)` : 'not confirmed (no document save state change seen)';
  }
  const fields = [failed ? 'call failed (partial input possible)' : ui, saved && 'saved: ' + saved].filter(Boolean);
  return fields.length ? 'sleight: ' + fields.join('; ') + '.' : undefined;
}

export function createReadCompactor() {
  // window key -> { lines, valid }: the last full tree Claude got, and the
  // element numbers in it Claude knows are current (undefined: all of them).
  const seen = new Map();
  let latest, observedInResult;
  function observe(tree, window, lines) {
    const observation = { window, lines, root: parse(lines[1] ?? '').key,
      incomplete: !ELEMENT.test(lines[1] ?? '') || /…\(\d+\)|sleight: (?:lines changed|no change since)/.test(tree) };
    latest = observedInResult = observation;
    return observation;
  }

  function compact(tree, prefix) {
    const window = windowFromText(tree);
    const lines = tree.replace(/\n+$/, '').split('\n');
    if (!window) {
      latest = undefined;
      observedInResult = { invalid: tree.includes('Window: ') ? 'ambiguous window read' : 'missing window header' };
      return tree;
    }
    const key = documentKey(window);
    const before = seen.get(key);
    const observation = observe(tree, window, lines);
    seen.set(key, { lines, observation });
    if (!before) return tree;
    const old = before.lines.map(parse), now = lines.map(parse);
    const keys = now.map(line => line.key);
    const degraded = new Set();
    for (let j = 0; j < now.length; j++) {
      const id = bareButtonId(now[j].key);
      if (now[j].num === undefined || id === undefined) continue;
      const matches = old.filter(line => line.num !== undefined && degradedButton(line.key, now[j].key));
      if (matches.length === 1 && [old, now].every(lines =>
        lines.filter(line => line.num !== undefined && buttonHasId(line.key, id)).length === 1)) {
        keys[j] = matches[0].key; degraded.add(j);
      }
    }
    const pairs = alignLines(old.map(line => line.key), keys);
    if (!pairs) return tree;
    // What Claude takes each number to be: the full tree it saw, plus the lines shown since.
    const believed = new Map(before.believed ?? numbered(before.lines));
    const valid = new Set(), changes = [];
    let renumbered = 0, fewerAttributes = 0, removedAttributes = 0, addedAttributes = 0, changedPanel = false;
    const removedState = [], addedState = [], removedNodes = new Map(), addedNodes = new Map();
    for (const [i, j] of pairs) {
      if (j < 0) {
        const fields = stateFields(old[i].key); removedState.push(...fields); removedAttributes += attributes(old[i].key);
        removedNodes.set(old[i].num ?? withoutValue(old[i].key), { ...old[i], fields });
        changedPanel ||= panel(old[i].key);
        changes.push('- ' + (old[i].num === undefined ? before.lines[i] : old[i].key));
        if (old[i].num !== undefined && believed.get(old[i].num) === old[i].key) believed.delete(old[i].num);
        continue;
      }
      const { num } = now[j];
      if (i < 0) {
        const fields = stateFields(now[j].key); addedState.push(...fields); addedAttributes += attributes(now[j].key); changedPanel ||= panel(now[j].key);
        addedNodes.set(num ?? withoutValue(now[j].key), { ...now[j], fields });
        changes.push('+ ' + lines[j]); if (num !== undefined) { valid.add(num); believed.set(num, now[j].key); } continue;
      }
      if (num === undefined) continue;
      if (degraded.has(j)) fewerAttributes++;
      if (num !== old[i].num) renumbered++;
      else if (!before.valid || before.valid.has(num)) valid.add(num);
    }
    let clearedFields = 0, element = false;
    for (const [number, was] of removedNodes) {
      const now = addedNodes.get(number);
      if (!now) continue;
      element ||= was.num !== undefined;
      if (/\btext (?:entry area|field)\b/.test(was.key) && withoutValue(was.key) === withoutValue(now.key) &&
          !now.fields.some(field => field.startsWith('value:'))) clearedFields += was.fields.filter(field => field.startsWith('value:')).length;
    }
    observation.delta = { baseline: before.observation,
      semantic: removedState.length > 0 && addedState.length > 0 && JSON.stringify(removedState.sort()) !== JSON.stringify(addedState.sort()),
      panel: changedPanel, renumbered, element,
      lostState: removedState.length > addedState.length,
      clearedValue: clearedFields > 0 && clearedFields >= removedState.length - addedState.length,
      degraded: fewerAttributes > 0 || removedAttributes > addedAttributes };
    // Numbers Claude saw in this same result, on a line identical to the
    // current tree's, are current too (its own reads, the engine's diff).
    const current = new Map(now.filter(l => l.num !== undefined).map(l => [l.num, l.key]));
    for (const line of prefix.split('\n')) {
      const shown = parse(line.replace(/^[+~] ?/, ''));
      if (shown.num !== undefined && current.get(shown.num) === shown.key) { valid.add(shown.num); believed.set(shown.num, shown.key); }
    }
    const header = lines.slice(0, 2).join('\n');
    const body = changes.length
      ? `sleight: lines changed since the last full tree you saw for this window (- removed, + added; numbers on + lines are current):\n${changes.join('\n')}`
      : 'sleight: no change since the last full tree you saw for this window' + (renumbered ? ', apart from numbering.' : '.');
    const note = renumbered
      ? `\nsleight: ${renumbered} other elements have new numbers. Use numbers from + lines above or from a full read. Read the window again with getAXState({ disableDiffing: true }) before acting on any other element; sleight refuses actions on numbers that changed.`
      : '';
    const degradedNote = fewerAttributes ? `\nsleight: ${fewerAttributes} button lines returned fewer attributes. Their unique IDs still match; missing descriptions and help are unavailable in this read.` : '';
    const text = `${header}\n${body}${note}${degradedNote}`;
    if (text.length > tree.length * MAX_SHARE) return tree;
    const allValid = [...current.keys()].every(num => valid.has(num));
    seen.set(key, { lines, observation, valid: allValid ? undefined : valid, believed: allValid ? undefined : believed });
    return text;
  }

  // Remembers the last full tree in a stretch of output Claude sees: from the
  // last line that starts with a Window header to the end.
  function remember(text) {
    const starts = [...text.matchAll(/^Window: /gm)];
    if (!starts.length) return;
    const tree = text.slice(starts.at(-1).index).replace(/\n+$/, '');
    const window = windowFromText(tree);
    if (window) {
      const lines = tree.split('\n');
      seen.set(documentKey(window), { lines, observation: observe(tree, window, lines) });
      if (starts.length > 1 && !windowFromText(text)) { latest = undefined; observedInResult = { invalid: 'ambiguous window read' }; }
    }
  }

  return {
    // Rewrites a result's text items. Everything one js call writes arrives
    // as one item, so marked trees (Claude's reads and the guard's) sit among
    // Claude's other output. Each is compacted against what Claude saw before it.
    process(content, { forceFull = false, action, failed = false } = {}) {
      if (!Array.isArray(content)) return content;
      observedInResult = undefined;
      const out = content.map(item => {
        if (item?.type === 'text' && /sleight: an action in this call failed|engine's JavaScript session restarted|## Computer Use\n/.test(item.text ?? '')) failed = true;
        if (item?.type !== 'text' || typeof item.text !== 'string' || !item.text.includes(GUARD_MARK)) {
          if (item?.type === 'text' && typeof item.text === 'string') remember(item.text);
          return item;
        }
        let out = '', seenText = '', pos = 0;
        const add = text => { if (out && text && !out.endsWith('\n')) out += '\n'; out += text; };
        for (;;) {
          const at = item.text.indexOf(GUARD_MARK, pos);
          const plain = item.text.slice(pos, at < 0 ? undefined : at);
          remember(plain); seenText += plain; add(plain);
          if (at < 0) break;
          const start = at + GUARD_MARK.length, end = item.text.indexOf(GUARD_END, start);
          const tree = item.text.slice(start, end < 0 ? undefined : end);
          const sent = forceFull ? tree : compact(tree, seenText);
          if (forceFull) remember(tree);
          if (end < 0 && observedInResult && !observedInResult.invalid) observedInResult.incomplete = true;
          add(sent); seenText += '\n' + sent;
          if (end < 0) break;
          pos = end + GUARD_END.length;
        }
        return { ...item, text: out };
      });
      const note = action && resultNote(action, observedInResult, failed);
      if (note) out.push({ type: 'text', text: note });
      if (failed || (action && (!observedInResult || observedInResult.invalid || action.overlap))) latest = undefined;
      return out;
    },
    beginAction(code) {
      const kind = actionKind(code, latest);
      return kind && { ...kind, before: latest };
    },
    // What Claude takes these element numbers to be in this window, from what it was last shown:
    // number -> line text without its number, for the guard to check before the call's first action.
    seenLines(window, numbers) {
      const entry = window && seen.get(documentKey({ title: window.title, app: window.app, url: window.url }));
      if (!entry) return undefined;
      const believed = new Map(entry.believed ?? numbered(entry.lines));
      const out = {};
      for (const n of numbers) if (believed.has(n)) out[n] = believed.get(n).replace(/^\t*/, '');
      return Object.keys(out).length ? out : undefined;
    },
    // The first element number in `code` that Claude can't know is current
    // for this window: { number } for a literal, { computed } for an expression.
    staleIndex(window, code) {
      const valid = window && seen.get(documentKey({ title: window.title, app: window.app, url: window.url }))?.valid;
      if (!valid || typeof code !== 'string') return undefined;
      for (const [, arg] of code.matchAll(/\.(?:click|setValue|selectText|performSecondaryAction|scroll)\(\s*([^,)\s]+)/g)) {
        // Coordinates aren't element numbers, and an { id } is resolved fresh inside the call.
        if (arg.startsWith('[') || arg.startsWith('{')) continue;
        if (!/^\d+$/.test(arg)) return { computed: arg };
        if (!valid.has(Number(arg))) return { number: Number(arg) };
      }
      return undefined;
    },
    // A literal number Claude took from an older tree names the element it saw there. When that
    // element's text is on exactly one line of the current tree, the action can name it by that
    // line ({ line }), which the guard looks up fresh, instead of costing Claude a read and a turn.
    // Undefined unless every stale number in the call can be named that way.
    remapStale(window, code) {
      const entry = window && seen.get(documentKey({ title: window.title, app: window.app, url: window.url }));
      if (!entry?.valid || !entry.believed || typeof code !== 'string') return undefined;
      const texts = entry.lines.map(parse).filter(l => l.num !== undefined).map(l => l.key.replace(/^\t*/, ''));
      const remapped = [];
      let missing = false;
      const out = code.replace(/(\.(?:click|setValue|selectText|performSecondaryAction|scroll)\(\s*)(\d+)(?=\s*[,)])/g, (whole, head, digits) => {
        const number = Number(digits);
        if (entry.valid.has(number)) return whole;
        const believed = entry.believed.get(number)?.replace(/^\t*/, '');
        const matches = believed === undefined ? [] : texts.filter(t => t === believed || degradedButton(believed, t));
        if (matches.length !== 1) { missing = true; return whole; }
        const text = matches[0];
        if (text !== believed) {
          const id = bareButtonId(text);
          if (id === undefined || [texts, [...entry.believed.values()]].some(lines =>
            lines.filter(line => buttonHasId(line, id)).length !== 1)) { missing = true; return whole; }
        }
        remapped.push({ number, line: text });
        return head + JSON.stringify({ line: text });
      });
      return !missing && remapped.length ? { code: out, remapped } : undefined;
    },
    reset() { seen.clear(); latest = observedInResult = undefined; },
  };
}
