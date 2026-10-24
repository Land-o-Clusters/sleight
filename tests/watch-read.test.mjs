import test from 'node:test';
import assert from 'node:assert/strict';
import { watchQuery, watchMatch, readWatch } from '../plugins/sleight/lib/watch-read.mjs';
import { createSelectedConnection } from '../plugins/sleight/lib/direct-browser/selected-connection.mjs';
import { mkdtempSync, realpathSync, writeFileSync, symlinkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const query = { sleightWatch: 1, url: 'https://example.test/ticket', find: 'shipped' };
const node = (role, name, extra = {}) => ({ nodeId: 'n' + name, role: { value: role }, name: { value: name }, ...extra });
const tree = text => [node('RootWebArea', 'Ticket'), node('StaticText', text)];
function fixture(options = {}) {
  const calls = [], config = { receipt: {}, executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' };
  const target = { type: 'page', url: query.url, targetId: 'target1' };
  const frame = { id: 'frame1', loaderId: 'loader1', url: query.url };
  let frames = 0, closed = false;
  const session = { async send(method, params, route) {
    calls.push({ method, params, route });
    if (options.send) { const result = await options.send(method, params, route); if (result !== undefined) return result; }
    if (method === 'Target.getTargets') return { targetInfos: options.targets ?? [target] };
    if (method === 'Target.attachToTarget') return { sessionId: 'attached1' };
    if (method === 'Target.getTargetInfo') return { targetInfo: options.changedTarget ?? target };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { ...frame, ...(frames++ && options.changedFrame) }, ...(options.children ? { childFrames: options.children } : {}) } };
    if (method === 'DOM.enable') return {};
    if (method === 'DOM.performSearch') return { searchId: 'guard1', resultCount: 0 };
    if (method === 'DOM.discardSearchResults') return {};
    if (method === 'Accessibility.getFullAXTree') return { nodes: options.nodes ?? tree('Shipped') };
    if (method === 'Target.detachFromTarget') return {};
    throw Error('unexpected command: ' + method);
  } };
  const selected = { session, selectedBrowser: 'browser1', browserIncarnation: 'incarnation1',
    endpoint: 'ws://127.0.0.1:9222/devtools/browser/one',
    async connect() { calls.push({ method: 'connect' }); return session; },
    async verifyConnection() { return !closed && options.current !== false; },
    async disconnect() { closed = true; calls.push({ method: 'disconnect' }); return options.collected !== false; } };
  const dependencies = { publicOrigin: new URL(query.url).origin, readConfig: () => config, acceptPackage: () => ({ current: () => true }),
    prepareHelpers: async () => ({ status: 'ready', receipt: {} }), selectConnection: async () => selected,
    permissions: { app: () => false, site: () => false }, timeoutMs: 20, ...options.dependencies };
  return { calls, dependencies, target, session };
}

test('a watch query is a closed HTTP(S) read grammar', () => {
  assert.deepEqual(watchQuery(query), query);
  for (const patch of [{ steps: [] }, { do: 'click' }, { url: 'file:///tmp/private' }, { url: 'javascript:alert(1)' },
    { url: 'https://user:secret@example.test/ticket' }, { url: 'https://example.test/\nticket' },
    { url: 'https://EXAMPLE.test/ticket' }, { find: '' }, { find: ' ' }, { find: '\n' }, { find: 'x'.repeat(513) }, { sleightWatch: 2 }])
    assert.throws(() => watchQuery({ ...query, ...patch }), undefined, JSON.stringify(patch));
});

test('a scheduled read cannot compile missing helpers or trigger their setup', async () => {
  const f = fixture({ dependencies: { prepareHelpers: async ({ compile }) => {
    await assert.rejects(compile(), /WATCH_HELPERS_UNAVAILABLE/);
    return { status: 'unavailable' };
  } } });
  await assert.rejects(readWatch(query, undefined, f.dependencies), /WATCH_HELPERS_UNAVAILABLE/);
  assert.deepEqual(f.calls, []);
});

test('predicate reads element names only and refuses the whole protected snapshot', () => {
  assert.equal(watchMatch(tree('SHIPPED'), 'shipped'), true);
  assert.equal(watchMatch(tree('Waiting'), 'shipped'), false);
  assert.equal(watchMatch(tree('Delivered'), 'shipped|delivered'), true);
  assert.equal(watchMatch(tree('anything'), '.*'), false);
  assert.equal(watchMatch([node('RootWebArea', 'shipped'), node('StaticText', 'waiting', { value: { value: 'shipped' } })], 'shipped'), false);
  const secret = node('textbox', 'shipped', { properties: [{ name: 'protected', value: { value: true } }] });
  assert.throws(() => watchMatch([node('RootWebArea', 'Ticket'), secret, node('StaticText', 'shipped', { parentId: secret.nodeId })], 'shipped'), /WATCH_PROTECTED_FIELDS/);
  assert.throws(() => watchMatch([...tree('Shipped'), node('password', '')], 'shipped'), /WATCH_PROTECTED_FIELDS/);
  assert.equal(watchMatch([node('RootWebArea', 'Ticket'), node('button', 'waiting')], 'button'), false);
  assert.equal(watchMatch([node('RootWebArea', 'Ticket'), node('button', 'waiting')], 'button waiting'), false);
  assert.equal(watchMatch([node('RootWebArea', 'Ticket'), node('StaticText', 'shipped', { ignored: true })], 'shipped'), false);
  for (const nodes of [[], [node('StaticText', 'shipped')], Array.from({ length: 10001 }, () => node('StaticText', 'shipped')),
    [node('RootWebArea', 'Ticket'), node('StaticText', 'x'.repeat(1048576))]]) assert.throws(() => watchMatch(nodes, 'shipped'), /INCOMPLETE/);
});

test('one check attaches, checks identity around a names-only read and detaches, with no input or JavaScript', async () => {
  const f = fixture();
  const result = await readWatch(query, undefined, f.dependencies);
  assert.deepEqual(result, { matched: true, binding: { browser: 'browser1', incarnation: 'incarnation1', target: 'target1' },
    scope: 'main-document accessibility names' });
  assert.deepEqual(f.calls.map(call => call.method), ['connect', 'Target.getTargets', 'Target.attachToTarget', 'Target.getTargetInfo',
    'Page.getFrameTree', 'DOM.enable', 'DOM.performSearch', 'DOM.discardSearchResults', 'DOM.performSearch', 'DOM.discardSearchResults',
    'Accessibility.getFullAXTree', 'Page.getFrameTree', 'Target.getTargetInfo', 'DOM.performSearch', 'DOM.discardSearchResults', 'DOM.performSearch', 'DOM.discardSearchResults', 'Target.detachFromTarget', 'disconnect']);
  assert.deepEqual(f.calls.find(call => call.method === 'Accessibility.getFullAXTree').params, { frameId: 'frame1' });
});

test('missing and ambiguous URLs stop before any attachment', async () => {
  for (const targets of [[], [{ type: 'page', url: query.url, targetId: 'a' }, { type: 'page', url: query.url, targetId: 'b' }]]) {
    const f = fixture({ targets });
    await assert.rejects(readWatch(query, undefined, f.dependencies), /NEEDS_ONE_EXISTING_TAB/);
    assert.ok(!f.calls.some(call => call.method === 'Target.attachToTarget'));
    assert.equal(f.calls.at(-1).method, 'disconnect');
  }
});

test('a changed browser incarnation or target never silently rebinds', async () => {
  for (const binding of [{ browser: 'other', incarnation: 'incarnation1', target: 'target1' },
    { browser: 'browser1', incarnation: 'other', target: 'target1' }, { browser: 'browser1', incarnation: 'incarnation1', target: 'other' }]) {
    const f = fixture();
    await assert.rejects(readWatch(query, binding, f.dependencies), /TARGET_CHANGED/);
    assert.ok(!f.calls.some(call => call.method === 'Target.attachToTarget'));
  }
});

test('pending navigation, URL or document replacement refuses; no fallback, reopen or reload', async () => {
  for (const options of [{ changedTarget: { type: 'page', url: 'https://other.test/', targetId: 'target1' } },
    { changedTarget: { type: 'page', url: query.url, targetId: 'different-target' } },
    { targets: [{ type: 'page', url: query.url, targetId: 'target1', pendingUrl: 'https://other.test/' }] },
    { changedFrame: { loaderId: 'new-loader' } }, { changedFrame: { url: 'https://other.test/' } }]) {
    const f = fixture(options);
    await assert.rejects(readWatch(query, undefined, f.dependencies), /TARGET_CHANGED/);
    assert.equal(f.calls.at(-1).method, 'disconnect');
  }
});

test('package, config, browser block, site block and connection revocation refuse further reads', async () => {
  for (const dependencies of [
    { acceptPackage: () => ({ current: () => false }) },
    { permissions: { app: ({ bundleId }) => bundleId === 'com.google.Chrome', site: () => false } },
    { permissions: { app: () => false, site: () => true } },
  ]) {
    const f = fixture({ dependencies });
    await assert.rejects(readWatch(query, undefined, f.dependencies), /PERMISSION_OR_CONNECTION_CHANGED/);
    assert.deepEqual(f.calls.map(call => call.method), ['disconnect']);
  }
  const f = fixture({ current: false });
  await assert.rejects(readWatch(query, undefined, f.dependencies), /PERMISSION_OR_CONNECTION_CHANGED/);
  assert.ok(!f.calls.some(call => call.method === 'Accessibility.getFullAXTree'));
  let reads = 0;
  const changing = fixture({ dependencies: { readConfig: () => ({ receipt: {}, changed: ++reads > 1 }) } });
  await assert.rejects(readWatch(query, undefined, changing.dependencies), /PERMISSION_OR_CONNECTION_CHANGED/);
});

test('read failure is unknown and cleanup still runs; unconfirmed cleanup is retained', async () => {
  const f = fixture({ send: async method => { if (method === 'Accessibility.getFullAXTree') throw Error('page-supplied error'); } });
  await assert.rejects(readWatch(query, undefined, f.dependencies), /page-supplied/);
  assert.deepEqual(f.calls.slice(-2).map(call => call.method), ['Target.detachFromTarget', 'disconnect']);
  const uncollected = fixture({ collected: false });
  await assert.rejects(readWatch(query, undefined, uncollected.dependencies), error => error.cleanupUnconfirmed && error.message === 'WATCH_CLEANUP_UNCONFIRMED');
});

test('a hung read is bounded and the selected connection is closed', async () => {
  const f = fixture({ send: method => method === 'Accessibility.getFullAXTree' ? new Promise(() => {}) : undefined });
  await assert.rejects(readWatch(query, undefined, f.dependencies), /WATCH_READ_TIMEOUT/);
  assert.equal(f.calls.at(-1).method, 'disconnect');
});

test('production connection with a fake native helper never presents, activates or spawns UI', async t => {
  const f = fixture(), forbidden = [], helperCalls = [], sockets = [];
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-watch-connection-'))));
  const executable = join(root, 'browser'); writeFileSync(executable, 'fixture browser', { mode: 0o700 });
  symlinkSync(hostname() + '-4312', join(root, 'SingletonLock'));
  writeFileSync(join(root, 'DevToolsActivePort'), '9222\n/devtools/browser/fixture\n', { mode: 0o600 });
  const config = { profileRoot: root, executable, receipt: {} }, start = Date.now() - 10000;
  const deny = name => () => { forbidden.push(name); throw Error(`unexpected ${name}`); };
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
    t.mock.method(childProcess, method, deny(method));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const helper = {
    process: async (pid, expected) => {
      helperCalls.push('process'); assert.equal(pid, 4312); assert.equal(expected, executable);
      return { pid, uid: process.getuid(), start, incarnation: 'p4312-s123-u456' };
    }, present: deny('present'), activate: deny('activate'), spawn: deny('helper.spawn'),
  };
  class Socket extends EventTarget {
    readyState = 0;
    constructor(endpoint) {
      super(); sockets.push(this); assert.equal(endpoint, 'ws://127.0.0.1:9222/devtools/browser/fixture');
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    async send(text) {
      const { id, method, params, sessionId } = JSON.parse(text);
      assert.doesNotMatch(method, /activate|createTarget|bringToFront|Input\./i);
      const result = await f.session.send(method, params, sessionId);
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }) }));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  f.dependencies.readConfig = () => config;
  f.dependencies.timeoutMs = 1000;
  f.dependencies.prepareHelpers = async () => ({ status: 'ready', receipt: helper });
  f.dependencies.selectConnection = options => createSelectedConnection({ ...options, testDependencies: {
    processMetadata: options.nativeReceipt.process, WebSocket: Socket,
    execFile: async (file, args) => {
      assert.equal(file, '/usr/sbin/lsof'); assert.deepEqual(args, ['-nP', '-a', '-iTCP:9222', '-sTCP:LISTEN', '-Fpun']);
      return { stdout: `p4312\nu${process.getuid()}\nf12\nn127.0.0.1:9222\n` };
    },
  } });
  assert.equal((await readWatch(query, undefined, f.dependencies)).matched, true);
  assert.ok(helperCalls.length > 2, 'production connect and verify must consult the fake helper');
  assert.equal(sockets.length, 1); assert.equal(sockets[0].readyState, 3);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(f.calls.slice(-1).map(call => call.method), ['Target.detachFromTarget']);
});

test('only the origin attested public at creation may be read', async () => {
  for (const publicOrigin of [undefined, false, 'https://other.test', query.url]) {
    const f = fixture({ dependencies: { publicOrigin } });
    await assert.rejects(readWatch(query, undefined, f.dependencies), /WATCH_PUBLIC_HOST_REQUIRED/);
    assert.deepEqual(f.calls, []);
  }
});

test('query and fragment credentials and secret-shaped values are refused', () => {
  for (const suffix of ['?token=abc', '?api_key=x', '?accessToken=x', '?password=x', '?sessionid=x', '?code=x', '?auth=abc', '?key=abc', '?sid=abc', '?q=Bearer+abc',
    '#access_token=abc', '#/reset?secret=abc', '?q=Bearer%20abc', '?q=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    '?q=0123456789abcdef0123456789abcdef', '#abcDEF0123456789abcDEF0123456789', '?%2574oken=x'])
    assert.throws(() => watchQuery({ ...query, url: 'https://example.test/ticket' + suffix }), /secret/i, suffix);
  assert.equal(watchQuery({ ...query, url: 'https://example.test/ticket?sort=recent#status' }).find, 'shipped');
});


test('DOM protected-field checks refuse before matching, including a field that appears during the read', async () => {
  for (const appear of [1, 2]) {
    let checks = 0;
    const f = fixture({ send: (method, params) => {
      if (method === 'DOM.performSearch' && params.query.includes('password')) return { searchId: 'guard1', resultCount: ++checks >= appear ? 1 : 0 };
    } });
    await assert.rejects(readWatch(query, undefined, f.dependencies), /WATCH_PROTECTED_FIELDS/);
    assert.equal(checks, appear);
    if (appear === 1) assert.ok(!f.calls.some(call => call.method === 'Accessibility.getFullAXTree'));
    assert.deepEqual(f.calls.slice(-2).map(call => call.method), ['Target.detachFromTarget', 'disconnect']);
  }
});


test('an embedded origin not marked public at creation refuses before the page read', async () => {
  const f = fixture({ children: [{ frame: { id: 'child', url: 'https://account.test/login' } }] });
  await assert.rejects(readWatch(query, undefined, f.dependencies), /WATCH_PUBLIC_HOST_REQUIRED/);
  assert.ok(!f.calls.some(call => call.method === 'Accessibility.getFullAXTree'));
});
