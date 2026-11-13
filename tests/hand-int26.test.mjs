import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import * as live from '../bench/hand/stage-live.mjs';
import * as progress from '../bench/hand/stage-progress.mjs';
import * as surface from '../bench/hand/stage-surface.mjs';
import { stageSurfaceFixture } from './fixtures/stage-surface.mjs';

async function mutant(t, file, before, after) {
  const url = new URL('../bench/hand/' + file, import.meta.url), source = readFileSync(url, 'utf8');
  assert.ok(source.includes(before), 'mutation site');
  const changed = source.replace(before, after).replace(/from '(\.\.?\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`)
    .replace(/import\('(\.\.?\/[^']+)'\)/g, (_, path) => `import('${new URL(path, url).href}')`);
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-int26-'))), target = join(dir, file);
  writeFileSync(target, changed); return import(pathToFileURL(target).href);
}
const shown = () => ({ shown: true, panelID: 44, panelGenerations: 1, hideReasonCounts: { call: 0 } });
async function recorderAssertion(module, change) {
  const before = shown(), after = change(shown());
  const session = { rows: [], request: async () => after };
  const recorder = { rows: [], wait: async () => ({ ok: false, error: 'stream-stopped' }) };
  await assert.rejects(module.recordPacingMotion(session, recorder, before), error => {
    assert.equal(error.unitFailureKind, 'visibility'); return true;
  });
}
for (const [name, change] of [
  ['hide then re-show', r => ({ ...r, hideReasonCounts: { call: 1 } })],
  ['panel generation changed', r => ({ ...r, panelGenerations: 2 })],
  ['missing final query', () => undefined],
  ['missing counters', r => ({ ...r, hideReasonCounts: undefined })],
]) {
  test(`INT26 recorder classifies ${name} as product visibility`, () => recorderAssertion(live, change));
  test(`INT26 broken recorder continuity: ${name}`, async t => {
    const broken = await mutant(t, 'stage-live.mjs', '!pacingVisibilityContinuous(metadata, partial.failureQuery)', 'false');
    await assert.rejects(recorderAssertion(broken, change), { name: 'AssertionError' });
  });
}
test('INT26 recorder needs positive continuity to remain a harness fault', async () => {
  await assert.rejects(live.recordPacingMotion({ rows: [], request: async () => shown() },
    { rows: [], wait: async () => ({ ok: false, error: 'recorder-error' }) }, shown()),
  e => e.unitFailureKind === 'pacing-recorder');
});
async function windowsAssertion(module, after, kind) {
  await assert.rejects(module.pacingPanelWindows({ pid: 42, request: async () => after }, shown(), async () => ({ windows: [] })),
    e => { assert.equal(e.unitFailureKind, kind); return true; });
}
test('INT26 missing owned window uses the same visibility continuity evidence', async () => {
  await windowsAssertion(live, { ...shown(), hideReasonCounts: { call: 1 } }, 'visibility');
  await windowsAssertion(live, undefined, 'visibility');
  await windowsAssertion(live, shown(), 'fixture-seat');
});
test('INT26 broken missing-window attribution', async t => {
  const broken = await mutant(t, 'stage-live.mjs', "pacingVisibilityContinuous(snapshot, failureQuery) ? 'fixture-seat' : 'visibility'", "'fixture-seat'");
  await assert.rejects(windowsAssertion(broken, undefined, 'visibility'), { name: 'AssertionError' });
});
async function capAssertion(module) {
  const attempts = [1, 2, 3].map(attempt => ({ id: 'behavior', attempt, interrupted: true }));
  attempts.push({ id: 'behavior', attempt: 4, status: 'failed', discarded: true });
  assert.equal(module.stageFailureAttempts({ attempts }, 'behavior'), 0);
  attempts.push({ id: 'behavior', attempt: 5, status: 'failed' });
  assert.equal(module.stageFailureAttempts({ attempts }, 'behavior'), 1);
}
test('INT26 retry cap excludes stops and discarded failures', () => capAssertion(progress));
test('INT26 broken retry cap accounting', async t => {
  const broken = await mutant(t, 'stage-progress.mjs', "row.status === 'failed' && !row.discarded && !row.interrupted", 'true');
  await assert.rejects(capAssertion(broken), { name: 'AssertionError' });
});
async function surfaceAssertion(module, surfaceName) {
  const c = stageSurfaceFixture({ surface: surfaceName }); c.windowServerPid = 88;
  const overlay = { id: 888, pid: 88, owner: 'WindowServer', layer: 2147483630, alpha: 1,
    bounds: { x: c.panel.x, y: c.panel.y, width: 20, height: 20 } };
  c.windows.unshift(overlay);
  let result = module.stageSurfaceObservation(c, c, c);
  assert.equal(result.valid, true); assert.match(result.interfering[0].reason, /WindowServer/);
  overlay.owner = 'other app'; assert.equal(module.stageSurfaceObservation(c, c, c).valid, false);
  overlay.owner = 'Window Server';
  assert.equal(module.stageSurfaceObservation(c, c, c).valid, true, 'current macOS spells the owner "Window Server"');
  c.windowServerPid = null;
  assert.equal(module.stageSurfaceObservation(c, c, c).valid, false, 'an unverified WindowServer pid exempts nothing');
  c.windowServerPid = 88;
  overlay.owner = 'WindowServer'; overlay.pid = 89; assert.equal(module.stageSurfaceObservation(c, c, c).valid, false);
  overlay.pid = 88; overlay.bounds = { ...c.backdrop.bounds }; overlay.alpha = 1;
  assert.equal(module.stageSurfaceObservation(c, c, c).valid, false, 'opaque content covering the panel is interference');
  overlay.alpha = 0.5; assert.equal(module.stageSurfaceObservation(c, c, c).valid, true);
}
for (const name of ['quiet', 'changing']) {
  test(`INT26 ${name} distinguishes WindowServer overlays from app content`, () => surfaceAssertion(surface, name));
  test(`INT26 broken ${name} WindowServer exemption`, async t => {
    const broken = await mutant(t, 'stage-surface.mjs', 'invalidates: !server || opaqueContent', 'invalidates: true');
    await assert.rejects(surfaceAssertion(broken, name), { name: 'AssertionError' });
  });
}
async function boundaryAssertion(module) {
  await assert.rejects(module.stageMeasurementBoundary('fixture-seat', async () => { throw Error('control refused'); }), e => e.unitFailureKind === 'fixture-seat');
  await assert.rejects(module.stageMeasurementBoundary('child', async () => { throw Object.assign(Error('parked changed'), { invalidVisibility: { first: 1 } }); }), e => e.unitFailureKind === 'visibility');
  await assert.rejects(module.stageMeasurementBoundary('child', async () => { throw progress.stageUnitFailure('host-crash', 'host died'); }), e => e.unitFailureKind === 'host-crash');
  await assert.rejects(module.stageMeasurementBoundary('child', async () => { throw TypeError('bug'); }), e => e instanceof TypeError && !e.unitFailureKind);
  await assert.rejects(module.stageMeasuredSurface({ session: { request: async () => ({}) }, helper: async () => ({}), surface: 'quiet', now: () => 1, log() {} }), e => e.unitFailureKind === 'fixture-seat');
}
test('INT26 measurement refusals are unit-local and product failures retain their kind', () => boundaryAssertion(live));
test('INT26 broken measurement refusal boundary', async t => {
  const broken = await mutant(t, 'stage-live.mjs', 'throw stageUnitFailure(kind, error.message, error.unitEvidence);', 'throw error;');
  await assert.rejects(boundaryAssertion(broken), { name: 'AssertionError' });
});
async function dumpAssertion(module) {
  const spawnChild = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.write = () => {}; child.stdin.end = () => {};
    child.kill = () => {};
    setImmediate(() => child.emit('close', 7, null)); return child;
  };
  await assert.rejects(module.dumpRows('offline', {}, [], { spawnChild }), e => { assert.equal(e.unitFailureKind, 'host-crash'); return true; });
  await assert.rejects(module.cacheProbe('offline', { root: join(tmpdir(), 'int26-fixture') }, spawnChild), e => { assert.equal(e.unitFailureKind, 'host-crash'); return true; });
}
test('INT26 dump and cache product host nonzero exits are host-crash', () => dumpAssertion(live));
test('INT26 broken dump host crash classification', async t => {
  const broken = await mutant(t, 'stage-live.mjs', "stageUnitFailure('host-crash', `stage dump exited", "stageUnitFailure('child', `stage dump exited");
  await assert.rejects(dumpAssertion(broken), { name: 'AssertionError' });
});
async function seatAssertion(module) {
  let elapsed = 0;
  const session = { ready: { windows: [{ pid: 42, id: 7, bounds: { x: 0, y: 0, width: 10, height: 10 } }] },
    wire: { aim: () => '' }, write() {}, size: 'stage', rows: Array.from({ length: 300 }, (_, i) => ({ reply: 'query', query: i })),
    request: async () => ({ callMonitor: { state: 'timeout', lastSuccessfulState: 'quiet', lastSuccessAgeMs: 999 } }) };
  await assert.rejects(module.seedFixture(session, { clock: () => elapsed, wait: async ms => { elapsed += ms; } }), e => {
    assert.equal(e.unitFailureKind, 'prepare-refusal'); assert.equal(e.unitEvidence.waitedMs, 3000);
    assert.equal(e.unitEvidence.rows.length, 20); assert.equal(e.unitEvidence.queryRowCount, 300);
    assert.equal(e.unitEvidence.monitorStates[0].lastSuccessfulState, 'quiet'); return true;
  });
}
test('INT26 seat failure evidence keeps twenty rows and the last confirmed microphone state', () => seatAssertion(live));
test('INT26 broken seat evidence bound', async t => {
  const broken = await mutant(t, 'stage-live.mjs', "rows: session.rows?.filter(row => row.reply === 'query').slice(-20)", 'rows: session.rows');
  await assert.rejects(seatAssertion(broken), { name: 'AssertionError' });
});

test('INT26 live query exports numeric panel generations and trail installation consults the call monitor', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const check = text => {
    assert.match(text, /"panelGenerations": panelGenerations, "hideReasonCounts": stage.hideReasonCounts/);
    assert.match(text, /if self.panel == nil \{ panelGenerations \+= 1 \}/);
    assert.match(text, /if let sprite = plan.sprite, !perch.legacyCallBlocked\(\)/);
    assert.match(text, /self.host\?\.hideRingCharacter\(\); self.hideLegacyCall\(\)/);
  };
  check(source);
  for (const needle of ['"panelGenerations": panelGenerations, ', 'if self.panel == nil { panelGenerations += 1 }',
    ', !perch.legacyCallBlocked()', 'self.host?.hideRingCharacter(); self.hideLegacyCall()'])
    assert.throws(() => check(source.replace(needle, '')), { name: 'AssertionError' });
});

async function markerForwarding(module) {
  const { resolve } = await import('node:path');
  const out = mkdtempSync(join(tmpdir(), 'sleight-int26-forward-'));
  const { rmSync } = await import('node:fs');
  const controller = new AbortController(); let opened = 0, forwarded;
  try {
    await module.runLiveStage({ ownerAway: true, ownerAwayFile: 'fixture-away', out, size: 'stage' }, {
      acquireLock: async () => async () => {}, runtime: {
        platform: 'darwin', createWork: () => out, signalTarget: new EventEmitter(), readLoad: () => 2, isHeld: () => false,
        createGuard: () => ({ signal: controller.signal, close: async () => {}, execute: async (_file, args) => ({ stdout: args.includes('rev-parse') ? 'a'.repeat(40) : '' }) }),
        startPriority: async () => ({ close: async () => {} }), holdAwake: () => ({ ready: Promise.resolve(), close: async () => {} }),
        machineIdentity: async () => 'offline', buildBench: async () => 'offline', moduleCache: () => out,
        prepareCharacter: () => ({ identity: { sha256: 'b'.repeat(64) } }),
        makeHelper: () => async () => ({ screenRecording: true }),
        openFixture: async (...args) => {
          if (++opened > 1) forwarded = args[6].ownerAwayFile;
          return { ready: { machine: { mac: 'offline', macOS: 'offline', maximumHz: 120 } }, rows: [],
            sampler: { stop: async () => {} }, close: async () => ({ code: 0 }),
            request: async () => { throw progress.stageUnitFailure('child', 'test end'); } };
        },
        collectEvidence: async deps => { await assert.rejects(deps.baseline('changing'), /test end/); return {}; },
      },
    });
    assert.equal(forwarded, resolve('fixture-away'));
  } finally { rmSync(out, { recursive: true, force: true }); }
}
test('INT26 own forwards the absolute owner marker supplied by the CLI', () => markerForwarding(live));
test('INT26 broken owner marker forwarding', async t => {
  const broken = await mutant(t, 'stage-live.mjs', '{ ownerAwayFile }); sessions.add(session)', "{ ownerAwayFile: opts['owner-away-file'] }); sessions.add(session)");
  await assert.rejects(markerForwarding(broken), { name: 'AssertionError' });
});

for (const [name, before, after] of [
  ['owner pid', 'w.pid === windowServerPid', 'true'],
  ['owner name', 'WINDOW_SERVER_OWNERS.has(w.owner)', 'true'],
  ['spaced owner name', "new Set(['WindowServer', 'Window Server'])", "new Set(['WindowServer'])"],
  ['null pid', 'Number.isSafeInteger(windowServerPid) && windowServerPid > 0 && w.pid === windowServerPid', 'true'],
  ['opaque cover', 'invalidates: !server || opaqueContent', 'invalidates: !server'],
]) test(`INT26 broken WindowServer ${name} check`, async t => {
  const broken = await mutant(t, 'stage-surface.mjs', before, after);
  await assert.rejects(surfaceAssertion(broken, 'changing'), { name: 'AssertionError' });
});

async function lateScriptAssertion(module) {
  const { recordedActions, measurementWindows } = await import('./fixtures/stage-surface.mjs');
  const actions = recordedActions();
  assert.equal(module.stageScriptReceipt(actions, measurementWindows).maxDispatchErrorMs, 0);
  actions.at(-1).dispatchedMs += 251;
  assert.throws(() => module.stageScriptReceipt(actions, measurementWindows), error => {
    assert.equal(error.unitFailureKind, 'fixture-seat'); assert.equal(error.unitEvidence.maxDispatchErrorMs, 251); return true;
  });
}
test('INT26 late script refuses its measurement unit during collection', async () => {
  await lateScriptAssertion(await import('../bench/hand/stage-measurement.mjs'));
});
test('INT26 broken collection-time script validity check', async t => {
  const broken = await mutant(t, 'stage-measurement.mjs', 'if (!scriptDigest) throw', 'if (false) throw');
  await assert.rejects(lateScriptAssertion(broken), { name: 'AssertionError' });
});

async function snapshotSeamAssertion(module) {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const seam = 'CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]';
  assert.doesNotThrow(() => module.stageCostSource(source));
  assert.throws(() => module.stageCostSource(source.replace(seam, 'nil')), /snapshot seam changed/);
  assert.throws(() => module.stageCostSource(source + '\n' + seam), /snapshot seam changed/);
}
test('INT26 benchmark world adapter pins all eight production snapshot seams', () => snapshotSeamAssertion(live));
test('INT26 broken snapshot seam count', async t => {
  const broken = await mutant(t, 'stage-live.mjs', 'source.split(snapshot).length !== 9', '!source.includes(snapshot)');
  await assert.rejects(snapshotSeamAssertion(broken), { name: 'AssertionError' });
});

test('INT26 broken cache-probe host crash classification', async t => {
  const broken = await mutant(t, 'stage-live.mjs',
    "stageUnitFailure('host-crash', `stage cache probe exited", "stageUnitFailure('child', `stage cache probe exited");
  await assert.rejects(dumpAssertion(broken), { name: 'AssertionError' });
});
async function fallbackCrashAssertion(t, module) {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-int26-fallback-')));
  const spawnChild = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.write = () => {}; child.stdin.end = () => {}; child.kill = () => {};
    setImmediate(() => child.emit('close', 7, null)); return child;
  };
  await assert.rejects(module.collectFallbacks('offline', root, { spawnChild }), error => {
    assert.equal(error.unitFailureKind, 'host-crash'); return true;
  });
}
test('INT26 fallback product host exits are host-crash', t => fallbackCrashAssertion(t, live));
test('INT26 broken fallback host crash classification', async t => {
  const broken = await mutant(t, 'stage-live.mjs',
    "stageUnitFailure('host-crash', `stage fallback exited", "stageUnitFailure('child', `stage fallback exited");
  await assert.rejects(fallbackCrashAssertion(t, broken), { name: 'AssertionError' });
});
