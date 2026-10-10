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
const isSite = selector => typeof selector === 'string' && selector.toLowerCase().startsWith('site:');
function siteSelector(selector) {
  const pattern = selector.slice(5).toLowerCase();
  const wildcard = pattern.startsWith('*.');
  const host = wildcard ? pattern.slice(2) : pattern;
  const label = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;
  if (host.length > 253 || !host.split('.').every(part => label.test(part)) ||
      (wildcard && (!host.includes('.') || /^[\d.]+$/.test(host)))) throw error(`invalid site host selector: ${selector}`);
  // Reject URL parser aliases such as shortened IPv4 addresses.
  try { if (new URL(`https://${host}`).hostname !== host) throw new Error(); }
  catch { throw error(`invalid site host selector: ${selector}`); }
  return { host, wildcard };
}
function urlHost(value) {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.hostname.toLowerCase().replace(/\.$/, '') : null;
  } catch { return null; }
}
const nativeBrowser = app => /^(?:browser|safari|helium|google chrome|chrome|chromium|firefox|microsoft edge|brave browser|arc|com\.apple\.safari|com\.google\.chrome|org\.mozilla\.firefox|com\.microsoft\.edgemac|net\.imput\.helium)$/i.test(norm(app));
const target = (app, url) => ({ app, host: urlHost(url), web: nativeBrowser(app) || !!urlHost(url), observed: !!urlHost(url) });
function headerTarget(text) {
  const window = windowFromText(text);
  if (window) return target(window.app, window.url);
  const header = /^Browser tab: [^\n]+?, Title: "(?:[^"\\]|\\.)*", URL: ("(?:[^"\\]|\\.)*")\.?\r?$/m.exec(text);
  if (header && !/^URL: /m.test(text)) {
    try { return target('browser', JSON.parse(header[1])); } catch { /* Unknown site. */ }
  }
  // A malformed native URL still identifies its app, but grants no site exception.
  const app = /^Window: "(?:[^"\\]|\\.)*", App: (.+?)\.?\r?$/m.exec(text)?.[1];
  return app ? target(app) : /^Browser tab: /m.test(text) ? target('browser') : undefined;
}
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
  const ts = tokens(code); const inputs = []; let readTarget = fallback;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].v === '=' && !ts[i - 1]?.string) {
      const source = i + (ts[i + 1]?.v === 'await' ? 2 : 1);
      const end = ts.findIndex((t, index) => index > source && t.v === ';');
      const expression = ts.slice(source, end < 0 ? ts.length : end);
      const factories = ['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'locator', 'frameLocator', 'filter', 'first', 'last', 'nth', 'and', 'or', 'new', 'get'];
      if (handles.get(ts[source]?.v)?.app === 'browser' && ts[source + 1]?.v === '.' &&
          expression.some((t, index) => !t.string && factories.includes(t.v) && expression[index + 1]?.v === '(')) {
        handles.set(ts[i - 1].v, handles.get(ts[source].v));
      }
    }
    if (!ts[i].string && handles.has(ts[i].v) && ts[i + 1]?.v === '.') readTarget = handles.get(ts[i].v);
    if (['getApp', 'getBrowser', 'getTab', 'createBrowserTab'].includes(ts[i].v) && ts[i + 1]?.v === '(' && (ts[i].v !== 'getApp' || ts[i + 2]?.string)) {
      const app = ts[i].v === 'getApp' ? ts[i + 2].v : 'browser'; readTarget = target(app);
      // Find the receiver assigned to this acquisition, without executing it.
      const start = Math.max(ts.slice(0, i).findLastIndex(t => t.v === ';') + 1, 0);
      const eq = ts.slice(start, i).findIndex(t => t.v === '=');
      if (eq > 0) handles.set(ts[start + eq - 1].v, readTarget);
    }
    const method = ts[i].v;
    if (!['typeText', 'paste', 'setValue', 'pressKey', 'fill', 'type', 'pressSequentially', 'press', 'goto', 'createBrowserTab', 'back', 'forward', 'reload'].includes(method)) continue;
    const bracket = ts[i].string && ts[i - 1]?.v === '[' && ts[i + 1]?.v === ']';
    if (!bracket && ts[i - 1]?.v !== '.') continue;
    const receiver = ts[i - 2]?.v;
    const start = Math.max(ts.slice(0, i).findLastIndex(t => t.v === ';') + 1, 0);
    const root = ts.slice(start, i).find(t => handles.get(t.v)?.app === 'browser')?.v;
    // A new tab is always the browser, however the method was named (`cua.createBrowserTab(` or
    // `cua["createBrowserTab"](`, where the token after the name is `]`, not `(`).
    const destination = method === 'createBrowserTab' ? target('browser') : handles.get(root ?? receiver) ?? fallback;
    if (destination?.app === 'browser') readTarget = destination;
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
    const arg = method === 'createBrowserTab' ? args[1] : method === 'setValue' ? args[1] : (args[0]?.[0]?.string ? args[0] : args[1] ?? args[0]);
    const literals = (arg ?? []).filter(t => t.string).map(t => t.v);
    const navigation = ['goto', 'createBrowserTab', 'back', 'forward', 'reload'].includes(method);
    const urlNavigation = ['goto', 'createBrowserTab'].includes(method);
    if (literals.length && (!navigation || urlNavigation)) inputs.push({ method, target: urlNavigation ? { ...target(destination?.app, literals.join('')), observed: false }
      : { ...destination }, value: literals.join('') });
    if (navigation && destination) { destination.host = null; destination.observed = false; }
    i = j;
  }
  return { inputs, readApp: readTarget?.app, readTarget };
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
      for (const selector of [...rule.destinations, ...(rule.except ?? []), ...(Array.isArray(rule.sources) ? rule.sources : [])]) {
        if (isSite(selector)) siteSelector(selector);
      }
      const copy = structuredClone(rule);
      copy.siteScoped = [...rule.destinations, ...(rule.except ?? [])].some(isSite);
      if (rule.kind === 'pattern') {
        if (typeof rule.pattern !== 'string' || !rule.pattern || !/^[imsu]*$/.test(rule.flags ?? '')) throw error(`invalid pattern in ${rule.id}`);
        try { copy.regex = new RegExp(rule.pattern, rule.flags); } catch { throw error(`invalid pattern in ${rule.id}`); }
      } else if (rule.kind !== 'source' || !list(rule.sources)) throw error(`invalid source rule ${rule.id}`);
      return copy;
    });
    this.aliases = new Map(); this.handles = new Map(); this.values = new Map(); this.tails = new Map(); this.windows = new Map(); this.revision = 0;
  }
  canonical(app) { return this.aliases.get(norm(app)) ?? norm(app); }
  matches(value, apps, { unknown = false, exception = false } = {}) {
    const context = typeof value === 'string' ? target(value) : value;
    return apps.some(a => {
      if (!isSite(a)) return a === '*' || this.canonical(a) === this.canonical(context?.app);
      if (!context?.host) return unknown && !!context?.web;
      if (exception && !context.observed) return false;
      const { host, wildcard } = siteSelector(a);
      return wildcard ? context.host.endsWith('.' + host) : context.host === host;
    });
  }
  analyze(name, args = {}, window) {
    const copies = new Map();
    const fallback = window ? target(window.app, window.url) : undefined;
    const current = value => value?.app === 'browser' ? value : this.windows.get(this.canonical(value?.app)) ??
      (fallback && this.canonical(value?.app) === this.canonical(fallback.app) ? fallback : value);
    const handles = new Map([...this.handles].map(([name, value]) => {
      if (!copies.has(value)) copies.set(value, { ...current(value) });
      return [name, copies.get(value)];
    }));
    const tails = new Map(this.tails);
    const localTarget = current(target(args.app));
    const parsed = name === 'js' ? calls(args.code ?? '', handles, fallback) : { inputs: strings(Object.fromEntries(Object.entries(args).filter(([k]) => !['app', 'op'].includes(k)))).map(value => ({ target: localTarget, value, method: 'argument' })), readApp: args.app, readTarget: localTarget };
    const violations = new Map();
    for (const input of parsed.inputs) {
      const destination = input.target;
      const app = this.canonical(destination?.app);
      const siteKey = JSON.stringify([app, destination?.host ?? null]);
      let value = input.value;
      if (['pressKey', 'press'].includes(input.method)) {
        value = keyText(value);
        if (value === undefined) { tails.delete(app); tails.delete(siteKey); continue; }
      }
      if (input.method === 'setValue') { tails.delete(app); tails.delete(siteKey); }
      const previousApp = tails.get(app) ?? '', previousSite = tails.get(siteKey) ?? '';
      if (input.method !== 'argument') {
        tails.set(app, (previousApp + value).slice(-16384)); tails.set(siteKey, (previousSite + value).slice(-16384));
      }
      for (const rule of this.rules) {
        const previous = rule.siteScoped ? previousSite : previousApp;
        const combined = previous + value;
        // Unknown destinations cannot establish an app exception.
        if ((destination?.app && !this.matches(destination, rule.destinations, { unknown: true })) ||
            (destination?.app && rule.except && this.matches(destination, rule.except, { exception: true }))) continue;
        let source;
        const hit = rule.kind === 'pattern' ? newPatternMatch(rule.regex, value, combined, previous.length) : [...this.values.values()].some(({ from, values }) => {
          if (!this.matches(from, rule.sources)) return false;
          if ([...values].some(v => value.includes(v) || combined.slice(Math.max(0, previous.length - v.length + 1)).includes(v))) { source = rule.sources.some(isSite) && from.host ? `site:${from.host}` : this.canonical(from.app); return true; }
          return false;
        });
        if (hit) violations.set(JSON.stringify([rule.id, app]), { rule: rule.id, app: destination?.app ?? 'unknown app', ...(source ? { source } : {}) });
      }
    }
    return { violations: [...violations.values()], handles, tails, readApp: parsed.readApp, readTarget: parsed.readTarget };
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
    const sections = all.split(/(?=^(?:Window: |Browser tab: ))/m).filter(Boolean);
    const headers = sections.filter(s => /^(?:Window: |Browser tab: )/m.test(s)).map(headerTarget).filter(Boolean);
    const observed = headers.length === 1 ? headers[0] : undefined;
    if (plan.readTarget) {
      const same = observed && this.canonical(observed.app) === this.canonical(plan.readTarget.app);
      Object.assign(plan.readTarget, { host: same ? observed.host : null, observed: same && observed.observed,
        web: plan.readTarget.web || !!observed?.web });
      if (plan.readTarget.app !== 'browser') this.windows.set(this.canonical(plan.readTarget.app), { ...plan.readTarget });
    }
    for (const header of headers) if (header.app !== 'browser') {
      const app = this.canonical(header.app);
      const next = headers.filter(h => this.canonical(h.app) === app).length === 1 ? header : target(header.app);
      next.web ||= this.windows.get(app)?.web || headers.some(h => this.canonical(h.app) === app && h.web);
      this.windows.set(app, next);
    }
    for (const block of blocks) {
      if (block.startsWith('## Computer Use\n') && block.includes('\n## API') && !/^Window: /m.test(block)) continue;
      const sections = block.split(/(?=^(?:Window: |Browser tab: ))/m).filter(Boolean);
      for (const section of sections) {
        const context = headerTarget(section) ?? observed ?? target(plan.readApp);
        if (!context.app || !this.rules.some(r => r.kind === 'source' && this.matches(context, r.sources))) continue;
        const values = []; const add = v => { if (v?.trim()) values.push(v.trim(), ...v.split('\n').map(s => s.trim()).filter(Boolean)); };
        if (context.app === 'browser') for (const line of section.split('\n')) {
          const field = /^\s*-\s+[\w-]+(?:\s+("(?:[^"\\]|\\.)*"))?(?:\s+\[[^\]]*\])*\s*(?::\s*(.*))?$/.exec(line);
          if (field?.[1]) { try { add(JSON.parse(field[1])); } catch { /* Ignore malformed labels. */ } }
          if (field?.[2]) add(field[2]);
        }
        if (/^(?:Window: |Browser tab: )/m.test(section)) {
          let field = [];
          for (const line of section.split('\n')) {
            const match = /^\s*\d+ .*?\bValue: (.*)$/.exec(line) ?? /^\s*\d+ (?:static text|text) (.+)$/.exec(line);
            if (match) { if (field.length) add(field.join('\n')); field = [match[1]]; }
            else if (/^(?:\s*\d+ (?:standard window|text entry|menu|button|scroll|group|toolbar|File\b)|Window: |Browser tab: |URL:)/.test(line)) { if (field.length) add(field.join('\n')); field = []; }
            else if (field.length) field.push(line);
          }
          if (field.length) add(field.join('\n'));
        } else {
          try { for (const v of strings(JSON.parse(section))) add(v); } catch { add(section); }
        }
        const from = { ...context, app: this.canonical(context.app) };
        const key = JSON.stringify([from.app, from.host]);
        const known = this.values.get(key)?.values ?? new Set();
        for (const v of values) known.add(v);
        this.values.set(key, { from, values: known });
      }
    }
  }
  dispose() { this.values.clear(); this.handles.clear(); this.tails.clear(); this.aliases.clear(); this.windows.clear(); }
}
