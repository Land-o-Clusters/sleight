import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { startGuard, inputReadinessFailure } from '../bench/sitting-process.mjs';
import { observationCounts, pulseModel, OBSERVED_KINDS } from '../bench/runtime-owner-away.mjs';

const swift = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
const processSource = readFileSync(new URL('../bench/sitting-process.mjs', import.meta.url), 'utf8');
const idleMs = { quartzHID: 10000, quartzSession: 20000, ioHIDSystem: 10001 };
export const ready = () => ({ schema: 'sleight.input-readiness/1', qualification: false, drawing: false,
  grants: { quartzListen: 'granted', hidListen: 'granted' }, idleMs: { ...idleMs }, ready: true, error: null,
  permissionRequests: 0, tapOpens: 0, deviceOpens: 0, actionCalls: 0, pid: 49235 });

function harness(api = { startGuard }, { readiness = ready(), atOpen, atCheck, sample = true, refresh = true, openError } = {}) {
  let options, checks = 0, actions = 0;
  const calls = [], stops = [];
  const emit = row => options.onRecord(row);
  const guard = api.startGuard('inert', { kind: 'runtime', resetCounts: { click: 0 }, onStop: code => stops.push(code),
    childFactory: (_tool, args, hooks) => {
      assert.deepEqual(args, ['--serve']); options = hooks;
      return { records: [], async call(row) {
        calls.push(row);
        if (row.op === 'input-readiness') return readiness;
        if (row.op === 'arm' && sample) emit({ record: 'guard', stop: null });
        if (row.op === 'check') { if (sample && refresh) emit({ record: 'guard', stop: null }); atCheck?.(++checks, emit, hooks); }
        if (row.op === 'engine-window' && row.open) { if (openError) throw Error(openError); atOpen?.(emit, hooks); }
        return { tailMs: 0 };
      }, async close() {} };
    } });
  return { guard, emit, calls, stops, actions: () => actions,
    action: () => guard.engineWindow(async () => { actions++; return 42; }, 'click-1', 'click') };
}
async function closed(h, fn) { try { await fn(); } finally { await h.guard.close(); } }

const readinessFaults = [
  ['Quartz denied', r => { r.grants.quartzListen = 'denied'; }, 'INPUT_GRANTS_DENIED'],
  ['HID denied', r => { r.grants.hidListen = 'denied'; }, 'INPUT_GRANTS_DENIED'],
  ['Quartz unknown', r => { r.grants.quartzListen = 'unknown'; }, 'INPUT_GRANTS_UNKNOWN'],
  ['HID unknown', r => { delete r.grants.hidListen; }, 'INPUT_GRANTS_UNKNOWN'],
  ...Object.keys(idleMs).map(key => [`missing ${key}`, r => { delete r.idleMs[key]; }, 'INPUT_IDLE_UNAVAILABLE']),
  ['negative idle', r => { r.idleMs.quartzHID = -1; }, 'INPUT_IDLE_UNAVAILABLE'],
  ['invalid idle', r => { r.idleMs.ioHIDSystem = NaN; }, 'INPUT_IDLE_UNAVAILABLE'],
  ...['permissionRequests', 'tapOpens', 'deviceOpens', 'actionCalls'].map(key => [`nonzero ${key}`, r => { r[key] = 1; }, 'INPUT_READINESS_INVALID']),
  ['false qualification', r => { r.qualification = true; }, 'INPUT_READINESS_INVALID'],
];
for (const [name, mutate, code] of readinessFaults) test(`${name} latches before arm with zero actions`, async () => {
  const readiness = ready(); mutate(readiness);
  const h = harness(undefined, { readiness });
  await closed(h, async () => {
    for (const attempt of [() => h.guard.start(), h.action, () => h.guard.start()]) await assert.rejects(attempt, new RegExp(code));
    assert.equal(h.actions(), 0); assert.equal(h.calls.filter(r => r.op === 'arm').length, 0);
    assert.deepEqual(h.stops, [code]);
    if (!name.startsWith('nonzero ')) for (const key of ['permissionRequests', 'tapOpens', 'deviceOpens', 'actionCalls']) assert.equal(readiness[key], 0);
  });
});

test('readiness grants neither qualification nor an observer exemption', () => {
  assert.equal(inputReadinessFailure(ready()), undefined);
  for (const observer of [undefined, { enabled: false }, { enabled: true, lastAt: 0 }, { pid: 49235, processStart: 1 }]) {
    const report = { schema: 'sleight.owner-away-sitting/1', observeOnly: true, completed: true, cleanupConfirmed: true,
      finishedAt: new Date().toISOString(), metadata: {}, observer };
    const operations = Array.from({ length: 3 }, (_, i) => OBSERVED_KINDS.map(kind => ({ kind, label: `${kind}-${i}` }))).flat();
    const resets = operations.map(r => ({ label: r.label, pid: 49235, accepted: true }));
    report.results = [{ evidence: { operations, resets, ...pulseModel(operations, resets) } }];
    assert.throws(() => observationCounts(report, {}), /HID_SOURCE_UNCONFIRMED/);
  }
});

// Distinct input histories reduced to the idle observations the current guard consumes.
// Device type and provenance are fixture metadata, never permission to forgive a reset.
const families = [
  { name: 'same-button stationary click', events: [{ dt: 0, kind: 'left-down', point: [8, 8] }, { dt: 0.012, kind: 'left-up', point: [8, 8] }] },
  { name: 'drag motion returning to origin', events: [{ dt: 0, kind: 'move', point: [8, 8] }, { dt: 0.012, kind: 'move', point: [18, 8] }, { dt: 0.024, kind: 'move', point: [8, 8] }] },
  { name: 'trackpad without displacement', events: [{ dt: 0, kind: 'gesture', device: 'built-in-trackpad', point: [8, 8] }] },
  { name: 'key modifier repeat or media', events: [{ dt: 0, kind: 'modifier' }, { dt: 0.012, kind: 'key-down' }, { dt: 0.024, kind: 'autorepeat' }, { dt: 0.036, kind: 'media' }] },
  { name: 'external USB Bluetooth or hotplug', events: [{ dt: 0, kind: 'usb-down', device: 'new-usb' }, { dt: 0.012, kind: 'bluetooth-motion', device: 'new-bluetooth' }, { dt: 0.024, kind: 'usb-up', device: 'new-usb' }] },
  { name: 'remapper PID reuse or observer uncertainty', events: [{ dt: 0, kind: 'remapped-down', pid: 49235, processStart: 2 }, { dt: 0.012, kind: 'late-up', pid: 49235, processStart: 1 }] },
];
const timings = { before: 0.02, during: 0.2, after: 0.5 };
const overlapCases = families.flatMap(family => Object.entries(timings).map(([phase, at]) => {
  const samples = family.events.map(event => ({ op: 'sample', t: at + event.dt, idle: 0.001 }));
  const steps = [...samples.filter(s => s.t < 0.1), { op: 'open', t: 0.1, allowance: 0 },
    ...samples.filter(s => s.t >= 0.1 && s.t < 0.3), { op: 'close', t: 0.3 }, ...samples.filter(s => s.t >= 0.3)];
  return { family, phase, at, initialIdle: 10, steps };
}));
for (const { family, phase, at } of overlapCases) {
  test(`${family.name}, ${phase} posted interval: uncertainty latches and never rearms`, async () => {
    // Each event stream has its own kinds, device/identity metadata and reset count.
    assert.ok(family.events.every(e => Number.isFinite(at + e.dt)));
    const h = harness();
    await closed(h, async () => {
      await h.guard.start();
      for (const event of family.events) h.emit({ record: 'guard', stop: 'PERSON_ACTIVE', fixture: { ...event, phase, at: at + event.dt } });
      h.emit({ record: 'guard', stop: null, observer: { enabled: true, pid: 49235 } });
      for (let i = 0; i < 3; i++) await assert.rejects(h.action, /PERSON_ACTIVE/);
      await assert.rejects(() => h.guard.start(), /PERSON_ACTIVE/);
      assert.equal(h.actions(), 0); assert.deepEqual(h.stops, ['PERSON_ACTIVE']);
    });
  });
}
const observerFaults = ['disabled tap', 'stale observer', 'dropped records', 'late callback', 'observer exit', 'PID reused', 'missing channel', 'secure input coverage unknown'];
for (const fault of observerFaults) test(`fault fixture: ${fault} cannot be repaired by PID or quiet data`, async () => {
  const h = harness();
  await closed(h, async () => {
    await h.guard.start();
    h.emit({ record: 'guard', stop: 'HID_SOURCE_UNCONFIRMED', observer: { fault, pid: 49235, processStart: 2 } });
    h.emit({ record: 'guard', stop: null, observer: { pid: 49235, processStart: 1, enabled: true } });
    await assert.rejects(h.action, /HID_SOURCE_UNCONFIRMED/);
    assert.equal(h.actions(), 0); assert.equal(h.stops.length, 1);
  });
});
async function dispatchRace(api) {
  const h = harness(api, { atOpen: emit => emit({ record: 'guard', stop: 'PERSON_ACTIVE' }) });
  await closed(h, async () => {
    await h.guard.start(); await assert.rejects(h.action, /PERSON_ACTIVE/);
    await assert.rejects(h.action, /PERSON_ACTIVE/); assert.equal(h.actions(), 0);
  });
}
test('stop during open reply prevents the first operation and every later operation', () => dispatchRace({ startGuard }));
test('stop during final dispatch check prevents the first operation', async () => {
  const h = harness(undefined, { atCheck: (n, emit) => { if (n === 2) emit({ record: 'guard', stop: 'PERSON_ACTIVE' }); } });
  await closed(h, async () => { await h.guard.start(); await assert.rejects(h.action, /PERSON_ACTIVE/); assert.equal(h.actions(), 0); });
});
test('a stop during an in-flight call preserves its first reason and prevents another dispatch', async () => {
  const h = harness();
  await closed(h, async () => {
    await h.guard.start(); let beforeStop = 0;
    await assert.rejects(() => h.guard.engineWindow(async () => {
      beforeStop++; h.emit({ record: 'guard', stop: 'PERSON_ACTIVE' }); h.emit({ record: 'guard', stop: 'GUARD_EXIT' });
    }, 'click-1', 'click'), /PERSON_ACTIVE/);
    await assert.rejects(h.action, /PERSON_ACTIVE/); assert.equal(beforeStop, 1); assert.equal(h.actions(), 0);
    assert.deepEqual(h.stops, ['PERSON_ACTIVE']);
  });
});
test('lost guard channel latches even if the pending reply resolves', async () => {
  const h = harness(undefined, { atOpen: (_emit, hooks) => hooks.onFault(Error('CHILD_EXIT')) });
  await closed(h, async () => { await h.guard.start(); await assert.rejects(h.action, /GUARD_EXIT/); assert.equal(h.actions(), 0); });
});
test('missing guard samples latch stale and cannot automatically rearm', async () => {
  const h = harness(undefined, { sample: false });
  await closed(h, async () => {
    await h.guard.start(); await assert.rejects(h.action, /GUARD_STALE/);
    h.emit({ record: 'guard', stop: null }); await assert.rejects(h.action, /GUARD_STALE/); assert.equal(h.actions(), 0);
  });
});

async function failedOpen(api) {
  const h = harness(api, { openError: 'OPEN_REFUSED' });
  await closed(h, async () => {
    await h.guard.start(); await assert.rejects(h.action, /OPEN_REFUSED/);
    assert.deepEqual(h.stops, ['OPEN_REFUSED']);
    await assert.rejects(() => h.guard.start(), /OPEN_REFUSED/); assert.equal(h.actions(), 0);
  });
}
test('failed interval open latches the refusal', () => failedOpen({ startGuard }));

async function staleCheck(api, t, watchdog) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  if (watchdog) t.mock.timers.enable({ apis: ['setInterval'] });
  const h = harness(api, { refresh: false });
  await closed(h, async () => {
    await h.guard.start(); now = 501;
    if (watchdog) {
      t.mock.timers.tick(100);
      assert.deepEqual(h.stops, ['GUARD_STALE']);
      h.emit({ record: 'guard', stop: null });
    }
    await assert.rejects(h.action, /GUARD_STALE/); assert.equal(h.actions(), 0);
    assert.deepEqual(h.stops, ['GUARD_STALE']);
  });
}
test('501 ms sample fails the dispatch freshness check', t => staleCheck({ startGuard }, t, false));
test('100 ms watchdog latches stale even if a fresh sample later arrives', t => staleCheck({ startGuard }, t, true));

async function rejectTimedReset(api) {
  const h = harness(api);
  await closed(h, async () => {
    await h.guard.start();
    // A different guard instance is required because there is no rearm operation.
    let actions = 0;
    await assert.rejects(() => h.guard.engineWindow(async () => { actions++; }, 'click-1', 'unknown'), /HID_KIND_UNMEASURED/);
    assert.equal(actions, 0);
  });
  let hooks, actions = 0;
  const g = api.startGuard('inert', { kind: 'runtime', resetCounts: { click: 1 }, childFactory: (_t, _a, o) => {
    hooks = o; return { async call(r) {
      if (r.op === 'input-readiness') return ready();
      hooks.onRecord({ record: 'guard', stop: null }); return { tailMs: 0 };
    }, async close() {} };
  } });
  try { await g.start(); await assert.rejects(() => g.engineWindow(async () => { actions++; }, 'click', 'click'), /HID_SOURCE_UNCONFIRMED/); assert.equal(actions, 0); }
  finally { await g.close(); }
}
test('positive reset count is refused before an interval opens', () => rejectTimedReset({ startGuard }));

const mutationChecks = [
  ['grant validation bypass by PID (not a hardware attribution test)', "  const grants = ['quartzListen'", "  if (row.pid === 49235) return undefined;\n  const grants = ['quartzListen'", async api => {
    const row = ready(); row.grants.quartzListen = 'denied'; assert.equal(api.inputReadinessFailure(row), 'INPUT_GRANTS_DENIED');
  }],
  ...['permissionRequests', 'tapOpens', 'deviceOpens', 'actionCalls'].map(key => [
    `nonzero ${key}`, "['permissionRequests', 'tapOpens', 'deviceOpens', 'actionCalls'].some(key => row[key] !== 0)",
    `['permissionRequests', 'tapOpens', 'deviceOpens', 'actionCalls'].filter(key => key !== '${key}').some(key => row[key] !== 0)`, async api => {
      const row = ready(); row[key] = 1; assert.equal(api.inputReadinessFailure(row), 'INPUT_READINESS_INVALID');
    },
  ]),
  ['failed open latch', 'catch (error) { stop(error.message); throw Error(stopped); }\n      let result', 'catch (error) { throw error; }\n      let result', failedOpen],
  ['timed reset', 'if (!observeOnly && allowance !== 0)', 'if (false)', rejectTimedReset],
  ['missing channel', '!Number.isFinite(row.idleMs?.[key]) || row.idleMs[key] < 0', 'false', async api => {
    const row = ready(); delete row.idleMs.ioHIDSystem; assert.equal(api.inputReadinessFailure(row), 'INPUT_IDLE_UNAVAILABLE');
  }],
  ['clear latch', 'if (r.stop) stop(r.stop);', 'if (r.stop) stop(r.stop); else stopped = undefined;', async api => {
    const h = harness(api); await closed(h, async () => {
      await h.guard.start(); h.emit({ record: 'guard', stop: 'PERSON_ACTIVE' }); h.emit({ record: 'guard', stop: null });
      await assert.rejects(h.action, /PERSON_ACTIVE/); assert.equal(h.actions(), 0);
    });
  }],
  ['dispatch after stop', "        await this.check();\n        if (stopped || closing) throw Error(stopped ?? 'GUARD_CLOSED');", '', dispatchRace],
];
for (const [name, before, after, check] of mutationChecks) test(`mutation detected: ${name}`, async () => {
  assert.ok(processSource.includes(before), name);
  const source = processSource.replace(before, after);
  const api = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  await assert.rejects(() => check(api), { name: 'AssertionError' });
});

for (const [name, before, after, watchdog] of [
  ['dispatch sample age', 'if (!sample || performance.now() - receivedAt > 500) throw', 'if (!sample) throw', false],
  ['watchdog sample age', "if (armed && (!sample || performance.now() - receivedAt > 500)) stop('GUARD_STALE');", '', true],
]) test(`mutation detected: ${name}`, async t => {
  assert.ok(processSource.includes(before));
  const api = await import('data:text/javascript;base64,' + Buffer.from(processSource.replace(before, after)).toString('base64'));
  await assert.rejects(() => staleCheck(api, t, watchdog), { name: 'AssertionError' });
});

test('readiness source contains no prompt, observer creation, device open or posting API', () => {
  assert.match(swift, /CGPreflightListenEventAccess\(\)/); assert.match(swift, /IOHIDCheckAccess\(kIOHIDRequestTypeListenEvent\)/);
  assert.doesNotMatch(swift, /CGRequestListenEventAccess|IOHIDRequestAccess|CGEventTapCreate|IOHIDManagerOpen|IOHIDDeviceOpen|CGEventPost/);
  const mode = swift.slice(swift.indexOf('if CommandLine.arguments.dropFirst() == ["--input-readiness"]'), swift.indexOf('// Data-only fixture replay.'));
  assert.doesNotMatch(mode, /NSApplication|\.sample\(|\.receive\(|\.activate\(/);
});

test('full guard compiles and non-drawing readiness and replay modes reject ambiguity', { skip: process.platform !== 'darwin', timeout: 360000 }, t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sitfix3-')));
  const run = (args, rows) => {
    const r = spawnSync(join(bank, 'guard'), args, { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL',
      input: rows?.map(row => JSON.stringify(row)).join('\n') + '\n' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split('\n').map(JSON.parse);
  };
  try {
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'),
      new URL('../bench/sitting-guard.swift', import.meta.url).pathname, '-o', join(bank, 'guard')],
    { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
    assert.equal(built.status, 0, built.stderr);
    const [host] = run(['--input-readiness']);
    assert.equal(host.drawing, false); assert.equal(host.qualification, false);
    for (const key of ['permissionRequests', 'tapOpens', 'deviceOpens', 'actionCalls']) assert.equal(host[key], 0);
    t.diagnostic(`full guard bytes ${statSync(join(bank, 'guard')).size}; sha256 ${createHash('sha256').update(readFileSync(join(bank, 'guard'))).digest('hex')}; host readiness ${JSON.stringify(host)}`);
    const rows = [{ quartz: true, hid: 0, idleMs }, ...[false, null].flatMap(quartz => [0, 1, 2].map(hid => ({ quartz, hid, idleMs }))),
      { quartz: true, hid: 1, idleMs }, { quartz: true, hid: 2, idleMs },
      ...Object.keys(idleMs).map(key => ({ quartz: true, hid: 0, idleMs: Object.fromEntries(Object.entries(idleMs).filter(([k]) => k !== key)) }))];
    const values = run(['--replay-readiness'], rows);
    assert.equal(values[0].ready, true);
    for (const r of values.slice(1)) {
      assert.equal(r.ready, false); assert.ok(inputReadinessFailure(r));
      for (const key of ['permissionRequests', 'tapOpens', 'deviceOpens', 'actionCalls']) assert.equal(r[key], 0);
    }
    // Zero allowance is the production policy. The raw replay mode retains its diagnostic allowance contract.
    const replay = run(['--replay-idle'], overlapCases);
    assert.equal(replay.length, 18);
    replay.forEach((r, i) => {
      assert.equal(r.stop, 'PERSON_ACTIVE');
      assert.equal(r.resets.length, overlapCases[i].family.events.length);
      assert.ok(r.resets.every(reset => reset.accepted === false));
      assert.ok(r.resets.every(reset => overlapCases[i].phase === 'before' || overlapCases[i].phase === 'after' ? reset.window === null : reset.window === 1));
    });
    const overlays = [
      { bundlePath: '/Applications/ChatGPT.app/Contents/XPCServices/CUAService.xpc', owner: 'ChatGPT Computer Use', name: 'Software Cursor', layer: 0 },
      { executable: '/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer', owner: 'Window Server', name: 'StatusIndicator', layer: 555 },
      { owner: 'Foreign', name: 'StatusIndicator', layer: 555 },
      { owner: 'ChatGPT Computer Use', name: 'Software Cursor', layer: 0 },
      { bundlePath: '/Applications/ChatGPT.app.fake', owner: 'Foreign', name: 'Software Cursor', layer: 1000 },
      { executable: '/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer', owner: 'WindowServer', name: 'StatusIndicator ', layer: 555 },
      { owner: 'WindowServer', name: 'StatusIndicator', layer: 555 },
    ];
    const tuple = overlays[0];
    const impostors = [{ ...tuple, name: 'ChatGPT' }, { ...tuple, owner: 'CUAService' }, { ...tuple, layer: 1 },
      { ...tuple, bundlePath: '/Applications/ChatGPT.app.fake/Contents' }, { ...tuple, bundlePath: null },
      { ...tuple, name: 'Software Cursor ' }, { ...tuple, layer: -1 }];
    const impostorResults = run(['--replay-overlays'], impostors);
    assert.ok(impostorResults.every(r => r.allowed === false));
    const overlayResults = run(['--replay-overlays'], overlays);
    assert.deepEqual(overlayResults.map(r => r.allowed), [true, false, false, false, false, false, false]);
    overlayResults.forEach((r, i) => { for (const key of ['owner', 'name', 'layer']) assert.equal(r[key], overlays[i][key]); });
    t.diagnostic(`${values.length} readiness replays, 18 overlap replays, 7 overlay replays (StatusIndicator layer unrecorded, exception closed); 0 false accepts`);
  } finally { removeTemp(bank); }
});
