import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('permission observation targets only the authorization process, never browser windows', async t => {
  const module = await import('../bench/real-permission.mjs').catch(() => ({}));
  assert.equal(typeof module.observePermission, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'real-observer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inspector = join(dir, 'inspector');
  writeFileSync(inspector, 'fixture');
  const run = async (command, args) => {
    if (command === '/usr/bin/pgrep') { assert.deepEqual(args, ['-x', 'UserNotificationCenter']); return { stdout: '321\n' }; }
    assert.equal(command, inspector);
    if (args[0] === 'app-info') { assert.deepEqual(args, ['app-info', '321']); return { stdout: '[{"isActive":true,"bundleIdentifier":"com.apple.UserNotificationCenter"}]' }; }
    assert.deepEqual(args, ['windows-for-pid', '321', '--scope', 'on-screen']);
    return { stdout: '[{"ownerPID":321,"ownerName":"UserNotificationCenter","layer":8}]' };
  };
  assert.equal(await module.observePermission({ inspector, run }), true);
  await assert.rejects(module.observePermission({ inspector: join(dir, 'missing'), run }), /observer unavailable/);
  await assert.rejects(module.observePermission({ inspector, run: async () => { throw new Error('inspection denied'); } }), /inspection denied/);
});
