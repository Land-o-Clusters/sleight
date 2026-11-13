import { macCommandSkip } from './requirements.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const mutation = process.env.SITPRES2_MUTATION;
const changes = {
  'presence-throws-open': ['runtime-owner-away', 'value => value === true, () => false', 'value => value === true, () => true'],
  'presence-unknown-open': ['runtime-owner-away', 'state.idleSeconds < 0) return undefined;', 'state.idleSeconds < 0) return true;'],
  'presence-timeout-open': ['runtime-owner-away', 'setTimeout(() => resolve(false), presenceMs)', 'setTimeout(() => resolve(true), presenceMs)'],
  'missing-build-notice': ['person-confirm', 'timeoutMs, ready, signal, notice,', 'timeoutMs, ready, signal,'],
  'sitting-reason-typo': ['runtime-owner-away', "OWNER_PRESENT_SITTING = 'owner-present-sitting'", "OWNER_PRESENT_SITTING = 'owner-present-siting'"],
  'unlock-before-acquisition': ['runtime-owner-away', 'Promise.resolve(acquiringLock).then(() => unlock?.())', 'Promise.resolve().then(() => unlock?.())'],
  'guard-foreign-titles': ['swift', 'foreignWindows = newForeign.map(publishedWindowEvidence)', 'foreignWindows = newForeign'],
  'guard-overlay-titles': ['swift', 'overlayWindows = overlays.map(publishedWindowEvidence)', 'overlayWindows = overlays'],
  'title-identity': ['swift', 'identity["name"] = publishedWindowEvidence(row)["name"]', ''],
  'unbounded-identities': ['swift', 'counts.count >= Self.capacity', 'false'],
  'drop-overflow': ['swift', 'overflow += 1', 'overflow = 1'],
  'kill-before-release': ['double-keys-client', 'let timer, released = false;', "let timer, released = false; child.kill('SIGKILL'); await stopped;"],
  'helper-skips-identity': ['person-confirm', 'report?.path === expected.path && report?.sha256 === expected.sha256', 'true'],
  'missing-startup-owner': ['runtime-owner-away', 'onClient: client => { engine = client; },', ''],
  'skip-confirmation': ['runtime-owner-away', 'ownerConfirmed = await (dependencies.confirmHandsOff ?? confirmHandsOff)({ signal: controller.signal });', 'ownerConfirmed = true;'],
  'accept-exit-one': ['runtime-owner-away', "if (result !== 'ok') throw Error('OWNER_PERSON_CONFIRMATION_REQUIRED');", "if (!['ok', 'failed'].includes(result)) throw Error('OWNER_PERSON_CONFIRMATION_REQUIRED');"],
  'dispatch-after-stop': ['runtime-owner-away', "      if (stopped) throw Error(stopped);\n      controller.signal.throwIfAborted();\n      return engine.call", '      return engine.call'],
  'open-after-stop': ['runtime-owner-away', "      if (stopped) throw Error(stopped);\n      controller.signal.throwIfAborted();\n      return (dependencies.open", '      return (dependencies.open'],
  'ignore-second-interrupt': ['runtime-owner-away', "if (ownerPresentHandsOff && signal === 'SIGINT' && ++ownerInterrupts > 1)", 'if (false)'],
  'mark-unadmitted': ['runtime-owner-away', "if (ownerPresentHandsOff && !admitted) throw Error('OWNER_PERSON_CONFIRMATION_REQUIRED');", ''],
  'mark-empty-report': ['runtime-owner-away', 'if (report.results.some(row => row.ownerObserved === true)) report.ownerObserved = true;', 'report.ownerObserved = true;'],
  'client-ignores-close': ['double-keys-client', "    if (callsClosed) throw Error('PROBE_CLIENT_CLOSED');", ''],
  'client-ignores-abort': ['double-keys-client', '    signal?.throwIfAborted();\n    return invoke', '    return invoke'],
  'latency-dispatch-after-abort': ['runtime-probe-live', "      signal?.throwIfAborted();\n      return client.call", '      return client.call'],
  'driver-skips-release': ['runtime-probe-live', 'await client.stopHeld?.();', ''],
  'metadata-device': ['swift', 'UInt32(truncatingIfNeeded: input ?? 0) == runner?.tty', 'true'],
  'metadata-controlling': ['swift', 'runner?.tty != UInt32.max', 'true'],
  'metadata-valid': ['swift', 'valid && runner?.tty != UInt32.max', 'runner?.tty != UInt32.max'],
  'metadata-foreground': ['swift', 'valid && source.foregroundGroup(fd) == source.processGroup()', 'true'],
  'metadata-chain-tty': ['swift', 'info.tty == runner?.tty', 'true'],
  'animation-flood': ['swift', '["pid", "bundle", "window", "owner", "name", "layer"].contains($0.key)', 'true'],
  'drop-count': ['swift', 'counts[key, default: 0] += 1', 'counts[key] = 1'],
  'publish-title': ['swift', '["StatusIndicator", "Software Cursor"].contains(name) ? name : ""', 'name'],
  'guard-skips-allowance': ['sitting-process', 'ownerPresentHandsOff ? 0 : observeOnly ? 32 : resetCounts?.[callKind]', 'observeOnly ? 32 : resetCounts?.[callKind]'],
};
async function moduleFor(name) {
  const url = new URL(name === 'person-confirm' ? '../plugins/sleight/lib/person-confirm.mjs' : `../bench/${name}.mjs`, import.meta.url);
  if (!mutation || changes[mutation]?.[0] !== name) return import(url);
  const [, before, after] = changes[mutation];
  const source = readFileSync(url, 'utf8'); assert.ok(source.includes(before), mutation);
  let mutated = source.replace(before, after);
  if (mutation === 'client-ignores-abort') mutated = mutated.replace("  signal?.addEventListener('abort', abort, { once: true });", '');
  const changed = mutated.replaceAll('import.meta.url', JSON.stringify(url.href))
    .replace(/from '(\.\.?\/[^']+)'/g, (_, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
  return import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}
const { helperConfirm, personConfirmationResult } = await moduleFor('person-confirm');
const runtime = await moduleFor('runtime-owner-away');
const clientModule = await moduleFor('double-keys-client');
const probe = await moduleFor('runtime-probe-live');
const processModule = await moduleFor('sitting-process');
const ready = { schema: 'sleight.input-readiness/1', qualification: false, drawing: false, ready: true, error: null,
  grants: { quartzListen: 'granted', hidListen: 'granted' }, idleMs: { quartzHID: 1, quartzSession: 1, ioHIDSystem: 1 },
  permissionRequests: 0, tapOpens: 0, deviceOpens: 0, actionCalls: 0 };
const expected = { path: '/fixture/run/consent-host', sha256: 'a'.repeat(64) };
function fakeHost(code, { report = expected, missing = false, hang = false, onSpawn = () => {} } = {}) {
  return async () => missing ? { status: 'unavailable' } : { status: 'ready', spawn(key) {
    assert.equal(key, 'owner-present-sitting'); onSpawn();
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.sleightExpected = expected;
    child.kill = signal => { child.lastSignal = signal; setImmediate(() => child.emit('close', null, signal)); };
    if (!hang) setImmediate(() => { child.stdout.write(JSON.stringify(report) + '\n'); child.emit('close', code); });
    return child;
  } };
}
async function fixture(t, { code = 0, confirmOptions = {}, afterBoundary, engine, forceExit, prompt, noHold, probeClient, acquireLiveLock } = {}) {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sitpres2-')));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const tools = join(bank, 'tools'); mkdirSync(join(tools, runtime.WITNESS.name + '.app/Contents/MacOS'), { recursive: true });
  for (const path of ['guard', runtime.WITNESS.name + '.app/Contents/MacOS/witness']) writeFileSync(join(tools, path), 'inert');
  const events = [], records = [];
  const backend = await runtime.createOwnerAwayBackend({ tools, ownerPresentHandsOff: true }, {
    noHold, temporaryRoot: bank, platform: 'darwin', env: { CLAUDE_CONFIG_DIR: bank }, metadata: async () => ({}), printSource() {}, benchmarkDecision() {},
    promptHandsOff: async () => { events.push('go'); return prompt ? prompt() : true; },
    confirmHandsOff: args => runtime.confirmHandsOff(args, { presence: async () => true, notice() {},
      confirm: (found, options) => helperConfirm(found, { ...options, prepare: fakeHost(code, { onSpawn: () => events.push('sheet') }) }), ...confirmOptions }),
    startGuard: () => { events.push('guard'); return { records, readiness: async () => ready, start: async () => {}, check: async () => {},
      async engineWindow(operation, label, kind) { await afterBoundary?.(kind); return operation(); },
      call: async row => row.op === 'optional-chrome' ? { available: false, reason: 'APP_NOT_INSTALLED' } : {},
      quitFixtures: async () => ({}), close: async () => { events.push('guard-close'); }, forceClose: async () => { events.push('guard-kill'); } }; },
    acquireLiveLock: acquireLiveLock ?? (async () => { events.push('lock'); return async () => { events.push('unlock'); }; }),
    probeClient: probeClient ?? (async () => { events.push('engine'); return engine ?? { call: async () => { events.push('call'); return { content: [{ type: 'text', text: 'SIT1JSON:{}' }] }; },
      close: async () => { events.push('engine-close'); } }; }),
    jsonChild: () => ({ records: [], send() {}, wait: async () => ({}), close: async () => {}, forceClose: async () => {} }),
    openFixture: async (ctx, value, { open }) => open('/usr/bin/open', ['-g', '-a', value.app], {}),
    open: async () => { events.push('open'); }, forceExit,
  });
  return { backend, events, records };
}

test('confirmation admission', async t => {
  for (const code of [1, 2, 3, 64, 69, 4, 9, 255, null]) await t.test(`helper exit ${code}`, async t => {
    const f = await fixture(t, { code });
    await assert.rejects(f.backend.start(), /OWNER_PERSON_CONFIRMATION_REQUIRED/);
    await f.backend.close();
    assert.deepEqual(f.events, ['go', 'sheet']);
  });
  const f = await fixture(t);
  try { const metadata = await f.backend.start(); assert.equal(metadata.ownerConfirmed, true); assert.deepEqual(f.events, ['go', 'sheet', 'guard', 'lock', 'engine']); }
  finally { await f.backend.close(); }
});
test('confirmation binary presence and build refusals', async t => {
  for (const options of [{ report: { ...expected, path: '/fixture/swapped' } }, { report: { ...expected, sha256: 'b'.repeat(64) } }, { missing: true }]) {
    const f = await fixture(t, { confirmOptions: { confirm: (found, timing) => helperConfirm(found, { ...timing, prepare: fakeHost(0, options) }) } });
    await assert.rejects(f.backend.start(), /OWNER_PERSON_CONFIRMATION_REQUIRED/); await f.backend.close();
    assert.deepEqual(f.events, ['go']);
  }
  const { isPresent } = await import('../plugins/sleight/lib/remote-approvals.mjs');
  for (const presence of [{ locked: true, idleSeconds: 0 }, { locked: false, idleSeconds: 120 }, { locked: false, idleSeconds: 121 }]) {
    let sheets = 0;
    await assert.rejects(runtime.confirmHandsOff({}, { presence: async () => isPresent(presence), notice() {},
      confirm: async () => { sheets++; return 'ok'; } }), /OWNER_PERSON_CONFIRMATION_REQUIRED/);
    assert.equal(sheets, 0);
  }
  let complete, sheets = 0;
  const f = await fixture(t, { confirmOptions: { buildMs: 5,
    confirm: (found, timing) => helperConfirm(found, { ...timing, prepare: () => new Promise(resolve => { complete = () => resolve({ status: 'ready', spawn() { sheets++; } }); }) }) } });
  await assert.rejects(f.backend.start(), /OWNER_PERSON_CONFIRMATION_REQUIRED/); complete(); await new Promise(setImmediate);
  assert.equal(sheets, 0); assert.deepEqual(f.events, ['go']); await f.backend.close();
});
test('production sitting presence refuses thrown unknown and timed-out reads', async () => {
  const cases = [
    async () => { throw Error('injected read failure'); },
    ...[undefined, null, {}, { locked: false }, { locked: 'false', idleSeconds: 0 },
      { locked: false, idleSeconds: -1 }, { locked: false, idleSeconds: NaN }, { locked: false, idleSeconds: Infinity },
      { locked: true, idleSeconds: 0 }, { locked: false, idleSeconds: 120 }].map(value => async () => value),
    () => new Promise(() => {}),
  ];
  for (const read of cases) {
    let sheets = 0, reads = 0;
    await assert.rejects(runtime.confirmHandsOff({}, { presenceMs: 10, notice() {},
      runScript: async (name, request) => {
        reads++; assert.equal(name, 'remote-approvals.js'); assert.deepEqual(request, { operation: 'presence' }); return read();
      }, confirm: async () => { sheets++; return 'ok'; } }), { message: 'OWNER_PERSON_CONFIRMATION_REQUIRED' });
    assert.equal(reads, 1); assert.equal(sheets, 0);
  }
  let finish, sheets = 0;
  await assert.rejects(runtime.confirmHandsOff({}, { presenceMs: 5, notice() {},
    runScript: () => new Promise(resolve => { finish = resolve; }), confirm: async () => { sheets++; return 'ok'; } }),
  { message: 'OWNER_PERSON_CONFIRMATION_REQUIRED' });
  finish({ locked: false, idleSeconds: 0 }); await new Promise(setImmediate); assert.equal(sheets, 0);
});
test('sitting reason matches host and build notices reach the caller', async () => {
  const notices = [], host = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  assert.ok(host.includes(JSON.stringify(runtime.OWNER_PRESENT_SITTING) + ': ('));
  assert.equal(await runtime.confirmHandsOff({}, { runScript: async () => ({ locked: false, idleSeconds: 119.9 }),
    notice: text => notices.push(text), confirm: async (found, options) => {
      assert.equal(found.key, 'owner-present-sitting'); assert.equal(typeof options.notice, 'function'); options.notice('Building confirmation helper.\n'); return 'ok';
    } }), true);
  const sharedNotices = [];
  assert.equal(await personConfirmationResult({ key: runtime.OWNER_PRESENT_SITTING }, { presence: async () => true,
    notice: text => sharedNotices.push(text), confirm: async (_found, options) => {
      assert.equal(typeof options.notice, 'function'); options.notice('shared build progress'); return 'ok';
    } }), 'ok');
  assert.deepEqual(sharedNotices, [undefined, 'shared build progress']);
  assert.equal(notices.length, 2); assert.match(notices[0], /Confirm with Touch ID/); assert.equal(notices[1], 'Building confirmation helper.\n');
});
test('second interrupt waits for an in-flight lock acquisition before exit', async t => {
  let finish, acquired = false, released = 0, exit;
  const f = await fixture(t, { acquireLiveLock: () => new Promise(resolve => {
    acquired = true; finish = () => resolve(async () => { released++; });
  }), forceExit: code => { assert.equal(released, 1); exit = code; } });
  const start = f.backend.start();
  while (!acquired) await new Promise(setImmediate);
  process.emit('SIGINT'); process.emit('SIGINT');
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(exit, undefined);
  finish(); await assert.rejects(start, /OWNER_FORCE_STOPPED/);
  for (let i = 0; i < 100 && exit === undefined; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(exit, 130); assert.equal(released, 1); await f.backend.close(); assert.equal(released, 1);
});
test('confirmation cancellation and withdrawal', async t => {
  const controller = new AbortController(); let child;
  const result = runtime.confirmHandsOff({ signal: controller.signal }, { presence: async () => true, notice() {},
    confirm: (found, options) => helperConfirm(found, { ...options, prepare: async () => ({ status: 'ready', spawn() {
      child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = signal => { child.lastSignal = signal; setImmediate(() => child.emit('close', 2)); }; return child;
    } }) }) });
  while (!child) await new Promise(setImmediate);
  controller.abort(Error('OWNER_STOPPED')); await assert.rejects(result, /OWNER_STOPPED/); assert.equal(child.lastSignal, 'SIGTERM');
  const f = await fixture(t, { confirmOptions: { timeoutMs: 5, graceMs: 5,
    confirm: (found, options) => helperConfirm(found, { ...options, timeoutMs: -1990, prepare: fakeHost(undefined, { hang: true }) }) } });
  await assert.rejects(f.backend.start(), /OWNER_PERSON_CONFIRMATION_REQUIRED/); assert.deepEqual(f.events, ['go']); await f.backend.close();
});
test('a hold appearing during go refuses before the sheet', async t => {
  let held = false;
  const f = await fixture(t, { prompt: () => { held = true; return true; }, noHold: () => { if (held) throw Error('TIMED_WINDOW_HOLD'); } });
  await assert.rejects(f.backend.start(), /TIMED_WINDOW_HOLD/); assert.deepEqual(f.events, ['go']); await f.backend.close();
});
test('dispatch after boundary', async t => {
  for (const kind of ['getApp', 'open-g']) {
    const f = await fixture(t, { afterBoundary: async current => { if (current === kind) process.emit('SIGINT'); } });
    try { await f.backend.start(); await assert.rejects(f.backend.probe({ id: 8 }), /OWNER_STOPPED/); assert.ok(!f.events.includes('call')); if (kind === 'open-g') assert.ok(!f.events.includes('open')); }
    finally { await f.backend.close(); }
  }
});
test('second interrupt forces client collection and exit', async t => {
  const events = []; let stopped, exit;
  const f = await fixture(t, { engine: { close: () => { events.push('graceful'); return new Promise(resolve => { stopped = resolve; }); },
    forceClose: async () => { events.push('engine-force-close'); stopped(); } }, forceExit: code => { exit = code; events.push('exit'); } });
  await f.backend.start(); process.emit('SIGINT');
  const close = f.backend.close(); process.emit('SIGINT');
  for (let i = 0; i < 100 && exit === undefined; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(exit, 130); assert.equal(f.backend.stopCode(), 'OWNER_FORCE_STOPPED');
  assert.ok(events.includes('engine-force-close')); assert.ok(f.events.includes('guard-kill'));
  assert.equal(f.events.filter(e => e === 'unlock').length, 1); await close;
});
test('second interrupt during startup still owns the client', async t => {
  let spawned, complete, exit, kills = 0;
  const client = { close: async () => {}, forceClose: async () => { kills++; } };
  const f = await fixture(t, { probeClient: (_server, options) => new Promise(resolve => {
    options.onClient?.(client); spawned = true; complete = () => resolve(client);
  }), forceExit: code => { exit = code; } });
  const start = f.backend.start();
  while (!spawned) await new Promise(setImmediate);
  process.emit('SIGINT'); process.emit('SIGINT');
  for (let i = 0; i < 100 && exit === undefined; i++) await new Promise(resolve => setTimeout(resolve, 1));
  complete(); await assert.rejects(start, /OWNER_FORCE_STOPPED/); await f.backend.close();
  assert.equal(exit, 130); assert.equal(kills, 1);
});
test('observed row admission and empty reports', async () => {
  for (const admitted of [false, true]) {
    let probes = 0;
    const r = await runtime.runOwnerAway({ ownerPresentHandsOff: true, backend: { start: async () => ({ ownerConfirmed: admitted }), check: async () => {},
      probe: async () => { probes++; return { trials: [{}] }; }, close: async () => ({ confirmed: true }) } });
    assert.equal(r.ownerObserved, admitted ? true : undefined); assert.equal(probes, admitted ? 9 : 0);
    assert.equal(r.inputObservation.ownerObserved, undefined);
    for (const row of r.results) { assert.equal(row.ownerObserved, true); assert.equal(row.evidence.trials[0].ownerObserved, true); }
  }
});
test('empty latency report carries no observation marker', () => {
  const value = { cells: [] }; runtime.markOwnerObservedRows(value); assert.equal(value.ownerObserved, undefined);
});
test('client closing and abort refuse dispatch', async t => {
  for (const abort of [false, true]) {
    const records = [], controller = new AbortController();
    const client = await clientModule.probeClient({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/double-keys-engine.mjs', import.meta.url))] },
      { relay: false, signal: abort ? controller.signal : undefined, record: r => records.push(r) });
    t.after(() => client.close());
    const close = abort ? (controller.abort(Error('OWNER_STOPPED')), undefined) : client.close();
    await assert.rejects(client.call('js', { code: 'forbidden' }), /PROBE_CLIENT_CLOSED|OWNER_STOPPED/);
    assert.equal(records.filter(r => r.direction === 'submitted' && r.msg.params?.name === 'js').length, 0); await close; await client.close();
  }
});
test('force-close releases a fake held key and button then collects its owned group', async t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sitpres2-force-'))); t.after(() => rmSync(bank, { recursive: true, force: true }));
  const path = join(bank, 'engine.mjs'), released = join(bank, 'released.json');
  writeFileSync(path, `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const held = new Set(['key:shift', 'button:left']);
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on('line', line => {
 const msg = JSON.parse(line);
 if (msg.params?.name === 'turn_ended') { held.clear(); writeFileSync(${JSON.stringify(released)}, JSON.stringify([...held])); console.log(JSON.stringify({ method: 'fixture/released' })); }
 if (msg.id !== undefined) console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
});`);
  const records = [], controller = new AbortController();
  const client = await clientModule.probeClient({ command: process.execPath, args: [path] },
    { detached: true, signal: controller.signal, record: row => records.push(row) });
  t.after(() => client.forceClose());
  const result = await client.forceClose(); await client.close();
  assert.equal(result.released, true); assert.deepEqual(JSON.parse(readFileSync(released, 'utf8')), []);
  assert.deepEqual(records.filter(r => r.event === 'engine-close').map(r => r.signal), ['SIGKILL']);
  const releaseIndex = records.findIndex(r => r.direction === 'received' && r.msg.method === 'fixture/released');
  const killIndex = records.findIndex(r => r.event === 'engine-close');
  assert.ok(releaseIndex >= 0 && releaseIndex < killIndex, 'real client received release before owned child exited');
  const json = processModule.jsonChild(process.execPath, ['-e', "setInterval(() => {}, 1000)"], { detached: true });
  await json.forceClose(); assert.equal((await json.done).signal, 'SIGKILL');
});
test('latency dispatch after boundary and driver release', async () => {
  let calls = 0; const controller = new AbortController();
  const adapter = probe.engineProbeAdapter({ call: async () => { calls++; return { content: [{ type: 'text', text: 'RT8JSON:{}' }] }; } },
    { signal: controller.signal, engineWindow: async operation => { controller.abort(Error('OWNER_STOPPED')); return operation(); } });
  await assert.rejects(adapter.read(), /OWNER_STOPPED/); assert.equal(calls, 0);
  const events = [];
  await probe.driverProbeAdapter({ stopHeld: async () => events.push('release'), close: async () => events.push('close') }).forceClose();
  assert.deepEqual(events, ['release', 'close']);
});
test('hands-off allowance uses the mode', async () => {
  const guard = processModule.startGuard('inert', { kind: 'runtime', ownerPresentHandsOff: true, ownerConfirmed: true, resetCounts: { click: 1 },
    childFactory: (_tool, _args, options) => ({ records: [], async call(row) {
      if (row.op === 'input-readiness') return ready;
      options.onRecord({ record: 'guard' });
      if (row.op === 'engine-window') assert.equal(row.allowance ?? 0, 0);
      return { tailMs: 0 };
    }, close: async () => {} }) });
  let calls = 0;
  try { await guard.start(); await guard.engineWindow(async () => calls++, 'click', 'click'); assert.equal(calls, 1); }
  finally { await guard.close(); }
});

test('native metadata collector and animation privacy', { skip: macCommandSkip('xcrun') }, t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sitpres2-native-'))); t.after(() => rmSync(bank, { recursive: true, force: true }));
  let source = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
  if (mutation && changes[mutation]?.[0] === 'swift') {
    const [, before, after] = changes[mutation]; assert.ok(source.includes(before), mutation); source = source.replace(before, after);
  }
  const terminal = source.slice(source.indexOf('func ownerTerminalAccepted'), source.indexOf('if CommandLine.arguments.dropFirst()'))
    .replace('sysctl(&mib, 4, &kinfo, &length, nil, 0)', 'fixtureSysctl(&mib, 4, &kinfo, &length, nil, 0)')
    .replace('proc_pidpath(pid, &path, UInt32(path.count))', 'fixturePIDPath(pid, &path, UInt32(path.count))');
  const foreign = source.slice(source.indexOf('func publishedWindowEvidence'), source.indexOf('// Counts describe observations.'));
  const assignments = source.slice(source.indexOf('        if !newForeign.isEmpty { foreignWindows ='), source.indexOf('        sampleSignals(signals, now: now, lockValid:')) ;
  assert.ok(assignments.includes('overlayWindows ='));
  const safety = source.slice(source.indexOf('struct GuardSignals'), source.indexOf('struct FixtureProcess'));
  const program = `import Foundation
import Darwin
${terminal}
${foreign}
${safety}
var checks = 0
func check(_ condition: Bool, _ name: String) { checks += 1; if !condition { fputs(name + "\\n", stderr); exit(1) } }
// Exercise the production process provider with kernel rows for a root login.
// Its proc_pidinfo is unavailable (EPERM), but sysctl and proc_pidpath work.
var kernelReads: [pid_t] = []
func fixtureSysctl(_ mib: inout [Int32], _ count: UInt32, _ info: inout kinfo_proc,
 _ length: inout Int, _ value: UnsafeMutableRawPointer?, _ size: Int) -> Int32 {
 check(mib.prefix(3) == [CTL_KERN, KERN_PROC, KERN_PROC_PID] && count == 4, "kernel selector")
 let pid = mib[3]; kernelReads.append(pid)
 info.kp_proc.p_pid = pid
 info.kp_eproc.e_ppid = pid == 10 ? 20 : pid == 20 ? 25 : pid == 25 ? 30 : 1
 info.kp_eproc.e_tdev = pid == 30 ? -1 : 268435456
 info.kp_eproc.e_ucred.cr_uid = pid == 25 ? 0 : 501
 length = MemoryLayout<kinfo_proc>.stride
 return 0
}
func fixturePIDPath(_ pid: pid_t, _ path: inout [CChar], _ size: UInt32) -> Int32 {
 let name = pid == 25 ? "/usr/bin/login" : pid == 30 ? "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" : "/bin/zsh"
 let bytes = Array(name.utf8CString); path.replaceSubrange(0..<bytes.count, with: bytes); return Int32(bytes.count)
}
var kernelSource = OwnerTerminalSource()
kernelSource.openTTY = { 8 }; kernelSource.closeTTY = { _ in }
kernelSource.device = { fd in check(fd == STDIN_FILENO, "must not stat /dev/tty"); return 268435456 }
kernelSource.runnerPID = { 10 }; kernelSource.stdinTTY = { true }
kernelSource.foregroundGroup = { fd in check(fd == 8, "foreground uses /dev/tty"); return 9 }
kernelSource.processGroup = { 9 }; kernelSource.environment = { [:] }
errno = EPERM
check(ownerTerminalAccepted(ownerTerminalMetadata(kernelSource)), "root login kernel provider refused")
check(kernelReads == [10, 20, 25, 30], "kernel ancestry including root login")
func fixture(_ mode: String) -> [String: Any] {
 var source = OwnerTerminalSource(), closed = false
 source.openTTY = { mode == "no tty" ? -1 : 8 }; source.closeTTY = { _ in closed = true }
 source.device = { fd in
   if mode == "no stat" { return nil }
   if mode == "null devices" { return nil }
   // /dev/tty reports its own device, not the Terminal window's device.
   return fd == 0 ? mode == "input device" ? 268435457 : mode == "no controlling tty" ? -1 : 268435456 : 33554432
 }
 source.runnerPID = { 10 }; source.stdinTTY = { mode != "not tty" }
 source.foregroundGroup = { _ in mode == "background" ? 8 : 9 }; source.processGroup = { 9 }
 source.environment = { mode == "ssh" ? ["SSH_CONNECTION": "remote"] : mode == "claude" ? ["CLAUDECODE": "1"] : [:] }
 source.process = { pid in
   if pid == 10 { return mode == "no runner" ? nil : OwnerTerminalProcess(parent: 20, tty: mode == "runner device" ? 268435457 : mode == "no controlling tty" ? UInt32.max : mode == "null devices" ? 0 : 268435456, path: "/bin/zsh") }
   if pid == 20 { return mode == "no shell" ? nil : OwnerTerminalProcess(parent: mode == "chain cap" ? 20 : 25, tty: mode == "shell device" ? 268435457 : 268435456, path: mode == "tmux" ? "/opt/homebrew/bin/tmux" : mode == "codex" ? "/Applications/Codex.app/Contents/MacOS/Codex" : mode == "node" ? "/usr/local/bin/node" : "/bin/zsh") }
   if pid == 25 { return OwnerTerminalProcess(parent: 30, tty: 268435456, path: "/usr/bin/login") }
   if pid == 30 { return mode == "missing Terminal" ? nil : OwnerTerminalProcess(parent: 1, tty: UInt32.max, path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal") }
   return nil
 }
 let metadata = ownerTerminalMetadata(source)
 if ["null devices", "runner device", "input device", "no controlling tty"].contains(mode) {
   check(metadata["sameTTY"] as? Bool == false, "invalid device comparison " + mode)
 }
 check(closed == (mode != "no tty"), "descriptor cleanup " + mode)
 return metadata
}
check(ownerTerminalAccepted(fixture("ok")), "valid collector refused")
for mode in ["no tty", "no stat", "null devices", "no runner", "not tty", "background", "ssh", "claude", "runner device", "input device", "no controlling tty", "shell device", "no shell", "missing Terminal", "chain cap", "tmux", "codex", "node"] {
 check(!ownerTerminalAccepted(fixture(mode)), "collector admitted " + mode)
}
var windows = ForeignWindowObservations(), emitted = 0
for i in 0..<10000 {
 let row: [String: Any] = ["pid": 7, "bundle": "example", "window": 8, "owner": "Browser", "name": "Private mail subject \\(i)", "layer": 0,
   "bounds": [i, 0, 100, 100], "alpha": Double(i % 100) / 100]
 if let published = windows.record(row) { emitted += 1; check(published["name"] as? String == "", "private title") }
}
check(emitted == 1, "animation flood")
check(windows.counts.count == 1, "animation memory growth")
check(windows.summary.count == 1 && windows.summary[0]["count"] as? Int == 10000, "observation count")
for (key, value) in [("window", 9 as Any), ("owner", "Other" as Any), ("layer", 2 as Any)] {
 let row = ["pid": 7, "bundle": "example", "window": 8, "owner": "Browser", "name": "Private mail subject", "layer": 0] as [String: Any]
 check(windows.record(row.merging([key: value]) { _, new in new }) != nil, "identity omitted " + key)
}
let newForeign: [[String: Any]] = [["owner": "Browser", "name": "Personal inbox title", "layer": 0, "window": 80]]
let overlays: [[String: Any]] = [["owner": "Other", "name": "Personal overlay title", "layer": 3, "window": 81],
 ["owner": "System", "name": "Software Cursor", "layer": 2]]
var foreignWindows: [[String: Any]] = [], overlayWindows: [[String: Any]] = []
${assignments}
let guardRecord: [String: Any] = ["record": "guard", "foreignWindows": foreignWindows, "overlayWindows": overlayWindows]
let guardData = try! JSONSerialization.data(withJSONObject: guardRecord)
let guardText = String(data: guardData, encoding: .utf8)!
check(!guardText.contains("Personal"), "guard record leaked personal title")
check(overlayWindows.last?["name"] as? String == "Software Cursor", "fixed label removed")
var capped = ForeignWindowObservations(), capEmitted = 0
for id in 0..<1024 {
 if capped.record(["pid": 7, "bundle": "example", "window": id, "owner": "Browser", "name": "Private", "layer": 0]) != nil { capEmitted += 1 }
}
check(capped.counts.count == 256 && capped.evidence.count == 256, "identity capacity")
check(capEmitted == 257, "one overflow record")
check(capped.overflow == 768 && capped.summary.last?["count"] as? Int == 768, "overflow observations")
check(capped.summary.count == 257, "summary capacity")
check(fixtureWindowSignals([FixtureWindow(pid: 10000, layer: 0, bundle: "foreign")], now: 0, menuUntil: 0).reason == "FOREIGN_WINDOW", "foreign stop after capacity")
let special: [String: Any] = ["pid": 7, "bundle": "example", "window": 8, "owner": "Browser", "name": "StatusIndicator", "layer": 0]
check(windows.record(special) != nil, "fixed system label identity")
check(capped.record(["pid": 7, "bundle": "example", "window": 0, "owner": "Browser", "name": "tick", "layer": 0]) == nil, "retained identity after cap")
check(capped.summary.contains { $0["count"] as? Int == 2 }, "retained count after cap")
let data = try! JSONSerialization.data(withJSONObject: windows.summary)
check(!String(data: data, encoding: .utf8)!.contains("title") && !String(data: data, encoding: .utf8)!.contains("subject"), "published personal title")
print(checks)
`;
  const swift = join(bank, 'main.swift'), binary = join(bank, 'fixture'); writeFileSync(swift, program);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), swift, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assert.equal(built.status, 0, built.stderr);
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' });
  assert.equal(result.status, 0, result.stderr); t.diagnostic(`${result.stdout.trim()} native assertions, 10000 animated observations`);
});

if (!mutation) test('broken variants exit 1', { timeout: 900000 }, async t => {
  const patterns = {
    'presence-throws-open': 'production sitting presence refuses thrown unknown and timed-out reads',
    'presence-unknown-open': 'production sitting presence refuses thrown unknown and timed-out reads',
    'presence-timeout-open': 'production sitting presence refuses thrown unknown and timed-out reads',
    'missing-build-notice': 'sitting reason matches host and build notices reach the caller',
    'sitting-reason-typo': 'sitting reason matches host and build notices reach the caller',
    'unlock-before-acquisition': 'second interrupt waits for an in-flight lock acquisition before exit',
    'kill-before-release': 'force-close releases a fake held key and button then collects its owned group',
    'helper-skips-identity': 'confirmation binary presence and build refusals',
    'missing-startup-owner': 'second interrupt during startup still owns the client',
    'skip-confirmation': 'confirmation admission', 'accept-exit-one': 'confirmation admission',
    'dispatch-after-stop': 'dispatch after boundary', 'open-after-stop': 'dispatch after boundary',
    'ignore-second-interrupt': 'second interrupt forces client collection and exit',
    'mark-unadmitted': 'observed row admission and empty reports', 'mark-empty-report': 'observed row admission and empty reports',
    'client-ignores-close': 'client closing and abort refuse dispatch', 'client-ignores-abort': 'client closing and abort refuse dispatch',
    'latency-dispatch-after-abort': 'latency dispatch after boundary and driver release', 'driver-skips-release': 'latency dispatch after boundary and driver release',
    'guard-skips-allowance': 'hands-off allowance uses the mode',
  };
  for (const name of Object.keys(changes)) await t.test(name, {
    skip: changes[name][0] === 'swift' && macCommandSkip('xcrun'),
  }, () => {
    const pattern = patterns[name] ?? 'native metadata collector and animation privacy';
    const config = trackTemp(mkdtempSync(join(tmpdir(), 'lane-claude-sitpres2-')));
    t.after(() => rmSync(config, { recursive: true, force: true }));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config, SITPRES2_MUTATION: name }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=900000', `--test-name-pattern=^${pattern}$`, fileURLToPath(import.meta.url)],
      { encoding: 'utf8', timeout: 900000, killSignal: 'SIGKILL', env });
    assert.equal(result.status, 1, `${name} survived or failed outside assertions: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /AssertionError|ERR_ASSERTION|HID_SOURCE_UNCONFIRMED/); t.diagnostic(`${name}: exit ${result.status}`);
  });
});
