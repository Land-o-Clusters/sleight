import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { sampleWindows, summarizeSamples, taskResult } from '../bench/hand/check4-measurement.mjs';
import { main, runTasks, check4Plan } from '../bench/hand/check4.mjs';

const status = (extra = {}) => ({ pid: 40, panelID: 7, hostTimeMs: 1000, shown: true, rendererPath: 'stage', size: 'stage',
  wideWindows: [{ pid: 42, id: 9, frame: [0, 0, 10, 10], reasons: ['uncertain-geometry'] }],
  protectedRects: [], hideReasonCounts: {}, maxWindowBoundsDifferencePt: 0, ...extra });
const window = (pid, id, frame, alpha = 1) => ({ pid, id, frame, alpha });
const sample = (t, extra = {}) => sampleWindows({ t, status: status({ hostTimeMs: t }), appPids: [42],
  windows: [window(40, 7, [158, 50, 20, 20]), window(42, 9, [100, 50, 10, 10])], ...extra });

test('continuation runs only the requested suffix and labels its limited task verdict', async () => {
  const { check4Options, check4RunVerdict, MODEL_TASKS } = await import('../bench/hand/check4.mjs');
  const args = ['--from-task', 'finder-move', '--skip-costs'];
  const plan = check4Plan(check4Options(args));
  assert.deepEqual(plan.tasks.map(t => t.id), MODEL_TASKS.slice(1));
  assert.equal(plan.continuationFrom, 'finder-move');
  assert.equal(plan.singleTask, false); assert.equal(plan.costs, null);
  const tasks = Object.fromEntries(plan.tasks.map(({ id }) => [id, { complete: true, measured: true, verdict: 'pass' }]));
  assert.equal(check4RunVerdict({ plan, tasks }), 'tasks-pass');
  assert.equal(check4RunVerdict({ plan: check4Plan(check4Options(['--skip-costs'])), tasks }), 'fail');
  tasks['finder-move'].verdict = 'fail'; assert.equal(check4RunVerdict({ plan, tasks }), 'fail');
  for (const extra of [[], ['--smoke'], ['--tasks', 'finder-move'], ['--drive', 'replay']]) {
    assert.throws(() => check4Options(['--from-task', 'finder-move', ...extra, ...(extra.length ? ['--skip-costs'] : [])]), /from-task/);
  }
  let live = false;
  const dry = await main([...args, '--dry-run'], { live: () => { live = true; }, print() {} });
  assert.equal(live, false); assert.equal(dry.processesStarted, 0); assert.equal(dry.tasks.length, 6);
});

test('CA7 a full task pass can defer costs without claiming release qualification', async () => {
  const { check4Options, check4RunVerdict, MODEL_TASKS } = await import('../bench/hand/check4.mjs');
  const plan = check4Plan(check4Options(['--skip-costs']));
  assert.equal(plan.costs, null);
  assert.equal(plan.costsDeferred, true);
  const tasks = Object.fromEntries(MODEL_TASKS.map(id => [id, { complete: true, measured: true, verdict: 'pass' }]));
  assert.equal(check4RunVerdict({ plan, tasks }), 'tasks-pass');
  assert.equal(check4RunVerdict({ plan: { ...plan, costsDeferred: false }, tasks }), 'fail');
});

test('independent window geometry detects contact at the 48 pt margin', () => {
  const row = sample(1000);
  assert.equal(row.intersections.length, 1);
  assert.equal(row.intersections[0].kind, 'wide-window');
  assert.deepEqual(row.panel.frame, [158, 50, 20, 20]);
  assert.equal(sample(1000, { windows: [window(40, 7, [158.01, 50, 20, 20]), window(42, 9, [100, 50, 10, 10])] }).intersections.length, 0);
});

test('host geometry cannot replace the independent panel or wide window', () => {
  const row = sample(1000, { status: status({ panel: [900, 900, 20, 20] }) });
  assert.equal(row.intersections.length, 1);
  assert.equal(sample(1000, { windows: [window(42, 9, [100, 50, 10, 10])] }).panel.onScreen, false);
  assert.equal(sample(1000, { windows: [window(99, 7, [158, 50, 20, 20])] }).panel.onScreen, false);
});

test('every task pid window is retained and protected rectangle contact counts', () => {
  const row = sample(1000, { status: status({ wideWindows: [], protectedRects: [[150, 50, 8, 20]] }),
    windows: [window(40, 7, [158, 50, 20, 20]), window(42, 10, [0, 0, 30, 30]), window(42, 11, [50, 0, 30, 30]), window(99, 12, [0, 0, 30, 30])] });
  assert.equal(row.windows.length, 2);
  assert.equal(row.intersections[0].kind, 'protected-rectangle');
});

test('time weighting hides the entire gap over 100 ms and uncovered endpoints', () => {
  const rows = [sample(1000), sample(1050), sample(1250), sample(1300)];
  const result = summarizeSamples(rows, { start: 950, end: 1350 });
  assert.equal(result.visibleMs, 100);
  assert.equal(result.hiddenMs, 300);
  assert.equal(result.visibleShare, 0.25);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].durationMs, 200);
});

test('missing status, stale status, transparent panels and incomplete windows count hidden', () => {
  for (const extra of [{ status: null }, { status: status({ hostTimeMs: 800 }) },
    { windows: [window(40, 7, [0, 0, 20, 20], 0)] }, { windows: null }]) {
    assert.equal(summarizeSamples([sample(1000, extra), sample(1050, extra)], { start: 1000, end: 1050 }).visibleMs, 0);
  }
});

test('a failed fixture cannot count as visible even with perfect fake samples', () => {
  const result = taskResult({ replay: { verdict: 'pass', cleanupConfirmed: true, lifecycle: { passed: false } },
    rows: [sample(1000), sample(1050)], start: 1000, end: 1050 });
  assert.equal(result.measured, false);
  assert.equal(result.visibleShare, null);
  assert.equal(result.visibleMs, null);
  assert.equal(result.verdict, 'unmeasured');
});

test('post-drive re-seating intersections and final status counters remain in the task result', () => {
  const clear = t => sample(t, { windows: [window(40, 7, [500, 500, 20, 20])] });
  const final = sample(1100, { status: status({ hostTimeMs: 1100, maxWindowBoundsDifferencePt: 300, hideReasonCounts: { 'no-seat': 2 } }) });
  const result = taskResult({ replay: { verdict: 'pass', cleanupConfirmed: true, lifecycle: { passed: true } },
    rows: [clear(1000), clear(1050), final], start: 1000, end: 1050, audit: { complete: true, intersections: 0 }, reseated: true });
  assert.equal(result.visibleShare, 1); assert.equal(result.drivingSamplerIntersections, 0);
  assert.equal(result.samplerIntersections, 1); assert.equal(result.maxWindowBoundsDifferencePt, 300);
  assert.equal(result.hideReasonCounts['no-seat'], 2); assert.equal(result.verdict, 'fail');
});

test('dry run starts zero processes and writes zero files', async t => {
  const dir = registerTemp(t, mkdtempSync(join(realpathSync('/tmp'), 'sleight-check4-dry-')));
  let launched = 0, written = 0;
  const result = await main(['--dry-run', '--out', join(dir, 'absent')], {
    live: () => { launched++; }, write: () => { written++; }, print: () => {},
  });
  assert.equal(launched, 0); assert.equal(written, 0);
  assert.equal(result.processesStarted, 0); assert.equal(result.filesWritten, 0);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(check4Plan({}).tasks.length, 7);
});

test('live entry refuses without owner-away before dependency effects', async () => {
  let launched = 0;
  await assert.rejects(main([], { live: () => launched++ }), /owner-away/);
  assert.equal(launched, 0);
});

test('dry run traps every child-process and synchronous filesystem write entry', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/check4-dry-run.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { processes: 0, writes: 0, tasks: 7 });
});

test('fixture setup retries once then remains unmeasured, later tasks continue', async () => {
  const calls = [], saved = [];
  const state = { tasks: {} };
  await runTasks([{ id: 'one' }, { id: 'two' }], state, {
    boundary: async () => {}, checkpoint: async value => saved.push(structuredClone(value)),
    attempt: async (task, number) => { calls.push([task.id, number]); return { cleanupConfirmed: true,
      fixtureFailure: task.id === 'one', measured: task.id !== 'one', verdict: task.id === 'one' ? 'unmeasured' : 'pass' }; },
  });
  assert.deepEqual(calls, [['one', 1], ['one', 2], ['two', 1]]);
  assert.equal(state.tasks.one.visibleShare, null);
  assert.equal(state.tasks.one.attempts.length, 2);
  assert.equal(saved.length >= 5, true);
});

test('resume preserves completed work and retries the interrupted task', async () => {
  const state = { tasks: { one: { complete: true, measured: false }, two: { complete: false, attempts: [] } } };
  const calls = [];
  await runTasks([{ id: 'one' }, { id: 'two' }], state, { boundary: async () => {}, checkpoint: async () => {},
    attempt: async task => { calls.push(task.id); return { cleanupConfirmed: true, measured: false }; } });
  assert.deepEqual(calls, ['two']);
});

test('unproved cleanup stops the bank instead of retrying or continuing', async () => {
  const calls = [], state = { tasks: {} };
  await assert.rejects(runTasks([{ id: 'one' }, { id: 'two' }], state, { boundary: async () => {}, checkpoint: async () => {},
    attempt: async task => { calls.push(task.id); return { cleanupConfirmed: false, fixtureFailure: true }; } }), /cleanup/i);
  assert.deepEqual(calls, ['one']);
  assert.equal(state.tasks.one.complete, false);
});
