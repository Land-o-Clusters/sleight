import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClipboardCoordinator } from '../plugins/sleight/lib/clipboard.mjs';

test('independent coordinators refuse overlap and release without leaking the reservation', () => {
  const bank = mkdtempSync('/private/tmp/sleight-clipboard-lock-');
  const a = createClipboardCoordinator(DatabaseSync, join(bank, 'lock.sqlite'));
  const b = createClipboardCoordinator(DatabaseSync, join(bank, 'lock.sqlite'));
  try {
    a.acquire(); assert.throws(() => b.acquire(), /Clipboard busy/);
    a.release(); b.acquire(); assert.throws(() => a.acquire(), /Clipboard busy/);
    b.release(); a.acquire(); a.release(); a.release();
  } finally { a.release(); b.release(); rmSync(bank, { recursive: true }); }
});
test('a process exit releases the transaction without stale-lock takeover', async () => {
  const bank = mkdtempSync('/private/tmp/sleight-clipboard-lock-'), path = join(bank, 'lock.sqlite');
  const contender = createClipboardCoordinator(DatabaseSync, path);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/clipboard-lock.mjs', import.meta.url)), path], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    const [data] = await once(child.stdout, 'data'); assert.match(data.toString(), /ready/);
    assert.throws(() => contender.acquire(), /Clipboard busy/);
    child.stdin.end(); assert.equal((await closed)[0], 7);
    contender.acquire(); contender.release();
  } finally { child.stdin.end(); await closed; contender.release(); rmSync(bank, { recursive: true }); }
});
