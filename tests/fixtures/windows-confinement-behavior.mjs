import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../plugins/sleight/lib/', import.meta.url);
const mutations = {
  'name-includes-popup': ['driver-safety.mjs', '!w.popup && !w.refused', '!w.refused'],
  'first-same-process-window': ['driver-safety.mjs', "if (candidates.length !== 1) fail('AMBIGUOUS_APP');", ''],
  'drop-native-binding-id': ['repl/identity.mjs', "...Object.hasOwn(value, 'bindingId') ? { bindingId: value.bindingId } : {}", ''],
  'worker-params-at-read': ['driver-safety.mjs', "method === 'getApp' ? 'getAXState' : method, binding)", "method === 'getApp' ? 'getAXState' : method, method === 'getApp' ? binding : params)"],
  'frame-with-aumid-accepted': ['repl/identity.mjs', "/^(?:ApplicationFrameWindow|Windows\\.UI\\.Core\\.CoreWindow)$/i.test(observed.className ?? '')", 'false'],
  'client-drops-read-binding': ['windows-driver/client.mjs', "admitted && admitted.processStart === params?.processStart && !Object.hasOwn(params, 'bindingId')", 'false'],
  'client-missing-cache-guard': ['windows-driver/client.mjs', 'admitted && admitted.processStart === params?.processStart', 'admitted?.processStart === params?.processStart'],
  'binding-before-native-refusal': ['repl/identity.mjs', 'if (observed.refused) fail(observed.refused);\n  const binding = windowBinding(expected);', 'const binding = windowBinding(expected);\n  if (observed.refused) fail(observed.refused);'],
  ...Object.fromEntries(['windowGeneration', 'topologyGeneration', 'desktopId', 'onCurrentDesktop', 'threadId'].map(key =>
    ['ignore-' + key, ['repl/identity.mjs', key === 'onCurrentDesktop' ? ", 'onCurrentDesktop'" : "'" + key + "', ", '']])),
};

async function mutatedModule(path, variant) {
  const url = new URL(path, root);
  if (!variant) return import(url.href);
  const [target, before, after] = mutations[variant];
  if (target !== path) return import(url.href);
  let source = readFileSync(url, 'utf8');
  assert.ok(source.includes(before), 'mutation anchor: ' + variant);
  source = source.replace(before, after).replace(/\bfrom\s+(['"])(\.[^'"]+)\1/g,
    (_match, _quote, relative) => 'from ' + JSON.stringify(new URL(relative, url).href));
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

function window() {
  return { windowId: '101', pid: 41, threadId: 51, processStart: '134059077770000001', image: 'C:\\Apps\\Fixture.exe',
    imageIdentity: '134059077770000000:4096', app: 'Fixture', title: 'Fixture', className: 'FixtureWindow', integrity: 'medium',
    refused: null, popup: false, bindingId: 'a'.repeat(32), windowGeneration: '1', topologyGeneration: '1:tree',
    desktopId: '11111111-2222-3333-4444-555555555555', onCurrentDesktop: true };
}
const publicBinding = w => ({ windowId: w.windowId, processStart: w.processStart });
async function fixture(variant) {
  let identity = await mutatedModule('repl/identity.mjs', variant);
  let safetyModule;
  if (variant && mutations[variant][0] === 'repl/identity.mjs') {
    // The parent imports the same mutated identity adapter. Other dependencies
    // remain the actual repository modules, outside this test's fake driver.
    let source = readFileSync(new URL('driver-safety.mjs', root), 'utf8');
    const identitySource = readFileSync(new URL('repl/identity.mjs', root), 'utf8')
      .replace(mutations[variant][1], mutations[variant][2])
      .replace(/\bfrom\s+(['"])(\.[^'"]+)\1/g,
        (_m, _q, relative) => 'from ' + JSON.stringify(new URL(relative, new URL('repl/identity.mjs', root)).href));
    const identityUrl = 'data:text/javascript;base64,' + Buffer.from(identitySource).toString('base64');
    source = source.replace("'./windows-repl/identity.mjs'", JSON.stringify(identityUrl))
      .replace(/\bfrom\s+(['"])(\.[^'"]+)\1/g, (_m, _q, relative) => 'from ' + JSON.stringify(new URL(relative, new URL('driver-safety.mjs', root)).href));
    safetyModule = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  } else safetyModule = await mutatedModule('driver-safety.mjs', variant);
  const windows = [window()], calls = [], cards = [];
  let id = 0;
  const safety = safetyModule.createWindowsSafety({
    driver: { async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'getState') return { windows: structuredClone(windows) };
      const selected = windows.find(w => w.windowId === params.windowId);
      return { window: { ...selected }, ...method === 'verifyWindowIdentity' ? {} : { readId: ++id, text: 'Window: "Fixture", App: Fixture.\n0 standard window Fixture' } };
    } },
    lease: { acquire: () => 'lease', ready() {}, renew() {}, release() {}, close() {} },
    approve: async card => { cards.push(card); return true; }, stuckEscape: false,
  });
  return { safety, windows, calls, cards, identity };
}

export const behaviorNames = ['name-excludes-popup', 'binding-forwarded', 'worker-omits-binding', 'same-process-ambiguity', 'packaged-frame-refused', 'refused-frame-without-birth', 'client-read-binding',
  ...['windowGeneration', 'topologyGeneration', 'desktopId', 'onCurrentDesktop', 'threadId'].map(key => 'changed-' + key)];
export const brokenVariants = Object.keys(mutations);
export const variantCase = variant => variant === 'name-includes-popup' ? 'name-excludes-popup' : variant === 'first-same-process-window' ? 'same-process-ambiguity'
  : variant === 'drop-native-binding-id' ? 'binding-forwarded' : variant === 'worker-params-at-read' ? 'worker-omits-binding'
    : variant === 'frame-with-aumid-accepted' ? 'packaged-frame-refused' : ['client-drops-read-binding', 'client-missing-cache-guard'].includes(variant) ? 'client-read-binding'
      : variant === 'binding-before-native-refusal' ? 'refused-frame-without-birth'
    : 'changed-' + variant.slice('ignore-'.length);

export async function runBehavior(name, variant) {
  if (name === 'client-read-binding') {
    const module = await mutatedModule('windows-driver/client.mjs', variant);
    const client = module.createWindowsDriverClient({ platform: 'win32', prepare: async () => ({ status: 'ready', spawn: ({ nonce }) =>
      spawn(process.execPath, [fileURLToPath(new URL('./windows-driver-fake.mjs', import.meta.url)), 'confinement-binding'], {
        stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce },
      }) }) });
    try {
      await assert.rejects(client.request('getAXState'), { code: 'INVALID_PARAMS' });
      await assert.rejects(client.request('getAXState', {}), { code: 'INVALID_PARAMS' });
      const first = await client.getApp('Notepad');
      assert.equal((await client.getAXState(first.window.windowId, { processStart: first.window.processStart })).window.windowId, first.window.windowId);
      assert.equal((await client.request('getAXState', publicBinding(first.window))).window.windowId, first.window.windowId);
    } catch (error) { assert.fail('Expected native binding on every client read: ' + error.code); }
    finally { await client.close(); }
    return;
  }
  const f = await fixture(variant);
  try {
    if (name === 'name-excludes-popup') {
      f.windows.push({ ...f.windows[0], windowId: '102', popup: true, ownerWindowId: '101' });
      let selected;
      try { selected = await f.safety.request('getApp', { selector: 'Fixture' }); }
      catch (error) { assert.fail('Expected exactly one non-popup match: ' + error.code); }
      assert.equal(selected.window.windowId, '101');
      assert.equal(f.cards.length, 1);
      return;
    }
    if (name === 'same-process-ambiguity') {
      f.windows.push({ ...f.windows[0], windowId: '102' });
      await assert.rejects(f.safety.request('getApp', { selector: 'Fixture' }), { code: 'AMBIGUOUS_APP' });
      assert.equal(f.cards.length, 0); assert.deepEqual(f.calls.map(c => c.method), ['getState']);
      assert.equal((await f.safety.request('getApp', { selector: { windowId: '102' } })).window.windowId, '102');
      return;
    }
    if (name === 'packaged-frame-refused') {
      Object.assign(f.windows[0], { className: 'ApplicationFrameWindow', aumid: 'Fixture.Package!App' });
      await assert.rejects(f.safety.request('getApp', { selector: { windowId: '101' } }), { code: 'HOSTED_APP_UNRESOLVED' });
      assert.equal(f.cards.length, 0); assert.deepEqual(f.calls.map(c => c.method), ['getState']);
      return;
    }
    if (name === 'refused-frame-without-birth') {
      Object.assign(f.windows[0], { processStart: null, bindingId: null, image: null, app: null, title: null, className: null,
        refused: 'HOSTED_APP_UNRESOLVED' });
      await assert.rejects(f.safety.request('getApp', { selector: { windowId: '101' } }), { code: 'HOSTED_APP_UNRESOLVED' });
      assert.equal(f.cards.length, 0); assert.deepEqual(f.calls.map(c => c.method), ['getState']);
      return;
    }
    const first = await f.safety.request('getApp', { selector: 'Fixture' });
    if (name.startsWith('changed-')) {
      const key = name.slice('changed-'.length);
      f.windows[0][key] = key === 'onCurrentDesktop' ? false : key === 'threadId' ? 52 : 'changed';
      const reads = f.calls.filter(c => c.method === 'getAXState').length;
      await assert.rejects(f.safety.request('getAXState', publicBinding(first.window)), { code: 'IDENTITY_CHANGED', message: 'IDENTITY_CHANGED' });
      assert.equal(f.calls.filter(c => c.method === 'getAXState').length, reads, 'no native content read after parent sees a revoked tuple');
      assert.throws(() => f.identity.verifyWindowIdentity(first.window, f.windows[0]), { code: 'IDENTITY_CHANGED', message: 'IDENTITY_CHANGED' });
    } else {
      if (name === 'worker-omits-binding') await f.safety.request('getAXState', publicBinding(first.window));
      assert.equal(f.calls.at(-1).params.bindingId, 'a'.repeat(32));
      assert.equal(f.calls.find(c => c.method === 'verifyWindowIdentity').params.bindingId, 'a'.repeat(32));
    }
  } finally { await f.safety.close(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const variant = process.argv[2];
  try { await runBehavior(variantCase(variant), variant); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
