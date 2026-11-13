import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as maintenance from '../bench/windows/uc3f-maintenance.mjs';

async function proof(run) {
  const events = [], options = { sshConfig: 'config', tools: '/tools', script: 'operation.ps1' };
  const dependencies = { platform: 'darwin', env: { CLAUDE_CONFIG_DIR: 'isolated' },
    noHold() { events.push('hold'); }, readFile: path => path === 'config' ? 'Host vm\n  HostName 192.168.64.8\n' : '& { Write-Output OK }\n\n',
    acquireLiveLock: async () => { events.push('lock'); return async () => events.push('unlock'); },
    startGuard: () => ({ records: [{ record: 'system-overlay', state: 'appeared', pid: 734, window: 34, layer: 21, timeUtcMs: 1000, onscreenMs: 0, title: 'PRIVATE' }],
      start: async () => events.push('arm'), check: async () => { events.push('guard'); return { hidIdleMs: 31000 }; }, close: async () => events.push('close') }),
    runChild: async (command, args, settings) => {
      assert.equal(command, '/usr/bin/ssh'); assert.ok(args.includes('HostName=192.168.64.8'));
      assert.ok(events.includes('lock')); assert.equal(events.at(-1), 'hold');
      assert.ok(events.includes('guard')); assert.match(settings.input, /Write-Output OK/);
      events.push('ssh'); return { status: 0, stdout: 'OK\n', stderr: '' };
    } };
  const result = await run(options, dependencies);
  assert.deepEqual(result.systemOverlays, [{ state: 'appeared', pid: 734, window: 34, layer: 21, timeUtcMs: 1000, onscreenMs: 0 }]);
  assert.ok(events.indexOf('arm') < events.indexOf('ssh'));
  assert.deepEqual(events.slice(-2), ['close', 'unlock']);
  events.length = 0;
  dependencies.startGuard = () => ({ start: async () => {}, check: async () => ({ hidIdleMs: 0 }), close: async () => events.push('close') });
  await assert.rejects(run(options, dependencies), /PERSON_ACTIVE/); assert.ok(!events.includes('ssh'));
}
test('maintenance owns a guarded lock and refuses active HID before SSH', async () => {
  await proof(maintenance.runMaintenance);
  const url = new URL('../bench/windows/uc3f-maintenance.mjs', import.meta.url);
  let source = readFileSync(url, 'utf8'); const before = 'await guard.check()';
  assert.ok(source.includes(before));
  source = source.replace(before, '({ hidIdleMs: 31000 })').replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, url).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  const broken = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  await assert.rejects(proof(broken.runMaintenance), assert.AssertionError);
});

test('kit copy refuses an existing guest destination before SCP', async () => {
  async function verify(run) {
    let copied = false;
    await assert.rejects(run({ sshConfig: 'config', tools: '/tools', copyKit: '/kit' }, {
    platform: 'darwin', env: { CLAUDE_CONFIG_DIR: 'isolated' }, noHold() {},
    readFile: path => path === 'config' ? 'Host vm\n  HostName 192.168.64.8\n' : '{}',
    acquireLiveLock: async () => async () => {},
    startGuard: () => ({ start: async () => {}, check: async () => ({ hidIdleMs: 31000 }), close: async () => {} }),
    runChild: async command => { if (command === '/usr/bin/scp') copied = true; return { status: 1, stdout: '', stderr: '' }; },
    }), /MAINTENANCE_FAILED/);
    assert.equal(copied, false);
  }
  await verify(maintenance.runMaintenance);
  const url = new URL('../bench/windows/uc3f-maintenance.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8').replace('    if (options.copyKit) {', '    if (false) {')
    .replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, url).href}'`).replaceAll('import.meta.url', JSON.stringify(url.href));
  const broken = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  await assert.rejects(verify(broken.runMaintenance), assert.AssertionError);
});

test('a rejected guard close still releases the live lock', async () => {
  async function prove(run) {
    let unlocked = false;
    await assert.rejects(run({ sshConfig: 'config', tools: '/tools', script: 'operation.ps1' }, {
      platform: 'darwin', env: { CLAUDE_CONFIG_DIR: 'isolated' }, noHold() {},
      readFile: path => path === 'config' ? 'Host vm\n  HostName 192.168.64.8\n' : '& { Write-Output OK }\n\n',
      acquireLiveLock: async () => async () => { unlocked = true; },
      startGuard: () => ({ start: async () => {}, check: async () => ({ hidIdleMs: 31000 }), close: async () => { throw Error('CLEANUP_UNCONFIRMED'); } }),
      runChild: async () => ({ status: 0, stdout: 'OK\n', stderr: '' }),
    }), /CLEANUP_UNCONFIRMED/);
    assert.equal(unlocked, true);
  }
  await prove(maintenance.runMaintenance);
  const url = new URL('../bench/windows/uc3f-maintenance.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8').replace(
    `  } finally {
    // A rejected guard close must not skip the lock release.
    try { await guard?.close(); } catch (error) { failure ??= error; }
    try { await unlock?.(); } catch (error) { failure ??= error; }
  }`,
    `  } finally {
    await guard?.close();
    await unlock?.();
  }`).replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, url).href}'`).replaceAll('import.meta.url', JSON.stringify(url.href));
  const broken = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  await assert.rejects(prove(broken.runMaintenance), assert.AssertionError);
});
