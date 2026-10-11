import { test } from './macos-only.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { routineGuard } from '../plugins/sleight/lib/routines.mjs';
import { acquireRoutineLock, clearRoutineLock, sameProcessStart } from '../plugins/sleight/lib/routine-lock.mjs';
import { resolveInstall, launchRoutine } from '../plugins/sleight/lib/routine-launcher.mjs';
import { relayServer } from '../plugins/sleight/lib/replay.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const app = { name: 'Calculator', bundle: 'com.apple.calculator', pid: 123, windows: [{ title: 'Calculator' }] };
const snapshot = { result: { content: [{ type: 'text', text: 'Window: "Calculator", App: Calculator.\n0 standard window Calculator' }] } };
const tree = (title, url) => ({ result: { content: [{ type: 'text', text: `Window: ${JSON.stringify(title)}, App: Calculator.${url ? `\nURL: ${url}` : ''}` }] } });
test('routine guard waits for idle, binds existing windows, and stops before input when the user returns', async () => {
  let state = { idleSeconds: 119, apps: [app] }, calls = 0;
  const guard = routineGuard(['Calculator'], async () => state);
  await assert.rejects(guard.start(), error => error.idle === true);
  state = { idleSeconds: 120, apps: [] };
  await assert.rejects(guard.start(), /not running/);
  state = { idleSeconds: 120, apps: [app] };
  await guard.start();
  const args = { code: 'let app = await cua.getApp("Calculator");' };
  await guard.beforeCall('js', args, () => { calls++; return snapshot; });
  assert.equal(args.code, 'let app = await cua.getApp("com.apple.calculator");');
  assert.doesNotMatch(args.code, /windowId/);
  state = { idleSeconds: 0, apps: [app] };
  await assert.rejects(guard.beforeCall('js', { code: 'await app.click({"id":"Seven"});' }, () => { calls++; return snapshot; }), /user.*active/);
  assert.equal(calls, 0);
  state = { idleSeconds: 120, apps: [{ ...app, pid: 124 }] };
  await assert.rejects(guard.beforeCall('js', { code: 'await app.click({"id":"Seven"});' }, () => snapshot), /changed|not running/);
});
test('routine guard confirms the acquired window title and URL before input', async () => {
  const calc = { ...app, windows: [{ title: 'Calculator' }] };
  const guard = routineGuard(['Calculator'], async () => ({ idleSeconds: 120, apps: [calc] }));
  await guard.start();
  const acquire = { code: 'let app = await cua.getApp("Calculator");' };
  await guard.beforeCall('js', acquire, () => snapshot);
  assert.equal(acquire.code, 'let app = await cua.getApp("com.apple.calculator");');
  await guard.beforeCall('js', { code: 'await app.click({"id":"Seven"});' }, () => snapshot);
  await assert.rejects(guard.beforeCall('js', { code: 'await app.click({"id":"Eight"});' }, () => tree('Notes')), /title or URL/);
});
test('routine guard requires an exact URL match when the existing window named one', async () => {
  const doc = { name: 'TextEdit', bundle: 'com.apple.TextEdit', pid: 9, windows: [{ title: 'Untitled', url: 'file:///tmp/a.txt' }] };
  const guard = routineGuard(['com.apple.TextEdit'], async () => ({ idleSeconds: 120, apps: [doc] }));
  await guard.start();
  const acquire = { code: 'let app = await cua.getApp("com.apple.TextEdit");' };
  await guard.beforeCall('js', acquire, () => tree('Untitled', 'file:///tmp/a.txt'));
  assert.equal(acquire.code, 'let app = await cua.getApp("com.apple.TextEdit");');
  await guard.beforeCall('js', { code: 'await app.setValue({"label":"Text"},"x");' }, () => tree('Untitled', 'file:///tmp/a.txt'));
  await assert.rejects(guard.beforeCall('js', { code: 'await app.setValue({"label":"Text"},"y");' },
    () => tree('Untitled', 'file:///tmp/other.txt')), /title or URL/);
});
test('idle is checked again after the AX read, immediately before input', async () => {
  let idle = 120;
  const guard = routineGuard(['Calculator'], async () => ({ idleSeconds: idle, apps: [app] }));
  await guard.start();
  await assert.rejects(guard.beforeCall('js', { code: 'await app.click({"id":"Seven"});' }, () => { idle = 0; return snapshot; }), /user.*active/);
});
test('locks persist owner identity, exclude overlaps, and recover only gone processes and groups', t => {
  const root = mkdtempSync('/private/tmp/sleight-lock-test-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'routine'); mkdirSync(directory);
  const options = { directory, coordinator: join(root, 'lock.sqlite'), alive: () => false };
  const first = acquireRoutineLock(options);
  const owner = JSON.parse(readFileSync(join(directory, 'running/owner.json')));
  assert.equal(owner.pid, process.pid); assert.equal(typeof owner.startTime, 'string');
  assert.equal(acquireRoutineLock(options), null);
  first.noteLaunching();
  first.preserve(); // Simulate a crashed owner while retaining its on-disk receipt.
  assert.equal(acquireRoutineLock(options), null, 'unknown ownership during launch must not be stolen');
  writeFileSync(join(directory, 'running/owner.json'), JSON.stringify({ ...owner, pendingLaunch: false }));
  const recovered = acquireRoutineLock(options); assert.ok(recovered); recovered.release();
  assert.equal(existsSync(join(directory, 'running')), false);
  mkdirSync(join(directory, 'running')); writeFileSync(join(directory, 'running/owner.json'), JSON.stringify({ pid: 123, startTime: 'old', groups: [456] }));
  assert.equal(acquireRoutineLock({ ...options, alive: pid => pid === -456 }), null);
  const gone = acquireRoutineLock(options); assert.ok(gone); gone.release();
  mkdirSync(join(directory, 'running')); writeFileSync(join(directory, 'running/owner.json'), JSON.stringify({ pid: 123, startTime: 'Fri Oct  9 01:00:00 2026', groups: [] }));
  assert.equal(acquireRoutineLock({ ...options, alive: () => true, started: () => 'Fri Oct  9 01:00:00 2026' }), null);
  const reused = acquireRoutineLock({ ...options, alive: () => true, started: () => 'Sat Oct 10 15:00:00 2026' });
  assert.ok(reused, 'a live PID with a different start time is a reused slot');
  reused.release();
  mkdirSync(join(directory, 'running')); writeFileSync(join(directory, 'running/owner.json'), '{');
  assert.equal(acquireRoutineLock(options), null, 'unreadable ownership stays blocked');
  assert.equal(clearRoutineLock({ directory, coordinator: join(root, 'lock.sqlite') }), true);
  assert.equal(existsSync(join(directory, 'running')), false);
  assert.equal(sameProcessStart('Fri Oct  9 01:00:00 2026', 'Fri Oct  9 01:00:00 2026'), true);
  assert.equal(sameProcessStart('Fri Oct  9 01:00:00 2026', 'Sat Oct 10 15:00:00 2026'), false);
});
test('launcher follows the current plugin registry and reports missing installs', async t => {
  const home = mkdtempSync('/private/tmp/sleight-launcher-test-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
  const registry = join(home, '.claude/plugins/installed_plugins.json');
  for (const version of ['1', '2']) {
    const installPath = join(home, 'cache', version); mkdirSync(join(installPath, 'bin'), { recursive: true });
    writeFileSync(join(installPath, 'bin/sleight-mcp'), 'fixture');
    writeFileSync(registry, JSON.stringify({ plugins: { 'sleight@sleight': [{ scope: 'user', installPath }] } }));
    assert.equal(resolveInstall(home), join(installPath, 'bin/sleight-mcp'));
  }
  rmSync(registry); const notices = [];
  assert.equal(await launchRoutine('a'.repeat(20), { home, notify: async message => notices.push(message) }), 1);
  assert.equal(notices.length, 1); assert.match(notices[0], /install|registry/);
});
test('detached replay forwards both terminal signals and removes listeners after collection', async () => {
  const child = new EventEmitter(), signals = new EventEmitter(), sent = [];
  child.pid = 123; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const server = relayServer('/fixture', { spawn: () => child, signals, signalGroup: name => sent.push(name), collect: async () => {} });
  signals.emit('SIGINT'); signals.emit('SIGTERM');
  assert.deepEqual(sent, ['SIGINT', 'SIGTERM']);
  child.emit('close', 0); await server.close();
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
});
