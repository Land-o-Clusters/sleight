import test from 'node:test';
import assert from 'node:assert/strict';
import { check4Options, check4Plan, check4RunVerdict, runTasks } from '../bench/hand/check4.mjs';
import * as measurement from '../bench/hand/check4-measurement.mjs';
import { check4Markdown } from '../bench/hand/check4-live.mjs';

test('smoke selects one Calculator task and skips costs; task selections stay bounded', () => {
  const plan = check4Plan(check4Options(['--smoke']));
  assert.deepEqual(plan.tasks.map(t => t.id), ['calculator-click']);
  assert.equal(plan.costs, null);
  assert.equal(plan.smoke, true);
  assert.match(check4Markdown({ plan, tasks: {} }), /Scope: smoke\. Costs: not run\./);
  const selected = check4Plan(check4Options(['--tasks', 'preview-read']));
  assert.equal(selected.tasks.length, 1); assert.equal(selected.costs, null);
  assert.throws(() => check4Options(['--tasks', 'unknown']), /Unexpected/);
  assert.throws(() => check4Options(['--tasks', 'calculator-click,textedit-drag']), /Unexpected/);
  assert.throws(() => check4Options(['--drive', 'replay', '--smoke']), /model/);
});

const status = (t, extra = {}) => ({ t, valid: true, panel: { onScreen: true, frame: [1, 2, 20, 20] }, status: { panel: [1, 2, 20, 20], shown: true, rendererPath: 'stage', size: 'stage',
  turnTargets: 1, protectedRects: [], ...extra } });
const result = { driving: { start: 1000, end: 1100 }, benchmarkPassed: true, cleanupConfirmed: true, measured: false };
test('smoke requires stage visibility and turn targets within driving, and a passing collected benchmark', () => {
  assert.equal(typeof measurement.smokeResult, 'function');
  const judge = (rows, extra = {}) => measurement.smokeResult({ ...result, ...extra }, rows);
  assert.equal(judge([status(1050)]).verdict, 'pass');
  assert.equal(judge([status(1050, { turnTargets: 0, protectedRects: [[0, 0, 10, 10]] })]).verdict, 'pass');
  for (const rows of [[], [status(900)], [status(1150)], [status(1050, { shown: false })],
    [status(1050, { size: 'medium' })], [status(1050, { rendererPath: 'legacy-perch' })],
    [status(1050, { turnTargets: 0 })], [{ ...status(1050), valid: false }]]) assert.equal(judge(rows).verdict, 'fail');
  assert.equal(judge([status(1050)], { benchmarkPassed: false }).verdict, 'fail');
  assert.equal(judge([status(1050)], { cleanupConfirmed: false }).verdict, 'fail');
});

test('never-shown failures survive task checkpointing; smoke proof never qualifies the full check', async () => {
  const state = { tasks: {}, plan: check4Plan(check4Options(['--smoke'])) };
  await runTasks(state.plan.tasks, state, { boundary: async () => {}, checkpoint: async () => {},
    attempt: async () => ({ cleanupConfirmed: true, measured: false, verdict: 'fail', characterNeverShown: true,
      reason: 'character never shown (dominant hide reason: hide)' }) });
  assert.equal(state.tasks['calculator-click'].verdict, 'fail');
  assert.equal(check4RunVerdict(state), 'fail');
  state.tasks['calculator-click'] = { complete: true, measured: false, verdict: 'pass', panelAgreement: { passed: true },
    smoke: { shownAtStage: true, targetsReceived: true } };
  assert.equal(check4RunVerdict(state), 'smoke-pass');
  state.tasks['calculator-click'].panelAgreement.passed = false;
  assert.equal(check4RunVerdict(state), 'fail');
  state.tasks['calculator-click'].panelAgreement.passed = true;
  state.plan = check4Plan(check4Options(['--tasks', 'calculator-click']));
  state.tasks['calculator-click'].measured = true;
  assert.equal(check4RunVerdict(state), 'single-task-pass');
  state.plan = check4Plan(check4Options([]));
  assert.equal(check4RunVerdict(state), 'fail');
});

test('CH-3 smoke accepts three-quarter with full-stage presence reported separately', () => {
  const answer = measurement.smokeResult(result, [status(1050, { size: 'three-quarter' })]);
  assert.equal(answer.verdict, 'pass');
  assert.equal(answer.smoke.shownAtStageFamily, true); assert.equal(answer.smoke.shownAtStage, false);
});
