import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildPlan, countByVariant, gateDecision, runExperiment, VARIANTS } from '../bench/textedit-save-lock.mjs';

test('the plan runs five no-event gate runs, then five interleaved cycles of the variants', () => {
  const plan = buildPlan();
  assert.equal(plan.length, 30);
  assert.deepEqual(plan.slice(0, 5).map(s => [s.phase, s.variant]), Array(5).fill(['gate', 'none']));
  assert.deepEqual(VARIANTS, ['none', 'shift-pair', 'escape', 'keyup-only', 'applescript-read']);
  const rest = plan.slice(5);
  for (let cycle = 0; cycle < 5; cycle++) {
    assert.deepEqual(rest.slice(cycle * 5, cycle * 5 + 5).map(s => s.variant), VARIANTS);
    assert.ok(rest.slice(cycle * 5, cycle * 5 + 5).every(s => s.phase === 'variants' && s.cycle === cycle + 1));
  }
  assert.deepEqual(plan.map(s => s.index), plan.map((_, i) => i + 1));
});

test('hangs are counted per variant, apart from skipped and undelivered runs', () => {
  const counts = countByVariant([
    { variant: 'none', hang: true }, { variant: 'none', hang: false, msToSave: 120 }, { variant: 'none', skipped: 'Attach refused' },
    { variant: 'escape', hang: true }, { variant: 'escape', hang: true },
    { variant: 'applescript-read', delivered: false, hang: true }, { variant: 'applescript-read', delivered: true, hang: false, msToSave: 90 },
  ]);
  assert.deepEqual(counts.none, { runs: 3, completed: 2, hangs: 1, saved: 1, skipped: 1, notDelivered: 0, msToSave: [120] });
  assert.equal(counts.escape.hangs, 2); assert.equal(counts.escape.completed, 2);
  assert.deepEqual(counts['applescript-read'], { runs: 2, completed: 1, hangs: 0, saved: 1, skipped: 0, notDelivered: 1, msToSave: [90] });
});

async function experiment(gateHangs, { skipGate = 0 } = {}) {
  const seen = [], report = {};
  let gate = 0;
  await runExperiment({ plan: buildPlan(), report, runOne: async run => {
    seen.push(run.phase);
    if (run.phase === 'gate') {
      gate++;
      if (gate <= skipGate) run.skipped = 'Attach refused';
      else run.hang = gate - skipGate <= gateHangs;
    } else run.hang = run.variant === 'none';
  } });
  return { seen, report };
}

test('fewer than three gate hangs records that open -g does not reproduce and runs no variant', async () => {
  const { seen, report } = await experiment(2);
  assert.deepEqual(seen, Array(5).fill('gate'));
  assert.equal(report.gate.proceed, false);
  assert.equal(report.gate.conclusion, 'open -g does not reproduce the hang');
  assert.equal(report.runs.length, 5); assert.deepEqual(report.counts.variants, {});
});

test('three gate hangs go on to every variant run, and each run is recorded', async () => {
  const { seen, report } = await experiment(3);
  assert.equal(seen.filter(p => p === 'variants').length, 25);
  assert.equal(report.gate.proceed, true);
  assert.equal(report.counts.variants.none.hangs, 5);
  assert.equal(report.counts.variants['shift-pair'].hangs, 0); assert.equal(report.counts.variants['shift-pair'].completed, 5);
});

test('skipped gate runs make a short gate inconclusive rather than a negative result', async () => {
  const { report } = await experiment(2, { skipGate: 2 });
  assert.equal(report.gate.proceed, false);
  assert.match(report.gate.conclusion, /^inconclusive: 3 of 5/);
  assert.equal(gateDecision([{ hang: true }, { hang: true }, { hang: false }, { hang: false }, { hang: false }]).conclusion, 'open -g does not reproduce the hang');
});

test('a stop from a run ends the experiment there', async () => {
  const report = {}, seen = [];
  await runExperiment({ plan: buildPlan(), report, runOne: async run => { seen.push(run.index); return run.index === 2 ? { stop: 'Live hold exists' } : undefined; } });
  assert.deepEqual(seen, [1, 2]); assert.equal(report.stopped, 'Live hold exists');
});

const helper = readFileSync(new URL('../bench/textedit-save-lock.js', import.meta.url), 'utf8');
function acceptOwnedWindows(rows) {
  const context = { ObjC: { import() {} } };
  runInNewContext(helper, context);
  // The result comes from another realm, so compare it as plain data.
  return JSON.parse(JSON.stringify(context.acceptOwnedWindows(rows, 'file:///private/tmp/sleight-save-lock-abc123/trial.txt')));
}
const owned = { document: 'file:///private/tmp/sleight-save-lock-abc123/trial.txt', modal: false, sheet: false, text: 'seed\n' };

test('the owned document window alone is accepted', () => {
  assert.deepEqual(acceptOwnedWindows([owned]), { accept: true, owned: 0, artifacts: [] });
});
test('an extra empty untitled window or panel from the same launch is tolerated', () => {
  assert.equal(acceptOwnedWindows([{ document: null, modal: false, sheet: false, text: '' }, owned]).accept, true);
  assert.equal(acceptOwnedWindows([{ document: null, modal: false, sheet: false, text: '' }, owned]).owned, 1);
  assert.deepEqual(acceptOwnedWindows([owned, { document: null, modal: false, sheet: false, text: null }]).artifacts, ['panel']);
});
test('a window that could hold someone else\'s data, or a second extra, is refused', () => {
  for (const extra of [
    { document: 'file:///Users/x/notes.txt', modal: false, sheet: false, text: '' },
    { document: null, modal: false, sheet: false, text: 'restored words' },
    { document: null, modal: true, sheet: false, text: null },
    { document: null, modal: false, sheet: true, text: '' },
  ]) { const r = acceptOwnedWindows([owned, extra]); assert.equal(r.accept, false); assert.ok(!r.retry, r.reason); }
  const empty = { document: null, modal: false, sheet: false, text: '' };
  assert.equal(acceptOwnedWindows([owned, empty, { ...empty }]).accept, false);
  assert.equal(acceptOwnedWindows([owned, { ...owned }]).reason, 'Ambiguous owned windows');
  assert.equal(acceptOwnedWindows([{ ...owned, sheet: true }]).accept, false);
});
test('no window, or no owned window yet, asks for a retry', () => {
  assert.equal(acceptOwnedWindows([]).retry, true);
  assert.equal(acceptOwnedWindows([{ document: null, modal: false, sheet: false, text: '' }]).retry, true);
});
