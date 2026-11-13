import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm, realpath, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { traceTiming } from '../bench/timing.mjs';
import { macDriverBuildInfo, prepareMacDriver } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { prepareNativeHelpers } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';

const mutations = {
  wiring: ['runtime-select.mjs', 'localToolOptions, inputRegistrar, approvalScope,', 'localToolOptions, approvalScope,'],
  eager: ['launch.mjs', 'lazy: true', 'lazy: false'],
  background: ['runtime-select.mjs', 'startMacInputPreparation(inputRegistrar, host.driver);', ''],
  forged: ['mac-driver/input-registrar.mjs', 'registrars.get(value) === driver && driver !== undefined', 'true'],
  timeout: ['mac-driver/input-registrar.mjs', 'Error(MAC_PREPARING_NOTICE)', "Error('REPL_TIMEOUT: Glide preparation timed out.')"],
  budget: ['runtime-select.mjs', 'timeout_ms: timeoutMs }, { id }',
    'timeout_ms: Math.max(1, Math.floor(timeoutMs - (performance.now() - waitStart))) }, { id }'],
  timing: ['runtime-select.mjs', 'recordTiming(context.cell, request.method, reply?.timing);', ''],
  retire: ['runtime-select.mjs', 'if (preparing) return;', ''],
  notice: ['runtime-select.mjs', 'result.content.unshift(text(ownConfirmationPolicy(inputRegistrar, driver)))',
    'result.content.unshift(text(OWN_CONFIRMATION_POLICY))'],
};
let hook;
if (process.env.GL1C_MUTANT) {
  const [file, before, after] = mutations[process.env.GL1C_MUTANT];
  const target = new URL('../plugins/sleight/lib/' + file, import.meta.url).href;
  hook = registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (url !== target) return loaded;
    assert.ok(String(loaded.source).includes(before), 'GL1C mutation anchor');
    return { ...loaded, source: String(loaded.source).replace(before, after) };
  } });
}
const { run, approvalLogging } = await import('../plugins/sleight/lib/launch.mjs');
const diagnosis = await import('../plugins/sleight/lib/runtime-doctor.mjs');
const registrar = await import('../plugins/sleight/lib/mac-driver/input-registrar.mjs');
// launch imports runtime-select lazily, so retain the hook through that import.
const runtime = await import('../plugins/sleight/lib/runtime-select.mjs');
hook?.deregister();

const window = { windowId: '42', pid: 321, processStart: '1.25', bundleId: 'org.test.Fixture', app: 'Fixture',
  title: 'Draft', identityVerified: true, onScreen: true, minimized: false,
  bounds: { x: 0, y: 0, width: 400, height: 300 } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const plain = result => (result?.content ?? []).filter(row => row.type === 'text').map(row => row.text).join('\n');

function native({ wait, failure, readDelayMs = 0, expectedCompileMs, retryAfterMs } = {}) {
  let prepares = 0, readId = 0;
  const calls = [], sink = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(bytes, _encoding, done) {
    const frame = JSON.parse(bytes); done();
    if (frame.control) return;
    calls.push(frame.method);
    if (frame.method === 'typeText') sink.push(frame.params.args[0]);
    const result = frame.method === 'ping' ? { protocol: 'sleight.driver/1', platform: 'darwin', apiVersion: 2,
      build: macDriverBuildInfo().build,
      methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS, 'inputGateState', 'personState', 'rendererRestore'] }
      : frame.method === 'inputGateState' ? { enabled: true }
        : frame.method === 'health' ? { accessibility: true, screenRecording: false }
          : frame.method === 'getState' ? { windows: [window], apps: [] }
          : frame.method === 'resolveApp' ? { app: { id: window.bundleId, name: window.app, pid: window.pid,
            processStart: window.processStart }, windows: [window] }
            : frame.method === 'personState' ? { token: 'fixture-person', personTookOver: false }
              : frame.method === 'rendererRestore' ? { restored: true, token: frame.params.args[0].lease.token }
                : { window, readId: ++readId, text: 'Window: "Draft", App: Fixture.\n0 standard window Draft\n\t1 button Press',
                  ...DRIVER_ACTION_METHODS.includes(frame.method) ? { delivery: 'sent-unverified',
                    timing: { sendMs: 7, settleMs: 31, postReadMs: 11 } } : {} };
    const respond = () => child.stdout.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin',
      nonce: frame.nonce, id: frame.id, ok: true, result }) + '\n');
    if (frame.method === 'getState' && readDelayMs) setTimeout(respond, readDelayMs);
    else queueMicrotask(respond);
  } });
  child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
  return { calls, sink, get prepares() { return prepares; }, options: { platform: 'darwin', async prepare({ onProgress }) {
    prepares++; onProgress?.({ stage: 'compile', helper: 'glide-engine', expectedCompileMs }); await wait;
    onProgress?.({ stage: 'publish' });
    if (failure) return failure === 'HOST_COMPILE_FAILED'
      ? { status: 'unavailable', code: 'NATIVE_HELPERS_UNAVAILABLE', detail: { stage: 'compile', stderr: 'private compiler output' } }
      : { status: 'unavailable', code: failure, detail: { retryAfterMs } };
    return { status: 'ready', origin: 'source', build: macDriverBuildInfo().build, binarySha256: 'c'.repeat(64), spawn: () => child };
  } } };
}

function launch(t, f, { traceDirectory } = {}) {
  const prior = process.env.SLEIGHT_RUNTIME; process.env.SLEIGHT_RUNTIME = 'own';
  t.after(() => { if (prior === undefined) delete process.env.SLEIGHT_RUNTIME; else process.env.SLEIGHT_RUNTIME = prior; });
  const input = new PassThrough(), output = new PassThrough(), pending = new Map();
  let next = 0, buffer = '';
  output.on('data', bytes => {
    buffer += bytes;
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const reply = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      pending.get(reply.id)?.(reply); pending.delete(reply.id);
    }
  });
  const started = run({ directBrowser: null, ownRuntimeOptions: { input, output, directBrowser: undefined, signals: new EventEmitter(),
    logging: traceDirectory ? preapproved => approvalLogging(preapproved, { SLEIGHT_TRACE: traceDirectory }) : () => ({}),
    driverOptions: f.options, ask: () => 'accept', grantAudit() {}, ownHostPid: () => false, allowForbidden: () => false,
    policy: () => ({ allow: true }), ancestry: () => [{ pid: 999, path: '/fixture/Host' }], targetParents: () => [1],
    permissions: { app() {}, page() {}, sitesLimited: () => false },
    lease: { acquire: () => 'lease', grant: () => ({ token: 'lease' }), renew() {}, renewGrant() {}, release() {}, close() {} },
    approvalStorage: { load: () => ({}), live: () => ({ list: () => [], allows: () => false }) },
    relayOptions: { idleTurnEndMs: 0, runtimeHandClient: { enabled: false,
      beginGlideStop: async () => () => {}, close() {} } },
  } });
  // Observe rejection immediately; the failing-startup regression must not leak it.
  const startup = started.then(owner => ({ owner }), error => ({ error }));
  t.after(async () => { const { owner } = await startup; await owner?.close(); input.destroy(); output.destroy(); });
  const call = (method, params) => new Promise(resolve => {
    const id = ++next; pending.set(id, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { startup, call, js: (code, timeout_ms = 2000) => call('tools/call', { name: 'js', arguments: { code, timeout_ms } }) };
}

test('initialize and tools/list reply before slow preparation finishes on the real launch path', { skip: replWorkerSkip, timeout: 10000 }, async t => {
  const wait = deferred(), f = native({ wait: wait.promise }), h = launch(t, f);
  let initialized;
  try {
    initialized = await Promise.race([h.call('initialize', { protocolVersion: '2024-11-05' }), delay(500, 'blocked')]);
    assert.notEqual(initialized, 'blocked', 'MCP handshake waited for helper compilation');
    assert.equal(initialized.result.serverInfo.name, 'sleight');
    const listing = await h.call('tools/list');
    assert.ok(listing.result.tools.some(tool => tool.name === 'js'));
    assert.equal(f.prepares, 1, 'server startup must start preparation before any model cell');
    const cell = h.js('await cua.getState()');
    await delay(30);
    assert.equal(f.prepares, 1);
    assert.equal(await Promise.race([cell, delay(30, 'pending')]), 'pending');
    wait.resolve();
    const result = (await cell).result; assert.notEqual(result.isError, true, plain(result));
  } finally { wait.resolve(); await h.startup; }
});

test('GLINT3 backoff tells the model the failed build and retry time without claiming work is running', { skip: replWorkerSkip }, async t => {
  const f = native({ failure: 'HOST_COMPILE_BACKOFF', retryAfterMs: 120001 }), h = launch(t, f);
  await h.startup;
  for (let i = 0; i < 2; i++) {
    const result = (await h.js('var backoffCellRan = true')).result;
    assert.equal(result.isError, true);
    assert.equal(result.content.at(-1).text,
      'Glide helper failed to build. Next automatic try in 121 s. Run sleight-mcp --doctor for the cause. No cell code ran.');
    assert.doesNotMatch(plain(result), /Building Glide|still running|waits by itself|private compiler/);
    assert.equal(result.timing.preparation.status, 'backoff');
    assert.deepEqual(f.calls, []);
  }
  const ready = native(); f.options.prepare = ready.options.prepare;
  assert.match(plain((await h.js('nodeRepl.write(typeof backoffCellRan)')).result), /undefined/);
});

for (const [label, expectedCompileMs] of [['missing', undefined], ['expired', 1]])
  test('GLINT3 ' + label + ' compile estimate says still running without zero or unknown seconds', { skip: replWorkerSkip }, async t => {
    const wait = deferred(), f = native({ wait: wait.promise, expectedCompileMs }), h = launch(t, f);
    try {
      await h.startup; await delay(10);
      const set = globalThis.setTimeout; let hold;
      t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
        if (hold === undefined) { hold = ms; return set(fn, 20, ...args); }
        return set(fn, ms, ...args);
      });
      const reply = (await h.js('var estimateCellRan = true', 30)).result;
      assert.equal(hold, 30, 'expired estimates retain the ordinary bounded hold');
      assert.equal(reply.content.at(-1).text,
        'DRIVER_PREPARING: Glide build is still running. No cell code ran. The next call waits by itself.');
      assert.doesNotMatch(plain(reply), /Remaining:|\? s/);
    } finally { wait.resolve(); }
  });

test('GLINT3 sloppy cells pass the real launch relay and worker', { skip: replWorkerSkip }, async t => {
  const h = launch(t, native()); await h.startup;
  for (const code of [
    'if (1) function glintIf(){return 17}; nodeRepl.write(glintIf())',
    'label: function glintLabel(){return 18}; nodeRepl.write(glintLabel())',
    '--> ignored comment\nnodeRepl.write(19)',
    'try { throw 20 } catch(e) { var e; nodeRepl.write(e) }',
    'if (1) function glintAwait(){return 21}; nodeRepl.write(await Promise.resolve(glintAwait()))',
  ]) {
    const result = (await h.js(code)).result;
    assert.notEqual(result.isError, true, plain(result));
    assert.match(plain(result), /\b(?:17|18|19|20|21)\b/);
  }
  const read = (await h.js('label: function glintRead(){}; var glintApp = await cua.getApp("Fixture"); await glintApp.getAXState()')).result;
  assert.notEqual(read.isError, true, plain(read));
  assert.match(plain(read), /button Press/);
});

test('GLINT3 relay returns serving build identity outside model-authored output', { skip: replWorkerSkip }, async t => {
  const h = launch(t, native()); await h.startup;
  const result = (await h.js('nodeRepl.write(JSON.stringify({runtimeReceipt:{driverBuild:"fake",driverSourceBuild:"fake"}}))')).result;
  assert.notEqual(result.isError, true, plain(result));
  assert.equal(result.runtimeReceipt.driverSourceBuild, macDriverBuildInfo().build);
  assert.equal(result.runtimeReceipt.ping.build, result.runtimeReceipt.driverSourceBuild);
  assert.equal(result.runtimeReceipt.driverBuild, 'c'.repeat(64));
  assert.doesNotMatch(JSON.stringify(result.runtimeReceipt), /fake/);
});

for (const failure of ['APPLE_TOOLS_MISSING', 'HOST_COMPILE_FAILED']) {
  test(`${failure} leaves tools available and every Glide read and input reports the cause`, { timeout: 10000 }, async t => {
    const f = native({ failure }), h = launch(t, f), start = await h.startup;
    assert.equal(start.error, undefined, 'helper failure killed the MCP server');
    await h.call('initialize', {});
    for (const code of ['await cua.getState()', 'var app = await cua.getApp("Fixture"); await app.typeText("test")']) {
      const reply = await h.js(code);
      assert.equal(reply.result.isError, true);
      assert.match(plain(reply.result), new RegExp('unavailable.*' + failure, 'i'));
      assert.match(plain(reply.result), new RegExp('Input is unavailable.*' + failure));
      assert.doesNotMatch(plain(reply.result), /Input is (?:on|enabled)/);
      assert.doesNotMatch(plain(reply.result), /partial input possible/);
    }
    assert.ok((await h.call('tools/list')).result.tools.some(tool => tool.name === 'js'));
    assert.equal(f.prepares, 1, 'failed preparation was started again');
    assert.deepEqual(f.sink, []);
    const grants = await diagnosis.runtimeGrantState({ driverOptions: f.options });
    assert.match(grants.unavailable, new RegExp(failure));
    assert.equal(f.prepares, 2, 'doctor owns one separate preparation');
    const doctor = diagnosis.runtimeDoctorSection({ env: { SLEIGHT_RUNTIME: 'own' }, platform: 'darwin', grants,
      buildState: () => ({ build: 'a'.repeat(64), status: 'compiled (fixture)' }), compilerState: () => 'found',
      lastProbe: () => 'none', rendererRecords: () => '0', consentRecipe: () => 'default' });
    assert.equal(doctor.ok, false); assert.ok(doctor.lines.some(line => line.includes(`unavailable (${failure})`)));
    assert.doesNotMatch(plain((await h.js('await cua.getState()')).result), /private compiler output/);
    assert.equal(f.prepares, 2);
  });
}

test('a slow compile reports preparation without executing or timing out the first cell', { skip: replWorkerSkip, timeout: 10000 }, async t => {
  const wait = deferred(), f = native({ wait: wait.promise }), h = launch(t, f);
  try {
    const first = h.js('var coldCellRan = true; await cua.getState()', 40);
    const reply = await Promise.race([first, delay(500, 'blocked')]);
    assert.notEqual(reply, 'blocked', 'cell timeout did not include compilation');
    assert.equal(reply.result.isError, true);
    assert.match(plain(reply.result), /DRIVER_PREPARING/);
    assert.match(plain(reply.result), /next call waits.*itself/i);
    assert.doesNotMatch(plain(reply.result), /sleep|requests arrived|action ledger/i);
    assert.equal(reply.result.ledger, undefined);
    assert.doesNotMatch(plain(reply.result), /REPL_TIMEOUT/);
    assert.equal(reply.result.timing.preparation.status, 'preparing');
    assert.equal(reply.result.timing.preparation.phase, 'compile');
    assert.equal(f.calls.includes('getState'), false);
    const second = h.js('await cua.getState()', 1000);
    await delay(20); assert.equal(f.prepares, 1);
    wait.resolve();
    const result = (await second).result; assert.notEqual(result.isError, true, plain(result));
    assert.equal(f.prepares, 1);
    assert.equal(result.timing.preparation.status, 'ready');
    const later = (await h.js('nodeRepl.write(typeof coldCellRan)')).result;
    assert.match(plain(later), /undefined/);
  } finally { wait.resolve(); await h.startup; }
});

test('GLS3 a predicted 25 second compile finishes within one 20 second-budget call', { skip: replWorkerSkip, timeout: 10000 }, async t => {
  const wait = deferred(), f = native({ wait: wait.promise, expectedCompileMs: 25000 }), h = launch(t, f);
  try {
    await h.startup;
    const set = globalThis.setTimeout; let hold;
    t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
      if (hold === undefined) { hold = ms; return set(fn, 100, ...args); }
      return set(fn, ms, ...args);
    });
    const cell = h.js('nodeRepl.write("one result after compile")', 20000);
    await new Promise(resolve => set(resolve, 25)); wait.resolve();
    const reply = (await cell).result;
    assert.equal(hold, 30000, 'preparation needs its own 30 second allowance');
    assert.notEqual(reply.isError, true, plain(reply));
    assert.match(plain(reply), /one result after compile/);
    assert.doesNotMatch(plain(reply), /DRIVER_PREPARING/);
  } finally { wait.resolve(); }
});

test('GLS3 a longer compile gives remaining seconds and lets the next call wait', { skip: replWorkerSkip, timeout: 10000 }, async t => {
  const wait = deferred(), f = native({ wait: wait.promise, expectedCompileMs: 65000 }), h = launch(t, f);
  try {
    await h.startup;
    const reply = (await h.js('var mustNotRun = true', 30)).result;
    assert.match(plain(reply), /remaining: \d+ s/i);
    assert.match(plain(reply), /next call waits.*itself/i);
    assert.doesNotMatch(plain(reply), /sleep|requests arrived|action ledger/i);
    assert.equal(reply.timing.preparation.phase, 'compile');
    assert.ok(reply.timing.preparation.remainingMs > 30000);
    wait.resolve();
    assert.match(plain((await h.js('nodeRepl.write(typeof mustNotRun)')).result), /undefined/);
  } finally { wait.resolve(); }
});

test('a call waits through preparation beyond 100 ms before evaluating with its full budget', { skip: replWorkerSkip, timeout: 10000 }, async t => {
  const wait = deferred(), f = native({ wait: wait.promise, readDelayMs: 800 }), h = launch(t, f);
  try {
    await h.startup;
    const started = performance.now();
    const cell = h.js('await cua.getState(); nodeRepl.write("ready after preparation")', 1000);
    assert.equal(await Promise.race([cell, delay(250, 'waiting')]), 'waiting');
    wait.resolve();
    const reply = (await cell).result;
    assert.notEqual(reply.isError, true, plain(reply));
    assert.match(plain(reply), /ready after preparation/);
    assert.ok(performance.now() - started > 1000, 'preparation must not reduce the evaluator budget');
    assert.ok(reply.timing.preparation.waitMs >= 200);
  } finally { wait.resolve(); }
});

test('a long call waits 20 seconds for preparation and keeps its code unexecuted', { skip: replWorkerSkip, timeout: 25000 }, async t => {
  const wait = deferred(), f = native({ wait: wait.promise }), h = launch(t, f);
  try {
    await h.startup;
    const started = performance.now();
    const reply = (await h.js('var neverRan = true', 120000)).result;
    const elapsed = performance.now() - started;
    assert.equal(reply.isError, true);
    assert.match(plain(reply), /DRIVER_PREPARING/);
    assert.ok(elapsed >= 19500 && elapsed < 24000, 'preparation wait ms=' + elapsed);
    assert.deepEqual(f.sink, []);
    wait.resolve();
    assert.match(plain((await h.js('nodeRepl.write(typeof neverRan)')).result), /undefined/);
  } finally { wait.resolve(); }
});

for (const transient of ['HOST_BUILD_BUSY', 'HOST_COMPILE_BACKOFF']) test(transient + ' leaves preparation retryable in the same session', { skip: replWorkerSkip, timeout: 10000 }, async t => {
  const f = native(), prepare = f.options.prepare;
  let attempts = 0;
  f.options.prepare = options => ++attempts === 1 ? { status: 'unavailable', code: transient } : prepare(options);
  const h = launch(t, f);
  await h.startup;
  await delay(10);
  const result = (await h.js('nodeRepl.write("same session recovered")')).result;
  assert.notEqual(result.isError, true, plain(result));
  assert.match(plain(result), /same session recovered/);
  assert.equal(attempts, 2);
});

test('preparation completes before the first cell and its compile receipt stays outside cell time', { skip: replWorkerSkip, timeout: 10000 }, async t => {
  const wait = deferred(), f = native({ wait: wait.promise }), h = launch(t, f);
  try {
    assert.notEqual(await Promise.race([h.call('initialize', {}), delay(500, 'blocked')]), 'blocked');
    await h.call('tools/list');
    assert.equal(f.prepares, 1);
    await delay(160); wait.resolve();
    while (!f.calls.includes('inputGateState')) await delay(1);
    const result = (await h.js('var app = await cua.getApp("Fixture"); await app.getAXState()')).result;
    assert.notEqual(result.isError, true, plain(result));
    assert.equal(plain(result).match(/Window: "Draft"/g)?.length, 1);
    assert.ok(result.timing.preparation.compileMs >= 150);
    assert.equal(result.timing.preparation.origin, 'source');
    assert.ok(result.timing.preparation.elapsedMs >= result.timing.preparation.compileMs);
    t.diagnostic('startup preparation receipt ' + JSON.stringify(result.timing));
  } finally { wait.resolve(); await h.startup; }
});

test('warm production helper cache serves tools/list and the first cell without a compile', { skip: process.platform !== 'darwin', timeout: 10000 }, async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-gls1b-warm-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let compiles = 0;
  const seeded = await prepareMacDriver({ cacheRoot: root, tools: async () => true, prepare: (options, selected) =>
    prepareNativeHelpers({ ...options, compile: async ({ binary }) => {
      compiles++; await writeFile(binary, Buffer.alloc(3 * 1024 * 1024, 42), { mode: 0o700 });
    } }, selected) });
  assert.equal(seeded.status, 'ready'); assert.equal(compiles, 2);
  const f = native(), inert = await f.options.prepare({});
  let preparations = 0, prepareMs;
  f.options.prepare = async options => {
    preparations++;
    const at = performance.now();
    const ready = await prepareMacDriver({ ...options, cacheRoot: root,
      tools: () => assert.fail('warm cache probed compiler tools'), prepare: (options, selected) =>
        prepareNativeHelpers({ ...options, compile: () => assert.fail('warm cache compiled') }, selected) });
    prepareMs = performance.now() - at;
    assert.equal(ready.status, 'ready');
    return { ...ready, spawn: inert.spawn };
  };
  const start = performance.now(), h = launch(t, f);
  const initialized = await h.call('initialize', {});
  const initializeMs = performance.now() - start, listingAt = performance.now();
  assert.ok(initialized.result.serverInfo);
  assert.ok((await h.call('tools/list')).result.tools.some(tool => tool.name === 'js'));
  const toolsListMs = performance.now() - listingAt, cellAt = performance.now();
  const result = (await h.js('var app = await cua.getApp("Fixture"); await app.getAXState()')).result;
  const firstCellMs = performance.now() - cellAt;
  assert.notEqual(result.isError, true, plain(result));
  assert.equal(plain(result).match(/Window: "Draft"/g)?.length, 1);
  assert.equal(preparations, 1); assert.equal(compiles, 2);
  assert.equal(result.timing.preparation.compileMs, 0);
  t.diagnostic('warm production cache ' + JSON.stringify({ initializeMs, toolsListMs, firstCellMs, prepareMs,
    binaryBytes: (await stat(seeded.binary)).size, preparation: result.timing.preparation }));
});

test('launch forwards the prepared capability through runOwnRuntime to the input sink', { skip: replWorkerSkip, timeout: 10000 }, async t => {
  const f = native(), h = launch(t, f);
  const start = await h.startup; assert.equal(start.error, undefined); await h.call('initialize', {});
  const result = (await h.js('var app = await cua.getApp("Fixture"); await app.typeText("GL1C sink");')).result;
  assert.notEqual(result.isError, true, plain(result));
  assert.deepEqual(f.sink, ['GL1C sink']);
  assert.equal(f.prepares, 1);
  assert.match(plain(result), /Input is on/);
  assert.ok(f.calls.includes('inputGateState'));
});

test('cell receipts keep each action timing and ignore worker-authored diagnostic lookalikes', { skip: replWorkerSkip, timeout: 10000 }, async t => {
  const f = native(), h = launch(t, f);
  await h.startup; await h.call('initialize', {});
  const result = (await h.js('var app = await cua.getApp("Fixture"); await app.typeText("one"); await app.typeText("two"); nodeRepl.write(JSON.stringify({timing:{actions:[{sendMs:999999}]}}))')).result;
  assert.notEqual(result.isError, true, plain(result));
  assert.equal(result.timing.actions.length, 2);
  for (const action of result.timing.actions) {
    assert.equal(action.method, 'typeText');
    assert.equal(action.sendMs, 7); assert.equal(action.settleMs, 31); assert.equal(action.postReadMs, 11);
    for (const key of ['admissionReadMs', 'personMs', 'policyMs', 'driverMs', 'totalMs'])
      assert.ok(Number.isFinite(action[key]) && action[key] >= 0, key);
  }
  const empty = (await h.js('nodeRepl.write("no action")')).result;
  assert.deepEqual(empty.timing.actions, []);
});

test('Glide startup trace delivers phase timings to the benchmark reader', { skip: replWorkerSkip, timeout: 10000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-glide-trace-')));
  const f = native(), h = launch(t, f, { traceDirectory: root });
  t.after(() => rm(root, { recursive: true, force: true }));
  await h.startup; await h.call('initialize', {});
  const result = (await h.js('var app = await cua.getApp("Fixture"); await app.typeText("test");')).result;
  assert.notEqual(result.isError, true, plain(result));
  const timing = traceTiming(root);
  assert.ok(timing, 'Glide startup did not enable its requested trace');
  assert.equal(timing.glideActions, 1);
  assert.equal(timing.glideActionPhases.sendMs, 7);
  assert.equal(timing.glideActionPhases.settleMs, 31);
  assert.equal(timing.glideActionPhases.postReadMs, 11);
  assert.ok(timing.glidePreparation.compileMs >= 0);
});

test('pending and copied capabilities grant no input; bound aliases validate once', async () => {
  const wait = deferred(); let pings = 0;
  const driver = { async ping() { pings++; await wait.promise; return { build: 'a'.repeat(64) }; },
    async request() { return { enabled: true }; } };
  const token = registrar.deferMacInputRegistrar(driver, 'a'.repeat(64)), alias = {};
  const bound = registrar.bindMacInputRegistrar(token, driver, alias);
  assert.equal(registrar.hasMacInputRegistrar(token, driver), false);
  assert.equal(registrar.hasMacInputRegistrar(bound, alias), false);
  assert.equal(registrar.ownsMacInputRegistrar(structuredClone(token), driver), false);
  const first = registrar.waitForMacInputRegistrar(token, driver, 1000);
  const second = registrar.waitForMacInputRegistrar(bound, alias, 1000);
  await delay(1); assert.equal(pings, 1);
  wait.resolve(); await Promise.all([first, second]);
  assert.equal(registrar.hasMacInputRegistrar(token, driver), true);
  assert.equal(registrar.hasMacInputRegistrar(bound, alias), true);
  assert.equal(registrar.hasMacInputRegistrar(token, alias), false);
});

test('Stop during preparation prevents the waiting cell from starting afterward', { skip: replWorkerSkip, timeout: 10000 }, async t => {
  const wait = deferred(), f = native({ wait: wait.promise }), h = launch(t, f);
  try {
    const { owner, error } = await h.startup; assert.equal(error, undefined);
    await h.call('initialize', {});
    const cell = h.js('var app = await cua.getApp("Fixture"); await app.typeText("must not appear")');
    while (!f.prepares) await delay(1);
    const stopping = owner.runtime.stopEngine();
    assert.notEqual(await Promise.race([stopping, delay(500, 'blocked')]), 'blocked',
      'Stop must finish before compilation without retiring the shared preparation');
    const stopped = await Promise.race([cell, delay(250, 'blocked')]);
    assert.notEqual(stopped, 'blocked', 'Stop must release the wait before the compiler finishes');
    const reply = stopped.result;
    assert.equal(reply.isError, true); assert.match(plain(reply), /REPL_CELL_ENDED/);
    assert.deepEqual(f.sink, []);
    assert.equal(f.calls.includes('resolveApp'), false);
    wait.resolve();
    const later = (await h.js('await cua.getState()')).result;
    assert.notEqual(later.isError, true, plain(later));
    assert.equal(f.prepares, 1);
  } finally { wait.resolve(); await h.startup; }
});

test('every input notice stays under the 2500 byte own-runtime budget', async () => {
  assert.match(runtime.ownConfirmationPolicy(), /Input is unavailable/);
  const driver = { async ping() { throw Object.assign(Error('fixture'), { code: 'A'.repeat(64) }); } };
  const token = registrar.deferMacInputRegistrar(driver, 'a'.repeat(64));
  for (const failed of [false, true]) {
    if (failed) await registrar.waitForMacInputRegistrar(token, driver, 1000).catch(() => {});
    const policy = runtime.ownConfirmationPolicy(token, driver);
    assert.match(policy, /Input is unavailable/);
    const notices = runtime.ownRuntimeNotices(); notices[0] = policy;
    assert.ok(Buffer.byteLength(notices.join('\n')) < 2500);
  }
});

test('doctor bounds slow preparation and aborts its owned compile without querying health', { timeout: 10000 }, async () => {
  let aborted = false;
  const result = await diagnosis.runtimeGrantState({ timeoutMs: 30, driverOptions: { platform: 'darwin',
    prepare: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      aborted = true; reject(Object.assign(Error('ABORT_ERR'), { code: 'ABORT_ERR' }));
    }, { once: true })) } });
  assert.deepEqual(result, { unavailable: 'DRIVER_PREPARE_TIMEOUT' });
  assert.equal(aborted, true);
});
