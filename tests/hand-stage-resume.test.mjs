import { passingPhase, passingPacing, withPairedControls } from './fixtures/stage-cost-evidence.mjs';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, fstatSync, fsyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { collectStageEvidence, runLiveStage, makeStageLoadTracker, stageMachineId, stageCharacterIdentity } from '../bench/hand/stage-live.mjs';
import { parseArgs, SIZES, stageVerdict, reportMarkdown } from '../bench/hand/stage-cost.mjs';
import { readStagePartial, roundQualification, sealStageEvidence, stageIdentity, stageUnitOrder,
  validateStageResume, writeStagePartial } from '../bench/hand/stage-progress.mjs';

const machine = { mac: 'offline-Mac', macOS: 'offline-OS', maximumHz: 120, machineId: 'offline-machine' };
const identity = stageIdentity('a'.repeat(40), { kind: 'supplied pack', id: 'fixture', sha256: 'b'.repeat(64) }, machine);
const options = { sizes: SIZES, identity };
const order = stageUnitOrder(SIZES);
const stops = [
  ['after behavior', 'round/1/baseline/quiet/before'],
  ['after round 1', 'round/2/baseline/quiet/before'],
  ['mid-round', 'round/1/phase/medium/changing'],
  ['mid-pacing', 'round/1/pacing/small/60/600/character/timestamps'],
  ['mid-H5', 'capture/front-sit'],
];

// These fakes use the real collector's checkpoint boundary, including failed recorder evidence.
function harness({ stop, load = 2, held = false, disk } = {}) {
  const calls = [], snapshots = []; let current, closed = 0, substeps = 0, ticking = 0;
  const observe = () => ({ loadAverageMax: typeof load === 'function' ? load(current) : load, puddleWindowHeld: held });
  const perform = async value => {
    calls.push(current);
    if (current === stop) {
      substeps++;
      const error = Error(`offline stop at ${current}`);
      if (current.includes('/pacing/')) error.pacingEvidence = { ...value, ok: false, error: 'stream-stopped', frames: [{ hash: 'partial' }] };
      throw error;
    }
    return structuredClone(value);
  };
  return {
    calls, get snapshots() { return snapshots.map(value => JSON.parse(value)); }, get closed() { return closed; }, get substeps() { return substeps; },
    now: () => new Date(Date.UTC(2026, 0, 1) + ticking++).toISOString(),
    deps: {
      machine: async () => machine, behavior: () => perform({ placements: [{ seed: 17 }] }),
      baseline: surface => perform({ surface, id: current, activeS: 62, wsAvgPct: 1, wsPeakPct: 2 }),
      phase: (size, surface) => perform({ figures: { ...passingPhase(size, surface), id: current }, samples: [{ t: 1000 }],
        marks: { start: 1000 }, replay: { trace: [current] }, visibility: [{ valid: true }],
        dump: { installMs: [1], installsPerPlan: [1], planIDs: [current], unplannedInstalls: 0 } }),
      pacing: (size, hz, ms, metadata) => perform({ ...passingPacing(hz, ms, metadata), size }),
      capture: seat => perform({ seat, modes: { hidden: { samples: [{ seat, handLike: 0 }] }, visible: { samples: [{ seat, handLike: 25 }] } } }),
      qualification: () => perform(observe()), observeQualification: observe,
      checkpoint: async evidence => {
        snapshots.push(JSON.stringify(evidence));
        if (snapshots.length > 5) snapshots.splice(3, snapshots.length - 5);
        current = evidence.collection.inProgress?.id;
        if (disk) writeStagePartial(disk, evidence);
      },
      close: async () => { closed++; },
    },
  };
}
const shape = evidence => {
  const copy = JSON.parse(JSON.stringify(evidence)); delete copy.collection; return copy;
};
async function collect(h, opts = {}, collector = collectStageEvidence) {
  let timer;
  try {
    return await Promise.race([collector(h.deps, { ...options, now: h.now, ...opts }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(
        `offline stage collection timed out after ${h.calls.length} calls, last unit: ${h.calls.at(-1)}`)), 120000); })]);
  } finally { clearTimeout(timer); }
}

async function assertContinuation(collector, stop) {
  const full = harness(), expected = await collect(full);
  const first = harness({ stop });
  await assert.rejects(collect(first), /offline stop/);
  const partial = first.snapshots.at(-1), before = structuredClone(partial);
  const resumed = harness(), actual = await collect(resumed, { resumeEvidence: partial }, collector);
  assert.deepEqual(shape(actual), shape(expected), 'same final observations and judge input');
  const verdict = stageVerdict(actual), fullVerdict = stageVerdict(expected);
  for (const name of ['WindowServer added, average', 'frame pacing, 60 and 120 Hz']) {
    assert.equal(fullVerdict.runs[0].sizes.stage.checks.find(c => c.name === name).verdict, 'pass');
    assert.equal(verdict.runs[0].sizes.stage.checks.find(c => c.name === name).verdict, 'pass');
  }
  for (const key of ['attempts', 'attemptCount', 'retryCount', 'discardedCount']) { delete verdict[key]; delete fullVerdict[key]; }
  for (const result of [verdict, fullVerdict]) {
    delete result.units.retried;
    for (const check of result.behavior) { delete check.attemptCount; delete check.failures; delete check.reason; }
    for (const run of result.runs) for (const size of Object.values(run.sizes)) {
      delete size.attemptCount;
      for (const check of size.checks) delete check.reason;
    }
  }
  assert.deepEqual(verdict, fullVerdict);
  const restart = stop.includes('/pacing/') ? order.findIndex(id => id.startsWith(stop.split('/').slice(0, 6).join('/'))) : order.indexOf(stop);
  assert.deepEqual(resumed.calls, order.slice(restart), 'completed units outside an interrupted trial must never run again');
  assert.deepEqual(first.calls.slice(0, -1), order.slice(0, order.indexOf(stop)));
  assert.deepEqual(partial, before, 'the caller owns the prior checkpoint');
  assert.deepEqual(actual.collection.units.map(row => row.id), order);
  assert.deepEqual(actual.collection.units.slice(0, restart), before.collection.units.slice(0, restart));
  assert.equal(actual.collection.segments.length, 2);
  assert.ok(actual.collection.segments.every(segment => segment.startedAt && segment.endedAt));
  assert.ok(actual.collection.units.every(unit => unit.startedAt && unit.endedAt && [1, 2].includes(unit.segment)));
  assert.equal(actual.collection.attempts.length, stop.includes('/pacing/') ? order.indexOf(stop) - restart + 1 : 1);
  assert.equal(actual.collection.attempts[0].id, stop);
  assert.equal(actual.collection.units.find(row => row.id === stop).segment, 2);
  if (stop.includes('/pacing/')) {
    assert.equal(actual.collection.attempts[0].evidence.error, 'stream-stopped');
    assert.deepEqual(actual.collection.attempts[0].evidence.frames, [{ hash: 'partial' }]);
  }
  assert.equal(first.substeps, 1); assert.equal(first.closed, 1); assert.equal(resumed.closed, 1);
  validateStageResume(actual, options);
}

for (const [label, stop] of stops) test(`CHV2N resumes ${label} without repeating completed units`, async () => {
  await assertContinuation(collectStageEvidence, stop);
});

test('CHV2N checkpoint is atomic JSON on disk and refuses corrupt and legacy partials', async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-stage-resume-')));
  const first = harness({ stop: stops[2][1], disk: dir });
  await assert.rejects(collect(first), /offline stop/);
  const partial = readStagePartial(dir); validateStageResume(partial, options);
  const resumed = harness(); await collect(resumed, { resumeEvidence: partial });
  const file = join(dir, 'stage-cost.partial.json');
  writeFileSync(file, '{"schema":'); assert.throws(() => readStagePartial(dir), /resume refused/);
  for (const value of ['null', 'false', '0', '[]']) {
    writeFileSync(file, value); assert.throws(() => readStagePartial(dir), /must be an object/);
  }
  writeFileSync(file, JSON.stringify({ schema: 'sleight.stage-cost/1', runs: [] }));
  assert.throws(() => validateStageResume(readStagePartial(dir), options), /corrupted/);
  const corrupted = structuredClone(partial); corrupted.runs[0].baselines.quiet[0].wsAvgPct = 0;
  assert.throws(() => validateStageResume(corrupted, options), /checksum/);
  const malformed = structuredClone(partial); malformed.collection.units[0].id = 'capture/front-sit'; sealStageEvidence(malformed);
  assert.throws(() => validateStageResume(malformed, options), /unit order/);
});

const changes = [
  ['commit', value => { value.sourceCommit = 'c'.repeat(40); }],
  ['pack digest', value => { value.character.sha256 = 'c'.repeat(64); }],
  ['machine', value => { value.machine.machineId = 'another-machine'; }],
  ['display rate', value => { value.machine.maximumHz = 60; }],
];
async function assertRefusal(collector, change) {
  const first = harness({ stop: stops[0][1] }); await assert.rejects(collect(first), /offline stop/);
  const changed = structuredClone(identity); change(changed);
  const next = harness();
  await assert.rejects(collect(next, { identity: changed, resumeEvidence: first.snapshots.at(-1) }, collector), /resume refused.*changed/);
  assert.equal(next.calls.length, 0); assert.equal(next.snapshots.length, 0); assert.equal(next.closed, 1);
}
async function assertCorruptRefusal(collector) {
  const first = harness({ stop: stops[0][1] }); await assert.rejects(collect(first), /offline stop/);
  const corrupt = structuredClone(first.snapshots.at(-1)); corrupt.behavior.placements[0].seed = 0;
  const next = harness();
  await assert.rejects(collect(next, { resumeEvidence: corrupt }, collector), /resume refused.*checksum/);
  assert.equal(next.calls.length, 0); assert.equal(next.snapshots.length, 0);
}
for (const [label, change] of changes) test(`CHV2N refuses changed ${label} before collecting or overwriting`, async () => {
  await assertRefusal(collectStageEvidence, change);
});
test('CHV2N corrupt observations are refused before collecting or overwriting', async () => { await assertCorruptRefusal(collectStageEvidence); });
test('CHV2N null resume evidence cannot silently restart from behavior', async () => {
  const next = harness(); await assert.rejects(collect(next, { resumeEvidence: null }), /corrupted/);
  assert.deepEqual(next.calls, []); assert.deepEqual(next.snapshots, []);
});

test('CHV2N CLI resume requires owner-away and same output; dry planning remains offline', () => {
  assert.equal(parseArgs(['--owner-away', '--out', 'bank', '--resume']).resume, true);
  assert.equal(parseArgs(['--dry-run', '--owner-away', '--out', 'bank', '--resume']).resume, true);
  for (const args of [['--dry-run', '--resume'], ['--evidence', 'bank/file', '--resume'], ['--owner-away', '--resume']])
    assert.throws(() => parseArgs(args), /requires/);
});

test('CHV2N machine identity is a hardware UUID digest and refuses missing identity', async () => {
  const calls = [];
  const executeFile = async (...args) => { calls.push(args); return { stdout: '"IOPlatformUUID" = "01234567-89AB-CDEF-0123-456789ABCDEF"' }; };
  const id = await stageMachineId({ executeFile }); assert.match(id, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']]);
  assert.equal(calls[0][2].timeout, 10000); assert.equal(calls[0][2].killSignal, 'SIGKILL');
  assert.equal(await stageMachineId({ executeFile: async () => ({ stdout: '"IOPlatformUUID" = "01234567-89ab-cdef-0123-456789abcdef"' }) }), id);
  await assert.rejects(stageMachineId({ executeFile: async () => ({ stdout: 'no UUID' }) }), /cannot establish/);
});

test('CHV2N character digest binds every byte and is independent of map insertion order', () => {
  const pack = { manifest: { id: 'fixture' }, files: new Map([['b.png', Buffer.from('image')], ['character.json', Buffer.from('{}')]]) };
  const first = stageCharacterIdentity(pack, 'supplied pack'); assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(stageCharacterIdentity({ ...pack, files: new Map([...pack.files].reverse()) }, 'supplied pack'), first);
  pack.files.set('b.png', Buffer.from('another-image'));
  assert.notEqual(stageCharacterIdentity(pack, 'supplied pack').sha256, first.sha256);
});

test('CHV2N split quiet rounds retain the maximum load', async () => {
  const first = harness({ stop: stops[2][1], load: 14 }); await assert.rejects(collect(first), /offline stop/);
  const partial = first.snapshots.at(-1), next = harness({ load: 1 });
  const evidence = await collect(next, { resumeEvidence: partial });
  assert.equal(evidence.runs[0].loadAverageMax, 14); assert.equal(evidence.runs[0].puddleWindowHeld, false);
  assert.equal(evidence.runs.length, 3); assert.equal(evidence.runs[1].loadAverageMax, 1);
  assert.equal(stageVerdict(evidence).runs[0].quiet, false);
  assert.equal(evidence.collection.segments[0].rounds[1].loadAverageMax, 14);
  assert.equal(evidence.collection.segments[1].rounds[1].loadAverageMax, 1);
});

test('CHV2Q abrupt loss recollects the interrupted round and retains behavior load', async () => {
  const first = harness({ stop: stops[2][1], load: id => id === 'behavior' ? 14 : 2 }); await assert.rejects(collect(first), /offline stop/);
  const abrupt = first.snapshots.findLast(snapshot => snapshot.collection.segments[0].endedAt === null);
  const next = harness(), evidence = await collect(next, { resumeEvidence: abrupt });
  assert.equal(evidence.runs[0].loadAverageMax, 14); assert.equal(evidence.runs[0].puddleWindowHeld, false);
  assert.equal(stageVerdict(evidence).runs[0].quiet, false);
  assert.equal(next.calls[0], 'round/1/baseline/quiet/before');
  assert.deepEqual(roundQualification([{ rounds: {} }], 1), { loadAverageMax: null, puddleWindowHeld: null });
});

test('CHV2N repeated stops retry a whole H5 seat and preserve the first seat once', async () => {
  const first = harness({ stop: stops[4][1] }); await assert.rejects(collect(first), /offline stop/);
  const second = harness({ stop: stops[4][1] }); await assert.rejects(collect(second, { resumeEvidence: first.snapshots.at(-1) }), /offline stop/);
  const last = harness(), evidence = await collect(last, { resumeEvidence: second.snapshots.at(-1) });
  assert.deepEqual(second.calls, ['capture/front-sit']); assert.deepEqual(last.calls, ['capture/front-sit']);
  assert.equal(evidence.captures.length, 2); assert.equal(evidence.collection.segments.length, 3);
  assert.equal(evidence.collection.attempts.length, 2);
});

test('CHV2N completed bad pacing and visibility observations survive resume without reruns', async () => {
  const first = harness({ stop: stops[1][1] });
  const pacing = first.deps.pacing, phase = first.deps.phase;
  first.deps.pacing = async (...args) => ({ ...await pacing(...args), ok: false, error: 'completed-invalid-frames' });
  first.deps.phase = async (...args) => { const result = await phase(...args); result.figures.visibilityValid = false; return result; };
  await assert.rejects(collect(first), /offline stop/);
  const partial = first.snapshots.at(-1), next = harness();
  const evidence = await collect(next, { resumeEvidence: partial });
  assert.deepEqual(evidence.runs[0], partial.runs[0]);
  assert.equal(evidence.runs[0].sizes.stage.pacing[0].error, 'completed-invalid-frames');
  assert.equal(evidence.runs[0].sizes.stage.phases.changing.visibilityValid, false);
  assert.ok(next.calls.every(id => !id.startsWith('round/1/')));
});

// Load only a private copy of the collector. Dependencies keep their real URLs; no live entry is called.
async function brokenModule(t, mutation, module = 'stage-live.mjs') {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-stage-resume-variant-')));
  const url = new URL('../bench/hand/' + module, import.meta.url), source = readFileSync(url, 'utf8');
  const mutated = mutation(source); assert.notEqual(mutated, source, 'variant seam must match');
  const imports = mutated.replace(/from '(\.\.?\/[^']+)'/g, (_, relative) => `from '${new URL(relative, url).href}'`)
    .replace(/import\('(\.\.?\/[^']+)'\)/g, (_, relative) => `import('${new URL(relative, url).href}')`);
  const file = join(dir, 'stage-live.mjs'); writeFileSync(file, imports);
  return import(pathToFileURL(file).href);
}

const brokenCollector = async (t, mutation) => (await brokenModule(t, mutation)).collectStageEvidence;

test('CHV2N each continuation assertion kills a variant that restarts behavior and round 1', async t => {
  const broken = await brokenCollector(t, source => source.replace('if (resumeEvidence !== undefined) {', 'if (false && resumeEvidence !== undefined) {'));
  for (const [label, stop] of stops) {
    await assert.rejects(assertContinuation(broken, stop), { name: 'AssertionError' }, label);
    t.diagnostic(`restart variant rejected: ${label}`);
  }
});

test('CHV2N each identity refusal kills a variant that skips validation', async t => {
  const broken = await brokenCollector(t, source => source.replace(
    'validateStageResume(resumeEvidence, { identity, sizes, targetStress, controlLayout });', '/* broken: trust the partial identity */'));
  for (const [label, change] of changes) {
    await assert.rejects(assertRefusal(broken, change), { name: 'AssertionError' }, label);
    t.diagnostic(`identity-check bypass rejected: ${label}`);
  }
  await assert.rejects(assertCorruptRefusal(broken), { name: 'AssertionError' });
  t.diagnostic('identity-check bypass rejected: corrupted partial checksum');
});

async function assertBehaviorLoad(collector = collectStageEvidence) {
  const dynamic = () => harness({ load: id => id === 'behavior' ? 14 : 2 });
  const full = dynamic(), expected = await collect(full, {}, collector);
  const first = dynamic(); first.deps.baseline = async () => { throw Error('after behavior'); };
  await assert.rejects(collect(first, {}, collector), /after behavior/);
  const next = harness(), actual = await collect(next, { resumeEvidence: first.snapshots.at(-1) }, collector);
  assert.equal(expected.runs[0].loadAverageMax, 14);
  assert.equal(actual.runs[0].loadAverageMax, 14);
  assert.equal(actual.runs[1].loadAverageMax, 2);
  assert.equal(stageVerdict(actual).runs[0].quiet, false);
  assert.equal(stageVerdict(expected).runs[0].quiet, false);
}
test('CHV2Q behavior load counts in round 1 before and after a stop', () => assertBehaviorLoad());

function liveFake(t, { stop, load = id => id === 'behavior' ? 14 : 2, signalName, parentSignal,
  changed = {}, dirty = false, priorityError = false, held = false, earlyExit = false } = {}) {
  const out = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-stage-live-fake-')));
  const events = [], signals = new EventEmitter(), controller = new AbortController();
  const h = harness({ stop }); let current, collectorOptions, exitCode;
  const runtime = {
    platform: 'darwin', createWork: () => registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-stage-work-fake-'))),
    signalTarget: signals, setExitCode: code => { exitCode = code; },
    isHeld: () => { events.push('hold'); return held; }, readLoad: () => typeof load === 'function' ? load(current) : load,
    createGuard: () => ({
      signal: controller.signal, abort: error => { events.push('abort'); controller.abort(error); },
      execute: async (file, args) => {
        events.push(args.includes('rev-parse') ? 'source' : args.includes('status') ? 'clean' : 'compile-helper');
        return { stdout: args.includes('rev-parse') ? changed.commit ?? identity.sourceCommit : args.includes('status') && dirty ? ' M fixture' : '' };
      },
      close: async () => { events.push('guard-close'); },
    }),
    startPriority: async () => {
      events.push('priority'); if (priorityError) throw Error('nice 0 required');
      return { close: async () => { events.push('priority-close'); } };
    },
    holdAwake: () => ({ ready: Promise.resolve(), ended: earlyExit,
      close: async () => { events.push('awake-close'); } }),
    prepareCharacter: () => { events.push('character'); return { identity: { ...identity.character, ...changed.character } }; },
    machineIdentity: async () => { events.push('machine-id'); return changed.machineId ?? machine.machineId; },
    buildBench: async () => { events.push('build'); return 'offline-binary'; }, moduleCache: () => out,
    makeHelper: () => async () => { events.push('recording'); return { screenRecording: true }; },
    openFixture: async () => { events.push('probe'); return { ready: { machine: { ...machine, ...changed.machine } },
      close: async () => { events.push('probe-close'); } }; },
    collectEvidence: async (deps, opts) => {
      events.push('collect'); collectorOptions = opts;
      const fake = { ...h.deps, machine: deps.machine, roundStart: deps.roundStart,
        observeQualification: deps.observeQualification, finished: deps.finished,
        checkpoint: async evidence => {
          current = evidence.collection.inProgress?.id;
          await h.deps.checkpoint(evidence); await deps.checkpoint(evidence);
        } };
      for (const name of ['behavior', 'baseline', 'phase', 'pacing', 'capture', 'qualification']) fake[name] = async (...args) => {
        if (signalName && current?.includes('/phase/')) signals.emit(signalName);
        if (parentSignal && current?.includes('/phase/')) parentSignal.abort(Error('offline parent stopped'));
        const observed = await deps.qualification();
        if (name === 'qualification') return observed;
        const value = await h.deps[name](...args);
        return name === 'phase' ? withPairedControls(value) : value;
      };
      return collectStageEvidence(fake, { ...opts, now: h.now });
    },
  };
  return { out, h, events, signals, runtime, controller,
    get exitCode() { return exitCode; }, get collectorOptions() { return collectorOptions; },
    run: (runner = runLiveStage, extra = {}) => runner({ ownerAway: true, size: 'all', out, ...extra }, {
      runtime, signal: parentSignal?.signal,
      acquireLock: async () => { events.push('lock'); return async () => { events.push('unlock'); }; },
    }) };
}

async function assertLiveLoad(t, runner = runLiveStage) {
  const full = liveFake(t), expected = await full.run(runner);
  const first = liveFake(t, { stop: stops[0][1] }); await assert.rejects(first.run(runner), /offline stop/);
  const saved = readStagePartial(first.out), next = liveFake(t);
  writeStagePartial(next.out, saved);
  const actual = await next.run(runner, { resume: true });
  assert.equal(expected.runs[0].loadAverageMax, 14);
  assert.equal(actual.runs[0].loadAverageMax, 14);
  assert.equal(actual.runs[1].loadAverageMax, 2);
  assert.deepEqual(next.collectorOptions.identity, identity);
  assert.deepEqual(next.collectorOptions.resumeEvidence, saved);
  assert.equal(stageVerdict(actual).runs[0].quiet, false);
  assert.equal(next.events.filter(event => event === 'lock').length, 1);
  assert.ok(next.events.indexOf('hold') < next.events.indexOf('lock'));
  assert.ok(next.events.indexOf('lock') < next.events.indexOf('priority'));
  assert.ok(next.events.indexOf('priority') < next.events.indexOf('collect'));
  assert.ok(next.events.indexOf('recording') < next.events.indexOf('collect'));
}
test('CHV2Q runLiveStage resumes with the real load closures and identity wiring', t => assertLiveLoad(t));

test('CHV2Q load and behavior assertions reject broken wiring', async t => {
  const broken = await brokenModule(t, source => source.replace('observeQualification: loadTracker.observe,',
    'observeQualification: () => ({ loadAverageMax: 0, puddleWindowHeld: false }),'));
  await assert.rejects(assertLiveLoad(t, broken.runLiveStage), { name: 'AssertionError' });
  const lost = await brokenModule(t, source => source.replace('activeBehavior = true;', 'activeBehavior = false;'));
  await assert.rejects(assertBehaviorLoad(lost.collectStageEvidence), { name: 'AssertionError' });
});

const liveChanges = [
  ['source', { commit: 'c'.repeat(40) }, /source commit changed/, 'build'],
  ['pack', { character: { sha256: 'c'.repeat(64) } }, /pack digest changed/, 'build'],
  ['hardware', { machineId: 'other-machine' }, /machine changed/, 'build'],
  ['display', { machine: { maximumHz: 60 } }, /display rate changed/, 'collect'],
  ['OS', { machine: { macOS: 'other-OS' } }, /display rate changed/, 'collect'],
];
async function assertLiveIdentity(t, runner = runLiveStage, selected = liveChanges) {
  const first = liveFake(t, { stop: stops[0][1] }); await assert.rejects(first.run(runner), /offline stop/);
  const saved = readStagePartial(first.out);
  for (const [label, changed, refusal, before] of selected) {
    const next = liveFake(t, { changed }); writeStagePartial(next.out, saved);
    const bytes = readFileSync(join(next.out, 'stage-cost.partial.json'), 'utf8');
    await assert.rejects(next.run(runner, { resume: true }), refusal, label);
    assert.ok(!next.events.includes(before), label);
    assert.equal(readFileSync(join(next.out, 'stage-cost.partial.json'), 'utf8'), bytes);
    assert.equal(next.events.filter(event => event === 'unlock').length, 1);
  }
  const dirty = liveFake(t, { dirty: true }); writeStagePartial(dirty.out, saved);
  await assert.rejects(dirty.run(runner, { resume: true }), /clean committed/);
  assert.ok(!dirty.events.includes('build'));
}
test('CHV2Q runLiveStage refuses changed live identities and dirty source before collection', t => assertLiveIdentity(t));
test('CHV2Q live identity assertion rejects a variant forwarding the stored identity', async t => {
  const broken = await brokenModule(t, source => source
    .replace(/if \(resumeEvidence && resumeEvidence.collection.identity.sourceCommit !== sourceCommit\)/, 'if (false)')
    .replace(/if \(resumeEvidence && JSON.stringify\(resumeEvidence.collection.identity.character\) !== JSON.stringify\(character.identity\)\)/, 'if (false)')
    .replace(/if \(resumeEvidence && resumeEvidence.collection.identity.machine.machineId !== machineId\)/, 'if (false)')
    .replace('if (resumeEvidence) validateStageResume(resumeEvidence, { identity, sizes, targetStress: opts.targetStress === true, controlLayout: STAGE_CONTROL_LAYOUT });', '')
    .replace('}, { sizes, identity,', '}, { sizes, identity: resumeEvidence?.collection.identity ?? identity,'));
  for (const change of liveChanges) await assert.rejects(assertLiveIdentity(t, broken.runLiveStage, [change]), { name: 'AssertionError' });
});

async function assertExistingRefusal(t, runner = runLiveStage) {
  for (const file of ['stage-cost.partial.json', 'stage-cost.json']) {
    const next = liveFake(t); writeFileSync(join(next.out, file), '{}');
    await assert.rejects(next.run(runner), /already contains evidence.*--resume/);
    assert.deepEqual(next.events, []);
    assert.equal(readFileSync(join(next.out, file), 'utf8'), '{}');
  }
}
test('CHV2Q runLiveStage refuses existing evidence without resume before acquiring a lock', t => assertExistingRefusal(t));
test('CHV2Q existing-evidence assertion rejects the overwrite variant', async t => {
  const broken = await brokenModule(t, source => source.replace('if (!opts.resume && (existsSync(', 'if (false && (existsSync('));
  await assert.rejects(assertExistingRefusal(t, broken.runLiveStage), { name: 'AssertionError' });
});

async function assertLiveSignals(t, runner = runLiveStage) {
  for (const [signalName, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const next = liveFake(t, { signalName });
    await assert.rejects(next.run(runner), new RegExp(signalName));
    const saved = readStagePartial(next.out);
    assert.match(saved.error, new RegExp(signalName));
    assert.equal(next.exitCode, code);
    assert.ok(next.controller.signal.aborted);
    assert.ok(next.events.indexOf('abort') < next.events.indexOf('guard-close'));
    assert.ok(next.events.indexOf('guard-close') < next.events.indexOf('unlock'));
    assert.equal(next.events.filter(event => event === 'unlock').length, 1);
    assert.ok(['SIGINT', 'SIGTERM', 'SIGHUP'].every(name => next.signals.listenerCount(name) === 0));
  }
}
test('CHV2Q runLiveStage signal handlers abort, checkpoint, clean up and preserve the exit code', t => assertLiveSignals(t));
test('CHV2Q signal assertion rejects a handler that ignores the interrupt', async t => {
  const broken = await brokenModule(t, source => source.replace('guard.abort(Error(`stage run interrupted by ${name}`));', '/* broken: ignore the signal */'));
  await assert.rejects(assertLiveSignals(t, broken.runLiveStage), { name: 'AssertionError' });
});

async function assertLivePreconditions(t, runner = runLiveStage) {
  const parentSignal = new AbortController(), parent = liveFake(t, { parentSignal });
  await assert.rejects(parent.run(runner), /offline parent stopped/);
  assert.ok(parent.controller.signal.aborted); assert.equal(parent.exitCode, undefined);
  for (const [opts, refusal] of [[{ held: true }, /sleight-hold exists/], [{ priorityError: true }, /nice 0 required/],
    [{ earlyExit: true }, /sleep assertion exited/]]) {
    const next = liveFake(t, opts); await assert.rejects(next.run(runner), refusal);
    if (opts.held) assert.ok(!next.events.includes('lock'));
    if (opts.priorityError) assert.ok(!next.events.includes('build'));
  }
}
test('CHV2Q runLiveStage parent abort and precondition failures never use real host dependencies', t => assertLivePreconditions(t));
test('CHV2Q precondition assertion rejects a variant ignoring the parent abort', async t => {
  const broken = await brokenModule(t, source => source.replace(
    "const parentAbort = () => guard.abort(signal.reason ?? Error('stage parent interrupted'));",
    'const parentAbort = () => {};'));
  await assert.rejects(assertLivePreconditions(t, broken.runLiveStage), { name: 'AssertionError' });
});

async function assertRoundRecollection(collector = collectStageEvidence, mode = 'abrupt', stop = 'round/2/pacing/medium/60/600/character/timestamps') {
  const first = harness({ stop }); await assert.rejects(collect(first), /offline stop/);
  const partial = structuredClone(mode === 'abrupt' ? first.snapshots.findLast(snapshot => snapshot.collection.segments[0].endedAt === null) : first.snapshots.at(-1));
  if (mode === 'hold') { partial.collection.segments[0].rounds[2].puddleWindowHeld = true; sealStageEvidence(partial); }
  if (mode === 'missing') { partial.collection.segments[0].rounds[2].loadAverageMax = null; sealStageEvidence(partial); }
  const oldRound = structuredClone(partial.runs[0]);
  const oldUnits = partial.collection.units.filter(unit => unit.id.startsWith('round/2/'));
  const oldEarlier = partial.collection.units.filter(unit => !unit.id.startsWith('round/2/'));
  const next = harness(), actual = await collect(next, { resumeEvidence: partial }, collector);
  assert.equal(next.calls[0], 'round/2/baseline/quiet/before');
  assert.deepEqual(next.calls, order.slice(order.indexOf('round/2/baseline/quiet/before')));
  assert.deepEqual(actual.runs[0], oldRound);
  assert.deepEqual(actual.collection.units.slice(0, oldEarlier.length), oldEarlier);
  assert.deepEqual(actual.behavior, partial.behavior);
  assert.equal(actual.runs[1].loadAverageMax, 2);
  assert.equal(stageVerdict(actual).runs[1].quiet, true);
  const discarded = actual.collection.attempts.filter(attempt => attempt.discarded);
  assert.deepEqual(discarded.map(attempt => attempt.id), [...oldUnits.map(unit => unit.id), stop]);
  assert.ok(discarded.every(attempt => attempt.error));
  assert.ok(discarded.filter(attempt => !attempt.interrupted).every(attempt => attempt.evidence));
  assert.ok(actual.collection.units.filter(unit => unit.id.startsWith('round/2/')).every(unit => unit.segment === 2));
  validateStageResume(actual, options);
  return actual;
}
for (const mode of ['abrupt', 'hold', 'missing']) test(`CHV2Q ${mode} load loss recollects round 2 and keeps behavior and round 1`, () => assertRoundRecollection(collectStageEvidence, mode));
test('CHV2Q abrupt phase and baseline stops also recollect the entire stopped round', async () => {
  for (const stop of ['round/2/phase/medium/changing', 'round/2/baseline/quiet/after']) await assertRoundRecollection(collectStageEvidence, 'abrupt', stop);
});
test('CHV2Q recollection assertions reject a variant that retains partial rounds', async t => {
  const broken = await brokenCollector(t, source => source.replace('discardUnobservedRound(evidence);', '/* broken: keep the lost round */'));
  for (const mode of ['abrupt', 'hold', 'missing']) await assert.rejects(assertRoundRecollection(broken, mode), { name: 'AssertionError' });
});

async function assertUnitBindings(validator = validateStageResume) {
  const full = await collect(harness());
  const changes = [
    ['behavior', e => { e.behavior = {}; }],
    ['baseline', e => { e.runs[0].baselines.quiet[0] = null; }],
    ['phase', e => { delete e.runs[0].sizes.small.phases.quiet; }],
    ['pacing', e => { e.runs[0].sizes.small.pacing[0].durationMs = 999; }],
    ['capture', e => { e.captures[0].seat = 'front-sit'; }],
    ['qualification', e => { delete e.runs[0].loadAverageMax; }],
    ['modified data', e => { e.runs[0].baselines.quiet[0].wsAvgPct = 0; }],
    ['misplaced data', e => { const b = e.runs[0].baselines; [b.quiet[0], b.changing[0]] = [b.changing[0], b.quiet[0]]; }],
    ['unlisted data', e => { e.collection.units.pop(); }],
  ];
  for (const [label, change] of changes) {
    const bad = structuredClone(full); change(bad); sealStageEvidence(bad);
    assert.throws(() => validator(bad, options), /unit data disagrees|corrupted round or capture structure/, label);
  }
}
test('CHV2Q completed unit IDs must match their stored observations even after resealing', () => assertUnitBindings());
test('CHV2Q unit binding assertion rejects a variant checking only the checksum and order', async t => {
  const broken = await brokenModule(t, source => source.replace('for (const id of order) {', 'for (const id of []) {'), 'stage-progress.mjs');
  await assert.rejects(assertUnitBindings(broken.validateStageResume), { name: 'AssertionError' });
});

async function assertAtomicWrite(t, writer = writeStagePartial) {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-stage-atomic-')));
  const saved = await collect(harness()), file = join(dir, 'stage-cost.partial.json');
  writer(dir, saved); const before = readFileSync(file, 'utf8');
  const replacement = structuredClone(saved); replacement.collection.attempts.push({ id: 'capture/front-sit', error: 'offline failure' });
  assert.throws(() => writer(dir, replacement, { beforeRename: temp => {
    assert.ok(readFileSync(temp, 'utf8').includes('offline failure'));
    throw Object.assign(Error('injected failure after temporary write'), { code: 'EIO' });
  } }), /injected failure/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(readdirSync(dir), ['stage-cost.partial.json']);
  validateStageResume(readStagePartial(dir), options);
}
test('CHV2Q atomic write failure before rename preserves the previous file and removes the temp', t => assertAtomicWrite(t));
test('CHV2Q atomic write assertion rejects a variant omitting the failure boundary', async t => {
  const broken = await brokenModule(t, source => source.replace('beforeRename(temp, file);', ''), 'stage-progress.mjs');
  await assert.rejects(assertAtomicWrite(t, broken.writeStagePartial), { name: 'AssertionError' });
});
async function assertDirectorySync(t, writer = writeStagePartial) {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-stage-durable-'))), events = [];
  writer(dir, await collect(harness()), { beforeRename: () => { events.push('rename-next'); },
    sync: fd => { events.push(fstatSync(fd).isDirectory() ? 'directory' : 'file'); fsyncSync(fd); } });
  assert.deepEqual(events, ['file', 'rename-next', 'directory']);
}
test('CHV2Q checkpoint fsyncs its directory after the atomic rename', t => assertDirectorySync(t));
test('CHV2Q directory durability assertion rejects a variant syncing only the file', async t => {
  const broken = await brokenModule(t, source => source.replace("fd = openSync(out, 'r'); sync(fd); closeSync(fd); fd = undefined;", ''), 'stage-progress.mjs');
  await assert.rejects(assertDirectorySync(t, broken.writeStagePartial), { name: 'AssertionError' });
});

function assertOnlyDowngrades(before, after) {
  for (let i = 0; i < before.length; i++) for (const size of SIZES) {
    const a = before[i].sizes[size].checks, b = after[i].sizes[size].checks;
    for (let j = 0; j < a.length; j++) assert.ok(a[j].verdict === b[j].verdict ||
      a[j].verdict === 'pass' && b[j].verdict === 'not-measured', a[j].name);
  }
}

async function assertAttemptReporting(judge = stageVerdict, report = reportMarkdown) {
  const first = harness({ stop: stops[3][1] }); await assert.rejects(collect(first), /offline stop/);
  const evidence = await collect(harness(), { resumeEvidence: first.snapshots.at(-1) });
  const result = judge(evidence), markdown = report(result);
  assert.equal(result.attemptCount, 3); assert.equal(result.retryCount, 1);
  assert.equal(result.discardedCount, 2);
  assert.equal(result.attempts[0].unit, stops[3][1]);
  assert.match(result.attempts[0].failure, /offline stop/);
  assert.match(markdown, /Prior attempts: 3/);
  assert.ok(markdown.includes(stops[3][1])); assert.ok(markdown.includes('offline stop'));
  const discarded = await assertRoundRecollection(), judged = judge(discarded), text = report(judged);
  assert.equal(judged.discardedCount, discarded.collection.attempts.length);
  assert.ok(text.includes('discarded partial round'));
  assert.ok(text.includes('round/2/baseline/quiet/before'));
  const noHistory = structuredClone(discarded); noHistory.collection.attempts = [];
  const clean = judge(noHistory);
  assert.equal(judged.verdict, clean.verdict);
  assertOnlyDowngrades(judged.runs, clean.runs); assert.deepEqual(judged.budget, clean.budget);
}
test('CHV2Q judge and markdown report retries and discarded units without changing a bar', () => assertAttemptReporting());
test('CHV2Q attempt reporting assertion rejects a judge that hides history', async t => {
  const broken = await brokenModule(t, source => source.replace('list(evidence.collection?.attempts).map', '[].map'), 'stage-cost.mjs');
  await assert.rejects(assertAttemptReporting(broken.stageVerdict, broken.reportMarkdown), { name: 'AssertionError' });
});

async function assertImmediateBehavior(collector = collectStageEvidence) {
  const first = harness({ stop: stops[0][1], load: id => id === 'behavior' ? 19 : 2 });
  await assert.rejects(collect(first, {}, collector), /offline stop/);
  const immediate = first.snapshots.find(snapshot => snapshot.collection.units.length === 1 && !snapshot.collection.inProgress);
  assert.deepEqual(immediate.collection.segments[0].rounds, {});
  assert.equal(immediate.collection.segments[0].endedAt, null);
  const next = harness(), actual = await collect(next, { resumeEvidence: immediate }, collector);
  assert.equal(actual.runs[0].loadAverageMax, 19);
  assert.equal(actual.runs[1].loadAverageMax, 2);
  assert.deepEqual(actual.behavior, immediate.behavior);
  assert.equal(next.calls[0], 'round/1/baseline/quiet/before');
}
test('CHV2Q stop at the behavior checkpoint keeps behavior load before any round begins', () => assertImmediateBehavior());
test('CHV2Q immediate behavior assertion rejects a variant that forgets its load row', async t => {
  const broken = await brokenCollector(t, source => source.replace('activeBehavior = true;', 'activeBehavior = false;'));
  await assert.rejects(assertImmediateBehavior(broken), { name: 'AssertionError' });
});

async function assertTracker(trackerFactory = makeStageLoadTracker) {
  let load = 3, held = false;
  const tracker = trackerFactory({ readLoad: () => load, isHeld: () => held });
  tracker.qualify(); load = 15; tracker.qualify(); load = 2; tracker.qualify();
  assert.equal(tracker.observe().loadAverageMax, 15);
  tracker.roundStart(); assert.equal(tracker.observe().loadAverageMax, 2);
  load = NaN; tracker.qualify(); load = 1; tracker.qualify();
  assert.ok(!Number.isFinite(tracker.observe().loadAverageMax));
  tracker.roundStart(); held = true;
  assert.throws(() => tracker.qualify(), /quiet window ended/);
  assert.equal(tracker.observe().puddleWindowHeld, true);
}
test('CHV2Q load tracker retains peaks and unknown samples and observes a hold', () => assertTracker());
test('CHV2Q tracker assertion rejects a last-observation-only variant', async t => {
  const broken = await brokenModule(t, source => source.replace('Math.max(loadAverageMax, load)', 'load'));
  await assert.rejects(assertTracker(broken.makeStageLoadTracker), { name: 'AssertionError' });
});

async function assertSplitQualification(qualify = roundQualification) {
  const row = (loadAverageMax, puddleWindowHeld = false) => ({ loadAverageMax, puddleWindowHeld, endedAt: '2026-01-01T00:00:00Z' });
  const segments = [{ behavior: row(12), rounds: { 1: row(3), 2: row(18) } }, { rounds: { 1: row(2), 2: row(4) } }];
  assert.equal(qualify(segments, 1).loadAverageMax, 12);
  assert.equal(qualify(segments, 2).loadAverageMax, 18);
  segments[0].behavior.endedAt = null;
  assert.equal(qualify(segments, 1).loadAverageMax, null);
  segments[0].behavior = row(NaN);
  assert.equal(qualify(segments, 1).loadAverageMax, null);
  segments[0].behavior = row(3, true);
  assert.equal(qualify(segments, 1).puddleWindowHeld, true);
}
test('CHV2Q qualification requires finite completed behavior observations and every retained segment', () => assertSplitQualification());
test('CHV2Q qualification assertions reject behavior omission and last-segment-only variants', async t => {
  for (const mutation of [source => source.replace('round === 1 && segment.behavior', 'false && segment.behavior'),
    source => source.replace('segments.flatMap', 'segments.slice(-1).flatMap')]) {
    const broken = await brokenModule(t, mutation, 'stage-progress.mjs');
    await assert.rejects(assertSplitQualification(broken.roundQualification), { name: 'AssertionError' });
  }
});

// Keep failed recorder payloads in attempts, outside the canonical completed-unit data.
for (const arm of ['character/hash', 'numbered/hash', 'character/timestamps', 'numbered/timestamps']) {
  test(`CHV2R failed ${arm} arm survives a second stop before retry`, async () => {
    const stop = `round/1/pacing/small/60/600/${arm}`;
    const first = harness({ stop }); await assert.rejects(collect(first), /offline stop/);
    const second = harness(); second.deps.roundStart = () => { throw Error('second stop before retry'); };
    await assert.rejects(collect(second, { resumeEvidence: first.snapshots.at(-1) }), /second stop/);
    const boundary = second.snapshots[0], stopped = second.snapshots.at(-1);
    for (const checkpoint of [boundary, stopped]) {
      validateStageResume(checkpoint, options);
      const last = harness(), evidence = await collect(last, { resumeEvidence: checkpoint });
      const start = order.findIndex(id => id.startsWith(stop.split('/').slice(0, 6).join('/')));
      assert.equal(last.calls[0], order[start]);
      assert.deepEqual(last.calls, order.slice(start));
      assert.equal(evidence.collection.attempts[0].id, stop);
      assert.equal(evidence.collection.attempts[0].evidence.error, 'stream-stopped');
      assert.deepEqual(evidence.collection.attempts[0].evidence.frames, [{ hash: 'partial' }]);
      validateStageResume(evidence, options);
    }
  });
}

for (const mode of ['abrupt', 'hold', 'missing']) {
  test(`CHV2R ${mode} behavior stop discards its load row and starts behavior again`, async () => {
    const first = harness({ stop: 'behavior', load: 14, held: mode === 'hold' });
    await assert.rejects(collect(first), /offline stop/);
    const partial = structuredClone(mode === 'abrupt' ? first.snapshots[1] : first.snapshots.at(-1));
    if (mode === 'missing') { partial.collection.segments[0].behavior.loadAverageMax = null; sealStageEvidence(partial); }
    const oldRow = structuredClone(partial.collection.segments[0].behavior);
    const second = harness(), actual = await collect(second, { resumeEvidence: partial });
    assert.equal(second.calls[0], 'behavior');
    assert.equal(actual.runs[0].loadAverageMax, 2);
    assert.equal(stageVerdict(actual).runs[0].quiet, true);
    assert.equal(actual.collection.segments[0].behavior.discarded, true);
    assert.equal(actual.collection.attempts.length, 1);
    const attempt = actual.collection.attempts[0];
    assert.equal(attempt.id, 'behavior'); assert.equal(attempt.discarded, true);
    assert.deepEqual(attempt.loadObservations, [{ segment: 1, ...oldRow }]);
    assert.equal(attempt.observedLoadAverageMax, mode === 'missing' ? null : 14);
    assert.equal(attempt.observedHeld, mode === 'hold');
    // A crash at the next segment-start checkpoint must not reintroduce the discarded row.
    const third = harness(), again = await collect(third, { resumeEvidence: second.snapshots[0] });
    assert.equal(third.calls[0], 'behavior');
    assert.equal(again.runs[0].loadAverageMax, 2);
    assert.equal(again.collection.attempts.length, 1);
    validateStageResume(again, options);
  });
}

for (const [label, mutate] of [
  ['dump', e => { e.runs[0].sizes.small.dump.unplannedInstalls = 99; }],
  ['machine', e => { e.machine.macOS = 'changed-OS'; }],
]) test(`CHV2R resealed changed ${label} refuses before collection`, async () => {
  const full = await collect(harness()), corrupt = structuredClone(full); mutate(corrupt); sealStageEvidence(corrupt);
  const next = harness();
  await assert.rejects(collect(next, { resumeEvidence: corrupt }), /resume refused/);
  assert.deepEqual(next.calls, []); assert.deepEqual(next.snapshots, []);
});

for (const mode of ['abrupt', 'hold', 'missing']) {
  test(`CHV2R discarded ${mode} round reports the observed peak and hold`, async () => {
    const stop = 'round/2/phase/medium/changing', first = harness({ stop, load: 14 });
    await assert.rejects(collect(first), /offline stop/);
    const partial = structuredClone(mode === 'abrupt' ? first.snapshots.findLast(s => s.collection.segments[0].endedAt === null) : first.snapshots.at(-1));
    const row = partial.collection.segments[0].rounds[2];
    if (mode === 'hold') row.puddleWindowHeld = true;
    if (mode === 'missing') row.loadAverageMax = null;
    sealStageEvidence(partial);
    const actual = await collect(harness(), { resumeEvidence: partial });
    const discarded = actual.collection.attempts.filter(attempt => attempt.discarded);
    assert.ok(discarded.length > 1);
    for (const attempt of discarded) {
      assert.equal(attempt.observedLoadAverageMax, mode === 'missing' ? null : 14);
      assert.equal(attempt.observedHeld, mode === 'hold');
      assert.deepEqual(attempt.loadObservations, [{ segment: 1, ...row }]);
    }
    const judged = stageVerdict(actual), markdown = reportMarkdown(judged);
    const summaries = judged.attempts.filter(attempt => attempt.discarded);
    assert.ok(summaries.every(attempt => attempt.observedLoadAverageMax === (mode === 'missing' ? null : 14)));
    assert.ok(summaries.every(attempt => attempt.observedHeld === (mode === 'hold')));
    assert.ok(markdown.includes(`observed load maximum ${mode === 'missing' ? 'unknown' : '14'}; observed held ${mode === 'hold'}`));
    assert.equal(actual.runs[0].loadAverageMax, 14, 'completed behavior and round 1 remain strict');
    assert.equal(actual.runs[1].loadAverageMax, 2);
    assert.equal(stageVerdict(actual).runs[0].quiet, false);
    const clean = structuredClone(actual); clean.collection.attempts = [];
    assertOnlyDowngrades(stageVerdict(actual).runs, stageVerdict(clean).runs);
    assert.equal(stageVerdict(actual).verdict, stageVerdict(clean).verdict);
  });
}

test('CHV2R a transient unknown load remains lost until the round is recollected', async () => {
  const transient = stop => {
    const h = harness({ stop }), observe = h.deps.observeQualification; let calls = 0;
    h.deps.observeQualification = () => (++calls === 4 ? { loadAverageMax: NaN, puddleWindowHeld: false } : observe());
    return h;
  };
  const first = transient(stops[2][1]);
  await assert.rejects(collect(first), /offline stop/);
  assert.equal(first.snapshots.at(-1).collection.segments[0].rounds[1].loadAverageMax, null);
  const next = harness(), actual = await collect(next, { resumeEvidence: first.snapshots.at(-1) });
  assert.equal(next.calls[0], 'round/1/baseline/quiet/before');
  assert.equal(actual.runs[0].loadAverageMax, 2);
  const full = await collect(transient());
  assert.equal(full.runs[0].loadAverageMax, null, 'qualification cannot overwrite a lost observation with a finite value');
  assert.equal(stageVerdict(full).runs[0].quiet, false);
  assert.equal(full.runs[1].loadAverageMax, 2);
});

test('CHV2R uninterrupted reports omit the empty attempt summary', async () => {
  assert.doesNotMatch(reportMarkdown(stageVerdict(await collect(harness()))), /Prior attempts:/);
});
