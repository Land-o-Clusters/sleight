// What sleight needs from the ChatGPT computer-use engine, and the checks that read it back after an engine update.
// Every name here is one sleight's code calls or parses (plugins/sleight/lib). tests/compat-contract.test.mjs fails when the
// code starts calling a cua method this file doesn't list, so a new dependency can't skip the check.
import { engineJsVariant } from '../../plugins/sleight/lib/tool-description.mjs';
import { rewritePaymentPolicy } from '../../plugins/sleight/lib/payment-policy.mjs';
import { rewriteWorkflow } from '../../plugins/sleight/lib/workflow-docs.mjs';

// cua methods the relay, guard and helpers call (relay.mjs, document-scope.mjs, helper-health.mjs, browser-*.mjs).
export const CUA_METHODS = ['getApp', 'getState', 'listApps', 'listBrowsers', 'getBrowser', 'getTab', 'createBrowserTab', 'listTabs'];
// The engine defines these only when CUA_REPL_ENABLED_SURFACES includes browser (engine 26.1013.40934, 2026-10-19:
// with "computer" alone cua has getApp, getState and listApps and no browser methods).
export const BROWSER_METHODS = ['listBrowsers', 'getBrowser', 'getTab', 'createBrowserTab', 'listTabs'];
// Names the code matches in Claude's own code but never calls itself, so the engine may drop them without breaking sleight.
export const MATCHED_ONLY = ['rewriteDocumentation', 'scroll'];

// Members of the API's TypeScript declarations, inherited ones included. App and Tab methods are the guard's
// (document-scope.mjs) and relay's calls; the type fields are the ones the code reads from results.
export const API_MEMBERS = {
  cua: CUA_METHODS,
  App: ['getAXState', 'getScreenshot', 'getAXStateAndScreenshot', 'click', 'drag', 'scroll', 'selectText', 'setValue',
    'performSecondaryAction', 'paste', 'pressKey', 'typeText'],
  Tab: ['getAXState', 'getScreenshot', 'click', 'drag', 'paste', 'pressKey', 'typeText', 'id', 'goto', 'close'],
  StateOptions: ['disableDiffing', 'emit'],
  StateAndScreenshot: ['state', 'screenshot'],
  AppInfo: ['id', 'windows'],
  WindowInfo: ['id', 'app', 'title'],
  State: ['apps', 'errors'],
  BrowserInfo: ['id', 'type', 'profileName', 'metadata'],
  Browser: ['browserId'],
};

// Headings sleight's result budget and first-call guidance cut the docs at (result-budget.mjs, initialization-guidance.mjs).
export const DOC_HEADINGS = ['## Computer Use', '## API', '# Computer Use Confirmations Policy'];

const result = (id, status, reason, detail) => ({ id, status, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) });

// The first ```typescript block after the "## API" heading.
export function apiBlock(docs) {
  const api = docs.search(/^## API\s*$/m);
  if (api < 0) return undefined;
  const open = docs.indexOf('```typescript\n', api);
  if (open < 0) return undefined;
  const close = docs.indexOf('\n```', open + 14);
  return close < 0 ? undefined : docs.slice(open + 14, close);
}

// Interfaces, object types and `declare const` objects with their direct members and the types they extend.
// Comments and string literals become spaces first, so a parenthesis or brace inside one can't throw off the scan and a
// method named only in a comment doesn't count.
export function stripCommentsAndStrings(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
    text => text.replace(/[^\n]/g, ' '));
}

export function parseDeclarations(source) {
  const block = stripCommentsAndStrings(source);
  const owners = new Map();
  const head = /^(?:export\s+)?(?:interface\s+(\w+)(?:<[^>{]*>)?(?:\s+extends\s+([\w\s,<>]+?))?\s*\{|type\s+(\w+)(?:<[^>=]*>)?\s*=\s*(?:[\w\s&]+&\s*)?\{|declare\s+const\s+(\w+)\s*:\s*\{)/gm;
  for (let match; (match = head.exec(block));) {
    const name = match[1] ?? match[3] ?? match[4];
    const start = match.index + match[0].length;
    // Members are the segments between ";" or line ends outside nested braces and parentheses, so a one-line
    // `{ state: string; screenshot?: Uint8Array }` and a multi-line method signature both count once.
    const members = new Set();
    let braces = 0, parens = 0, segment = '', at = start;
    const flush = () => {
      const member = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[(:<]/.exec(segment);
      if (member) members.add(member[1]);
      segment = '';
    };
    for (; at < block.length; at++) {
      const char = block[at];
      if (char === '{') braces++;
      else if (char === '}') { if (braces === 0) break; braces--; }
      else if (char === '(') parens++;
      else if (char === ')') parens--;
      if (braces === 0 && parens === 0 && (char === ';' || char === '\n')) flush();
      else if (braces === 0 && char !== '}') segment += char;
    }
    flush();
    // `type X = A & { ... }` inherits A, as `interface X extends A` does.
    const intersected = match[3] ? (/=\s*([\w\s&]+)&\s*\{$/.exec(match[0])?.[1] ?? '') : '';
    const parents = [...(match[2] ?? '').split(','), ...intersected.split('&')].map(part => part.replace(/<.*$/, '').trim()).filter(Boolean);
    // A repeated interface merges, as TypeScript's declaration merging does.
    const known = owners.get(name);
    if (known) { for (const member of members) known.members.add(member); known.parents.push(...parents); }
    else owners.set(name, { members, parents });
  }
  return owners;
}

export function membersOf(owners, name, seen = new Set()) {
  const owner = owners.get(name);
  if (!owner || seen.has(name)) return new Set();
  seen.add(name);
  const all = new Set(owner.members);
  for (const parent of owner.parents) for (const member of membersOf(owners, parent, seen)) all.add(member);
  return all;
}

// The API docs against API_MEMBERS. A member sleight uses that's gone fails; anything else that changed shows in the diff.
export function checkApiContract(docs) {
  const block = typeof docs === 'string' ? apiBlock(docs) : undefined;
  if (!block) return [result('api-contract', 'fail', 'the engine docs have no "## API" TypeScript block')];
  const owners = parseDeclarations(block);
  const missing = [];
  for (const [owner, wanted] of Object.entries(API_MEMBERS)) {
    if (!owners.has(owner)) { missing.push(`${owner} (whole declaration)`); continue; }
    const have = membersOf(owners, owner);
    for (const name of wanted) if (!have.has(name)) missing.push(`${owner}.${name}`);
  }
  const headings = DOC_HEADINGS.filter(heading => !new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(docs));
  return [
    missing.length ? result('api-contract', 'fail', `the API no longer declares ${missing.join(', ')}`)
      : result('api-contract', 'pass', `${Object.values(API_MEMBERS).flat().length} members sleight uses are declared`),
    headings.length ? result('doc-headings', 'warn', `missing heading ${headings.map(h => JSON.stringify(h)).join(', ')}; sleight's docs trimming leaves that part whole`)
      : result('doc-headings', 'pass'),
  ];
}

// The engine's own tools/list, read without sleight's relay.
export function checkToolSurface(tools) {
  if (!Array.isArray(tools)) return [result('tool-surface', 'fail', 'tools/list returned no tools array')];
  const byName = new Map(tools.map(tool => [tool?.name, tool]));
  const problems = [];
  const js = byName.get('js');
  if (!js) problems.push('no js tool');
  else {
    const schema = js.inputSchema ?? {};
    const props = schema.properties ?? {};
    if (schema.type !== 'object') problems.push('js inputSchema is not an object');
    if (props.code?.type !== 'string') problems.push('js has no string "code" argument');
    // The relay's own calls send title and timeout_ms (relay.mjs 1248, 1257, 1380).
    if (!props.timeout_ms || !['number', 'integer'].includes(props.timeout_ms.type)) problems.push('js has no numeric "timeout_ms" argument');
    if (!props.title) problems.push('js has no "title" argument');
    if (Array.isArray(schema.required) && schema.required.some(key => key !== 'code')) problems.push(`js requires ${schema.required.filter(key => key !== 'code').join(', ')}`);
  }
  // The relay ends every turn through turn_ended (relay.mjs endTurnArgs).
  if (!byName.has('turn_ended')) problems.push('no turn_ended tool');
  const results = [problems.length ? result('tool-surface', 'fail', problems.join('; '))
    : result('tool-surface', 'pass', `js and turn_ended present (${tools.length} tools)`)];
  if (js && typeof js.description === 'string') results.push(jsDescriptionResult(engineJsVariant(js.description)));
  else if (js) results.push(result('js-description', 'pass'));
  return results;
}

// Whether sleight's shorter js description replaces the engine's (tool-description.mjs pins). A pin of the engine's current
// text applies only with SLEIGHT_FS=1 until its A/B, so by default it still warns. `mode` names a surface setting.
export function jsDescriptionResult(pin, mode) {
  const where = mode ? ` for CUA_REPL_ENABLED_SURFACES=${mode}` : '';
  if (!pin) return result('js-description', 'warn', `the engine's js description changed${where}, so sleight sends it whole instead of its shorter version (tool-description.mjs pins)`);
  if (pin.current) return result('js-description', 'warn', `sleight's shorter js description${where} applies only with SLEIGHT_FS=1 (under A/B); by default the engine's text goes out with its first-call rule rewritten`);
  return result('js-description', 'pass', "sleight's shorter js description applies");
}

// sleight rewrites the engine's confirmations policy for payments and forms the user asked for (payment-policy.mjs).
// It matches the engine's exact text, so a new wording turns it off.
// The relay rewrites only a text item that starts with "## Computer Use" (relay.mjs, near rewritePaymentPolicy).
export function checkPolicyRewrite(texts) {
  const strings = texts.filter(text => typeof text === 'string');
  if (!strings.some(text => /(^|\n)## Computer Use\n/.test(text))) {
    return [result('policy-rewrite', 'warn', 'the first result has no "## Computer Use" docs, so the payment and form rules sleight adds are not delivered')];
  }
  const item = strings.find(text => text.startsWith('## Computer Use\n'));
  if (!item) return [result('policy-rewrite', 'warn', 'no result item starts with "## Computer Use", so sleight skips its policy rewrite')];
  let status = 'unmatched';
  rewritePaymentPolicy(item, 'requested', (_, info) => { status = info?.status ?? status; });
  if (status !== 'rewritten') {
    return [result('policy-rewrite', 'warn', "the engine's confirmations policy changed, so sleight leaves it whole: payments and form submits the user named ask again")];
  }
  return [result('policy-rewrite', 'pass')];
}

// sleight rewrites the engine's Workflow lines that ask for a getAXState() after actions (workflow-docs.mjs), matching
// each whole line by hash, so a new wording turns the rewrite off and Claude reads after its actions again.
export function checkWorkflowRewrite(texts) {
  const item = texts.find(text => typeof text === 'string' && text.startsWith('## Computer Use\n'));
  if (!item) return [result('workflow-rewrite', 'warn', 'no result item starts with "## Computer Use", so sleight skips its Workflow rewrite')];
  return rewriteWorkflow(item).status === 'rewritten' ? [result('workflow-rewrite', 'pass')]
    : [result('workflow-rewrite', 'warn', "the engine's Workflow lines changed or are gone, so sleight leaves them whole and Claude may end calls on a read again")];
}

// One js call on the raw engine with no app: which cua methods exist, and the shape (key names and value types, never
// values) of getState and listApps, which the doctor and the guard read.
export const PROBE_MARK = 'sleight-compat-probe:';
export const PROBE_CODE = `await (async () => {
const names = ${JSON.stringify(CUA_METHODS)};
const kinds = Object.fromEntries(names.map(name => [name, typeof cua[name]]));
kinds['nodeRepl.write'] = typeof nodeRepl.write;
kinds['nodeRepl.emitImage'] = typeof nodeRepl.emitImage;
const shape = (value, depth = 0) => {
  if (Array.isArray(value)) {
    const merged = {};
    for (const item of value.slice(0, 200)) {
      const inner = shape(item, depth + 1);
      if (inner && typeof inner === 'object') Object.assign(merged, inner); else merged['[]'] = inner;
    }
    return { '[]': merged };
  }
  if (value && typeof value === 'object' && depth < 4) return Object.fromEntries(Object.keys(value).sort().map(key => [key, shape(value[key], depth + 1)]));
  return value === null ? 'null' : typeof value;
};
const state = await cua.getState({ emit: false });
const apps = await cua.listApps({ emit: false });
nodeRepl.write(${JSON.stringify(PROBE_MARK)} + JSON.stringify({ kinds, state: shape(state), apps: shape(apps) }));
})();`;

export function parseProbe(text) {
  const line = String(text ?? '').split('\n').find(item => item.startsWith(PROBE_MARK));
  if (!line) return undefined;
  try { return JSON.parse(line.slice(PROBE_MARK.length)); } catch { return undefined; }
}

// `surfaces` is the CUA_REPL_ENABLED_SURFACES the engine ran with. The browser methods are checked only when it includes
// browser. Missing browser methods with no surface setting to judge them by are the harness's error, not the engine's.
export function checkReplProbe(probe, { surfaces } = {}) {
  const where = surfaces ? ` (surfaces ${surfaces})` : '';
  if (!probe || typeof probe !== 'object') return [result('repl-probe', 'fail', `the probe printed no result${where}`)];
  const browser = surfaces ? surfaces.split(',').map(part => part.trim()).includes('browser') : undefined;
  const missing = name => probe.kinds?.[name] !== 'function';
  const describe = name => `${name.includes('.') ? name : `cua.${name}`} is ${probe.kinds?.[name] ?? 'missing'}`;
  const browserGone = BROWSER_METHODS.filter(missing);
  if (browser === undefined && browserGone.length) {
    return [result('repl-probe', 'error', `the probe didn't say which surfaces the engine ran with, so ${browserGone.map(describe).join('; ')} can't be judged (the engine defines them only with CUA_REPL_ENABLED_SURFACES including browser)`)];
  }
  const checked = browser === false ? CUA_METHODS.filter(name => !BROWSER_METHODS.includes(name)) : CUA_METHODS;
  const problems = [];
  for (const name of [...checked, 'nodeRepl.write', 'nodeRepl.emitImage']) if (missing(name)) problems.push(describe(name));
  const apps = probe.state?.apps?.['[]'];
  if (!probe.state?.apps || !('[]' in probe.state.apps)) problems.push('getState() has no apps array');
  else if (apps && Object.keys(apps).length && apps.id !== 'string') problems.push('getState() apps have no string id');
  const listed = probe.apps?.['[]'];
  if (!probe.apps || !('[]' in probe.apps)) problems.push('listApps() returned no array');
  else if (listed && Object.keys(listed).length) {
    if (listed.id !== 'string') problems.push('listApps() rows have no string id');
    const windows = listed.windows?.['[]'];
    if (listed.windows && !windows) problems.push('listApps() windows is not an array');
    if (windows && Object.keys(windows).length && (windows.id !== 'number' || windows.app !== 'string')) problems.push('listApps() windows lack a numeric id or an app name');
  }
  const skipped = browser === false ? '; browser methods not checked, as the engine ran without the browser surface' : '';
  return [problems.length ? result('repl-probe', 'fail', `${problems.join('; ')}${where}`)
    : result('repl-probe', 'pass', `${checked.length} cua methods, getState and listApps shapes as expected${where}${skipped}`)];
}
