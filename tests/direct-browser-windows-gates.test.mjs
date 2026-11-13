import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWindowsFilePermissions, createWindowsPeerVerifier, createWindowsPeerConnection, createWindowsConsent,
  createWindowsGateHelper, windowsGatePath } from '../plugins/sleight/lib/direct-browser/windows-gates.mjs';
import { createWindowsTurboDiscovery } from '../plugins/sleight/lib/direct-browser/windows-platform.mjs';

const selected = { application: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', pid: 42,
  start: 1700000000000, ownerSid: 'S-1-5-21-1-2-3-1000', sessionId: 1 };
const endpoint = 'ws://127.0.0.1:9222/devtools/browser/test';
const socket = { localPort: 45678, localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', remotePort: 9222, destroyed: false };
const file = 'C:\\Users\\person\\AppData\\Local\\sleight\\hand.json';
function fileReply(req, change = {}) { return JSON.stringify({ nonce: req.nonce, ok: true,
  evidence: { path: req.path, kind: req.kind, volume: 7, fileId: '7:0:99', parents: 5, text: '{}', mtime: selected.start + 1, ...change } }); }
function peerReply(req, change = {}) { return JSON.stringify({ nonce: req.nonce, ok: true,
  evidence: { ...selected, port: 9222, incarnation: 'p42-t133444736000000000', listeners: 1, publisher: true, ...(req.connection ? { connection: { ...req.connection, pid: selected.pid, matches: 1 } } : {}), ...change } }); }
const card = { id: 'request-1', kind: 'payment', question: 'Allow this payment?', detail: '$12.00 to fixture, card ending 1234',
  choices: ['cancel', 'once'], deadline: 2000 };
const consentReply = (req, change = {}) => JSON.stringify({ nonce: req.nonce, id: req.id, choice: 'once', ...change });

test('Windows native factories do no host work on macOS', async () => {
  const helper = { requestSync() { assert.fail(); }, request() { assert.fail(); } };
  const permissions = createWindowsFilePermissions({ platform: 'darwin', helper });
  assert.equal(permissions.privateFile(file).ok, false);
  assert.equal((await permissions.privateFileAsync(file)).ok, false);
  assert.throws(() => createWindowsPeerVerifier({ platform: 'darwin', selected, endpoint, helper }), /PLATFORM/);
  assert.throws(() => createWindowsConsent({ platform: 'darwin', helper }), /PLATFORM/);
  assert.equal(createWindowsGateHelper({ platform: 'darwin', cached() { assert.fail(); } }), undefined);
});
for (const unsafe of ['\\\\server\\share\\file', '\\\\?\\C:\\file', 'C:relative', 'C:\\a\\..\\file', 'C:\\file:ads',
  'C:\\file.', 'C:\\file ', 'C:/file', 'C:\\PROGRA~1\\file', 'C:\\a\nfile', 'C:\\']) {
  test('private path refuses alias ' + JSON.stringify(unsafe), () => {
    assert.equal(windowsGatePath(unsafe), false);
    const permissions = createWindowsFilePermissions({ platform: 'win32', helper: { requestSync() { assert.fail(); } } });
    assert.equal(permissions.privateFile(unsafe).reason, 'WINDOWS_PATH_UNSAFE');
  });
}
test('file checks never reuse a verdict after file or parent DACL changes', async () => {
  let calls = 0, allowed = true; const seen = [];
  const reply = req => { calls++; seen.push(req); if (!allowed) throw Error('ACL_DENIED'); return fileReply(req); };
  const permissions = createWindowsFilePermissions({ platform: 'win32', helper: { requestSync: reply, request: async req => reply(req) } });
  assert.equal(permissions.privateFile(file).ok, true); assert.equal(permissions.privateFile(file).ok, true);
  allowed = false; assert.equal(permissions.privateFile(file).reason, 'ACL_DENIED');
  assert.equal((await permissions.privateFileAsync(file)).ok, false);
  allowed = true; assert.equal(permissions.privateDirectory(file).ok, true); assert.equal((await permissions.privateDirectoryAsync(file)).ok, true);
  assert.equal(calls, 6); assert.equal(new Set(seen.map(r => r.nonce)).size, 6);
  assert.ok(seen.every(r => /^[a-f0-9]{64}$/.test(r.nonce)));
});
for (const [name, edit] of Object.entries({ nonce: r => JSON.stringify({ ...JSON.parse(fileReply(r)), nonce: '0'.repeat(64) }),
  malformed: () => 'not JSON', multiple: r => fileReply(r) + '\n' + fileReply(r),
  denied: r => JSON.stringify({ nonce: r.nonce, ok: false }),
  otherPath: r => fileReply(r, { path: 'C:\\other' }), otherKind: r => fileReply(r, { kind: 'directory' }),
  volume: r => fileReply(r, { volume: null }), fileId: r => fileReply(r, { fileId: '' }), parents: r => fileReply(r, { parents: 0 }) })) {
  test('private file refuses helper evidence ' + name, async () => {
    const permissions = createWindowsFilePermissions({ platform: 'win32', helper: { requestSync: edit, request: async r => edit(r) } });
    assert.equal(permissions.privateFile(file).ok, false); assert.equal((await permissions.privateFileAsync(file)).ok, false);
  });
}
test('native file read binds bounded text to the inspected handle', () => {
  const seen = [];
  const permissions = createWindowsFilePermissions({ platform: 'win32', helper: { requestSync(req) { seen.push(req); return fileReply(req); } } });
  assert.equal(permissions.readPrivateFile(file).text, '{}'); assert.equal(seen[0].op, 'read-private-file');
  for (const text of ['', 'x'.repeat(513), null]) {
    const p = createWindowsFilePermissions({ platform: 'win32', helper: { requestSync: req => fileReply(req, { text }) } });
    assert.throws(() => p.readPrivateFile(file), /FILE_UNPROVED/);
  }
});
for (const [field, value] of Object.entries({ pid: 43, application: 'C:\\fake\\chrome.exe', start: selected.start + 1,
  ownerSid: 'S-1-5-21-2-3-4-1000', sessionId: 2, port: 9333, publisher: false, listeners: 0, incarnation: 'pid42' })) {
  test('peer refuses mismatched ' + field + ' and stays fenced', async () => {
    let calls = 0;
    const verifier = createWindowsPeerVerifier({ platform: 'win32', selected, endpoint, helper: { request(req) { calls++; return peerReply(req, { [field]: value }); } } });
    await assert.rejects(verifier.current(), /PEER_UNPROVED/); await assert.rejects(verifier.current(), /FENCED/); assert.equal(calls, 1);
  });
}
test('peer pins the exact FILETIME incarnation after matching the discovery millisecond', async () => {
  const seen = []; let generation = 'p42-t133444736000000000';
  const verifier = createWindowsPeerVerifier({ platform: 'win32', selected, endpoint, helper: { request(req) { seen.push(req); return peerReply(req, { incarnation: generation }); } } });
  await verifier.current(); await verifier.current(); generation = 'p42-t133444736000000001';
  await assert.rejects(verifier.current(), /PEER_UNPROVED/);
  assert.equal(seen[0].incarnation, undefined); assert.equal(seen[1].incarnation, 'p42-t133444736000000000');
});
test('connection checks before and after opening and before every private command', async () => {
  const order = []; let allowed = true;
  const verifier = createWindowsPeerVerifier({ platform: 'win32', selected, endpoint, helper: { request(req) { order.push('verify'); if (!allowed) throw Error(); return peerReply(req); } } });
  const connection = createWindowsPeerConnection({ verifier, open: async () => { order.push('open'); return socket; }, close: async () => order.push('close'), send: async method => { order.push(method); return 12; } });
  assert.equal(await connection.connect(), undefined); assert.deepEqual(order, ['verify', 'open', 'verify']);
  assert.equal(await connection.send('Page.getFrameTree'), 12); allowed = false;
  await assert.rejects(connection.send('Input.dispatchMouseEvent'), /PEER_UNPROVED/);
  assert.deepEqual(order.slice(3), ['verify', 'Page.getFrameTree', 'verify', 'close']);
  await assert.rejects(connection.connect(), /FENCED/); await assert.rejects(connection.send('Runtime.evaluate'), /FENCED/);
});
test('peer failure before open sends no bytes and failure after open closes', async () => {
  for (const failAt of [1, 2]) {
    let checks = 0, opens = 0, closes = 0;
    const verifier = createWindowsPeerVerifier({ platform: 'win32', selected, endpoint, helper: { request(req) { if (++checks === failAt) throw Error(); return peerReply(req); } } });
    const connection = createWindowsPeerConnection({ verifier, open: async () => { opens++; return socket; }, close: async () => { closes++; }, send: () => assert.fail() });
    await assert.rejects(connection.connect()); assert.equal(opens, failAt - 1); assert.equal(closes, 1);
  }
});
test('peer endpoint validation refuses redirects, host aliases and remote hosts before native work', () => {
  for (const value of ['ws://localhost:9222/devtools/browser/test', 'ws://127.1:9222/devtools/browser/test', 'wss://127.0.0.1:9222/devtools/browser/test', 'ws://192.168.1.1:9222/devtools/browser/test'])
    assert.throws(() => createWindowsPeerVerifier({ platform: 'win32', selected, endpoint: value }));
});
test('consent response is nonce-bound, frozen and authenticates once by object identity', async () => {
  const ui = createWindowsConsent({ platform: 'win32', now: () => 1000, helper: { request: req => consentReply(req) } });
  const event = await ui.present(card); assert.equal(event.choice, 'once'); assert.ok(Object.isFrozen(event));
  assert.equal(ui.authenticate({ ...event }), false); assert.equal(ui.authenticate(event), true); assert.equal(ui.authenticate(event), false);
});
for (const [field, value] of Object.entries({ id: 'other', nonce: 'a'.repeat(64), choice: 'always', injected: true })) {
  test('consent refuses mismatched or forged reply ' + field, async () => {
    const ui = createWindowsConsent({ platform: 'win32', now: () => 1000, helper: { request: req => consentReply(req, { [field]: value }) } });
    await assert.rejects(ui.present(card), /CONSENT_UNPROVED/);
  });
}
test('consent enforces expiry, abort and one pending request per id', async () => {
  let clock = 1000, release, request;
  const ui = createWindowsConsent({ platform: 'win32', now: () => clock, helper: { request: req => { request = req; return new Promise(resolve => { release = resolve; }); } } });
  const pending = ui.present(card); await assert.rejects(ui.present(card), /INVALID/); clock = 2000; release(consentReply(request));
  await assert.rejects(pending, /UNPROVED/);
  clock = 1000; const controller = new AbortController(); const aborted = ui.present(card, { signal: controller.signal });
  controller.abort(); release(consentReply(request)); await assert.rejects(aborted, /UNPROVED/);
});
for (const edit of [{ choices: ['cancel', 'always'] }, { choices: ['once', 'cancel'] }, { deadline: 1000 }, { deadline: 301001 }, { detail: 'x\u202ey' }, { detail: 'x\u007fy' }, { detail: 'x\u0085y' }, { question: '' }]) {
  test('consent refuses invalid card ' + JSON.stringify(edit), async () => {
    const ui = createWindowsConsent({ platform: 'win32', now: () => 1000, helper: { request() { assert.fail(); } } });
    await assert.rejects(ui.present({ ...card, ...edit }), /CONSENT_INVALID/);
  });
}
test('native helper executes only a receipt-bound binary with JSON on stdin', async () => {
  const calls = [];
  const helper = createWindowsGateHelper({ platform: 'win32', receipt: {}, executable: () => 'C:\\cache\\host.exe',
    runSync(file, args, options) { calls.push({ file, args, options }); return { status: 0, stdout: 'fixture' }; } });
  assert.equal(helper.requestSync({ op: 'private-file', path: file }), 'fixture');
  assert.deepEqual(calls[0].args, ['--browser-gate']); assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(JSON.parse(calls[0].options.input), { op: 'private-file', path: file }); assert.equal(calls[0].options.timeout, 30000);
  assert.throws(() => helper.requestSync({ op: 'consent' }), /ASYNC_REQUIRED/);
  assert.throws(() => createWindowsGateHelper({ platform: 'win32', cached: () => undefined }).requestSync({}), /HOST_NOT_BUILT/);
});
test('async native helper collects close after abort and does not resolve early', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let stops = 0, settled = false; child.kill = () => { stops++; };
  const helper = createWindowsGateHelper({ platform: 'win32', receipt: {}, executable: () => 'C:\\cache\\host.exe', run: () => child });
  const abort = new AbortController(); const pending = helper.request({ op: 'peer' }, { signal: abort.signal }).catch(e => { settled = true; return e; });
  abort.abort(); await new Promise(resolve => setImmediate(resolve)); assert.equal(stops, 1); assert.equal(settled, false);
  child.emit('close', 1); assert.match((await pending).message, /UNPROVED/);
});
test('discovery native read avoids a second, unchecked Node file open', () => {
  const root = 'C:\\Users\\person\\Chrome';
  const discovery = createWindowsTurboDiscovery({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local' },
    fs: { lstatSync() { assert.fail('second open'); } },
    filePermissions: { readBrowserFile(value) { return { path: value, kind: 'file', text: '9222\n/devtools/browser/test\n', mtime: selected.start + 1 }; } } });
  const browser = { candidates: [{ path: selected.application }] };
  const hint = discovery.activePort(browser, { ...selected, profileRoot: root }); assert.equal(hint.port, 9222); assert.equal(hint.authenticated, false);
});
test('revocation during native verification cannot return a successful proof', async () => {
  let release;
  const verifier = createWindowsPeerVerifier({ platform: 'win32', selected, endpoint, helper: { request: req => new Promise(resolve => { release = () => resolve(peerReply(req)); }) } });
  const pending = verifier.current(); verifier.revoke(); release(); await assert.rejects(pending, /PEER_UNPROVED/);
});
test('an undelivered native consent reply expires before authentication', async () => {
  let clock = 1000;
  const ui = createWindowsConsent({ platform: 'win32', now: () => clock, helper: { request: req => consentReply(req) } });
  const event = await ui.present(card); clock = card.deadline;
  assert.equal(ui.authenticate(event), false); assert.equal(ui.authenticate(event), false);
});
test('native reply decoding preserves a Unicode split across output chunks', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => assert.fail();
  const helper = createWindowsGateHelper({ platform: 'win32', receipt: {}, executable: () => 'C:\\cache\\host.exe', run: () => child });
  const pending = helper.request({ op: 'private-file' }); const bytes = Buffer.from('café');
  child.stdout.write(bytes.subarray(0, 4)); child.stdout.write(bytes.subarray(4)); child.emit('close', 0);
  assert.equal(await pending, 'café');
});
test('browser gates prepare one helper even when the optional cursor is disabled', async () => {
  const { prepareWindowsBrowserGates } = await import('../plugins/sleight/lib/direct-browser/windows-gates.mjs');
  let builds = 0; const receipt = {};
  const gates = await prepareWindowsBrowserGates({ platform: 'win32',
    prepare: async options => { assert.equal(options.platform, 'win32'); builds++; return { status: 'ready', receipt }; },
    helperFactory(options) { assert.equal(options.receipt, receipt); return { requestSync: fileReply, request: req => peerReply(req) }; } });
  assert.equal(gates.status, 'ready'); assert.equal(gates.filePermissions.privateFile(file).ok, true);
  assert.equal(await gates.peerVerifier(selected, endpoint).current(), true); assert.equal(typeof gates.consent.authenticate, 'function');
  assert.equal(builds, 1); assert.ok(Object.isFrozen(gates));
  assert.deepEqual(await prepareWindowsBrowserGates({ platform: 'darwin', prepare: () => assert.fail() }), { status: 'unavailable', code: 'PLATFORM' });
  assert.deepEqual(await prepareWindowsBrowserGates({ platform: 'win32', prepare: async () => ({ status: 'unavailable', code: 'NO_CSC' }), helperFactory: () => assert.fail() }), { status: 'unavailable', code: 'NO_CSC' });
});

test('browser endpoint reads select the inherited-ACE rule, private reads retain the strict rule', () => {
  const seen = [];
  const endpointFile = 'C:\\Users\\person\\Chrome\\DevToolsActivePort';
  const permissions = createWindowsFilePermissions({ platform: 'win32', helper: { requestSync(req) { seen.push(req); return fileReply(req); } } });
  permissions.readBrowserFile(endpointFile); permissions.readPrivateFile(file); permissions.privateFile(file);
  assert.deepEqual(seen.map(req => req.op), ['read-browser-file', 'read-private-file', 'private-file']);
  const malformed = createWindowsFilePermissions({ platform: 'win32', helper: { requestSync: req => fileReply(req, { text: '' }) } });
  assert.throws(() => malformed.readBrowserFile(endpointFile), /FILE_UNPROVED/);
});
test('browser file rule refuses other leaves before requesting a native helper', () => {
  let calls = 0;
  const permissions = createWindowsFilePermissions({ platform: 'win32', helper: {
    requestSync(req) { calls++; return fileReply(req); },
  } });
  for (const leaf of ['hand.json', 'DevToolsActivePort.bak', 'NotDevToolsActivePort', 'DevToolsActivePort\\other'])
    assert.throws(() => permissions.readBrowserFile('C:\\Users\\person\\Chrome\\' + leaf), /PATH_UNSAFE/);
  assert.equal(calls, 0);
  assert.equal(permissions.readBrowserFile('C:\\Users\\person\\Chrome\\devtoolsactiveport').text, '{}');
  assert.equal(calls, 1);
});
test('a bound verifier refuses a missing socket before native work and stays fenced', async () => {
  let checks = 0;
  const verifier = createWindowsPeerVerifier({ platform: 'win32', selected, endpoint,
    helper: { request(req) { checks++; return peerReply(req); } } });
  await verifier.current(); await verifier.current(socket);
  await assert.rejects(verifier.current(), /PEER_UNPROVED/);
  assert.equal(checks, 2);
  await assert.rejects(verifier.current(socket), /FENCED/);
  assert.equal(checks, 2);
});
for (const connection of [null, { localPort: 45678, address: '127.0.0.1', pid: 43, matches: 1 },
  { localPort: 45679, address: '127.0.0.1', pid: 42, matches: 1 },
  { localPort: 45678, address: '::1', pid: 42, matches: 1 },
  { localPort: 45678, address: '127.0.0.1', pid: 42, matches: 0 },
  { localPort: 45678, address: '127.0.0.1', pid: 42, matches: 2 }]) {
  test('accepted socket rejects mismatched table evidence ' + JSON.stringify(connection), async () => {
    let calls = 0, sends = 0, closes = 0;
    const verifier = createWindowsPeerVerifier({ platform: 'win32', selected, endpoint,
      helper: { request(req) { calls++; return peerReply(req, req.connection ? { connection } : {}); } } });
    const transport = createWindowsPeerConnection({ verifier, open: async () => socket,
      close: async () => { closes++; }, send: async () => { sends++; } });
    await assert.rejects(transport.connect(), /UNPROVED/);
    await assert.rejects(transport.send('Runtime.evaluate'), /FENCED/);
    assert.equal(calls, 2); assert.equal(closes, 1); assert.equal(sends, 0);
  });
}
for (const change of [{ localPort: 0 }, { localPort: undefined }, { localAddress: '127.0.0.2' }, { remoteAddress: '::1' }, { remotePort: 9999 }, { destroyed: true }]) {
  test('socket tuple refuses before native work ' + JSON.stringify(change), async () => {
    let calls = 0;
    const verifier = createWindowsPeerVerifier({ platform: 'win32', selected, endpoint, helper: { request() { calls++; assert.fail(); } } });
    await assert.rejects(verifier.current({ ...socket, ...change }), /UNPROVED/); assert.equal(calls, 0);
  });
}
test('accepted IPv6 socket uses the client local port and keeps listener checks', async () => {
  const seen = [];
  const verifier = createWindowsPeerVerifier({ platform: 'win32', selected, endpoint: endpoint.replace('127.0.0.1', '[::1]'),
    helper: { request(req) { seen.push(req); return peerReply(req); } } });
  const transport = createWindowsPeerConnection({ verifier, open: async () => ({ ...socket, localAddress: '::1', remoteAddress: '::1' }),
    close: async () => {}, send: async () => 'ok' });
  await transport.connect(); assert.equal(await transport.send('Page.getFrameTree'), 'ok');
  assert.equal(seen[0].connection, undefined);
  assert.deepEqual(seen.slice(1).map(r => r.connection), [{ localPort: 45678, address: '::1' }, { localPort: 45678, address: '::1' }]);
});
test('connection requires the private transport to return its socket', async () => {
  let closes = 0;
  const verifier = createWindowsPeerVerifier({ platform: 'win32', selected, endpoint, helper: { request: peerReply } });
  const transport = createWindowsPeerConnection({ verifier, open: async () => undefined, close: async () => { closes++; }, send: () => assert.fail() });
  await assert.rejects(transport.connect(), /CONNECTION_REQUIRED/); assert.equal(closes, 1);
});
test('spawn error rejects without waiting for a close event and releases the timer', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => assert.fail('failed spawn has no process');
  const helper = createWindowsGateHelper({ platform: 'win32', receipt: {}, executable: () => 'C:\\cache\\host.exe', run: () => child });
  const pending = helper.request({ op: 'peer' });
  child.emit('error', Object.assign(Error('spawn failed'), { code: 'ENOENT' }));
  await assert.rejects(pending, /UNPROVED/);
  child.emit('close', -1);
});
test('a socket lost during its native check cannot return a successful proof', async () => {
  let release;
  const live = { ...socket };
  const verifier = createWindowsPeerVerifier({ platform: 'win32', selected, endpoint,
    helper: { request: req => new Promise(resolve => { release = () => resolve(peerReply(req)); }) } });
  const pending = verifier.current(live); live.destroyed = true; release();
  await assert.rejects(pending, /UNPROVED/);
});
test('a listener still owned by the browser cannot cover a lost connection row before a command', async () => {
  let checks = 0, sends = 0, closes = 0;
  const verifier = createWindowsPeerVerifier({ platform: 'win32', selected, endpoint,
    helper: { request(req) { return peerReply(req, ++checks === 3 ? { connection: null } : {}); } } });
  const transport = createWindowsPeerConnection({ verifier, open: async () => socket,
    close: async () => { closes++; }, send: async () => { sends++; } });
  await transport.connect(); await assert.rejects(transport.send('Input.dispatchKeyEvent'), /UNPROVED/);
  assert.equal(sends, 0); assert.equal(closes, 1);
});
