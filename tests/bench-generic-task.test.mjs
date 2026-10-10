import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { genericTask } from '../bench/generic-task.mjs';
import { tasks } from '../bench/tasks.mjs';
import { executeRealTask } from '../bench/real-run.mjs';

function context(t) {
  const dir = mkdtempSync(join(tmpdir(), 'generic-task-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, nonce: 'unit', signal: new AbortController().signal };
}

test('generic default setup preserves prompts and checks and only acquires tracked fixtures', async t => {
  for (const original of tasks.filter(task => task.app !== 'Simulator')) {
    const ctx = { ...context(t), ownerAway: true };
    const acquired = [];
    const task = genericTask({ ...original, setup: () => assert.fail('legacy setup'), cleanup: () => assert.fail('legacy cleanup') }, {
      open: async (_ctx, request) => { acquired.push(request); return {}; },
    });
    assert.equal(task.prompt, original.prompt); assert.equal(task.check, original.check);
    await task.setup(ctx); await task.cleanup(ctx);
    assert.equal(acquired.length, 1);
    assert.equal(acquired[0].stopOnAppDialog, true);
    if (ctx.document) { assert.equal(readFileSync(ctx.document, 'utf8'), 'alpha beta gamma\n'); assert.equal(acquired[0].mode, 'document'); }
    else assert.equal(acquired[0].mode, 'inherit');
  }
});

test('an application approval stops before the model and performs no fixture close', async t => {
  const ctx = context(t), control = new AbortController();
  const original = tasks.find(task => task.id === 'calculator-click');
  let disposed = 0;
  const task = genericTask(original, { open: async (ctx, request) => {
    assert.equal(request.stopOnAppDialog, true);
    ctx.windowLeases = [{ close: () => assert.fail('no AX after approval stop'), dispose: async () => { disposed++; return true; } }];
    ctx.onAppDialog({ app: request.app, category: 'permission', stop: true });
    return {};
  } });
  const result = await executeRealTask(task, ctx, { lockHeld: true, signal: control.signal,
    permissionCheck: async () => false, stop: () => control.abort(), drive: () => assert.fail('no model after approval stop') });
  assert.equal(result.passed, false); assert.match(result.reason, /dialog/); assert.equal(disposed, 1);
});

test('a hold or observer failure before setup prevents application launch', async t => {
  const ctx = context(t), control = new AbortController();
  const task = genericTask(tasks[0], { open: () => assert.fail('no launch during hold') });
  const result = await executeRealTask(task, ctx, { lockHeld: true, signal: control.signal,
    permissionCheck: async () => { throw new Error('/tmp/sleight-hold exists'); }, stop: () => control.abort() });
  assert.equal(result.passed, false); assert.match(result.reason, /sleight-hold/);
});
