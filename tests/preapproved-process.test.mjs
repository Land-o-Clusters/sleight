import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOwned } from '../bench/preapproved-process.mjs';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';

const hangs = `
  const {spawn} = require('node:child_process');
  process.on('SIGTERM', () => {});
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'], {stdio:'inherit'});
  setInterval(()=>{},1000);
`;
test('a timeout collects a process group even when the child and descendant ignore TERM', async () => {
  const start = Date.now();
  const result = await runOwned(process.execPath, ['-e', hangs], { timeoutMs: 300, graceMs: 100 });
  assert.equal(result.exit.signal, 'SIGKILL'); assert.equal(result.timedOut, true);
  assert.equal(result.groupClean, true);
  assert.match(result.stdout, /ready/); assert.ok(Date.now() - start < 3000);
});
test('cancellation collects the same owned group before returning its evidence', async () => {
  const controller = new AbortController();
  const result = await runOwned(process.execPath, ['-e', hangs], { timeoutMs: 2000, graceMs: 100,
    signal: controller.signal, onStdout: data => { if (String(data).includes('ready')) controller.abort(); } });
  assert.equal(result.exit.signal, 'SIGKILL'); assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false); assert.match(result.stdout, /ready/);
  assert.equal(result.groupClean, true);
});
test('normal exit and spawn failure keep their actual exit evidence', async () => {
  const normal = await runOwned(process.execPath, ['-e', 'console.log("done");process.exit(7)']);
  assert.deepEqual(normal.exit, { code: 7, signal: null }); assert.match(normal.stdout, /done/);
  const missing = await runOwned('/does-not-exist/sleight-test', []);
  assert.equal(missing.exit.code, -2); assert.match(missing.spawnError, /ENOENT/);
});
test('parent exit does not release an active descendant with redirected output', async () => {
  const code = `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); process.on("disconnect",()=>{}); process.send("ready"); setTimeout(()=>process.exit(0),2000); setInterval(()=>{},1000)'], {stdio:['ignore','ignore','ignore','ipc']});
    child.on('message', () => { console.log(child.pid); process.exit(0); });
  `;
  const result = await runOwned(process.execPath, ['-e', code], { graceMs: 100 });
  const pid = Number(result.stdout.trim());
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(result.groupClean, true);
});

for (const code of ['ESRCH', 'EPERM']) {
  test(`post-exit ${code} probe collects the owned group without retrying`, async t => {
    const nativeKill = process.kill;
    let probes = 0;
    t.mock.method(process, 'kill', (pid, signal) => {
      if (signal === 0) { probes++; throw Object.assign(new Error('group gone'), { code }); }
      return nativeKill(pid, signal);
    });
    const result = await runOwned(process.execPath, ['-e', 'process.exit(7)'], { graceMs: 40 });
    assert.equal(result.groupClean, true);
    assert.deepEqual(result.exit, { code: 7, signal: null });
    assert.equal(probes, 1);
  });
  for (const action of ['SIGTERM', 'SIGKILL']) {
    test(`post-exit ${action} ${code} collects a group that disappeared after its probe`, async t => {
      const sent = [];
      t.mock.method(process, 'kill', (_pid, signal) => {
        if (signal === 0) return true;
        sent.push(signal);
        if (signal === action) throw Object.assign(new Error('group gone'), { code });
        return true;
      });
      const result = await runOwned(process.execPath, ['-e', 'process.exit(0)'], { graceMs: 10 });
      assert.equal(result.groupClean, true);
      assert.deepEqual(result.exit, { code: 0, signal: null });
      assert.deepEqual(sent, action === 'SIGTERM' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL']);
    });
  }
}
test('EPERM still fails cancellation before the leader exits', async t => {
  const child = Object.assign(new EventEmitter(), { pid: 123456, stdout: new PassThrough(), stderr: new PassThrough() });
  t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -child.pid); assert.equal(signal, 'SIGTERM');
    throw Object.assign(new Error('live group denied'), { code: 'EPERM' });
  });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runOwned('fixture', [], { signal: controller.signal }), { code: 'EPERM' });
});
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
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('unexpected failure'), { code: 'EIO' }); });
  await assert.rejects(runOwned(process.execPath, ['-e', 'process.exit(0)']), { code: 'EIO' });
});
