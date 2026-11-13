import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { verifyWindowIdentity as verifyEngineIdentity } from '../plugins/sleight/lib/window-identity.mjs';

const mutations = {
  reasons: ['repl/identity.mjs', "throw macIdentityError(identityFieldStep(key))", "fail('IDENTITY_CHANGED')"],
  format: ['mac-driver/errors.mjs', '${error.message}${step}${safeDisposition}', '${error.message}${safeDisposition}'],
  bounds: ['mac-safety.mjs', '!boundsEqual(expected.bounds, app.bounds)', 'false'],
  pid: ['repl/identity.mjs', "['windowId', 'processStart', 'pid', 'bundleId']", "['windowId', 'processStart', 'bundleId']"],
  start: ['repl/identity.mjs', "['windowId', 'processStart', 'pid', 'bundleId']", "['windowId', 'pid', 'bundleId']"],
  number: ['repl/identity.mjs', "['windowId', 'processStart', 'pid', 'bundleId']", "['processStart', 'pid', 'bundleId']"],
  roles: ['mac-driver/surfaces.mjs', "rowRole(body)", "/^(menu|sheet|dialog|alert)(?: |$)/.exec(body)?.[1]"],
  menus: ['mac-driver/surfaces.mjs', "states.filter(state => state !== 'disabled')", 'states'],
  'old-regex': ['mac-driver/surfaces.mjs', 'rowRole(body)', '/^(menu(?! (?:item|bar|button)(?: |$))|sheet|dialog|alert)(?: |$)/.exec(body)?.[1]'],
  selected: ['mac-driver/surfaces.mjs', "selected: states.includes('selected')", 'selected: false'],
  secondary: ['mac-driver/surfaces.mjs', "body.slice(role.length + (state?.[0].length ?? 0))", "body.slice(role.length + (state?.[0].length ?? 0)).replace(/, Secondary Actions:.*$/, '')"],
  metadata: ['repl/identity.mjs', "['windowId', 'processStart', 'pid', 'bundleId']", "['windowId', 'processStart', 'pid', 'bundleId', 'identityCorroboration', 'windowIdentifier']"],
};
let hook;
if (process.env.GL8_MUTANT) {
  const [file, before, after] = mutations[process.env.GL8_MUTANT];
  const target = new URL('../plugins/sleight/lib/' + file, import.meta.url).href;
  hook = registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (url !== target) return loaded;
    assert.ok(String(loaded.source).includes(before), 'mutation anchor');
    return { ...loaded, source: String(loaded.source).replace(before, after) };
  } });
}
const { verifyWindowIdentity } = await import('../plugins/sleight/lib/repl/identity.mjs');
const { formatMacDriverError, normalizeMacDriverError } = await import('../plugins/sleight/lib/mac-driver/errors.mjs');
const { macIdentityStep, macIdentityError } = await import('../plugins/sleight/lib/repl/identity-steps.mjs');
const { createOwnRuntime } = await import('../plugins/sleight/lib/runtime-select.mjs');
const { createRelay } = await import('../plugins/sleight/lib/relay.mjs');
const { helperInspection } = await import('../plugins/sleight/lib/repl/helpers.mjs');
const { prepareMacInputRegistrar } = await import('../plugins/sleight/lib/mac-driver/input-registrar.mjs');
// Keep parent policy mutations active for this process. Worker permissions stay unchanged.
process.on('exit', () => hook?.deregister());

const window = { app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 24944,
  processStart: '1794009283.716096', windowId: '668622', title: 'gl1-ce52e127.txt',
  bounds: { x: 471, y: 392, width: 656, height: 422 }, identityVerified: true,
  identityCorroboration: 'pid-bounds-ax-title', windowIdentifier: '_NS:31',
  windowSubrole: 'AXStandardWindow', onScreen: true, hidden: false, minimized: false,
  fullScreen: false, fullScreenTile: false, focusedSecureField: false, secureInput: false, layer: 0 };
const tree = 'Window: "gl1-ce52e127.txt", App: TextEdit.\n0 standard window gl1-ce52e127.txt\n\t1 text area';
const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

async function fixture(t, { externalAfterType, receiptPatch = {}, treePatch = value => value } = {}) {
  let live = structuredClone(window);
  let menu = false;
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
      if (method === 'getAXState') return { window: structuredClone(live), text: treePatch(current, calls.some(row => row.method === 'typeText')) + (menu ? '\n\t2 sheet Confirm' : ''), readId: ++readId, truncated: false };
      assert.ok(['typeText', 'pressKey', 'click'].includes(method), method);
      assert.equal(params.readId, readId, 'native action uses the latest admission read');
      return { window: { ...structuredClone(live), ...receiptPatch }, delivery: 'sent-unverified', retry: 'read-first' };
    } };
  const runtime = createOwnRuntime({ driver, inputRegistrar: await prepareMacInputRegistrar(driver, 'a'.repeat(64)),
    lease: { acquire: () => 'fixture', grant: () => ({ token: 'fixture' }), renew() {}, renewGrant() {}, release() {}, close() {} },
    approve: () => true, policy: () => ({ allow: true }), targetParents: () => [1],
    ancestry: () => [{ pid: 500, path: '/fixture/Host' }], ownHostPid: () => false,
    permissions: { app() {}, page() {}, sitesLimited: () => false }, replOptions: { environment: () => ({}) },
  });
  const input = new PassThrough(), output = new PassThrough(), bridge = runtime.createTransport(output);
  let policy;
  const setPolicy = bridge.nativeSession.setPolicy;
  bridge.nativeSession.setPolicy = value => { policy = value; return setPolicy.call(bridge.nativeSession, value); };
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
  const acquired = await js('let app = await cua.getApp("TextEdit");');
  assert.equal(acquired.isError, false, text(acquired));
  return { js, calls, policy, patch: fields => Object.assign(live, fields), menu: (value = true) => { menu = value; } };
}

test('live tree-free typing receipt then untargeted Command+s', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t);
  const result = await f.js('const t = await app.typeText("Sleight GL1 input smoke\\n"); console.log(JSON.stringify({readId:t.readId, hasTree:typeof t.text === "string",delivery:t.delivery})); await app.pressKey("Command+s"); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /\"readId\":2,\"hasTree\":false,\"delivery\":\"sent-unverified\"/);
  assert.deepEqual(f.calls.filter(row => ['typeText', 'pressKey'].includes(row.method)).map(row => row.method), ['typeText', 'pressKey']);
  assert.equal(f.calls.find(row => row.method === 'typeText').params.args[0].length, 24);
  assert.equal(f.calls.filter(row => row.method === 'getAXState').length, 4, 'acquisition, one admission read per action, and one final read');
});

for (const [field, value, step] of [['pid', 24945, 'pid'], ['processStart', '1794009284.716096', 'process-start'],
  ['windowId', '668623', 'window-id'], ['bounds', { ...window.bounds, x: 472 }, 'bounds'],
  ['bundleId', 'org.test.Other', 'bundle-id']]) {
  test(`live receipt followed by external ${field} change refuses with ${step}`, { skip: replWorkerSkip }, async t => {
    const f = await fixture(t, { externalAfterType: { [field]: value } });
    const result = await f.js('await app.typeText("fixture"); await app.pressKey("Command+s"); void 0;');
    assert.equal(result.isError, true, text(result));
    assert.match(text(result), new RegExp('IDENTITY_CHANGED[^\\n]*step=' + step));
    assert.equal(f.calls.filter(row => row.method === 'typeText').length, 1);
    assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 0);
  });
}
for (const patch of [{ identityCorroboration: 'window-number' }, { windowIdentifier: undefined },
  { title: window.title, bounds: { height: 422, width: 656, y: 392, x: 471 } }]) {
  test('corroboration labels and property order never change the identity tuple: ' + JSON.stringify(patch), { skip: replWorkerSkip }, async t => {
    const f = await fixture(t, { receiptPatch: patch });
    const result = await f.js('await app.typeText("fixture"); await app.pressKey("Command+s"); void 0;');
    assert.equal(result.isError, false, text(result));
    assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 1);
  });
}
for (const [field, value, step] of [['pid', 24945, 'pid'], ['processStart', 'different', 'process-start'],
  ['windowId', '2', 'window-id'], ['bundleId', 'org.test.Other', 'bundle-id']]) {
  test('worker identity diagnostic: ' + field, () => {
    assert.throws(() => verifyWindowIdentity(window, { ...window, [field]: value }, 'darwin'), error => {
      assert.equal(error.code, 'IDENTITY_CHANGED'); assert.equal(error.identityStep, step);
      assert.match(error.message, new RegExp('step=' + step));
      assert.doesNotMatch(error.message, /gl1-|TextEdit|org\.test|1794009283/); return true;
    });
  });
}
test('a new sheet has a fixed surface diagnostic and sends no key', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t);
  assert.equal((await f.js('await app.typeText("fixture"); void 0;')).isError, false);
  f.menu();
  const result = await f.js('await app.pressKey("Command+s"); void 0;');
  assert.match(text(result), /IDENTITY_CHANGED[^\n]*step=surface/);
  assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 0);
});
test('native and parent identity steps survive formatting without provider text', () => {
  for (const step of ['pid', 'bounds', 'process-start', 'window-id', 'header-parse', 'read-id', 'expected-missing', 'keyboard-pid']) {
    for (const failure of [macIdentityError(step), { code: 'IDENTITY_CHANGED', message: 'private/title step=' + step + ' /private/path' }]) {
      const normalized = normalizeMacDriverError(failure);
      assert.equal(normalized.identityStep, step);
      const rendered = formatMacDriverError(failure);
      assert.match(rendered, new RegExp('step=' + step + ';'));
      assert.doesNotMatch(rendered, /private|title step/);
    }
  }
  for (const value of ['private-title', '../path', 'pid\nprivate', '', undefined]) {
    assert.equal(macIdentityStep(value), undefined);
    assert.equal(normalizeMacDriverError({ code: 'IDENTITY_CHANGED', identityStep: value }).identityStep, undefined);
  }
});
test('every native Glide identity throw has an inventoried fixed step', () => {
  const root = new URL('../plugins/sleight/lib/mac-driver/native/', import.meta.url);
  let sites = 0;
  for (const name of readdirSync(root).filter(name => name.endsWith('.swift'))) {
    const source = readFileSync(new URL(name, root), 'utf8');
    for (const match of source.matchAll(/DriverFault\("IDENTITY_CHANGED"([^)]*)\)/g)) {
      const step = /"IDENTITY_CHANGED step=([a-z-]+)"/.exec(match[1])?.[1];
      assert.equal(macIdentityStep(step), step, name + ': ' + match[0]);
      assert.ok(step, name); sites++;
    }
  }
  assert.ok(sites >= 47, 'native identity throw inventory: ' + sites);
});

test('broken variants have exact source anchors', () => {
  if (process.env.GL8_MUTANT) return;
  for (const [file, anchor] of Object.values(mutations))
    assert.ok(readFileSync(new URL('../plugins/sleight/lib/' + file, import.meta.url), 'utf8').includes(anchor), file);
});

test('serialized engine identity diagnostics name the mismatched field without a closure', () => {
  const verify = runInNewContext('(' + verifyEngineIdentity.toString() + ')');
  const target = { appId: 'org.test.Editor', title: 'Private title', url: null };
  const observed = { ...target, status: 'ok', epoch: 'helper', window: 1, windowNumber: 2,
    pid: 120, processStart: 100.25, matches: 1 };
  for (const [key, value, step] of [['pid', 121, 'pid'], ['processStart', 101, 'process-start'],
    ['window', 3, 'window'], ['epoch', 'other', 'epoch']]) {
    assert.throws(() => verify({ ...target, nativeIdentity: observed }, { ...observed, [key]: value }), error => {
      assert.match(error.message, new RegExp('step=' + step));
      assert.doesNotMatch(error.message, /Private title/); return true;
    });
  }
  assert.throws(() => verify(undefined, observed), /step=expected-missing/);
});

for (const [before, after] of [
  ['\n\t2 menu (disabled, collapsed) Editing', '\n\t2 menu (collapsed) Editing'],
  ['\n\t2 menu (disabled, selected, collapsed) Editing', '\n\t2 menu (selected, collapsed) Editing'],
]) test('closed menu metadata can change after typing with equal live identity: ' + JSON.stringify([before, after]), { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { treePatch: (value, typed) => value + (typed ? after : before) });
  const result = await f.js('await app.typeText("Sleight GL1 input smoke\\n"); await app.pressKey("Command+s"); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 1);
});
for (const after of ['menu (expanded) Editing', 'menu Editing', 'menu (collapsed) Other', 'sheet (collapsed) Editing', 'dialog Editing', 'alert Editing']) {
  test('new active or unproved surface refuses with a fixed step: ' + after, { skip: replWorkerSkip }, async t => {
    const f = await fixture(t, { treePatch: (value, typed) => value + '\n\t2 ' +
      (typed ? after : 'menu (collapsed) Editing') });
    const result = await f.js('await app.typeText("fixture"); await app.pressKey("Command+s"); void 0;');
    assert.equal(result.isError, true, text(result));
    assert.match(text(result), /IDENTITY_CHANGED[^\n]*step=surface/);
    assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 0);
  });
}

for (const [key, value, step] of [['windowId', '668623', 'window-id'],
  ['processStart', 'other', 'process-start'], ['readId', 3, 'read-id']]) {
  test('helper inspection binds ' + key + ' with its fixed reason', { skip: replWorkerSkip }, async t => {
    const f = await fixture(t);
    const proposal = helperInspection('fillForm', 'pressKey', { windowId: window.windowId,
      processStart: window.processStart, readId: 2, args: ['Home'], [key]: value });
    await assert.rejects(f.policy.inspectHelperStep(proposal, { window, readId: 2 }), error => {
      assert.equal(error.code, 'IDENTITY_CHANGED'); assert.equal(error.identityStep, step);
      assert.doesNotMatch(error.message, /gl1-|TextEdit|other/); return true;
    });
    assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 0);
  });
}
test('a changed URL still refuses the untargeted key with its fixed reason', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { treePatch: (value, typed) => typed ? value.replace('0 standard window gl1-ce52e127.txt', '0 standard window gl1-ce52e127.txt, URL: file:///fixture/other') : value });
  const result = await f.js('await app.typeText("fixture"); await app.pressKey("Command+s"); void 0;');
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), /IDENTITY_CHANGED[^\n]*step=url/);
  assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 0);
});

test('a new collapsed menu remains a new surface requiring a session read', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { treePatch: (value, typed) => value + (typed ? '\n\t2 menu (collapsed) Editing' : '') });
  const result = await f.js('await app.typeText("fixture"); await app.pressKey("Command+s"); void 0;');
  assert.match(text(result), /IDENTITY_CHANGED[^\n]*step=surface/);
  assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 0);
});

for (const role of ['menu item', 'menu bar', 'menu bar item', 'menu button']) {
  test('typing can update ' + role + ' metadata without opening a surface', { skip: replWorkerSkip }, async t => {
    const f = await fixture(t, { treePatch: (value, typed) => value + '\n\t2 menu (collapsed) ID: edit-menu' +
      '\n\t\t3 ' + role + (typed ? ' (selectable, collapsed) Undo Typing, ID: undo:' : ' (disabled, selectable, collapsed) Undo, ID: undo:') });
    const result = await f.js('await app.typeText("fixture"); await app.pressKey("Command+s"); void 0;');
    assert.equal(result.isError, false, text(result));
    assert.equal(f.calls.filter(row => row.method === 'pressKey').length, 1);
  });
}

for (const [name, before, after, stops] of [
  ['measured collapsed open menu', 'menu (collapsed) Edit', 'menu (collapsed) Edit, Secondary Actions: Cancel', true],
  ['measured unflagged open menu', 'menu Edit', 'menu Edit, Secondary Actions: Cancel', true],
  ['changed secondary actions', 'menu Edit, Secondary Actions: Cancel', 'menu Edit, Secondary Actions: Cancel, Close', true],
  ['removed secondary actions', 'menu Edit, Secondary Actions: Cancel', 'menu Edit', true],
  ...['bar x', 'button y', 'item z'].map(label => ['new menu named ' + label, '', 'menu () ' + label, true]),
  ['removed menu', 'menu (collapsed) Edit', '', true],
  ['duplicate collapsed menu', 'menu (collapsed) Edit', 'menu (collapsed) Edit\n\t3 menu (collapsed) Edit', true],
  ['item gains selected', 'menu item (selectable) Undo', 'menu item (selected) Undo', true],
  ['item added selected', '', 'menu item (selected) Undo', true],
  ['menu bar item gains selected', 'menu bar item Edit', 'menu bar item (selected) Edit', true],
  ['selected item label changes', 'menu item (selected) Undo', 'menu item (selected) Undo Typing', false],
  ['item label changes', 'menu item Undo', 'menu item Undo Typing', false],
  ['item enabled', 'menu item (disabled) Undo', 'menu item Undo', false],
  ['item disabled', 'menu item Undo', 'menu item (disabled) Undo', false],
  ['selected item enabled', 'menu item (disabled, selected) Undo', 'menu item (selected) Undo', false],
  ['label cannot supply selection', 'menu item () (selected) Undo', 'menu item () (selected) Undo Typing', false],
  ['menu label cannot supply disabled flags', 'menu () (disabled, collapsed) Edit', 'menu () (collapsed) Edit', true],
  ['popover appears', '', 'popover Options', true],
  ['floating window appears', '', 'floating window Options', true],
  ['popover changes', 'popover Options', 'popover Other', true],
  ['floating window changes', 'floating window Options', 'floating window Other', true],
]) test('admission surface invariant: ' + name, { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { treePatch: (value, typed) => value +
    ((typed ? after : before) ? '\n\t2 ' + (typed ? after : before) : '') });
  const result = await f.js('await app.typeText("fixture"); await app.pressKey("Command+s"); void 0;');
  assert.equal(result.isError, stops, text(result));
  if (stops) assert.match(text(result), /IDENTITY_CHANGED[^\n]*step=surface/);
  assert.equal(f.calls.filter(row => row.method === 'typeText').length, 1);
  assert.equal(f.calls.filter(row => row.method === 'pressKey').length, stops ? 0 : 1);
});
