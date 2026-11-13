import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { PassThrough } from 'node:stream';

const mutations = {
  session: ['relay.mjs', 'checkSessionMenu(action, paymentMessages.menuRequests());', ''],
  dedup: ['runtime-select.mjs', "if (coalesceTrees(item.text) &&", "if (false &&"],
  order: ['runtime-select.mjs', 'displayed.slice(index + 1).some', 'displayed.slice(0, index).some'],
  window: ['runtime-select.mjs', 'JSON.stringify([row.window.windowId, row.window.pid, row.window.processStart, row.window.bundleId])', "'shared'"],
  geometry: ['mac-safety.mjs', 'const expected = menuRead ?', 'const expected = true ?'],
  'partial-menu': ['mac-safety.mjs', "result.truncated === false && Number.isSafeInteger(result.readId)", 'Number.isSafeInteger(result.readId)'],

};
let hook;
if (process.env.GLC1_MUTANT) {
  const [file, before, after] = mutations[process.env.GLC1_MUTANT];
  const target = new URL('../plugins/sleight/lib/' + file, import.meta.url).href;
  hook = registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (url !== target) return loaded;
    assert.ok(String(loaded.source).includes(before), 'mutation anchor');
    return { ...loaded, source: String(loaded.source).replace(before, after) };
  } });
}
const { createOwnRuntime } = await import('../plugins/sleight/lib/runtime-select.mjs');
const { createRelay } = await import('../plugins/sleight/lib/relay.mjs');
const { createMacReadState } = await import('../plugins/sleight/lib/mac-driver/diff.mjs');
const { prepareMacInputRegistrar } = await import('../plugins/sleight/lib/mac-driver/input-registrar.mjs');
process.on('exit', () => hook?.deregister());

const window = { windowId: '101', processStart: '100.25', pid: 120, bundleId: 'com.apple.calculator',
  app: 'Calculator', title: 'Calculator', identityVerified: true, onScreen: true, minimized: false,
  bounds: { x: 0, y: 0, width: 320, height: 500 } };
const header = 'Window: "Calculator", App: Calculator.\n0 standard window Calculator, ID: main';
const rows = value => [
  'container ID: keypad',
  ...(value === '735' ? ['\tscroll area ID: StandardResultView', '\t\ttext Description: Last Expression, Value: 15 × 49'] : []),
  `\tscroll area ID: StandardInputView;value:${value}`,
  `\t\ttext Description: Edit field, Value: ${value}`,
  '\tbutton Description: Delete, ID: Delete',
  `\tbutton Description: ${value === '0' ? 'All Clear' : 'Clear'}, ID: ${value === '0' ? 'AllClear' : 'Clear'}`,
  ...['Seven', 'One', 'Multiply', 'Four', 'Three', 'Equals'].map(id => '\tbutton Description: ' + id + ', ID: ' + id),
];
const tree = value => header + '\n' + rows(value).map((row, i) => {
  const indent = /^\t*/.exec(row)[0]; return '\t' + indent + (i + 1) + ' ' + row.slice(indent.length);
}).join('\n');
const binding = { windowId: window.windowId, processStart: window.processStart };
const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

async function fixture(t, { initial = tree('735'), afterClick, menu, partial, missingRead, changedIdentity, readSequence, menuBounds, twoWindows, realPolicy } = {}) {
  let readId = 0, current = initial, id = 0, buffer = '';
  let live = structuredClone(window);
  const calls = [], pending = new Map();
  const driver = { async restart() {}, async close() {}, async ping() { return { build: 'a'.repeat(64) }; },
    async request(method, params) {
      const selected = twoWindows && (params?.selector === 'Other' || params?.windowId === '102') ? { ...live, windowId: '102' } : live;
      calls.push({ method, params: structuredClone(params) });
      if (method === 'inputGateState') return { enabled: true };
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid,
        processStart: window.processStart }, windows: [structuredClone(selected)] };
      if (method === 'verifyWindowIdentity') return { window: structuredClone(selected) };
      if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
      if (method === 'personState') return { token: 'fixture', personTookOver: false };
      if (method === 'getAXState') return { window: structuredClone(selected), text: readSequence?.[Math.min(readId, readSequence.length - 1)] ?? current, readId: ++readId, truncated: false };
      assert.equal(method, 'click');
      assert.equal(params.readId, readId, 'native input uses the current admission read');
      current = afterClick?.(current, params.args[0]) ?? current;
      if (menu) live = { ...live, ...changedIdentity, bounds: { ...live.bounds, width: 600, ...menuBounds } };
      return { window: structuredClone(live), readId, delivery: 'sent-unverified', retry: 'read-first',
        ...menu ? { semantics: 'menu-accessibility', ...missingRead ? {} : { text: current, readId: ++readId, truncated: !!partial } } : {} };
    } };
  const runtime = createOwnRuntime({ driver, compactReads: false, inputRegistrar: await prepareMacInputRegistrar(driver, 'a'.repeat(64)),
    lease: { acquire: () => 'fixture', grant: () => ({ token: 'fixture' }), renew() {}, renewGrant() {}, release() {}, close() {} },
    approve: () => true, policy: () => ({ allow: true }), targetParents: () => [1],
    ancestry: () => [{ pid: 500, path: '/fixture/Host' }], ownHostPid: () => false,
    permissions: { app() {}, page() {}, sitesLimited: () => false }, replOptions: { environment: () => ({}) },
  });
  const input = new PassThrough(), output = new PassThrough(), bridge = runtime.createTransport(output);
  const relay = createRelay({ clientIn: input, clientOut: bridge.clientOut, serverIn: runtime.serverIn, serverOut: runtime.serverOut,
    nativeMac: true, nativeSession: bridge.nativeSession, documentationTrust: runtime.documentationTrust,
    permissions: { app() {}, page() {}, sitesLimited: () => false }, ownHostPid: () => false,
    changeReview: false, warmRepl: false, warmEngine: false, simFocusNote: false, idleTurnEndMs: 0 });
  t.after(async () => { await relay.close(); bridge.close(); await runtime.close(); input.destroy(); output.destroy(); });
  if (!realPolicy) runtime.safety.setPolicy({ checkPause() {}, beforeAction: ({ args }) => ({ args }) });
  output.setEncoding('utf8').on('data', bytes => {
    buffer += bytes;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message.result); pending.delete(message.id);
    }
  });
  const js = code => new Promise(resolve => {
    pending.set(++id, resolve);
    input.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  });
  return { js, calls, change: value => { current = value; }, move: () => { live.bounds.x++; } };
}

test('GLA1 initial getApp, getAXState and String(state) print one full tree', { skip: replWorkerSkip }, async t => {
  const large = tree('735') + Array.from({ length: 200 }, (_, i) => `\n\t${rows('735').length + i + 1} button Menu item ${i}, ID: item-${i}`).join('');
  const f = await fixture(t, { initial: large });
  const result = await f.js('let app = await cua.getApp("Calculator"); let state = await app.getAXState(); nodeRepl.write(String(state));');
  assert.equal(result.isError, false, text(result));
  assert.equal(result.content.filter(item => item.text === large).length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result.content)) < Buffer.byteLength(large) + 3200);
  assert.equal((await f.js('await app.click({id:"Seven"}); void 0;')).isError, false, 'one complete copy establishes delivery');
});
test('archived GLA1 first read is complete and below the paired engine result size', { skip: replWorkerSkip }, async t => {
  const captured = readFileSync(new URL('./fixtures/glc1-calculator-closed.txt', import.meta.url), 'utf8');
  assert.equal(Buffer.byteLength(captured), 16559, 'complete archived Calculator tree');
  const f = await fixture(t, { initial: captured });
  const result = await f.js('let app = await cua.getApp("Calculator"); let state = await app.getAXState(); nodeRepl.write(String(state));');
  assert.equal(result.isError, false, text(result));
  assert.equal(result.content.filter(item => item.text === captured).length, 1);
  const bytes = Buffer.byteLength(JSON.stringify(result.content));
  assert.ok(bytes < 27875, 'paired GLA1 ChatGPT-engine first result: 27,875 compact JSON bytes');
  t.diagnostic(`firstReadContentBytes=${bytes}; treeBytes=${Buffer.byteLength(captured)}; copies=1`);
});
for (const hidden of [false, true]) test(`a return to an earlier tree preserves the final state, hidden middle=${hidden}`, { skip: replWorkerSkip }, async t => {
  const first = tree('7'), middle = tree('71');
  const f = await fixture(t, { readSequence: [first, middle, first] });
  const result = await f.js(`let app = await cua.getApp("Calculator"); await app.getAXState(${hidden ? '{emit:false}' : ''}); await app.getAXState(); void 0;`);
  assert.equal(result.isError, false, text(result));
  const trees = result.content.filter(item => item.text?.startsWith('Window:')).map(item => item.text);
  assert.deepEqual(trees, hidden ? [first] : [middle, first]);
});

for (const selector of ['id', 'label']) test(`E2b permits AllClear identity drift after Seven via ${selector}`, { skip: replWorkerSkip }, async t => {
  const initial = tree('0');
  const f = await fixture(t, { initial, afterClick: () => tree('7') });
  await f.js('let app = await cua.getApp("Calculator");');
  const result = await f.js(`await app.click({${selector}:"Seven"}); await app.click({${selector}:"One"}); void 0;`);
  assert.equal(result.isError, false, text(result));
  assert.equal(f.calls.filter(row => row.method === 'click').length, 2);
});

test('recorded AllClear then Seven then One reaches all three unchanged controls', { skip: replWorkerSkip }, async t => {
  const initial = tree('735').replace('button Description: Clear, ID: Clear', 'button Description: All Clear, ID: AllClear');
  const f = await fixture(t, { initial, afterClick: (_current, target) => tree(target.id === 'AllClear' ? '0' : '7') });
  await f.js('let app = await cua.getApp("Calculator");');
  const result = await f.js('for (const id of ["AllClear","Seven","One"]) await app.click({id}); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.equal(f.calls.filter(row => row.method === 'click').length, 3);
});

test('a native menu complete post-read adopts its own resize and prints the mechanism', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { menu: true });
  await f.js('let app = await cua.getApp("Calculator");');
  const result = await f.js('await app.click({id:"Seven"}); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /Menu pressed via AX/);
  f.move();
  const stopped = await f.js('await app.click({id:"One"}); void 0;');
  assert.equal(stopped.isError, true); assert.match(text(stopped), /IDENTITY_CHANGED.*step=bounds/);
  assert.equal(f.calls.filter(row => row.method === 'click').length, 1, 'external movement stops the successor before input');
});
for (const options of [{ menu: true, partial: true }, { menu: true, missingRead: true },
  { menu: true, changedIdentity: { pid: 121 } }, { menu: true, changedIdentity: { processStart: 'other' } },
  { menu: true, changedIdentity: { windowId: '102' } }]) test('a menu receipt cannot adopt unproved geometry: ' + JSON.stringify(options), { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, options); await f.js('let app = await cua.getApp("Calculator");');
  const result = await f.js('await app.click({id:"Seven"}); void 0;');
  assert.equal(result.isError, true, text(result)); assert.match(text(result), /IDENTITY_CHANGED.*step=/);
  assert.equal(f.calls.filter(row => row.method === 'click').length, 1);
});

function selection(before, after, target) {
  const state = createMacReadState(), snapshot = state.read({ window, text: before, readId: 1 });
  state.endCell([{ type: 'text', text: before }], [snapshot]);
  state.read({ window, text: after, readId: 2 });
  return () => state.assertCurrent('click', { ...binding, readId: 2, args: [target] }, 'cell');
}
const closedMenu = '\n12 menu bar\n\t13 Edit\n\t\t14 menu (collapsed) Secondary Actions: cancel\n\t\t\t15 menu item (disabled, selectable, collapsed) Undo, ID: undo';
test('an unrelated closed-menu enabled or label update leaves a unique control usable', () => {
  const before = tree('7') + closedMenu;
  const after = before.replace('Value: 7', 'Value: 71').replace('menu item (disabled, selectable, collapsed) Undo', 'menu item (selectable, collapsed) Undo Typing');
  assert.doesNotThrow(selection(before, after, { id: 'Seven' }));
});
test('a menu item selection gain still refuses a unique control', () => {
  const before = tree('7') + closedMenu;
  const after = before.replace('(disabled, selectable, collapsed) Undo', '(selected, collapsed) Undo');
  assert.throws(selection(before, after, { id: 'Seven' }), { code: 'STALE_READ', delivery: 'not-sent' });
});
for (const [name, change] of [
  ['label', s => s.replace('Description: Seven', 'Description: Changed')],
  ['disabled', s => s.replace('button Description: Seven', 'button (disabled) Description: Seven')],
  ['parent', s => s.replace('container ID: keypad', 'container ID: replaced')],
  ['ambiguous', s => s + '\n\t12 button Description: Seven, ID: Seven'],
  ['surface', s => s + '\n\t12 sheet Payment'],
]) test(`unique ID refuses ${name} changes before input`, () => {
  const before = tree('7'), after = change(before);
  assert.throws(selection(before, after, { id: 'Seven' }), { code: 'STALE_READ', delivery: 'not-sent' });
});
for (const selector of [{ id: 'pay' }, { label: 'Pay now' }]) test(`consequential selector binds the whole tree: ${JSON.stringify(selector)}`, () => {
  const before = header + '\n\t1 button Pay now, ID: pay\n\t2 text Total $5';
  assert.throws(selection(before, before.replace('$5', '$500'), selector), { code: 'STALE_READ', delivery: 'not-sent' });
});
test('a changed numbered target still refuses', () => {
  assert.throws(selection(tree('7'), tree('7').replace('Description: Seven', 'Description: Changed'), 6), { code: 'STALE_READ', delivery: 'not-sent' });
});
test('all broken variants retain an exact source anchor', () => {
  for (const [file, anchor] of Object.values(mutations))
    assert.ok(readFileSync(new URL('../plugins/sleight/lib/' + file, import.meta.url), 'utf8').includes(anchor), file);
});

test('identical trees from two distinct windows remain two observations', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { twoWindows: true });
  const result = await f.js('let a = await cua.getApp("Calculator"); let b = await cua.getApp("Other"); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.equal(result.content.filter(item => item.text === tree('735')).length, 2);
});
for (const menuBounds of [{ x: 1 }, { y: 1 }, { x: 1, width: 600 }]) test('a complete exact-identity menu post-read adopts its new bounds ' + JSON.stringify(menuBounds), { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { menu: true, menuBounds });
  await f.js('let app = await cua.getApp("Calculator");');
  const result = await f.js('await app.click({id:"Seven"}); void 0;');
  assert.equal(result.isError, false, text(result)); assert.match(text(result), /Menu pressed via AX/);
  assert.equal(f.calls.filter(row => row.method === 'click').length, 1);
});

for (const [target, title, expected] of [[3, 'View', /Menu title:/], [5, 'Quit Calculator…', /Not requested/],
  [5, 'Log Out Chris…', /Not requested/], [5, 'Shut Down…', /Not requested/]]) test('the relay blocks unrequested menu input: ' + title, { skip: replWorkerSkip }, async t => {
  const initial = header + '\n1 button Other\n2 menu bar\n\t3 ' + (target === 3 ? title : 'View') + '\n\t\t4 menu (collapsed)\n\t\t\t5 menu item ' + (target === 3 ? 'Basic' : title);
  const f = await fixture(t, { initial, realPolicy: true });
  assert.equal((await f.js('let app = await cua.getApp("Calculator");')).isError, false);
  const result = await f.js('await app.click(' + target + '); void 0;');
  assert.equal(result.isError, true, text(result)); assert.match(text(result), expected);
  assert.equal(f.calls.filter(row => row.method === 'click').length, 0);
});
