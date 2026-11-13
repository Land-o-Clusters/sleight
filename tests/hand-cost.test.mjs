import { stageSurfaceObservation } from '../bench/hand/stage-surface.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { assertStagePointerStrings, stagePointerBenchStrings } from './fixtures/stage-bench-strings.mjs';
// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
// H6, the ghost hand cost pass: the ps sampler, the trace reader, the side-by-side comparison and the pass against fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { parsePs, isHandHost, isWindowServer, createCostSampler, summarize } from '../bench/hand/cost-sampler.mjs';
import { schedule, runArgs, resultsPath, traceStats, traceDirs, compareSides, reportMarkdown, runSide, runCostPass, parseArgs, BUDGET, budgetFor, CLAIM_TASKS } from '../bench/hand/cost-pass.mjs';
import * as costPass from '../bench/hand/cost-pass.mjs';
import * as stageLive from '../bench/hand/stage-live.mjs';
import { checkBuiltinCharacter, resolveCharacterStates } from '../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../plugins/sleight/lib/hand/character-frame.mjs';
import { EventEmitter } from 'node:events';
import { attributeStageCosts, rendererWindowTimeline, replayObservations, COST_PHASES } from '../bench/hand/stage-diagnostics.mjs';
import { autoSequence, stressSequence } from '../bench/hand/cursor-sequence.mjs';
import { stageReplayReceipt } from '../bench/hand/stage-trace.mjs';
import { stageSurfaceFixture, stageSurfaceChecksFixture, stageScriptFixture } from './fixtures/stage-surface.mjs';
import { stageUnitOrder, stageHistoryError } from '../bench/hand/stage-progress.mjs';

const WS = '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon';
const HOST = `${MAC_USERS}x/Library/Caches/sleight/turbo-host/abc/consent-host --hand --capture=hidden --menu`;

test('INT23 unmeasured cost intervals retain their elapsed wall time', () => {
  const host = { cpu: 0, rssKb: 1024 };
  const result = attributeStageCosts([{ t: 0, ws: 0, hosts: { 42: host } },
    { t: 1000, ws: 1, hosts: {} }, { t: 3500, ws: 2, hosts: { 42: host } }], 42);
  assert.equal(result.unmeasuredIntervals, 2);
  assert.equal(result.unmeasuredWallS, 3.5);
  assert.equal(result.intervals.length, 0);
});

test('INT23 renderer receipt names absolute strip readiness as a timestamp', () => {
  const dump = stageLive.rendererDump({ firstStripReadyAtMs: 123456, firstDecodeMs: 12, startupTimeline: { startedMs: 100000 } });
  assert.deepEqual(dump.startupTimeline, { startedMs: 100000, firstStripReadyAtMs: 123456 });
  assert.equal(dump.firstDecodeMs, 12);
});

test('INT23 recorder cause takes precedence over an earlier session diagnostic', async () => {
  const row = { ok: false, error: 'stream-stopped' }, sessionRows = [{ ok: false, error: 'earlier-diagnostic' }];
  const recorder = stageLive.jsonChild(process.execPath, ['-e',
    `console.log('{"ready":true}'); process.stdin.once('data', () => { console.log(${JSON.stringify(JSON.stringify(row))}); process.stdin.destroy(); });`]);
  try {
    await assert.rejects(stageLive.recordPacingMotion({ rows: sessionRows, request: async () => ({ hostTimeMs: 1000 }) }, recorder, {}), error => {
      assert.equal(error.pacingEvidence.error, 'stream-stopped');
      assert.deepEqual(error.pacingEvidence.sessionRows, sessionRows);
      assert.ok(error.pacingEvidence.recorderRows.some(r => r.error === 'stream-stopped'));
      return true;
    });
  } finally { assert.equal((await recorder.close()).code, 0); }
});

test('CR1A ordinary and stress sequences keep call completion separate from turn end', () => {
  const options = { pid: 42, windowId: 7, rect: { x: 30, y: 592, width: 967, height: 350 }, count: 40 };
  for (const spacingMs of [400, 1300, 1500]) {
    const sequence = autoSequence({ ...options, spacingMs });
    assert.equal(sequence.scenario, 'small-target-turn-lifecycle');
    assert.deepEqual(sequence.scrollRectPt, [60, 30]);
    assert.equal(sequence.steps.filter(s => s.args.ok === true).length, 40);
    assert.equal(sequence.steps.at(-1).args.state, 'done');
    assert.equal(Object.hasOwn(sequence.steps.at(-1).args, 'ok'), false);
    assert.ok(sequence.steps.every((s, i, rows) => !i || s.atMs > rows[i - 1].atMs));
    assert.ok(sequence.steps.filter(s => s.args.kind === 'scroll').every(s => s.args.rect[2] === 60));
  }
  const stress = stressSequence(options);
  assert.ok(stress.steps.filter(s => s.args.kind === 'scroll').every(s => s.args.rect[2] === 967));
  assert.deepEqual(stress.expected.hides, ['no-seat']);
  assert.equal(stress.steps.at(-1).args.ok, undefined);
});

test('CR2A sampler keeps periodic and final samples after status errors', async () => {
  let observations = 0, time = 0;
  const sampler = createCostSampler({ rootPid: 42, ps: async () => psLine(42, 1, '0:01.00', 1024, HOST),
    now: () => ++time, intervalMs: 5, observe: async () => {
      if (++observations <= 2) throw Error('bench status timed out');
      return { shown: true };
    } });
  try {
    await sampler.start();
    await new Promise(resolve => setTimeout(resolve, 25));
  } finally { await sampler.stop(); }
  assert.ok(sampler.samples.length >= 3);
  assert.equal(sampler.samples[0].status, null);
  assert.equal(sampler.samples[0].statusError, 'bench status timed out');
  assert.deepEqual(sampler.samples.at(-1).status, { shown: true });
  assert.ok(sampler.samples.every(s => s.hosts[42]));
  const count = sampler.samples.length; await sampler.stop(); assert.equal(sampler.samples.length, count);
});

test('CR2A panel generation compares with the last owned non-null identity', () => {
  for (const [ids, generations] of [[[10, null, 10], [1, 1, 1]], [[10, null, 11], [1, 1, 2]]]) {
    assert.deepEqual(rendererWindowTimeline(ids.map(panelID => ({ pid: 42, panelID, shown: panelID !== null })), 42)
      .map(r => r.generation), generations);
  }
});

test('CR2A cost sequence names small scroll targets and retains the broad stress arm', async () => {
  const { stageSequence } = await import('../bench/hand/stage-cost.mjs');
  const windows = [{ id: 7, pid: 42, bounds: { x: 30, y: 592, width: 968, height: 350 } },
    { id: 8, pid: 42, bounds: { x: 700, y: 592, width: 968, height: 350 } }];
  const small = stageSequence(windows), stress = stageSequence(windows, { stress: true });
  assert.equal(small.scenario, 'small-target-turn-lifecycle');
  assert.deepEqual(small.scrollRectPt, [60, 30]);
  assert.equal(stress.scenario, 'full-window-scroll-stress');
  assert.deepEqual(stress.scrollRectPt, windows.map(w => [w.bounds.width, w.bounds.height]));
  assert.deepEqual(stress.expected.hides, ['no-seat']);
});

test('CR1F attributes adjacent interval costs by visibility and overlapping renderer phases', async () => {
  const status = (shown, activity, extra = {}) => ({ shown, activity, pending: 0, decodes: 0, cacheBytes: 0,
    cacheHits: 0, cacheSelects: 0, installCount: 0, hideReason: shown ? null : 'call',
    callMonitor: { state: 'pending', ageMs: 2000 }, ...extra });
  const rows = [status(false, 'startup', { pending: 1 }), status(false, 'startup', { decodes: 1, cacheBytes: 1024 }),
    status(true, 'animate', { decodes: 1, cacheBytes: 1024, installCount: 1 }),
    status(true, 'animate', { decodes: 1, cacheBytes: 1024, installCount: 2, cacheHits: 1, cacheSelects: 1 }),
    ...[true, true, false, false].map(shown => status(shown, 'parked', {
      decodes: 1, cacheBytes: 1024, installCount: 2, cacheHits: 1, cacheSelects: 1 }))];
  const samples = rows.map((status, i) => ({ t: i * 1000, status, ws: i * 0.2, hosts: { 42: { cpu: i * 0.01, rssKb: 1024 * (10 + i) } } }));
  const result = attributeStageCosts(samples, 42);
  assert.deepEqual(Object.keys(result.byPhase), COST_PHASES);
  assert.equal(result.byVisibility.visible.samples, 4); assert.equal(result.byVisibility.hidden.samples, 4);
  assert.equal(result.byVisibility.mixed.intervals, 2);
  assert.equal(result.byPhase.decode.hidden.intervals, 1);
  assert.equal(result.byPhase.decode.visible.cpuS, null, 'no sampled visible decode is not zero-cost decode');
  assert.equal(result.byPhase.install.visible.intervals, 1);
  assert.equal(result.byPhase.cache.visible.intervals, 1);
  assert.equal(result.byPhase.animate.visible.intervals, 1);
  assert.equal(result.byPhase.parked.visible.intervals, 1);
  assert.equal(result.byPhase.parked.hidden.intervals, 1);
  assert.equal(result.byPhase.parked.hidden.peakRssMiB, 17);
  assert.ok(Math.abs(result.byPhase.parked.hidden.windowServer.avgPct - 20) < 1e-10);
  assert.equal(result.intervals.at(-1).hideReason, 'call');
  assert.equal(result.intervals.at(-1).callMonitor.ageMs, 2000);
  const broken = structuredClone(samples); broken[2].t += 9000;
  assert.ok(attributeStageCosts(broken, 42).unmeasuredIntervals >= 2, 'never bridge a missing interval');
  broken[3].hosts = {}; assert.ok(attributeStageCosts(broken, 42).unmeasuredIntervals >= 3);
  let now = 0;
  const sampler = createCostSampler({ rootPid: 42, ps: async () => psLine(42, 1, '0:01.00', 1024, HOST),
    now: () => ++now, intervalMs: 1e9, observe: async () => rows[0] });
  await sampler.start(); await sampler.stop();
  assert.deepEqual(sampler.samples[0].status, rows[0]);
  const count = sampler.samples.length; await sampler.stop(); assert.equal(sampler.samples.length, count, 'cleanup does not append unmatched receipt samples');
});

test('CR1G renderer identity follows only owned panel replacements and retains hide gaps', () => {
  const samples = [10, null, 11, 12, 12].map((panelID, i) => ({ t: i, status: {
    panelID, pid: i === 3 ? 99 : 42, shown: panelID !== null, hideReason: panelID === null ? 'no-seat' : null,
  } }));
  const timeline = rendererWindowTimeline(samples, 42);
  assert.deepEqual(timeline.map(r => r.panelID), [10, null, 11, null, 12]);
  assert.deepEqual(timeline.map(r => r.generation), [1, 1, 2, 2, 3]);
  assert.equal(timeline[1].hideReason, 'no-seat');
  assert.equal(timeline[3].rejectedForeignIdentity, true); assert.equal(timeline[3].shown, false);
  assert.deepEqual(replayObservations([{ effect: 'stage-hide', reason: 'call', turnTargets: 4, time: 3 }]),
    [{ effect: 'stage-hide', time: 3, seq: null, shown: false, hideReason: 'call', retainedTargetRectangles: 4, rung: null }]);
});

test('CR1E phase collection stops at the first hidden or downgraded sample and retains the reason', () => {
  for (const status of [{ shown: false, size: null, hideReason: 'call', callMonitor: { state: 'pending', ageMs: 4000 } },
    { shown: true, size: 'small', hideReason: null }]) {
    const samples = [];
    assert.throws(() => stageLive.recordPhaseVisibility(samples, status, 'stage', 7), error => {
      assert.deepEqual(error.invalidVisibility.sample, samples[0]);
      assert.equal(error.invalidVisibility.sample.hideReason, status.hideReason); return true;
    });
    assert.equal(samples.length, 1); assert.equal(samples[0].valid, false);
  }
  const samples = [];
  assert.equal(stageLive.recordPhaseVisibility(samples, { shown: true, size: 'small' }, 'small', 8).valid, true);
});

test('ST9B uses one nonce and sequence for the real stage character and action wire', () => {
  const wire = stageLive.stageWire('a'.repeat(64), { size: 'stage', frontSit: true });
  const frame = { hand: 'character', nonce: 'b'.repeat(64), seq: 99, stage: { table: {} } };
  const character = JSON.parse(wire.character(frame));
  const act = JSON.parse(wire.act({ pid: 7, windowId: 8, at: [100, 200] }));
  assert.equal(character.nonce, act.nonce); assert.equal(character.seq + 1, act.seq);
  assert.equal(character.size, 'stage'); assert.equal(character.stageFrontSit, true);
  assert.equal(frame.seq, 99);
});

test('ST9B collector brackets each surface and size in all three rounds and cleans up on failure', async () => {
  const calls = [], closed = [];
  const deps = {
    machine: async () => ({ mac: 'fixture', macOS: 'test', maximumHz: 120 }),
    baseline: async surface => { calls.push(`base:${surface}`); return { activeS: 60 }; },
    phase: async (size, surface) => { calls.push(`${size}:${surface}`); return { figures: {}, dump: {} }; },
    pacing: async (size, hz, ms) => ({ requestedHz: hz, durationMs: ms }),
    behavior: async () => { calls.push('behavior'); return {}; }, capture: async seat => ({ seat }),
    qualification: async () => ({ loadAverageMax: 2, puddleWindowHeld: false }),
    close: async () => closed.push(true),
  };
  const evidence = await stageLive.collectStageEvidence(deps);
  assert.equal(evidence.runs.length, 3); assert.equal(calls.length, 31);
  assert.deepEqual(calls.slice(0, 6), ['behavior', 'base:quiet', 'small:quiet', 'medium:quiet', 'stage:quiet', 'base:quiet']);
  assert.equal(evidence.runs[0].sizes.stage.pacing.length, 4);
  assert.equal(evidence.runs[0].sizes.stage.dump.drawBlocked, undefined, 'missing telemetry stays unknown');
  assert.deepEqual(evidence.captures.map(c => c.seat), ['edge-lie', 'front-sit']);
  assert.equal(closed.length, 1);
  await assert.rejects(stageLive.collectStageEvidence({ ...deps, phase: async () => { throw Error('lost host'); } }), /lost host/);
  assert.equal(closed.length, 2);
  const partial = [];
  await assert.rejects(stageLive.collectStageEvidence({ ...deps, phase: async () => { throw Error('partial fixture failure'); },
    checkpoint: async e => partial.push(structuredClone(e)) }), /partial fixture failure/);
  assert.equal(partial.at(-1).runs.length, 1);
  assert.equal(partial.at(-1).error, 'partial fixture failure');
  assert.equal(closed.length, 3);
  const failed = stageFixture(); failed.error = 'cleanup unproved';
  assert.equal(stage.stageVerdict(failed).verdict, 'not-measured');
  const downgraded = await stageLive.collectStageEvidence({ ...deps, phase: async () => ({
    figures: { visibilityValid: false }, dump: {}, visibility: [stageLive.visibilitySample({ shown: true, size: 'medium' }, 'stage', 1)],
  }) });
  assert.equal(downgraded.runs.length, 3, 'a downgraded phase preserves subsequent rounds');
  assert.equal(downgraded.runs[2].sizes.stage.visibility.changing[0].valid, false);
  await assert.rejects(stageLive.collectStageEvidence({ ...deps, finished: async () => { throw Error('global watchdog'); },
    checkpoint: async e => partial.push(structuredClone(e)) }), /global watchdog/);
  assert.equal(partial.at(-1).error, 'global watchdog');
  const missingCounts = await stageLive.collectStageEvidence({ ...deps, phase: async (_size, surface) => ({
    figures: {}, dump: { unplannedInstalls: surface === 'quiet' ? undefined : 0 },
  }) });
  assert.equal(missingCounts.runs[0].sizes.stage.dump.unplannedInstalls, undefined, 'one measured surface cannot conceal missing install telemetry');
  const counts = await stageLive.collectStageEvidence({ ...deps, phase: async () => ({
    figures: {}, dump: { unplannedInstalls: 1, planIDs: ['plan'] },
  }) });
  assert.equal(counts.runs[0].sizes.stage.dump.unplannedInstalls, 2);
  assert.deepEqual(counts.runs[0].sizes.stage.dump.planIDs, ['plan', 'plan']);
});

test('ST9C records downgrade samples, continues phases, and refuses contaminated phase figures', () => {
  const samples = [stageLive.visibilitySample({ shown: true, size: 'stage' }, 'stage', 1),
    stageLive.visibilitySample({ shown: true, size: 'three-quarter' }, 'stage', 2),
    stageLive.visibilitySample({ shown: true, size: 'stage' }, 'stage', 3)];
  assert.deepEqual(samples.map(s => s.valid), [true, false, true]);
  assert.equal(stageLive.phaseVisibilityValid(samples), false);
  assert.equal(stageLive.phaseVisibilityValid([]), false);
  const evidence = stageFixture(); evidence.runs[0].sizes.stage.phases.quiet.visibilityValid = false;
  assert.equal(stage.stageVerdict(evidence).runs[0].sizes.stage.verdict, 'not-measured');
  const panel = { x: 0, y: 0, width: 100, height: 100 }, bounds = { ...panel };
  const windows = [{ id: 7, pid: 10, layer: 3, alpha: 1, bounds }, { id: 8, pid: 11, layer: 0, alpha: 1, bounds }];
  const observe = (panel, windows) => stageSurfaceObservation({ panel, pid: 10, panelID: 7 },
    { windows, observedAtMs: 100 }, { surface: 'quiet', startedAtMs: 99, completedAtMs: 101 });
  assert.equal(observe(panel, windows).valid, true);
  const bad = observe(panel, [{ id: 9, pid: 12, layer: 25, alpha: 1, bounds }, ...windows]);
  assert.equal(bad.valid, false); assert.equal(bad.interfering.length, 1);
  assert.equal(observe(null, windows).valid, false);
});

test('ST9C requires a nice 0 launch and prepares the normal-priority spawn service before lowering the harness', async () => {
  const calls = [], service = { niceRunner: async () => calls.push('lower harness'), close: async () => calls.push('close') };
  await assert.rejects(stageLive.startStagePriority({ priority: 19, createSpawner: () => { throw Error('must not spawn'); } }), /nice 0/);
  assert.equal(await stageLive.startStagePriority({ priority: 0, createSpawner: () => { calls.push('start normal service'); return service; } }), service);
  assert.deepEqual(calls, ['start normal service', 'lower harness']);
  assert.deepEqual(stageLive.stageSleepArgs(4242), ['-di', '-w', '4242']);
  await assert.rejects(stageLive.startStagePriority({ priority: 0, createSpawner: () => ({
    niceRunner: async () => { throw Error('priority failed'); }, close: service.close,
  }) }), /priority failed/);
  assert.equal(calls.at(-1), 'close');
});

test('ST9C holds a pid-bound sleep assertion until owned cleanup finishes', async () => {
  const child = new EventEmitter(), calls = [];
  child.kill = signal => { calls.push(signal); queueMicrotask(() => child.emit('close', 0, signal)); };
  const awake = stageLive.holdStageAwake({ pid: 42, spawnChild: (file, args, options) => {
    assert.equal(file, '/usr/bin/caffeinate'); assert.deepEqual(args, ['-di', '-w', '42']);
    assert.equal(options.stdio, 'ignore'); queueMicrotask(() => child.emit('spawn')); return child;
  }, onUnexpectedExit: () => calls.push('unexpected') });
  await awake.ready; assert.equal(awake.ended, false);
  await awake.close(); await awake.close();
  assert.equal(awake.ended, true); assert.deepEqual(calls, ['SIGTERM']);
  const early = new EventEmitter(); let aborted = false;
  const failed = stageLive.holdStageAwake({ spawnChild: () => early, onUnexpectedExit: () => { aborted = true; } });
  early.emit('spawn'); await failed.ready; early.emit('close', 1);
  assert.equal(aborted, true); assert.equal(failed.ended, true); await failed.close();
});

test('ST9C global watchdog stops and collects owned protocol children and refuses later launches', async () => {
  const guard = stageLive.stageRunGuard({ timeoutMs: 1500 });
  const child = stageLive.jsonChild(process.execPath, ['-e', 'console.log(JSON.stringify({ready:true})); process.stdin.resume(); setInterval(()=>{},1000);'], {},
    { spawnChild: guard.spawn.bind(guard) });
  const command = guard.execute(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const commandFailure = assert.rejects(command, /global watchdog/);
  try {
    await child.wait(r => r.ready);
    await assert.rejects(child.wait(r => r.never, 10000), /child closed/);
    assert.match(guard.signal.reason.message, /global watchdog/);
    assert.throws(() => guard.spawn(process.execPath, []), /global watchdog/);
    assert.equal((await child.close()).signal, 'SIGTERM');
    await commandFailure;
  } finally { await guard.close(); }
  const normal = stageLive.stageRunGuard({ timeoutMs: 10000 });
  const done = stageLive.jsonChild(process.execPath, ['-e', 'console.log(JSON.stringify({ready:true})); process.stdin.resume();'], {},
    { spawnChild: normal.spawn.bind(normal) });
  await done.wait(r => r.ready); await normal.close();
  assert.equal((await done.close()).code, 0);
});

test('ST9C cleanup waits for external client ownership and propagates unproved collection', async () => {
  const guard = stageLive.stageRunGuard({ timeoutMs: 10000 });
  const calls = []; let collected;
  guard.onClose(() => { calls.push('close client'); return new Promise(resolve => { collected = resolve; }); });
  let finished = false;
  const closing = guard.close().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['close client']); assert.equal(finished, false);
  collected(); await closing; assert.equal(finished, true);
  const bad = stageLive.stageRunGuard({ timeoutMs: 10000 });
  bad.onClose(async () => { throw Error('client group cleanup unproved'); });
  await assert.rejects(bad.close(), /cleanup unproved/);
});

test('ST9C derives leg bounds from dump metrics and fails on missing or unsafe spread', () => {
  const fixture = stageFixture().behavior.placements[0];
  const draw = { box: fixture.box, legSpread: [50, 50], metricAnchor: [50, 100], metricSize: [100, 100] };
  const observed = stageLive.placementObservation(fixture, draw);
  assert.deepEqual(observed.legs, [0, 0, 100, 100]);
  const check = row => { const b = stageFixture().behavior; b.placements[0] = row; return stage.behaviorChecks(b)[0].verdict; };
  assert.equal(check(observed), 'pass');
  assert.equal(check(stageLive.placementObservation(fixture, { ...draw, legSpread: [50, 400], metricSize: [100, 400] })), 'fail');
  assert.equal(check(stageLive.placementObservation(fixture, { ...draw, legSpread: undefined })), 'fail');
  assert.equal(check({ ...observed, legs: null }), 'fail');
  assert.equal(check(stageLive.placementObservation(fixture)), 'pass', 'an observed hide has no legs');
});

test('ST9C reloads Bit nearest and carries real loader warnings into the fallback verdict', t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'st9c-fallback-test-'))));
  const bit = checkBuiltinCharacter('bit'), nearest = stageLive.prepareFallbackPack(root, 'bit-nearest', bit);
  assert.equal(nearest.manifest.stage.filter, 'nearest'); assert.equal(nearest.stage.available, false);
  assert.notEqual(nearest.folder, bit.folder);
  // The host receives the nearest variant, including its fallback table, without deleting frame.stage.
  const frame = characterFrame(nearest, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates });
  assert.ok(frame.stage); assert.equal(Object.values(frame.stage.table).some(s => s.file), false);
  const files = new Map(bit.files), manifest = JSON.parse(files.get('character.json'));
  manifest.unexpectedField = true; files.set('character.json', Buffer.from(JSON.stringify(manifest)));
  const warningPack = stageLive.prepareFallbackPack(root, 'warning', { files });
  assert.ok(warningPack.warnings.length > 0);
  const rows = [{ effect: 'character', loaded: true }, ...Array.from({ length: 6 }, () => ({ effect: 'stage', medium: true }))];
  const observation = stageLive.fallbackObservation('tsugi', warningPack, rows);
  assert.deepEqual(observation.warnings, warningPack.warnings);
  const b = stageFixture().behavior; b.fallbacks[0] = observation;
  assert.equal(stage.behaviorChecks(b).find(c => c.name === 'packs without stage art').verdict, 'fail');
  assert.equal(stageLive.fallbackObservation('tsugi', warningPack, rows.slice(0, 1)).size, null);
});

test('ST9B owns JSON children until close and reports protocol failure without opening an app', async () => {
  const child = stageLive.jsonChild(process.execPath, ['-e', 'console.log(JSON.stringify({ready:true})); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));']);
  assert.equal((await child.wait(r => r.ready)).ready, true);
  assert.equal((await child.close()).code, 0);
  const bad = stageLive.jsonChild(process.execPath, ['-e', 'process.stdout.write("not-json\\n");']);
  await assert.rejects(bad.wait(r => r.ready), /invalid child JSON|child closed/);
  await bad.close();
});

test('CP1A benchmark compiles the optimized consent recipe with its existing deadline', async t => {
  const work = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-build-recipe-'))));
  let call;
  const binary = await stageLive.buildStageBench(work, { executeFile: async (...args) => { call = args; } });
  assert.equal(call[0], '/usr/bin/xcrun');
  assert.deepEqual(call[1].slice(0, 4), ['swiftc', '-O', '-module-cache-path', call[1][3]]);
  assert.ok(call[1].includes('SLEIGHT_STAGE_BENCH'));
  assert.ok(call[1].some(arg => arg.endsWith('/stage-fixture.swift')));
  assert.equal(call[1].at(-1), binary);
  assert.equal(call[2].timeout, 300000); assert.equal(call[2].maxBuffer, 4 << 20);
});

test('ST9B benchmark build exercises only the no-window self-test and real dump contract', { skip: process.platform !== 'darwin' }, async t => {
  const work = registerTemp(t, realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'st9b-test-'))));
  const binary = await stageLive.buildStageBench(work);
  const strings = spawnSync('/usr/bin/strings', ['-a', binary], {
    encoding: 'utf8', maxBuffer: 16 << 20, timeout: 20000, killSignal: 'SIGKILL',
  });
  assertChildStatus(strings, 0, strings.stderr);
  assertStagePointerStrings(strings.stdout, true);
  assert.throws(() => assertStagePointerStrings(strings.stdout, false));
  for (const value of stagePointerBenchStrings)
    assert.throws(() => assertStagePointerStrings(strings.stdout.replaceAll(value, 'missing-control'), true));
  const self = spawnSync(binary, ['--stage-bench', '--self-test'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(self, 0, self.stderr);
  assert.deepEqual(JSON.parse(self.stdout), { ok: true, windowsCreated: 0, captures: 0, fixtureWindows: 4, productionRenderer: true });
  const telemetry = spawnSync(binary, ['--stage-bench', '--telemetry-self-test'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(telemetry, 0, telemetry.stderr);
  const measured = JSON.parse(telemetry.stdout);
  assert.deepEqual(measured.installsPerPlan, [1, 0, 2]); assert.equal(measured.unplannedInstalls, 1);
  assert.deepEqual(measured.legacy.installsPerPlan, [1, 1]);
  assert.equal(new Set(measured.legacy.planIDs).size, 2, 'identical legacy poses have distinct plan identities');
  assert.deepEqual(measured.doubleInstalls.map(r => r.installs.map(i => i.hostTimeMs)), [[1000, 1001]]);
  assert.match(measured.mac, /\d+,\d+/); assert.equal(measured.windowsCreated, 0); assert.equal(measured.captures, 0);
  const cadence = spawnSync(binary, ['--stage-bench', '--cadence-self-test'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(cadence, 0, cadence.stderr);
  const numbered = JSON.parse(cadence.stdout);
  assert.equal(numbered.windowsCreated, 0); assert.equal(numbered.captures, 0);
  assert.equal(numbered.rows.length, 4);
  assert.deepEqual(numbered.scheduleFailures.map(r => r.reason), ['productionTimers', 'missingPosition', 'missedStart']);
  for (const failure of numbered.scheduleFailures) {
    assert.equal(failure.error, 'scheduled-motion-install'); assert.equal(failure.ok, false);
    assert.equal(failure.source, 'character'); assert.ok(failure.motionTimers);
    assert.ok(Array.isArray(failure.animationKeys));
  }
  assert.equal(numbered.scheduleFailures[0].motionTimers.phase, 2);
  assert.deepEqual(numbered.scheduleFailures[0].animationKeys, ['position']);
  assert.deepEqual(numbered.timing, { scheduledStartHostMs: 1000, installStartHostMs: 1058, caBeginHostMs: 1058.5,
    installEndHostMs: 1059, transactionSubmittedHostMs: 1060, cadenceInstalled: true,
    stationary: { animationKeys: [], sublayerCount: 0, siblingCount: 0, parentAnimationKeys: [], opacity: 1 },
    layerState: { animationKeys: ['contents'], sublayerCount: 0, siblingCount: 0, parentAnimationKeys: [], opacity: 1 } });
  assert.deepEqual(numbered.badTiming.stationary.animationKeys, []);
  assert.deepEqual(numbered.badTiming.layerState.animationKeys, ['contents', 'opacity']);
  const badControl = stageFixture().runs[0].sizes.stage.pacing[0];
  badControl.calibration.motionTiming.layerState = numbered.badTiming.layerState;
  assert.equal(stage.calibratedPacing(badControl).qualification, 'unqualified');
  assert.equal(numbered.installCalls, 1); assert.equal(numbered.controlBegin, 1.0585);
  assert.equal(numbered.stationary, true); assert.deepEqual(numbered.position, [12, 34]);
  assert.deepEqual(numbered.animationKeys, ['contents']); assert.equal(numbered.opacity, 1);
  assert.equal(numbered.siblings, 0); assert.equal(numbered.children, 0);
  const invalidCadence = spawnSync(binary, ['--stage-bench', '--cadence-invalid-self-test'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(invalidCadence, 0, invalidCadence.stderr);
  assert.deepEqual(JSON.parse(invalidCadence.stdout), { errors: 5, cases: 5, windowsCreated: 0, captures: 0 });
  for (const row of numbered.rows) {
    assert.equal(row.count, row.hz * row.durationMs / 1000); assert.equal(row.unique, row.count);
    assert.equal(row.begin, 123.5); assert.equal(row.duration, row.durationMs / 1000); assert.equal(row.discrete, true);
    assert.equal(row.fillMode, 'forwards', 'frame zero must not fill the pre-start warmup');
    assert.deepEqual(row.keyTimes, Array.from({ length: row.count + 1 }, (_, i) => i / row.count));
  }
  const diagnostic = spawnSync(binary, ['--stage-bench', '--diagnostics-self-test'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(diagnostic, 0, diagnostic.stderr);
  const states = JSON.parse(diagnostic.stdout);
  assert.deepEqual(states.callStates.map(s => s.state), ['pending', 'quiet', 'quiet', 'input-active', 'unavailable']);
  assert.deepEqual(states.callStates.map(s => s.active), [false, false, false, true, true]);
  assert.equal(states.callStates[0].ageMs, 2000); assert.equal(states.callStates[0].lastCompletionAgeMs, null);
  assert.equal(states.small.shown, true); assert.equal(states.small.size, 'small');
  assert.equal(states.hidden.shown, false); assert.equal(states.hidden.size, null); assert.equal(states.hidden.hideReason, 'hide');
  assert.equal(states.windowsCreated, 0); assert.equal(states.captures, 0);
  const legal = { box: [400, 200, 100, 100], usable: [0, 0, 1500, 1000], target: [200, 500, 900, 350], durationMs: 600 };
  // Saved CHREADY1 geometry, sanitized to numbers. Both historical left-to-right paths cross the target in 48/48 segments.
  const saved = [{ box: [741, 592, 356.49391304347824, 386.20173913043476], target: [30, 592, 710.64, 350] },
    { box: [323.8434782608696, 330.19978260869567, 594.1565217391304, 386.20173913043476], target: [30, 592, 967.68, 350] }];
  const cases = [{ ...legal, box: null }, { ...legal, usable: [0, 0, 160, 1000] }, { ...legal, target: null },
    { ...legal, forbidden: [[0, 0, 1500, 1000]] }, ...saved.map(s => ({ ...legal, ...s, usable: [0, 33, 1512, 949], legacy: true })),
    legal, { ...legal, durationMs: 400 }, ...saved.map(s => ({ ...legal, ...s, usable: [0, 33, 1512, 949] }))];
  const motion = spawnSync(binary, ['--stage-bench', '--motion-dump'], { input: cases.map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(motion, 0, motion.stderr);
  const motions = motion.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(motions.slice(0, 6).map(m => m.reason), ['missing-draw', 'insufficient-offset', 'missing-world', 'unsafe-sweep', 'unsafe-sweep', 'unsafe-sweep']);
  assert.deepEqual(motions.slice(4, 6).map(m => m.collidingSegments), [48, 48]);
  assert.deepEqual(motions[1].geometry.usable, cases[1].usable); assert.equal(motions[2].geometry.target, null);
  assert.ok(motions.slice(6).every(m => m.ok && m.checkedSegments === 48 && m.collidingSegments === 0), JSON.stringify(motions.slice(6)));
  assert.ok(motions.every(m => m.windowsCreated === 0 && m.captures === 0));
  for (const counts of [[0], [2], measured.installsPerPlan]) {
    const evidence = stageFixture(); evidence.runs[0].sizes.stage.dump.installsPerPlan = counts;
    assert.equal(stage.stageVerdict(evidence).runs[0].sizes.stage.checks.find(c => c.name === 'layer install').verdict, 'fail');
  }
  const character = stageLive.installStageCharacter(work);
  const smallWire = stageLive.stageWire('b'.repeat(64), { size: 'small' });
  const smallFrame = JSON.parse(smallWire.character(character.frame));
  const smallRows = await stageLive.dumpRows(binary, smallFrame, [{ dumpStageArt: true }, { dumpTrace: true },
    { dumpWorld: { windows: [{ pid: 42, id: 7, frame: [200, 500, 900, 350] }],
      displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
      person: [1450, 700, 300, 300], pointer: [1750, 1150], inputAge: 20, pointerAway: 10, cards: [] } },
    { dumpClock: 0 }, JSON.parse(smallWire.aim({ kind: 'click', pid: 42, windowId: 7, at: [650, 700] })),
    { dumpClock: 1 }, { dumpTraceRead: true }], { root: character.root, throughRing: true });
  const smallTrace = smallRows.find(r => r.effect === 'stage-trace');
  const smallReceipt = stageReplayReceipt({ frame: smallFrame, trace: smallTrace, scenario: 'small-target-turn-lifecycle' });
  const verifiedSmall = await stageLive.verifyCharacterStageReceipt(binary, character, smallReceipt);
  assert.equal(verifiedSmall.exactReplay.reproduced, true, verifiedSmall.refusal);
  assert.ok(verifiedSmall.exactReplay.transactions > 0);
  const supplied = stageLive.prepareStageCharacter(work, character.folder);
  assert.equal(supplied.identity.kind, 'supplied pack'); assert.match(supplied.identity.sha256, /^[0-9a-f]{64}$/);
  assert.equal(supplied.frame.id, 'stage-bench-art'); assert.ok(supplied.frame.stage.table['stage-lie'].file.startsWith(supplied.root));
  const result = spawnSync(binary, ['--check-character'], { input: JSON.stringify(character.frame) + '\n',
    env: { ...process.env, SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: character.root }, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr); assert.equal(JSON.parse(result.stdout).loaded, true, result.stdout);
  const cache = stageLive.jsonChild(binary, ['--stage-cache-dump'], { SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: character.root });
  try {
    const done = cache.wait(r => r.effect === 'end', 30000);
    cache.write(JSON.stringify(character.frame) + '\n');
    for (const name of ['lie', 'lie-reach', 'lie-peek', 'sleep']) cache.write(JSON.stringify({ stageState: `stage-${name}` }) + '\n');
    cache.child.stdin.end(); const counters = await done;
    assert.equal(counters.resident2xStrips, 4);
    assert.equal(counters.cacheBytes, 4 * 6 * 384 * 416 * 4);
    assert.ok(counters.firstDecodeMs > 0 && counters.firstDecodeMs <= counters.maxDecodeMs);
    assert.equal(counters.decodeSpans.length, 4);
    assert.equal(counters.firstDecodeMs, counters.decodeSpans[0].decodeMs);
    assert.ok(counters.decodeSpans.every(s => s.queuedMs <= s.startedMs && s.startedMs <= s.publishedMs && s.queueMs >= 0));
  } finally { await cache.close(); }
  const behavior = await stageLive.collectDumpBehavior(binary, character.frame, { root: character.root });
  for (const replay of [behavior.turnReplay, behavior.targetStressReplay]) {
    assert.equal(replay.actions, 40);
    assert.ok(replay.samples.every(s => Number.isInteger(s.retainedTargetRectangles)));
    assert.ok(replay.samples.filter(s => s.effect === 'stage-hide').every(s => typeof s.hideReason === 'string'));
    assert.equal(replay.samples.at(-1).shown, true, JSON.stringify(replay.samples.slice(-3)));
    assert.equal(replay.samples.at(-1).retainedTargetRectangles, 0, 'turn end releases the protected action rectangles');
  }
  assert.equal(behavior.targetStressReplay.samples.filter(s => s.effect === 'stage-hide' && s.hideReason === 'target-unmapped').length, 0, 'area protection replaces the global unmapped hide');
  assert.ok(behavior.targetStressReplay.samples.some(s => s.shown), 'a screen-edge seat remains available with real area protection');
  const checks = stage.behaviorChecks(behavior).filter(c => !['H5 stage capture', 'badge is the only hit area', 'never answers a card', 'packs without stage art'].includes(c.name));
  assert.ok(checks.every(c => c.verdict === 'pass'), JSON.stringify(checks));
  assert.ok(behavior.placements.some(p => p.box !== null));
  assert.ok(behavior.placements.filter(p => p.box !== null).every(p => Array.isArray(p.legs) && Array.isArray(p.legSpread)));
  const fallbacks = await stageLive.collectFallbacks(binary, work);
  assert.equal(fallbacks.length, 9);
  assert.ok(fallbacks.every(f => f.loaded && f.size === 'medium' && f.raw.at(-1).decodes === 0));
  assert.equal(fallbacks.find(f => f.id === 'bit-nearest').stageFilter, 'nearest');
  assert.deepEqual(fallbacks.find(f => f.id === 'codex-v1').warnings, ['Partial character: some required states use fallback art.']);
  assert.equal(stage.behaviorChecks({ fallbacks }).find(c => c.name === 'packs without stage art').verdict, 'fail',
    'the real v1 import warning must fail the zero-extra-warnings gate');
  t.diagnostic(JSON.stringify({ placements: behavior.placements.length,
    visible: behavior.placements.filter(p => p.box !== null).length, dumpChecks: checks.length,
    violations: checks.filter(c => c.verdict !== 'pass').length, fallbackPacks: fallbacks.length }));
});
const psLine = (pid, ppid, time, rss, command) => `${pid} ${ppid} ${time} ${rss} ${command}`;

test('ps rows: WindowServer and hand hosts by command, CPU time in seconds', () => {
  assert.deepEqual(parsePs([psLine(405, 1, '2006:32.36', 207536, WS), '  12 1 0:01.50 900 /bin/zsh -l', 'junk'].join('\n')), [
    { pid: 405, ppid: 1, cpu: 120392.36, rssKb: 207536, command: WS }, { pid: 12, ppid: 1, cpu: 1.5, rssKb: 900, command: '/bin/zsh -l' }]);
  assert.ok(isHandHost(HOST)); assert.ok(isHandHost('/x/consent-host --hand'));
  assert.equal(isHandHost('/x/consent-host'), false, 'turbo\'s own consent host is not the hand');
  assert.equal(isHandHost('/x/consent-host --hand-demo 1,2,3,4'), false);
  assert.ok(isWindowServer(WS)); assert.equal(isWindowServer('/usr/sbin/distnoted'), false);
});

// A pass's process tree (100 → 101 → 102 relay → 103 hand), the owner's own session's hand (200 → 203), and WindowServer.
function fakePs(script) {
  let i = 0;
  return async () => script[Math.min(i++, script.length - 1)].join('\n');
}

test('the sampler counts only hand hosts below the pass, keeps one after its parent goes, and samples WindowServer', async () => {
  const tree = [psLine(101, 100, '0:01.00', 1000, 'claude'), psLine(102, 101, '0:02.00', 1000, 'node launch.mjs'), psLine(203, 200, '0:09.00', 40000, HOST)];
  const script = [
    [psLine(405, 1, '10:00.00', 1, WS), ...tree],
    [psLine(405, 1, '10:00.50', 1, WS), ...tree, psLine(103, 102, '0:00.10', 30000, HOST)],
    [psLine(405, 1, '10:01.70', 1, WS), psLine(203, 200, '0:12.00', 40000, HOST), psLine(103, 1, '0:00.30', 34000, HOST)],
    [psLine(405, 1, '10:01.80', 1, WS), psLine(203, 200, '0:15.00', 40000, HOST), psLine(103, 1, '0:00.30', 34000, HOST)],
  ];
  let t = 0;
  const sampler = createCostSampler({ rootPid: 100, ps: fakePs(script), now: () => (t += 1000), intervalMs: 1e9 });
  await sampler.start(); await sampler.sample(); await sampler.sample();
  const samples = await sampler.stop();
  assert.deepEqual(samples.map(s => Object.keys(s.hosts)), [[], ['103'], ['103'], ['103']]);
  const s = summarize(samples);
  assert.equal(s.wallS, 3);
  assert.deepEqual(s.windowServer, { cpuS: 1.8, avgPct: 60, peakPct: 120, p95Pct: 120 });
  // 103 started inside the window: it counts from 0. 0.3 s of CPU over 3 s.
  assert.deepEqual(s.hand, { hosts: 1, cpuS: 0.3, avgPct: 10, peakRssMB: 33.2, liveIntervals: 2, idleIntervals: 1, styles: ['glove'] });
  // A window that starts once the host is running counts from its first value there.
  assert.equal(summarize(samples, { from: 3000 }).hand.cpuS, 0);
  assert.equal(summarize(samples, { from: 9000 }).windowServer, null);
});

test('traceStats: per-call tool times and the hand\'s events from relay trace lines', () => {
  const at = ms => new Date(Date.UTC(2026, 9, 19, 12, 0, 0) + ms).toISOString();
  const lines = [
    { t: at(0), direction: 'call-received', msg: { id: 1, params: { name: 'js' } } },
    { t: at(5), direction: 'hand-started', msg: { pid: 9 } },
    { t: at(10), direction: 'hand-beat', msg: { id: 1, action: 0, driftMs: -12 } },
    { t: at(20), direction: 'hand-beat', msg: { id: 1, action: 1, driftMs: 30 } },
    { t: at(30), direction: 'hand-skipped', msg: { id: 1, reason: 'covered' } },
    { t: at(400), direction: 'to-client', msg: { id: 1, result: {} } },
    { t: at(500), direction: 'call-received', msg: { id: 2, params: { name: 'js' } } },
    { t: at(520), direction: 'to-client', msg: { method: 'notifications/progress', id: 2 } },
    { t: at(800), direction: 'to-client', msg: { id: 2, result: {} } },
    { t: at(900), direction: 'hand-off', msg: { reason: 'exit' } },
  ].map(JSON.stringify).concat(['not json']);
  const s = traceStats(lines);
  assert.deepEqual(s.toolMs, [400, 300]);
  assert.deepEqual(s.hand, { started: 1, off: { exit: 1 }, skipped: { covered: 1 }, dropped: 0, restarts: 0, beats: 2, drift: [-12, 30] });
});

test('the schedule alternates which side runs first by round and task, each side once per task per round', () => {
  const steps = schedule(['a', 'b'], 2);
  assert.deepEqual(steps.map(s => `${s.round}${s.task}${s.side}`), ['1aoff', '1aon', '1bon', '1boff', '2aon', '2aoff', '2boff', '2bon']);
  assert.equal(schedule(CLAIM_TASKS, 3).length, 18);
  assert.deepEqual(runArgs({ task: 'textedit-save', model: 'claude-haiku-5-5', effort: 'high' }),
    ['bench/run.mjs', '--suite', 'world', '--arm', 'sleight', '--tasks', 'textedit-save', '--runs', '1', '--model', 'claude-haiku-5-5', '--effort', 'high', '--owner-away']);
  assert.equal(resultsPath('x\n\nresults: /r/bench/results/2026-10-19T12-00-00-000Z.json\n'), '/r/bench/results/2026-10-19T12-00-00-000Z.json');
  const base = join(tmpdir(), 'trace-paths'), armHome = join(base, 'arms');
  assert.deepEqual(traceDirs('S', 'calculator-click', 1, [base], armHome), [join(armHome, 'evidence/S/sleight-calculator-click-1'),
    join(base, 'sleight-real-evidence/S/sleight-calculator-click-1'), join(base, 'sleight-bench/S/sleight-calculator-click-1')]);
  assert.throws(() => parseArgs(['--rounds', '0']), /from 1 to 10/);
  assert.deepEqual(parseArgs([]).tasks, CLAIM_TASKS);
  assert.equal(parseArgs([]).cursorStyle, undefined); assert.equal(parseArgs(['--cursor-style', 'sprite']).cursorStyle, 'sprite');
  assert.throws(() => parseArgs(['--cursor-style', 'Sprite']), /--cursor-style/);
});

test('trace lookup reads durable evidence first and retains both temp spellings for old traces', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'hand-trace-'))), armHome = join(root, 'arms');
  const temp = join(root, 'temp'), alias = join(root, 'alias'); mkdirSync(temp); symlinkSync(temp, alias);
  const previous = process.env.TMPDIR; process.env.TMPDIR = alias;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  const dirs = traceDirs('S', 'calculator-click', 1, undefined, armHome);
  assert.deepEqual(dirs, [join(armHome, 'evidence/S/sleight-calculator-click-1'),
    join(alias, 'sleight-real-evidence/S/sleight-calculator-click-1'), join(realpathSync(temp), 'sleight-real-evidence/S/sleight-calculator-click-1'),
    join(alias, 'sleight-bench/S/sleight-calculator-click-1'), join(realpathSync(temp), 'sleight-bench/S/sleight-calculator-click-1')]);
  for (const [index, dir] of [dirs[0], dirs[1]].entries()) {
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'trace-1.jsonl'), String(index));
  }
  assert.equal(readFileSync(join(dirs[0], 'trace-1.jsonl'), 'utf8'), '0');
  assert.equal(readFileSync(join(dirs[2], 'trace-1.jsonl'), 'utf8'), '1');
  assert.equal(typeof costPass.readTraceLines, 'function');
  assert.deepEqual(costPass.readTraceLines(dirs), ['0']);
  rmSync(join(dirs[0], 'trace-1.jsonl'));
  assert.deepEqual(costPass.readTraceLines(dirs), ['1'], 'temp aliases must not double-count the same trace');
});

const entry = (side, { hostCpuS = 0.05, elapsedS = 10, ws = 3, peak = 9, rss = 42, hosts = side === 'on' ? 1 : 0, tool = [500, 600], drift = [], passed = true } = {}) => ({
  side, passed, elapsedS, whole: { hand: { hosts, peakRssMB: side === 'on' ? rss : 0 } },
  window: { windowServer: { avgPct: ws, peakPct: peak }, hand: side === 'on' ? { cpuS: hostCpuS, idleIntervals: 6, liveIntervals: 8 } : { cpuS: 0, idleIntervals: 0, liveIntervals: 0 } },
  trace: { toolMs: tool, hand: { drift, skipped: side === 'on' ? { covered: 1 } : {} } } });

test('compareSides: inside the budget, over it, and invalid when a side measured the wrong thing', () => {
  const within = compareSides([entry('on', { ws: 3.5, peak: 12, drift: [10, -40, 5] }), entry('off', { ws: 3, peak: 9 }), entry('on', { ws: 3.4 }), entry('off', { ws: 2.9 })]);
  assert.equal(within.verdict, 'within', JSON.stringify(within.checks));
  assert.deepEqual(within.checks.map(c => c.value), [0.5, 0.5, 1.5, 42, 0]);
  assert.deepEqual(within.drift, { beats: 3, medianAbsMs: 10, p90AbsMs: 40 });
  assert.deepEqual(within.passes, { on: '2/2', off: '2/2' });
  const md = reportMarkdown(within, { tasks: ['calculator-click'], rounds: 1, model: 'm', effort: 'high', started: 's', finished: 'f' });
  assert.match(md, /Verdict: \*\*within\*\*/); assert.match(md, /\| Hand host CPU per task, % \| 0\.5, 0\.5 \| 0, 0 \|/);
  const over = compareSides([entry('on', { hostCpuS: 0.2, rss: 61, tool: [800, 900] }), entry('off')]);
  assert.equal(over.verdict, 'over');
  assert.deepEqual(over.checks.filter(c => !c.ok).map(c => c.name), ['hand host CPU, highest task average', 'hand host RSS, peak', 'tool time per call, median on minus off']);
  assert.match(compareSides([entry('on', { hosts: 0 }), entry('off')]).invalid[0], /no hand host ran in 1 on-side run/);
  assert.match(compareSides([entry('on'), entry('off', { hosts: 1 })]).invalid[0], /SLEIGHT_HAND=0 did not reach the arm/);
  assert.equal(compareSides([entry('on')]).verdict, 'invalid');
  // No data on a side is no figure: null, never null - null = 0, and the pass is invalid rather than within.
  const blank = e => ({ ...e, window: { windowServer: null, hand: e.window.hand }, trace: { toolMs: [], hand: e.trace.hand } });
  const empty = compareSides([blank(entry('on')), blank(entry('off'))]);
  assert.equal(empty.verdict, 'invalid');
  assert.deepEqual(empty.checks.slice(1, 3).map(c => [c.value, c.ok]), [[null, false], [null, false]]);
  assert.equal(empty.checks[4].value, null);
  assert.deepEqual(empty.invalid, ['no WindowServer average figure on the on side', 'no WindowServer average figure on the off side',
    'no WindowServer busiest second figure on the on side', 'no WindowServer busiest second figure on the off side',
    'no tool time figure on the on side', 'no tool time figure on the off side']);
  const oneSided = compareSides([entry('on'), blank(entry('off'))]);
  assert.equal(oneSided.verdict, 'invalid');
  assert.equal(oneSided.checks[1].value, null);
  assert.equal(BUDGET.hostAvgPct, 1);
  assert.deepEqual(['glove', 'ring', 'seam', 'sprite', undefined].map(style => budgetFor(style).rssMB), [50, 50, 50, 64, 50]);
  assert.equal(budgetFor('sprite').hostAvgPct, BUDGET.hostAvgPct);
  // main() scores with budgetFor(meta.cursorStyle): a 60 MiB peak is over for the ring and within for the sprite.
  const rssCheck = style => compareSides([entry('on', { rss: 60 }), entry('off')], budgetFor(style)).checks.find(c => c.name === 'hand host RSS, peak');
  assert.deepEqual([rssCheck('ring').ok, rssCheck('ring').limit, rssCheck('sprite').ok, rssCheck('sprite').limit], [false, 50, true, 64]);
  const source = readFileSync(new URL('../bench/hand/cost-pass.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/compareSides\([^)]*budgetFor\(/g)?.length, 2); assert.doesNotMatch(source, /compareSides\((saved\.)?entries\)/);
});

test('runSide runs one task with the switch, samples the run\'s own tree and reads its row and trace', async () => {
  const runs = [];
  const deps = {
    env: { PATH: '/bin', SLEIGHT_BENCH_HAND: '1' },
    run: async (args, env) => { runs.push({ args, env }); return { pid: 4242, done: Promise.resolve({ code: 0, stdout: 'results: /r/one.json\n' }) }; },
    sampler: rootPid => { assert.equal(rootPid, 4242); let t = Date.parse('2026-10-19T12:00:00Z');
      const samples = []; const take = cpu => samples.push({ t: (t += 1000), ws: 100 + cpu, hosts: { 7: { cpu, rssKb: 40960 } } });
      return { start: async () => take(0), stop: async () => { for (const c of [0.01, 0.02, 0.02]) take(c); return samples; } }; },
    readJson: path => (assert.equal(path, '/r/one.json'), { stamp: 'S', ghostHand: runs.at(-1).env.SLEIGHT_BENCH_HAND === '1' ? 'on' : 'off',
      results: [{ arm: 'sleight', task: 'calculator-click', passed: true, finishedAt: '2026-10-19T12:00:04Z', timing: { elapsedMs: 3000 } }] }),
    traceLines: dirs => (assert.ok(dirs.every(d => d.includes('/S/sleight-calculator-click-1'))), [JSON.stringify({ t: '2026-10-19T12:00:01Z', direction: 'hand-started', msg: {} })]),
  };
  const on = await runSide(deps, { round: 1, task: 'calculator-click', side: 'on', model: 'm', effort: 'high' });
  assert.equal(runs[0].env.SLEIGHT_BENCH_HAND, '1'); assert.equal(runs[0].env.PATH, '/bin');
  assert.deepEqual([on.passed, on.elapsedS, on.window.hand.cpuS, on.whole.hand.peakRssMB, on.trace.hand.started], [true, 3, 0.02, 40, 1]);
  const off = await runSide(deps, { round: 1, task: 'calculator-click', side: 'off', model: 'm', effort: 'high' });
  assert.equal(runs[1].env.SLEIGHT_BENCH_HAND, '0'); assert.equal(off.error, undefined);
  // A results file that says the other side, a missing file or a missing row is an error entry, never a measurement.
  const wrong = await runSide({ ...deps, readJson: () => ({ stamp: 'S', ghostHand: 'off', results: [] }) }, { round: 1, task: 'calculator-click', side: 'on', model: 'm', effort: 'high' });
  assert.match(wrong.error, /the hand was off, not on/);
  const none = await runSide({ ...deps, run: async () => ({ pid: 4242, done: Promise.resolve({ code: 1, stdout: 'boom' }) }) }, { round: 1, task: 'x', side: 'on', model: 'm', effort: 'high' });
  assert.match(none.error, /exited 1 without a results file/);
  // The whole pass saves after every side and waits out the hold before each.
  const saves = [], waits = [];
  const entries = await runCostPass({ ...deps, waitForHold: async () => waits.push(1) }, { tasks: ['calculator-click'], rounds: 2, save: e => saves.push(e.length) });
  assert.deepEqual([entries.map(e => e.side), saves, waits.length], [['off', 'on', 'on', 'off'], [1, 2, 3, 4], 4]);
});

// ST9 checks raw evidence. These fixtures are measurements, not a passing production host.
let stage = await import('../bench/hand/stage-cost.mjs');
if (process.env.CHV4O_HELP_BROKEN === 'old-poll') {
  const url = new URL('../bench/hand/stage-cost.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8').replace('Kernel watches', 'Polls every second')
    .replace(/from (['"])(\.[^'"]+)\1/g, (_, q, path) => 'from ' + q + new URL(path, url).href + q)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  stage = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const stageFixture = () => {
  const motion = (hz, durationMs) => {
    const record = { requestedHz: hz, maximumHz: 120, durationMs, started: true, source: 'character', recorderMode: 'hash',
      scheduledStartHostMs: 1000, motionTiming: { scheduledStartHostMs: 1000, installStartHostMs: 1000,
        caBeginHostMs: 1000.1, installEndHostMs: 1000.2, transactionSubmittedHostMs: 1000.3 },
      frames: Array.from({ length: durationMs * hz / 1000 }, (_, i) => ({ tMs: i * 1000 / hz, ptsHostMs: 1000 + i * 1000 / hz, hash: String(i) })) };
    return { ...record, calibration: { ...structuredClone(record), source: 'numbered',
      motionTiming: { ...record.motionTiming, source: 'numbered', numberedFrames: hz * durationMs / 1000, cadenceInstalled: true,
        stationary: { animationKeys: [], sublayerCount: 0, siblingCount: 0, parentAnimationKeys: [], opacity: 1 },
        layerState: { animationKeys: ['contents'], sublayerCount: 0, siblingCount: 0, parentAnimationKeys: [], opacity: 1 } } } };
  };
  const capture = seat => ({ seat, size: 'stage', modes: { hidden: { samples: Object.keys(stage.CAPTURE_SOURCES).flatMap(source =>
    Array.from({ length: 5 }, (_, i) => ({ source, sample: i + 1, handUp: true, result: 'excluded', handLike: 0 }))) },
  visible: { samples: ['region', 'composite'].flatMap(source => Array.from({ length: 5 }, (_, i) =>
    ({ source, sample: i + 1, handUp: true, result: 'shown', handLike: 100 }))) } } });
  const placements = stage.placementFixtures().map(p => ({ ...p, box: null, legs: null }));
  placements[0] = { ...placements[0], box: [0, 0, 100, 100], aim: [300, 300], aimRect: [290, 290, 20, 20],
    person: [500, 500, 200, 200], legs: [0, 0, 100, 100], target: [250, 250, 300, 300], above: [] };
  return { schema: 'sleight.stage-cost/1', machine: { mac: 'fixture', macOS: 'fixture', maximumHz: 120 },
    runs: Array.from({ length: 3 }, (_, i) => ({ round: i + 1, loadAverageMax: 9.9, puddleWindowHeld: false,
      baselines: { quiet: [{ wsAvgPct: 10, wsPeakPct: 12, activeS: 60 }, { wsAvgPct: 10, wsPeakPct: 12, activeS: 60 }],
        changing: [0, 1].map(() => ({ wsAvgPct: 10, wsPeakPct: 12, activeS: 60, surfaceChecks: stageSurfaceChecksFixture('changing', false) })) },
      sizes: Object.fromEntries(stage.SIZES.map(size => [size, { phases: Object.fromEntries(['quiet', 'changing'].map(surface =>
        [surface, { activeS: 60, idleS: 60, hosts: 1, hostAvgPct: 2.5, idleHostCpuS: 0.05, peakRssMiB: 96,
          wsAvgPct: 13, wsPeakPct: 20, idleWsAvgPct: 13, idleWsPeakPct: 20, hostAliveThroughout: true,
          surfaceChecks: stageSurfaceChecksFixture(surface), ...stageScriptFixture(surface, size), control: { start: 0, end: 60000, pid: 42, ...stageScriptFixture(surface, size), surfaceChecks: stageSurfaceChecksFixture(surface, false),
            samples: Array.from({ length: 61 }, (_, j) => ({ t: j * 1000, ws: j * 0.1 + (j === 30 ? 0.02 : 0), hosts: { 42: { cpu: 0, rssKb: 1024 } },
              status: { pid: 42, characterHiddenControl: true, shown: false } })) } }])),
        dump: { cacheBytes: 24 * 1024 ** 2, resident2xStrips: 4, installMs: [3.99], installsPerPlan: [1], unplannedInstalls: 0,
          startupMs: 399, firstStripDecoded: true, decodeMs: [39.99], drawBlocked: false,
          panels: [{ panel: [0, 0, 148, 148], seat: [24, 24, 100, 100], move: [24, 24, 100, 100],
            drawing: { inkUnion: [25, 25, 98, 98], filterUnion: [24, 24, 100, 100], clip: [0, 0, 148, 148],
              required: [24, 24, 100, 100], positions: 1, geometries: 1, hasExtras: false } }] },
        pacing: [60, 120].flatMap(hz => [motion(hz, 600), motion(hz, 400)]) }])) })),
    behavior: { placements,
      pointer: [{ elapsedMs: 200, outcome: 'move', distancePt: 120 }, { elapsedMs: 200, outcome: 'fade', opacity: 0.35 }],
      hides: ['move', 'space', 'minimized', 'gone', 'full-screen'].map(event => ({ event, elapsedMs: 120, hidden: true })),
      frontSit: ['person-window', 'pointer-near', 'pointer-recent', 'asleep', 'locked'].map(event => ({ event, elapsedMs: 200, seat: 'edge-lie' })),
      hits: stage.SIZES.flatMap(size => Array.from({ length: 200 }, () => ({ size, outsideBadge: true, hit: false }))),
      consent: { syntheticMouseUpAnswered: false, badNonceDropped: true },
      reduced: [{ positionValues: 2 }], ladder: [700, 500, 300, 150, 40].map((width, i) =>
        ({ width, level: ['stage', 'stage-0.75', 'medium', 'small', 'hidden'][i] })),
      attention: [{ inputAgeS: 7.99, size: 'medium' }, { inputAgeS: 8, size: 'stage' }],
      sleepLock: ['sleep', 'lock'].map(event => ({ event, animations: 0 })),
      fallbacks: ['tsugi', 'shizu', 'bit', 'kit', 'yori', 'tab', 'codex-v1', 'codex-v2', 'bit-nearest'].map(id =>
        ({ id, stageArtAvailable: false, stageFilter: id === 'bit-nearest' ? 'nearest' : null, loaded: true, size: 'medium', warnings: ['shown at medium'] })) },
    captures: [capture('edge-lie'), capture('front-sit')] };
};

for (const event of ['move', 'space', 'minimized', 'gone']) test(`CH-7 ${event} receipt must prove a clear panel and every widened obligation`, () => {
  const behavior = stageFixture().behavior;
  const moved = behavior.hides.find(h => h.event === event);
  Object.assign(moved, { hidden: false, elapsedMs: 0, protection: { window: { pid: 42, id: 7 },
    wideWindows: [{ pid: 42, id: 7 }], required: [[100, 100, 300, 300], [500, 100, 96, 96]],
    forbidden: [[100, 100, 300, 300], [500, 100, 96, 96]], panel: [900, 40, 200, 200] } });
  const check = () => stage.behaviorChecks(behavior).find(c => /window change/.test(c.name)).verdict;
  assert.equal(check(), 'pass');
  moved.elapsedMs = 121; assert.equal(check(), 'fail'); moved.elapsedMs = 0;
  for (const mutate of [p => { p.wideWindows = []; }, p => { p.required.pop(); },
    p => { p.forbidden.pop(); }, p => { p.panel = [120, 120, 200, 200]; }, p => { p.panel = null; }]) {
    const original = structuredClone(moved.protection); mutate(moved.protection);
    assert.equal(check(), 'fail'); moved.protection = original;
  }
});

test('ST9: three runs, every size, every surface and every section 5 gate are required', () => {
  const evidence = stageFixture(), result = stage.stageVerdict(evidence);
  assert.equal(result.verdict, 'pass', JSON.stringify(result));
  assert.equal(result.runs.length, 3);
  assert.equal(result.runs[0].sizes.stage.checks.length, 12);
  assert.equal(result.behavior.length, 12);
  assert.equal(stage.stageVerdict({}).verdict, 'not-measured');
  evidence.runs.pop(); assert.equal(stage.stageVerdict(evidence).verdict, 'not-measured');
});

function int27Bank(id, interruptions = 6) {
  const e = stageFixture(), startedAt = '2026-01-01T00:00:00.000Z', endedAt = '2026-01-01T00:01:00.000Z';
  const qualification = { startedAt, endedAt, loadAverageMax: 1, puddleWindowHeld: false };
  const provenance = { segment: 1, startedAt, endedAt };
  e.collection = { sizes: stage.SIZES, segments: [{ id: 1, behavior: qualification,
    captures: { 'edge-lie': qualification, 'front-sit': qualification },
    rounds: { 1: qualification, 2: qualification, 3: qualification } }],
    units: stageUnitOrder(stage.SIZES).map(unit => ({ ...provenance, id: unit, attempt: unit === id ? interruptions + 1 : 1 })),
    attempts: Array.from({ length: interruptions }, (_, i) => ({ ...provenance, id, attempt: i + 1,
      interrupted: true, error: `offline watchdog ${i + 1}` })) };
  assert.equal(stageHistoryError(e.collection), null, 'fixture has contiguous, quiet interruption history');
  return e;
}
const int27Judge = (e, judge = stage.stageVerdict) => judge(e, stage.STAGE_BUDGET, { medianOfThree: true });
const int27Cases = [
  ['phase', 'round/1/phase/stage/quiet', 'host CPU, animating'],
  ['pacing', 'round/1/pacing/stage/60/600/character/hash', 'frame pacing, 60 and 120 Hz'],
  ['qualification', 'round/1/qualification', 'startup'],
  ['behavior', 'behavior', null],
  ['capture', 'capture/edge-lie', 'H5 stage capture'],
  ['baseline', 'round/1/baseline/quiet/before', null],
];
function int27Excluded(id, name, judge = stage.stageVerdict) {
  const result = int27Judge(int27Bank(id), judge);
  assert.equal(result.interruptionCeilings.length, 1);
  assert.equal(result.verdict, 'not-measured', 'canonical verdict must retain the exclusion');
  assert.equal(result.medianOfThree.verdict, 'not-measured', 'companion verdict must retain the exclusion');
  if (id === 'behavior' || id.startsWith('capture/')) {
    const affected = result.behavior.filter(c => id === 'behavior' ? c.name !== 'H5 stage capture' : c.name === name);
    assert.ok(affected.every(c => c.verdict === 'not-measured' && c.value === null));
  } else if (name) {
    const current = result.runs[0].sizes.stage.checks.find(c => c.name === name);
    const median = result.medianOfThree.sizes.stage.checks.find(c => c.name === name);
    assert.equal(current.verdict, 'not-measured'); assert.match(current.reason, /STAGE_INTERRUPTION_CEILING/);
    assert.equal(median.verdict, 'not-measured'); assert.equal(median.value, null);
    assert.equal(median.roundValues[0], null, 'excluded values must never enter the median');
  }
}
for (const [kind, id, name] of int27Cases) test(`INT27M excluded ${kind} cannot pass either verdict`, () => int27Excluded(id, name));
test('INT27M five interruptions allow both verdicts to pass and a surviving failure still fails', () => {
  const id = int27Cases[0][1], e = int27Bank(id, 5), pass = int27Judge(e);
  assert.equal(pass.verdict, 'pass'); assert.equal(pass.medianOfThree.verdict, 'pass');
  const excluded = int27Bank(int27Cases[5][1]); excluded.runs[1].sizes.stage.dump.drawBlocked = true;
  const fail = int27Judge(excluded);
  assert.equal(fail.verdict, 'fail'); assert.equal(fail.medianOfThree.verdict, 'fail');
});

for (const variant of ['retain-bars', 'ignore-baseline-exclusion']) test(`INT27M broken ${variant}`, async () => {
  const url = new URL('../bench/hand/stage-cost.mjs', import.meta.url), source = readFileSync(url, 'utf8');
  const [before, after] = variant === 'retain-bars' ? ["    c.verdict = 'not-measured'; c.value = null;", '    return;'] :
    ['!identity || !complete || result.interruptionCeilings.length', '!identity || !complete'];
  assert.ok(source.includes(before), 'broken variant must match its production site');
  const changed = source.replace(before, after).replace(/from (['"])(\.[^'"]+)\1/g,
    (_, quote, path) => 'from ' + quote + new URL(path, url).href + quote).replaceAll('import.meta.url', JSON.stringify(url.href));
  const mutated = await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
  const [, id, name] = int27Cases[variant === 'retain-bars' ? 0 : 5];
  const run = () => int27Excluded(id, name, mutated.stageVerdict);
  if (process.env.INT27M_BROKEN === '1') run();
  else assert.throws(run, { name: 'AssertionError' });
});

test('ST9: boundaries, missing samples, short phases and quiet-window failures fail closed', () => {
  for (const mutate of [
    e => { e.runs[0].sizes.stage.phases.quiet.hostAvgPct = 2.5001; },
    e => { e.runs[0].sizes.stage.phases.changing.wsPeakPct = 20.001; },
    e => { e.runs[0].sizes.small.phases.quiet.idleS = 59; },
    e => { e.runs[0].sizes.medium.phases.quiet.hostAliveThroughout = false; },
    e => { e.runs[0].loadAverageMax = 10; },
    e => { e.runs[0].puddleWindowHeld = true; },
    e => { e.runs[0].sizes.stage.dump.installMs = [4]; },
    e => { e.runs[0].sizes.stage.dump.installsPerPlan = [2]; },
    e => { e.runs[0].sizes.stage.dump.installsPerPlan = [0]; },
    e => { e.runs[0].sizes.stage.dump.unplannedInstalls = 1; },
    e => { delete e.runs[0].sizes.stage.dump.unplannedInstalls; },
    e => { e.machine.mac = ' '; },
    e => { e.runs[0].sizes.stage.dump.startupMs = 400; },
    e => { e.runs[0].sizes.stage.dump.cacheBytes++; },
    e => { e.runs[0].sizes.stage.dump.resident2xStrips = 3; },
    e => { e.runs[0].sizes.stage.dump.panels[0].panel[2] = 123; },
    e => { delete e.runs[0].sizes.stage.dump.drawBlocked; },
  ]) { const evidence = stageFixture(); mutate(evidence); assert.notEqual(stage.stageVerdict(evidence).verdict, 'pass'); }
});

test('ST9 frame pacing: measure delivery, unique frames and repeated runs; never pass an undersampled capture', () => {
  const good = stageFixture().runs[0].sizes.stage.pacing[0];
  assert.equal(stage.framePacing(good).verdict, 'pass');
  assert.equal(stage.framePacing({ ...good, frames: good.frames.slice(0, 5) }).verdict, 'not-measured');
  const repeated = structuredClone(good); repeated.frames[11].hash = repeated.frames[10].hash;
  assert.equal(stage.framePacing(repeated).verdict, 'fail');
  const gap = structuredClone(good); gap.frames[10].tMs += 100;
  assert.notEqual(stage.framePacing(gap).verdict, 'pass');
  assert.equal(stage.framePacing({ ...good, frames: [] }).achievedHz, null);
  assert.equal(stage.framePacing({ ...good, requestedHz: 120, maximumHz: 60 }).verdict, 'skipped');
  assert.equal(stage.framePacing({ ...good, maximumHz: undefined }).verdict, 'not-measured');
});

test('ST9 behavior: geometry and every behavior failure change the verdict', () => {
  for (const mutate of [
    e => { e.behavior.placements[0].box = [260, 260, 10, 10]; },
    e => { e.behavior.placements[0].legs = [300, 300, 20, 20]; },
    e => { e.behavior.placements[0].person = [50, 50, 100, 100]; },
    e => { e.behavior.pointer[0].elapsedMs = 201; },
    e => { e.behavior.hides.pop(); },
    e => { e.behavior.frontSit[0].seat = 'front-sit'; },
    e => { e.behavior.hits.pop(); },
    e => { e.behavior.consent.syntheticMouseUpAnswered = true; },
    e => { e.behavior.reduced[0].positionValues = 3; },
    e => { e.behavior.ladder[0].level = 'small'; },
    e => { e.behavior.attention[1].size = 'medium'; },
    e => { e.behavior.sleepLock[0].animations = 1; },
    e => { e.behavior.fallbacks[0].warnings.push('bad strip'); },
    e => { e.behavior.fallbacks.at(-1).stageFilter = 'linear'; },
    e => { e.behavior.fallbacks[0].stageArtAvailable = true; },
  ]) { const evidence = stageFixture(); mutate(evidence); assert.notEqual(stage.stageVerdict(evidence).verdict, 'pass'); }
});

test('ST9 H5: both seats, six sources, five real controls and exactly zero character pixels', () => {
  for (const mutate of [
    e => { e.captures.pop(); },
    e => { e.captures[0].modes.hidden.samples.pop(); },
    e => { e.captures[0].modes.hidden.samples[0].handLike = 1; },
    e => { e.captures[0].modes.hidden.samples[0].handUp = false; },
    e => { e.captures[0].modes.visible.samples = []; },
  ]) { const evidence = stageFixture(); mutate(evidence); assert.notEqual(stage.stageVerdict(evidence).verdict, 'pass'); }
});

test('ST9: the two-window script lasts 60 seconds and the dry plan covers all gates without running them', () => {
  const seq = stage.stageSequence([{ pid: 1, id: 2, bounds: { x: 0, y: 0, width: 800, height: 600 } },
    { pid: 1, id: 3, bounds: { x: 900, y: 0, width: 800, height: 600 } }]);
  assert.equal(seq.lengthMs, 60000);
  assert.equal(new Set(seq.steps.filter(s => s.type === 'aim').map(s => s.args.windowId)).size, 2);
  assert.equal(stage.parseArgs(['--dry-run', '--size', 'stage']).size, 'stage');
  assert.throws(() => stage.parseArgs(['--size', 'large']), /size/);
  assert.throws(() => stage.parseArgs(['--evidence']), /value/);
  const plan = stage.dryRunPlan(stage.parseArgs(['--dry-run'])).join('\n');
  for (const word of ['60 s', '3 runs', '120', '600', '400', '1000', '200', 'H5', 'changing', 'WindowServer']) assert.ok(plan.includes(word), word);
  assert.match(plan, /about 112 minutes plus compilation, including 144 pacing arms/);
  assert.match(stage.dryRunPlan({ size: 'stage' }).join('\n'), /about 54 minutes plus compilation, including 48 pacing arms/);
  assert.match(plan, /estimated 5 s per arm/);
  assert.match(plan, /Kernel watches/); assert.match(plan, /one-shot deadline/);
  assert.doesNotMatch(plan, /every second/);
  assert.match(stage.reportMarkdown(stage.stageVerdict(stageFixture())), /stage/);
});

test('ST9 placement fuzz is deterministic and varies widths, stacks, pointers, people and aim rectangles', () => {
  const cases = stage.placementFixtures();
  assert.equal(cases.length, 1000);
  assert.deepEqual(cases, stage.placementFixtures());
  assert.notDeepEqual(cases, stage.placementFixtures({ seed: 2 }));
  assert.ok(new Set(cases.map(c => c.target[2])).size > 500);
  assert.ok(cases.every(c => c.target[2] >= 300 && c.target[2] <= 1700));
  assert.ok(cases.some(c => c.above.length > 0) && cases.some(c => c.above.length === 0));
  assert.ok(cases.some(c => c.aimRect === null) && cases.some(c => c.aimRect !== null));
  assert.ok(cases.some(c => c.personIsTarget) && cases.some(c => !c.personIsTarget));
});

test('ST9 native pacing helper builds and hashes without a screen capture or a window', {
  skip: process.platform !== 'darwin' || !existsSync('/usr/bin/xcrun'),
}, t => {
  const work = registerTemp(t, mkdtempSync(join(tmpdir(), 'stage-pacing-test-')));
  const source = fileURLToPath(new URL('../bench/hand/frame-pacing.swift', import.meta.url));
  const binary = join(work, 'frame-pacing');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(work, 'modules'), source, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  const run = args => spawnSync(binary, args, { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  const stopped = run(['--stream-error-self-test']); assertChildStatus(stopped, 2);
  assert.deepEqual(JSON.parse(stopped.stdout), { ok: false, error: 'stream-stopped', code: -3808,
    description: 'Owned window stopped', domain: 'SCStreamErrorDomain' });
  const selftest = run(['--self-test']); assertChildStatus(selftest, 0, selftest.stderr);
  assert.deepEqual(JSON.parse(selftest.stdout), { ok: true, paddingIgnored: true, pixelChangeDetected: true,
    hash: '66840dda154e8a113c31dd0ad32f7f3a366a80e8136979d8f5a101d3d29d6f72', windowsCreated: 0, captures: 0 });
  const recorder = run(['--recorder-self-test']); assertChildStatus(recorder, 0, recorder.stderr);
  const arms = JSON.parse(recorder.stdout);
  assert.equal(arms.windowsCreated, 0); assert.equal(arms.captures, 0);
  assert.equal(arms.hash.frames.length, 2); assert.equal(arms.timestamps.frames.length, 2);
  assert.equal(arms.hash.frames[0].hash, arms.hash.frames[1].hash);
  assert.match(arms.hash.frames[0].hash, /^[0-9a-f]{64}$/);
  assert.ok(arms.hash.frames.every(f => f.hashMs >= 0 && f.callbackHostMs === f.ptsHostMs + 58));
  assert.ok(arms.timestamps.frames.every(f => !Object.hasOwn(f, 'hash') && f.hashMs === 0));
  assert.deepEqual(arms.hash.frames.map(f => f.tMs), [0, 599]);
  const samples = [
    { pts: 999, arrival: 1020, status: 0, valid: true },
    { pts: 1000, arrival: 1058, status: 0, valid: true },
    { pts: 1010, arrival: 1060, status: 1, valid: true },
    { pts: 1020, arrival: 1061, status: 2, valid: true },
    { pts: 1030, arrival: 1062, status: 0, valid: false },
    { pts: 1599, arrival: 1700, status: 0, valid: true },
    { pts: 1600, arrival: 1701, status: 0, valid: true },
  ];
  const dump = spawnSync(binary, ['--samples-dump'], { input: JSON.stringify({ start: 1000, durationMs: 600, samples }) + '\n',
    encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(dump, 0, dump.stderr);
  const log = JSON.parse(dump.stdout);
  assert.deepEqual(log.frames.map(f => f.tMs), [0, 599], 'arrival after the end still belongs to its original PTS');
  assert.deepEqual([log.completeFrames, log.idleFrames, log.rejectedFrames, log.outsideIntervalFrames], [3, 1, 2, 2]);
  assert.equal(log.samples[1].arrivalDelayMs, 58); assert.equal(log.scheduledStartHostMs, 1000);
  assert.deepEqual(log.samples.map(s => s.accepted), [false, true, false, false, false, true, false]);
  assert.equal(log.overflow, false); assert.equal(log.windowsCreated, 0); assert.equal(log.captures, 0);
  const overflow = spawnSync(binary, ['--samples-dump'], {
    input: JSON.stringify({ start: 1000, durationMs: 600, samples: Array(4097).fill(samples[1]) }) + '\n',
    encoding: 'utf8', timeout: 10000, maxBuffer: 4 << 20, killSignal: 'SIGKILL' });
  assertChildStatus(overflow, 2);
  const full = JSON.parse(overflow.stdout);
  assert.equal(full.error, 'sample-overflow'); assert.equal(full.overflow, true);
  assert.equal(full.frames.length, 4096); assert.equal(full.samples.length, 4096);
  const realOverflow = spawnSync(binary, ['--recorder-overflow-self-test'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 4 << 20, killSignal: 'SIGKILL' });
  assertChildStatus(realOverflow, 2, realOverflow.stderr);
  const recordedOverflow = JSON.parse(realOverflow.stdout);
  assert.equal(recordedOverflow.ok, false); assert.equal(recordedOverflow.error, 'sample-overflow');
  assert.equal(recordedOverflow.overflow, true); assert.equal(recordedOverflow.recorderMode, 'hash');
  assert.equal(recordedOverflow.scheduledStartHostMs, 1000); assert.equal(recordedOverflow.durationMs, 600);
  assert.equal(recordedOverflow.frames.length, 4096); assert.equal(recordedOverflow.samples.length, 4096);
  assert.ok(recordedOverflow.frames.every(f => f.hash === arms.hash.frames[0].hash && f.hashMs >= 0));
  const dry = run(['--dry-run']); assertChildStatus(dry, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).captures, 0);
  for (const args of [[], ['--window', '1', '--pid', '1', '--hz', '30', '--duration-ms', '600'],
    ['--window', '1', '--pid', '1', '--hz', '60', '--duration-ms', '601']]) {
    const bad = run(args); assertChildStatus(bad, 2); assert.equal(JSON.parse(bad.stdout).error, 'usage');
  }
});

test('ST9 offline CLI never promotes absent evidence and dry run launches no collector', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'stage-cli-test-')));
  const input = join(root, 'observations.json');
  writeFileSync(input, JSON.stringify(stageFixture()));
  const script = fileURLToPath(new URL('../bench/hand/stage-cost.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  const pass = run(['--evidence', input]); assertChildStatus(pass, 0, pass.stderr);
  assert.match(pass.stdout, /ST9 stage cost: pass/);
  writeFileSync(input, '{}'); const missing = run(['--evidence', input]); assertChildStatus(missing, 1);
  assert.match(missing.stdout, /not-measured/);
  writeFileSync(input, 'null'); assertChildStatus(run(['--evidence', input]), 2);
  const dry = run(['--dry-run', '--size', 'stage']); assertChildStatus(dry, 0, dry.stderr);
  assert.match(dry.stdout, /no children, windows or captures/);
});

test('ST9 phases cannot pass a host that vanished, CPU reset or sampling gaps', () => {
  const marks = { start: 0, activeEnd: 60000, idleEnd: 126000 };
  const samples = Array.from({ length: 127 }, (_, i) => ({ t: i * 1000, ws: i * 0.1,
    hosts: { 7: { cpu: Math.min(i, 60) * 0.01, rssKb: 40960 } } }));
  const good = stage.stagePhaseFigures(samples, marks, 7);
  assert.deepEqual([good.activeS, good.idleS, good.hostAliveThroughout], [60, 60, true]);
  const gap = structuredClone(samples); gap.splice(60, 2);
  assert.equal(stage.stagePhaseFigures(gap, marks, 7).hostAliveThroughout, false);
  const dead = structuredClone(samples); dead[80].hosts = {};
  assert.equal(stage.stagePhaseFigures(dead, marks, 7).hostAliveThroughout, false);
  const reset = structuredClone(samples); reset[80].ws = 0;
  assert.equal(stage.stagePhaseFigures(reset, marks, 7).hostAliveThroughout, false);
});

test('ST9 compares the changing script to its matching control and retains visible capture leaks', () => {
  const evidence = stageFixture();
  evidence.runs[0].sizes.stage.phases.changing.wsAvgPct = 13.001;
  evidence.runs[0].sizes.stage.phases.changing.idleWsAvgPct = 0;
  assert.equal(stage.stageVerdict(evidence).verdict, 'fail');
  const pass = stageFixture();
  pass.captures[0].modes.visible.samples.push({ source: 'hover', sample: 1, handUp: true, result: 'shown', handLike: 99 });
  const result = stage.stageVerdict(pass);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.captures[0].sources.find(s => s.source === 'hover').visible.characterPixels, 99);
  assert.match(stage.reportMarkdown(result), /hover.*99/);
  pass.machine.maximumHz = 60;
  for (const r of pass.runs) for (const s of Object.values(r.sizes)) {
    s.pacing = s.pacing.filter(p => p.requestedHz === 60).map(p => ({ ...p, maximumHz: 60, calibration: { ...p.calibration, maximumHz: 60 } }));
  }
  assert.equal(stage.stageVerdict(pass).verdict, 'pass', '120 Hz is explicitly skipped only on a 60 Hz display');
});


test('GL1A 14: a Glide executable is not a hand host', () => {
  assert.equal(isHandHost('/fixture/Library/Caches/sleight/turbo-host/mac-driver/k2/glide-engine'), false);
  assert.equal(isHandHost('/fixture/Library/Caches/sleight/turbo-host/mac-driver/k2/glide-engine --hand'), false);
});


test('CP1G preserves whole-motion denominator, onset loss and PTS when install or arrivals are late', () => {
  for (const hz of [60, 120]) for (const durationMs of [400, 600]) {
    const base = stageFixture().runs[0].sizes.stage.pacing.find(p => p.requestedHz === hz && p.durationMs === durationMs);
    const delayed = structuredClone(base);
    delayed.motionTiming.installStartHostMs += 58; delayed.motionTiming.caBeginHostMs += 58;
    delayed.motionTiming.installEndHostMs += 58; delayed.motionTiming.transactionSubmittedHostMs += 58;
    delayed.frames = delayed.frames.filter(f => f.tMs >= 58).map(f => ({ ...f,
      ptsHostMs: 1000 + f.tMs, callbackHostMs: 1200 + f.tMs, arrivalDelayMs: 200, hashMs: 1.7 }));
    const result = stage.calibratedPacing(delayed);
    assert.equal(result.expected, hz * durationMs / 1000);
    assert.equal(result.captured, delayed.frames.length); assert.equal(result.onsetMs, delayed.frames[0].tMs);
    assert.equal(result.scheduledStartHostMs, 1000); assert.equal(result.motionTiming.caBeginHostMs, 1058.1);
    assert.equal(result.installDelayMs, 58);
    assert.equal(result.onsetFromCABeginMs, Math.round((delayed.frames[0].ptsHostMs - 1058.1) * 1000) / 1000);
    assert.deepEqual(result.callbackDelayMs, delayed.frames.map(() => 200));
    assert.deepEqual(result.hashMs, delayed.frames.map(() => 1.7));
    assert.equal(result.verdict, 'fail'); assert.equal(result.rawVerdict, 'not-measured');
    assert.equal(result.qualification, 'qualified');
    const arrivedLate = structuredClone(base);
    arrivedLate.frames = arrivedLate.frames.map(f => ({ ...f, callbackHostMs: 2000 + f.tMs }));
    assert.equal(stage.calibratedPacing(arrivedLate).verdict, 'pass', 'arrival cannot replace PTS');
  }
});

test('CP1G retains failed calibration and refuses missing, mismatched or overflowed controls', () => {
  const good = stageFixture().runs[0].sizes.stage.pacing[0];
  assert.equal(stage.calibratedPacing(good).qualification, 'qualified');
  for (const mutate of [
    p => { delete p.calibration; }, p => { p.calibration.durationMs = 400; },
    p => { p.calibration.maximumHz = 60; }, p => { p.calibration.source = 'character'; },
    p => { p.calibration.recorderMode = 'timestamps'; }, p => { p.calibration.overflow = true; },
    p => { p.calibration.frames = p.calibration.frames.slice(4); },
    p => { p.calibration.frames[2].hash = p.calibration.frames[1].hash; },
    p => { p.calibration.motionTiming.caBeginHostMs = null; },
    p => { p.calibration.motionTiming.source = 'character'; },
    p => { delete p.calibration.motionTiming.source; },
    p => { p.calibration.motionTiming.numberedFrames--; },
    p => { delete p.calibration.motionTiming.numberedFrames; },
    p => { p.calibration.motionTiming.cadenceInstalled = false; },
    p => { delete p.calibration.motionTiming.cadenceInstalled; },
    p => { p.motionTiming.scheduledStartHostMs++; },
  ]) {
    const record = structuredClone(good); mutate(record);
    const result = stage.calibratedPacing(record);
    assert.equal(result.verdict, 'not-measured'); assert.equal(result.qualification, 'unqualified');
    assert.equal(result.rawVerdict, 'pass');
  }
  const duplicate = structuredClone(good); duplicate.calibration.frames[2].hash = duplicate.calibration.frames[1].hash;
  assert.equal(stage.calibratedPacing(duplicate).calibration.verdict, 'fail');
  const evidence = stageFixture(); evidence.runs[0].sizes.stage.pacing[0].calibration.frames = [];
  assert.notEqual(stage.stageVerdict(evidence).verdict, 'pass');
});

test('CP1GFIX1 qualified control turns count, coverage and rate deficits into exact failures', () => {
  for (const mutate of [
    p => { p.frames = p.frames.filter((_, i) => i % 6 !== 3); },
    p => { p.frames = p.frames.slice(0, 35).map((f, i) => ({ ...f, tMs: 20 + i * 570 / 34 })); },
    p => { p.frames = p.frames.slice(0, 35).map((f, i) => ({ ...f, tMs: i * 570 / 34 })); },
    p => { p.frames = []; },
    p => { p.frames = p.frames.slice(0, 1); },
    p => { p.frames = p.frames.slice(0, 35).map((f, i) => ({ ...f, tMs: i * 599 / 34 })); },
  ]) {
    const record = stageFixture().runs[0].sizes.stage.pacing[0]; mutate(record);
    const result = stage.calibratedPacing(record);
    assert.equal(result.qualification, 'qualified'); assert.equal(result.verdict, 'fail');
    assert.equal(result.expected, 36);
  }
  const invalid = stageFixture().runs[0].sizes.stage.pacing[0]; invalid.invalidFrames = 1;
  assert.equal(stage.calibratedPacing(invalid).verdict, 'not-measured', 'invalid evidence cannot measure a frame deficit');
});

test('CP1GFIX1 raw failures survive unqualified controls and missing sibling measurements', () => {
  const record = stageFixture().runs[0].sizes.stage.pacing[0];
  record.frames[2].hash = record.frames[1].hash;
  for (const control of [undefined, { ...record.calibration, frames: [] },
    { ...record.calibration, motionTiming: { ...record.calibration.motionTiming, cadenceInstalled: false } }]) {
    const result = stage.calibratedPacing({ ...record, calibration: control });
    assert.equal(result.qualification, 'unqualified'); assert.equal(result.rawVerdict, 'fail'); assert.equal(result.verdict, 'fail');
  }
  for (const failedArm of [0, 1, 2, 3]) {
    const evidence = stageFixture(), pacing = evidence.runs[0].sizes.stage.pacing;
    // Use that arm's own valid cadence, then remove its control and leave a different sibling unmeasured.
    const original = stageFixture().runs[0].sizes.stage.pacing[failedArm];
    pacing[failedArm] = original; original.frames[2].hash = original.frames[1].hash; delete original.calibration;
    delete pacing[(failedArm + 1) % 4].calibration;
    const result = stage.stageVerdict(evidence), size = result.runs[0].sizes.stage;
    assert.equal(size.pacing[failedArm].verdict, 'fail');
    assert.equal(size.pacing[(failedArm + 1) % 4].verdict, 'not-measured');
    assert.equal(size.checks.find(c => c.name.startsWith('frame pacing')).verdict, 'fail');
    assert.equal(result.verdict, 'fail');
  }
});

test('CP1GFIX1 tolerates JSON clock rounding and records numbered phase without moving the interval', () => {
  for (const delta of [-5e-7, 5e-7]) {
    const record = stageFixture().runs[0].sizes.stage.pacing[0];
    record.motionTiming.scheduledStartHostMs += delta; record.calibration.motionTiming.scheduledStartHostMs += delta;
    const result = stage.calibratedPacing(record);
    assert.equal(result.verdict, 'pass'); assert.equal(result.expected, 36);
    assert.ok(result.calibration.cadencePhaseMs.every(n => n === 16.567));
  }
  for (const delta of [-2e-6, 2e-6]) {
    const record = stageFixture().runs[0].sizes.stage.pacing[0]; record.motionTiming.scheduledStartHostMs += delta;
    assert.equal(stage.calibratedPacing(record).qualification, 'unqualified');
  }
});

test('CP1G timestamps-only records report delivery without claiming unique character frames', () => {
  const base = stageFixture().runs[0].sizes.stage.pacing[0];
  const record = { ...base, recorderMode: 'timestamps', ok: true, overflow: false, invalidFrames: 0, changedDimensions: false,
    frames: base.frames.map(({ tMs }) => ({ tMs, hashMs: 0 })) };
  const result = stage.framePacing(record);
  assert.equal(result.verdict, 'not-measured'); assert.equal(result.delivery.verdict, 'pass');
  assert.equal(result.delivery.expected, 36); assert.equal(result.delivery.captured, 36);
  assert.equal(stage.framePacing({ ...record, frames: record.frames.slice(4) }).delivery.verdict, 'fail');
  assert.equal(stage.framePacing({ ...record, overflow: true }).delivery.verdict, 'not-measured');
});

test('CP1G captures every arm separately and checkpoints failed controls before the next arm', async () => {
  const calls = [], saved = [];
  const capture = async (size, hz, ms, options) => {
    calls.push({ size, hz, ms, ...options });
    return { ...options, frames: [], ok: options.source !== 'numbered' };
  };
  const result = await stageLive.collectPacingTrial(capture, 'stage', 120, 400, async row => saved.push(structuredClone(row)));
  assert.deepEqual(calls.map(c => [c.source, c.recorderMode]), [
    ['character', 'hash'], ['numbered', 'hash'], ['character', 'timestamps'], ['numbered', 'timestamps']]);
  assert.ok(calls.every(c => c.hz === 120 && c.ms === 400 && c.size === 'stage'));
  assert.equal(result.calibration.ok, false); assert.equal(result.calibration.timestampsOnly.ok, false);
  assert.equal(saved.length, 4); assert.equal(saved[1].calibration.ok, false);
  const partial = [];
  await assert.rejects(stageLive.collectPacingTrial(async (...args) => {
    if (args[3].recorderMode === 'timestamps') throw Error('diagnostic stopped');
    return capture(...args);
  }, 'small', 60, 600, async row => partial.push(structuredClone(row))), /diagnostic stopped/);
  assert.equal(partial.at(-1).calibration.ok, false);
});

test('CP1GFIX1 recorder protocol failures retain each failed arm and finish the collection', async () => {
  const failures = ['sample-overflow', 'stream-stopped', 'pixel-lock', 'invalid-pixels', 'start-capture', 'window-owner-mismatch', 'nonzero-with-frames'];
  const options = [['character', 'hash'], ['numbered', 'hash'], ['character', 'timestamps'], ['numbered', 'timestamps']];
  for (const failure of failures) for (const failedArm of [0, 1, 2, 3]) {
    const snapshots = [], calls = []; let closed = 0, captures = 0;
    const row = { ok: failure === 'nonzero-with-frames', error: failure, frames: [{ tMs: 0, hash: 'kept' }],
      samples: [{ ptsHostMs: 1000, callbackHostMs: 1058 }], overflow: failure === 'sample-overflow' };
    const beforeReady = ['start-capture', 'window-owner-mismatch'].includes(failure);
    const deps = {
      machine: async () => ({ mac: 'fixture', macOS: 'test', maximumHz: 120 }), behavior: async () => ({}),
      baseline: async () => ({}), phase: async () => ({ figures: {} }),
      qualification: async () => ({}), capture: async seat => { captures++; return { seat }; },
      checkpoint: async evidence => snapshots.push(structuredClone(evidence)), close: async () => { closed++; },
      pacing: async (size, hz, ms, metadata) => {
        calls.push(metadata);
        if (calls.length !== failedArm + 1) return { ...metadata, requestedHz: hz, durationMs: ms, ok: true, frames: [] };
        const script = beforeReady ? `console.log(${JSON.stringify(JSON.stringify(row))}); process.exitCode = 2;` :
          `console.log('{"ready":true}'); process.stdin.once('data', () => { console.log(${JSON.stringify(JSON.stringify(row))}); process.stdin.destroy(); process.exitCode = 2; });`;
        const recorder = stageLive.jsonChild(process.execPath, ['-e', script]);
        const requests = [], writes = [];
        const session = { request: async request => {
          requests.push(request); return { hostTimeMs: 1000, motionTiming: { source: metadata.source }, shown: true, panelID: 44, panelGenerations: 1, hideReasonCounts: {} };
        } };
        const originalWrite = recorder.write; recorder.write = line => { writes.push(JSON.parse(line)); originalWrite(line); };
        try { return await stageLive.recordPacingMotion(session, recorder, { ...metadata, requestedHz: hz, durationMs: ms, shown: true, panelID: 44, panelGenerations: 1, hideReasonCounts: {} }); }
        finally {
          const exit = await recorder.close(); assert.equal(exit.code, 2);
          assert.equal(requests.length, beforeReady ? 1 : 3);
          assert.deepEqual(writes, beforeReady ? [] : [{ start: true, startAtHostMs: 1500 }]);
        }
      },
    };
    const complete = await stageLive.collectStageEvidence(deps, { sizes: ['stage'] });
    assert.equal(closed, 1); assert.equal(captures, 2); assert.equal(calls.length, 48);
    assert.deepEqual(calls.slice(0, 4).map(c => [c.source, c.recorderMode]), options);
    const failedUnit = complete.collection.units.find(unit => unit.status === 'failed');
    const failed = complete.collection.attempts.find(attempt => attempt.id === failedUnit.id).evidence;
    assert.equal(failedUnit.kind, 'pacing-recorder');
    assert.equal(failed.ok, false); assert.equal(failed.error, failure);
    assert.deepEqual(failed.frames, row.frames); assert.deepEqual(failed.samples, row.samples);
    assert.equal(failed.overflow, row.overflow); assert.ok(failed.recorderRows.some(r => r.error === failure));
    assert.equal(complete.error, undefined); assert.equal(complete.runs.length, 3);
    assert.equal(complete.collection.attempts.length, 1);
    const savedFailure = snapshots.find(snapshot => snapshot.collection.units.some(unit => unit.status === 'failed'));
    assert.deepEqual(savedFailure.collection.attempts[0].evidence, failed);
    assert.equal(savedFailure.collection.inProgress, undefined, 'failure checkpoint precedes the next unit');
  }
});

test('CP1GFIX1 recorder success completes the same handshake and keeps fixture timing', async () => {
  const row = { ok: true, maximumHz: 60, frames: [{ tMs: 0, hash: 'first' }] };
  const recorder = stageLive.jsonChild(process.execPath, ['-e',
    `console.log('{"ready":true}'); process.stdin.once('data', () => { console.log(${JSON.stringify(JSON.stringify(row))}); process.stdin.destroy(); });`]);
  const timing = { source: 'numbered', numberedFrames: 36, cadenceInstalled: true };
  const requests = [], metadata = { source: 'numbered', recorderMode: 'hash', maximumHz: 120 };
  try {
    const result = await stageLive.recordPacingMotion({ request: async value => {
      requests.push(value); return { hostTimeMs: 1000, motionTiming: timing };
    } }, recorder, metadata);
    assert.deepEqual(result, { ...metadata, ...row, motionTiming: timing });
    assert.deepEqual(requests, [{ bench: 'query' }, { bench: 'start', startAtHostMs: 1500 }, { bench: 'query' }]);
  } finally { assert.equal((await recorder.close()).code, 0); }
});

test('CP1GFIX2 measured failures survive errors, missing rounds and unqualified runs', () => {
  const mutations = [() => {}, e => { e.error = 'later recorder stopped'; }, e => { e.runs.pop(); },
    e => { e.runs[0].loadAverageMax = 100; }, e => { delete e.runs[0].puddleWindowHeld; },
    e => { e.runs.length = 1; e.runs[0].loadAverageMax = 100; e.error = 'install failed'; }];
  for (let arm = 0; arm < 4; arm++) for (const mutate of mutations) {
    const evidence = stageFixture(), pacing = evidence.runs[0].sizes.stage.pacing[arm];
    pacing.frames[1].hash = pacing.frames[0].hash;
    // A sibling measurement is absent as well. Failure still wins at every roll-up.
    evidence.runs[0].sizes.stage.pacing[(arm + 1) % 4].calibration = null;
    mutate(evidence);
    const verdict = stage.stageVerdict(evidence);
    assert.equal(verdict.runs[0].sizes.stage.pacing[arm].verdict, 'fail');
    assert.equal(verdict.runs[0].sizes.stage.verdict, 'fail');
    assert.equal(verdict.runs[0].verdict, 'fail');
    assert.equal(verdict.verdict, 'fail');
    assert.equal(verdict.error, evidence.error ?? null);
    if (evidence.error) assert.match(stage.reportMarkdown(verdict), new RegExp(evidence.error));
  }
  const incomplete = stageFixture(); incomplete.runs.length = 1; incomplete.error = 'later recorder stopped';
  assert.equal(stage.stageVerdict(incomplete).verdict, 'not-measured', 'an incomplete pass cannot qualify');
});

test('CP1GFIX2 numbered qualification checks observed stationary and installed layers', () => {
  const edits = [t => { t.stationary.animationKeys = ['opacity']; }, t => { t.stationary.sublayerCount = 1; },
    t => { t.stationary.siblingCount = 1; }, t => { t.stationary.parentAnimationKeys = ['opacity']; },
    t => { t.stationary.opacity = 0.35; }, t => { delete t.stationary; },
    t => { t.layerState.animationKeys.push('transform'); }, t => { t.layerState.animationKeys = []; },
    t => { t.layerState.sublayerCount = 1; }, t => { t.layerState.siblingCount = 1; },
    t => { t.layerState.parentAnimationKeys = ['position']; }, t => { t.layerState.opacity = 0.35; },
    t => { delete t.layerState; }];
  for (const edit of edits) {
    const record = stageFixture().runs[0].sizes.stage.pacing[0];
    edit(record.calibration.motionTiming);
    assert.equal(stage.calibratedPacing(record).verdict, 'not-measured');
    assert.equal(stage.calibratedPacing(record).qualification, 'unqualified');
    record.frames[1].hash = record.frames[0].hash;
    assert.equal(stage.calibratedPacing(record).verdict, 'fail', 'an invalid control cannot erase a measured failure');
  }
});

test('CP1GFIX2 completed invalid captures retain counts and continue every arm and round', async () => {
  for (const invalid of [{ invalidFrames: 2, changedDimensions: false }, { invalidFrames: 0, changedDimensions: true },
    { invalidFrames: 3, changedDimensions: true }]) for (const failedArm of [0, 1, 2, 3]) {
    const snapshots = []; let calls = 0, captures = 0, qualifications = 0, closed = 0;
    const valid = stageFixture().runs[0].sizes.stage.pacing[0];
    const deps = { machine: async () => ({ mac: 'fixture', macOS: 'test', maximumHz: 120 }),
      behavior: async () => ({}), baseline: async () => ({}), phase: async () => ({ figures: {} }),
      qualification: async () => { qualifications++; return {}; }, capture: async () => { captures++; return {}; },
      checkpoint: async e => snapshots.push(structuredClone(e)), close: async () => { closed++; },
      pacing: async (_size, hz, ms, metadata) => {
        const row = { ...structuredClone(metadata.source === 'numbered' ? valid.calibration : valid), ...metadata,
          requestedHz: hz, durationMs: ms, ok: true, overflow: false, invalidFrames: 0, changedDimensions: false };
        delete row.calibration;
        if (calls++ !== failedArm) return row;
        Object.assign(row, invalid, { ok: false, completeFrames: 36, idleFrames: 4, rejectedFrames: invalid.invalidFrames });
        const recorder = stageLive.jsonChild(process.execPath, ['-e',
          `console.log('{"ready":true}'); process.stdin.once('data', () => { console.log(${JSON.stringify(JSON.stringify(row))}); process.stdin.destroy(); });`]);
        try {
          return await stageLive.recordPacingMotion({ request: async () => ({ hostTimeMs: 500, motionTiming: row.motionTiming }) }, recorder, metadata);
        } finally { assert.equal((await recorder.close()).code, 0); }
      } };
    const evidence = await stageLive.collectStageEvidence(deps, { sizes: ['stage'] });
    assert.equal(calls, 48); assert.equal(qualifications, 3); assert.equal(captures, 2); assert.equal(closed, 1);
    assert.equal(evidence.error, undefined); assert.equal(evidence.runs.length, 3);
    const result = evidence.runs[0].sizes.stage.pacing[0];
    const failed = [result, result.calibration, result.timestampsOnly, result.calibration.timestampsOnly][failedArm];
    assert.equal(failed.ok, false); assert.equal(failed.invalidFrames, invalid.invalidFrames);
    assert.equal(failed.changedDimensions, invalid.changedDimensions);
    assert.equal(failed.completeFrames, 36); assert.equal(failed.idleFrames, 4); assert.equal(failed.rejectedFrames, invalid.invalidFrames);
    assert.equal(failed.frames.length, 36); assert.equal(stage.framePacing(failed).verdict, 'not-measured');
    assert.equal(stage.framePacing(failed).invalidFrames, invalid.invalidFrames);
    assert.equal(stage.framePacing(failed).changedDimensions, invalid.changedDimensions);
    if (failedArm < 2) assert.equal(stage.calibratedPacing(result).verdict, 'not-measured');
    assert.equal(snapshots.at(-1).runs.length, 3);
  }
});

test('CP1GFIX2 integrity errors abort even with exit zero and completed invalid frames', async () => {
  for (const failure of [{ error: 'stream-stopped' }, { overflow: true }, { ok: false, invalidFrames: 0, changedDimensions: false }]) {
    let arms = 0;
    const row = { ok: false, started: true, frames: [{ tMs: 0, hash: 'kept' }], invalidFrames: 2, changedDimensions: true, ...failure };
    const recorder = stageLive.jsonChild(process.execPath, ['-e',
      `console.log('{"ready":true}'); process.stdin.once('data', () => { console.log(${JSON.stringify(JSON.stringify(row))}); process.stdin.destroy(); });`]);
    try {
      await assert.rejects(stageLive.collectPacingTrial(async (_size, _hz, _ms, metadata) => {
        arms++;
        return stageLive.recordPacingMotion({ request: async () => ({ hostTimeMs: 1000, shown: true, panelID: 44, panelGenerations: 1, hideReasonCounts: {} }) }, recorder, { ...metadata, shown: true, panelID: 44, panelGenerations: 1, hideReasonCounts: {} });
      }, 'stage', 60, 600), error => {
        assert.equal(error.pacingEvidence.ok, false); assert.deepEqual(error.pacingEvidence.frames, row.frames);
        return /pacing recorder failed/.test(error.message);
      });
      assert.equal(arms, 1);
    } finally { assert.equal((await recorder.close()).code, 0); }
  }
});

test('CP1GFIX2 session death at numbered install checkpoints its cause and rows', async () => {
  const failure = { ok: false, error: 'numbered-control-install', source: 'numbered' };
  const session = stageLive.jsonChild(process.execPath, ['-e', `
    let started = false;
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.bench === 'query' && !started) console.log('{"reply":"query","hostTimeMs":1000}');
      if (request.bench === 'start') {
        started = true; console.log('{"reply":"start"}');
        setTimeout(() => { console.log(${JSON.stringify(JSON.stringify(failure))}); process.exit(2); }, 10);
      }
    });`], {}, { failureKind: 'host-crash' });
  const row = { ok: true, frames: [{ tMs: 0, hash: 'kept' }], samples: [{ ptsHostMs: 1500 }] };
  const recorder = stageLive.jsonChild(process.execPath, ['-e',
    `console.log('{"ready":true}'); process.stdin.once('data', () => { console.log(${JSON.stringify(JSON.stringify(row))}); process.stdin.destroy(); });`]);
  const snapshots = []; let arms = 0, closed = 0, captures = 0;
  const deps = { machine: async () => ({ mac: 'fixture', macOS: 'test', maximumHz: 120 }), behavior: async () => ({}),
    baseline: async () => ({}), phase: async () => ({ figures: {} }), qualification: async () => ({}),
    capture: async seat => { captures++; return { seat }; }, checkpoint: async e => snapshots.push(structuredClone(e)), close: async () => { closed++; },
    pacing: async (_size, _hz, _ms, metadata) => {
      if (++arms !== 2) return { ...metadata, ...row };
      return stageLive.recordPacingMotion(session, recorder, metadata);
    } };
  try {
    const complete = await stageLive.collectStageEvidence(deps, { sizes: ['stage'] });
    assert.equal(arms, 48); assert.equal(closed, 1); assert.equal(captures, 2);
    const failedUnit = complete.collection.units.find(unit => unit.status === 'failed');
    assert.equal(failedUnit.kind, 'host-crash');
    const failed = complete.collection.attempts.find(attempt => attempt.id === failedUnit.id).evidence;
    assert.equal(failed.error, 'numbered-control-install');
    assert.ok(failed.sessionRows.some(r => r.error === 'numbered-control-install'));
    assert.ok(failed.recorderRows.some(r => Array.isArray(r.frames)));
    assert.deepEqual(failed.frames, row.frames); assert.deepEqual(failed.samples, row.samples);
    assert.equal(complete.error, undefined);
    assert.ok(snapshots.some(snapshot => snapshot.collection.attempts[0]?.evidence?.error === 'numbered-control-install'));
  } finally {
    assert.equal((await session.close()).code, 2); assert.equal((await recorder.close()).code, 0);
  }
});

test('CR2B cost receipts retain stale-window counts and largest measured bounds difference', () => {
  const sample = (t, count, difference) => ({ t, status: { shown: false, hideReason: 'stale-window',
    hideReasonCounts: { 'stale-window': count, 'no-seat': 2 }, maxWindowBoundsDifferencePt: difference } });
  const result = attributeStageCosts([sample(0, 1, 0.5), sample(1000, 3, 2.25), sample(2000, 3, 1)], 42);
  assert.equal(result.hideReasonCounts['stale-window'], 3);
  assert.equal(result.maxWindowBoundsDifferencePt, 2.25);
  const renderer = stageLive.rendererDump({ hideReasonCounts: { 'stale-window': 3 }, maxWindowBoundsDifferencePt: 2.25 });
  assert.deepEqual(renderer.hideReasonCounts, { 'stale-window': 3 });
  assert.equal(renderer.maxWindowBoundsDifferencePt, 2.25);
});

test('CR2C cost receipts distinguish unmeasured bounds from compared zero', () => {
  for (const value of [null, 0]) {
    const samples = [0, 100].map(t => ({ t, status: { shown: false, hideReasonCounts: { 'stale-window': 0 }, maxWindowBoundsDifferencePt: value } }));
    assert.equal(attributeStageCosts(samples, 1).maxWindowBoundsDifferencePt, value);
    assert.equal(stageLive.rendererDump(samples[0].status).maxWindowBoundsDifferencePt, value);
  }
});


test('CHRET4 pointer protection accepts a measured immediate hide and refuses visible or late hides', () => {
  const check = pointer => stage.behaviorChecks({ pointer }).find(c => c.name === 'pointer dodge or fade');
  assert.equal(check([{ outcome: 'hidden', elapsedMs: 0, panelOnScreen: false, reason: 'pointer-covered' }]).verdict, 'pass');
  assert.equal(check([{ outcome: 'move', elapsedMs: 200, distancePt: 120, opacity: 1 }]).verdict, 'pass');
  assert.equal(check([{ outcome: 'fade', elapsedMs: 200, opacity: 0.35 }]).verdict, 'pass');
  for (const row of [
    { outcome: 'hidden', elapsedMs: 201, panelOnScreen: false, reason: 'pointer-covered' },
    { outcome: 'hidden', elapsedMs: 0, panelOnScreen: true, reason: 'pointer-covered' },
    { outcome: 'hidden', elapsedMs: 0, panelOnScreen: false, reason: 'paused' },
    { outcome: 'hidden', elapsedMs: 0, panelOnScreen: false, reason: 'geometry-unobserved' },
    { outcome: 'hidden', elapsedMs: 0, reason: 'pointer-covered' },
    { outcome: 'hidden', elapsedMs: 0, panelOnScreen: 'unmeasured', reason: 'pointer-covered' },
    { outcome: 'move', elapsedMs: 200, distancePt: 119, opacity: 1 },
    { outcome: 'fade', elapsedMs: 200, opacity: 0.5 },
  ]) assert.equal(check([row]).verdict, 'fail', JSON.stringify(row));
});

function pointerBar(receipt, checks) {
  const bar = rows => checks({ pointer: receipt(rows, { box: [0, 0, 10, 10], panelOnScreen: true }) }).find(c => c.name === 'pointer dodge or fade').verdict;
  const hide = (reason, panelOnScreen) => [{ effect: 'stage-hide', duration: 0, reason, ...(panelOnScreen === undefined ? {} : { panelOnScreen }) }];
  assert.equal(bar(hide('paused', false)), 'fail', 'paused hide');
  assert.equal(bar(hide('geometry-unobserved', false)), 'fail', 'unknown geometry hide');
  assert.equal(bar(hide('pointer-covered', false)), 'pass', 'pointer-covered hide');
  assert.equal(bar(hide('pointer-covered', true)), 'fail', 'panel still on screen');
  assert.equal(bar(hide('pointer-covered')), 'fail', 'missing panel state');
  for (const value of ['unmeasured', null, 0, 'false'])
    assert.equal(bar(hide('pointer-covered', value)), 'fail', 'unmeasured or invalid panel state');
  assert.equal(Object.hasOwn(receipt(hide('pointer-covered', false), { panelOnScreen: true })[0], 'opacity'), false);
}
async function loadMutatedBench(dir, file, transform) {
  const url = new URL('../bench/hand/' + file, import.meta.url);
  let source = transform(readFileSync(url, 'utf8'));
  assert.notEqual(source, readFileSync(url, 'utf8'), file);
  source = source.replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, path) => prefix + quote + new URL(path, url).href + quote);
  const copy = join(dir, file);
  writeFileSync(copy, source);
  return import(pathToFileURL(copy).href + '?mutant=' + Math.random());
}
test('pointer scenario bar uses the production panel state and rejects fabricated or unrelated hides', async t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-int23j-pointer-'))));
  pointerBar(stageLive.pointerScenarioReceipt, stage.behaviorChecks);
  const anyHide = await loadMutatedBench(root, 'stage-cost.mjs', source => source.replace(
    "p.outcome === 'hidden' && p.reason === 'pointer-covered' && p.panelOnScreen === false",
    "p.outcome === 'hidden' && p.panelOnScreen === false"));
  assert.throws(() => pointerBar(stageLive.pointerScenarioReceipt, anyHide.behaviorChecks), /paused hide/);
  const literal = await loadMutatedBench(root, 'stage-live.mjs', source => source.replace(
    "typeof hide.panelOnScreen === 'boolean' ? hide.panelOnScreen : 'unmeasured'",
    'false'));
  assert.throws(() => pointerBar(literal.pointerScenarioReceipt, stage.behaviorChecks), /panel still on screen/);
  const hide = [{ effect: 'stage-hide', duration: 0, reason: 'pointer-covered', panelOnScreen: false }];
  const verdict = (receipt, initial) => stage.behaviorChecks({ pointer: receipt(hide, initial) }).find(c => c.name === 'pointer dodge or fade').verdict;
  assert.equal(verdict(stageLive.pointerScenarioReceipt, { box: [0, 0, 10, 10] }), 'fail', 'hide with no panel');
  assert.equal(verdict(stageLive.pointerScenarioReceipt, { box: [0, 0, 10, 10], panelOnScreen: false }), 'fail', 'panel was not on screen');
  assert.equal(stageLive.pointerScenarioReceipt(hide, { panelOnScreen: false })[0].panelOnScreen, 'unmeasured');
  const droppedInitial = await loadMutatedBench(root, 'stage-live.mjs', source => source.replace(
    "initial?.panelOnScreen === true ? recorded : 'unmeasured'", 'recorded'));
  assert.throws(() => assert.equal(verdict(droppedInitial.pointerScenarioReceipt, { box: [0, 0, 10, 10] }), 'fail', 'hide with no panel'));
});

function pointerVerdict(pointer) {
  return stage.behaviorChecks({ pointer }).find(c => c.name === 'pointer dodge or fade').verdict;
}
test('owned panel identity rejects duplicate and foreign window rows', () => {
  const owned = { id: 5, pid: 9 }, other = { id: 8, pid: 3 }, identity = { pid: 9, panelID: 5 };
  assert.equal(stageLive.ownedPanelOnScreen([owned, other], identity), true);
  assert.equal(stageLive.ownedPanelOnScreen([other], identity), false);
  for (const windows of [[owned, owned], [{ ...owned, pid: 4 }], null])
    assert.equal(stageLive.ownedPanelOnScreen(windows, identity), 'unmeasured');
  for (const bad of [{ pid: null, panelID: 5 }, { pid: 9, panelID: null }, { pid: 9, panelID: 5.5 }])
    assert.equal(stageLive.ownedPanelOnScreen([], bad), 'unmeasured');
  const source = readFileSync(new URL('../bench/hand/stage-live.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function runLiveStage'), source.indexOf('\nasync function cacheProbe'));
  assert.match(body, /await collectLivePointerBehavior\(dump, \{ helper, session, snapshot, wait \}\)/,
    'live entry must use the same session collector exercised by hand-live-pointer');
});

test('screen-edge seats count as a front-sit retreat in the stage cost check', () => {
  for (const seat of ['edge-hang', 'floor-stand']) {
    const frontSit = ['person-window', 'pointer-near', 'pointer-recent', 'asleep', 'locked'].map(event => ({ event, seat, elapsedMs: 100 }));
    const check = stage.behaviorChecks({ frontSit }).find(c => c.name === 'front-sit retreats when watched');
    assert.equal(check.verdict, 'pass', seat);
  }
});
