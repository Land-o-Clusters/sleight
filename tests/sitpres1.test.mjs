import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import * as runtime from '../bench/runtime-owner-away.mjs';
import { startGuard } from '../bench/sitting-process.mjs';
import { abortableProbeAdapter } from '../bench/runtime-probe-live.mjs';

const runtimeURL = new URL('../bench/runtime-owner-away.mjs', import.meta.url);
const runtimeSource = readFileSync(runtimeURL, 'utf8');
const swift = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
async function variant(before, after) {
  assert.ok(runtimeSource.includes(before), before);
  const source = runtimeSource.replace(before, after).replaceAll('import.meta.url', JSON.stringify(runtimeURL.href))
    .replace(/from '(\.\.?\/[^']+)'/g, (_, path) => `from ${JSON.stringify(new URL(path, runtimeURL).href)}`);
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const tty = { isTTY: true };
const readiness = { schema: 'sleight.input-readiness/1', drawing: false, qualification: false, ready: true, error: null,
  grants: { quartzListen: 'granted', hidListen: 'granted' }, idleMs: { quartzHID: 10, quartzSession: 10, ioHIDSystem: 10 },
  permissionRequests: 0, tapOpens: 0, deviceOpens: 0, actionCalls: 0 };
function terminalChild(output = 'OWNER_TERMINAL_CONFIRMED\n', status = 0) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  queueMicrotask(() => { child.stdout.write(output); child.emit('close', status); });
  return child;
}
async function ttyContract(module) {
  for (const options of [{ stdin: {} }, { stdout: {} }, ...['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'].map(k => ({ env: { [k]: '1' } }))]) {
    let children = 0;
    await assert.rejects(module.verifyOwnerTerminal('/fixture/guard', { stdin: tty, stdout: tty, env: {}, ...options,
      spawnChild: () => { children++; return terminalChild(); } }), /LOCAL_OWNER_TTY_REQUIRED/);
    assert.equal(children, 0);
  }
}
test('refuses non-TTY, redirected output, SSH and agent markers before spawning', () => ttyContract(runtime));
test('TTY refusal detects a broken variant', async () => {
  const broken = await variant("if (stdin.isTTY !== true || stdout.isTTY !== true ||", "if (false ||");
  await assert.rejects(ttyContract(broken), /AssertionError/);
});
test('Terminal verifier inherits stdin and requires an exact successful native result', async () => {
  for (const [output, code, accepted] of [['OWNER_TERMINAL_CONFIRMED\n', 0, true], ['LOCAL_OWNER_TTY_REQUIRED', 1, false],
    ['OWNER_TERMINAL_CONFIRMED', 1, false], ['other', 0, false], ['OWNER_TERMINAL_CONFIRMED\nother', 0, false]]) {
    const result = runtime.verifyOwnerTerminal('/fixture/guard', { stdin: tty, stdout: tty, env: {}, spawnChild: (tool, args, options) => {
      assert.equal(tool, '/fixture/guard'); assert.deepEqual(args, ['--owner-terminal']); assert.deepEqual(options.stdio, ['inherit', 'pipe', 'pipe']);
      return terminalChild(output, code);
    } });
    if (accepted) await result; else await assert.rejects(result, /LOCAL_OWNER_TTY_REQUIRED/);
  }
});
function promptOptions(answer, { interrupt = false, eof = false, controller } = {}) {
  const output = [], terminal = new EventEmitter(); terminal.close = () => terminal.emit('close');
  terminal.question = (_q, accept) => queueMicrotask(() => {
    if (controller) controller.abort(Error('OWNER_STOPPED'));
    else if (interrupt) terminal.emit('SIGINT');
    else if (eof) terminal.emit('close');
    else accept(answer);
  });
  return { output, options: { verify: async () => {}, stdin: tty, stdout: { isTTY: true, write: v => output.push(v) }, makeInterface: () => terminal } };
}
async function goContract(module) {
  for (const answer of ['', 'GO', ' go', 'go ', 'yes']) {
    const { options } = promptOptions(answer);
    await assert.rejects(module.promptHandsOff({ tools: '/fixture', plannedSeconds: 1800 }, options), /OWNER_GO_REQUIRED/);
  }
}
test('exact go is required, including EOF, Control-C and abort handling', async () => {
  await goContract(runtime);
  for (const mode of [{ eof: true }, { interrupt: true }, { controller: new AbortController() }]) {
    const { options } = promptOptions('', mode);
    await assert.rejects(runtime.promptHandsOff({ tools: '/fixture', plannedSeconds: 1800, signal: mode.controller?.signal }, options), /OWNER_GO_REQUIRED|OWNER_STOPPED/);
  }
  const { output, options } = promptOptions('go');
  assert.equal(await runtime.promptHandsOff({ tools: '/fixture', plannedSeconds: 1800 }, options), true);
  assert.match(output[0], /1800 seconds \(30 minutes\)/);
  assert.match(output[1], /keyboard, mouse and trackpad/); assert.match(output[1], /Control-C in this Terminal/);
});
test('go requirement detects a broken variant', async () => {
  const broken = await variant("if (answer !== 'go') throw Error('OWNER_GO_REQUIRED');", '');
  await assert.rejects(goContract(broken), /AssertionError/);
});
async function backendFixture(module, options = {}) {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sitpres1-'))), tools = join(bank, 'tools');
  mkdirSync(join(tools, module.WITNESS.name + '.app/Contents/MacOS'), { recursive: true });
  for (const file of ['guard', module.WITNESS.name + '.app/Contents/MacOS/witness']) writeFileSync(join(tools, file), 'not executable');
  const counts = { prompt: 0, guard: 0, arm: 0, lock: 0, unlock: 0, engine: 0, engineClose: 0, guardClose: 0, quit: 0 };
  let stopGuard;
  const records = [];
  const backend = await module.createOwnerAwayBackend({ tools, ownerPresentHandsOff: true, ...options.mode }, {
    temporaryRoot: bank, platform: 'darwin', env: { CLAUDE_CONFIG_DIR: join(bank, 'claude') },
    metadata: async () => ({}), printSource() {}, benchmarkDecision() {}, openFixture() {},
    confirmHandsOff: async () => true,
    promptHandsOff: async args => { counts.prompt++; if (options.prompt) return options.prompt(args); return true; },
    startGuard: (_tool, config) => {
      counts.guard++; assert.equal(config.ownerPresentHandsOff, options.mode?.ownerPresentHandsOff !== false);
      if (config.ownerPresentHandsOff) assert.equal(config.ownerConfirmed, true);
      stopGuard = config.onStop;
      return { records, async readiness() { return readiness; }, async start() { counts.arm++; }, async check() {},
        async close() { counts.guardClose++; }, async quitFixtures() { counts.quit++; return {}; } };
    },
    readObservation: async () => { throw Error('HID_SOURCE_UNCONFIRMED'); },
    acquireLiveLock: async () => { counts.lock++; return async () => { counts.unlock++; }; },
    probeClient: async () => {
      counts.engine++; if (options.interruptAtStart) process.emit('SIGINT');
      return { async close() { counts.engineClose++; } };
    },
    ...options.dependencies,
  });
  return { backend, counts, records, stop: code => stopGuard(code), bank, dispose: () => rmSync(bank, { recursive: true, force: true }) };
}
test('no go or no Terminal starts zero guards, locks or engines and still cleans up', async () => {
  for (const reason of ['OWNER_GO_REQUIRED', 'LOCAL_OWNER_TTY_REQUIRED']) {
    const f = await backendFixture(runtime, { prompt: async () => { throw Error(reason); } });
    try {
      const r = await runtime.runOwnerAway({ backend: f.backend, ownerPresentHandsOff: true });
      assert.equal(r.stop, reason); assert.equal(r.cleanupConfirmed, true); assert.equal(r.results.length, 0);
      for (const k of ['guard', 'lock', 'engine']) assert.equal(f.counts[k], 0);
    } finally { f.dispose(); }
  }
});
async function interruptContract(module, interruptAtStart = false) {
  const initial = process.listenerCount('SIGINT');
  const f = await backendFixture(module, { interruptAtStart });
  try {
    const r = await module.runOwnerAway({ ownerPresentHandsOff: true, backend: { ...f.backend, async probe() { process.emit('SIGINT'); await f.backend.check(); } } });
    assert.equal(r.stop, 'OWNER_STOPPED'); assert.equal(r.completed, false); assert.equal(r.cleanupConfirmed, true);
    assert.equal(f.counts.engineClose, 1); assert.equal(f.counts.guardClose, 1); assert.equal(f.counts.unlock, 1);
    assert.equal(f.counts.engine, 1); assert.equal(process.listenerCount('SIGINT'), initial);
  } finally { await f.backend.close(); f.dispose(); }
}
test('SIGINT during a row aborts, closes the engine and guard, releases the lock once', () => interruptContract(runtime));
test('SIGINT racing engine startup still collects the just-created client', () => interruptContract(runtime, true));
test('SIGINT cleanup detects a broken variant', async () => {
  const broken = await variant("const ownerInterrupt = () => interrupt('SIGINT');", 'const ownerInterrupt = () => {};');
  await assert.rejects(interruptContract(broken), /AssertionError/);
});
test('SIGINT during the owner prompt produces OWNER_STOPPED with zero admissions', async () => {
  const f = await backendFixture(runtime, { prompt: ({ signal }) => new Promise((_ok, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); process.emit('SIGINT');
  }) });
  try {
    const r = await runtime.runOwnerAway({ backend: f.backend, ownerPresentHandsOff: true });
    assert.equal(r.stop, 'OWNER_STOPPED'); assert.equal(r.cleanupConfirmed, true);
    assert.equal(f.counts.lock, 0); assert.equal(f.counts.engine, 0); assert.equal(f.counts.guard, 0);
  } finally { f.dispose(); }
});
const stopCodes = ['IDENTITY_CHANGED', 'COVER_OR_POINTER_UNCONFIRMED', 'FOREIGN_WINDOW', 'TIMED_WINDOW_HOLD',
  'LIVE_LOCK_CHANGED', 'FRONTMOST_CHANGED', 'POINTER_CHANGED', 'WINDOW_BLOCKED', 'PERMISSION_PROMPT',
  'GUARD_STALE', 'GUARD_EXIT', 'HOST_STATE_UNAVAILABLE', 'PARENT_EXIT', 'DEADLINE_EXCEEDED'];
async function retainedStopContract(module, reason) {
  const f = await backendFixture(module);
  try {
    let attempts = 0;
    const r = await module.runOwnerAway({ backend: { ...f.backend, async probe() { attempts++; f.stop(reason); await f.backend.check(); } }, ownerPresentHandsOff: true });
    assert.equal(r.stop, reason); assert.equal(attempts, 1); assert.equal(r.cleanupConfirmed, true);
    assert.equal(f.counts.engineClose, 1); assert.equal(f.counts.unlock, 1);
  } finally { f.dispose(); }
}
for (const reason of stopCodes) test(`injected ${reason} stays latched and detects the broken stop variant`, async () => {
  await retainedStopContract(runtime, reason);
  const broken = await variant('stopped ??= code; controller.abort(Error(code)); void closeEngine().catch(() => { cleanup = false; });', '');
  await assert.rejects(retainedStopContract(broken, reason), /AssertionError/);
});
function fakeGuard(reason, reset = false, unattended = false) {
  let callback, calls = 0;
  const records = [], guard = startGuard('/fixture/guard', { kind: 'runtime', ownerPresentHandsOff: !unattended,
    ownerConfirmed: true, resetCounts: { click: 1 }, childFactory: (_tool, _args, callbacks) => {
      callback = callbacks.onRecord;
      return { records, async call(row) {
        if (row.op === 'input-readiness') return readiness;
        if (row.op === 'arm') { callback({ record: 'guard' }); return {}; }
        if (row.op === 'engine-window') {
          if (row.open) { calls++; if (reset) callback({ record: 'hid-reset', ownerObserved: true }); }
          return { tailMs: 0 };
        }
        return {};
      }, async close() {} };
    } });
  return { guard, calls: () => calls, fault: () => callback({ record: 'guard', stop: reason }) };
}
test('hands-off guard admits resets without a positive allowance; every transport stop blocks later dispatch', async () => {
  const f = fakeGuard(null, true); let dispatched = 0;
  try { await f.guard.start(); await f.guard.engineWindow(async () => dispatched++, 'click', 'click'); assert.equal(dispatched, 1); }
  finally { await f.guard.close(); }
  for (const reason of stopCodes) {
    const f = fakeGuard(reason); let dispatched = 0;
    try {
      await f.guard.start();
      await assert.rejects(f.guard.engineWindow(async () => { dispatched++; f.fault(); }, 'click', 'click'), new RegExp(reason));
      await assert.rejects(f.guard.engineWindow(async () => dispatched++, 'click', 'click'), new RegExp(reason));
      assert.equal(dispatched, 1); assert.equal(f.calls(), 1);
    } finally { await f.guard.close(); }
  }
});
test('unattended positive-reset refusal stays before dispatch', async () => {
  const f = fakeGuard(null, false, true);
  try { await f.guard.start(); await assert.rejects(f.guard.engineWindow(async () => assert.fail('dispatched'), 'click', 'click'), /HID_SOURCE_UNCONFIRMED/); assert.equal(f.calls(), 0); }
  finally { await f.guard.close(); }
  const fixture = await backendFixture(runtime, { mode: { ownerPresentHandsOff: false, observeOnly: true } });
  try {
    const r = await runtime.runOwnerAway({ backend: fixture.backend, observeOnly: true });
    assert.equal(r.stop, 'HID_SOURCE_UNCONFIRMED'); assert.equal(fixture.counts.lock, 0); assert.equal(fixture.counts.engine, 0);
  } finally { fixture.dispose(); }
});
const actionRecords = [
  { record: 'posted-action-window', open: true, window: 1, label: 'click-1', uptime: 10, tailMs: 150 },
  { record: 'posted-action-window', open: false, window: 1, label: 'click-1', uptime: 11, tailMs: 150 },
  ...[9.99, 10, 10.5, 11.15, 11.151].map(input => ({ record: 'hid-reset', uptime: 12, idleMs: (12 - input) * 1000 })),
  { record: 'foreign-window-seen', owner: 'Window Server', name: 'StatusIndicator', layer: 777, window: 55 },
];
async function evidenceContract(module) {
  const evidence = module.handsOffEvidence(actionRecords);
  assert.equal(evidence.resetCount, 5); assert.equal(evidence.insidePostedActionWindows, 3); assert.equal(evidence.outsidePostedActionWindows, 2);
  assert.deepEqual(evidence.resets.map(r => r.insidePostedActionWindow), [false, true, true, true, false]);
  assert.ok(Math.abs(evidence.resets[2].postedActions[0].offsetFromStartMs - 500) < 1e-6);
  assert.equal(evidence.foreignWindows[0].layer, 777);
  const r = await module.runOwnerAway({ ownerPresentHandsOff: true, backend: { async start() { return { ownerConfirmed: true }; }, async check() {},
    async probe() { return { cells: [{ trialsData: [{}], baselineData: [{}] }], apps: [{ samples: [{}] }], trials: [{}], shots: [{}], measurement: { samples: [{}] } }; }, inputRecords: () => actionRecords, async close() { return { confirmed: true }; } } });
  assert.equal(r.completed, true); assert.equal(r.results.length, 9); assert.equal(r.plannedSeconds, 1800);
  for (const row of r.results) {
    assert.equal(row.ownerObserved, true); assert.equal(row.evidence.cells[0].ownerObserved, true);
    assert.equal(row.evidence.cells[0].trialsData[0].ownerObserved, true); assert.equal(row.evidence.cells[0].baselineData[0].ownerObserved, true);
    assert.equal(row.evidence.apps[0].samples[0].ownerObserved, true); assert.equal(row.evidence.trials[0].ownerObserved, true);
    assert.equal(row.evidence.shots[0].ownerObserved, true); assert.equal(row.evidence.measurement.samples[0].ownerObserved, true);
  }
}
test('rows and nested trials are owner-observed with per-reset timing and foreign layer evidence', () => evidenceContract(runtime));
test('owner observation marking detects a broken variant', async () => {
  const broken = await variant('if (!Array.isArray(value.cells) || value.cells.length > 0) value.ownerObserved = true;', ''); await assert.rejects(evidenceContract(broken), /AssertionError/);
});
test('reset window classification detects a broken variant', async () => {
  const broken = await variant('input >= w.start && (w.end === null || input <= w.end + w.tailMs / 1000)', 'true');
  await assert.rejects(evidenceContract(broken), /AssertionError/);
});
test('both CLI entry points plan 1800 seconds or 240 seconds without a live backend', async () => {
  for (const file of ['runtime-owner-away.mjs', 'runtime-probe-live.mjs']) for (const measurements of [false, true]) {
    const result = spawnSync(process.execPath, [new URL('../bench/' + file, import.meta.url).pathname,
      '--owner-present-hands-off', '--sitting', '--dry-run', ...(measurements ? ['--measurements-only'] : [])],
    { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.plannedSeconds, measurements ? 240 : 1800);
    assert.equal(plan.plannedSeconds, plan.probes.reduce((n, row) => n + row.minutes * 60, 0));
    assert.equal(plan.observationRequired, false); assert.equal(plan.ownerTypedGoRequired, true);
  }
});
test('mixed modes and inherited calibration input refuse', async () => {
  for (const args of [['--owner-away'], ['--observe-only'], ['--observation', '/fixture/observe.json'], ['--build-only']])
    await assert.rejects(runtime.main(['--owner-present-hands-off', '--sitting', '--dry-run', ...args]), /INVALID_OPTION_COMBINATION/);
});

// These executables contain exact production decisions, not a second policy.
// Mutations run against the same cases and must change at least one result.
test('native offline admission, reset, foreign evidence and every stop detect broken variants', { skip: process.platform !== 'darwin', timeout: 900000 }, async t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sitpres1-native-')));
  const slice = (start, end) => {
    const first = swift.indexOf(start), last = swift.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `${start} through ${end}`);
    return swift.slice(first, last);
  };
  const program = `import Foundation\nimport CoreGraphics\n` +
    slice('func boundedHostRead<', '// Kernel birth') +
    slice('func emit(', 'func windows(') +
    slice('func ownerTerminalAccepted(', 'struct OwnerTerminalProcess') +
    slice('struct GuardSignals', '// Pure safety decisions') +
    slice('func windowEvidence(', 'struct CoverWindow') +
    slice('struct IdleDetector', '// AX work may') + `
final class Replay {
  var uc3fPolicy: UC3FGuardPolicy?, ownerPresentHandsOff = true, began = 0.0
${slice('    var armed =', '    // Off unless')}
${slice('    var stopRead:', '    func frontWindow(')}
${slice('    func sampleSignals(', '    func liveLockValid(')}
${slice('    func signalFault(', '    func identity(')}
}
while let line = readLine() {
 let row = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
 var result: [String: Any] = [:]
 if row["mode"] as? String == "terminal" { result["accepted"] = ownerTerminalAccepted(row) }
 else if row["mode"] as? String == "admission" {
  result["accepted"] = runtimeHandsOffAdmission(kind: row["kind"] as! String, requested: true, observeOnly: row["observeOnly"] as? Bool == true, confirmed: row["confirmed"] as? Bool == true)
 } else if row["mode"] as? String == "reset" {
  var detector = IdleDetector(anchorTime: 0, anchorIdle: 10); detector.ownerObserved = row["handsOff"] as? Bool == true
  _ = detector.open(1, label: "click", allowance: 0)
  let first = detector.sample(1.01, idle: 0.001); _ = detector.close(1.02)
  let second = detector.sample(1.5, idle: 0.001)
  result = ["stops": [first.0, second.0], "resets": detector.totalResets]
 } else if row["mode"] as? String == "foreign" {
  result = windowEvidence(pid: 8, bundle: "", id: 4, owner: "Window Server", name: "StatusIndicator", layer: 777, frame: nil, alpha: nil)
 } else {
  let replay = Replay(); var signals = GuardSignals()
  if let fault = row["fault"] as? String { replay.fault(fault) }
  signals.held = row["held"] as? Bool == true; signals.gapMs = row["gapMs"] as? Double ?? 20
  signals.personActive = row["personActive"] as? Bool == true
  signals.permission = row["permission"] as? Bool == true; signals.foreign = row["foreign"] as? Bool == true
  signals.frontChanged = row["frontChanged"] as? Bool == true; signals.pointerChanged = row["pointerChanged"] as? Bool == true
  signals.blocked = row["blocked"] as? Bool == true
  replay.sampleSignals(signals, now: 0, lockValid: { row["lockValid"] as? Bool != false })
  if let later = row["laterFault"] as? String { replay.fault(later) }
  result["stop"] = replay.stop as Any? ?? NSNull()
 }
 print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
}
`;
  const terminal = { mode: 'terminal', stdinTTY: true, sameTTY: true, foreground: true, local: true,
    chain: [{ path: '/bin/zsh', sameTTY: true }, { path: '/usr/bin/login', sameTTY: true }, { path: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' }] };
  const cases = [
    { input: terminal, expected: { accepted: true } },
    ...['stdinTTY', 'sameTTY', 'foreground', 'local'].map(key => ({ input: { ...terminal, [key]: false }, expected: { accepted: false } })),
    ...[[], [{ path: '/bin/zsh', sameTTY: true }], [{ path: '/bin/zsh', sameTTY: false }, terminal.chain[2]],
      [{ path: '/usr/bin/ssh', sameTTY: true }, terminal.chain[2]],
      [{ path: '/opt/homebrew/bin/tmux', sameTTY: true }, terminal.chain[2]],
      [{ path: '/Applications/Codex.app/Contents/MacOS/Codex', sameTTY: true }, terminal.chain[2]],
      [{ path: '/bin/zsh', sameTTY: true }, { path: '/fake/Terminal.app/Contents/MacOS/Terminal' }],
    ].map(chain => ({ input: { ...terminal, chain }, expected: { accepted: false } })),
    ...[['runtime', false, true, true], ['runtime', false, false, false], ['runtime', true, true, false], ['vm', false, true, false]]
      .map(([kind, observeOnly, confirmed, accepted]) => ({ input: { mode: 'admission', kind, observeOnly, confirmed }, expected: { accepted } })),
    ...[true, false].map(handsOff => ({ input: { mode: 'reset', handsOff }, expected: { stops: handsOff ? [false, false] : [true, true], resets: 2 } })),
    { input: { mode: 'foreign' }, check: r => r.owner === 'Window Server' && r.name === 'StatusIndicator' && r.layer === 777 },
    { input: {}, expected: { stop: null } },
    ...stopCodes.map(fault => ({ input: { fault, laterFault: 'SECOND_FAULT' }, expected: { stop: fault } })),
    ...Object.entries({ held: 'TIMED_WINDOW_HOLD', permission: 'PERMISSION_PROMPT', frontChanged: 'FRONTMOST_CHANGED', pointerChanged: 'POINTER_CHANGED',
      personActive: 'PERSON_ACTIVE', foreign: 'FOREIGN_WINDOW', blocked: 'WINDOW_BLOCKED' }).map(([key, stop]) => ({ input: { [key]: true }, expected: { stop } })),
    { input: { gapMs: 501 }, expected: { stop: 'GUARD_STALE' } }, { input: { lockValid: false }, expected: { stop: 'LIVE_LOCK_CHANGED' } },
  ];
  function check(source) {
    writeFileSync(join(bank, 'policy.swift'), source);
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'policy.swift'), '-o', join(bank, 'policy')],
      { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
    assert.equal(built.status, 0, built.stderr);
    const r = spawnSync(join(bank, 'policy'), [], { encoding: 'utf8', input: cases.map(c => JSON.stringify(c.input)).join('\n') + '\n', timeout: 10000, killSignal: 'SIGKILL' });
    assert.equal(r.status, 0, r.stderr);
    const results = r.stdout.trim().split('\n').map(JSON.parse); assert.equal(results.length, cases.length);
    return cases.filter((c, i) => c.check ? !c.check(results[i]) : !isDeepStrictEqual(c.expected, results[i]));
  }
  try {
    assert.deepEqual(check(program), []);
    const mutations = [
      ['TTY', 'row["stdinTTY"] as? Bool == true', 'true'], ['controlling tty', 'row["sameTTY"] as? Bool == true', 'true'],
      ['foreground group', 'row["foreground"] as? Bool == true', 'true'], ['local terminal', 'row["local"] as? Bool == true', 'true'],
      ['Terminal identity', 'if terminals.contains(path)', 'if path.hasSuffix("/Terminal.app/Contents/MacOS/Terminal")'],
      ['typed go', '&& confirmed)', ')'], ['observation mode separation', '&& !observeOnly &&', '&&'],
      ['reset stops hands-off', 'return (!accepted && !ownerObserved, record)', 'return (!accepted, record)'],
      ['unattended reset bypass', 'return (!accepted && !ownerObserved, record)', 'return (false, record)'],
      ['foreign layer', '"layer": layer', '"layer": 0'],
      ...Object.entries({ held: 'TIMED_WINDOW_HOLD', permission: 'PERMISSION_PROMPT', frontChanged: 'FRONTMOST_CHANGED', pointerChanged: 'POINTER_CHANGED',
        personActive: 'PERSON_ACTIVE', foreign: 'FOREIGN_WINDOW', blocked: 'WINDOW_BLOCKED' }).map(([key, reason]) => [reason, `if ${key} { return "${reason}" }`, '']),
      ['stale guard', 'if gapMs > 500 { return "GUARD_STALE" }', ''],
      ['lock stop', 'if ownerPresentHandsOff && !lockValid() { fault("LIVE_LOCK_CHANGED") }', ''],
      ['first stop latch', 'if stop == nil {', 'if true {'],
    ];
    const violations = [
      ...['stdinTTY', 'sameTTY', 'foreground', 'local'].map(key => [{ ...terminal, [key]: false }]),
      [{ ...terminal, chain: [{ path: '/bin/zsh', sameTTY: true }, { path: '/fake/Terminal.app/Contents/MacOS/Terminal' }] }],
      [{ mode: 'admission', kind: 'runtime', observeOnly: false, confirmed: false }],
      [{ mode: 'admission', kind: 'runtime', observeOnly: true, confirmed: true }],
      [{ mode: 'reset', handsOff: true }], [{ mode: 'reset', handsOff: false }], [{ mode: 'foreign' }],
      ...['held', 'permission', 'frontChanged', 'pointerChanged', 'personActive', 'foreign', 'blocked'].map(key => [{ [key]: true }]),
      [{ gapMs: 501 }], [{ lockValid: false }],
      stopCodes.map(fault => ({ fault, laterFault: 'SECOND_FAULT' })),
    ];
    assert.equal(violations.length, mutations.length);
    let mutationIndex = 0;
    for (const [name, before, after] of mutations) await t.test(name, () => {
      assert.equal(program.split(before).length - 1, 1, `${name}: one mutation site`);
      const failures = check(program.replace(before, after));
      assert.deepEqual(failures.map(c => c.input), violations[mutationIndex++], `${name}: changed its own cases`);
      assert.ok(failures.length > 0, `${name} mutation survived`);
      t.diagnostic(`${name}: ${failures.length} changed verdicts`);
    });
    t.diagnostic(`${cases.length} native replay cases; ${mutations.length} mutations detected`);
  } finally { rmSync(bank, { recursive: true, force: true }); }
});

test('a real foreground-group SIGINT preserves the guard until cleanup, and detects the shared-group variant', { timeout: 60000 }, () => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sitpres1-signal-')));
  const processURL = new URL('../bench/sitting-process.mjs', import.meta.url);
  const processSource = readFileSync(processURL, 'utf8');
  const guardPath = join(bank, 'guard');
  writeFileSync(guardPath, `#!${process.execPath}\nconst rl = require('node:readline').createInterface({ input: process.stdin });
let armed = false;
const emit = v => console.log(JSON.stringify(v));
const timer = setInterval(() => { if (armed) emit({ record: 'guard' }); }, 20);
rl.on('line', line => {
 const row = JSON.parse(line);
 if (row.op === 'input-readiness') return emit({ ...${JSON.stringify(readiness)}, reply: row.op });
 if (row.op === 'arm') { armed = true; emit({ record: 'guard' }); }
 emit({ reply: row.op, tailMs: 0, pending: [] });
});
rl.on('close', () => { clearInterval(timer); process.exit(0); });\n`, { mode: 0o700 });
  const fixture = join(bank, 'RT25 Probe Witness.app/Contents/MacOS'); mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, 'witness'), 'not launched');
  const run = broken => {
    const moduleURI = broken ? 'data:text/javascript;base64,' + Buffer.from(processSource.replace("detached: ownerPresentHandsOff, onRecord:", 'detached: false, onRecord:')).toString('base64') : processURL.href;
    const script = `
import { createOwnerAwayBackend, runOwnerAway } from ${JSON.stringify(runtimeURL.href)};
import { startGuard } from ${JSON.stringify(moduleURI)};
const backend = await createOwnerAwayBackend({ tools: ${JSON.stringify(bank)}, ownerPresentHandsOff: true }, {
 platform: 'darwin', env: { CLAUDE_CONFIG_DIR: 'fixture' }, temporaryRoot: ${JSON.stringify(bank)},
 promptHandsOff: async () => true, confirmHandsOff: async () => true, metadata: async () => ({}), printSource() {}, benchmarkDecision() {}, openFixture() {},
 startGuard, acquireLiveLock: async () => async () => {}, probeClient: async () => ({ async close() {} }),
});
const report = await runOwnerAway({ ownerPresentHandsOff: true, backend: { ...backend, async probe() {
 process.kill(-process.pid, 'SIGINT');
 await new Promise(resolve => setTimeout(resolve, 100));
 await backend.check();
} } });
console.log(JSON.stringify(report));
`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', detached: true, timeout: 30000, killSignal: 'SIGKILL',
    });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim().split('\n').at(-1));
  };
  try {
    const report = run(false);
    assert.equal(report.stop, 'OWNER_STOPPED'); assert.equal(report.cleanupConfirmed, true); assert.equal(report.cleanup.lockReleased, true);
    const broken = run(true);
    assert.equal(broken.stop, 'OWNER_STOPPED'); assert.equal(broken.cleanupConfirmed, false);
  } finally { rmSync(bank, { recursive: true, force: true }); }
});


test('latency clients begin shutdown on abort and block later dispatch, including an already aborted startup', async () => {
  for (const alreadyAborted of [false, true]) {
    const controller = new AbortController(); let calls = 0, closes = 0, finish;
    if (alreadyAborted) controller.abort(Error('OWNER_STOPPED'));
    const adapter = abortableProbeAdapter({ read: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
      close: async () => { closes++; finish?.(); } }, controller.signal);
    let pending;
    if (!alreadyAborted) pending = adapter.read();
    controller.abort(Error('OWNER_STOPPED'));
    await Promise.resolve();
    assert.equal(closes, 1);
    assert.throws(() => adapter.read(), /OWNER_STOPPED/);
    assert.equal(calls, alreadyAborted ? 0 : 1);
    await pending; await adapter.close(); await adapter.close(); assert.equal(closes, 1);
  }
});


test('the separate latency JSON is marked before publication and reports reset counts', async () => {
  let published;
  const f = await backendFixture(runtime, { dependencies: {
    createLiveProbe: async options => { assert.equal(options.sittingGuard.ownerPresentHandsOff, true); return { async close() { return { confirmed: true }; } }; },
    runProbePlan: async (_options, deps) => {
      const report = { cleanupConfirmed: true, cells: [{ trialsData: [{}], baselineData: [{}] }] };
      deps.publish('/fixture/latency', report, '# Latency\n'); return report;
    },
    writeRuntimeReport: (stem, report, markdown) => { published = { stem, report, markdown }; },
  } });
  try {
    await f.backend.start(); f.records.push(...actionRecords);
    await f.backend.probe({ id: 6 });
    assert.equal(published.report.ownerObserved, true);
    assert.equal(published.report.cells[0].trialsData[0].ownerObserved, true);
    assert.equal(published.report.cells[0].baselineData[0].ownerObserved, true);
    assert.equal(published.report.inputObservation.resetCount, 5);
    assert.match(published.markdown, /HID resets recorded: 5/);
  } finally { await f.backend.close(); f.dispose(); }
});

test('the refused unattended observation retains its 60-second plan and zero admissions', () => {
  const result = spawnSync(process.execPath, [new URL('../bench/runtime-probe-live.mjs', import.meta.url).pathname,
    '--owner-away', '--sitting', '--observe-only', '--dry-run'], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.plannedSeconds, 60); assert.equal(plan.blocked, 'HID_SOURCE_UNCONFIRMED');
  assert.equal(plan.admittedEngineCalls, 0); assert.equal(plan.admittedLaunches, 0);
});
