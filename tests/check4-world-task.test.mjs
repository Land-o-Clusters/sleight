import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { getWorldTasks } from '../bench/world/tasks.mjs';
import { tasks as defaults } from '../bench/tasks.mjs';
import { realTasks as real } from '../bench/tasks-real.mjs';
import { resolveTask } from '../bench/world/suite.mjs';

test('early-scroll task owns a multi-page PDF, hides its answer from the prompt and checks unchanged bytes', async t => {
  const opened = [];
  const tasks = getWorldTasks({ defaults, real, open: async (_ctx, spec) => { opened.push(spec); return { pid: 42 }; } });
  const task = tasks.find(t => t.id === 'preview-early-scroll');
  assert.ok(task, 'missing fixture-backed native scroll task');
  assert.equal((await resolveTask('native/preview-early-scroll')).id, task.id);
  const dir = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-check4-world-'))));
  const ctx = { dir, nonce: 'fixed' };
  await task.setup(ctx);
  assert.equal(opened.length, 1); assert.equal(opened[0].bundle, 'com.apple.Preview');
  assert.equal(opened[0].target, ctx.document);
  const pdf = readFileSync(ctx.document, 'utf8');
  assert.match(pdf, /\/Count 12\b/);
  assert.equal(pdf.includes(ctx.readback), true);
  assert.equal(task.prompt(ctx).includes(ctx.readback), false);
  assert.match(task.prompt(ctx), /first action.*scroll/i);
  assert.equal(task.heldOut, true);
  assert.notEqual(await task.check({ ...ctx, answer: 'wrong' }), true);
  assert.equal(await task.check({ ...ctx, answer: ctx.readback }), true);
  writeFileSync(ctx.document, pdf + 'changed');
  assert.notEqual(await task.check({ ...ctx, answer: ctx.readback }), true);
});

test('CH-6 both Preview tasks request an asserted fixture slot no wider than 1000 pt', async t => {
  const opened = [];
  const tasks = getWorldTasks({ defaults, real, open: async (_ctx, spec) => { opened.push(spec); return { pid: 42 }; } });
  for (const id of ['preview-read', 'preview-early-scroll']) {
    const dir = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-check4-preview-'))));
    await tasks.find(task => task.id === id).setup({ dir, nonce: id });
  }
  assert.equal(opened.length, 2);
  for (const spec of opened) assert.deepEqual(spec.placement, { slot: 0, count: 1 });
});
