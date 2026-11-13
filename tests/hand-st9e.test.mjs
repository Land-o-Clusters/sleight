import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as originalProgress from '../bench/hand/stage-progress.mjs';
import * as originalSurface from '../bench/hand/stage-surface.mjs';
import * as originalCost from '../bench/hand/stage-cost.mjs';
import { stageSurfaceFixture } from './fixtures/stage-surface.mjs';

// External negative runs execute the same assertions against one deliberately broken module.
const variants = {
  'no-ceiling': ['stage-progress.mjs', 'attempts.size >= STAGE_MAX_INTERRUPTED_ATTEMPTS', 'false'],
  'forget-discarded': ['stage-progress.mjs', 'row.interrupted === true', 'row.interrupted === true && !row.discarded'],
  'forget-current': ['stage-progress.mjs', '...progress?.inProgress ? [{ ...progress.inProgress, interrupted: true }] : []', '...[]'],
  'no-recurring': ['stage-surface.mjs', 'return first.interfering.filter', 'return [].filter'],
  'ignore-window-id': ['stage-surface.mjs', 'other.owner === w.owner && other.id === w.id', 'other.owner === w.owner'],
  'forget-failed': ['stage-surface.mjs', 'read(attempt.evidence);', 'read(null);'],
  'exempt-system-app': ['stage-surface.mjs', 'invalidates: !server || opaqueContent', "invalidates: w.owner === 'ContinuityCaptureOnboardingUI' ? false : !server || opaqueContent"],
  'late-report': ['stage-cost.mjs', "${recurring.length ? '; ' + recurring.join('; ') : ''}", ''],
};
async function load(file, dependencies = {}) {
  const url = new URL('../bench/hand/' + file, import.meta.url), variant = variants[process.env.ST9E_BROKEN];
  if (variant?.[0] !== file && !Object.keys(dependencies).length) return import(url.href);
  let source = readFileSync(url, 'utf8');
  if (variant?.[0] === file) {
    assert.ok(source.includes(variant[1]), 'mutation site must exist'); source = source.replace(variant[1], variant[2]);
  }
  source = source.replace(/from '(\.\.?\/[^']+)'/g, (_, path) => `from '${dependencies[path] ?? new URL(path, url).href}'`);
  source = source.replaceAll('import.meta.url', JSON.stringify(url.href));
  const href = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  return { module: await import(href), href };
}
const loadedProgress = await load('stage-progress.mjs');
const progress = loadedProgress.module ?? originalProgress;
const loadedSurface = await load('stage-surface.mjs');
const surface = loadedSurface.module ?? originalSurface;
const loadedCost = await load('stage-cost.mjs', {
  './stage-surface.mjs': loadedSurface.href ?? new URL('../bench/hand/stage-surface.mjs', import.meta.url).href,
  './stage-progress.mjs': loadedProgress.href ?? new URL('../bench/hand/stage-progress.mjs', import.meta.url).href,
});
const cost = loadedCost.module ?? originalCost;
const id = 'round/1/phase/stage/quiet';
const interrupted = (attempt, extra = {}) => ({ id, attempt, interrupted: true, error: `watchdog ${attempt}`, ...extra });

test('ST9F ceiling excludes at six with a named code, unit and last reason', () => {
  assert.equal(progress.STAGE_MAX_INTERRUPTED_ATTEMPTS, 6);
  const p = { attempts: Array.from({ length: 6 }, (_, i) => interrupted(i + 1)) };
  const evidence = { collection: p };
  assert.equal(progress.excludeStageInterruptedUnits(evidence), true);
  assert.deepEqual(p.excluded, [{ code: 'STAGE_INTERRUPTION_CEILING', unit: id,
    interruptions: 6, limit: 6, reason: 'watchdog 6' }]);
  assert.equal(progress.excludeStageInterruptedUnits(evidence), false, 'record is idempotent');
});
test('ST9E ceiling counts discarded interruptions for the bank lifetime', () => {
  const p = { attempts: Array.from({ length: 6 }, (_, i) => interrupted(i + 1, { discarded: true })) };
  assert.equal(progress.stageInterruptionCeilings(p)[0]?.interruptions, 6);
});
test('ST9E ceiling includes an unfinished sixth attempt without double counting', () => {
  const p = { attempts: Array.from({ length: 5 }, (_, i) => interrupted(i + 1)), inProgress: interrupted(6) };
  assert.equal(progress.stageInterruptionCeilings(p)[0]?.interruptions, 6);
  p.attempts.push(interrupted(6));
  assert.equal(progress.stageInterruptionCeilings(p)[0]?.interruptions, 6);
});
test('ST9E five stops allow recovery, failures and other units spend no interruption slots', () => {
  const p = { attempts: [
    ...Array.from({ length: 5 }, (_, i) => interrupted(i + 1)),
    ...Array.from({ length: 3 }, (_, i) => ({ id, attempt: i + 6, status: 'failed' })),
    ...Array.from({ length: 5 }, (_, i) => interrupted(i + 1, { id: 'behavior' })),
  ] };
  assert.deepEqual(progress.stageInterruptionCeilings(p), []);
  assert.equal(progress.excludeStageInterruptedUnits({ collection: p }), false);
  assert.equal(progress.stageFailureAttempts(p, id), 3);
  assert.equal(progress.STAGE_TOTAL_FAILURE_BUDGET, 12); assert.equal(progress.STAGE_MAX_ATTEMPTS, 3);
});

function boundary(at = 100, { owner = 'ContinuityCaptureOnboardingUI', windowId = 634121, pid = 48748,
  panel = false, name = 'quiet', windowServerPid = 414 } = {}) {
  const c = stageSurfaceFixture({ panel, surface: name });
  Object.assign(c, { observedAtMs: at, startedAtMs: at - 1, completedAtMs: at + 1, windowServerPid });
  c.windows.unshift({ owner, pid, id: windowId, layer: 200, alpha: 1,
    bounds: { x: 516, y: 232, width: 482, height: 546 } });
  return { ...surface.stageSurfaceObservation(c, c, c), boundary: c.boundary };
}
function failedBank(a = boundary(), b = boundary(200)) {
  return { runs: [], collection: { units: [], segments: [], sizes: ['stage'],
    attempts: [{ id, evidence: a, discarded: true }], inProgress: { id, evidence: b } } };
}
test('ST9E first report line names a recurring window from failed and discarded boundaries', () => {
  const bank = failedBank(), recurring = surface.stageRecurringWindows(bank);
  assert.deepEqual(recurring, [{ owner: 'ContinuityCaptureOnboardingUI', pid: 48748, windowId: 634121,
    level: 200, bounds: { x: 516, y: 232, width: 482, height: 546 }, firstSeen: '1970-01-01T00:00:00.100Z' }]);
  const line = cost.reportMarkdown(cost.stageVerdict(bank)).split('\n')[0];
  for (const value of ['ContinuityCaptureOnboardingUI', 'pid 48748', 'window 634121', 'level 200',
    '"x":516,"y":232,"width":482,"height":546', 'first seen 1970-01-01T00:00:00.100Z']) assert.ok(line.includes(value), value);
});
test('ST9E recurrence needs the same owner and window id at distinct boundaries', () => {
  for (const other of [boundary(200, { owner: 'other app' }), boundary(200, { windowId: 634122 })])
    assert.deepEqual(surface.stageRecurringWindows(failedBank(boundary(), other)), []);
  const one = boundary(); assert.deepEqual(surface.stageRecurringWindows(failedBank(one, one)), []);
});
test('ST9E canonical baselines, controls and phases retain first-seen chronology', () => {
  const first = boundary(), second = boundary(200), third = boundary(300);
  const bank = { runs: [{ baselines: { quiet: [{ surfaceChecks: [first] }] }, sizes: {
    stage: { phases: { quiet: { surfaceChecks: [third], control: { surfaceChecks: [second] } } } },
  } }], collection: { attempts: [{ evidence: first }, { evidence: { phases: { quiet: { surfaceChecks: [third] } } } }] } };
  const [row] = surface.stageRecurringWindows(bank);
  assert.equal(row.firstSeen, '1970-01-01T00:00:00.100Z');
});
test('ST9E system app never exempted, verified WindowServer overlay alone is exempt', () => {
  for (const name of ['quiet', 'changing']) {
    const c = boundary(100, { name }); assert.equal(c.valid, false);
    const panel = boundary(100, { name, panel: true }); assert.equal(panel.valid, false);
    const server = boundary(100, { owner: 'Window Server', pid: 414, windowId: 8888, name });
    assert.equal(server.valid, true); assert.deepEqual(surface.stageRecurringWindows(failedBank(server, { ...server, observedAtMs: 200 })), []);
    const unknown = boundary(100, { owner: 'Window Server', pid: 414, name, windowServerPid: null });
    assert.equal(unknown.valid, false);
  }
});
