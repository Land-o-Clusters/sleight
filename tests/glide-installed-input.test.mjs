import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { macDriverBuildInfo } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { hasMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';

const mutations = {
  startup: ['runtime-select.mjs', 'await prepareMacInputRegistrar(host.driver, macDriverBuildInfo().build)', 'undefined'],
  build: ['runtime-select.mjs', 'macDriverBuildInfo().build);', '(await host.driver.ping()).build);'],
  stop: ['runtime-select.mjs', 'if (stopControl) host?.setStopInput', 'if (false) host?.setStopInput'],
  doctor: ['runtime-doctor.mjs', 'screenRecording: result.screenRecording', 'screenRecording: true'],
};
let hook;
if (process.env.GL1_INSTALLED_MUTANT) {
  const [file, before, after] = mutations[process.env.GL1_INSTALLED_MUTANT];
  const target = new URL('../plugins/sleight/lib/' + file, import.meta.url).href;
  hook = registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (url !== target) return loaded;
    assert.ok(String(loaded.source).includes(before), 'installed mutation anchor');
    return { ...loaded, source: String(loaded.source).replace(before, after) };
  } });
}
const runtime = await import('../plugins/sleight/lib/runtime-select.mjs');
const diagnosis = await import('../plugins/sleight/lib/runtime-doctor.mjs');
hook?.deregister();
const window = { windowId: '42', pid: 321, processStart: '1.25', bundleId: 'org.test.Fixture', app: 'Fixture',
  title: 'Draft', identityVerified: true, onScreen: true, minimized: false,
  bounds: { x: 0, y: 0, width: 400, height: 300 } };

// The transport and registrar are production code. The child has only in-memory
// streams, so neither startup nor diagnosis can reach a desktop provider.
function helper({ enabled = true, build = macDriverBuildInfo().build } = {}) {
  const calls = [], child = new EventEmitter();
  let active, onInput;
  const reply = (frame, result, error) => queueMicrotask(() => child.stdout.write(JSON.stringify({
    protocol: 'sleight.driver/1', platform: 'darwin', nonce: frame.nonce, id: frame.id, ok: !error,
    ...error ? { error } : { result },
  }) + '\n'));
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(bytes, _encoding, done) {
    const frame = JSON.parse(bytes); calls.push(frame.method); done();
    if (frame.control) {
      if (frame.control === 'stop' && active) reply(active, undefined, { code: 'USER_STOPPED', message: 'stopped',
        unhealthy: false, next: 'stop-tell-user', delivery: 'sent-unverified', retry: 'read-first' });
      return;
    }
    if (frame.method === 'typeText') { active = frame; onInput?.(); return; }
    const result = frame.method === 'ping' ? { protocol: 'sleight.driver/1', platform: 'darwin', apiVersion: 2,
      build, methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS, 'inputGateState', 'personState', 'rendererRestore'] }
      : frame.method === 'inputGateState' ? { enabled }
        : frame.method === 'health' ? { accessibility: true, screenRecording: false }
          : frame.method === 'resolveApp' ? { app: { id: window.bundleId, name: window.app, pid: window.pid,
            processStart: window.processStart }, windows: [window] }
            : frame.method === 'personState' ? { token: 'fixture-person', personTookOver: false }
              : frame.method === 'rendererRestore' ? { restored: true, token: frame.params.args[0].lease.token }
                : { window, readId: 1, text: 'Window: "Draft", App: Fixture.\n0 standard window Draft\n\t1 button Press' };
    reply(frame, result);
  } });
  let closes = 0;
  child.kill = () => { closes++; queueMicrotask(() => child.emit('close', 0)); return true; };
  return { calls, whenInput: () => new Promise(resolve => { onInput = resolve; }), get closes() { return closes; },
    options: { platform: 'darwin', prepare: async () => ({ status: 'ready', build, spawn: () => child }) } };
}

test('installed startup prepares an input capability against the current helper build', async t => {
  assert.equal(typeof runtime.prepareOwnRuntimeHost, 'function');
  const f = helper(), prepared = await runtime.prepareOwnRuntimeHost({ driverOptions: f.options });
  t.after(() => prepared.driver.close());
  assert.equal(hasMacInputRegistrar(prepared.inputRegistrar, prepared.driver), true);
  assert.equal(hasMacInputRegistrar(structuredClone(prepared.inputRegistrar), prepared.driver), false);
  assert.ok(f.calls.includes('inputGateState'));
  const source = readFileSync(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf('export async function run('), source.indexOf('await recoverClipboard();'));
  assert.match(start, /await own\.prepareOwnRuntimeHost\(/);
  assert.match(start, /runOwnRuntime\(\{[^\n]*\.\.\.host/);
});

test('installed startup closes a helper that refuses input or reports another build', async () => {
  assert.equal(typeof runtime.prepareOwnRuntimeHost, 'function');
  for (const options of [{ enabled: false }, { build: 'e'.repeat(64) }]) {
    const f = helper(options);
    await assert.rejects(runtime.prepareOwnRuntimeHost({ driverOptions: f.options }), /MAC_INPUT_GATE_DISABLED/);
    assert.equal(f.closes, 1);
  }
});

test('doctor reads both native grants and collects its helper', async () => {
  assert.equal(typeof diagnosis.runtimeGrantState, 'function');
  const f = helper();
  const grants = await diagnosis.runtimeGrantState({ driverOptions: f.options });
  assert.deepEqual(grants, { accessibility: true, screenRecording: false });
  assert.ok(f.calls.includes('health')); assert.equal(f.closes, 1);
});

test('installed helper retains Stop wiring while typing', { timeout: 10000 }, async t => {
  const f = helper(), prepared = await runtime.prepareOwnRuntimeHost({ driverOptions: f.options });
  let stop, began;
  const ready = new Promise(resolve => { began = resolve; });
  const owner = runtime.createOwnRuntime({ ...prepared,
    stopControl: { beginGlideStop(_window, callback) { stop = callback; began(); return () => {}; } },
    lease: { acquire: () => 'lease', grant: () => ({ token: 'lease' }), renew() {}, renewGrant() {}, release() {}, close() {} },
    approve: () => true, policy: () => ({ allow: true }), ancestry: () => [{ pid: 999, path: '/fixture/Host' }], targetParents: () => [1],
    permissions: { app() {}, page() {}, sitesLimited: () => false }, ownHostPid: () => false,
  });
  t.after(() => owner.close());
  owner.safety.setPolicy({ checkPause() {}, beforeAction: ({ args }) => ({ args }) });
  await owner.safety.request('getApp', { selector: 'Fixture' });
  const posted = f.whenInput();
  const pending = owner.safety.request('typeText', { windowId: '42', processStart: '1.25', readId: 1, args: ['long input'] });
  const outcome = pending.then(result => ({ result }), error => ({ error }));
  let timer;
  try {
    await Promise.race([Promise.all([ready, posted]), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('installed Stop was not connected')), 1000);
    })]);
    stop();
    assert.equal((await outcome).error?.code, 'USER_STOPPED');
  } finally {
    clearTimeout(timer);
    await owner.close();
    await outcome;
  }
});

test('own doctor renders actual preflight grants and reports unavailable helpers explicitly', async () => {
  for (const grants of [{ accessibility: true, screenRecording: false }, { accessibility: false, screenRecording: true },
    { unavailable: 'DRIVER_UNAVAILABLE' }]) {
    const result = await diagnosis.runtimeDoctor({ platform: 'darwin', env: { SLEIGHT_RUNTIME: 'own' },
      grantState: async () => grants, buildState: () => ({ build: 'a'.repeat(64), status: 'compiled (fixture)' }),
      compilerState: () => 'found', lastProbe: () => 'none', rendererRecords: () => '0', consentRecipe: () => 'default' });
    const line = result.lines.find(line => line.startsWith('grants '));
    if (grants.unavailable) assert.match(line, /unavailable \(DRIVER_UNAVAILABLE\)/);
    else {
      assert.ok(line.includes('Accessibility: ' + (grants.accessibility ? 'granted' : 'not granted')));
      assert.ok(line.includes('Screen Recording: ' + (grants.screenRecording ? 'granted' : 'not granted')));
    }
    assert.doesNotMatch(line, /unknown/);
  }
});
