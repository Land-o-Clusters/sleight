// EPV3-7a: the admin client (electron-admin.mjs), the resident host process (electron-host-run.mjs): its trusted
// callbacks, the exit rule, and ensureHost spawning it detached with the per-start secret on descriptor 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { connectAdmin, ensureHost } from '../plugins/sleight/lib/direct-browser/electron-admin.mjs';
import { createExitRule, hostDependencies, quitThroughApp } from '../plugins/sleight/lib/direct-browser/electron-host-run.mjs';
import { readRecipeRegistry } from '../plugins/sleight/lib/direct-browser/electron-recipes.mjs';
import { createElectronConnection } from '../plugins/sleight/lib/direct-browser/electron-connection.mjs';
import { makeHost, pageSession, until } from './direct-browser-electron-host-fixture.mjs';

const python = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' });
const skipSpawn = python.status !== 0 ? 'python3 is unavailable' : false;
const finish = h => { h.host._crashForTest(); h.state.remove(); };
const recipe = (bundleId, version) => ({ build: `${bundleId}@${version}`, name: 'Fake', bundleId, signer: 'TEAM123456', runtime: 'electron/43.0.0',
  executable: '/Applications/Fake.app/Contents/MacOS/Fake', sha256: 'a'.repeat(64), cdhash: 'b'.repeat(40), args: ['--user-data-dir={profile}/user-data'],
  schemes: ['vscode-file'], fileRoots: [], joinTolerance: 2, focusEmulation: false, zoomLevel: 0, qualified: false });
function registryFile(t, recipes = [recipe('com.example.Editor', '1.2.3')]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'eadm-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'recipes.json');
  writeFileSync(path, JSON.stringify({ version: 1, recipes }));
  return { root, path };
}

test('connectAdmin speaks the admin handshake with the parent\'s secret: status, issue, revoke, resume', async () => {
  const secret = randomBytes(32);
  const h = await makeHost({ hostOptions: { adminSecret: secret } });
  await h.host.start({ build: 'fake-build' });
  const admin = await connectAdmin({ stateDir: h.state.dir, secret, hostId: h.host.hostId });
  assert.equal(admin.hostId, h.host.hostId);
  assert.equal((await admin.status()).ownership.state, 'owned');
  const handle = await admin.issue({ session: 'w' });
  const connection = await createElectronConnection({ handle });
  await connection.connect();
  assert.equal((await connection.session.send('Runtime.evaluate', {}, await pageSession(connection))).ok, true);
  await assert.rejects(admin.issue({ session: 'other' }), /^Error: ELECTRON_BUSY$/);
  await admin.revoke({ session: 'w' });
  await until(() => h.host.status().broker.state === 'parked', 'parked');
  await until(() => h.host.status().channels === 1, 'worker dropped');
  assert.equal((await admin.resume()).event, 'resumed');
  await admin.revokeAll();
  await until(() => h.host.status().broker.state === 'parked', 'parked again');
  admin.close();
  finish(h);
});

test('connectAdmin refuses a wrong secret and a host that is not the one it expects', async () => {
  const secret = randomBytes(32);
  const h = await makeHost({ hostOptions: { adminSecret: secret } });
  await assert.rejects(connectAdmin({ stateDir: h.state.dir, secret: randomBytes(32) }), /ADMIN_AUTH_FAILED/);
  await assert.rejects(connectAdmin({ stateDir: h.state.dir, secret, hostId: 'A'.repeat(22) }), /ELECTRON_HOST_MISMATCH/);
  await assert.rejects(connectAdmin({ stateDir: h.state.dir, secret: Buffer.alloc(8) }), /ADMIN_SECRET_INVALID/);
  const admin = await connectAdmin({ stateDir: h.state.dir, secret });
  assert.equal((await admin.status()).ownership.state, 'free');
  admin.close();
  finish(h);
});

test('admin start names a registered build only; quit goes through the app and collect ends ownership', async () => {
  const secret = randomBytes(32);
  const quits = [];
  let h;
  h = await makeHost({ hostOptions: { adminSecret: secret, requestQuit: async identity => { quits.push(identity); h.world.alive = false; h.app.output.end(); } } });
  const admin = await connectAdmin({ stateDir: h.state.dir, secret });
  await assert.rejects(admin.start({ build: 'other-build' }), /BUILD_NOT_REGISTERED/);
  assert.equal(h.world.apps.length, 0, 'nothing launched');
  const receipt = await admin.start({ build: 'fake-build' });
  assert.equal(receipt.phase, 'verified');
  assert.equal(receipt.identity.pid, 4100);
  await assert.rejects(admin.start({ build: 'fake-build' }), /OWNERSHIP_RETAINED/, 'never a second launch while one is owned');
  const quit = await admin.quit();
  assert.equal(quit.cleanup, 'removed', JSON.stringify(quit));
  assert.deepEqual(quits, [{ pid: 4100, birth: 'birth-1' }]);
  assert.equal((await admin.status()).ownership.state, 'free');
  assert.equal((await admin.collect()).cleanup, 'removed');
  admin.close();
  finish(h);
});

test('hostDependencies: launch only a registered build the host was given; issue and resume come only through the admin channel', async t => {
  const { path } = registryFile(t, [recipe('com.example.Editor', '1.2.3'), { ...recipe('com.example.Raw', '1.0.0'), sha256: null, signer: null, cdhash: null }]);
  const registry = readRecipeRegistry(path);
  const deps = hostDependencies({ registry, builds: ['com.example.Editor@1.2.3', 'com.example.Raw@1.0.0'], run: async () => 'sent' });
  assert.equal(await deps.authorizeLaunch({ build: 'com.example.Editor@1.2.3' }), true);
  assert.equal(await deps.authorizeLaunch({ build: 'com.example.Other@1' }), false);
  assert.equal(await deps.authorizeLaunch({ build: 'com.example.Raw@1.0.0' }), false, 'an unfilled recipe never launches');
  const narrow = hostDependencies({ registry, builds: ['com.example.Raw@1.0.0'], run: async () => 'sent' });
  assert.equal(await narrow.authorizeLaunch({ build: 'com.example.Editor@1.2.3' }), false, 'only the builds this host was started for');
  assert.equal(await deps.authorizeIssue({ session: 's' }), true);
  assert.equal(await deps.resumeAuthority({}), true);
});

test('hostDependencies admitTarget: app pages of the launched recipe only, nothing before a launch', async t => {
  const registry = readRecipeRegistry(registryFile(t).path);
  const deps = hostDependencies({ registry, builds: ['com.example.Editor@1.2.3'], run: async () => 'sent' });
  const page = { targetId: 'T1', type: 'page', url: 'vscode-file://vscode-app/workbench.html' };
  assert.equal(await deps.admitTarget(page), false, 'no launch yet');
  await deps.authorizeLaunch({ build: 'com.example.Editor@1.2.3' });
  assert.equal(await deps.admitTarget(page), true);
  assert.equal(await deps.admitTarget({ ...page, type: 'service_worker' }), false);
  assert.equal(await deps.admitTarget({ ...page, url: 'chrome://settings' }), false);
  assert.equal(await deps.admitTarget({ ...page, url: 'devtools://devtools/bundled/inspector.html' }), false);
  assert.equal(await deps.admitTarget({ ...page, type: 'other' }), false);
  assert.equal(await deps.admitTarget({ ...page, url: 'https://example.com/' }), true, 'web inside the app is a member; v3-context checks its origin');
});

test('quitThroughApp asks NSRunningApplication for the exact pid and checks its executable; never a signal', async () => {
  const calls = [];
  const run = async args => { calls.push(args); return 'sent'; };
  await quitThroughApp({ pid: 4100, birth: 'b' }, '/Applications/Fake.app/Contents/MacOS/Fake', { run });
  assert.equal(calls.length, 1);
  const [flag, language, e, script, pid, executable] = calls[0];
  assert.deepEqual([flag, language, e, pid, executable], ['-l', 'JavaScript', '-e', '4100', '/Applications/Fake.app/Contents/MacOS/Fake']);
  assert.match(script, /runningApplicationWithProcessIdentifier/);
  assert.match(script, /terminate/);
  assert.doesNotMatch(script, /forceTerminate|kill/);
  await quitThroughApp({ pid: 4100, birth: 'b' }, '/x', { run: async () => 'absent' });
  await assert.rejects(quitThroughApp({ pid: 4100, birth: 'b' }, '/x', { run: async () => 'mismatch' }), /QUIT_TARGET_MISMATCH/);
  await assert.rejects(quitThroughApp({ pid: 4100, birth: 'b' }, '/x', { run: async () => 'refused' }), /QUIT_REFUSED/);
  await assert.rejects(quitThroughApp({ pid: 0, birth: 'b' }, '/x', { run }), /QUIT_TARGET_INVALID/);
});

test('exit rule: after the app exits with no channel open, the host collects it, and exits 10 min later', async () => {
  let clock = 0;
  let status = { channels: 0, ownership: { state: 'owned' }, broker: { state: 'parked', parked: { reason: 'child exited' } } };
  const events = [];
  const rule = createExitRule({ status: () => status, now: () => clock, exit: code => events.push(code), close: async () => events.push('closed'),
    collect: async () => { events.push('collect'); status = { channels: 0, ownership: { state: 'free' }, broker: { state: 'collected' } }; } });
  await rule.check();
  assert.deepEqual(events, ['collect']);
  clock = 10 * 60000; await rule.check();
  assert.deepEqual(events, ['collect', 'closed', 0]);
  const kept = [];
  for (const parked of [{ reason: 'revoked' }, { reason: 'child exited' }]) {
    const channels = parked.reason === 'revoked' ? 0 : 1;
    const other = createExitRule({ status: () => ({ channels, ownership: { state: 'owned' }, broker: { state: 'parked', parked } }), now: () => 0,
      exit: () => kept.push('exit'), close: async () => {}, collect: async () => kept.push('collect') });
    await other.check();
  }
  assert.deepEqual(kept, [], 'a revoked app is never collected, and an open channel defers collection');
});

test('exit rule: unresolved ownership is reconciled on each check, so a host whose app the user quit frees it and can exit', async () => {
  let clock = 0, resolves = false, status = { channels: 0, ownership: { state: 'unresolved' } };
  const events = [];
  const rule = createExitRule({ status: () => status, now: () => clock, exit: code => events.push(code), close: async () => events.push('closed'),
    reconcile: async () => { events.push('reconcile'); if (resolves) status = { channels: 0, ownership: { state: 'free' } }; return { resolved: resolves }; } });
  await rule.check();
  clock = 20 * 60000; await rule.check();
  assert.deepEqual(events, ['reconcile', 'reconcile'], 'held while the app runs');
  resolves = true; await rule.check();
  clock = 31 * 60000; await rule.check();
  assert.deepEqual(events, ['reconcile', 'reconcile', 'reconcile', 'closed', 0]);
});

test('exit rule: the host exits after 10 min with ownership free and no channel; an owned app or an open channel keeps it', async () => {
  let clock = 0, status = { channels: 0, ownership: { state: 'free' } };
  const exits = [];
  const rule = createExitRule({ status: () => status, now: () => clock, exit: code => exits.push(code), close: async () => exits.push('closed') });
  await rule.check();
  clock = 9 * 60000; await rule.check();
  assert.deepEqual(exits, []);
  status = { channels: 1, ownership: { state: 'free' } };
  clock = 9.5 * 60000; await rule.check();                // a channel resets the idle clock
  status = { channels: 0, ownership: { state: 'free' } };
  clock = 19 * 60000; await rule.check();
  assert.deepEqual(exits, []);
  status = { channels: 0, ownership: { state: 'owned' } };
  clock = 60 * 60000; await rule.check();
  assert.deepEqual(exits, [], 'an owned app is never left without its host');
  status = { channels: 0, ownership: { state: 'unresolved' } };
  clock = 120 * 60000; await rule.check();
  assert.deepEqual(exits, [], 'unresolved ownership keeps the host for reconcile');
  status = { channels: 0, ownership: { state: 'free' } };
  clock = 130 * 60000; await rule.check();
  assert.deepEqual(exits, ['closed', 0]);
});

test('admin close completion waits for peer release and never permits overlapping administrators', async t => {
  const secret = randomBytes(32), h = await makeHost({ hostOptions: { adminSecret: secret } });
  t.after(() => finish(h));
  let releaseFin, second;
  const first = await connectAdmin({ stateDir: h.state.dir, secret, connect: path => {
    const socket = net.connect(path), end = socket.end.bind(socket);
    socket.end = (...args) => { releaseFin = () => end(...args); return socket; };
    return socket;
  } });
  let settled = false;
  const closing = Promise.resolve(first.close()).then(result => { settled = true; return result; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.host.status().channels, 1, 'the controlled peer still holds the admin role');
    await assert.rejects(ensureHost({ stateDir: h.state.dir, secret,
      spawn: () => assert.fail('a conflicting administrator cannot spawn a replacement') }), /ELECTRON_HOST_FOREIGN/);
    assert.equal(settled, false, 'close completion cannot precede remote role release');
    releaseFin(); releaseFin = undefined;
    assert.equal(await closing, true);
    assert.equal(h.host.status().channels, 0, 'peer EOF follows removal of the exact administrator');
    await assert.rejects(ensureHost({ stateDir: h.state.dir, secret: randomBytes(32),
      spawn: () => assert.fail('a wrong secret cannot spawn a replacement') }), /ELECTRON_HOST_FOREIGN/);
    second = await ensureHost({ stateDir: h.state.dir, secret });
    assert.equal(second.spawned, false);
    assert.equal(second.hostId, first.hostId);
    assert.equal(await second.close(), true);
  } finally {
    releaseFin?.();
    if (second) await second.close();
    await until(() => h.host.status().channels === 0, 'test administrators released');
  }
});

for (const mode of ['error', 'timeout', 'local-only']) test(`admin close ${mode} resolves false without unhandled rejection or a peer-release claim`, async t => {
  const secret = randomBytes(32), h = await makeHost({ hostOptions: { adminSecret: secret } });
  t.after(() => finish(h));
  const admin = await connectAdmin({ stateDir: h.state.dir, secret, timeoutMs: 250, connect: path => {
    const socket = net.connect(path);
    socket.end = () => {
      if (mode === 'error') throw Error('controlled close failure');
      if (mode === 'local-only') socket.destroy();
      return socket;
    };
    return socket;
  } });
  const closing = admin.close();
  assert.equal(admin.close(), closing, 'close completion is idempotent');
  assert.equal(await closing, false);
  await until(() => h.host.status().channels === 0, 'failed local close eventually drops its own channel');
});

test('ensureHost spawns the host detached with the secret on descriptor 3, waits for its ready line, reconnects with the secret, refuses without it', { skip: skipSpawn }, async t => {
  const { root } = registryFile(t);
  const registryPath = join(root, 'recipes.json');
  const stateDir = join(root, 's'), tempRootDir = join(root, 'tmp');
  let first;
  try {
    first = await ensureHost({ stateDir, registryPath, tempRoot: tempRootDir, build: 'com.example.Editor@1.2.3' });
    assert.equal(first.spawned, true);
    assert.equal(Buffer.isBuffer(first.secret) && first.secret.length, 32);
    const status = await first.status();
    assert.equal(status.ownership.state, 'free');
    assert.equal(status.hostId, first.hostId);
    assert.equal(await first.close(), true);
    const again = await ensureHost({ stateDir, registryPath, tempRoot: tempRootDir, build: 'com.example.Editor@1.2.3', secret: first.secret });
    assert.equal(again.spawned, false);
    assert.equal(again.hostId, first.hostId, 'the same host, not a second one');
    assert.equal(await again.close(), true);
    await assert.rejects(ensureHost({ stateDir, registryPath, tempRoot: tempRootDir, build: 'com.example.Editor@1.2.3' }), /ELECTRON_HOST_FOREIGN/);
    await assert.rejects(ensureHost({ stateDir, registryPath, tempRoot: tempRootDir, build: 'com.example.Editor@1.2.3', secret: randomBytes(32) }), /ELECTRON_HOST_FOREIGN/);
  } finally {
    if (first?.pid) try { process.kill(first.pid, 'SIGTERM'); } catch { /* gone */ }
  }
  await until(() => { try { process.kill(first.pid, 0); return false; } catch { return true; } }, 'host process gone', 5000);
});

test('ensureHost with a parent-chosen secret (hex) spawns the host with it, and every worker given it reconnects', { skip: skipSpawn }, async t => {
  const { root } = registryFile(t);
  const options = { stateDir: join(root, 's'), registryPath: join(root, 'recipes.json'), tempRoot: join(root, 'tmp'), build: 'com.example.Editor@1.2.3' };
  const adminSecret = randomBytes(32).toString('hex');
  let first;
  try {
    first = await ensureHost({ ...options, adminSecret });
    assert.equal(first.spawned, true);
    assert.equal(first.secret.toString('hex'), adminSecret);
    assert.equal(await first.close(), true);
    const second = await ensureHost({ ...options, adminSecret });
    assert.equal(second.spawned, false);
    assert.equal(second.hostId, first.hostId);
    assert.equal(await second.close(), true);
    await assert.rejects(ensureHost({ ...options, adminSecret: 'abc' }), /ADMIN_SECRET_INVALID/);
  } finally { if (first?.pid) try { process.kill(first.pid, 'SIGTERM'); } catch { /* gone */ } }
  await until(() => { try { process.kill(first.pid, 0); return false; } catch { return true; } }, 'host process gone', 5000);
});

test('ensureHost reports a host that never becomes ready and leaves no process behind', { skip: skipSpawn }, async t => {
  const { root } = registryFile(t);
  const stateDir = join(root, 's');
  writeFileSync(join(root, 'bad.json'), 'not json');
  await assert.rejects(ensureHost({ stateDir, registryPath: join(root, 'bad.json'), tempRoot: join(root, 'tmp'), build: 'com.example.Editor@1.2.3', timeoutMs: 5000 }),
    /ELECTRON_HOST_START_FAILED/);
});
