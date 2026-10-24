import test from 'node:test';
import assert from 'node:assert/strict';
import { watchQuery, watchMatch, readWatch } from '../plugins/sleight/lib/watch-read.mjs';

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
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { ...frame, ...(frames++ && options.changedFrame) } } };
    if (method === 'Accessibility.getFullAXTree') return { nodes: options.nodes ?? tree('Shipped') };
    if (method === 'Target.detachFromTarget') return {};
    throw Error('unexpected command: ' + method);
  } };
  const selected = { session, selectedBrowser: 'browser1', browserIncarnation: 'incarnation1',
    endpoint: 'ws://127.0.0.1:9222/devtools/browser/one',
    async connect() { calls.push({ method: 'connect' }); return session; },
    async verifyConnection() { return !closed && options.current !== false; },
    async disconnect() { closed = true; calls.push({ method: 'disconnect' }); return options.collected !== false; } };
  const dependencies = { readConfig: () => config, acceptPackage: () => ({ current: () => true }),
    prepareHelpers: async () => ({ status: 'ready', receipt: {} }), selectConnection: async () => selected,
    createUi: () => ({ present() {}, close() {} }),
    permissions: { app: () => false, site: () => false }, timeoutMs: 20, ...options.dependencies };
  return { calls, dependencies, target };
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

test('predicate reads names only, excludes title, protected subtrees, hidden nodes and values', () => {
  assert.equal(watchMatch(tree('SHIPPED'), 'shipped'), true);
  assert.equal(watchMatch(tree('Waiting'), 'shipped'), false);
  assert.equal(watchMatch(tree('Delivered'), 'shipped|delivered'), true);
  assert.equal(watchMatch(tree('anything'), '.*'), false);
  assert.equal(watchMatch([node('RootWebArea', 'shipped'), node('StaticText', 'waiting', { value: { value: 'shipped' } })], 'shipped'), false);
  const secret = node('textbox', 'shipped', { properties: [{ name: 'protected', value: { value: true } }] });
  assert.equal(watchMatch([node('RootWebArea', 'Ticket'), secret, node('StaticText', 'shipped', { parentId: secret.nodeId })], 'shipped'), false);
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
    'Page.getFrameTree', 'Accessibility.getFullAXTree', 'Page.getFrameTree', 'Target.getTargetInfo', 'Target.detachFromTarget', 'disconnect']);
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

test('the connection indicator accepts only authenticated person events and closes on every check', async () => {
  for (const authentic of [false, true]) {
    let closed = false;
    const f = fixture({ dependencies: { createUi: () => ({
      present(_id, data, choices, deliver) {
        assert.equal(data.status, 'connected'); assert.deepEqual(choices, ['pause', 'disconnect']);
        deliver({ action: 'disconnect' });
      }, authenticate: () => authentic, close: () => { closed = true; },
    }) } });
    if (authentic) {
      await assert.rejects(readWatch(query, undefined, f.dependencies), /PERMISSION_OR_CONNECTION_CHANGED|WATCH_STOPPED/);
      assert.ok(!f.calls.some(call => call.method === 'Accessibility.getFullAXTree'));
    } else assert.equal((await readWatch(query, undefined, f.dependencies)).matched, true);
    assert.equal(closed, true);
  }
});

test('a person stopping during detach still pauses, and ordinary UI closure is not a user stop', async () => {
  let deliver, onLoss;
  const f = fixture({ send: method => {
    if (method === 'Target.detachFromTarget') deliver({ action: 'pause' });
  }, dependencies: { createUi: (_receipt, loss) => {
    onLoss = loss;
    return { present(_id, _data, _choices, callback) { deliver = callback; }, authenticate: () => true, close() { onLoss(); } };
  } } });
  await assert.rejects(readWatch(query, undefined, f.dependencies), /WATCH_STOPPED/);
  const ordinary = fixture({ dependencies: { createUi: (_receipt, loss) => ({ present() {}, close: loss }) } });
  assert.equal((await readWatch(query, undefined, ordinary.dependencies)).matched, true);
});
