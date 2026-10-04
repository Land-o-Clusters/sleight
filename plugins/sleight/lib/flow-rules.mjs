// Literal inspection is a mistake guard. Never evaluate the caller's code here.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowFromText } from './document-scope.mjs';

export const FLOW_TOOL = {
  name: 'flow_exception',
  description: 'Ask the user to allow the exact call most recently stopped by a flow rule, once. No decision arguments are accepted. Retry the identical call after approval; never work around a refusal.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
const error = message => new Error(`Flow rules: ${message}`);
const norm = app => typeof app === 'string' ? app.toLowerCase().replace(/^.*\//, '').replace(/\.app$/, '') : '';
const within = (file, root) => { const r = relative(root, file); return !r || (!r.startsWith('..') && !isAbsolute(r)); };
function projectRoot(cwd) {
  let dir = realpathSync(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return realpathSync(cwd);
    dir = parent;
  }
}

export function loadFlowRules(env = process.env, { cwd = process.cwd() } = {}) {
  const setting = env.SLEIGHT_FLOW_RULES;
  if (!setting || setting === '0') return undefined;
  try {
    const file = setting === '1' ? join(homedir(), 'Library', 'Application Support', 'sleight', 'flow-rules.json') : setting;
    if (!isAbsolute(file)) throw error('SLEIGHT_FLOW_RULES must be 1 or an absolute file path');
    const actual = realpathSync(file);
    const plugin = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
    if (within(actual, projectRoot(cwd)) || within(actual, plugin)) throw error('the user rules file must be outside the working project and plugin');
    return new FlowRules(JSON.parse(readFileSync(actual, 'utf8')));
  } catch (err) { throw error(err.message); }
}

// A small tokenizer, deliberately narrower than a JavaScript interpreter.
export function tokens(code) {
  const out = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) { i++; continue; }
    if (code.startsWith('//', i)) { i = code.indexOf('\n', i); if (i < 0) break; continue; }
    if (code.startsWith('/*', i)) { const end = code.indexOf('*/', i + 2); i = end < 0 ? code.length : end + 2; continue; }
    if (c === '/' && (!out.length || ['=', '(', ',', ':', 'return', '[', '!'].includes(out.at(-1).v))) {
      i++; let bracket = false;
      while (i < code.length) { const ch = code[i++]; if (ch === '\\') i++; else if (ch === '[') bracket = true; else if (ch === ']') bracket = false; else if (ch === '/' && !bracket) break; }
      while (/[a-z]/i.test(code[i] ?? '') && i < code.length) i++;
      out.push({ v: '<regexp>' }); continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; let value = ''; let dynamic = false; i++;
      while (i < code.length && code[i] !== quote) {
        const ch = code[i++];
        if (quote === '`' && ch === '$' && code[i] === '{') dynamic = true;
        if (ch !== '\\') { value += ch; continue; }
        const esc = code[i++];
        const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
        if (esc === '\n') continue;
        if (esc === '\r') { if (code[i] === '\n') i++; continue; }
        if (esc === 'x' || esc === 'u') {
          const brace = esc === 'u' && code[i] === '{'; if (brace) i++;
          const raw = brace ? code.slice(i, code.indexOf('}', i)) : code.slice(i, i + (esc === 'x' ? 2 : 4));
          if (/^[\da-f]+$/i.test(raw) && Number.parseInt(raw, 16) <= 0x10ffff) value += String.fromCodePoint(Number.parseInt(raw, 16));
          i += raw.length + (brace ? 1 : 0);
        } else value += simple[esc] ?? esc ?? '';
      }
      i++; out.push(dynamic ? { v: '<template>' } : { v: value, string: true }); continue;
    }
    const word = /^[\w$]+/.exec(code.slice(i));
    if (word) { out.push({ v: word[0] }); i += word[0].length; }
    else { out.push({ v: c }); i++; }
  }
  return out;
}

function calls(code, handles, fallback) {
  const ts = tokens(code); const inputs = []; let readApp = fallback;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].v === 'getApp' && ts[i + 1]?.v === '(' && ts[i + 2]?.string) {
      const target = ts[i + 2].v; readApp = target;
      // Find the receiver assigned to this acquisition, without executing it.
      const start = Math.max(ts.slice(0, i).findLastIndex(t => t.v === ';') + 1, 0);
      const eq = ts.slice(start, i).findIndex(t => t.v === '=');
      if (eq > 0) handles.set(ts[start + eq - 1].v, target);
    }
    const method = ts[i].v;
    if (!['typeText', 'paste', 'setValue', 'pressKey'].includes(method)) continue;
    const bracket = ts[i].string && ts[i - 1]?.v === '[' && ts[i + 1]?.v === ']';
    if (!bracket && ts[i - 1]?.v !== '.') continue;
    const receiver = ts[i - 2]?.v;
    const open = i + (bracket ? 2 : 1);
    if (ts[open]?.v !== '(') continue;
    const args = [[]]; let depth = 0; let j = open + 1;
    for (; j < ts.length; j++) {
      const t = ts[j];
      if (!t.string && t.v === ')' && depth === 0) break;
      if (!t.string && t.v === ',' && depth === 0) { args.push([]); continue; }
      if (!t.string && ['(', '[', '{'].includes(t.v)) depth++;
      if (!t.string && [')', ']', '}'].includes(t.v)) depth--;
      args.at(-1).push(t);
    }
    const arg = method === 'setValue' ? args[1] : (args[0]?.[0]?.string ? args[0] : args[1] ?? args[0]);
    const literals = (arg ?? []).filter(t => t.string).map(t => t.v);
    if (literals.length) inputs.push({ method, app: handles.get(receiver) ?? fallback, value: literals.join('') });
    i = j;
  }
  return { inputs, readApp };
}

function keyText(value) {
  if (value === '-') return '-';
  if (/\+/.test(value)) return undefined;
  const keys = value.split(/\s+/);
  const named = { minus: '-', space: ' ', Return: '\n', Enter: '\n', Tab: '\t', period: '.', comma: ',' };
  if (keys.some(k => k.length !== 1 && named[k] === undefined)) return undefined;
  return keys.map(k => named[k] ?? k).join('');
}
const strings = value => typeof value === 'string' ? [value] : (value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []);
function* regexMatches(regex, text) {
  const scan = new RegExp(regex.source, regex.flags + 'g');
  let match;
  while ((match = scan.exec(text))) {
    yield match;
    // An old match may overlap a new one. Advance past its start, not its end.
    scan.lastIndex = match.index + (regex.unicode && text.codePointAt(match.index) > 0xffff ? 2 : 1);
  }
}
function newPatternMatch(regex, value, combined, previousLength) {
  if (regex.test(value)) return true;
  // Compare old matches too: a new suffix can complete a lookahead without
  // extending the matched span. Ignore only matches that already existed.
  let oldMatches;
  const key = match => JSON.stringify([match.index, match[0]]);
  for (const match of regexMatches(regex, combined)) {
    if (match.index + match[0].length > previousLength) return true;
    oldMatches ??= new Set([...regexMatches(regex, combined.slice(0, previousLength))].map(key));
    if (!oldMatches.has(key(match))) return true;
  }
  return false;
}

export class FlowRules {
  constructor(config) {
    if (config?.version !== 1 || !Array.isArray(config.rules) || Object.keys(config).some(k => !['version', 'rules'].includes(k))) throw error('expected version 1 and rules array');
    const ids = new Set();
    const list = value => Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && v.trim());
    this.rules = config.rules.map(rule => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw error('each rule must be an object');
      const allowed = ['id', 'kind', 'destinations', 'except', ...(rule.kind === 'pattern' ? ['pattern', 'flags'] : ['sources'])];
      if (typeof rule.id !== 'string' || !/^[\w.-]{1,80}$/.test(rule.id) || ids.has(rule.id) || !list(rule.destinations) ||
          (rule.except !== undefined && !list(rule.except)) || Object.keys(rule).some(k => !allowed.includes(k))) throw error('invalid or duplicate rule');
      ids.add(rule.id);
      const copy = structuredClone(rule);
      if (rule.kind === 'pattern') {
        if (typeof rule.pattern !== 'string' || !rule.pattern || !/^[imsu]*$/.test(rule.flags ?? '')) throw error(`invalid pattern in ${rule.id}`);
        try { copy.regex = new RegExp(rule.pattern, rule.flags); } catch { throw error(`invalid pattern in ${rule.id}`); }
      } else if (rule.kind !== 'source' || !list(rule.sources)) throw error(`invalid source rule ${rule.id}`);
      return copy;
    });
    this.aliases = new Map(); this.handles = new Map(); this.values = new Map(); this.tails = new Map(); this.revision = 0;
  }
  canonical(app) { return this.aliases.get(norm(app)) ?? norm(app); }
  matches(app, apps) { return apps.some(a => a === '*' || this.canonical(a) === this.canonical(app)); }
  analyze(name, args = {}, window) {
    const handles = new Map(this.handles); const tails = new Map(this.tails);
    const parsed = name === 'js' ? calls(args.code ?? '', handles, window?.app) : { inputs: strings(Object.fromEntries(Object.entries(args).filter(([k]) => !['app', 'op'].includes(k)))).map(value => ({ app: args.app, value, method: 'argument' })), readApp: args.app };
    const violations = new Map();
    for (const input of parsed.inputs) {
      const app = this.canonical(input.app);
      let value = input.value;
      if (input.method === 'pressKey') {
        value = keyText(value);
        if (value === undefined) { tails.delete(app); continue; }
      }
      if (input.method === 'setValue') tails.delete(app);
      const previous = tails.get(app) ?? '';
      const combined = previous + value;
      if (input.method !== 'argument') tails.set(app, combined.slice(-16384));
      for (const rule of this.rules) {
        // Unknown destinations cannot establish an app exception.
        if ((input.app && !this.matches(input.app, rule.destinations)) || (input.app && rule.except && this.matches(input.app, rule.except))) continue;
        let source;
        const hit = rule.kind === 'pattern' ? newPatternMatch(rule.regex, value, combined, previous.length) : [...this.values].some(([from, values]) => {
          if (!this.matches(from, rule.sources)) return false;
          if ([...values].some(v => value.includes(v) || combined.slice(Math.max(0, previous.length - v.length + 1)).includes(v))) { source = from; return true; }
          return false;
        });
        if (hit) violations.set(JSON.stringify([rule.id, app]), { rule: rule.id, app: input.app ?? 'unknown app', ...(source ? { source } : {}) });
      }
    }
    return { violations: [...violations.values()], handles, tails, readApp: parsed.readApp };
  }
  forward(plan) { this.handles = plan.handles; this.tails = plan.tails; this.revision++; }
  observe(result, plan) {
    this.revision++;
    if (!result) return;
    const blocks = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text);
    const all = blocks.join('\n'); const window = windowFromText(all);
    if (window) {
      const canonical = this.canonical(window.app);
      for (const alias of [window.app, result._meta?.['codex/toolSurface']?.app?.appId, plan.readApp]) if (alias) this.aliases.set(norm(alias), canonical);
    }
    for (const block of blocks) {
      if (block.startsWith('## Computer Use\n') && block.includes('\n## API') && !/^Window: /m.test(block)) continue;
      const sections = block.split(/(?=^Window: )/m).filter(Boolean);
      for (const section of sections) {
        const target = windowFromText(section)?.app ?? plan.readApp;
        if (!target || !this.rules.some(r => r.kind === 'source' && this.matches(target, r.sources))) continue;
        const values = []; const add = v => { if (v?.trim()) values.push(v.trim(), ...v.split('\n').map(s => s.trim()).filter(Boolean)); };
        if (/^Window: /m.test(section)) {
          let field = [];
          for (const line of section.split('\n')) {
            const match = /^\s*\d+ .*?\bValue: (.*)$/.exec(line) ?? /^\s*\d+ (?:static text|text) (.+)$/.exec(line);
            if (match) { if (field.length) add(field.join('\n')); field = [match[1]]; }
            else if (/^(?:\s*\d+ (?:standard window|text entry|menu|button|scroll|group|toolbar|File\b)|Window: |URL:)/.test(line)) { if (field.length) add(field.join('\n')); field = []; }
            else if (field.length) field.push(line);
          }
          if (field.length) add(field.join('\n'));
        } else {
          try { for (const v of strings(JSON.parse(section))) add(v); } catch { add(section); }
        }
        const app = this.canonical(target); const known = this.values.get(app) ?? new Set();
        for (const v of values) known.add(v);
        this.values.set(app, known);
      }
    }
  }
  dispose() { this.values.clear(); this.handles.clear(); this.tails.clear(); this.aliases.clear(); }
}
