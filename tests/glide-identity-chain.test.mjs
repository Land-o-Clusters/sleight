import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { PassThrough } from 'node:stream';

// The complete parent policy and worker transport run against an inert driver.
// Mutations run this file in separate processes, without reaching macOS.
const mutations = {
  baseline: ['relay.mjs', 'const expected = helper === undefined ? { ...windowFromText(baseline), title: window.title } : windowFromText(baseline);',
    'const expected = windowFromText(baseline);'],
  guard: ['relay.mjs', 'expected, undefined, undefined, { careful: true, payment,',
    'windowFromText(baseline), undefined, undefined, { careful: true, payment,'],
  bounds: ['mac-safety.mjs', 'DRIVER_ACTION_METHODS.includes(operation) || expected.title !== app.title',
    'expected.title !== app.title'],
  pid: ['repl/identity.mjs', "['windowId', 'processStart', 'pid', 'bundleId']", "['windowId', 'processStart', 'bundleId']"],
  start: ['repl/identity.mjs', "['windowId', 'processStart', 'pid', 'bundleId']", "['windowId', 'pid', 'bundleId']"],
  number: ['repl/identity.mjs', "['windowId', 'processStart', 'pid', 'bundleId']", "['processStart', 'pid', 'bundleId']"],
  surfaces: ['relay.mjs', "if (macInputSurfaceChanged(baseline, text)) stop('IDENTITY_CHANGED', 'surface');", ''],
};
let hook;
if (process.env.GL6B_MUTANT) {
  const [file, before, after] = mutations[process.env.GL6B_MUTANT];
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
const { prepareMacInputRegistrar } = await import('../plugins/sleight/lib/mac-driver/input-registrar.mjs');
hook?.deregister();

const window = { windowId: '101', processStart: '100.25', pid: 120, bundleId: 'org.test.Editor',
  app: 'Editor', title: 'Draft', identityVerified: true, onScreen: true, minimized: false,
  bounds: { x: 0, y: 0, width: 800, height: 600 } };
const tree = 'Window: "Draft", App: Editor.\n0 standard window Draft\n' +
  Array.from({ length: 7 }, (_, i) => `\t${i + 1} button Item ${i + 1}`).join('\n');
const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
const binding = { windowId: window.windowId, processStart: window.processStart };

async function fixture(t, { postRead = false, resultTitle = false, externalAfterType, corroboration } = {}) {
  let live = structuredClone(window);
  if (corroboration) live.identityCorroboration = corroboration;
  let surface = '';
  let readId = 0, current = tree, id = 0, buffer = '';
  const calls = [], pending = new Map();
  const driver = { async restart() {}, async close() {}, async ping() { return { build: 'a'.repeat(64) }; },
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'inputGateState') return { enabled: true };
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid,
        processStart: window.processStart }, windows: [structuredClone(live)] };
      if (method === 'verifyWindowIdentity') {
        if (externalAfterType && calls.some(row => row.method === 'typeText')) Object.assign(live, externalAfterType);
        return { window: structuredClone(live) };
      }
      if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
      if (method === 'personState') return { token: 'fixture', personTookOver: false };
      if (method === 'getAXState') return { window: structuredClone(live), text: current.replaceAll('Draft', live.title) + surface, readId: ++readId, truncated: false };
      assert.ok(['typeText', 'pressKey', 'click'].includes(method), method);
      assert.equal(params.readId, readId, 'native action uses the latest admission read');
      const receipt = structuredClone(live);
      if (method === 'typeText') live.title = 'Draft (Edited)';
      return { window: postRead || resultTitle ? structuredClone(live) : receipt, delivery: 'sent-unverified', retry: 'read-first',
        ...postRead ? { text: current.replaceAll('Draft', live.title), readId: ++readId, truncated: false } : {} };
    } };
  const runtime = createOwnRuntime({ driver, inputRegistrar: await prepareMacInputRegistrar(driver, 'a'.repeat(64)),
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
  const acquired = await js('let app = await cua.getApp("Editor");');
  assert.equal(acquired.isError, false, text(acquired));
  return { js, calls, patch: fields => Object.assign(live, fields), surface: value => { surface = value; } };
}

for (const corroboration of ['window-number', 'pid-bounds-ax-title'])
for (const options of [{ postRead: false }, { resultTitle: true }, { postRead: true }]) {
  test(`edited title then Command+s in one cell: ${corroboration}, ${JSON.stringify(options)}`, { skip: replWorkerSkip }, async t => {
    const f = await fixture(t, { ...options, corroboration });
    const result = await f.js('await app.typeText("Sleight GL1 input smoke\\n"); await app.pressKey("Command+s"); void 0;');
    assert.equal(result.isError, false, text(result));
    assert.deepEqual(f.calls.filter(row => ['typeText', 'pressKey'].includes(row.method)).map(row => row.method), ['typeText', 'pressKey']);
  });
}

for (const [name, patch] of Object.entries({ pid: { pid: 999 }, processStart: { processStart: '999.5' },
  windowNumber: { windowId: '999' }, bounds: { bounds: { ...window.bounds, x: 25 } },
  titleAndBounds: { title: 'Other', bounds: { ...window.bounds, width: 900 } } })) {
  test(`external ${name} change refuses the next key before input`, { skip: replWorkerSkip }, async t => {
    const f = await fixture(t, { postRead: true });
    const typed = await f.js('await app.typeText("fixture"); void 0;');
    assert.equal(typed.isError, false, text(typed));
    f.patch(patch);
    const result = await f.js('await app.pressKey("Command+s"); void 0;');
    assert.equal(result.isError, true, text(result));
    assert.match(text(result), /IDENTITY_CHANGED/);
    assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 0);
  });
  test(`external ${name} change between two actions in one cell refuses the key`, { skip: replWorkerSkip }, async t => {
    const f = await fixture(t, { postRead: true, externalAfterType: patch });
    const result = await f.js('await app.typeText("fixture"); await app.pressKey("Command+s"); void 0;');
    assert.equal(result.isError, true, text(result));
    assert.match(text(result), /IDENTITY_CHANGED/);
    assert.equal(f.calls.filter(row => row.method === 'typeText').length, 1);
    assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 0);
  });
}

test('an explicit session read refreshes a resized window before its next key', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t);
  f.patch({ bounds: { ...window.bounds, x: 25 } });
  const result = await f.js('await app.getAXState({ emit: false }); await app.pressKey("Command+s"); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 1);
});

test('a new sheet between actions still refuses input after a title change', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t);
  assert.equal((await f.js('await app.typeText("fixture"); void 0;')).isError, false);
  f.surface('\n\t8 sheet Confirm');
  const result = await f.js('await app.pressKey("Command+s"); void 0;');
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), /IDENTITY_CHANGED/);
  assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 0);
});

test('a tree-free receipt retains its own admission tree for the next surface check', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t);
  f.surface('\n\t8 menu item (selected) Save');
  assert.equal((await f.js('await app.getAXState({ emit: false }); void 0;')).isError, false);
  // GL9 permits item metadata changes, while root removal now stops input.
  // Clearing selection must become the next action's admission baseline.
  f.surface('\n\t8 menu item (selectable) Save');
  const typed = await f.js('await app.typeText("fixture"); void 0;');
  assert.equal(typed.isError, false, text(typed));
  f.surface('\n\t8 menu item (selected) Save');
  const result = await f.js('await app.pressKey("Command+s"); void 0;');
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), /IDENTITY_CHANGED/);
  assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 0);
});

test('a removed sheet stops input before a tree-free action receipt', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t);
  f.surface('\n\t8 sheet Confirm');
  assert.equal((await f.js('await app.getAXState({ emit: false }); void 0;')).isError, false);
  f.surface('');
  const result = await f.js('await app.typeText("fixture"); void 0;');
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), /IDENTITY_CHANGED step=surface/);
  assert.equal(f.calls.filter(row => row.method === 'typeText').length, 0);
});

test('broken variants have exact source anchors', () => {
  if (process.env.GL6B_MUTANT) return;
  for (const [file, anchor] of Object.values(mutations))
    assert.ok(readFileSync(new URL('../plugins/sleight/lib/' + file, import.meta.url), 'utf8').includes(anchor), file);
});
