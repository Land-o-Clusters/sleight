import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

let hook;
if (process.env.GLS2B_REPL_MUTANT) hook = registerHooks({ load(url, context, next) {
  const loaded = next(url, context), source = String(loaded.source);
  const variant = process.env.GLS2B_REPL_MUTANT;
  const file = variant === 'focus' ? 'mac-driver/errors.mjs' : ['scope', 'parse', 'module'].includes(variant) ? 'repl/rebindings.mjs' :
    ['popup-exact', 'baseline'].includes(variant) ? 'mac-driver/diff.mjs' : variant === 'lazy-apple' ? 'mac-driver/compound/helper.mjs' :
      variant === 'request-path' ? 'quit-key.mjs' : 'repl/worker.mjs';
  if (url !== new URL('../plugins/sleight/lib/' + file, import.meta.url).href) return loaded;
  const [before, after] = variant === 'focus' ? ["...code === 'KEY_FOCUS_UNAVAILABLE' && focusErrorStep(source)", '...false && focusErrorStep(source)'] :
    variant === 'module' ? ['import { parseScript }', 'import { parseModule as parseScript }'] :
    variant === 'eager-names' ? ['code = normalized.code; nextDeclared = normalized.names;',
      'code = normalized.code; declared = normalized.names; nextDeclared = normalized.names;'] :
    variant === 'scope' ? ["if (node.type !== 'VariableDeclaration'", "if (node.type === 'BlockStatement') node = node.body[0]; if (node.type !== 'VariableDeclaration'"] :
    variant === 'parse' ? ['lexical: true', 'lexical: false'] :
    variant === 'popup-exact' ? ['if (JSON.stringify(expanded(delivered)) !== JSON.stringify(expanded(current))) return true;', ''] :
    variant === 'baseline' ? ['entry.delivered = observed; entry.actions = undefined;',
      'entry.delivered = {...observed, snapshot: {...observed.snapshot, text: observed.snapshot.text + "\\n\\t" + observed.lines.length + " menu item RAW_PRIVATE_RECENT"}}; entry.actions = undefined;'] :
    variant === 'lazy-apple' ? ["if (intent.operation === 'menu' && /", "if (false && /"] :
    variant === 'request-path' ? ['if (path) for (const label', 'if (false) for (const label'] :
    ["if (platform === 'darwin') {", 'if (false) {'];
  assert.ok(source.includes(before)); return { ...loaded, source: source.replace(before, after) };
} });
const { createEvaluator } = await import('../plugins/sleight/lib/repl/worker.mjs');
const { formatMacDriverError, MAC_DRIVER_MENU_DETAILS } = await import('../plugins/sleight/lib/mac-driver/errors.mjs');
const { macFocusDiagnostics } = await import('../plugins/sleight/lib/repl/focus-steps.mjs');
const { checkSessionMenu } = await import('../plugins/sleight/lib/session-menu.mjs');
const { createMacReadState, compareMacElement } = await import('../plugins/sleight/lib/mac-driver/diff.mjs');
const { createMacReplClient } = await import('../plugins/sleight/lib/repl/client.mjs');
const { compoundFixture } = await import('./fixtures/compound-runtime.mjs');
const { requestedQuitApps } = await import('../plugins/sleight/lib/quit-key.mjs');
process.on('exit', () => hook?.deregister());
const text = result => result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
const window = { app: 'Calculator', title: 'Calculator', windowId: '7', processStart: '1.2', pid: 42,
  bundleId: 'test.fixture', identityVerified: true };
const closed = 'Window: "Calculator", App: Calculator.\n0 standard window Calculator\n\t1 button Mode, ID: Mode';
const open = closed + '\n\t\t2 menu (expanded)\n\t\t\t3 menu item Basic\n\t\t\t4 menu item Scientific';
const fixture = t => {
  const requests = [];
  const instance = createEvaluator({ platform: 'darwin', request: async (method, params) => {
    requests.push({ method, params });
    if (method === 'getApp') return { window, readId: 1, text: closed };
    if (method === 'getAXState') return { window, readId: 2, text: closed };
    return { window, readId: 3, delivery: 'sent-unverified' };
  } });
  t.after(() => instance.close()); return { instance, requests };
};
test('GLS1-9 app, s, state and const redeclarations become assignments across cells', async t => {
  const { instance } = fixture(t);
  for (const code of [
    'let app = await cua.getApp("Calculator"); let s = await app.getAXState(); nodeRepl.write(String(s));',
    'let app = await cua.getApp("Calculator"); let s = await app.getAXState(); let t = String(s); nodeRepl.write(t.length + "\\n" + t.slice(0, 6000));',
    'const app = await cua.getApp("Calculator"); const s = await app.getAXState(); nodeRepl.write(s);',
    'let state = 1; const fixed = 2; nodeRepl.write(state + fixed);',
    'const state = 4, fresh = 8; let fixed = 3; nodeRepl.write(state + fixed + fresh);',
  ]) {
    const result = await instance.evaluate(code); assert.equal(result.isError, false, text(result));
  }
  assert.equal(text(await instance.evaluate('state + fixed + fresh')), '15');
});
test('rebinds survive real permission-limited worker IPC', { skip: replWorkerSkip }, async t => {
  const driver = { async request(method) { return { window, readId: 1, text: closed }; }, async close() {}, async restart() {} };
  const client = createMacReplClient({ driver, admit: () => true, environment: () => ({}) }); t.after(() => client.close());
  for (const code of ['let app = await cua.getApp("Calculator");', 'const app = await cua.getApp("Calculator");']) {
    const result = await client.execute({ code }); assert.equal(result.isError, false, text(result));
  }
  for (const code of ['let a = await Promise.reject(Error("initializer"))', 'let b = 1; throw Error("after declaration")'])
    assert.equal((await client.execute({ code })).isError, true);
  const recovered = await client.execute({ code: 'let a=2; let b=3; nodeRepl.write(a+b)' });
  assert.equal(recovered.isError, false, text(recovered)); assert.equal(text(recovered), '5');
});
test('the worker cannot name a submenu disclosure request in read options', async t => {
  const { instance, requests } = fixture(t); await instance.evaluate('let app=await cua.getApp("Calculator");');
  const before = requests.length;
  const result = await instance.evaluate('await app.getAXState({menuRequests:["Recent Items"]});');
  assert.equal(result.isError, true); assert.equal(requests.length, before);
});
for (const [name, code] of [
  ['same-cell let duplicate', 'let app=1; let app=2;'],
  ['same-cell const duplicate', 'const app=1; const app=2;'],
  ['mixed duplicate', 'let app=1; var app=2;'],
  ['malformed initializer', 'let app = ;'],
  ['missing const initializer', 'const app;'],
  ['duplicate parameter in strict script', '"use strict"; function f(a,a){}'],
]) test('keeps parse refusal: ' + name, async t => {
  const { instance, requests } = fixture(t); await instance.evaluate('let app = 10;');
  const result = await instance.evaluate(code);
  assert.equal(result.isError, true, text(result)); assert.match(text(result), /SyntaxError/);
  assert.equal(text(await instance.evaluate('app')), '10'); assert.equal(requests.length, 0);
});
for (const [name, code, expected] of [
  ['duplicate top-level functions', 'function f(){return 1;} function f(){return 2;} f()', '2'],
  ['with statement', 'with(Math){ nodeRepl.write(floor(2.9)); }', '2'],
  ['legacy octal', 'var octal = 010; octal', '8'],
  ['delete identifier', 'delete absentSloppyName', 'true'],
  ['yield identifier', 'var yield = 1; yield', '1'],
  ['duplicate sloppy parameters', 'function f(a,a){return a;} f(1,2)', '2'],
  ['if function', 'if (1) function f(){return 3;} f()', '3'],
  ['labelled function', 'label: function g(){return 4;} g()', '4'],
  ['HTML close comment', 'var a=1\n--> comment\na', '1'],
  ['catch var', 'try{throw 7}catch(e){var e; nodeRepl.write(e)}', '7'],
]) test('preserves sloppy-script cell: ' + name, async t => {
  const { instance } = fixture(t);
  const result = await instance.evaluate(code);
  assert.equal(result.isError, false, text(result));
  assert.equal(text(result), expected);
});
for (const first of ['let a = await Promise.reject(Error("initializer"))',
  'let a = 1; throw Error("after declaration")']) test('rebinding recovers after ' + first, async t => {
  const { instance } = fixture(t);
  assert.equal((await instance.evaluate(first)).isError, true);
  const next = await instance.evaluate('let a = 2; a');
  assert.equal(next.isError, false, text(next)); assert.equal(text(next), '2');
});
test('an unexecuted TDZ binding is not recorded as a completed declaration', async t => {
  const { instance } = fixture(t);
  const failed = await instance.evaluate('throw Error("before declaration"); const later = 1;');
  assert.equal(failed.isError, true); assert.match(text(failed), /before declaration/);
  const next = await instance.evaluate('const later = 2; later');
  // Node retains the uninitialized lexical binding. A fresh declaration must
  // reach Node's redeclaration check instead of an assignment into that TDZ.
  assert.equal(next.isError, true); assert.match(text(next), /SyntaxError: Identifier 'later' has already been declared/);
});
test('Node compile failure cannot make the next declaration an implicit global', async t => {
  const { instance } = fixture(t);
  // The async-body parse accepts return; the real REPL rejects it as a script.
  const failed = await instance.evaluate('return; const neverRan = 1;');
  assert.equal(failed.isError, true); assert.match(text(failed), /SyntaxError/);
  const next = await instance.evaluate('const neverRan = 2; [neverRan, Object.hasOwn(globalThis,"neverRan")].join(":")');
  assert.equal(next.isError, false, text(next)); assert.equal(text(next), '2:false');
});
test('nested block, function, loop, strings, comments and templates preserve scope', async t => {
  const { instance } = fixture(t); await instance.evaluate('let app=10;');
  for (const code of ['{ let app=20; }', 'function f(){ const app=30; return app; }',
    'for(let app=0;app<2;app++){}', '`let app = 40`', '"const app = 40"', '/* let app=40; */ void 0;'])
    assert.equal((await instance.evaluate(code)).isError, false, code);
  assert.equal(text(await instance.evaluate('app')), '10'); assert.equal(text(await instance.evaluate('f()')), '30');
});
test('runtime failure after a redeclaration never replays a cell', async t => {
  const { instance, requests } = fixture(t);
  await instance.evaluate('let app = await cua.getApp("Calculator");');
  const result = await instance.evaluate('let app = await cua.getApp("Calculator"); throw Error("after acquisition");');
  assert.equal(result.isError, true); assert.equal(requests.filter(x => x.method === 'getApp').length, 2);
});
test('var, function, class and destructuring bindings can be rebound by top-level let or const', async t => {
  const { instance } = fixture(t);
  for (const code of ['var app=1; function other(){}; class Third{};',
    'let app=2; const other=3; let Third=4;',
    'const {a,b}={a:1,b:2};', 'let {a,c}={a:5,c:8};',
    'const [b,...rest]=[6,9,10];', 'const [b,...rest]=[7,11];']) {
    const result = await instance.evaluate(code); assert.equal(result.isError, false, text(result));
  }
  assert.equal(text(await instance.evaluate('app+other+Third+a+b+c+rest[0]')), '40');
});
test('GLS1-7a title refusal states the item-number and compound alternatives in fixed words', () => {
  assert.throws(() => checkSessionMenu({ method: 'click', args: [2], window,
    text: '0 standard window\n1 menu bar\n\t2 View\n\t\t3 menu (collapsed)\n\t\t\t4 menu item Basic' }), error => {
    assert.ok(formatMacDriverError(error).includes(MAC_DRIVER_MENU_DETAILS['menu-compound']));
    assert.match(error.message, /Menu title:/); assert.match(error.message, /click the item's number; the menu need not be open/); return true;
  });
});
test('GLS1-7d every fixed KEY_FOCUS_UNAVAILABLE step survives formatting without provider text', () => {
  for (const message of macFocusDiagnostics()) {
    const formatted = formatMacDriverError({ code: 'KEY_FOCUS_UNAVAILABLE', message, delivery: 'not-sent', retry: 'safe' });
    assert.ok(formatted.includes(message.slice('KEY_FOCUS_UNAVAILABLE'.length) + ';'), formatted);
  }
  assert.doesNotMatch(formatMacDriverError({ code: 'KEY_FOCUS_UNAVAILABLE', message: 'step=private-file.txt' }), /step=|private-file/);
});
test('GLS1-7d KEY_FOCUS_UNAVAILABLE step survives the real worker boundary', { skip: replWorkerSkip }, async t => {
  const driver = { async request(method) {
    if (method === 'pressKey') throw Object.assign(Error('KEY_FOCUS_UNAVAILABLE step=frontmost'),
      { code: 'KEY_FOCUS_UNAVAILABLE', delivery: 'not-sent', retry: 'safe' });
    return { window, readId: 1, text: closed };
  }, async close() {}, async restart() {} };
  const client = createMacReplClient({ driver, admit: () => true, environment: () => ({}) }); t.after(() => client.close());
  await client.execute({ code: 'let app = await cua.getApp("Calculator");' });
  const result = await client.execute({ code: 'await app.pressKey("super+2");' });
  assert.equal(result.isError, true); assert.match(text(result), /KEY_FOCUS_UNAVAILABLE:.*step=frontmost;/);
});
const deliver = (state, tree, readId) => {
  const snapshot = state.read({ window, readId, text: tree, truncated: false });
  state.endCell([{ type: 'text', text: tree }], [snapshot]);
};
test('D6 delivered collapsed menu refuses when fresh popup prints expanded', () => {
  const state = createMacReadState(); deliver(state, open.replace('(expanded)', '(collapsed)'), 1);
  state.read({ window, readId: 2, text: open });
  assert.throws(() => state.assertCurrent('click', { ...window, readId: 2, args: [4] }, 2), { code: 'STALE_READ' });
  const fresh = createMacReadState(); deliver(fresh, open, 1); fresh.read({ window, readId: 2, text: open });
  assert.doesNotThrow(() => fresh.assertCurrent('click', { ...window, readId: 2, args: [4] }, 2));
});
for (const body of ['menu item Font (submenu, 12 items)', 'menu item Description: Font (submenu, 12 items)'])
  test('C parent submenu title still binds a selector: ' + body, () => {
    const state = createMacReadState(), tree = closed + '\n\t2 ' + body;
    deliver(state, tree, 1); state.read({ window, readId: 2, text: tree });
    assert.doesNotThrow(() => state.assertCurrent('click', { ...window, readId: 2, args: [{ label: 'Font' }] }, 2));
  });
test('D4 expanded menu is byte-exact, including sibling, help and flags', () => {
  for (const after of [open.replace('Basic', 'Renamed'), open.replace('Basic', 'Basic, Help: Changed'), open.replace('Basic', '(disabled) Basic')])
    assert.equal(compareMacElement(open, after, 4).to, undefined);
});
test('D10 consequential popup leaf allows only a byte-equal whole read', () => {
  const before = open.replace('Scientific', 'Pay now');
  assert.equal(compareMacElement(before, before, 4).to, 4);
  assert.equal(compareMacElement(before, before.replace('Mode', 'Other'), 4).to, undefined);
});
test('D14 open-and-pick in one cell refuses an item outside the delivered read', () => {
  const state = createMacReadState(); deliver(state, closed, 1);
  state.assertCurrent('click', { ...window, readId: 1, args: [1] }, 1);
  state.read({ window, readId: 2, text: open });
  assert.throws(() => state.assertCurrent('click', { ...window, readId: 2, args: [4] }, 1), { code: 'STALE_READ' });
});
test('C11 emit:false reads and the next diff never print unprinted submenu text', () => {
  const state = createMacReadState();
  const tree = closed + Array.from({ length: 30 }, (_, i) => `\n\t${i + 2} button Public ${i}`).join('');
  const first = state.read({ window, readId: 1, text: tree, truncated: false });
  const full = state.prepareDisplay([{ type: 'text', text: tree }], [first], { compact: true }); full.commit();
  state.read({ window, readId: 2, text: tree, truncated: false }); // emit:false
  const changed = tree.replace('button Mode,', 'button Mode changed,');
  const third = state.read({ window, readId: 3, text: changed, truncated: false });
  const diff = state.prepareDisplay([{ type: 'text', text: changed }], [third], { compact: true });
  assert.doesNotMatch(JSON.stringify(diff.content), /RAW_PRIVATE_RECENT|_recentItemRequested:|private-file/);
  diff.commit();
});
for (const unopened of [true, false]) for (const requested of [true, false])
  test(`C3, C4 and C12 Apple Recent Items ${unopened ? 'direct' : 'lazy'} requested=${requested}`, async () => {
    const h = compoundFixture('menu', { unopened, parent: { application: 'Fixture', menuRequests: () =>
      requestedQuitApps(requested ? 'open Memo-acda03e0.docx from Recent Items' : 'Read Calculator', { menu: true }) } });
    h.intent.segments = ['Apple', 'Recent Items', 'Memo-acda03e0.docx'];
    h.node('edit').title = 'Apple'; h.node('find').title = 'Recent Items'; h.node('command').title = 'Memo-acda03e0.docx';
    const result = await h.run();
    if (requested) assert.equal(result.state, 'completed', JSON.stringify(result));
    else { assert.equal(result.stop?.reason, 'BOUNDARY_REQUIRED', JSON.stringify(result)); assert.equal(h.mutations.length, 0); }
    assert.ok(!JSON.stringify(result).includes('Unrequested sibling'));
  });
for (const path of [['File', 'Open Recent', 'x.txt'], ['Format', 'Font', 'Bold'], ['Calculator', 'Services', 'Service']])
  test('C6-8 hidden submenu compound path remains resolvable: ' + path.join(' > '), async () => {
    const h = compoundFixture('menu', { unopened: true }); h.intent.segments = path;
    for (const [token, label] of ['edit', 'find', 'command'].map((token, i) => [token, path[i]])) h.node(token).title = label;
    const result = await h.run(); assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(h.mutations.length, 1); assert.equal(h.mutations[0].node, 'command');
  });
