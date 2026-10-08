import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function runner() {
  const module = await import('../bench/real-run.mjs').catch(() => ({}));
  assert.equal(typeof module.executeRealTask, 'function', 'runner must own real-task cleanup and locking');
  return module.executeRealTask;
}
function fixture(t) {
  const bank = mkdtempSync(join(tmpdir(), 'real-run-test-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  return { dir: join(bank, 'fixture'), nonce: 'abc123', lockPath: join(bank, 'lock') };
}

test('an explicit no-mutation acquisition refusal removes only that pending acquisition', async t => {
  const { acquireFixture } = await import('../bench/real-run.mjs');
  const ctx = fixture(t);
  await assert.rejects(acquireFixture(ctx, 'browser', async () => {
    throw Object.assign(new Error('app unavailable'), { noMutation: true });
  }), /unavailable/);
  assert.equal(ctx.pendingAcquisitions.size, 0);
  await assert.rejects(acquireFixture(ctx, 'browser', async () => { throw new Error('identity unknown'); }), /unknown/);
  assert.deepEqual([...ctx.pendingAcquisitions], ['browser']);
});

test('real runner holds the lock through the awaited check and cleanup, then removes fixture files', async t => {
  const execute = await runner(), ctx = fixture(t), order = [];
  const result = await execute({
    setup: c => { assert.ok(existsSync(c.lockPath)); writeFileSync(join(c.dir, 'file'), 'fixture'); order.push('setup'); },
    prompt: () => 'task',
    check: async () => { order.push('check'); return true; },
    cleanup: async c => { assert.ok(existsSync(c.lockPath)); await Promise.resolve(); order.push('cleanup'); },
  }, ctx, { drive: async () => { order.push('drive'); return { code: 0, out: { result: 'done' } }; } });
  assert.equal(result.passed, true);
  assert.deepEqual(order, ['setup', 'drive', 'check', 'cleanup']);
  assert.equal(existsSync(ctx.dir), false);
  assert.equal(existsSync(ctx.lockPath), false);
});

test('partial setup is cleaned and reported; a failed cleanup releases the exit lock and preserves its fixture', async t => {
  const execute = await runner(), ctx = fixture(t);
  let cleaned = false;
  const result = await execute({
    setup: () => { throw new Error('setup failed'); }, prompt: () => '', check: () => true,
    cleanup: () => { cleaned = true; },
  }, ctx, { drive: () => assert.fail('no agent call after failed setup') });
  assert.equal(cleaned, true);
  assert.match(result.reason, /setup failed/);
  assert.equal(existsSync(ctx.lockPath), false);
  const failed = await execute({ setup: () => {}, prompt: () => '', check: () => true,
    cleanup: () => { throw new Error('owned window remains'); },
  }, ctx, { drive: async () => ({ code: 0, out: {} }) });
  assert.equal(failed.passed, false);
  assert.match(failed.cleanupError, /owned window remains/);
  assert.equal(existsSync(ctx.lockPath), false);
  assert.equal(existsSync(ctx.dir), true);
});

test('dry run prepares and checks without launching apps, calling the driver or taking the live lock', async t => {
  const execute = await runner(), ctx = fixture(t);
  const result = await execute({ prepare: () => {}, setup: () => assert.fail('no UI setup'),
    prompt: () => 'fixture', check: () => 'not completed', cleanup: () => {},
  }, ctx, { dryRun: true, drive: () => assert.fail('no model call') });
  assert.equal(result.dryRun, true);
  assert.equal(result.check, 'not completed');
  assert.equal(existsSync(ctx.lockPath), false);
  assert.equal(existsSync(ctx.dir), false);
});

test('a successful disk check cannot hide a failed agent process', async t => {
  const execute = await runner(), ctx = fixture(t);
  const result = await execute({ setup: () => {}, prompt: () => '', check: () => true, cleanup: () => {} },
    ctx, { drive: async () => ({ code: 1, out: { result: 'done' } }) });
  assert.equal(result.passed, false);
  assert.match(result.reason, /driver exited/);
});

test('cancellation after setup prevents the agent call and still cleans the owned fixture', async t => {
  const execute = await runner(), ctx = fixture(t), controller = new AbortController();
  let cleaned = false;
  const result = await execute({ setup: () => controller.abort(), prompt: () => '', check: () => true,
    cleanup: () => { cleaned = true; },
  }, ctx, { signal: controller.signal, drive: () => assert.fail('no model call after cancellation') });
  assert.equal(result.passed, false);
  assert.equal(cleaned, true);
  assert.equal(existsSync(ctx.lockPath), false);
});

test('a macOS prompt during setup stops before driving and records the safety stop', async t => {
  const execute = await runner(), ctx = fixture(t), controller = new AbortController();
  let setupActive = false;
  const result = await execute({ setup: () => { setupActive = true; return new Promise(resolve => setTimeout(resolve, 3100)); },
    prompt: () => '', check: () => true, cleanup: () => {},
  }, ctx, { signal: controller.signal, permissionCheck: async () => setupActive, stop: () => controller.abort(),
    drive: () => assert.fail('no driver call after a permission prompt'),
  });
  assert.equal(result.permissionPrompt, true);
  assert.equal(result.passed, false);
  assert.match(result.reason, /macOS permission prompt/);
  assert.equal(existsSync(ctx.lockPath), false);
});

test('an unavailable permission observer refuses setup and releases only an untouched fixture', async t => {
  const execute = await runner(), ctx = fixture(t);
  const result = await execute({ setup: () => assert.fail('no setup without an observer'), cleanup: () => {} }, ctx,
    { permissionCheck: async () => { throw new Error('observer unavailable'); } });
  assert.equal(result.passed, false);
  assert.match(result.reason, /observer unavailable/);
  assert.equal(existsSync(ctx.lockPath), false);
});

test('permission observation continues while asynchronous cleanup owns the lock', async t => {
  const execute = await runner(), ctx = fixture(t), controller = new AbortController();
  let cleaning = false;
  const result = await execute({ setup: () => {}, prompt: () => '', check: () => true,
    cleanup: async () => { cleaning = true; await new Promise(resolve => setTimeout(resolve, 3100)); },
  }, ctx, { signal: controller.signal, permissionCheck: async () => cleaning, stop: () => controller.abort(),
    drive: async () => ({ code: 0, out: {} }),
  });
  assert.equal(result.permissionPrompt, true);
  assert.equal(result.passed, false);
  assert.match(result.reason, /macOS permission prompt/);
});

test('an unresolved acquisition or uncollected driver preserves the fixture and reports its failed cleanup', async t => {
  const execute = await runner(), ctx = fixture(t);
  const result = await execute({ setup: c => { c.pendingAcquisitions = new Set(['simulator']); throw new Error('launch failed after boot'); },
    cleanup: () => {},
  }, ctx);
  assert.match(result.cleanupError, /simulator/);
  assert.equal(existsSync(ctx.lockPath), false);
  ctx.pendingAcquisitions.clear();
  const uncollected = await execute({ setup: () => {}, prompt: () => '', check: () => true,
    cleanup: () => assert.fail('no window cleanup while driver can still act'),
  }, ctx, { drive: async () => ({ code: 0, out: {}, groupClean: false }) });
  assert.equal(uncollected.passed, false);
  assert.match(uncollected.cleanupError, /process group/);
  assert.equal(existsSync(ctx.lockPath), false);
});

test('fixture acquisition records ownership before resolving and retains uncertainty after a failed mutation', async () => {
  const { acquireFixture } = await import('../bench/real-run.mjs');
  const ctx = {};
  await acquireFixture(ctx, 'calculatorOwnership', async () => 'owned');
  assert.equal(ctx.calculatorOwnership, 'owned');
  assert.equal(ctx.pendingAcquisitions.size, 0);
  for (const stage of ['boot', 'bootstatus', 'viewer launch']) {
    await assert.rejects(acquireFixture(ctx, 'sim', async () => { throw new Error(stage); }), new RegExp(stage));
    assert.ok(ctx.pendingAcquisitions.has('sim'));
  }
});

test('a task under the runner-owned lock does not wait on itself or release its caller lock', async t => {
  const execute = await runner(), ctx = fixture(t);
  mkdirSync(ctx.lockPath);
  const result = await execute({ setup: () => {}, prompt: () => 'task', check: () => true,
    cleanup: () => assert.ok(existsSync(ctx.lockPath)),
  }, ctx, { lockHeld: true, signal: AbortSignal.timeout(150), drive: async () => ({ code: 0, out: {} }) });
  assert.equal(result.passed, true);
  assert.equal(existsSync(ctx.lockPath), true);
});

test('a refused cleanup collects fixture helpers before releasing its live lock', async t => {
  const execute = await runner(), ctx = fixture(t);
  let collected = false;
  ctx.windowLeases = [{ dispose: async () => {
    assert.ok(existsSync(ctx.lockPath));
    await new Promise(resolve => setTimeout(resolve, 10));
    collected = true;
    return true;
  } }];
  const result = await execute({ setup: () => {}, prompt: () => '', check: () => true,
    cleanup: () => assert.fail('no app actions while the driver remains active'),
  }, ctx, { drive: async () => ({ code: 1, groupClean: false }) });
  assert.equal(collected, true);
  assert.match(result.cleanupError, /process group/);
  assert.equal(existsSync(ctx.lockPath), false);
});
