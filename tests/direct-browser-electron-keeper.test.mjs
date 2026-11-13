// The pipe keeper (launch.py --keeper): on the user's own profile, a second process holds the host's ends of the app's
// debugging pipe, so the app never reads EOF when the resident host dies. Real Python adapter and keeper, with
// tests/fixtures/fake-electron.py standing in for Electron: like Electron, it quits as soon as its pipe reads EOF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElectronBroker } from '../plugins/sleight/lib/direct-browser/electron/broker.mjs';
import { connectKeeper, createElectronHost, createPythonAdapter } from '../plugins/sleight/lib/direct-browser/electron-host.mjs';
import { createElectronConnection } from '../plugins/sleight/lib/direct-browser/electron-connection.mjs';
import { connectAdmin } from '../plugins/sleight/lib/direct-browser/electron-admin.mjs';
import { hostDependencies } from '../plugins/sleight/lib/direct-browser/electron-host-run.mjs';
import { createAppTargets } from '../plugins/sleight/lib/direct-browser/electron-targets.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const launch = join(here, '../plugins/sleight/lib/direct-browser/electron/launch.py'), fake = join(here, 'fixtures/fake-electron.py');
const fixture = join(here, 'fixtures/electron-host-process.mjs');
const python = spawnSync('python3', ['-c', 'import os,sys;print(os.path.realpath(sys.executable))'], { encoding: 'utf8' });
const skip = python.status !== 0 ? 'python3 is unavailable' : process.platform === 'win32' ? 'POSIX launch primitive unavailable' : false;
const BUILD = 'keeper-fixture';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, ms = 10000) => { const start = Date.now(); while (!await check()) { if (Date.now() - start > ms) throw Error('timed out waiting for ' + label); await sleep(20); } };
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const pgid = pid => Number(spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());

function environment() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ekeep-')));
  const executable = python.stdout.trim();
  const registryPath = join(root, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ version: 1, recipes: [{ build: BUILD, executable, sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    args: [fake, '--fake-host', '{profile}'], userProfile: { supportDir: 'Fake', args: [fake, '--fake-host'] } }] }));
  const tempRoot = join(root, 'tmp'); mkdirSync(tempRoot);
  const pids = new Set();
  return { root, registryPath, tempRoot, stateDir: join(root, 's'), pids,
    cleanup() { for (const pid of pids) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {} rmSync(root, { recursive: true, force: true }); } };
}
const lockPath = e => join(e.tempRoot, 'sleight-ep2-lock-' + createHash('sha256').update(BUILD).digest('hex'));

async function realHost(e, options = {}) {
  const host = await createElectronHost({
    stateDir: e.stateDir, Broker: ElectronBroker, builds: [BUILD], brokerOptions: { identityMaxAgeMs: 0 },
    createAdapter: async () => createPythonAdapter({ script: launch, registryPath: e.registryPath, tempRoot: e.tempRoot }),
    authorizeLaunch: async () => true, authorizeIssue: async () => true, admitTarget: async info => info.type === 'page', resumeAuthority: async () => true,
    ...options,
  });
  return host;
}
async function worker(host, session = 'w') {
  const connection = await createElectronConnection({ handle: await host.issueTicket({ session }) });
  await connection.connect();
  return connection;
}

// The resident host as its own detached process (a session and process group of its own, as ensureHost starts it).
async function hostProcess(e, { flags = ['--profile-user'], secret } = {}) {
  const child = spawn(process.execPath, [fixture, ...flags, BUILD, '--state-dir', e.stateDir, '--registry', e.registryPath, '--temp-root', e.tempRoot,
    '--builds', BUILD, '--adapter-script', launch, ...(secret ? ['--admin-fd', '3'] : [])], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], detached: true });
  child.stdio[3].on('error', () => {});
  child.stdio[3].end(secret ? secret.toString('base64url') + '\n' : '');
  let text = '', errors = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const line = () => text.split('\n').find(item => item.includes('"started"'));
  await until(() => { if (child.exitCode !== null) throw Error('host process exited: ' + errors); return line(); }, 'host started', 20000);
  const started = JSON.parse(line());
  e.pids.add(child.pid); e.pids.add(started.pid); if (started.keeper) e.pids.add(started.keeper);
  return { child, started };
}

test('host death keeps the user\'s app running, and a restarted host with the parent\'s secret reattaches, resumes and later collects', { skip }, async () => {
  const e = environment(), secret = randomBytes(32);
  let second;
  try {
    const { child, started } = await hostProcess(e, { secret, flags: ['--profile-user', '--flood'] });
    assert.ok(alive(started.keeper), 'a keeper holds the pipe beside the host');
    process.kill(child.pid, 'SIGKILL');                                    // the resident host crashes
    await until(() => !alive(child.pid), 'host gone');
    await sleep(1500);                                                     // the app's 8 MB of events go out meanwhile
    assert.equal(alive(started.pid), true, 'the fake app quits on pipe EOF, so it is alive only if its pipe is still open');
    assert.equal(alive(started.keeper), true);
    second = await realHost(e, { adminSecret: secret });
    const status = second.status();
    assert.equal(status.ownership.state, 'owned', JSON.stringify(status));
    assert.equal(status.broker.state, 'parked');
    assert.deepEqual(status.broker.parked, { reason: 'host restarted', resumable: true });
    assert.deepEqual(status.broker.identity, { pid: started.pid, birth: started.birth });
    await second.resume();
    const connection = await worker(second);
    assert.equal((await connection.session.send('Browser.getVersion')).pid, started.pid, 'the same process answers');
    assert.deepEqual(await second.broker.pipe.request('Fake.flood'), { sent: 8 << 20, done: true }, 'the keeper drained what the app sent while no host read');
    await connection.disconnect();
    await second.broker.pipe.request('Fake.quit').catch(() => {});          // the user's own Quit, later
    await until(() => !alive(started.pid) && !alive(started.keeper), 'the app and its keeper exit');
    await until(() => second.broker.state === 'parked' && second.broker.parkedBy?.reason === 'pipe EOF', 'the host sees the app go');
    assert.equal((await second.collect()).cleanup, 'removed');
    assert.equal(existsSync(lockPath(e)), false);
    assert.deepEqual(readdirSync(e.tempRoot), []);
    assert.equal(existsSync(join(e.stateDir, 'hold.sock')), false, 'the keeper removed its socket');
    assert.equal(second.status().ownership.state, 'free');
  } finally { second?._crashForTest(); await sleep(100); e.cleanup(); }
});

test('a restarted host without the secret leaves the app alone, and releases ownership once the user quits the app', { skip }, async () => {
  const e = environment();
  let second;
  try {
    const { child, started } = await hostProcess(e, { secret: randomBytes(32) });
    process.kill(child.pid, 'SIGKILL');
    await until(() => !alive(child.pid), 'host gone');
    second = await realHost(e, { adminSecret: randomBytes(32) });          // another server run: another secret
    assert.equal(second.status().ownership.state, 'unresolved');
    assert.equal(second.status().ownership.lastAttempt, 'keeper-refused');
    assert.equal((await second.reconcile()).resolved, false, 'the app still runs, so nothing is collected');
    await sleep(300);
    assert.equal(alive(started.pid), true);
    process.kill(started.pid, 'SIGTERM');                                  // the user quits the app
    await until(() => !alive(started.pid) && !alive(started.keeper), 'the app and its keeper exit: no process is left');
    assert.equal((await second.reconcile()).resolved, true);
    assert.equal(existsSync(lockPath(e)), false);
    assert.equal(second.status().ownership.state, 'free');
  } finally { second?._crashForTest(); await sleep(100); e.cleanup(); }
});

test('killing the host\'s whole process group leaves the app and its keeper running', { skip }, async () => {
  const e = environment();
  try {
    const { child, started } = await hostProcess(e, { secret: randomBytes(32) });
    assert.notEqual(pgid(started.pid), pgid(child.pid), 'the user\'s app is not in sleight\'s process group');
    assert.notEqual(pgid(started.keeper), pgid(child.pid));
    process.kill(-child.pid, 'SIGKILL');
    await until(() => !alive(child.pid), 'host gone');
    await sleep(500);
    assert.equal(alive(started.pid), true);
    assert.equal(alive(started.keeper), true);
  } finally { e.cleanup(); }
});

test('half a command left in the pipe by the dead host does not break the reattach', { skip }, async () => {
  const e = environment(), secret = randomBytes(32);
  let second;
  try {
    const { child, started } = await hostProcess(e, { secret, flags: ['--profile-user', '--partial'] });
    process.kill(child.pid, 'SIGKILL');
    await until(() => !alive(child.pid), 'host gone');
    second = await realHost(e, { adminSecret: secret });
    await second.resume();
    assert.equal((await second.broker.pipe.request('Browser.getVersion')).pid, started.pid);
    assert.equal(second.broker.state, 'ready');
  } finally { second?._crashForTest(); await sleep(100); e.cleanup(); }
});

test('the keeper detaches the sessions the dead host left, so no page of the user\'s app waits on a debugger that is gone', { skip }, async () => {
  const e = environment(), secret = randomBytes(32);
  let second;
  try {
    const { child, started } = await hostProcess(e, { secret, flags: ['--profile-user', '--attach'] });
    process.kill(child.pid, 'SIGKILL');
    await until(() => !alive(child.pid), 'host gone');
    await sleep(500);
    second = await realHost(e, { adminSecret: secret });
    await second.resume();
    assert.deepEqual(await second.broker.pipe.request('Fake.sessions'), { sessions: [] }, 'T1\'s session went with its host');
    assert.equal(alive(started.pid), true);
  } finally { second?._crashForTest(); await sleep(100); e.cleanup(); }
});

test('when a reattached host dies too, the keeper detaches its sessions and the next host reattaches', { skip }, async () => {
  const e = environment(), secret = randomBytes(32);
  let second, third;
  try {
    const { child, started } = await hostProcess(e, { secret });
    process.kill(child.pid, 'SIGKILL');
    await until(() => !alive(child.pid), 'host gone');
    second = await realHost(e, { adminSecret: secret });
    await second.resume();
    await second.broker.pipe.request('Target.attachToTarget', { targetId: 'T2', flatten: true });
    second._crashForTest(); second = undefined;                           // the second host dies with T2 attached
    await sleep(500);
    third = await realHost(e, { adminSecret: secret });
    await third.resume();
    assert.deepEqual(await third.broker.pipe.request('Fake.sessions'), { sessions: [] });
    assert.equal((await third.broker.pipe.request('Browser.getVersion')).pid, started.pid);
  } finally { second?._crashForTest(); third?._crashForTest(); await sleep(100); e.cleanup(); }
});

// The restarted host with the parent's own callbacks (electron-host-run.mjs hostDependencies), as ensureHost runs it. Live on
// 2026-10-22 03:14Z the reattached host had no launched recipe, so it refused every attach (CDP_TARGET_NOT_OWNED): the
// worker's geometry read failed for every page, the page registry joined nothing, and browser_tabs listed zero tabs.
const reviewedRegistry = e => {
  const registry = JSON.parse(readFileSync(e.registryPath, 'utf8'));
  return { recipes: registry.recipes.map(recipe => ({ ...recipe, schemes: ['app'] })) };
};
test('a reattached host admits the app\'s own pages again: the worker attaches, reads a window\'s geometry, and Quit names the app', { skip }, async () => {
  const e = environment(), secret = randomBytes(32);
  let second;
  try {
    const { child, started } = await hostProcess(e, { secret });
    process.kill(child.pid, 'SIGKILL');
    await until(() => !alive(child.pid), 'host gone');
    const quits = [], deps = hostDependencies({ registry: reviewedRegistry(e), builds: [BUILD], run: async args => { quits.push(args[4]); return 'sent'; } });
    second = await realHost(e, { adminSecret: secret, ...deps });
    assert.equal(second.status().ownership.state, 'owned', JSON.stringify(second.status()));
    await second.resume();
    const connection = await worker(second);
    const { identity } = connection;
    assert.deepEqual([identity.pid, identity.birth], [started.pid, started.birth], 'the same process, reattached');
    const targets = createAppTargets({ upstream: connection.session, identity, expected: { pid: started.pid, pidBirth: started.birth },
      recipe: { schemes: ['app'] }, verify: async () => true });
    await targets.start();
    assert.deepEqual(targets.members().map(row => row.targetId), ['T1', 'T2']);
    assert.deepEqual(await targets.geometry('T1'), { x: 0, y: 25, width: 800, height: 600, scale: 2, visible: true },
      'the page registry joins a window only after this read');
    assert.equal(await deps.requestQuit({ pid: started.pid, birth: started.birth }), 'sent', 'the app\'s own Quit has its executable');
    assert.deepEqual(quits, [String(started.pid)]);
    targets.stop();
    await connection.disconnect();
  } finally { second?._crashForTest(); await sleep(100); e.cleanup(); }
});

test('a restarted host whose parent refuses the recorded build leaves the app and its keeper as they were', { skip }, async () => {
  const e = environment(), secret = randomBytes(32);
  let refused, second;
  try {
    const { child, started } = await hostProcess(e, { secret });
    process.kill(child.pid, 'SIGKILL');
    await until(() => !alive(child.pid), 'host gone');
    refused = await realHost(e, { adminSecret: secret, authorizeLaunch: async () => false });
    assert.equal(refused.status().ownership.state, 'unresolved');
    assert.equal(refused.status().ownership.lastAttempt, 'launch-unauthorized');
    assert.equal(refused.broker, undefined, 'no broker took the pipe');
    refused._crashForTest(); refused = undefined;
    await sleep(300);
    assert.equal(alive(started.pid), true); assert.equal(alive(started.keeper), true);
    second = await realHost(e, { adminSecret: secret, ...hostDependencies({ registry: reviewedRegistry(e), builds: [BUILD], run: async () => 'sent' }) });
    await second.resume();
    assert.equal((await second.broker.pipe.request('Browser.getVersion')).pid, started.pid, 'the next approved host still reattaches');
  } finally { refused?._crashForTest(); second?._crashForTest(); await sleep(100); e.cleanup(); }
});

// Every attach a foreign process can try: the keeper's socket, its answer while the host lives, and after the host's death a
// wrong proof. It passes no descriptor to anyone (SCM_RIGHTS is read for on every message).
const FOREIGN = `
import array, json, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(2); s.connect(sys.argv[1])
fds = []
def recv():
    data, ancillary, _, _ = s.recvmsg(65536, socket.CMSG_SPACE(64))
    for level, kind, payload in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            fds.extend(array.array('i', payload[:len(payload) - len(payload) % 4]))
    return data
received = b''
try:
    first = recv(); received += first
    if first and sys.argv[2] == 'wrong-proof':
        s.sendall(json.dumps({'t': 'attach', 'cn': 'A' * 22, 'proof': 'B' * 43}).encode() + b'\\0')
    if first and sys.argv[2] == 'non-ascii':
        s.sendall(json.dumps({'t': 'attach', 'cn': 'A' * 22, 'proof': '\\u00e9'}).encode() + b'\\0')
    if first and sys.argv[2] == 'nested':
        s.sendall(b'[' * 4000 + b'\\0')
    while True:
        chunk = recv()
        if not chunk: break
        received += chunk
except (socket.timeout, ConnectionResetError):
    pass
print(json.dumps({'received': received.decode('utf-8', 'replace'), 'fds': len(fds)}))
`;
const foreign = (path, mode) => JSON.parse(spawnSync('python3', ['-I', '-c', FOREIGN, path, mode], { encoding: 'utf8', timeout: 10000 }).stdout);

test('nothing else obtains the pipe: the keeper refuses while the host lives, refuses a wrong proof after, and passes no descriptor', { skip }, async () => {
  const e = environment(), secret = randomBytes(32);
  let second;
  try {
    const { child, started } = await hostProcess(e, { secret });
    const path = join(e.stateDir, 'hold.sock');
    const socket = lstatSync(path);
    assert.ok(socket.isSocket()); assert.equal(socket.mode & 0o777, 0o600); assert.equal(lstatSync(e.stateDir).mode & 0o077, 0);
    assert.deepEqual(foreign(path, 'listen'), { received: '', fds: 0 }, 'while the host lives, a connection is closed unanswered');
    await assert.rejects(connectKeeper({ socketPath: path, key: randomBytes(32), nonce: 'x'.repeat(32) }), /KEEPER_REFUSED/);
    process.kill(child.pid, 'SIGKILL');
    await until(() => !alive(child.pid), 'host gone');
    await sleep(200);
    for (const mode of ['wrong-proof', 'non-ascii', 'nested']) {
      const wrong = foreign(path, mode);
      assert.match(wrong.received, /^\{"t": ?"keeper"/, 'the keeper\'s challenge, and nothing after a bad attach: ' + mode);
      assert.equal(wrong.received.split('\0').filter(Boolean).length, 1, mode);
      assert.equal(wrong.fds, 0);
      assert.equal(alive(started.keeper), true, 'a malformed attach never ends the keeper: ' + mode);
    }
    await sleep(300);
    assert.equal(alive(started.pid), true);
    second = await realHost(e, { adminSecret: secret });                   // the owner's host still gets in afterwards
    await second.resume();
    assert.equal((await second.broker.pipe.request('Browser.getVersion')).pid, started.pid);
    assert.deepEqual(foreign(path, 'listen'), { received: '', fds: 0 }, 'one host at a time: attached, it refuses everyone else');
  } finally { second?._crashForTest(); await sleep(100); e.cleanup(); }
});

test('connectKeeper refuses a keeper that cannot prove the key, or names another launch, before it sends anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekfk-')), path = join(dir, 'k.sock'), seen = [];
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.write(JSON.stringify({ t: 'keeper', v: 1, nonce: server.nonce, challenge: 'C'.repeat(43) }) + '\0');
    socket.on('data', chunk => { seen.push(String(chunk)); socket.write(JSON.stringify({ t: 'ready', proof: 'P'.repeat(43) }) + '\0'); });
  });
  await new Promise(resolve => server.listen(path, resolve));
  try {
    server.nonce = 'n'.repeat(32);
    await assert.rejects(connectKeeper({ socketPath: path, key: randomBytes(32), nonce: 'm'.repeat(32) }), /KEEPER_MISMATCH/);
    assert.deepEqual(seen, [], 'another launch\'s keeper gets no proof');
    await assert.rejects(connectKeeper({ socketPath: path, key: randomBytes(32), nonce: 'n'.repeat(32) }), /KEEPER_MISMATCH/);
    assert.equal(seen.length, 1);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

// The relaunch flow asks for the keeper before the user's app quits (electron-relaunch.mjs), so a keeper that can't start
// quits nothing.
test('prepare starts and proves the keeper before any app exists, over the admin channel, and the start then uses it', { skip }, async () => {
  const e = environment(), secret = randomBytes(32);
  let host;
  try {
    host = await realHost(e, { adminSecret: secret });
    const admin = await connectAdmin({ stateDir: e.stateDir, secret });
    await assert.rejects(admin.prepare({ build: BUILD, profile: 'temporary' }), /BUILD_NOT_REGISTERED/);
    const prepared = await admin.prepare({ build: BUILD, profile: 'user' });
    e.pids.add(prepared.pid);
    assert.equal(alive(prepared.pid), true); assert.equal(host.broker, undefined, 'no app yet');
    assert.deepEqual(await admin.prepare({ build: BUILD, profile: 'user' }), prepared, 'asking again reuses it');
    await admin.start({ build: BUILD, profile: 'user' });
    e.pids.add(host.broker.identity.pid);
    assert.equal(host.status().keeper.pid, prepared.pid);
    admin.close();
  } finally { host?._crashForTest(); await sleep(100); e.cleanup(); }
});

test('a keeper that cannot start fails the preflight and the start, and no app is launched', { skip }, async () => {
  const e = environment();
  let host;
  try {
    host = await realHost(e, { adminSecret: randomBytes(32) });
    writeFileSync(join(e.stateDir, 'hold.sock'), 'not a socket');
    await assert.rejects(host.prepare(), /KEEPER_UNAVAILABLE/);
    assert.equal(host.status().ownership.state, 'free');
    await assert.rejects(host.start({ build: BUILD, profile: 'user' }), /KEEPER_UNAVAILABLE/);
    assert.equal(host.broker.identity, undefined, 'the user\'s app never ran without its keeper');
    assert.equal((await host.reconcile()).resolved, true, 'and sleight\'s own launch record is collected');
  } finally { host?._crashForTest(); await sleep(100); e.cleanup(); }
});

test('with the host alive the keeper only waits; it exits when the app quits, and a temporary profile gets none', { skip }, async () => {
  const e = environment();
  let host;
  try {
    host = await realHost(e, { adminSecret: randomBytes(32) });
    await host.start({ build: BUILD, profile: 'user' });
    const { pid } = host.broker.identity, keeper = host.status().keeper?.pid;
    e.pids.add(pid); e.pids.add(keeper);
    assert.ok(alive(keeper));
    const connection = await worker(host);
    for (let i = 0; i < 20; i++) assert.equal((await connection.session.send('Browser.getVersion')).pid, pid, 'the keeper reads nothing while the host lives');
    await connection.disconnect();
    await host.broker.pipe.request('Fake.quit').catch(() => {});
    await until(() => !alive(pid) && !alive(keeper), 'the app and the keeper exit');
    await until(() => host.broker.state === 'parked', 'parked');
    assert.equal((await host.collect()).cleanup, 'removed');
    await host.start({ build: BUILD });
    e.pids.add(host.broker.identity.pid);
    assert.equal(host.status().keeper, undefined, 'a benchmark\'s temporary instance keeps the old rule: it quits with its host');
  } finally { host?._crashForTest(); await sleep(100); e.cleanup(); }
});

test('a keeper killed while the host lives is replaced, so a later host death still keeps the app', { skip }, async () => {
  const e = environment();
  let host, crashed = false;
  try {
    host = await realHost(e, { adminSecret: randomBytes(32) });
    await host.start({ build: BUILD, profile: 'user' });
    const { pid } = host.broker.identity, first = host.status().keeper.pid;
    e.pids.add(pid); e.pids.add(first);
    process.kill(first, 'SIGKILL');
    await until(() => host.status().keeper?.pid && host.status().keeper.pid !== first, 'a new keeper');
    const next = host.status().keeper.pid; e.pids.add(next);
    host._crashForTest(); crashed = true;
    await sleep(500);
    assert.equal(alive(pid), true);
    assert.equal(alive(next), true);
  } finally { if (!crashed) host?._crashForTest(); await sleep(100); e.cleanup(); }
});
