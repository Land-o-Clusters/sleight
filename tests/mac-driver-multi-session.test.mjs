import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, fork, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnRuntime, runOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { macLeaseTarget } from '../plugins/sleight/lib/mac-safety.mjs';
import { InputLease, leaseKey } from '../plugins/sleight/lib/input-lease.mjs';
import { REPL_NODE_UNSUPPORTED } from '../plugins/sleight/lib/repl/client.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

const workerOptions = { skip: !process.allowedNodeEnvironmentFlags.has('--allow-net') && REPL_NODE_UNSUPPORTED,
  timeout: 60000 };
const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
const helper = fileURLToPath(new URL('./fixtures/mac-driver-session.mjs', import.meta.url));
const windowFor = index => ({ windowId: String(101 + index), pid: 120, processStart: '134059077770000001',
  bundleId: 'com.example.Editor' });
const directory = t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-rt16c-')));
  t.after(() => removeTemp(dir)); return dir;
};
const records = dir => readdirSync(dir).filter(name => name.endsWith('.json')).sort();

async function fixture(t, { index = 0, dir = directory(t), transport = false, prepare, driver,
  helperMode = String(index), lease: suppliedLease } = {}) {
  const helpers = [], workers = [], pending = new Map(), signals = new EventEmitter();
  let holding;
  const held = new Promise(resolve => { holding = resolve; });
  const lease = suppliedLease ?? new InputLease({ directory: dir, holder: `session-${index}` });
  const options = { driver, lease,
    driverOptions: { platform: 'darwin', prepare: prepare ?? (async () => ({ status: 'ready', spawn({ nonce }) {
      const child = spawn(process.execPath, [helper, helperMode],
        { stdio: ['pipe', 'pipe', 'pipe'], env: { SLEIGHT_DRIVER_NONCE: nonce } });
      child.stderr.on('data', bytes => { if (/HOLD_(READ|PING)/.test(bytes.toString())) holding(); });
      helpers.push(child); return child;
    } })) },
    approve: () => true, policy: () => ({ allow: true }),
    permissions: { app() {}, page() {}, sitesLimited: () => false },
    targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/Host' }],
    replOptions: { environment: () => ({}), spawn: (...args) => {
      const child = fork(...args); workers.push(child); return child;
    } },
  };
  // EOF must exercise its own listener without an automatic close masking it.
  const input = new PassThrough({ autoDestroy: false }), output = new PassThrough();
  const owner = transport ? await runOwnRuntime({ ...options, input, output, signals,
    allowForbidden: () => false, ownHostPid: () => false,
    approvalStorage: { load: () => ({}), live: () => ({ list: () => [], allows: () => false }) },
    ask: () => 'accept', grantAudit() {}, relayOptions: { idleTurnEndMs: 0 },
  }) : createOwnRuntime(options);
  const runtime = transport ? owner.runtime : owner;
  t.after(() => owner.close().catch(() => {}));
  let next = 0, buffer = '';
  runtime.serverOut.setEncoding('utf8').on('data', bytes => {
    buffer += bytes;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      runtime.safety.guardResult(message);
      const result = runtime.safety.displayResult(message.id, message.result);
      pending.get(message.id)?.(result); pending.delete(message.id);
    }
  });
  const call = (name, args = {}) => new Promise(resolve => {
    const id = ++next; pending.set(id, resolve);
    runtime.serverIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  const js = code => call('js', { code });
  return { owner, runtime, js, call, lease, dir, helpers, workers, held, input, output, signals };
}
const collected = f => {
  for (const child of [...f.helpers, ...f.workers]) assert.notEqual(child.exitCode ?? child.signalCode, null);
};
const alive = f => {
  for (const child of [...f.helpers, ...f.workers]) assert.equal(child.exitCode ?? child.signalCode, null);
};
const exited = f => [...f.helpers, ...f.workers].every(child => (child.exitCode ?? child.signalCode) !== null);
async function waitFor(check, message) {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), message);
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function fakeDriver({ verify = () => {}, close = async () => {}, restart = async () => {} } = {}) {
  const window = { ...windowFor(0), app: 'Editor', title: 'Draft', identityVerified: true,
    bounds: { x: 0, y: 0, width: 800, height: 600 } };
  return { close, restart, async request(method, params) {
    if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid,
      processStart: window.processStart }, windows: [window] };
    if (method === 'getAXState') return { window, readId: 1, text: 'Window: "Draft", App: Editor.\n0 standard window Draft' };
    if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
    assert.equal(method, 'verifyWindowIdentity'); await verify(); return { window };
  } };
}
function watchSafety(f) {
  const events = [], calls = [];
  for (const method of ['acquire', 'close', 'release']) {
    const original = f.lease[method].bind(f.lease);
    f.lease[method] = (...args) => { events.push(method); return original(...args); };
  }
  const request = f.runtime.safety.request.bind(f.runtime.safety);
  f.runtime.safety.request = (...args) => {
    const call = request(...args); calls.push(call); call.catch(() => {}); return call;
  };
  return { events, calls };
}

test('4 same-process safety sessions hold 4 distinct windows for 30 rounds and shut down independently', workerOptions, async t => {
  const dir = directory(t), sessions = [];
  for (let index = 0; index < 4; index++) sessions.push(await fixture(t, { index, dir }));
  const acquire = await Promise.all(sessions.map(f => f.js('let app = await cua.getApp("Editor");')));
  for (const result of acquire) assert.equal(result.isError, false, text(result));
  const keys = sessions.map((_, i) => leaseKey(macLeaseTarget(windowFor(i))));
  assert.equal(new Set(keys).size, 4);
  for (let round = 0; round < 30; round++) {
    const results = await Promise.all(sessions.map(f => f.js('await app.getAXState({disableDiffing:true});')));
    for (const [i, result] of results.entries()) {
      assert.equal(result.isError, false, text(result));
      assert.match(text(result), new RegExp(`session-${i}/read-${round + 2}(?:\\s|$)`));
      for (let other = 0; other < 4; other++) if (other !== i)
        assert.doesNotMatch(text(result), new RegExp(`session-${other}/`));
      assert.deepEqual([...sessions[i].lease.owned.keys()], [keys[i]]);
      const record = JSON.parse(readFileSync(join(dir, keys[i] + '.json'), 'utf8'));
      assert.equal(record.holder, `session-${i}`);
      assert.equal(record.token, sessions[i].lease.owned.get(keys[i]));
      assert.equal(sessions[i].helpers.length, 1); assert.equal(sessions[i].workers.length, 1);
      alive(sessions[i]);
    }
    assert.deepEqual(records(dir), keys.map(key => key + '.json').sort());
  }
  assert.equal(new Set(sessions.map(f => f.helpers[0].pid)).size, 4);
  assert.equal(new Set(sessions.map(f => f.workers[0].pid)).size, 4);
  // Real getApp must fail before any content read on another session's window.
  for (let i = 1; i < 4; i++) {
    const result = await sessions[i].js('await cua.getApp({windowId:"101"});');
    assert.equal(result.isError, true); assert.match(text(result), /Input lease: held by session-0/);
    assert.doesNotMatch(text(result), /session-\d\/read-/);
    assert.deepEqual([...sessions[i].lease.owned.keys()], [keys[i]]);
  }
  for (let i = 3; i >= 0; i--) {
    const foreign = keys.slice(0, i).map(key => readFileSync(join(dir, key + '.json'), 'utf8'));
    await sessions[i].owner.close(); collected(sessions[i]);
    assert.equal(sessions[i].lease.owned.size, 0);
    assert.equal(existsSync(join(dir, keys[i] + '.json')), false);
    for (let j = 0; j < i; j++) {
      assert.equal(readFileSync(join(dir, keys[j] + '.json'), 'utf8'), foreign[j]);
      alive(sessions[j]);
      const result = await sessions[j].js('await app.getAXState();');
      assert.equal(result.isError, false, text(result));
    }
  }
  assert.deepEqual(records(dir), []);
});

for (const [surface, event] of [['input', 'end'], ['input', 'close'], ['input', 'error'], ['output', 'error'],
  ['signals', 'SIGINT'], ['signals', 'SIGTERM'], ['signals', 'SIGHUP']]) {
  test(`${surface} ${event} collects its runtime and preserves another session`, workerOptions, async t => {
    const f = await fixture(t, { transport: true }), other = await fixture(t, { index: 1 });
    for (const session of [f, other]) {
      const result = await session.js('let app = await cua.getApp("Editor");');
      assert.equal(result.isError, false, text(result));
    }
    if (event === 'end') { f.input.resume(); f.input.end(); await once(f.input, 'end'); }
    else if (event === 'close') { f.input.destroy(); await once(f.input, 'close'); }
    else f[surface].emit(event, event === 'error' ? Error('fixture transport failed') : undefined);
    // Observe the trigger before any explicit close can mask a missing listener.
    await waitFor(() => f.runtime.serverIn.destroyed && exited(f) && f.lease.owned.size === 0,
      `${surface} ${event} did not shut down its runtime`);
    collected(f); alive(other);
    assert.deepEqual(records(f.dir), []);
    const closing = f.owner.close(); assert.equal(f.owner.close(), closing); await closing;
    assert.equal((await other.js('await app.getAXState();')).isError, false);
    f.input.emit('error', Error('late input failure')); f.output.emit('error', Error('late output failure'));
    assert.equal(f.signals.listenerCount('exit'), 0);
  });
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`repeated ${signal} signals owned children and releases leases before forced exit`, workerOptions, async t => {
    const gate = deferred(), stopping = deferred();
    t.after(() => gate.resolve());
    const f = await fixture(t, { transport: true,
      driver: fakeDriver({ close: async () => { stopping.resolve(); await gate.promise; } }) });
    const other = await fixture(t, { index: 1, dir: f.dir });
    assert.equal((await other.js('let app = await cua.getApp("Editor");')).isError, false);
    assert.equal(other.helpers.length, 1); assert.equal(other.workers.length, 1);
    const foreignKey = leaseKey(macLeaseTarget(windowFor(1)));
    const foreignPath = join(f.dir, foreignKey + '.json');
    const foreignRecord = readFileSync(foreignPath, 'utf8');
    const preserved = () => {
      assert.equal(readFileSync(foreignPath, 'utf8'), foreignRecord);
      assert.deepEqual([...other.lease.owned.keys()], [foreignKey]);
      assert.equal(other.lease.owned.get(foreignKey), JSON.parse(foreignRecord).token);
      alive(other);
    };
    const watched = watchSafety(f);
    assert.equal((await f.js('await cua.getApp("Editor");')).isError, false);
    assert.equal(f.lease.owned.size, 1);
    let signalled = 0, exits = 0;
    const worker = f.workers[0], kill = worker.kill.bind(worker);
    worker.kill = (...args) => { signalled++; return kill(...args); };
    f.signals.exit = exitCode => {
      exits++; assert.equal(exitCode, code);
      assert.ok(signalled >= 2, 'fallback signals the owned worker again');
      assert.equal(f.lease.owned.size, 0); assert.deepEqual(records(f.dir), [foreignKey + '.json']);
      preserved();
      assert.deepEqual(watched.events, ['acquire', 'close', 'release']);
    };
    f.signals.emit(signal); await stopping.promise;
    assert.equal(f.lease.owned.size, 1, 'first signal waits for driver cleanup');
    assert.equal(f.signals.listenerCount(signal), 1);
    f.signals.emit(signal);
    assert.equal(exits, 1, 'the second signal runs the fallback before exit');
    preserved();
    gate.resolve(); await f.owner.close(); collected(f);
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit']) assert.equal(f.signals.listenerCount(name), 0);
    preserved();
    assert.deepEqual(watched.events, ['acquire', 'close', 'release', 'release']);
    const result = await other.js('await app.getAXState({disableDiffing:true});');
    assert.equal(result.isError, false, text(result));
    assert.match(text(result), /session-1\/read-2(?:\s|$)/);
    await other.owner.close(); collected(other);
    assert.deepEqual(records(f.dir), []);
  });

  test(`real process repeated ${signal} exits with open stdin after synchronous lease cleanup`, workerOptions, async t => {
    const dir = directory(t), child = spawn(process.execPath, [helper, '--signal-runtime', dir],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    // Keep ownership of the test child even when an assertion fails.
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
    let diagnostics = '';
    child.stdout.resume(); child.stderr.setEncoding('utf8').on('data', bytes => { diagnostics += bytes; });
    await waitFor(() => diagnostics.includes('PREPARING'), 'the fixture must enter its non-abortable prepare');
    assert.equal(records(join(dir, 'leases')).length, 1);
    child.kill(signal);
    await waitFor(() => diagnostics.includes('ABORTED') && existsSync(join(dir, 'worker-closed')),
      'the first signal must abort startup and collect the worker');
    assert.equal(records(join(dir, 'leases')).length, 1, 'prepare still blocks async lease cleanup');
    child.kill(signal);
    const [status, killedBy] = await closed;
    assert.equal(killedBy, null, diagnostics); assert.equal(status, code, diagnostics);
    assert.deepEqual(records(join(dir, 'leases')), []);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')), { leases: 0, aborted: true });
  });
}

test('a prepare that ignores abort cannot hold leases beyond the fixed shutdown deadline', workerOptions, async t => {
  const preparing = deferred();
  let aborted = false, spawned = 0;
  const f = await fixture(t, { prepare: ({ signal }) => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    preparing.resolve();
    return new Promise(() => {}).then(() => ({ status: 'ready', spawn() { spawned++; } }));
  } });
  // A pre-existing session record must also be released if startup stalls.
  f.lease.acquire(macLeaseTarget(windowFor(0)), 'window');
  f.js('await cua.getApp("Editor");'); await preparing.promise;
  assert.equal(f.lease.owned.size, 1);
  const closing = f.owner.close();
  await assert.rejects(closing, /OWN_RUNTIME_SHUTDOWN_TIMEOUT/);
  assert.equal(aborted, true); assert.equal(spawned, 0); collected(f);
  assert.equal(f.runtime.serverIn.destroyed, true); assert.equal(f.runtime.serverOut.destroyed, true);
  assert.equal(f.lease.owned.size, 0); assert.deepEqual(records(f.dir), []);
  assert.equal(f.owner.close(), closing);
});

test('in-flight js verification cannot acquire a lease after safety.close', workerOptions, async t => {
  const stopping = deferred(), gate = deferred(), verifying = deferred(), verified = deferred();
  t.after(() => { gate.resolve(); verified.resolve(); });
  let verifyingCall = false, restarts = 0;
  const driver = fakeDriver({
    verify: async () => { if (verifyingCall) { verifying.resolve(); await verified.promise; } },
    close: async () => { stopping.resolve(); await gate.promise; },
    restart: async () => { restarts++; },
  });
  const f = await fixture(t, { driver }), watched = watchSafety(f);
  assert.equal((await f.js('await cua.getApp("Editor");')).isError, false);
  verifyingCall = true;
  f.js('await cua.getApp("Editor");'); await verifying.promise;
  const closing = f.owner.close(); await stopping.promise;
  assert.equal(f.runtime.serverIn.destroyed, false, 'the shutdown window is still open');
  gate.resolve(); await closing;
  const afterClose = [...watched.events];
  assert.deepEqual(afterClose, ['acquire', 'close', 'release']);
  verified.resolve(); await Promise.allSettled(watched.calls);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(watched.events, afterClose, 'late verification cannot acquire a lease');
  // The blocked verification holds the scheduler, so renderer inventory must
  // retire it after 2 s before confirming on a fresh helper.
  assert.equal(f.workers.length, 1); assert.equal(restarts, 1); collected(f);
  assert.deepEqual(records(f.dir), []);
});

test('shutdown during js_reset awaits its pending lease ending and blocks late acquisition', workerOptions, async t => {
  const restarting = deferred(), restarted = deferred(), verifying = deferred(), verified = deferred();
  t.after(() => { restarted.resolve(); verified.resolve(); });
  let verifyingCall = false, restarts = 0, closes = 0;
  const f = await fixture(t, { driver: fakeDriver({
    verify: async () => { if (verifyingCall) { verifying.resolve(); await verified.promise; } },
    restart: async () => { restarts++; restarting.resolve(); await restarted.promise; },
    close: async () => { closes++; },
  }) });
  const watched = watchSafety(f);
  assert.equal((await f.js('await cua.getApp("Editor");')).isError, false);
  verifyingCall = true;
  f.js('await cua.getApp("Editor");'); await verifying.promise;
  f.call('js_reset'); await restarting.promise;
  const closing = f.owner.close();
  assert.equal(f.lease.owned.size, 1, 'reset cleanup still owns the lease');
  restarted.resolve(); await closing; collected(f);
  assert.equal(restarts, 2); assert.equal(closes, 1); // Reset plus bounded renderer retirement.
  // The reset already started a lease ending before shutdown. Its confirmed
  // release precedes close; onReset must not start another ending afterward.
  assert.deepEqual(watched.events, ['acquire', 'release', 'close', 'release']);
  verified.resolve(); await Promise.allSettled(watched.calls);
  assert.deepEqual(watched.events, ['acquire', 'release', 'close', 'release']);
  assert.equal(f.lease.owned.size, 0); assert.deepEqual(records(f.dir), []);
});

test('close aborts a pending prepare before any helper spawn', workerOptions, async t => {
  let entered, aborted = false, spawned = 0;
  const preparing = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { prepare: ({ signal }) => new Promise((resolve, reject) => {
    const abort = () => { aborted = true; reject(Object.assign(Error('fixture compile aborted'), { code: 'ABORT_ERR' })); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    entered();
    // Deliberately no completion timer. Only cancellation can settle prepare.
  }).then(() => ({ status: 'ready', spawn() { spawned++; throw Error('unexpected spawn'); } })) });
  f.js('await cua.getApp("Editor");'); await preparing;
  await f.owner.close();
  assert.equal(aborted, true); assert.equal(spawned, 0); collected(f);
});

test('fake driver and real worker are collected before lease release, including driver failure', workerOptions, async t => {
  for (const failed of [false, true]) {
    const dir = directory(t), lease = new InputLease({ directory: dir });
    const window = { ...windowFor(0), app: 'Editor', title: 'Draft', identityVerified: true,
      bounds: { x: 0, y: 0, width: 800, height: 600 } };
    let stop, collect, f, collectedDriver = false;
    const stopped = new Promise(resolve => { stop = resolve; });
    const gate = new Promise(resolve => { collect = resolve; });
    t.after(() => collect());
    const driver = {
      async request(method, params) {
        if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid,
          processStart: window.processStart }, windows: [window] };
        if (method === 'getAXState') return { window, readId: 1, text: 'Window: "Draft", App: Editor.\n0 standard window Draft' };
        if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
        assert.equal(method, 'verifyWindowIdentity'); return { window };
      },
      async restart() { assert.fail('shutdown must not restart the driver'); },
      async close() { stop(); await gate; collectedDriver = true; if (failed) throw Error('fixture retirement failed'); },
    };
    const closeLease = lease.close.bind(lease);
    lease.close = () => {
      assert.equal(collectedDriver, true, 'the driver completion precedes policy cleanup');
      collected(f); closeLease();
    };
    f = await fixture(t, { dir, driver, lease });
    assert.equal((await f.js('await cua.getApp("Editor");')).isError, false);
    assert.equal(lease.owned.size, 1);
    const closing = f.owner.close(); await stopped;
    assert.equal(lease.owned.size, 1, 'the held driver prevents early release');
    collect();
    if (failed) await assert.rejects(closing, /fixture retirement failed/); else await closing;
    collected(f); assert.deepEqual(records(dir), []);
  }
});

test('close interrupts a pending startup ping and an in-flight content read', workerOptions, async t => {
  for (const helperMode of ['hold-ping', '0']) {
    const f = await fixture(t, { helperMode });
    if (helperMode === '0') assert.equal((await f.js('let app = await cua.getApp("Editor");')).isError, false);
    f.js(helperMode === 'hold-ping' ? 'await cua.getApp("Editor");' : 'await app.getAXState({budgetMs:123});');
    await f.held; await f.owner.close(); collected(f);
    assert.deepEqual(records(f.dir), []);
  }
});

test('real process exit signals both children and retains pending renderer leases for expiry', workerOptions, async t => {
  const dir = directory(t);
  const result = spawnSync(process.execPath, [helper, '--exit-runtime', dir], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'signalled.json'), 'utf8')).sort(), ['helper', 'worker']);
  const key = leaseKey(macLeaseTarget(windowFor(0)));
  assert.deepEqual(records(join(dir, 'leases')), [key + '.json']);
  const retained = JSON.parse(readFileSync(join(dir, 'leases', key + '.json'), 'utf8'));
  assert.equal(retained.holder, 'exit-session'); assert.equal(typeof retained.token, 'string');
  assert.match(result.stderr, /synchronous exit cannot confirm renderer restore/);
  const deadline = Date.now() + 3000;
  while (!existsSync(join(dir, 'helper-signalled')) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(readFileSync(join(dir, 'helper-signalled'), 'utf8'), 'SIGTERM');
});
