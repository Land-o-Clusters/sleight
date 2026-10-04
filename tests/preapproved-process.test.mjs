import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOwned } from '../bench/preapproved-process.mjs';

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
  assert.match(result.stdout, /ready/); assert.ok(Date.now() - start < 3000);
});
test('cancellation collects the same owned group before returning its evidence', async () => {
  const controller = new AbortController();
  const result = await runOwned(process.execPath, ['-e', hangs], { timeoutMs: 2000, graceMs: 100,
    signal: controller.signal, onStdout: data => { if (String(data).includes('ready')) controller.abort(); } });
  assert.equal(result.exit.signal, 'SIGKILL'); assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false); assert.match(result.stdout, /ready/);
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
