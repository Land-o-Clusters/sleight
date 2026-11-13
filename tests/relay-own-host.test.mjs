// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
const MAC_USERS = ['', 'Users', ''].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { OWN_HOST_LINE, isOwnHost, ownHostPid, getAppTargets } from '../plugins/sleight/lib/own-host.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';

// Security: sleight's own consent host (the menu bar glove, approval and payment cards) answers only the person's click.
// No engine call, local tool or approval may reach it, by name, by its file in sleight's helper cache, or by pid. A local
// tool's target that only its pid gives away is refused in lease-target.js (own-host-native.test.mjs).
const OWN = "That is sleight's own confirmation window; only you can answer it.";
const HOST_FILE = `${MAC_USERS}x/Library/Caches/sleight/turbo-host/k1/consent-host`;
const HOST_PID = 4242;
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

function harness(t, options = {}) {
  const [clientIn, clientOut, serverIn, serverOut] = [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()];
  const toServer = [], toClient = [], ran = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const directory = mkdtempSync(join(tmpdir(), 'sleight-own-host-relay-'));
  const tool = name => ({ name, description: 'x', inputSchema: { type: 'object' } });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 's', ask: async () => 'accept',
    inputLease: new InputLease({ directory, holder: 'A' }), ownHostPid: pid => pid === HOST_PID,
    localTools: { tools: ['menu_bar', 'hover', 'drag', 'select_window', 'open_file'].map(tool),
      target: async args => options.targets?.[args.app] ?? ({ appId: `com.example.${String(args.app).toLowerCase()}`, app: args.app, title: null, url: null }),
      call: async name => { ran.push(name); return { content: [{ type: 'text', text: 'ok' }] }; } }, ...options.relay });
  t.after(() => { relay.close(); removeTemp(directory); });
  const call = (id, name, args) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  return {
    toServer, ran, call, js: (id, code) => call(id, 'js', { code }),
    fromServer: msg => serverOut.write(JSON.stringify(msg) + '\n'),
    reply: id => toClient.find(m => m.id === id),
    sent: id => toServer.some(m => m.id === id),
  };
}
const read = (id, app, appId, title = 'Doc', body = '\t1 button Save') => ({ jsonrpc: '2.0', id, result: {
  content: [{ type: 'text', text: `Window: ${JSON.stringify(title)}, App: ${app}.\n0 standard window ${title}\n${body}` }],
  ...(appId ? { _meta: { 'codex/toolSurface': { app: { appId } } } } : {}) } });
const refused = (h, id) => { assert.equal(h.sent(id), false, `call ${id} reached the engine`); assert.deepEqual(h.reply(id)?.result, { isError: true, content: [{ type: 'text', text: OWN }] }); };

test('the line and the identity checks: name, a file in the helper cache, and a pid whose executable is there', () => {
  assert.equal(OWN_HOST_LINE, OWN);
  for (const value of ['consent-host', 'Consent-Host', HOST_FILE, `${MAC_USERS}x/Library/Caches/sleight/turbo-host/build-1/peer-host`]) assert.equal(isOwnHost(value), true, value);
  for (const value of ['TextEdit', 'com.apple.TextEdit', '/Applications/consent-host-viewer.app', 'my consent-host notes', undefined, 7]) assert.equal(isOwnHost(value), false, String(value));
  const ps = path => (command, args) => { assert.equal(command, '/bin/ps'); assert.deepEqual(args, ['-p', '4242', '-o', 'comm=']); return path + '\n'; };
  assert.equal(ownHostPid(HOST_PID, ps(HOST_FILE)), true);
  assert.equal(ownHostPid(HOST_PID, ps('/Applications/TextEdit.app/Contents/MacOS/TextEdit')), false);
  assert.equal(ownHostPid(HOST_PID, () => { throw new Error('no such process'); }), false);
  assert.equal(ownHostPid('4242', ps(HOST_FILE)), false, 'only an integer pid is looked up');
});

test('engine: getApp of the host by name, by its file or by its pid never reaches the engine', async t => {
  const h = harness(t);
  for (const [id, code] of [[1, 'let card = await cua.getApp("consent-host")'], [2, "let card = await cua.getApp('Consent-Host')"],
    [3, `let card = await cua.getApp(${JSON.stringify(HOST_FILE)})`], [4, `let card = await cua.getApp(${HOST_PID})`],
    [5, `let card = await cua.getApp("${HOST_PID}")`], [6, 'let a = await cua.getApp("TextEdit"); let b = await cua.getApp("consent-host"); await b.click(1)']]) {
    h.js(id, code); await settle();
    refused(h, id);
  }
});

test('engine: a read that turns out to be the host shows Claude only the line, and the next action on it stops', async t => {
  const h = harness(t);
  h.js(1, 'let card = await cua.getApp({ windowId: 9 })'); await settle();
  assert.equal(h.sent(1), true, 'a window id names no app, so it goes to the engine');
  h.fromServer(read(1, 'consent-host', undefined, 'Allow this payment?', '\t1 button Allow once\n\t2 button Cancel')); await settle();
  assert.deepEqual(h.reply(1).result, { isError: true, content: [{ type: 'text', text: OWN }] });
  assert.doesNotMatch(JSON.stringify(h.reply(1)), /Allow once/);
  h.js(2, 'await card.click(1)'); await settle();
  refused(h, 2);
  h.js(3, 'let other = await cua.getApp("Some Alias")'); await settle();
  h.fromServer(read(3, 'Alias', HOST_FILE, 'Turn turbo off?')); await settle();
  assert.equal(h.reply(3).result.content[0].text, OWN, 'the engine\'s app id names the host file');
});

test('engine: the approval card for the host is declined without asking the person', async t => {
  const h = harness(t);
  h.fromServer({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow Computer Use to use "consent-host"?',
    _meta: { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'consent-host' } } } });
  await settle();
  assert.deepEqual(h.toServer.find(m => m.id === 'e1')?.result, { action: 'decline' });
});

test('local tools: menu_bar, hover, drag and select_window refuse the host by name and by the target the name resolves to', async t => {
  const host = { appId: HOST_FILE, app: 'consent-host', pid: HOST_PID, title: null, url: null };
  const h = harness(t, { targets: { sleight: host } });
  h.call(1, 'menu_bar', { op: 'choose', app: 'consent-host', path: ['Turn Turbo Off…'] }); await settle();
  h.call(2, 'menu_bar', { op: 'press', app: HOST_FILE, element: 0 }); await settle();
  h.call(3, 'hover', { app: 'sleight', at: [1, 1] }); await settle();
  h.call(4, 'drag', { app: 'sleight', from: [1, 1], to: [2, 2] }); await settle();
  h.call(5, 'select_window', { app: 'consent-host', title: 'x' }); await settle();
  for (const id of [1, 2, 3, 4, 5]) assert.equal(h.reply(id)?.result?.content?.[0]?.text, OWN, `call ${id}`);
  assert.deepEqual(h.ran, [], 'no local tool ran');
});

for (const [name, args] of [
  ['drag', { app: 'TextEdit', from: [1, 1], to: [2, 2] }],
  ['hover', { app: 'TextEdit', at: [1, 1] }],
  ['menu_bar', { op: 'choose', app: 'TextEdit', path: ['File', 'Save'] }],
  ['select_window', { app: 'TextEdit', title: 'Doc' }],
  ['open_file', { app: 'TextEdit', path: `${MAC_TMP}/fixture.txt` }],
]) {
  test(`local ${name} refuses an ordinary app while the leased window is the host`, async t => {
    const h = harness(t);
    h.js(1, 'let card = await cua.getApp({ windowId: 9 })'); await settle();
    h.fromServer(read(1, 'consent-host', HOST_FILE)); await settle();
    assert.equal(h.reply(1).result.content[0].text, OWN);
    h.call(2, name, args); await settle();
    refused(h, 2);
    assert.deepEqual(h.ran, [], 'the local action must not run');
  });
}

test('a host lease still permits an app inventory and a read of an ordinary app', async t => {
  const h = harness(t);
  h.js(1, 'let card = await cua.getApp({ windowId: 9 })'); await settle();
  h.fromServer(read(1, 'consent-host', HOST_FILE)); await settle();
  h.call(2, 'menu_bar', { op: 'apps' }); await settle();
  assert.deepEqual(h.ran, ['menu_bar']);
  h.js(3, 'let other = await cua.getApp("TextEdit")'); await settle();
  assert.equal(h.sent(3), true);
  h.fromServer(read(3, 'TextEdit', 'com.apple.TextEdit')); await settle();
  h.call(4, 'hover', { app: 'TextEdit', at: [1, 1] }); await settle();
  assert.deepEqual(h.ran, ['menu_bar', 'hover']);
});

test('ordinary apps are unaffected: getApp, a read, an action, an approval and the local tools go through', async t => {
  const h = harness(t);
  h.js(1, 'let app = await cua.getApp("TextEdit")'); await settle();
  assert.equal(h.sent(1), true);
  h.fromServer(read(1, 'TextEdit', 'com.apple.TextEdit')); await settle();
  assert.match(h.reply(1).result.content[0].text, /button Save/);
  h.js(2, 'await app.click(1)'); await settle();
  assert.equal(h.sent(2), true);
  h.fromServer(read(2, 'TextEdit', 'com.apple.TextEdit')); await settle();
  h.js(3, 'let calc = await cua.getApp(1234)'); await settle();
  assert.equal(h.sent(3), true, 'a pid that is not the host goes to the engine');
  h.fromServer(read(3, 'Calculator', 'com.apple.calculator')); await settle();
  h.fromServer({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow Computer Use to use "TextEdit"?',
    _meta: { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'TextEdit' } } } });
  await settle();
  assert.notDeepEqual(h.toServer.find(m => m.id === 'e1')?.result, { action: 'decline' });
  h.call(4, 'menu_bar', { op: 'open', app: 'Clock' }); await settle();
  h.call(5, 'hover', { app: 'Chess', at: [1, 1] }); await settle();
  assert.deepEqual(h.ran, ['menu_bar', 'hover']);
});

// Review follow-ups (sleight-arch, 2026-10-18): other spellings, computed names, and approval paths that came first.
// A computed getApp is an action, so it needs a window read first.
async function leased(h) {
  h.js(100, 'let app = await cua.getApp("TextEdit")'); await settle();
  h.fromServer(read(100, 'TextEdit', 'com.apple.TextEdit')); await settle();
}
const getAppSpellings = [
  target => `await cua?.getApp(${target})`,
  target => `await cua?.["getApp"](${target})`,
  target => `await cua.getApp?.(${target})`,
  target => `await cua?.['getApp']?.(${target})`,
  target => `const g = cua.getApp; await g(${target})`,
  target => `const g = cua["getApp"]; await g(${target})`,
  target => `const g = cua?.getApp; await g?.(${target})`,
  target => `const { getApp } = cua; await getApp(${target})`,
  target => `const { getApp: g } = cua; await g(${target})`,
];
for (const [i, spelling] of getAppSpellings.entries()) {
  test(`engine: optional or aliased getApp spelling ${i + 1} refuses the host`, async t => {
    const h = harness(t);
    await leased(h);
    h.js(1, spelling('"consent-host"')); await settle();
    refused(h, 1);
  });
  test(`engine: optional or aliased getApp spelling ${i + 1} allows an ordinary app`, async t => {
    const h = harness(t);
    await leased(h);
    h.js(1, spelling('"TextEdit"')); await settle();
    assert.equal(h.sent(1), true);
  });
}
test('optional and aliased getApp keep literal decoding and leave computed targets to approval', () => {
  for (const spelling of getAppSpellings) {
    assert.deepEqual(getAppTargets(spelling('"consent" + "\\x2dhost"')), ['consent-host']);
    assert.deepEqual(getAppTargets(spelling('4242')), ['4242']);
    assert.deepEqual(getAppTargets(spelling('names[3]')), []);
  }
});
test('a getApp result and another object\'s method are not function aliases', () => {
  assert.deepEqual(getAppTargets('const g = cua.getApp("TextEdit"); g("consent-host")'), ['TextEdit']);
  assert.deepEqual(getAppTargets('const g = cua.getApp; other.g("consent-host")'), []);
});
test('engine: other spellings of the host in getApp are refused before the engine', async t => {
  const h = harness(t);
  const spellings = ['cua.getApp ("consent-host")', "cua . getApp ( 'consent-host' )", 'cua["getApp"]("consent-host")',
    "cua.getApp('consent\\x2dhost')", 'cua.getApp("consent\\u002dhost")', 'cua.getApp("consent\\u{2d}host")', 'cua.getApp(`consent-host`)',
    'cua.getApp("consent" + "-host")', "cua.getApp('consent' + `-` + \"host\")", 'cua.getApp("Consent Host")', 'cua.getApp("consent_host.app")',
    'cua.getApp(" 4242 ")', `cua.getApp(${JSON.stringify(HOST_FILE.toUpperCase())})`];
  for (const [i, spelling] of spellings.entries()) {
    h.js(i + 1, `let card = await ${spelling}`); await settle();
    refused(h, i + 1);
  }
});

test('engine: a computed getApp goes to the engine, and its approval card is the backstop: declined for a name, alias, file or pid', async t => {
  for (const app of ['consent-host', 'Consent Host', 'consent_host', HOST_FILE, HOST_PID, String(HOST_PID), undefined]) {
    const h = harness(t);
    await leased(h);
    h.js(1, 'let card = await cua.getApp(names[3])'); await settle();
    assert.equal(h.sent(1), true, 'a computed name can only be checked when the engine names it');
    h.fromServer({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow Computer Use to use "consent-host"?',
      _meta: { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: app === undefined ? {} : { app } } } });
    await settle();
    assert.deepEqual(h.toServer.find(m => m.id === 'e1')?.result, { action: 'decline' }, String(app));
    h.fromServer({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'The user declined.' }] } }); await settle();
    assert.equal(h.reply(1).result.content[0].text, OWN, String(app));
  }
});

test('engine: in document scope the host\'s card is declined before the document question is asked', async t => {
  const asked = [];
  const h = harness(t, { relay: { approvalScope: 'document', ask: async (...args) => { asked.push(args); return 'accept'; } } });
  h.js(1, 'let card = await cua.getApp("Some Alias")'); await settle();
  assert.equal(h.sent(1), true, 'a window read in document scope, by a name that the engine resolves to the host');
  h.fromServer({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow Computer Use to use "consent-host"?',
    _meta: { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'consent-host' } } } });
  await settle();
  assert.deepEqual(h.toServer.find(m => m.id === 'e1')?.result, { action: 'decline' });
  assert.deepEqual(asked, []);
});

test('fuzzy matching stays on the host: near names of ordinary apps are not refused', async t => {
  for (const value of ['Consent Manager', 'Hostess', 'consent-host-viewer', 'consenthostviewer.app', 'Consent Hosting']) assert.equal(isOwnHost(value), false, value);
  const h = harness(t);
  h.js(1, 'let app = await cua.getApp("Consent Manager")'); await settle();
  assert.equal(h.sent(1), true);
  h.fromServer({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow Computer Use to use "Consent Manager"?',
    _meta: { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'Consent Manager' } } } });
  await settle();
  assert.notDeepEqual(h.toServer.find(m => m.id === 'e1')?.result, { action: 'decline' });
});

// VC10: macOS's own Touch ID and password sheets (coreautha for LocalAuthentication, SecurityAgent for authorization) are
// refused like the host, with their own line, so sleight can't answer the confirmation its settings changes ask for.
const AUTH = "That is macOS's own Touch ID or password dialog; only you can answer it.";
const COREAUTHA = '/System/Library/Frameworks/LocalAuthentication.framework/Support/coreautha.bundle/Contents/MacOS/coreautha';
const AUTH_PID = 4343;

test('auth dialogs: the identity checks by name, bundle id, path and pid', async () => {
  const { AUTH_DIALOG_LINE, isAuthDialog, ownLine } = await import('../plugins/sleight/lib/own-host.mjs');
  assert.equal(AUTH_DIALOG_LINE, AUTH);
  for (const value of ['coreautha', 'SecurityAgent', 'com.apple.LocalAuthentication.UIAgent', 'com.apple.SecurityAgent', 'coreauthd', 'authorizationhost',
    COREAUTHA, '/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle', 'coreautha.bundle']) {
    assert.equal(isAuthDialog(value), true, value); assert.equal(isOwnHost(value), true, value); assert.equal(ownLine(value), AUTH, value);
  }
  for (const value of ['TextEdit', 'com.apple.Safari', 'Security Settings Helper', '/Applications/Keychain Access.app']) assert.equal(isAuthDialog(value), false, value);
  assert.equal(ownLine('consent-host'), OWN);
  assert.equal(ownHostPid(AUTH_PID, () => COREAUTHA + '\n'), true);
});

test('auth dialogs: getApp, local tools and approval cards for them never reach the engine or run', async t => {
  const sheet = { appId: 'com.apple.LocalAuthentication.UIAgent', app: 'coreautha', pid: AUTH_PID, title: null, url: null };
  const h = harness(t, { targets: { 'Touch ID': sheet }, relay: { ownHostPid: pid => pid === HOST_PID || pid === AUTH_PID } });
  for (const [id, code] of [[1, 'let s = await cua.getApp("coreautha")'], [2, 'let s = await cua.getApp("com.apple.LocalAuthentication.UIAgent")'],
    [3, 'let s = await cua.getApp("SecurityAgent")'], [4, `let s = await cua.getApp(${JSON.stringify(COREAUTHA)})`]]) {
    h.js(id, code); await settle();
    assert.equal(h.sent(id), false, `call ${id} reached the engine`);
    assert.equal(h.reply(id)?.result?.content?.[0]?.text, AUTH, `call ${id}`);
  }
  h.js(5, `let s = await cua.getApp(${AUTH_PID})`); await settle();
  assert.equal(h.sent(5), false, 'a pid whose executable is coreautha stays out');
  h.call(6, 'drag', { app: 'SecurityAgent', from: [1, 1], to: [2, 2] }); await settle();
  h.call(7, 'hover', { app: 'Touch ID', at: [1, 1] }); await settle();
  h.call(8, 'menu_bar', { op: 'press', app: 'coreautha', element: 0 }); await settle();
  for (const id of [6, 7, 8]) assert.equal(h.reply(id)?.result?.content?.[0]?.text, AUTH, `call ${id}`);
  assert.deepEqual(h.ran, [], 'no local tool ran');
  h.fromServer({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow Computer Use to use "SecurityAgent"?',
    _meta: { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'SecurityAgent' } } } });
  await settle();
  assert.deepEqual(h.toServer.find(m => m.id === 'e1')?.result, { action: 'decline' });
});

test('auth dialogs: a read that turns out to be the sheet shows Claude only the line, and the next action on it stops', async t => {
  const h = harness(t);
  h.js(1, 'let s = await cua.getApp({ windowId: 9 })'); await settle();
  h.fromServer(read(1, 'SecurityAgent', undefined, '', '\t1 secure text field Password\n\t2 button OK')); await settle();
  assert.deepEqual(h.reply(1).result, { isError: true, content: [{ type: 'text', text: AUTH }] });
  assert.doesNotMatch(JSON.stringify(h.reply(1)), /Password/);
  h.js(2, 'await s.typeText("hunter2")'); await settle();
  assert.equal(h.sent(2), false);
  assert.equal(h.reply(2)?.result?.content?.[0]?.text, AUTH);
});
