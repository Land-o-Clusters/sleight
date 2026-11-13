import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, symlinkSync, chmodSync, chownSync, utimesSync, rmSync, mkdirSync, copyFileSync, readFileSync, lstatSync, renameSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import { createSelectedConnection } from '../plugins/sleight/lib/direct-browser/selected-connection.mjs';
import { createNativeProcessProvider, isNativeProcessProvider, parseProcessMetadata } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { codeRequirement, signedBrowserAt, verifiedOnDisk, writeClass } from '../plugins/sleight/lib/direct-browser/executable-trust.mjs';

class FakeSocket extends EventTarget {
  static instances = [];
  readyState = 0; frames = []; closeCalls = 0;
  constructor(url) { super(); this.url = url; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  send(text) { this.frames.push(JSON.parse(text)); }
  close() { this.closeCalls++; this.readyState = 2; }
  closed() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
function fixture(t) {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-selected-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'browser'); writeFileSync(executable, 'synthetic', { mode: 0o700 });
  symlinkSync(hostname() + '-4312', join(root, 'SingletonLock'));
  const active = join(root, 'DevToolsActivePort'); writeFileSync(active, '9222\n/devtools/browser/fixture\n', { mode: 0o600 });
  const start = Date.now() - 10000;
  let processCalls = 0, ownerCalls = 0;
  const f = { root, executable, active, start, pid: 4312, uid: process.getuid(), listeners: [], sockets: [],
    metadata: { uid: process.getuid(), pid: 4312, start, incarnation: 'p4312-s123-u456' },
    ownerOutput: 'p4312\nu' + process.getuid() + '\nf12\nn127.0.0.1:9222\n',
    options: { config: { profileRoot: root, executable }, testDependencies: {
      processMetadata: async (pid, expected) => { assert.equal(pid, 4312); assert.equal(expected, executable); processCalls++; return f.metadata; },
      execFile: async (file, args, options) => { assert.equal(file, '/usr/sbin/lsof'); assert.deepEqual(args, ['-nP', '-a', '-iTCP:9222', '-sTCP:LISTEN', '-Fpun']); assert.equal(options.timeout, 3000); ownerCalls++; return { stdout: f.ownerOutput }; },
      WebSocket: class extends FakeSocket { constructor(url) { super(url); f.sockets.push(this); } },
      closeTimeoutMs: 20, openTimeoutMs: 100,
    } },
    counts: () => ({ processCalls, ownerCalls }) };
  f.connect = async provider => { const opening = provider.connect(); await new Promise(resolve => setImmediate(resolve)); f.sockets.at(-1)?.open(); return opening; };
  return f;
}
test('resolves pinned identity without opening a socket and verifies both sides of explicit connect', async t => {
  const f = fixture(t), provider = await createSelectedConnection(f.options);
  assert.equal(f.sockets.length, 0); assert.match(provider.browserIncarnation, /^[A-Za-z0-9_-]+$/); assert.match(provider.selectedBrowser, /^b[A-Za-z0-9_-]+$/);
  assert.equal(await f.connect(provider), provider.session);
  assert.equal(f.sockets[0].url, 'ws://127.0.0.1:9222/devtools/browser/fixture');
  assert.equal(f.counts().ownerCalls, 2); assert.equal(await provider.verifyConnection(provider.session, provider.browserIncarnation), true);
  assert.equal(await provider.verifyConnection({ ...provider.session }), false);
  const close = provider.disconnect(); f.sockets[0].closed(); assert.equal(await close, true);
});
test('idle socket loss notifies trusted lifecycle once and fences before notification', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options), events = [];
  assert.equal(typeof p.onConnectionLoss, 'function');
  const remove = p.onConnectionLoss(() => {
    events.push('lost'); assert.rejects(p.session.send('Target.getTargets', {}), /SELECTED_CONNECTION_CLOSED/);
  });
  await f.connect(p); f.sockets[0].closed(); f.sockets[0].dispatchEvent(new Event('error'));
  assert.deepEqual(events, ['lost']); remove(); assert.equal(await p.disconnect(), true);
});
test('a root-owned immutable executable may serve the current user owned profile', async t => {
  const f = fixture(t), executable = realpathSync('/usr/bin/true');
  f.options.config.executable = executable;
  f.options.testDependencies.processMetadata = async (_pid, expected) => { assert.equal(expected, executable); return f.metadata; };
  const p = await createSelectedConnection(f.options); await f.connect(p);
  const closing = p.disconnect(); f.sockets[0].closed(); assert.equal(await closing, true);
});
// A group-writable executable at a signed browser's fixed place in a private app root. The kernel's code status is
// answered by f.status (flags, arch, cdhash) and codesign by `sign.verify` (whether the requirement plus cdhash holds).
const LIVE_FLAGS = 0x22013301; // what the kernel reported for an ad hoc kill,library,runtime process on this Mac
const CDHASH = '03f46f9f79e69851d671abc204fe28c9cb08dc81';
function signedFixture(t, mode = 0o775, sign = { verify: true, flags: LIVE_FLAGS }) {
  const f = fixture(t), apps = join(f.root, 'Applications'), name = 'Signed Browser';
  const bundle = join(apps, `${name}.app`), executable = join(bundle, `Contents/MacOS/${name}`);
  mkdirSync(dirname(executable), { recursive: true }); writeFileSync(executable, 'synthetic'); chmodSync(executable, mode);
  const requirement = 'identifier "com.example.signed" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"';
  f.executable = executable; f.options.config.executable = executable; f.codesign = [];
  f.status = () => ({ ...f.metadata, flags: sign.flags, arch: 'arm64', cdhash: CDHASH });
  Object.assign(f.options.testDependencies, {
    signedAppRoots: [apps],
    signedBrowsers: [{ name, bundleId: 'com.example.signed', team: 'ABCDE12345', executable, requirement, qualified: true }],
    processMetadata: async (pid, expected) => { assert.equal(pid, 4312); assert.equal(expected, executable); f.metadataCalls = (f.metadataCalls ?? 0) + 1; return f.metadata; },
    codeStatus: async (pid, expected) => { assert.equal(pid, 4312); assert.equal(expected, executable); f.statusCalls = (f.statusCalls ?? 0) + 1; return f.status(); },
  });
  const lsof = f.options.testDependencies.execFile;
  f.options.testDependencies.execFile = async (file, args, options) => {
    if (file !== '/usr/bin/codesign') return lsof(file, args, options);
    f.codesign.push(args); assert.equal(options.env.PATH, '/usr/bin:/bin');
    assert.deepEqual(args, ['--verify', '--strict', '--architecture', 'arm64', `-R=(${requirement}) and cdhash H"${CDHASH}"`, bundle]);
    f.onVerify?.();
    if (!sign.verify) throw Object.assign(Error('failed'), { code: 3 });
    return { stdout: '', stderr: '' };
  };
  return f;
}
test('a group-writable signed browser connects once its running process proves the signature, proved once per incarnation', async t => {
  const f = signedFixture(t), p = await createSelectedConnection(f.options);
  assert.equal(f.codesign.length, 1); assert.equal(f.statusCalls, 1);
  assert.equal(await f.connect(p), p.session); assert.equal(await p.verifyConnection(p.session), true);
  assert.equal(f.codesign.length, 1, 'the proof is cached for the same incarnation and executable');
  const closing = p.disconnect(); f.sockets[0].closed(); assert.equal(await closing, true);
});
const otherGroup = path => lstatSync(path).gid + 1000;
for (const [name, make, code] of [
  ['a world-writable signed browser', t => signedFixture(t, 0o777), /SELECTED_PATH_UNSAFE/],
  ['a group-writable executable outside a signed browser place', t => { const f = fixture(t); chmodSync(f.executable, 0o770); return f; }, /SELECTED_PATH_UNSAFE/],
  ['a group-writable signed browser whose group is neither admin nor the user\'s', t => {
    const f = signedFixture(t); f.options.testDependencies.primaryGid = otherGroup(f.executable); return f; }, /SELECTED_PATH_UNSAFE/],
  ['an unqualified browser with a Team ID', t => { const f = signedFixture(t); f.options.testDependencies.signedBrowsers[0].qualified = false; return f; }, /SELECTED_PATH_UNSAFE/],
  ['a signature that fails the browser requirement or the running cdhash', t => signedFixture(t, 0o775, { verify: false, flags: LIVE_FLAGS }), /SELECTED_SIGNATURE_UNPROVED/],
  ['a process without library validation', t => signedFixture(t, 0o775, { verify: true, flags: LIVE_FLAGS & ~0x2000 }), /SELECTED_SIGNATURE_UNPROVED/],
  ['a process whose code the kernel no longer counts valid', t => signedFixture(t, 0o775, { verify: true, flags: LIVE_FLAGS & ~0x1 }), /SELECTED_SIGNATURE_UNPROVED/],
  ['a process without the kill flag', t => signedFixture(t, 0o775, { verify: true, flags: LIVE_FLAGS & ~0x200 }), /SELECTED_SIGNATURE_UNPROVED/],
  ['a debugged process', t => signedFixture(t, 0o775, { verify: true, flags: LIVE_FLAGS | 0x10000000 }), /SELECTED_SIGNATURE_UNPROVED/],
  ['an unsigned process', t => signedFixture(t, 0o775, { verify: false, flags: 0 }), /SELECTED_SIGNATURE_UNPROVED/],
  ['a status read of another incarnation', t => { const f = signedFixture(t), status = f.status; f.status = () => ({ ...status(), incarnation: 'p4312-s999-u1' }); return f; }, /SELECTED_PROCESS_UNPROVED/],
  ['a failed status read', t => { const f = signedFixture(t); f.status = () => { throw Error('SELECTED_SIGNATURE_UNPROVED'); }; return f; }, /SELECTED_SIGNATURE_UNPROVED/],
  ['a pid reused during the signature check', t => { const f = signedFixture(t); f.onVerify = () => { f.metadata = { ...f.metadata, incarnation: 'p4312-s999-u1' }; }; return f; }, /SELECTED_PROCESS_UNPROVED/],
]) test('refuses ' + name + ' before any socket opens', async t => {
  const f = make(t);
  await assert.rejects(async () => { const p = await createSelectedConnection(f.options); await p.connect(); }, code);
  assert.equal(f.sockets.length, 0);
  if (/world|group is|unqualified/.test(name)) assert.deepEqual(f.codesign, [], 'refused before any signature check');
});
test('the relaxation tolerates group write only for admin (80) or the user\'s primary group', () => {
  const stat = (mode, gid) => ({ mode: 0o100000 | mode, gid });
  assert.equal(writeClass(stat(0o755, 12), 20), 'strict');
  assert.equal(writeClass(stat(0o775, 80), 501), 'signature');
  assert.equal(writeClass(stat(0o775, 20), 20), 'signature');
  assert.equal(writeClass(stat(0o775, 20), 501), undefined, 'staff when the user\'s primary group is not staff');
  assert.equal(writeClass(stat(0o775, 12), 20), undefined, 'everyone');
  assert.equal(writeClass(stat(0o777, 80), 20), undefined);
  assert.equal(writeClass(stat(0o757, 80), 20), undefined);
});
test('real gid: a signed browser whose group is everyone (12) is refused (Darwin)', {
  skip: process.platform !== 'darwin' || !process.getgroups().includes(12) ? 'needs membership of group 12 on macOS' : false,
}, async t => {
  const f = signedFixture(t); chownSync(f.executable, -1, 12);
  await assert.rejects(createSelectedConnection(f.options), /SELECTED_PATH_UNSAFE/); assert.deepEqual(f.codesign, []);
});
async function compilePeerHost(t) {
  const directory = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-process-helper-'))));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/peer-host.c', import.meta.url));
  const helper = join(directory, 'peer-host');
  await promisify(execFile)('/usr/bin/xcrun', ['clang', '-Wall', '-Werror', source, '-lbsm', '-o', helper], { timeout: 60000, maxBuffer: 65536 });
  return helper;
}
test('real codesign and kernel status: a group-writable ad hoc signed bundle is accepted only with the requirement, flags and running cdhash (Darwin)', {
  skip: macCommandSkip('xcrun') || macCommandSkip('codesign'),
}, async t => {
  const f = fixture(t), apps = join(f.root, 'Applications'), name = 'Signed Browser', run = promisify(execFile);
  const bundle = join(apps, `${name}.app`), executable = join(bundle, `Contents/MacOS/${name}`);
  const replacement = join(f.root, `spare/${name}.app/Contents/MacOS/${name}`);
  mkdirSync(dirname(executable), { recursive: true }); mkdirSync(dirname(replacement), { recursive: true });
  const helper = await compilePeerHost(t);
  // The same call and error mapping as host.mjs createNativeProcessProvider, with a helper compiled here.
  const read = async (mode, pid, expected) => {
    try { return parseProcessMetadata((await run(helper, [mode, String(pid), expected], { timeout: 3000, maxBuffer: 1024 })).stdout, pid, mode === '--code-status'); }
    catch { throw Error(mode === '--code-status' ? 'SELECTED_SIGNATURE_UNPROVED' : 'SELECTED_PROCESS_UNPROVED'); }
  };
  // A fresh inode each time: the kernel caches a signature per vnode, so rewriting a launched file in place would kill the next launch.
  const place = (program, path) => { rmSync(path, { force: true }); copyFileSync(program, path); };
  const sign = async (path, flags, program = '/bin/sleep') => { place(program, path);
    await run('/usr/bin/codesign', ['-f', '-s', '-', '-i', 'com.sleight.test', ...(flags ? ['-o', flags] : []), path], { timeout: 10000 }); chmodSync(path, 0o775); };
  const attempt = async (requirement = 'identifier "com.sleight.test"', afterStart) => {
    const child = spawn(executable, ['30'], { stdio: 'ignore' }), closed = once(child, 'close');
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      await afterStart?.(child);
      rmSync(join(f.root, 'SingletonLock')); symlinkSync(hostname() + '-' + child.pid, join(f.root, 'SingletonLock'));
      writeFileSync(f.active, '9222\n/devtools/browser/fixture\n');
      const options = { config: { profileRoot: f.root, executable }, testDependencies: { ...f.options.testDependencies,
        signedAppRoots: [apps], signedBrowsers: [{ name, bundleId: 'com.sleight.test', team: 'ABCDE12345', executable, requirement, qualified: true }],
        processMetadata: (pid, expected) => read('--process-pid', pid, expected), codeStatus: (pid, expected) => read('--code-status', pid, expected),
        execFile: (file, args, opts) => file === '/usr/bin/codesign' ? run(file, args, opts) : { stdout: `p${child.pid}\nu${f.uid}\nf12\nn127.0.0.1:9222\n` } } };
      return await createSelectedConnection(options).then(() => 'accepted', error => error.message);
    } finally { child.kill(); await closed; }
  };
  await sign(executable, 'kill,library,runtime');
  assert.equal(await attempt(), 'accepted');
  assert.equal(await attempt('identifier "com.sleight.other"'), 'SELECTED_SIGNATURE_UNPROVED');
  assert.equal(await attempt('identifier "com.sleight.test" and anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"'), 'SELECTED_SIGNATURE_UNPROVED');
  // A runs; then B, another program signed the same way that satisfies the requirement on its own, replaces A's path.
  await sign(replacement, 'kill,library,runtime', '/bin/cat');
  let running;
  assert.equal(await attempt(undefined, async child => {
    running = await read('--code-status', child.pid, executable);
    renameSync(replacement, executable);
    await run('/usr/bin/codesign', ['--verify', '--strict', '-R=identifier "com.sleight.test"', bundle], { timeout: 10000 });
    const shown = await run('/usr/bin/codesign', ['--display', '--verbose=4', '--architecture', running.arch, executable], { timeout: 10000 });
    assert.notEqual(/^CDHash=([0-9a-f]{40})$/m.exec(shown.stderr)?.[1], running.cdhash, 'the file on disk now has another cdhash');
  }), 'SELECTED_SIGNATURE_UNPROVED', 'the running cdhash is not the verified file\'s');
  assert.equal(running.flags & 0x10201, 0x10201);
  await sign(executable, undefined);
  assert.equal(await attempt(), 'SELECTED_SIGNATURE_UNPROVED', 'no kill, library-validation and runtime flags');
  chmodSync(executable, 0o777);
  assert.equal(await attempt(), 'SELECTED_PATH_UNSAFE');
});
test('real codesign: setup accepts the signed bundle on disk and refuses a tampered or unsigned one (Darwin)', {
  skip: macCommandSkip('codesign'),
}, async t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-signed-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = promisify(execFile), requirement = 'identifier "com.sleight.test"';
  const make = async (label, change) => {
    const executable = join(root, `${label}.app/Contents/MacOS/${label}`); mkdirSync(dirname(executable), { recursive: true });
    copyFileSync('/bin/sleep', executable);
    await run('/usr/bin/codesign', ['-f', '-s', '-', '-i', 'com.sleight.test', '-o', 'kill,library,runtime', executable], { timeout: 10000 });
    await change?.(executable); chmodSync(executable, 0o775);
    return verifiedOnDisk(executable, requirement, lstatSync(executable));
  };
  assert.equal(await make('Signed'), true);
  assert.equal(await make('Tampered', path => { const bytes = readFileSync(path); bytes[0x4000 + 100] ^= 0xff; writeFileSync(path, bytes); }), false);
  assert.equal(await make('Unsigned', path => run('/usr/bin/codesign', ['--remove-signature', path], { timeout: 10000 })), false);
});
test('the browser table yields the Developer ID requirement only at the fixed places', () => {
  const chrome = signedBrowserAt('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', { appRoots: ['/Applications'] });
  assert.equal(chrome.team, 'EQHXZ8M8AV');
  assert.equal(chrome.requirement, codeRequirement({ bundleId: 'com.google.Chrome', team: 'EQHXZ8M8AV' }));
  assert.match(chrome.requirement, /^identifier "com\.google\.Chrome" and anchor apple generic and .*certificate leaf\[subject\.OU\] = "EQHXZ8M8AV"$/);
  assert.equal(signedBrowserAt('/Applications/Helium.app/Contents/MacOS/Helium', { appRoots: ['/Applications'] }).team, 'S4Q33XPHB4');
  for (const path of ['/tmp/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Other',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/x/../Google Chrome.app/Contents/MacOS/Google Chrome'])
    assert.equal(signedBrowserAt(path, { appRoots: ['/Applications'] }), undefined, path);
  // Chrome Beta, Dev and Canary carry Google's Team ID but are unqualified, so the relaxation never covers them,
  // whatever SLEIGHT_TURBO_UNQUALIFIED says.
  const before = process.env.SLEIGHT_TURBO_UNQUALIFIED;
  try {
    process.env.SLEIGHT_TURBO_UNQUALIFIED = '1';
    for (const channel of ['Google Chrome Beta', 'Google Chrome Dev', 'Google Chrome Canary'])
      assert.equal(signedBrowserAt(`/Applications/${channel}.app/Contents/MacOS/${channel}`, { appRoots: ['/Applications'] }), undefined, channel);
  } finally { if (before === undefined) delete process.env.SLEIGHT_TURBO_UNQUALIFIED; else process.env.SLEIGHT_TURBO_UNQUALIFIED = before; }
  assert.throws(() => codeRequirement({ bundleId: 'x" or true', team: 'EQHXZ8M8AV' }), /SIGNATURE_REQUIREMENT_INVALID/);
});
test('CDP routes flattened commands, events and errors without using Browser.getVersion as proof', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options); await f.connect(p); const socket = f.sockets[0], events = [];
  const listener = event => events.push(event); p.session.on('event', listener);
  const root = p.session.send('Target.getTargets', {}), child = p.session.send('Runtime.enable', {}, 'child-session');
  assert.equal(socket.frames[0].sessionId, undefined); assert.equal(socket.frames[1].sessionId, 'child-session');
  socket.message({ id: socket.frames[1].id, sessionId: 'child-session', result: {} });
  socket.message({ id: socket.frames[0].id, result: { targetInfos: [] } });
  assert.deepEqual(await root, { targetInfos: [] }); assert.deepEqual(await child, {});
  socket.message({ method: 'Runtime.executionContextCreated', params: { context: {} }, sessionId: 'child-session' });
  assert.deepEqual(events, [{ method: 'Runtime.executionContextCreated', params: { context: {} }, sessionId: 'child-session' }]);
  p.session.off('event', listener); socket.message({ method: 'Target.targetCreated', params: {} }); assert.equal(events.length, 1);
  assert.throws(() => p.session.on('unsupported', listener), /INVALID_CDP_EVENT/);
  const failing = p.session.send('Runtime.enable', {}, 'child-session'); socket.message({ id: socket.frames.at(-1).id, sessionId: 'child-session', error: { code: -1, message: 'failure' } });
  await assert.rejects(failing, /CDP_COMMAND_FAILED/);
  const close = p.disconnect(); socket.closed(); assert.equal(await close, true);
});
for (const [name, change] of [
  ['writable root', f => chmodSync(f.root, 0o777)],
  ['writable endpoint file', f => chmodSync(f.active, 0o666)],
  ['stale endpoint timestamp', f => utimesSync(f.active, 1, 1)],
  ['endpoint symlink', f => { rmSync(f.active); symlinkSync(f.executable, f.active); }],
  ['malformed active port', f => writeFileSync(f.active, '9222\nws://evil.example/x')],
  ['wrong executable', f => f.options.config.executable = f.active],
  ['foreign lock host', f => { rmSync(join(f.root, 'SingletonLock')); symlinkSync('other-host-4312', join(f.root, 'SingletonLock')); }],
  ['reused pid metadata', f => f.metadata = { ...f.metadata, pid: 5555 }],
]) test('refuses ' + name + ' before any socket opens', async t => {
  const f = fixture(t); change(f);
  await assert.rejects(async () => { const p = await createSelectedConnection(f.options); await p.connect(); }, /SELECTED_|STALE_INSTANCE/);
  assert.equal(f.sockets.length, 0);
});
for (const [name, output] of [
  ['another owner', 'p4313\nu1000\nf12\nn127.0.0.1:9222\n'],
  ['wildcard address', 'p4312\nuUID\nf12\nn*:9222\n'],
  ['missing listener', ''],
  ['missing file record', 'p4312\nuUID\nn127.0.0.1:9222\n'],
  ['foreign uid', 'p4312\nu99999\nf12\nn127.0.0.1:9222\n'],
  ['ambiguous owner', 'p4312\nuUID\nf12\nn127.0.0.1:9222\np4313\nuUID\nf13\nn127.0.0.1:9222\n'],
]) test('refuses ' + name + ' listener ownership before opening', async t => {
  const f = fixture(t); f.ownerOutput = output.replaceAll('UID', String(f.uid)); const p = await createSelectedConnection(f.options);
  await assert.rejects(p.connect(), /SELECTED_LISTENER_UNPROVED/); assert.equal(f.sockets.length, 0);
});
// Chrome rewrites Local State in the profile folder about 10 s after a pref change (a temp file renamed over it), which
// changes the folder's size and times. Two real-Chrome turbo starts failed this way (2026-10-18 and 2026-10-19).
test('Chrome writing an entry in the profile folder during selection and connect changes nothing', async t => {
  const f = fixture(t), metadata = f.options.testDependencies.processMetadata;
  let writes = 0;
  f.options.testDependencies.processMetadata = async (...args) => {
    const temp = join(f.root, `Local State~${++writes}`);
    writeFileSync(temp, '{"n":' + writes + '}'); renameSync(temp, join(f.root, 'Local State'));
    if (writes % 2) writeFileSync(join(f.root, `BrowserMetrics-spare-${writes}.pma`), 'x'); else rmSync(join(f.root, `BrowserMetrics-spare-${writes - 1}.pma`));
    return metadata(...args);
  };
  const p = await createSelectedConnection(f.options);
  assert.equal(f.counts().processCalls, 1, 'selection needed no second look');
  assert.equal(await f.connect(p), p.session);
  assert.equal(await p.verifyConnection(p.session), true);
  const close = p.disconnect(); f.sockets[0].closed(); assert.equal(await close, true);
});
test('a replaced or re-permissioned profile folder during selection is still refused or re-read', async t => {
  // Each look swaps in a complete copy of the folder (its own inode), so every look sees two different folders.
  const f = fixture(t), metadata = f.options.testDependencies.processMetadata;
  let swaps = 0;
  f.options.testDependencies.retryDelayMs = 1;
  f.options.testDependencies.processMetadata = async (...args) => {
    const moved = f.root + '-moved-' + (++swaps); renameSync(f.root, moved); t.after(() => rmSync(moved, { recursive: true, force: true }));
    mkdirSync(f.root, { mode: 0o700 }); copyFileSync(join(moved, 'browser'), f.executable); chmodSync(f.executable, 0o700);
    symlinkSync(hostname() + '-4312', join(f.root, 'SingletonLock'));
    writeFileSync(f.active, '9222\n/devtools/browser/fixture\n', { mode: 0o600 });
    return metadata(...args);
  };
  await assert.rejects(createSelectedConnection(f.options), /^Error: STALE_INSTANCE$/);
  assert.equal(swaps, 3, 'refused on each of the three looks'); assert.equal(f.sockets.length, 0);
  // A permission change between two reads is still caught: that look is retried, and the next consistent look is used.
  const g = fixture(t), base = g.options.testDependencies.processMetadata;
  let changed = false;
  g.options.testDependencies.retryDelayMs = 1;
  g.options.testDependencies.processMetadata = async (...args) => { if (!changed) { changed = true; chmodSync(g.root, 0o750); } return base(...args); };
  const p = await createSelectedConnection(g.options);
  assert.equal(g.counts().processCalls, 2, 'the changed look was refused and read again');
  assert.equal(g.sockets.length, 0); await p.disconnect();
});
test('a DevToolsActivePort Chrome is still writing is read again, within three looks', async t => {
  const f = fixture(t), metadata = f.options.testDependencies.processMetadata;
  f.options.testDependencies.retryDelayMs = 1;
  writeFileSync(f.active, '');
  let looks = 0;
  f.options.testDependencies.processMetadata = async (...args) => {
    if (++looks === 2) writeFileSync(f.active, '9222\n/devtools/browser/fixture\n');
    return metadata(...args);
  };
  const p = await createSelectedConnection(f.options);
  assert.equal(looks, 2); assert.equal(await f.connect(p), p.session);
  const close = p.disconnect(); f.sockets[0].closed(); assert.equal(await close, true);
  const g = fixture(t); g.options.testDependencies.retryDelayMs = 1; writeFileSync(g.active, '9222\n');
  await assert.rejects(createSelectedConnection(g.options), /SELECTED_ENDPOINT_UNPROVED/);
  assert.equal(g.counts().processCalls, 3, 'bounded at three looks'); assert.equal(g.sockets.length, 0);
});
test('an lsof that its timeout killed runs once more; an lsof that answered is final', async t => {
  const f = fixture(t), lsof = f.options.testDependencies.execFile;
  let kills = 1;
  f.options.testDependencies.retryDelayMs = 1;
  f.options.testDependencies.execFile = async (...args) => {
    if (kills-- > 0) { await lsof(...args); throw Object.assign(Error('Command failed: lsof'), { killed: true, signal: 'SIGTERM', code: null }); }
    return lsof(...args);
  };
  const p = await createSelectedConnection(f.options), opening = p.connect();
  while (!f.sockets.length) await new Promise(resolve => setTimeout(resolve, 1));
  f.sockets[0].open(); assert.equal(await opening, p.session);
  assert.equal(f.counts().ownerCalls, 3, 'the killed run, its one retry, and the check after open');
  const close = p.disconnect(); f.sockets[0].closed(); assert.equal(await close, true);
  const g = fixture(t); g.ownerOutput = ''; const q = await createSelectedConnection(g.options);
  await assert.rejects(q.connect(), /SELECTED_LISTENER_UNPROVED/); assert.equal(g.counts().ownerCalls, 1);
  const h = fixture(t); h.options.testDependencies.retryDelayMs = 1;
  h.options.testDependencies.execFile = async () => { throw Object.assign(Error('Command failed: lsof'), { killed: true, signal: 'SIGTERM' }); };
  const r = await createSelectedConnection(h.options);
  await assert.rejects(r.connect(), /SELECTED_LISTENER_UNPROVED/); assert.equal(h.sockets.length, 0);
});
test('changed listener after open closes exact socket and refuses connection', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options), opening = p.connect();
  await new Promise(resolve => setImmediate(resolve)); f.ownerOutput = ''; const socket = f.sockets[0]; socket.open();
  const rejected = assert.rejects(opening, /SELECTED_LISTENER_UNPROVED/); await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.closeCalls, 1); socket.closed(); await rejected; assert.equal(await p.verifyConnection(p.session), false);
});
test('disconnect fences synchronously but retains in-flight command until response or confirmed closure', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options); await f.connect(p); const socket = f.sockets[0];
  const command = p.session.send('Target.getTargets', {}), closing = p.disconnect();
  await assert.rejects(p.session.send('Runtime.enable', {}), /SELECTED_CONNECTION_CLOSED/);
  socket.message({ id: socket.frames[0].id, result: { targetInfos: [] } }); assert.deepEqual(await command, { targetInfos: [] });
  assert.equal(await closing, false); assert.equal(socket.closeCalls, 1);
  socket.closed(); assert.equal(await p.disconnect(), true); assert.equal(socket.closeCalls, 1);
  await assert.rejects(p.connect(), /SELECTED_CONNECTION_CLOSED/);
});
test('disconnect during pending open prevents late connection and confirms socket closure', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options), opening = p.connect();
  await new Promise(resolve => setImmediate(resolve)); const socket = f.sockets[0], closing = p.disconnect();
  const rejected = assert.rejects(opening, /SELECTED_CONNECTION_CLOSED/); socket.open(); socket.closed(); await rejected; assert.equal(await closing, true);
});
test('mismatched response route closes connection and rejects command on actual close', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options); await f.connect(p); const socket = f.sockets[0];
  const command = p.session.send('Runtime.enable', {}, 'child'), rejected = assert.rejects(command, /SELECTED_CONNECTION_CLOSED/);
  socket.message({ id: socket.frames[0].id, sessionId: 'other', result: {} }); assert.equal(socket.closeCalls, 1); socket.closed(); await rejected;
});
test('a session-gone reply without a sessionId fails its own routed command and keeps the connection', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options), losses = []; p.onConnectionLoss(reason => losses.push(reason));
  await f.connect(p); const socket = f.sockets[0];
  const gone = p.session.send('Input.dispatchKeyEvent', {}, 'closed-popup'), other = p.session.send('Runtime.enable', {}, 'opener');
  socket.message({ id: socket.frames[0].id, error: { code: -32001, message: 'Session with given id not found.' } });
  await assert.rejects(gone, /CDP_COMMAND_FAILED/);
  socket.message({ id: socket.frames[1].id, sessionId: 'opener', result: {} }); assert.deepEqual(await other, {});
  assert.deepEqual(losses, []); assert.equal(socket.closeCalls, 0); assert.equal(await p.verifyConnection(p.session), true);
  const close = p.disconnect(); socket.closed(); assert.equal(await close, true);
});
for (const [name, send, reply, code] of [
  ['a routed reply to an unrouted command', ['Target.getTargets', {}], { sessionId: 'child', result: {} }, 'REPLY_ROUTE_MISMATCH'],
  ['another error code', ['Runtime.enable', {}, 'child'], { error: { code: -32000, message: 'x' } }, 'REPLY_ROUTE_MISMATCH'],
  ['a result without its route', ['Runtime.enable', {}, 'child'], { result: {} }, 'REPLY_ROUTE_MISMATCH'],
  ['a wrong sessionId on a gone-session error', ['Runtime.enable', {}, 'child'], { sessionId: 'other', error: { code: -32001, message: 'x' } }, 'REPLY_ROUTE_MISMATCH'],
  ['an unknown id', ['Runtime.enable', {}, 'child'], { id: 99, result: {} }, 'REPLY_UNKNOWN_ID'],
]) test('fences on ' + name + ' and reports the reason code', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options), losses = []; p.onConnectionLoss(reason => losses.push(reason));
  await f.connect(p); const socket = f.sockets[0];
  const command = p.session.send(...send), rejected = assert.rejects(command, /SELECTED_CONNECTION_CLOSED/);
  socket.message({ id: socket.frames[0].id, ...reply }); assert.equal(socket.closeCalls, 1); socket.closed(); await rejected;
  assert.deepEqual(losses, [code]);
});
test('a socket close reports its own reason code', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options), losses = []; p.onConnectionLoss(reason => losses.push(reason));
  await f.connect(p); f.sockets[0].closed(); assert.deepEqual(losses, ['SOCKET_CLOSED']);
});
test('verification fences a replaced browser incarnation before any further command', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options); await f.connect(p); const socket = f.sockets[0];
  f.metadata = { ...f.metadata, incarnation: 'p4312-s124-u456' };
  assert.equal(await p.verifyConnection(p.session), false);
  await assert.rejects(p.session.send('Target.getTargets', {}), /SELECTED_CONNECTION_CLOSED/);
  assert.equal(socket.closeCalls, 1); socket.closed(); assert.equal(await p.disconnect(), true);
});
test('native process capability cannot be fabricated from caller metadata', async t => {
  const f = fixture(t); assert.equal(isNativeProcessProvider(f.options.testDependencies.processMetadata), false);
  assert.throws(() => createNativeProcessProvider({}), /DISTRIBUTION_ACCEPTANCE_REQUIRED/);
  await assert.rejects(createSelectedConnection({ config: f.options.config, processMetadata: f.options.testDependencies.processMetadata }), /SELECTED_PROCESS_UNPROVED/);
});
test('opening timeout fences once and retains unconfirmed socket for cleanup', async t => {
  const f = fixture(t); f.options.testDependencies.openTimeoutMs = 10;
  const p = await createSelectedConnection(f.options), opening = p.connect();
  await assert.rejects(opening, /SELECTED_CONNECTION_TIMEOUT/);
  const socket = f.sockets[0]; assert.equal(socket.closeCalls, 1); assert.equal(await p.disconnect(), false);
  socket.closed(); assert.equal(await p.disconnect(), true);
});
test('identity replacement while explicit connect is pending cannot open a socket', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options);
  writeFileSync(f.active, '9223\n/devtools/browser/replaced\n');
  await assert.rejects(p.connect(), /STALE_INSTANCE/); assert.equal(f.sockets.length, 0);
});
test('verification raced with disconnect cannot restore the fenced connection', async t => {
  const f = fixture(t), p = await createSelectedConnection(f.options); await f.connect(p); const socket = f.sockets[0];
  const verifying = p.verifyConnection(p.session), closing = p.disconnect(); socket.closed();
  assert.equal(await verifying, false); assert.equal(await closing, true);
});
test('native peer-host compiles and binds metadata to an owned synthetic child (Darwin host tools)', {
  skip: macCommandSkip('xcrun'),
}, async t => {
  const directory = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-process-helper-'))));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/peer-host.c', import.meta.url));
  const helper = join(directory, 'peer-host'), run = promisify(execFile);
  await run('/usr/bin/xcrun', ['clang', '-Wall', '-Werror', source, '-lbsm', '-o', helper], { timeout: 30000, maxBuffer: 65536 });
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); process.stdout.write("ready\\n");'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = once(child, 'close');
  try {
    await once(child.stdout, 'data');
    const expected = realpathSync(process.execPath), result = JSON.parse((await run(helper, ['--process-pid', String(child.pid), expected], { timeout: 3000, maxBuffer: 1024 })).stdout);
    assert.equal(result.pid, child.pid); assert.equal(result.uid, process.getuid()); assert.ok(result.start > 0);
    assert.match(result.incarnation, new RegExp('^p' + child.pid + '-s[1-9]\\d*-u\\d+$'));
    await assert.rejects(run(helper, ['--process-pid', String(child.pid), realpathSync('/usr/bin/true')], { timeout: 3000, maxBuffer: 1024 }), error => error.code === 65);
    await assert.rejects(run(helper, ['--process-pid', '+1', expected], { timeout: 3000, maxBuffer: 1024 }), error => error.code === 64);
  } finally { child.stdin.end(); await closed; }
});
test('v3 filters bind only to the explicitly connected provider and fence on socket loss', async t => {
  const f = fixture(t), provider = await createSelectedConnection(f.options);
  assert.equal(typeof provider.createFilter, 'function');
  assert.throws(() => provider.createFilter(['owned']), /SELECTED_CONNECTION_CLOSED/);
  await f.connect(provider);
  const filter = provider.createFilter(['owned']); t.after(() => filter.dispose());
  assert.equal(filter.owns('owned'), true); assert.equal(filter.owns('foreign'), false);
  const snapshot = filter.session.send('Target.getTargets');
  const request = f.sockets[0].frames.at(-1);
  f.sockets[0].message({ id: request.id, result: { targetInfos: [{ targetId: 'owned', type: 'page' }, { targetId: 'foreign', type: 'page' }] } });
  assert.deepEqual((await snapshot).targetInfos.map(v => v.targetId), ['owned']);
  f.sockets[0].closed();
  await assert.rejects(filter.session.send('Target.getTargets'), /CDP_FILTER_CLOSED/);
});
