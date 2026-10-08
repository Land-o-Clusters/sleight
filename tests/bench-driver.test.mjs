import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('default driver cancellation collects the driver while the pass lock remains held', async t => {
  const { runDriver } = await import('../bench/driver.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'bench-driver-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, 'lock'), receipt = join(dir, 'receipt');
  writeFileSync(lock, 'held');
  const controller = new AbortController();
  const response = await runDriver(process.execPath, ['-e', `
    const fs = require('node:fs');
    process.on('SIGTERM', () => setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(receipt)}, String(fs.existsSync(${JSON.stringify(lock)})));
      process.exit(0);
    }, 150));
    setInterval(() => {}, 1000);
    console.log(JSON.stringify({result:'ready'}));
  `], { format: 'json', signal: controller.signal, graceMs: 2000,
    onStdout: () => controller.abort() });
  assert.equal(response.groupClean, true);
  assert.equal(response.cancelled, true);
  assert.equal(readFileSync(receipt, 'utf8'), 'true');
  assert.equal(existsSync(lock), true);
});

test('a streamed browser permission refusal stops before another driver action', async t => {
  const { runDriver } = await import('../bench/driver.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'bench-permission-stop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'another-action'), controller = new AbortController();
  let refusals = 0;
  const event = { type: 'user', message: { content: [{ type: 'tool_result', is_error: true,
    content: 'Browser Use could not complete this action because a browser security check was unavailable. Reason: The permission request was dismissed before a decision was made.' }] } };
  const response = await runDriver(process.execPath, ['-e', `
    console.log(JSON.stringify({message:{content:{unexpected:'frame'}}}));
    console.log(JSON.stringify({message:{content:[{type:'tool_result',content:'Browser Use could not complete this action: permission request dismissed',is_error:false}]}}));
    console.log(${JSON.stringify(JSON.stringify(event))});
    setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'wrong'), 200);
    setInterval(() => {}, 1000);
  `], { format: 'stream-json', signal: controller.signal, timeoutMs: 1500, graceMs: 500,
    onPermissionRefusal: () => { refusals++; controller.abort(); } });
  assert.equal(refusals, 1);
  assert.equal(response.cancelled, true);
  assert.equal(response.groupClean, true);
  assert.equal(existsSync(marker), false);
});
