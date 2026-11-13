import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { spawn } from 'node:child_process';
import { check4Options, check4Plan, check4RunVerdict } from '../bench/hand/check4.mjs';
import { sampleWindows } from '../bench/hand/check4-measurement.mjs';

test('model is the default and dry plans contain single-task login benchmark commands', () => {
  const plan = check4Plan(check4Options(['--dry-run']));
  assert.equal(plan.drive, 'model');
  assert.equal(plan.tasks.length, 7);
  for (const task of plan.tasks) {
    assert.deepEqual(task.benchCommand.slice(0, 5), ['node', 'bench/run.mjs', '--suite', 'world', '--arm']);
    assert.ok(task.benchCommand.includes('--owner-away'));
    assert.equal(task.benchCommand[task.benchCommand.indexOf('--arm') + 1], 'sleight');
    assert.equal(task.benchCommand[task.benchCommand.indexOf('--tasks') + 1], task.id);
    assert.equal(task.benchCommand[task.benchCommand.indexOf('--runs') + 1], '1');
    assert.equal(task.benchCommand[task.benchCommand.indexOf('--auth') + 1], 'login');
    assert.equal(task.benchCommand[task.benchCommand.indexOf('--model') + 1], 'claude-haiku-5-5');
    assert.equal(task.benchCommand[task.benchCommand.indexOf('--effort') + 1], 'high');
  }
  assert.equal(check4Options(['--drive', 'replay']).drive, 'replay');
  assert.equal(check4Plan(check4Options(['--drive', 'replay'])).tasks.length, 5);
  assert.throws(() => check4Options(['--drive', 'other']), /drive/);
});

test('model run verdict requires the added scroll and cross-window slots', () => {
  const state = { plan: { drive: 'model' }, tasks: Object.fromEntries(
    ['textedit-drag', 'finder-move', 'preview-read', 'calculator-click', 'textedit-calculator'].map(id =>
      [id, { complete: true, measured: true, verdict: 'pass' }])), costs: { complete: true, result: { verdict: 'pass' } } };
  assert.equal(check4RunVerdict(state), 'fail');
  for (const id of ['textedit-window-drag', 'preview-early-scroll']) state.tasks[id] = { complete: true, measured: true, verdict: 'pass' };
  assert.equal(check4RunVerdict(state), 'pass');
});

const importModel = () => import('../bench/hand/check4-model.mjs');
const sample = (t, extra = {}) => ({ ...sampleWindows({ t, status: { pid: 40, panelID: 7, hostTimeMs: t,
  shown: true, rendererPath: 'stage', size: 'stage', protectedRects: [[0, 0, 20, 20]], wideWindows: [],
  maxWindowBoundsDifferencePt: 0 }, windows: [{ pid: 40, id: 7, frame: [500, 500, 20, 20], alpha: 1 }] }),
  epochMs: 100000 + t, ...extra });
const samples = Array.from({ length: 9 }, (_, i) => sample(900 + i * 50));
const resultRow = { arm: 'sleight', task: 'calculator-click', run: 1, passed: true, groupClean: true,
  exitCode: 0, stamps: { spawnAt: 100800, exitAt: 101200, closeAt: 101250 } };
const toolTrace = [{ t: new Date(101000).toISOString(), direction: 'call-received', msg: { id: 1, params: { name: 'js' } } }];

test('sampler window uses the first tool and driver exit, excluding setup and collection', async () => {
  const { modelTaskResult } = await importModel();
  const result = modelTaskResult({ task: { id: 'calculator-click' }, row: resultRow, trace: toolTrace, rows: samples,
    audit: { complete: true, intersections: 0 }, cleanupConfirmed: true });
  assert.equal(result.driving.start, 1000); assert.equal(result.driving.end, 1200);
  assert.equal(result.durationMs, 200); assert.equal(result.visibleMs, 200);
  assert.equal(result.benchmarkPassed, true); assert.equal(result.verdict, 'pass');
});

test('a failed benchmark task still contributes its driving interval and character figures', async () => {
  const { modelTaskResult } = await importModel();
  const result = modelTaskResult({ task: { id: 'calculator-click' }, row: { ...resultRow, passed: false, reason: 'wrong answer' },
    trace: toolTrace, rows: samples, audit: { complete: true, intersections: 0 }, cleanupConfirmed: true });
  assert.equal(result.measured, true); assert.equal(result.durationMs, 200); assert.equal(result.visibleShare, 1);
  assert.equal(result.benchmarkPassed, false); assert.equal(result.verdict, 'fail');
});

test('missing tool timing, clock jumps, wrong task rows and incomplete cleanup stay unmeasured', async () => {
  const { modelTaskResult } = await importModel();
  const input = { task: { id: 'calculator-click' }, row: resultRow, trace: toolTrace, rows: samples,
    audit: { complete: true, intersections: 0 }, cleanupConfirmed: true };
  for (const change of [{ trace: [] }, { row: { ...resultRow, task: 'word-edit' } }, { cleanupConfirmed: false },
    { rows: samples.map((r, i) => i === 4 ? { ...r, epochMs: r.epochMs + 500 } : r) }]) {
    const result = modelTaskResult({ ...input, ...change });
    assert.equal(result.measured, false); assert.equal(result.visibleShare, null); assert.equal(result.verdict, 'unmeasured');
  }
});

test('model measurements retain SF1, stage-family visibility and early scroll coverage', async () => {
  const { modelTaskResult } = await importModel();
  const input = { task: { id: 'calculator-click' }, row: resultRow, trace: toolTrace, rows: samples,
    audit: { complete: true, intersections: 0 }, cleanupConfirmed: true };
  const empty = samples.map(r => ({ ...r, status: { ...r.status, protectedRects: [] } }));
  assert.equal(modelTaskResult({ ...input, rows: empty }).verdict, 'unmeasured');
  assert.equal(modelTaskResult({ ...input, rows: samples.map(r => ({ ...r, status: { ...r.status, size: 'small' } })) }).visibleShare, 0);
  const scroll = { ...input, rows: samples.map(r => ({ ...r, status: { ...r.status, wideWindows: [{ pid: 42, id: 9 }] } })), task: { id: 'preview-early-scroll', earlyScroll: true }, row: { ...resultRow, task: 'preview-early-scroll' },
    trace: [{ t: new Date(101000).toISOString(), direction: 'call-received', msg: { id: 1, params: { name: 'open_file' } } },
      { t: new Date(101010).toISOString(), direction: 'to-client', msg: { id: 1, result: {} } },
      { t: new Date(101015).toISOString(), direction: 'call-received', msg: { id: 2, params: { name: 'js' } } },
      { t: new Date(101150).toISOString(), direction: 'to-client', msg: { id: 2, result: {} } }],
    recordedCalls: [{ name: 'open_file', arguments: {} }, { name: 'js', arguments: { code: 'await app.scroll({direction:"down",pixels:20});' } }],
    hostTrace: { records: [{ input: { op: 'receive', now: 1.02, event: { state: 'scroll' } } }] } };
  assert.equal(modelTaskResult(scroll).firstScrollFractionOfDrivingTime, 0.1);
  assert.equal(modelTaskResult(scroll).measured, true);
  // Model thinking can put action one past the old 20% time threshold.
  assert.equal(modelTaskResult({ ...scroll, hostTrace: { records: [{ input: { op: 'receive', now: 1.1, event: { state: 'scroll' } } }] } }).measured, true);
  assert.equal(modelTaskResult({ ...scroll, recordedCalls: undefined }).measured, false);
});

test('missing scroll and drag coverage cannot erase the never-shown failure', async () => {
  const { modelTaskResult } = await importModel();
  for (const task of [{ id: 'preview-early-scroll', earlyScroll: true }, { id: 'textedit-window-drag', crossWindowDrag: true }]) {
    const result = modelTaskResult({ task, row: { ...resultRow, task: task.id }, trace: toolTrace,
      rows: samples.map(r => ({ ...r, status: { ...r.status, shown: false, size: null, hideReason: 'hide', protectedRects: [] } })),
      audit: { complete: true, intersections: 0 }, cleanupConfirmed: true, hostTrace: { records: [] } });
    assert.equal(result.verdict, 'fail');
    assert.match(result.reason, /character never shown.*hide/);
  }
});

test('cross-window coverage requires a successful drag method and two independently observed windows', async () => {
  const { modelTaskResult } = await importModel();
  const input = { task: { id: 'textedit-window-drag', crossWindowDrag: true },
    row: { ...resultRow, task: 'textedit-window-drag', methodAudit: { complete: true, drag: true, replacement: false } },
    trace: toolTrace, rows: samples.map(r => ({ ...r, status: { ...r.status, wideWindows: [{ pid: 42, id: 1 }] }, windows: [
      { pid: 42, id: 1, layer: 0, alpha: 1, frame: [0, 0, 100, 100] }, { pid: 42, id: 2, layer: 0, alpha: 1, frame: [200, 0, 100, 100] },
      // An older document below both fixtures must not hide their independent top-window identity.
      { pid: 42, id: 3, layer: 0, alpha: 1, frame: [0, 0, 300, 100] }] })),
    audit: { complete: true, intersections: 0 }, cleanupConfirmed: true,
    hostTrace: { records: [{ input: { now: 1.05, event: { state: 'drag', pid: 42, window: 1, at: [250, 50], end: [50, 50] } } }] } };
  assert.equal(modelTaskResult(input).crossWindowDragObserved, true);
  assert.equal(modelTaskResult(input).verdict, 'pass');
  assert.equal(modelTaskResult({ ...input, row: { ...input.row, methodAudit: { complete: true, drag: false, replacement: false } } }).verdict, 'unmeasured');
  assert.equal(modelTaskResult({ ...input, hostTrace: { records: [] } }).verdict, 'unmeasured');
});

test('fake bench child writes real private evidence, leaves settings bytes and parent environment unchanged', async t => {
  const { runModelBench } = await importModel();
  const dir = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-check4-model-'))));
  const hand = join(dir, 'hand.json'), bytes = Buffer.from('{"enabled":false}\n'); writeFileSync(hand, bytes);
  const fixture = new URL('./fixtures/check4-model-bench.mjs', import.meta.url);
  const inherited = process.env.SLEIGHT_BENCH_HAND;
  const answer = await runModelBench({ id: 'calculator-click' }, { dir, repo: dir, config: {},
    benchEntry: fixture.pathname, env: { CHECK4_FAKE_HAND: hand },
    startSampler: async () => ({ rows: samples, close: async () => ({ code: 0 }) }) });
  assert.equal(answer.measured, true); assert.equal(answer.durationMs, 200);
  assert.equal(answer.benchmarkPassed, true); assert.deepEqual(readFileSync(hand), bytes);
  assert.equal(process.env.SLEIGHT_BENCH_HAND, inherited);
  assert.equal(JSON.parse(readFileSync(join(dir, 'fake-env.json'))).SLEIGHT_BENCH_HAND, '1');
  assert.equal(JSON.parse(readFileSync(join(dir, 'fake-env.json'))).CLAUDE_CONFIG_DIR.startsWith(dir), true);
});

test('a crashing bench child leaves an unmeasured task and unproved cleanup', async t => {
  const { runModelBench } = await importModel();
  const dir = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-check4-crash-'))));
  const answer = await runModelBench({ id: 'calculator-click' }, { dir, repo: dir, config: {},
    benchEntry: new URL('./fixtures/check4-model-bench.mjs', import.meta.url).pathname, env: { CHECK4_FAKE_CRASH: '1' },
    startSampler: async () => ({ rows: samples, close: async () => ({ code: 0 }) }) });
  assert.equal(answer.measured, false); assert.equal(answer.visibleShare, null);
  assert.equal(answer.verdict, 'unmeasured'); assert.equal(answer.cleanupConfirmed, false);
});

test('owner-return cancellation immediately reaches the benchmark child and collects the sampler', async t => {
  const { runModelBench } = await importModel(), controller = new AbortController();
  const dir = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-check4-cancel-'))));
  let samplerClosed = false;
  const answer = await runModelBench({ id: 'calculator-click' }, { dir, repo: dir, config: {}, signal: controller.signal,
    benchEntry: new URL('./fixtures/check4-model-bench.mjs', import.meta.url).pathname, env: { CHECK4_FAKE_WAIT: '1' },
    spawnChild: (...args) => { const child = spawn(...args); child.once('spawn', () => controller.abort(Error('owner returned'))); return child; },
    startSampler: async () => ({ rows: samples, close: async () => { samplerClosed = true; return { code: 0 }; } }) });
  assert.equal(answer.stopped, true); assert.equal(answer.benchExit.signal, 'SIGTERM');
  assert.equal(answer.measured, false); assert.equal(samplerClosed, true);
});
