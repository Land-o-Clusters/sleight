import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { getTasks } from '../bench/tasks.mjs';
import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
const { dragMethodAudit } = parserSkip ? {} : await import('../bench/world/method-check.mjs');
import { getWorldTasks } from '../bench/world/tasks.mjs';

test('Calculator claim checks read the current display and reject the right answer on a wrong display', async () => {
  const task = getTasks('world').find(t => t.id === 'calculator-click');
  let reads = 0;
  const ctx = { expectedCalculator: '391', calculatorBefore: '0', answer: '391',
    readCalculator: async () => { reads++; return '1 text Description: Edit field, Value: 392'; } };
  assert.notEqual(await task.check(ctx), true);
  assert.equal(reads, 1);
  ctx.readCalculator = async () => '1 text Description: Edit field, Value: 391';
  assert.equal(await task.check(ctx), true);
  ctx.calculatorBefore = '391';
  assert.notEqual(await task.check(ctx), true);
});

test('the cross-app calculation needs both the saved file and the current Calculator display', async () => {
  const task = getTasks('world').find(t => t.id === 'textedit-calculator');
  const temp = mkdtempSync(join(tmpdir(), 'sleight-world-cross-'));
  try {
    const ctx = { dir: temp, nonce: 'fixture', calculatorBefore: '0' };
    await task.prepare(ctx);
    ctx.expectedCalculator ??= '391';
    writeFileSync(ctx.document, String(ctx.expectedCalculator) + '\n');
    ctx.readCalculator = async () => '1 text Description: Edit field, Value: 0';
    assert.notEqual(await task.check(ctx), true);
    ctx.readCalculator = async () => `1 text Description: Edit field, Value: ${ctx.expectedCalculator}`;
    assert.equal(await task.check(ctx), true);
    writeFileSync(ctx.document, 'wrong');
    assert.notEqual(await task.check(ctx), true);
  } finally { removeTemp(temp); }
});

test('the new native tasks prepare private files and grade exact artifacts without app execution', async () => {
  const tasks = getTasks('world');
  const temp = mkdtempSync(join(tmpdir(), 'sleight-world-native-'));
  try {
    for (const id of ['finder-rename', 'finder-move', 'finder-create-folder', 'textedit-two-windows', 'textedit-window-drag',
      'textedit-replace-save', 'preview-read', 'textedit-replace-all', 'textedit-insert-line']) {
      const dir = join(temp, id); mkdirSync(dir);
      const task = tasks.find(t => t.id === id);
      assert.ok(task, id);
      const ctx = { dir, nonce: 'fixture' };
      await task.prepare(ctx);
      assert.equal(task.fixtureLifecycle, true);
      assert.doesNotMatch(task.prompt(ctx), /in the background|sleight\.|playwright\./);
      assert.notEqual(await task.check({ ...ctx, answer: 'I did it' }), true, id);
      if (id === 'preview-read') {
        assert.equal(task.prompt(ctx).includes(ctx.readback), false);
        assert.equal(await task.check({ ...ctx, answer: ctx.readback }), true);
        writeFileSync(ctx.document, 'changed');
        assert.notEqual(await task.check({ ...ctx, answer: ctx.readback }), true);
      } else {
        if (id === 'finder-rename') renameSync(join(ctx.folder, 'alpha.txt'), join(ctx.folder, 'renamed.txt'));
        if (id === 'finder-move') renameSync(join(ctx.folder, 'alpha.txt'), join(ctx.folder, 'Archive/alpha.txt'));
        if (id === 'finder-create-folder') mkdirSync(join(ctx.folder, 'Created'));
        const text = {
          'textedit-two-windows': ['first fixture\n', 'second fixture\n'],
          'textedit-window-drag': ['alpha omega\n', 'destination\nmove-fixture\n'],
          'textedit-replace-save': ['replacement fixture\n'], 'textedit-replace-all': ['violet violet violet\n'],
          'textedit-insert-line': ['first line\nsecond fixture\n'],
        }[id];
        if (text) for (const [index, value] of text.entries()) writeFileSync(ctx.documents[index], value);
        if (id === 'textedit-window-drag') {
          assert.match(task.prompt(ctx), /Use drag and drop, not typing or cut and paste/);
          assert.notEqual(await task.check(ctx), true, 'saved files alone cannot prove the drag method');
          await task.capture(ctx, { methodAudit: { drag: true, replacement: false, complete: true } });
        }
        assert.equal(await task.check({ ...ctx, answer: 'done' }), true, id);
        writeFileSync(ctx.documents?.[0] ?? join(ctx.folder, 'extra.txt'), 'wrong');
        assert.notEqual(await task.check({ ...ctx, answer: 'done' }), true, id);
      }
    }
  } finally { removeTemp(temp); }
});

test('DPg recorded method audit reaches exact text grading and rejects missing moves or wrong text', { skip: parserSkip }, async () => {
  const task = getTasks('world').find(t => t.id === 'textedit-window-drag');
  const temp = mkdtempSync(join(tmpdir(), 'sleight-world-dpg-'));
  try {
    const ctx = { dir: temp, nonce: '7a278a09' }; task.prepare(ctx);
    const events = readFileSync(new URL('./fixtures/dpg-drag-method.jsonl', import.meta.url), 'utf8');
    for (const [i, value] of ctx.expectedText.entries()) writeFileSync(ctx.documents[i], value);
    task.capture(ctx, { methodAudit: { drag: true, replacement: false, complete: false } });
    assert.equal(task.check(ctx), 'WORLD_DRAG_METHOD_UNPROVEN');
    task.capture(ctx, { methodAudit: dragMethodAudit(events) });
    assert.equal(task.check(ctx), true);
    writeFileSync(ctx.documents[1], 'destination\n\n move-7a278a09');
    assert.equal(task.check(ctx), 'WORLD_TEXT_MISMATCH');
    const failedMoves = events.trim().split('\n').map(JSON.parse).map(event => {
      for (const item of event.message.content) if (item.type === 'tool_result' && item.tool_use_id === 'toolu_01RgCCdPw72TtXggZk1mR4k8') item.is_error = true;
      return JSON.stringify(event);
    }).join('\n');
    task.capture(ctx, { methodAudit: dragMethodAudit(failedMoves) });
    assert.equal(task.check(ctx), 'WORLD_DRAG_METHOD_UNPROVEN');
  } finally { removeTemp(temp); }
});

test('Calculator menu requires the requested mode change as well as the generated answer', async () => {
  const task = getTasks('world').find(t => t.id === 'calculator-menu');
  const ctx = { expectedCalculator: '144', calculatorBefore: '0', expectedCalculatorMode: 'scientific', calculatorModeBefore: 'basic',
    readCalculator: async () => '1 text Description: Edit field, Value: 144\n2 button ID: Mode: basic; unitConversion: false' };
  assert.notEqual(await task.check(ctx), true);
  ctx.readCalculator = async () => '1 text Description: Edit field, Value: 144\n2 button ID: Mode: scientific; unitConversion: false';
  assert.equal(await task.check(ctx), true);
  ctx.calculatorModeBefore = 'scientific';
  assert.notEqual(await task.check(ctx), true, 'an unchanged mode does not prove the requested menu task');
});

test('multi-window setup acquires each exact fixture path and retains a failed acquisition', async () => {
  const { tasks: defaults } = await import('../bench/tasks.mjs');
  const { realTasks: real } = await import('../bench/tasks-real.mjs');
  const temp = mkdtempSync(join(tmpdir(), 'sleight-world-acquisition-'));
  try {
    const calls = [], first = { fixture: true };
    const tasks = getWorldTasks({ defaults, real, open: async (ctx, request) => {
      calls.push(request);
      if (calls.length === 2) throw new Error('second acquisition uncertain');
      return first;
    } });
    const task = tasks.find(t => t.id === 'textedit-two-windows');
    const ctx = { dir: temp, nonce: 'fixture' };
    await assert.rejects(task.setup(ctx), /uncertain/);
    assert.deepEqual(calls.map(call => call.target), ctx.documents);
    assert.equal(ctx.document0, first);
    assert.deepEqual([...ctx.pendingAcquisitions], ['document1']);
    assert.ok(calls.every(call => call.mode === 'document' && call.target.startsWith(temp)));
  } finally { removeTemp(temp); }
});

test('the two-window tasks ask for side-by-side slots and single documents ask for none', async () => {
  const { tasks: defaults } = await import('../bench/tasks.mjs');
  const { realTasks: real } = await import('../bench/tasks-real.mjs');
  const temp = mkdtempSync(join(tmpdir(), 'sleight-world-placement-'));
  try {
    for (const [id, expected] of [['textedit-window-drag', [{ slot: 0, count: 2 }, { slot: 1, count: 2 }]],
      ['textedit-two-windows', [{ slot: 0, count: 2 }, { slot: 1, count: 2 }]], ['textedit-replace-save', [undefined]]]) {
      const calls = [];
      const task = getWorldTasks({ defaults, real, open: async (_ctx, request) => { calls.push(request); return {}; } }).find(t => t.id === id);
      await task.setup({ dir: temp, nonce: 'fixture' });
      assert.deepEqual(calls.map(call => call.placement), expected, id);
    }
  } finally { removeTemp(temp); }
});

test('world save opens an owned empty document and Chess refuses an existing process', async () => {
  const { tasks: defaults } = await import('../bench/tasks.mjs');
  const { realTasks: real } = await import('../bench/tasks-real.mjs');
  const temp = mkdtempSync(join(tmpdir(), 'sleight-world-owned-'));
  try {
    const calls = [];
    const tasks = getWorldTasks({ defaults, real, open: async (_ctx, request) => { calls.push(request); return {}; } });
    const save = tasks.find(t => t.id === 'textedit-save'), ctx = { dir: temp, nonce: 'fixture' };
    await save.setup(ctx);
    assert.equal(calls[0].target, join(temp, 'fixture.txt'));
    assert.equal(calls[0].mode, 'document');
    assert.doesNotMatch(save.prompt(ctx), /sleight bench/);
    writeFileSync(ctx.document, 'fixture fixture\n');
    assert.equal(save.check(ctx), true);
    const chess = tasks.find(t => t.id === 'chess-drag');
    await assert.rejects(chess.setup({ ownerAway: true, chessProcessCheck: async () => ({ groupClean: true, exit: { code: 0 } }) }), /requires Chess to be closed/);
    assert.equal(calls.length, 1);
    const calculator = tasks.find(t => t.id === 'calculator-click');
    await assert.rejects(calculator.setup({ calculatorProcessCheck: async () => ({ groupClean: true, exit: { code: 0 } }),
      readCalculator: async () => { throw new Error('TEST_REACHED_READER'); } }), /requires Calculator to be closed/);
    assert.equal(calls.length, 1);
  } finally { removeTemp(temp); }
});

test('a failed Calculator read keeps its reason in the check result', async () => {
  const task = getTasks('world').find(t => t.id === 'calculator-click');
  const ctx = { expectedCalculator: '391', calculatorBefore: '0', answer: '391',
    readCalculator: async () => { throw new Error('WORLD_CALCULATOR_READ_FAILED: exit 1: Calculator window absent or ambiguous'); } };
  const result = await task.check(ctx);
  assert.match(result, /^WORLD_CALCULATOR_DISPLAY_UNAVAILABLE: /);
  assert.match(result, /Calculator window absent or ambiguous/);
  ctx.readCalculator = async () => '2 button ID: Mode: basic; unitConversion: false';
  assert.match(await task.check(ctx), /^WORLD_CALCULATOR_DISPLAY_(UNAVAILABLE|MISMATCH)/);
});
