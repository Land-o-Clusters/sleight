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
