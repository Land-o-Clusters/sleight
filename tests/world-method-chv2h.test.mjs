import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { packageSkip } from './requirements.mjs';
import { getTasks } from '../bench/tasks.mjs';
import { sampleWindows } from '../bench/hand/check4-measurement.mjs';
import { modelTaskResult } from '../bench/hand/check4-model.mjs';

const skip = packageSkip('typescript');
const { dragMethodAudit } = skip ? {} : await import('../bench/world/method-check.mjs');
// CHV2C run 1, 35 tool requests and replies. Retain inputs and error flags,
// omit screenshots, model prose and document output, sanitize the fixture paths.
const transcript = readFileSync(new URL('./fixtures/chv2h-drag-method.jsonl', import.meta.url), 'utf8');
const successfulDrag = 'toolu_015A1P244enubeFNS9fgzsMH';
const changeEvents = change => transcript.trim().split('\n').map(JSON.parse).map(event => {
  change(event.message.content[0]); return JSON.stringify(event);
}).join('\n');
const extraCall = code => [
  { message: { content: [{ type: 'tool_use', id: 'extra', name: 'mcp__plugin_sleight_computer__js', input: { code } }] } },
  { message: { content: [{ type: 'tool_result', tool_use_id: 'extra' }] } },
].map(JSON.stringify).join('\n');

// Removing codePointAt from recognized string reads must fail both regressions.
test('CHV2H recorded current-selection drag reaches exact file grading after character inspection', { skip }, t => {
  assert.deepEqual(dragMethodAudit(transcript, { diagnostics: true }),
    { drag: true, replacement: false, complete: true, issues: [], issuesOmitted: 0 });
  const task = getTasks('world').find(task => task.id === 'textedit-window-drag');
  const ctx = { dir: registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-chv2h-method-'))), nonce: 'ed265d96' };
  task.prepare(ctx);
  // Synthetic saved artifacts exercise correctness separately from method proof.
  for (const [i, text] of ['alpha omega\n', 'destination\nmove-ed265d96\n'].entries()) writeFileSync(ctx.documents[i], text);
  const grade = text => { task.capture(ctx, { methodAudit: dragMethodAudit(text) }); return task.check(ctx); };
  assert.equal(grade(transcript), true);
  const failed = changeEvents(item => {
    if (item.type === 'tool_result' && item.tool_use_id === successfulDrag) item.is_error = true;
  });
  assert.equal(grade(failed), 'WORLD_DRAG_METHOD_UNPROVEN', 'the earlier ambiguity refusal cannot prove a move');
  const missing = changeEvents(item => {
    if (item.type === 'tool_use' && item.id === successfulDrag) item.type = 'omitted';
    if (item.type === 'tool_result' && item.tool_use_id === successfulDrag) item.type = 'omitted';
  });
  assert.equal(grade(missing), 'WORLD_DRAG_METHOD_UNPROVEN');
  for (const code of ['await app.typeText("move-ed265d96")', 'await app.paste("move-ed265d96")',
    'await app.pressKey("super+x")', 'await app.pressKey("super+v")',
    'unknown()', 'String.prototype.codePointAt = app.typeText', 'app.codePointAt.call(app, "move-ed265d96")']) {
    assert.equal(grade(transcript + '\n' + extraCall(code)), 'WORLD_DRAG_METHOD_UNPROVEN', code);
  }
  writeFileSync(ctx.documents[1], 'destination\nmove-ed265d96\n\n');
  assert.equal(grade(transcript), 'WORLD_TEXT_MISMATCH', 'method proof cannot relax the final newline');
});

test('CHV2H retained host endpoints prove cross-window coverage only with complete method and sampler witnesses', { skip }, () => {
  // Exact endpoints and window identities from run 1. Use synthetic clocks and
  // visibility around them so this offline test does not qualify the live run.
  const windows = [
    { alpha: 1, frame: [752, 49, 720, 560], id: 613388, layer: 0, pid: 79909 },
    { alpha: 1, frame: [16, 49, 720, 560], id: 613382, layer: 0, pid: 79909 },
  ];
  const rows = Array.from({ length: 9 }, (_, i) => {
    const t = 900 + i * 50;
    return { ...sampleWindows({ t, status: { pid: 40, panelID: 7, hostTimeMs: t, shown: true,
      rendererPath: 'stage', size: 'stage', protectedRects: [[0, 0, 20, 20]],
      wideWindows: [{ pid: 79909, id: 613382 }], maxWindowBoundsDifferencePt: 0 },
    windows: [{ pid: 40, id: 7, frame: [20, 840, 220, 122], alpha: 1 }] }), epochMs: 100000 + t, windows };
  });
  const input = { task: { id: 'textedit-window-drag', crossWindowDrag: true },
    row: { arm: 'sleight', task: 'textedit-window-drag', run: 1, passed: true, groupClean: true,
      stamps: { exitAt: 101200 }, methodAudit: dragMethodAudit(transcript) },
    trace: [{ t: new Date(101000).toISOString(), direction: 'call-received', msg: { id: 24, params: { name: 'drag' } } }],
    rows, audit: { complete: true, intersections: 0 }, cleanupConfirmed: true,
    hostTrace: { records: [{ input: { now: 1.05, event: { state: 'drag', pid: 79909, window: 613382,
      at: [764, 100], end: [69.05, 87.5], ok: false } } }] } };
  const result = modelTaskResult(input);
  assert.equal(result.crossWindowDragObserved, true);
  assert.equal(result.verdict, 'pass');
  for (const change of [{ hostTrace: { records: [] } }, { rows: rows.map(r => ({ ...r, windows: windows.slice(0, 1) })) },
    { rows: rows.map(r => ({ ...r, windows: windows.map(w => ({ ...w, alpha: 0 })) })) },
    { rows: rows.filter(r => [900, 1200, 1250, 1300].includes(r.t)) },
    ...[{ complete: false, drag: true, replacement: false }, { complete: true, drag: false, replacement: false },
      { complete: true, drag: true, replacement: true }].map(methodAudit => ({ row: { ...input.row, methodAudit } }))]) {
    assert.notEqual(modelTaskResult({ ...input, ...change }).verdict, 'pass');
  }
  const wrongAnswer = modelTaskResult({ ...input, row: { ...input.row, passed: false, reason: 'WORLD_TEXT_MISMATCH' } });
  assert.equal(wrongAnswer.crossWindowDragObserved, true);
  assert.equal(wrongAnswer.verdict, 'fail');
});
