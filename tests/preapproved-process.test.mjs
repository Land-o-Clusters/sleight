import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOwned } from '../bench/preapproved-process.mjs';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';

function ownedProcess(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const child = Object.assign(new EventEmitter(), { pid: 123456, stdout: new PassThrough(), stderr: new PassThrough() });
  const sent = []; let alive = true, closed = false;
  const close = (code, signal, groupGone = true) => { closed = true; if (groupGone) alive = false;
    child.emit('exit', code, signal); child.emit('close', code, signal); };
  t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -child.pid);
    if (!alive) throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
    if (signal !== 0) sent.push(signal);
    if (signal === 'SIGKILL') { alive = false; if (!closed) close(null, signal); }
    return true;
  });
  return { child, sent, close };
}
test('owned runs pass the specified benchmark environment to their child', async t => {
  const { child, close } = ownedProcess(t);
  const env = { SLEIGHT_BENCH_TEST_VALUE: 'fixture-trace' };
  const pending = runOwned('fixture', ['arg'], { env });
  assert.deepEqual(childProcess.spawn.mock.calls[0].arguments, ['fixture', ['arg'],
    { cwd: undefined, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }]);
  child.stdout.write('fixture-trace\n'); close(0, null);
  const result = await pending;
  assert.equal(result.stdout.trim(), 'fixture-trace');
  assert.equal(result.groupClean, true);
});
test('a timeout collects a process group even when the child and descendant ignore TERM', async t => {
  const { child, sent } = ownedProcess(t);
  const pending = runOwned('fixture', [], { timeoutMs: 300, graceMs: 100 });
  child.stdout.write('ready\n');
  t.mock.timers.tick(299); assert.deepEqual(sent, []);
  t.mock.timers.tick(1); assert.deepEqual(sent, ['SIGTERM']);
  t.mock.timers.tick(99); assert.deepEqual(sent, ['SIGTERM']);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.exit.signal, 'SIGKILL'); assert.equal(result.timedOut, true);
  assert.equal(result.groupClean, true);
  assert.match(result.stdout, /ready/);
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
});
test('cancellation collects the same owned group before returning its evidence', async t => {
  const { child, sent } = ownedProcess(t);
  const controller = new AbortController();
  const pending = runOwned('fixture', [], { timeoutMs: 2000, graceMs: 100,
    signal: controller.signal, onStdout: data => { if (String(data).includes('ready')) controller.abort(); } });
  child.stdout.write('ready\n');
  assert.deepEqual(sent, ['SIGTERM']);
  t.mock.timers.tick(100);
  const result = await pending;
  assert.equal(result.exit.signal, 'SIGKILL'); assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false); assert.match(result.stdout, /ready/);
  assert.equal(result.groupClean, true);
});
test('normal exit and spawn failure keep their actual exit evidence', async t => {
  const { child, close } = ownedProcess(t);
  const pending = runOwned('fixture', []);
  child.stdout.write('done\n'); close(7, null);
  const normal = await pending;
  assert.deepEqual(normal.exit, { code: 7, signal: null }); assert.match(normal.stdout, /done/);
  const { stdoutAt, closeAt, groupGoneAt } = normal.stamps;
  assert.ok(stdoutAt <= closeAt && closeAt <= groupGoneAt, JSON.stringify(normal.stamps));
  child.pid = undefined;
  const failed = runOwned('/does-not-exist/sleight-test', []);
  child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })); close(-2, null);
  const missing = await failed;
  assert.equal(missing.exit.code, -2); assert.match(missing.spawnError, /ENOENT/);
});
test('parent exit does not release an active descendant with redirected output', async t => {
  const { sent, close } = ownedProcess(t);
  let finished = false;
  const pending = runOwned('fixture', [], { graceMs: 100 }).then(result => { finished = true; return result; });
  close(0, null, false);
  for (let i = 0; i < 12; i++) { await Promise.resolve(); t.mock.timers.tick(20); }
  const result = await pending;
  assert.equal(finished, true);
  assert.deepEqual(result.exit, { code: 0, signal: null });
  assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.groupClean, true);
});

for (const code of ['ESRCH', 'EPERM']) {
  test(`post-exit ${code} probe collects the owned group without retrying`, async t => {
    const { close } = ownedProcess(t);
    const nativeKill = process.kill;
    let probes = 0;
    t.mock.method(process, 'kill', (pid, signal) => {
      if (signal === 0) { probes++; throw Object.assign(new Error('group gone'), { code }); }
      return nativeKill(pid, signal);
    });
    const pending = runOwned('fixture', [], { graceMs: 40 }); close(7, null);
    const result = await pending;
    assert.equal(result.groupClean, true);
    assert.deepEqual(result.exit, { code: 7, signal: null });
    assert.equal(probes, 1);
  });
  for (const action of ['SIGTERM', 'SIGKILL']) {
    test(`post-exit ${action} ${code} collects a group that disappeared after its probe`, async t => {
      const { close } = ownedProcess(t);
      const sent = [];
      t.mock.method(process, 'kill', (_pid, signal) => {
        if (signal === 0) return true;
        sent.push(signal);
        if (signal === action) throw Object.assign(new Error('group gone'), { code });
        return true;
      });
      const pending = runOwned('fixture', [], { graceMs: 10 }); close(0, null);
      for (let i = 0; i < 12; i++) { await Promise.resolve(); t.mock.timers.tick(20); }
      const result = await pending;
      assert.equal(result.groupClean, true);
      assert.deepEqual(result.exit, { code: 0, signal: null });
      assert.deepEqual(sent, action === 'SIGTERM' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL']);
    });
  }
}
for (const trigger of ['abort listener', 'already aborted', 'timeout']) {
  test(`live EPERM during ${trigger} waits for exit and reports unconfirmed cleanup`, async t => {
    const { child, close } = ownedProcess(t);
    const sent = []; let abort, finished = false;
    const signal = { aborted: trigger === 'already aborted',
      addEventListener: (_name, listener) => { abort = listener; }, removeEventListener() {} };
    t.mock.method(process, 'kill', (pid, name) => {
      assert.equal(pid, -child.pid);
      if (name !== 0) { sent.push(name); throw Object.assign(new Error('live group denied'), { code: 'EPERM' }); }
      throw Object.assign(new Error('exited group denied'), { code: 'EPERM' });
    });
    const pending = runOwned('fixture', [], { signal, timeoutMs: 200, graceMs: 100 });
    pending.then(() => { finished = true; }, () => { finished = true; });
    if (trigger === 'abort listener') assert.doesNotThrow(() => abort());
    if (trigger === 'timeout') assert.doesNotThrow(() => t.mock.timers.tick(200));
    await Promise.resolve();
    assert.equal(finished, false, 'a signal failure must keep waiting for the child');
    assert.doesNotThrow(() => t.mock.timers.tick(100));
    assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
    child.stdout.write('last evidence\n'); close(7, null);
    const result = await pending;
    assert.deepEqual(result.exit, { code: 7, signal: null });
    assert.equal(result.groupClean, false);
    assert.equal(result.cancelled, trigger !== 'timeout');
    assert.equal(result.timedOut, trigger === 'timeout');
    assert.match(result.stdout, /last evidence/);
    assert.deepEqual(result.signalErrors, [
      { signal: 'SIGTERM', code: 'EPERM', message: 'live group denied' },
      { signal: 'SIGKILL', code: 'EPERM', message: 'live group denied' },
    ]);
  });
}
test('EPERM cancellation after leader exit but before pipe close collects the group', async t => {
  const child = Object.assign(new EventEmitter(), { pid: 123456, stdout: new PassThrough(), stderr: new PassThrough() });
  t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -child.pid); assert.equal(signal, 'SIGTERM');
    throw Object.assign(new Error('exited group denied'), { code: 'EPERM' });
  });
  const controller = new AbortController();
  const pending = runOwned('fixture', [], { signal: controller.signal });
  child.emit('exit', 7, null);
  controller.abort();
  child.emit('close', 7, null);
  const result = await pending;
  assert.deepEqual(result.exit, { code: 7, signal: null });
  assert.equal(result.cancelled, true); assert.equal(result.groupClean, true);
});
test('other post-exit signaling errors still fail cleanup', async t => {
  const { close } = ownedProcess(t);
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('unexpected failure'), { code: 'EIO' }); });
  const pending = runOwned('fixture', []); close(0, null);
  await assert.rejects(pending, { code: 'EIO' });
});
