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

test('fixture-only diagnostics run setup and cleanup under the lock without a model or task verdict', async t => {
  const execute = await runner(), ctx = fixture(t), calls = [];
  const result = await execute({ setup() { assert.equal(existsSync(ctx.lockPath), true); calls.push('setup'); },
    prompt: () => 'fixture', check: () => assert.fail('no task verdict without a model'),
    cleanup: () => calls.push('cleanup') }, ctx, {
    setupOnly: true, drive: () => assert.fail('fixture-only run must not start a model'), permissionCheck: async () => false,
  });
  assert.equal(result.setupOnly, true);
  assert.equal(result.passed, true);
  assert.deepEqual(calls, ['setup', 'cleanup']);
  assert.equal(existsSync(ctx.lockPath), false);
});

test('an Office activation dialog stops before a model and suppresses AX cleanup', async t => {
  const execute = await runner(), ctx = fixture(t), controller = new AbortController();
  const dialog = { app: 'Microsoft Word', category: 'activation', description: 'activation application dialog' };
  let disposed = false;
  const result = await execute({ setup(context) {
    context.windowLeases = [{ dispose: async () => { disposed = true; return true; } }];
    context.onAppDialog(dialog);
    throw new Error('activation');
  }, cleanup: () => assert.fail('never press a close or licensing button after an app-dialog stop') }, ctx, {
    signal: controller.signal, stop: () => controller.abort(), drive: () => assert.fail('no model before licensing is resolved'),
    permissionCheck: async () => false,
  });
  assert.deepEqual(result.appDialog, dialog);
  assert.match(result.reason, /activation.*stopped/);
  assert.equal(disposed, true);
  assert.equal(result.passed, false);
});

test('an application result dialog is recorded while the driver checker and cleanup continue', async t => {
  const execute = await runner(), ctx = fixture(t), calls = [];
  const dialog = { app: 'Microsoft Word', category: 'application-result', title: 'Microsoft Word', buttons: ['OK'], stop: false };
  const result = await execute({ setup() {}, prompt: () => 'fixture', check: () => { calls.push('check'); return true; },
    cleanup: () => calls.push('cleanup') }, ctx, {
    drive: async (_prompt, context) => {
      context.onAppDialog(dialog); context.onAppDialog(dialog);
      assert.equal(context.cleanupSignal.aborted, false);
      calls.push('driver');
      return { code: 0, groupClean: true, out: { result: 'done' } };
    }, stop: () => assert.fail('a result dialog must remain available to the model'),
  });
  assert.equal(result.passed, true);
  assert.equal(result.appDialog, undefined);
  assert.deepEqual(result.appDialogs, [dialog]);
  assert.deepEqual(calls, ['driver', 'check', 'cleanup']);
});

test('an app dialog during the model stops before an app-data checker or AX cleanup', async t => {
  const execute = await runner(), ctx = fixture(t), controller = new AbortController();
  const dialog = { app: 'Microsoft Excel', category: 'sign-in', description: 'sign-in application dialog' };
  let disposed = false, serverClosed = false;
  const result = await execute({ setup(context) {
    context.windowLeases = [{ dispose: async () => { disposed = true; return true; } }];
    context.closeServer = async () => { serverClosed = true; };
  }, prompt: () => 'fixture', check: () => assert.fail('checker must not export app data after a dialog'),
  cleanup: () => assert.fail('no AX action after a dialog') }, ctx, {
    signal: controller.signal, stop: () => controller.abort(), permissionCheck: async () => false,
    drive: async (_prompt, context) => {
      context.onAppDialog(dialog);
      return { code: 0, groupClean: true, out: { result: 'done' } };
    },
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.appDialogs, [dialog]);
  assert.match(result.reason, /sign-in.*stopped/);
  assert.equal(disposed, true);
  assert.equal(serverClosed, true);
  assert.equal(existsSync(ctx.dir), true);
  assert.equal(existsSync(ctx.lockPath), false);
});

test('a failed setup action is recorded without forcing a stop after confirmed cleanup', async t => {
  const execute = await runner(), ctx = fixture(t);
  const result = await execute({ setup(context) {
    context.fixtureDiagnostics = [{ actionTaken: true, cleanup: 'nothing created', retries: [], totalWaitMs: 0 }];
    throw new Error('read failed after action');
  }, cleanup() {} }, ctx);
  assert.equal(result.stopAfterAction, undefined);
  assert.equal(result.cleanupError, undefined);
  assert.equal(result.fixtureDiagnostics[0].cleanup, 'nothing created');
  assert.equal(existsSync(ctx.lockPath), false);
});

test('unconfirmed setup without an owned reference preserves evidence without a cleanup error', async t => {
  const execute = await runner(), ctx = fixture(t);
  const result = await execute({ setup(context) {
    context.fixtureDiagnostics = [{ cleanup: 'unconfirmed', retries: [], totalWaitMs: 0 }];
    throw new Error('no owned window reference');
  }, cleanup() {} }, ctx);
  assert.equal(result.cleanupUnconfirmed, true);
  assert.equal(result.cleanupError, undefined);
  assert.equal(existsSync(ctx.dir), true);
  assert.equal(existsSync(ctx.lockPath), false);
});

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

test('a browser permission refusal records the stop and still closes the retained owned fixture', async t => {
  const execute = await runner(), ctx = fixture(t), controller = new AbortController();
  let cleaned = false;
  const result = await execute({ setup() {}, prompt: () => 'fixture', check: () => true,
    cleanup(context) { assert.equal(context.cleanupSignal.aborted, false); cleaned = true; } }, ctx, {
    signal: controller.signal, stop: () => controller.abort(), permissionCheck: async () => false,
    drive: async (_prompt, _ctx, callbacks) => {
      callbacks.onPermissionRefusal();
      return { code: null, cancelled: true, groupClean: true };
    },
  });
  assert.equal(result.permissionRefusal, true);
  assert.equal(result.passed, false);
  assert.match(result.reason, /computer-use permission/);
  assert.equal(cleaned, true);
  assert.equal(existsSync(ctx.lockPath), false);
  assert.equal(existsSync(ctx.dir), false);
});

test('a prompt appearing with a streamed refusal is observed before any fixture close', async t => {
  const execute = await runner(), ctx = fixture(t), controller = new AbortController();
  let visible = false, observations = 0, serverClosed = false;
  ctx.closeServer = async () => { serverClosed = true; };
  const result = await execute({ setup() {}, prompt: () => 'fixture', check: () => true,
    cleanup() { assert.fail('must not close a fixture while a permission window is visible'); } }, ctx, {
    signal: controller.signal, stop: () => controller.abort(),
    permissionCheck: async () => { observations++; return visible ? { process: 'Authorization', title: 'Permission' } : false; },
    drive: async (_prompt, _ctx, callbacks) => {
      visible = true; callbacks.onPermissionRefusal();
      return { code: null, cancelled: true, groupClean: true };
    },
  });
  assert.equal(observations, 2);
  assert.equal(result.permissionPrompt, true);
  assert.deepEqual(result.permissionWindow, { process: 'Authorization', title: 'Permission' });
  assert.match(result.cleanupError, /permission/);
  assert.equal(serverClosed, true);
  assert.equal(existsSync(ctx.dir), true);
  assert.equal(existsSync(ctx.lockPath), false);
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
