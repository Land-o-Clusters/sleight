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
    if (command === '/usr/bin/osascript') {
      assert.deepEqual(args.slice(0, 2), ['-l', 'JavaScript']);
      assert.equal(args.at(-1), '321');
      return { stdout: '{"titles":["ChatGPT wants access to control Safari","fixture quit unexpectedly"]}' };
    }
    assert.equal(command, inspector);
    if (args[0] === 'app-info') { assert.deepEqual(args, ['app-info', '321']); return { stdout: '[{"isActive":true,"bundleIdentifier":"com.apple.UserNotificationCenter"}]' }; }
    assert.deepEqual(args, ['windows-for-pid', '321', '--scope', 'on-screen']);
    return { stdout: '[{"ownerPID":321,"ownerName":"UserNotificationCenter","layer":8}]' };
  };
  assert.deepEqual(await module.observePermission({ inspector, run }), {
    process: 'UserNotificationCenter', title: 'ChatGPT wants access to control Safari',
  });
  await assert.rejects(module.observePermission({ inspector: join(dir, 'missing'), run }), /observer unavailable/);
  await assert.rejects(module.observePermission({ inspector, run: async () => { throw new Error('inspection denied'); } }), /inspection denied/);
  const withTitles = titles => async (command, args) => command === '/usr/bin/osascript'
    ? { stdout: JSON.stringify({ titles }) } : run(command, args);
  assert.equal(await module.observePermission({ inspector, run: withTitles(['fixture quit unexpectedly']) }), false);
  await assert.rejects(module.observePermission({ inspector, run: withTitles([]) }), /visible authorization window/);
  assert.deepEqual(await module.observePermission({ inspector, run: withTitles(['(untitled)']) }), {
    process: 'UserNotificationCenter', title: '(untitled)',
  });
});
