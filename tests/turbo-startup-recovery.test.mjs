// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
const MAC_USERS = ['', 'Users', ''].join('/');
// A turbo start that fails before any command reaches the browser starts once more, keeps its stage and code where the
// harness and the trace can find them, and is never retried once the browser could have received something.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { withMT } from './fixtures/mt-env.mjs';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { createProtocol } from '../bench/turbo/v3-protocol.mjs';
import { createSession } from '../bench/turbo/v3-session.mjs';
import { recordStartupFailure } from '../bench/turbo/v3-server.mjs';
import { startBenchWorker } from '../bench/turbo/v3-worker.mjs';
import { createV3Bridge, serveV3Worker, startInstalledV3Worker, unavailableFrame, startupReason, transientStartup,
  traceStartupFailure } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { prepareInstalledStartup } from '../plugins/sleight/lib/launch.mjs';
import { retryCodes, runOnceMore, transientRunFailure } from '../plugins/sleight/lib/direct-browser/transient.mjs';
import { proveRunningCode } from '../plugins/sleight/lib/direct-browser/executable-trust.mjs';

const read = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } };
const ok = { text: 'Untrusted page', isError: false };
function protocolFixture(start, options = {}) {
  const output = new PassThrough(), messages = [], failures = [];
  output.on('data', data => messages.push(JSON.parse(data)));
  const protocol = createProtocol({ output, start, validate: value => value, retryDelayMs: 1,
    onStartupFailure: failure => failures.push(failure), ...options });
  return { protocol, messages, failures, text: index => messages[index].result.content[0].text };
}
const startupFailure = (message, stage, reason) => Object.assign(Error(message), { stage, reason, beforeCdp: true });

test('a start that failed before any browser command starts once more within the same call', async () => {
  let starts = 0, calls = 0;
  const f = protocolFixture(async () => {
    if (++starts === 1) throw startupFailure('V3_RUNTIME_UNAVAILABLE', 'connection-select', 'STALE_INSTANCE');
    return { call: async () => { calls++; return ok; }, close: async () => {} };
  });
  await f.protocol.message({ ...read, id: 1 });
  assert.equal(starts, 2); assert.equal(calls, 1);
  assert.deepEqual(f.messages[0].result, { content: [{ type: 'text', text: ok.text }], isError: false });
  assert.deepEqual(f.failures.map(({ ms, ...rest }) => rest), [{ attempt: 1, stage: 'connection-select', code: 'V3_RUNTIME_UNAVAILABLE',
    reason: 'STALE_INSTANCE', retrying: true }]);
  await f.protocol.message({ ...read, id: 2 }); assert.equal(starts, 2); assert.equal(calls, 2);
  await f.protocol.close();
});

test('a second failed start is final for the task and names its stage', async () => {
  let starts = 0;
  const f = protocolFixture(async () => { starts++; throw startupFailure('V3_RUNTIME_UNAVAILABLE', 'connection-select', 'SELECTED_PROCESS_UNPROVED'); });
  await f.protocol.message({ ...read, id: 1 });
  await f.protocol.message({ ...read, id: 2 });
  assert.equal(starts, 2, 'one retry, then the failure stays for the task');
  for (const index of [0, 1]) {
    assert.equal(f.messages[index].result.isError, true);
    assert.equal(f.text(index), 'Turbo bench unavailable (effect unknown, startup stage connection-select). Read before any retry.');
  }
  assert.deepEqual(f.failures.map(row => [row.attempt, row.retrying]), [[1, true], [2, false]]);
  await f.protocol.close();
});

test('a start that hung is not retried, so the call cannot outlast the client', async () => {
  let starts = 0, clock = 0;
  const f = protocolFixture(async () => { starts++; clock += 31000; throw startupFailure('V3_WORKER_UNAVAILABLE', 'bind', 'V3_WORKER_UNAVAILABLE'); },
    { now: () => clock });
  await f.protocol.message({ ...read, id: 1 });
  assert.equal(starts, 1); assert.deepEqual(f.failures.map(row => [row.attempt, row.retrying, row.ms]), [[1, false, 31000]]);
  await f.protocol.close();
});

test('a start failure that does not say it came before any browser command is not retried', async () => {
  let starts = 0;
  const f = protocolFixture(async () => { starts++; throw Object.assign(Error('V3_RUNTIME_UNAVAILABLE'), { stage: 'serve' }); });
  await f.protocol.message({ ...read, id: 1 });
  await f.protocol.message({ ...read, id: 2 });
  assert.equal(starts, 1);
  assert.deepEqual(f.failures.map(row => [row.attempt, row.stage, row.retrying]), [[1, 'serve', false]]);
  await f.protocol.close();
});

test('a call that failed after the session started is never retried, and its next call reuses the session', async () => {
  let starts = 0, calls = 0;
  const f = protocolFixture(async () => { starts++; return { call: async () => { calls++; throw Object.assign(Error('V3_WORKER_UNAVAILABLE'), { beforeCdp: true }); },
    close: async () => {} }; });
  await f.protocol.message({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_act', arguments: { steps: [{ do: 'click', ref: 'e1' }] } } });
  assert.equal(starts, 1); assert.equal(calls, 1); assert.deepEqual(f.failures, []);
  assert.equal(f.text(0), 'Turbo bench unavailable (effect unknown). Read before any retry.');
  await f.protocol.message({ ...read, id: 2 }); assert.equal(starts, 1); assert.equal(calls, 2);
  await f.protocol.close();
});

test('startup records go to the task folder and the trace with codes only', t => {
  const dir = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-startup-metric-'))));
  const traced = [];
  const metric = recordStartupFailure(join(dir, 'turbo-metrics.jsonl'), { attempt: 1, stage: 'connection-select',
    code: 'V3_RUNTIME_UNAVAILABLE', reason: 'STALE_INSTANCE', retrying: true, ms: 41 }, { trace: value => traced.push(value) });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'turbo-metrics.jsonl'), 'utf8')), metric);
  assert.deepEqual(metric, { version: 3, phase: 'startup-failed', attempt: 1, stage: 'connection-select', code: 'V3_RUNTIME_UNAVAILABLE',
    reason: 'STALE_INSTANCE', retrying: true, ms: 41 });
  assert.deepEqual(traced, [{ code: 'V3_RUNTIME_UNAVAILABLE', stage: 'connection-select', reason: 'STALE_INSTANCE', attempt: 1, retrying: true }]);
  // A bad destination never throws into the protocol.
  assert.doesNotThrow(() => recordStartupFailure(join(dir, 'elsewhere.jsonl'), metric, { trace: () => {} }));

  traceStartupFailure({ code: 'V3_RUNTIME_UNAVAILABLE', stage: 'connection-select', reason: 'STALE_INSTANCE', attempt: 2, retrying: false },
    { setting: join(dir, 'logs'), relayPid: 77 });
  traceStartupFailure({ code: `${MAC_USERS}someone/private`, stage: 'Not A Stage', reason: 'has spaces and /paths' }, { setting: join(dir, 'logs'), relayPid: 77 });
  traceStartupFailure({ code: 'X1' }, { setting: '', relayPid: 77 });
  const rows = readFileSync(join(dir, 'logs', 'trace-77.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => [row.direction, row.msg]), [
    ['turbo-startup-failed', { code: 'V3_RUNTIME_UNAVAILABLE', stage: 'connection-select', reason: 'STALE_INSTANCE', attempt: 2, retrying: false }],
    ['turbo-startup-failed', { code: 'UNKNOWN', stage: 'startup', reason: 'UNKNOWN' }]]);
});

test('the worker names the failed startup stage and a code, never the message of a system error', async () => {
  for (const [stage, dependencies] of [
    ['config', { readConfig: () => null }],
    ['helpers', { prepareHelpers: async () => ({ status: 'unavailable', code: 'HOST_BUILD_BUSY' }) }],
    ['connection-select', { selectConnection: async () => { throw Error('STALE_INSTANCE'); } }],
  ]) {
    const channel = new EventEmitter(); channel.connected = true; channel.send = () => {};
    const error = await startInstalledV3Worker({ channel }, { recoverClipboard: async () => {}, schedule: () => undefined, tracePhase: () => {}, readConfig: () => ({}),
      acceptPackage: () => ({ current: () => true }), prepareHelpers: async () => ({ status: 'ready', receipt: {} }),
      createUi: () => ({ present() {}, authenticate: () => false, close() {} }), ...dependencies }).then(() => assert.fail('started'), value => value);
    assert.equal(error.stage, stage);
    assert.deepEqual(Object.keys(unavailableFrame(error)), ['version', 'status', 'code', 'stage', 'reason']);
    assert.equal(unavailableFrame(error).stage, stage);
  }
  const system = Object.assign(Error(`ENOENT: no such file or directory, open '${MAC_USERS}someone/Library/x'`), { code: 'ENOENT' });
  assert.equal(startupReason(system), 'ENOENT');
  assert.equal(startupReason(new TypeError(`Cannot read properties of ${MAC_USERS}someone`)), 'TypeError');
  assert.equal(startupReason(Error('SELECTED_PROCESS_UNPROVED')), 'SELECTED_PROCESS_UNPROVED');
  assert.deepEqual(unavailableFrame(Error('HOST_PACKAGE_MISMATCH')), { version: 3, status: 'unavailable', code: 'HOST_PACKAGE_MISMATCH',
    stage: 'startup', reason: 'HOST_PACKAGE_MISMATCH' });
  // The bench worker's own steps carry their stage too.
  const bench = await startBenchWorker({ channel: new EventEmitter(), realBrowser: null,
    launch: async () => { throw Error('BENCH_BROWSER_MISSING'); } }).then(() => assert.fail('started'), value => value);
  assert.equal(bench.stage, 'bench-browser');
  const real = await startBenchWorker({ channel: new EventEmitter(), realBrowser: { browser: 'chrome' },
    realOptions: async () => { throw Error('BENCH_PROFILE_UNSAFE'); } }).then(() => assert.fail('started'), value => value);
  assert.equal(real.stage, 'bench-config');
});

// A forked worker stand-in: it either fails its startup with the given frame (or exit) or serves turns.
// exitFirst: the exit event comes before the worker's own frame, as IPC ordering allows.
function fork({ fail, exit, begin, exitFirst, disconnectOnCall } = {}) {
  const forks = [];
  const forkWorker = (_path, _args, options) => {
    const child = new EventEmitter(), endpoint = new EventEmitter();
    forks.push(options);
    child.connected = endpoint.connected = true;
    child.send = frame => queueMicrotask(() => {
      if (disconnectOnCall && frame.method === 'call') child.disconnect();
      else endpoint.emit('message', structuredClone(frame));
    });
    endpoint.send = frame => queueMicrotask(() => child.emit('message', structuredClone(frame)));
    child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
    child.unref = () => {};
    if (exit) queueMicrotask(() => child.emit('exit', exit, null));
    else if (fail && exitFirst) queueMicrotask(() => { child.emit('exit', 0, null); setTimeout(() => endpoint.send(fail), 5); });
    else if (fail) queueMicrotask(() => endpoint.send(fail));
    else {
      const worker = serveV3Worker({ channel: endpoint, browser: 'bbench', begin: begin ?? (async () => ({ call: async () => ok, delivered: () => true,
        end: async () => ({ revoked: true, cleanup: [] }) })) });
      queueMicrotask(() => worker.ready());
    }
    return child;
  };
  return { forkWorker, forks };
}
const bridgeDependencies = forkWorker => ({ readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
  shareConsent: async () => undefined, tracePhase: () => {}, forkWorker });

for (const mode of [undefined, '0']) test(`a worker lost on the first call returns the Helium failure pair without entering TU1 startup retry, MT=${mode}`, async () => withMT(mode, async () => {
  const worker = fork({ disconnectOnCall: true });
  let starts = 0;
  const f = protocolFixture(async () => {
    starts++;
    const bridge = await createV3Bridge({}, bridgeDependencies(worker.forkWorker));
    assert.equal(await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'fixture', text: 'Read the fixture.' }), true);
    return { call: bridge.call, delivered: bridge.delivered, close: bridge.close };
  });
  await f.protocol.message({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'browser_open', arguments: { url: 'https://fixture.invalid', browser: 'bbench' } } });
  await f.protocol.message({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'browser_tabs', arguments: { do: 'list' } } });
  assert.equal(f.text(0), mode === '0'
    ? 'Input outcome is unconfirmed. Read state before retrying; use the engine browser path if needed.'
    : 'Input outcome is unconfirmed. Read state before retrying.');
  assert.equal(f.messages[0].result.isError, false);
  assert.equal(f.text(1), 'Turbo is unavailable for this turn. Use the engine browser path.');
  assert.equal(f.messages[1].result.isError, true);
  assert.equal(starts, 1); assert.equal(worker.forks.length, 1); assert.deepEqual(f.failures, []);
  await f.protocol.close();
}));

test('the bridge keeps the worker\'s stage and code, and an older three-field frame still works', async () => {
  const frame = { version: 3, status: 'unavailable', code: 'V3_RUNTIME_UNAVAILABLE', stage: 'connection-select', reason: 'STALE_INSTANCE' };
  let error = await createV3Bridge({}, bridgeDependencies(fork({ fail: frame }).forkWorker)).then(() => assert.fail('ready'), value => value);
  assert.equal(error.message, 'V3_RUNTIME_UNAVAILABLE'); assert.equal(error.stage, 'connection-select'); assert.equal(error.reason, 'STALE_INSTANCE');
  error = await createV3Bridge({}, bridgeDependencies(fork({ fail: { ...frame, stage: '../x', reason: 'a path/here' } }).forkWorker)).then(() => assert.fail('ready'), value => value);
  assert.equal(error.stage, 'startup'); assert.equal(error.reason, 'V3_RUNTIME_UNAVAILABLE');
  error = await createV3Bridge({}, bridgeDependencies(fork({ fail: { version: 3, status: 'unavailable', code: 'HOST_SOURCE_MISMATCH' } }).forkWorker))
    .then(() => assert.fail('ready'), value => value);
  assert.equal(error.message, 'HOST_SOURCE_MISMATCH'); assert.equal(error.stage, 'startup');
  error = await createV3Bridge({}, bridgeDependencies(fork({ fail: { ...frame, reason: 'SELECTED_PROCESS_UNPROVED' }, exitFirst: true }).forkWorker))
    .then(() => assert.fail('ready'), value => value);
  assert.equal(error.stage, 'connection-select', 'the worker\'s frame names the failure even after its exit');
  assert.equal(error.reason, 'SELECTED_PROCESS_UNPROVED'); assert.equal(transientStartup(error), false);
  error = await createV3Bridge({}, bridgeDependencies(fork({ exit: 1 }).forkWorker)).then(() => assert.fail('ready'), value => value);
  assert.equal(error.message, 'V3_WORKER_UNAVAILABLE'); assert.equal(error.stage, 'worker-exit'); assert.equal(error.reason, 'EXIT_1');
  assert.equal(transientStartup(error), true);
  assert.equal(transientStartup({ stage: 'worker-exit', reason: 'EXIT_0' }), false, 'a worker that exited cleanly said why first');
  assert.equal(transientStartup({ stage: 'worker-timeout', reason: 'V3_WORKER_UNAVAILABLE' }), false, 'a hung worker is not started twice');
  assert.equal(transientStartup({ stage: 'connection-select', reason: 'SELECTED_PROCESS_UNPROVED' }), false, 'Chrome closed stays closed');
  assert.equal(transientStartup({ stage: 'connection-select', reason: 'STALE_INSTANCE' }), true);
});

test('the bench session marks every startup failure as before any browser command and passes SLEIGHT_TRACE to its worker', async t => {
  const previous = process.env.SLEIGHT_TRACE; process.env.SLEIGHT_TRACE = `${MAC_TMP}/sleight-trace-fixture`;
  t.after(() => { if (previous === undefined) delete process.env.SLEIGHT_TRACE; else process.env.SLEIGHT_TRACE = previous; });
  const failing = fork({ fail: { version: 3, status: 'unavailable', code: 'V3_RUNTIME_UNAVAILABLE', stage: 'connection-select', reason: 'STALE_INSTANCE' } });
  const error = await createSession({ origins: [], taskMessage: 'Read the page.', forkWorker: failing.forkWorker }).then(() => assert.fail('started'), value => value);
  assert.equal(error.beforeCdp, true); assert.equal(error.stage, 'connection-select'); assert.equal(error.reason, 'STALE_INSTANCE');
  assert.equal(failing.forks[0].env.SLEIGHT_TRACE, `${MAC_TMP}/sleight-trace-fixture`);
  assert.equal(failing.forks[0].env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  const unbound = await createSession({ origins: [], taskMessage: 'Read the page.', forkWorker: fork({ begin: async () => undefined }).forkWorker })
    .then(() => assert.fail('started'), value => value);
  assert.equal(unbound.message, 'V3_PRIVATE_PROVIDERS_UNAVAILABLE'); assert.equal(unbound.stage, 'bind'); assert.equal(unbound.beforeCdp, true);
  const input = await createSession({ origins: [], taskMessage: '' }).then(() => assert.fail('started'), value => value);
  assert.equal(input.beforeCdp, undefined, 'a refused task input never forks and is not retried');
});

test('the relay starts the bridge once more after a transient failure and reports a second one with its stage', async () => {
  const transient = () => Object.assign(Error('V3_WORKER_UNAVAILABLE'), { stage: 'worker-exit', reason: 'EXIT_1' });
  let builds = 0; const notices = [], traced = [], logs = [];
  const recovered = await prepareInstalledStartup(async () => {
    if (++builds === 1) throw transient();
    return createV3Bridge({}, bridgeDependencies(fork().forkWorker));
  }, (...args) => notices.push(args), { retryDelayMs: 1, trace: value => traced.push(value), log: text => logs.push(text) });
  assert.equal(builds, 2); assert.ok(recovered.directBrowser); assert.deepEqual(notices, []);
  assert.deepEqual(traced, [{ code: 'V3_WORKER_UNAVAILABLE', stage: 'worker-exit', reason: 'EXIT_1', attempt: 1, retrying: true }]);
  assert.match(logs.join(''), /turbo startup failed \(V3_WORKER_UNAVAILABLE at worker-exit: EXIT_1\); starting it once more/);
  await recovered.directHost.close();

  builds = 0; traced.length = 0;
  const failed = await prepareInstalledStartup(async () => { builds++; throw transient(); }, (...args) => notices.push(args),
    { retryDelayMs: 1, trace: value => traced.push(value), log: () => {} });
  assert.equal(builds, 2); assert.equal(failed.turboUnavailable, 'V3_WORKER_UNAVAILABLE');
  assert.deepEqual(notices, [['V3_WORKER_UNAVAILABLE', { stage: 'worker-exit', reason: 'EXIT_1' }]]);
  assert.deepEqual(traced.map(row => [row.attempt, row.retrying]), [[1, true], [2, false]]);

  builds = 0; notices.length = 0;
  const closed = await prepareInstalledStartup(async () => { builds++;
    throw Object.assign(Error('V3_RUNTIME_UNAVAILABLE'), { stage: 'connection-select', reason: 'SELECTED_PROCESS_UNPROVED' }); },
  (...args) => notices.push(args), { retryDelayMs: 1, trace: () => {}, log: () => assert.fail('retried') });
  assert.equal(builds, 1, 'a browser that is not running is not retried'); assert.equal(closed.turboUnavailable, 'V3_RUNTIME_UNAVAILABLE');
});

test('one more run only for a helper that never completed, and bounded retries of a read', async () => {
  assert.equal(transientRunFailure(Object.assign(Error('timed out'), { killed: true, signal: 'SIGTERM', code: null })), true);
  assert.equal(transientRunFailure(Object.assign(Error('spawn'), { code: 'EAGAIN' })), true);
  assert.equal(transientRunFailure(Object.assign(Error('exit 65'), { code: 65, killed: false, signal: null })), false);
  assert.equal(transientRunFailure(Object.assign(Error('missing'), { code: 'ENOENT' })), false);
  let runs = 0;
  const flaky = async () => { if (++runs === 1) throw Object.assign(Error('killed'), { killed: true, signal: 'SIGTERM' }); return { stdout: 'ok' }; };
  assert.deepEqual(await runOnceMore(flaky, 'x', [], {}, { delayMs: 1 }), { stdout: 'ok' }); assert.equal(runs, 2);
  runs = 0;
  const refusing = async () => { runs++; throw Object.assign(Error('exit 1'), { code: 1 }); };
  await assert.rejects(runOnceMore(refusing, 'x', [], {}, { delayMs: 1 }), /exit 1/); assert.equal(runs, 1);
  runs = 0;
  const hung = async () => { runs++; throw Object.assign(Error('killed'), { killed: true }); };
  await assert.rejects(runOnceMore(hung, 'x', [], {}, { delayMs: 1 }), /killed/); assert.equal(runs, 2);
  runs = 0;
  await assert.rejects(retryCodes(async () => { runs++; throw Error('STALE_INSTANCE'); }, ['STALE_INSTANCE'], { delayMs: 1 }), /STALE_INSTANCE/);
  assert.equal(runs, 3);
  runs = 0;
  await assert.rejects(retryCodes(async () => { runs++; throw Error('SELECTED_PROCESS_UNPROVED'); }, ['STALE_INSTANCE'], { delayMs: 1 }));
  assert.equal(runs, 1);
});

test('codesign that its timeout killed runs once more; a codesign that refused is final', async () => {
  const status = { flags: 0x1 | 0x200 | 0x2000 | 0x10000, arch: 'arm64', cdhash: 'a'.repeat(40) };
  const executable = '/Applications/Example.app/Contents/MacOS/Example';
  let runs = 0;
  assert.equal(await proveRunningCode(async () => { if (++runs === 1) throw Object.assign(Error('killed'), { killed: true, signal: 'SIGTERM' }); return {}; },
    status, 'identifier "com.example"', executable), true);
  assert.equal(runs, 2);
  runs = 0;
  await assert.rejects(proveRunningCode(async () => { runs++; throw Object.assign(Error('invalid'), { code: 1 }); }, status, 'identifier "com.example"', executable),
    /SELECTED_SIGNATURE_UNPROVED/);
  assert.equal(runs, 1);
});
