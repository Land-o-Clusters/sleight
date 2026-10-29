import { parseCell, walk, memberCall, literalValue, handleBindings, callInventory, invalidHandleNames, UNKNOWN } from './code-ast.mjs';
import { receiverRoot, unsafeHandleUse, trustedInvocations, introspectionCalls } from './call-inspection.mjs';
// Literal inspection is a mistake guard. Never evaluate the caller's code here.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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
// Read registration metadata once when flow rules load. This neither launches nor acquires apps.
export function discoverNativeBrowsers({ run = execFileSync } = {}) {
  try {
    const script = `ObjC.import('CoreServices'); ObjC.import('AppKit');
      const http = ObjC.deepUnwrap(ObjC.castRefToObject($.LSCopyAllHandlersForURLScheme('http'))) || [];
      const https = ObjC.deepUnwrap(ObjC.castRefToObject($.LSCopyAllHandlersForURLScheme('https'))) || [];
      const apps = [];
      for (const bundle of http.filter(id => https.includes(id))) {
        apps.push(bundle);
        const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(bundle);
        if (url && !url.isNil()) apps.push(ObjC.unwrap(url.lastPathComponent).replace(/\\.app$/, ''));
      }
      JSON.stringify(apps);`;
    const apps = JSON.parse(run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout: 2000, maxBuffer: 262144, stdio: ['ignore', 'pipe', 'pipe'] }));
    return Array.isArray(apps) && apps.every(app => typeof app === 'string' && app) ? apps : [];
  } catch { return []; }
}
const nativeBrowser = (app, browsers) => browsers?.has(norm(app)) || /^(?:browser|safari|helium|google chrome|chrome|chromium|firefox|microsoft edge|brave browser|arc|com\.apple\.safari|com\.google\.chrome|org\.mozilla\.firefox|com\.microsoft\.edgemac|net\.imput\.helium)$/i.test(norm(app));
const target = (app, url, browsers) => ({ app, host: urlHost(url), web: nativeBrowser(app, browsers) || !!urlHost(url), observed: !!urlHost(url) });
function headerTarget(text, browsers) {
  const window = windowFromText(text);
  if (window) return target(window.app, window.url, browsers);
  const header = /^Browser tab: [^\n]+?, Title: "(?:[^"\\]|\\.)*", URL: ("(?:[^"\\]|\\.)*")\.?\r?$/m.exec(text);
  if (header && !/^URL: /m.test(text)) {
    try { return target('browser', JSON.parse(header[1]), browsers); } catch { /* Unknown site. */ }
  }
  // A malformed native URL still identifies its app, but grants no site exception.
  const app = /^Window: "(?:[^"\\]|\\.)*", App: (.+?)\.?\r?$/m.exec(text)?.[1];
  return app ? target(app, undefined, browsers) : /^Browser tab: /m.test(text) ? target('browser', undefined, browsers) : undefined;
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

export function loadFlowRules(env = process.env, { cwd = process.cwd(), discoverBrowsers = discoverNativeBrowsers } = {}) {
  const setting = env.SLEIGHT_FLOW_RULES;
  if (!setting || setting === '0') return undefined;
  try {
    const file = setting === '1' ? join(homedir(), 'Library', 'Application Support', 'sleight', 'flow-rules.json') : setting;
    if (!isAbsolute(file)) throw error('SLEIGHT_FLOW_RULES must be 1 or an absolute file path');
    const actual = realpathSync(file);
    const plugin = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
    if (within(actual, projectRoot(cwd)) || within(actual, plugin)) throw error('the user rules file must be outside the working project and plugin');
    return new FlowRules(JSON.parse(readFileSync(actual, 'utf8')), { browsers: discoverBrowsers() });
  } catch (err) { throw error(err.message); }
}

export { codeInspectionRefusal } from './call-inspection.mjs';


export function calls(code, handles, fallback, browsers, { trustedFunctions = new Set() } = {}) {
  const { ast, error } = parseCell(code), inputs = [], unknownInputs = [];
  let readTarget = fallback;
  if (error) return { inputs, unknown: true, unknownInputs };
  const methods = new Set(['typeText', 'paste', 'setValue', 'pressKey', 'fill', 'type', 'pressSequentially', 'press', 'goto', 'createBrowserTab', 'back', 'forward', 'reload']);
  const invalid = invalidHandleNames(ast);
  for (const name of invalid) handles.delete(name);
  const trusted = trustedInvocations(ast, code, trustedFunctions, new Set(['app', ...handles.keys()])), reads = introspectionCalls(ast).calls;
  const indirect = callInventory(ast).filter(entry => {
    if (trusted.has(entry.node) || reads.has(entry.node)) return false;
    const call = memberCall(entry.node);
    return !call || call.method === 'eval' || call.method === 'constructor';
  });
  const unsafe = unsafeHandleUse(ast, new Set(['app', ...handles.keys()]), { code, trustedFunctions });
  const previous = new Map([...handles].map(([name, value]) => [name, { kind: value.app === 'browser' ? 'browser' : 'app', app: value.app }]));
  for (const statement of ast.body) {
    const hints = handleBindings({ body: [statement] }, previous);
    // Bindings are hints, not execution. Keep shared browser targets so a
    // navigation invalidates aliases, as it does on the old literal path.
    for (const node of walk(statement)) {
      const assignment = node.type === 'VariableDeclarator' ? { left: node.id, right: node.init, operator: '=' }
        : node.type === 'AssignmentExpression' ? node : undefined;
      if (assignment?.left.type === 'Identifier') {
        const name = assignment.left.name, hint = hints.get(name);
        if (invalid.has(name)) { handles.delete(name); continue; }
        if (hint?.kind === 'app') handles.set(name, hint.source ? handles.get(hint.source) ?? fallback ?? target(undefined, undefined, browsers) : target(hint.app, undefined, browsers));
        else if (hint) handles.set(name, handles.get(hint.root) ?? target('browser', undefined, browsers));
        else if (assignment.operator === '=' && assignment.right?.type === 'Identifier' && handles.has(assignment.right.name)) handles.set(name, handles.get(assignment.right.name));
        else handles.delete(name);
      }
      if (node.type !== 'CallExpression') continue;
      const call = memberCall(node);
      if (!call) continue;
      const root = receiverRoot(call.receiver);
      if (handles.has(root)) readTarget = handles.get(root);
      if (['getApp', 'getBrowser', 'getTab', 'createBrowserTab'].includes(call.method)) {
        const value = literalValue(call.args[0]);
        const binding = [...hints].find(([, hint]) => hint.range && hint.range[0] <= node.range[0] && hint.range[1] >= node.range[1]);
        readTarget = (binding && handles.get(binding[0])) ?? (call.method === 'getApp'
          ? target(typeof value === 'string' ? value : undefined, undefined, browsers) : target('browser', undefined, browsers));
      }
      if (call.method === UNKNOWN) { unknownInputs.push({ method: UNKNOWN, target: { ...(handles.get(root) ?? (!invalid.has(root) && root === 'app' ? fallback : undefined)) } }); continue; }
      if (!methods.has(call.method)) continue;
      const method = call.method;
      const factory = memberCall(call.receiver);
      const directApp = factory?.receiver.type === 'Identifier' && factory.receiver.name === 'cua' && factory.method === 'getApp';
      const appValue = directApp && literalValue(factory.args[0]);
      const destination = method === 'createBrowserTab' ? target('browser', undefined, browsers)
        : directApp ? target(typeof appValue === 'string' ? appValue : undefined, undefined, browsers) : handles.get(root) ?? (!invalid.has(root) && root === 'app' ? fallback : undefined);
      if (destination?.app === 'browser') readTarget = destination;
      const values = call.args.map(literalValue);
      let value = method === 'createBrowserTab' || method === 'setValue' ? values[1]
        : typeof values[0] === 'string' ? values[0] : values[1] ?? values[0];
      if (typeof value !== 'string') {
        unknownInputs.push({ method, target: ['goto', 'createBrowserTab'].includes(method)
          ? target(destination?.app, undefined, browsers) : { ...destination } });
        // Preserve the conservative literal-fragment check for concatenations.
        // The complete runtime value is still unknown and is never evaluated.
        const fragments = node => [...walk(node)].sort((a,b) => a.range[0]-b.range[0]).flatMap(part => part.type === 'Literal' && typeof part.value === 'string'
          ? [part.value] : part.type === 'TemplateElement' ? [part.value.cooked ?? part.value.raw] : []);
        const known = call.args.flatMap(fragments);
        if (known.length) value = known.join('');
      }
      const navigation = ['goto', 'createBrowserTab', 'back', 'forward', 'reload'].includes(method);
      const urlNavigation = ['goto', 'createBrowserTab'].includes(method);
      if (typeof value === 'string' && (!navigation || urlNavigation)) inputs.push({ method,
        target: urlNavigation ? { ...target(destination?.app, value, browsers), observed: false } : { ...destination }, value });
      else if (value !== UNKNOWN && (!navigation || urlNavigation)) unknownInputs.push({ method, target: { ...destination } });
      if (navigation && destination) { destination.host = null; destination.observed = false; }
    }
    previous.clear();
    for (const [name, value] of handles) previous.set(name, { kind: value.app === 'browser' ? 'browser' : 'app', app: value.app });
  }
  return { inputs, unknownInputs, unknown: !!unsafe || indirect.length > 0 || unknownInputs.some(input => input.method === UNKNOWN), readApp: readTarget?.app, readTarget };
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
  constructor(config, { browsers = [] } = {}) {
    this.browsers = new Set(browsers.map(norm));
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
    const context = typeof value === 'string' ? target(value, undefined, this.browsers) : value;
    return apps.some(a => {
      if (!isSite(a)) return a === '*' || this.canonical(a) === this.canonical(context?.app);
      if (!context?.host) return unknown && !!context?.web;
      if (exception && !context.observed) return false;
      const { host, wildcard } = siteSelector(a);
      return wildcard ? context.host.endsWith('.' + host) : context.host === host;
    });
  }
  analyze(name, args = {}, window, inspection = {}) {
    const copies = new Map();
    const fallback = window ? target(window.app, window.url, this.browsers) : undefined;
    const current = value => value?.app === 'browser' ? value : this.windows.get(this.canonical(value?.app)) ??
      (fallback && this.canonical(value?.app) === this.canonical(fallback.app) ? fallback : value);
    const handles = new Map([...this.handles].map(([name, value]) => {
      if (!copies.has(value)) copies.set(value, { ...current(value) });
      return [name, copies.get(value)];
    }));
    const tails = new Map(this.tails);
    const localTarget = current(target(args.app, undefined, this.browsers));
    const parsed = name === 'js' ? calls(args.code ?? '', handles, fallback, this.browsers, inspection) : { inputs: strings(Object.fromEntries(Object.entries(args).filter(([k]) => !['app', 'op'].includes(k)))).map(value => ({ target: localTarget, value, method: 'argument' })), readApp: args.app, readTarget: localTarget };
    const violations = new Map(parsed.unknown ? this.rules.map(rule => [rule.id, { rule: rule.id, app: 'unknown app' }]) : []);
    for (const input of parsed.unknownInputs ?? []) for (const rule of this.rules) {
      if (rule.kind === 'source' && (!input.target?.app || this.matches(input.target, rule.destinations, { unknown: true })) &&
          !(input.target?.app && rule.except && this.matches(input.target, rule.except, { exception: true })))
        violations.set(rule.id, { rule: rule.id, app: input.target?.app ?? 'unknown app' });
    }
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
        if (hit) violations.set(rule.id, { rule: rule.id, app: destination?.app ?? 'unknown app', ...(source ? { source } : {}) });
      }
    }
    return { violations: [...violations.values()], handles, tails, readApp: parsed.readApp, readTarget: parsed.readTarget, unknownInputs: parsed.unknownInputs ?? [] };
  }
  forward(plan) { this.handles = plan.handles; this.tails = plan.tails; this.revision++; }
  observe(result, plan) {
    this.revision++;
    if (!result) return;
    const blocks = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text);
    const all = blocks.join('\n'); const window = windowFromText(all);
    if (window) {
      const canonical = this.canonical(window.app);
      const aliases = [window.app, result._meta?.['codex/toolSurface']?.app?.appId, plan.readApp].filter(Boolean);
      const web = aliases.some(alias => nativeBrowser(alias, this.browsers));
      for (const alias of aliases) {
        this.aliases.set(norm(alias), canonical);
        // LaunchServices' bundle filename may differ from the localized name in the engine read.
        if (web) this.browsers.add(norm(alias));
      }
    }
    const sections = all.split(/(?=^(?:Window: |Browser tab: ))/m).filter(Boolean);
    const headers = sections.filter(s => /^(?:Window: |Browser tab: )/m.test(s)).map(text => headerTarget(text, this.browsers)).filter(Boolean);
    const observed = headers.length === 1 ? headers[0] : undefined;
    if (plan.readTarget) {
      const same = observed && this.canonical(observed.app) === this.canonical(plan.readTarget.app);
      Object.assign(plan.readTarget, { host: same ? observed.host : null, observed: same && observed.observed,
        web: plan.readTarget.web || !!observed?.web });
      if (plan.readTarget.app !== 'browser') this.windows.set(this.canonical(plan.readTarget.app), { ...plan.readTarget });
    }
    for (const header of headers) if (header.app !== 'browser') {
      const app = this.canonical(header.app);
      const next = headers.filter(h => this.canonical(h.app) === app).length === 1 ? header : target(header.app, undefined, this.browsers);
      next.web ||= this.windows.get(app)?.web || headers.some(h => this.canonical(h.app) === app && h.web);
      this.windows.set(app, next);
    }
    for (const block of blocks) {
      if (block.startsWith('## Computer Use\n') && block.includes('\n## API') && !/^Window: /m.test(block)) continue;
      const sections = block.split(/(?=^(?:Window: |Browser tab: ))/m).filter(Boolean);
      for (const section of sections) {
        const context = headerTarget(section, this.browsers) ?? observed ?? target(plan.readApp, undefined, this.browsers);
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
