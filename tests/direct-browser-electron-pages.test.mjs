import test from 'node:test';
import assert from 'node:assert/strict';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';
import { setViewport, restoreViewport } from '../plugins/sleight/lib/direct-browser/viewport.mjs';
import { app, identity, recipe, page, rect, fakeUpstream, fakeWindows, nativeWindow, fakeBrowser, tick } from './fixtures/electron-graph.mjs';
import { withMT } from './fixtures/mt-env.mjs';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

for (const mode of [undefined, '0']) test(`MTb Electron handles use the shared format and reject forged handles, switch=${mode}`, async t => withMT(mode, async () => {
  const f = fakeUpstream([page('a'), page('b', 'app://main/b.html')]);
  f.geometry.set('a', geometryOf(rect(0, 0))); f.geometry.set('b', geometryOf(rect(900, 0)));
  const s = await world({ extra: { upstream: f, windows: fakeWindows([nativeWindow(11, rect(0, 0)), nativeWindow(12, rect(900, 0))]) } });
  t.after(() => s.filter.dispose());
  let draws = 0;
  const original = crypto.randomBytes, mocked = t.mock.method(crypto, 'randomBytes', size => size === 9 ? Buffer.alloc(9, draws++ < 2 ? 0 : 1) : original(size));
  syncBuiltinESMExports();
  try {
    await s.pages.seed();
    const rows = await s.pages.list();
    assert.equal(rows.length, 2); assert.equal(new Set(rows.map(row => row.tab)).size, 2);
    for (const row of rows) {
      assert.match(row.tab, mode === '0' ? /^t[0-9a-f]{32}$/ : /^t[a-z2-7]{9}$/);
      assert.equal(s.pages.tab(row.tab).targetId, row.targetId);
    }
    if (mode !== '0') assert.equal(draws, 3, 'the second admission retries the colliding draw');
    assert.throws(() => s.pages.tab('tforged123'), /unknown|owned/i);
    await s.pages.endTurn();
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
}));

const base = new URL('../plugins/sleight/lib/direct-browser/', import.meta.url);
async function load() {
  const modules = {};
  for (const name of ['electron-targets', 'electron-native-join', 'electron-pages']) {
    try { modules[name] = await import(new URL(name + '.mjs', base)); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  }
  assert.equal(typeof modules['electron-pages']?.createAppPageRegistry, 'function', 'EPV3-3 must provide the app page registry');
  return modules;
}
const geometryOf = frame => ({ ...frame, scale: 2, visible: true });

async function world({ targets: initial, windows, owner = 'session-a', fence, extra } = {}) {
  const m = await load();
  const f = extra?.upstream ?? fakeUpstream(initial);
  const w = extra?.windows ?? fakeWindows(windows);
  const targets = m['electron-targets'].createAppTargets({ upstream: f.session, identity, expected: app, recipe, verify: async () => true });
  await targets.start();
  const join = m['electron-native-join'].createNativeJoin({ app, approved: () => true, readWindows: w.read, now: () => 1000 });
  const filter = createCDPFilter({ session: f.session, app: targets.filterHooks });
  const pw = fakeBrowser(filter);
  await pw.browser.ready();
  const pages = m['electron-pages'].createAppPageRegistry({ browser: pw.browser, filter, targets, join, fence: fence ?? m['electron-targets'].createInstanceFence(),
    owner, timeoutMs: 500 });
  return { m, f, w, targets, join, filter, pw, pages };
}

// VP1 clears media over CDP (Emulation.setEmulatedMedia with empty values), not through emulateMedia.
function mediaClears(entry, calls, failing = () => false) {
  entry.page.context = () => ({ newCDPSession: async () => ({ detach: async () => {}, send: async (method, params) => {
    if (method === 'Emulation.setEmulatedMedia') {
      if (failing()) throw Error('restore failed');
      assert.equal(entry.released, false); calls.push([method, params]);
    }
    return {};
  } }) });
}

for (const release of ['keep', 'handoff', 'endTurn']) test(`FD5 app ${release} restores media before releasing the renderer`, async t => {
  const s = await world({ targets: [page('a')], windows: [nativeWindow(11, rect(0, 0))] }); t.after(() => s.filter.dispose());
  await s.pages.seed();
  const [{ tab }] = await s.pages.list(), entry = s.pages.tab(tab), calls = [];
  entry.page.emulateMedia = async media => { calls.push(media); assert.equal(entry.released, false); };
  mediaClears(entry, calls);
  await setViewport(entry.page, { color_scheme: 'dark', reduced_motion: true });
  if (release === 'endTurn') assert.equal((await s.pages.endTurn()).cleanedUp, true);
  else { await s.pages[release](tab); await s.pages.endTurn(); }
  assert.deepEqual(calls, [{ colorScheme: 'dark', reducedMotion: 'reduce' }, ['Emulation.setEmulatedMedia', { media: '', features: [] }]]);
  assert.equal(entry.released, true); assert.deepEqual(s.pw.closes, []);
});

test('FD5 a failed app media restore keeps ownership and can retry release', async t => {
  const s = await world({ targets: [page('a')], windows: [nativeWindow(11, rect(0, 0))] }); t.after(() => s.filter.dispose());
  await s.pages.seed();
  const [{ tab }] = await s.pages.list(), entry = s.pages.tab(tab); let fail = false;
  entry.page.emulateMedia = async () => {};
  mediaClears(entry, [], () => fail);
  await setViewport(entry.page, { color_scheme: 'dark' }); fail = true;
  await assert.rejects(s.pages.keep(tab), /restore failed/);
  assert.equal(s.pages.tab(tab), entry); assert.equal(entry.released, false);
  fail = false; await s.pages.keep(tab); assert.equal(entry.released, true);
  await s.pages.endTurn();
});

for (const release of ['keep', 'handoff', 'endTurn']) test(`FD5B app ${release} after a reset releases with no override left`, async t => {
  const s = await world({ targets: [page('a')], windows: [nativeWindow(11, rect(0, 0))] }); t.after(() => s.filter.dispose());
  await s.pages.seed();
  const [{ tab }] = await s.pages.list(), entry = s.pages.tab(tab), calls = [];
  let size = { width: 1000, height: 800 };
  entry.page.context = () => ({ newCDPSession: async () => ({
    send: async method => { calls.push(method); return { cssLayoutViewport: { clientWidth: size.width, clientHeight: size.height } }; },
    detach: async () => {} }) });
  entry.page.setViewportSize = async next => { size = next; };
  entry.page._connection = { toImpl: () => ({ emulatedMedia: () => ({ colorScheme: 'light', reducedMotion: 'no-preference' }) }) };
  entry.page.emulateMedia = async media => { calls.push(media); assert.equal(entry.released, false); };
  await setViewport(entry.page, { width: 390, height: 844, color_scheme: 'dark', reduced_motion: true });
  await restoreViewport(entry.page);
  for (const method of ['Emulation.clearDeviceMetricsOverride', 'Emulation.setEmulatedMedia']) assert.ok(calls.includes(method), method);
  calls.length = 0;
  if (release === 'endTurn') assert.equal((await s.pages.endTurn()).cleanedUp, true);
  else await s.pages[release](tab);
  // Since VP1 a reset already removes every override, so release has nothing left to clear.
  assert.deepEqual(calls, []);
  assert.equal(entry.released, true); assert.deepEqual(s.pw.closes, []);
  await s.pages.endTurn();
});

test('FD5B app turn end reports the unknown original size while clearing its override', async t => {
  const s = await world({ targets: [page('a')], windows: [nativeWindow(11, rect(0, 0))] }); t.after(() => s.filter.dispose());
  await s.pages.seed();
  const [{ tab }] = await s.pages.list(), entry = s.pages.tab(tab);
  entry.page.context = () => ({ newCDPSession: async () => ({ send: async method => {
    if (method === 'Page.getLayoutMetrics') throw Error('size unavailable');
    assert.equal(method, 'Emulation.clearDeviceMetricsOverride'); return {};
  }, detach: async () => {} }) });
  entry.page.setViewportSize = async () => {};
  await setViewport(entry.page, { width: 390, height: 844 });
  const result = await s.pages.endTurn();
  assert.equal(result.cleanedUp, true);
  assert.match(result.rows[0].viewport, /previous size unknown/);
});

test('the app filter refuses unadmitted targets before any attach, Target.create/close and focus emulation', async t => {
  const f = fakeUpstream([page('a'), page('d', 'devtools://devtools/x.html')]);
  assert.throws(() => createCDPFilter({ session: f.session, ownedTargets: ['a'], app: { admit: async () => true, current: () => true } }), /CDP_CONNECTION_REQUIRED/,
    'app mode never takes an initial owned list that would skip admission');
  const filter = createCDPFilter({ session: f.session, app: { admit: async info => info.targetId === 'a', current: id => id === 'a' } });
  t.after(() => filter.dispose());
  await assert.rejects(filter.own('d'), /CDP_TARGET_NOT_OWNED/);
  await assert.rejects(filter.session.send('Target.attachToTarget', { targetId: 'd', flatten: true }), /CDP_TARGET_NOT_OWNED/);
  assert.deepEqual(f.attaches(), []);
  await filter.own('a');
  assert.equal(filter.owns('a'), true);
  for (const [method, params] of [['Target.createTarget', { url: 'about:blank', background: true }], ['Target.closeTarget', { targetId: 'a' }]])
    await assert.rejects(filter.session.send(method, params), /CDP_COMMAND_REFUSED/);
  const { sessionId } = await filter.session.send('Target.attachToTarget', { targetId: 'a', flatten: true });
  for (const method of ['Page.close', 'Page.crash', 'Emulation.setFocusEmulationEnabled', 'Page.bringToFront'])
    await assert.rejects(filter.session.send(method, {}, sessionId), /CDP_COMMAND_REFUSED/);
  await filter.session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  assert.deepEqual(f.calls.at(-1).params.filter, [{ type: 'iframe' }, { exclude: true }], 'child auto-attach asks for frames only');
});

test('app filter children: an OOPIF swap moves the route, workers are resumed and detached without a route', async t => {
  const f = fakeUpstream([page('a')]);
  const filter = createCDPFilter({ session: f.session, app: { admit: async () => true, current: () => true } });
  t.after(() => filter.dispose());
  const events = []; filter.session.on('event', frame => events.push(frame));
  await filter.own('a');
  const { sessionId } = await filter.session.send('Target.attachToTarget', { targetId: 'a', flatten: true });
  f.sessions.set('frame-1', 'f1');
  f.emit({ method: 'Target.attachedToTarget', sessionId, params: { sessionId: 'frame-1', targetInfo: { targetId: 'f1', type: 'iframe', url: 'https://x.example/' }, waitingForDebugger: true } });
  assert.equal(filter.owns('f1'), true);
  f.emit({ method: 'Target.detachedFromTarget', sessionId, params: { sessionId: 'frame-1', targetId: 'f1' } });
  assert.equal(filter.owns('f1'), false, 'the swapped-out frame loses its route synchronously');
  f.sessions.set('frame-2', 'f2');
  f.emit({ method: 'Target.attachedToTarget', sessionId, params: { sessionId: 'frame-2', targetInfo: { targetId: 'f2', type: 'iframe', url: 'https://y.example/' }, waitingForDebugger: true } });
  assert.equal(filter.owns('f2'), true);
  f.sessions.set('worker-1', 'w1');
  f.emit({ method: 'Target.attachedToTarget', sessionId, params: { sessionId: 'worker-1', targetInfo: { targetId: 'w1', type: 'worker', url: 'app://main/w.js' }, waitingForDebugger: true } });
  await tick();
  assert.equal(filter.owns('w1'), false);
  assert.ok(f.calls.some(row => row.method === 'Runtime.runIfWaitingForDebugger' && row.route === 'worker-1'), 'a paused worker is resumed');
  assert.ok(f.calls.some(row => row.method === 'Target.detachFromTarget' && row.params.sessionId === 'worker-1'));
  assert.ok(!events.some(frame => frame.params?.targetInfo?.targetId === 'w1'), 'workers are lifecycle signals only');
});

test('seed admits only joined app pages: DevTools, workers, hidden, ambiguous and other-instance windows are never listed or attached', async t => {
  const f = fakeUpstream([page('a'), page('b', 'app://main/b.html'), page('c', 'app://main/c.html'), page('h', 'app://main/hidden.html'),
    page('d', 'devtools://devtools/x.html'), { ...page('w'), type: 'service_worker' }]);
  f.geometry.set('a', geometryOf(rect(0, 0)));
  f.geometry.set('b', geometryOf(rect(900, 0)));
  f.geometry.set('c', geometryOf(rect(900, 0)));
  f.geometry.set('h', { ...geometryOf(rect(0, 700)), visible: false });
  const w = fakeWindows([nativeWindow(11, rect(0, 0)), nativeWindow(12, rect(900, 0)), nativeWindow(21, rect(0, 0), { pid: 4200 })]);
  const s = await world({ extra: { upstream: f, windows: w } });
  t.after(() => s.filter.dispose());
  await s.pages.seed();
  const rows = await s.pages.list();
  assert.deepEqual(rows.map(row => [row.targetId, row.status, row.window]), [['a', 'joined', { id: 11, epoch: 1 }]]);
  assert.match(rows[0].tab, (process.env.SLEIGHT_MT === '0' ? /^t[0-9a-f]{32}$/ : /^t[a-z2-7]{9}$/));
  for (const id of ['d', 'w']) assert.ok(!f.attaches().includes(id), id + ' never gets an attach');
  assert.equal(s.filter.owns('b'), false, 'b and c share a window: ambiguous, so not admitted');
  assert.equal(s.filter.owns('h'), false);
  assert.doesNotMatch(JSON.stringify(rows), /ignored|devtools/);
});

test('browser_open and close return the native handoff; endTurn and keep release control without closing anything', async t => {
  const f = fakeUpstream([page('a'), page('b', 'app://main/b.html')]);
  f.geometry.set('a', geometryOf(rect(0, 0))); f.geometry.set('b', geometryOf(rect(900, 0)));
  const s = await world({ extra: { upstream: f, windows: fakeWindows([nativeWindow(11, rect(0, 0)), nativeWindow(12, rect(900, 0))]) } });
  t.after(() => s.filter.dispose());
  await s.pages.seed();
  const [a, b] = await s.pages.list();
  await assert.rejects(s.pages.openTab({ url: 'https://example.com/' }), /ELECTRON_NATIVE_HANDOFF/);
  await assert.rejects(s.pages.close(a.tab), /ELECTRON_NATIVE_HANDOFF/);
  assert.equal(s.pages.closedOpener(a.tab), undefined);
  assert.deepEqual(await s.pages.keep(b.tab), { tab: b.tab, kept: true, handoff: false });
  assert.equal(s.filter.owns('b'), false);
  assert.throws(() => s.pages.tab(b.tab), /released/);
  assert.deepEqual((await s.pages.list()).map(row => row.targetId), ['a'], 'a kept window is not taken back this turn');
  assert.equal(s.filter.owns('b'), false);
  const receipt = await s.pages.endTurn();
  assert.deepEqual(receipt, { cleanedUp: true, rows: [{ tab: a.tab, kept: true, closed: false }, { tab: b.tab, kept: true, closed: false }] });
  assert.deepEqual(s.pw.closes, [], 'no app page or window is closed at turn end');
  assert.ok(!f.calls.some(row => /closeTarget|Page.close|Browser.close/.test(row.method)));
  assert.equal(s.filter.owns('a'), false);
  assert.throws(() => s.pages.tab(a.tab), /turn ended/);
});

test('a sheet that arrives during an awaited preparation stops the dispatch, and the page parks', async t => {
  const f = fakeUpstream([page('a')]); f.geometry.set('a', geometryOf(rect(0, 0)));
  const w = fakeWindows([nativeWindow(11, rect(0, 0))]);
  const s = await world({ extra: { upstream: f, windows: w } });
  t.after(() => s.filter.dispose());
  await s.pages.seed();
  const [a] = await s.pages.list();
  let dispatched = 0;
  await assert.rejects(s.pages.enqueue(a.tab, entry => s.pages.guard(entry, async () => {
    w.windows = [nativeWindow(11, rect(0, 0), { modal: 'sheet' })];
    s.join.invalidate('native-change');
  }).then(() => { dispatched++; })), /ELECTRON_PARKED/);
  assert.equal(dispatched, 0);
  assert.equal((await s.pages.list())[0].status, 'parked');
  await assert.rejects(s.pages.enqueue(a.tab, () => { dispatched++; }), /ELECTRON_PARKED/);
  assert.equal(dispatched, 0);
  assert.equal(await s.pages.enqueue(a.tab, () => 'read', { mutation: false }), 'read', 'a parked page can still be read');
  w.windows = [nativeWindow(11, rect(0, 0))];
  const [again] = await s.pages.list();
  assert.equal(again.status, 'joined', 'the same window id and epoch joins again after the sheet closes');
  assert.ok(again.joinNo > a.joinNo, 'a new join number tells later reads that refs need a fresh read');
  await s.pages.enqueue(a.tab, () => { dispatched++; });
  assert.equal(dispatched, 1);
});

test('a modal that arrives while an action waits in the queue stops it before it runs', async t => {
  const f = fakeUpstream([page('a')]); f.geometry.set('a', geometryOf(rect(0, 0)));
  const w = fakeWindows([nativeWindow(11, rect(0, 0))]);
  const s = await world({ extra: { upstream: f, windows: w } });
  t.after(() => s.filter.dispose());
  await s.pages.seed();
  const [a] = await s.pages.list();
  let release, ran = 0;
  const first = s.pages.enqueue(a.tab, () => new Promise(resolve => { release = resolve; }));
  const second = s.pages.enqueue(a.tab, () => { ran++; });
  await tick(); await tick();
  w.windows = [nativeWindow(11, rect(0, 0), { modal: 'dialog' })]; s.join.invalidate('native-change');
  release();
  await first;
  await assert.rejects(second, /ELECTRON_PARKED/);
  assert.equal(ran, 0);
});

test('two sessions on one instance: the second gets busy until the first ends its turn', async t => {
  const m = await load(), fence = m['electron-targets'].createInstanceFence();
  const f = fakeUpstream([page('a')]); f.geometry.set('a', geometryOf(rect(0, 0)));
  const w = fakeWindows([nativeWindow(11, rect(0, 0))]);
  const one = await world({ owner: 'session-a', fence, extra: { upstream: f, windows: w } });
  t.after(() => one.filter.dispose());
  await one.pages.seed();
  const [a] = await one.pages.list();
  await one.pages.enqueue(a.tab, () => {});
  const two = await world({ owner: 'session-b', fence, extra: { upstream: fakeUpstream([page('a')]), windows: w } });
  t.after(() => two.filter.dispose());
  await two.pages.seed();
  const [b] = await two.pages.list();
  let ran = 0;
  await assert.rejects(two.pages.enqueue(b.tab, () => { ran++; }), /ELECTRON_BUSY/);
  await one.pages.endTurn();
  await two.pages.enqueue(b.tab, () => { ran++; });
  assert.equal(ran, 1);
});

test('a mutation after 30 s idle renews the host lease first instead of refusing busy', async t => {
  const { createHostFence } = await import(new URL('electron-runtime.mjs', base));
  let clock = 0, holder = 'session-a';
  const ops = [];
  const fence = createHostFence({ owner: 'session-a', now: () => clock, op: async action => { ops.push(action); return { held: true, holder, leaseMs: 30000 }; } });
  await fence.renew();
  const f = fakeUpstream([page('a')]); f.geometry.set('a', geometryOf(rect(0, 0)));
  const s = await world({ fence, extra: { upstream: f, windows: fakeWindows([nativeWindow(11, rect(0, 0))]) } });
  t.after(() => s.filter.dispose());
  await s.pages.seed();
  const [a] = await s.pages.list();
  clock = 30001;
  let ran = 0;
  await s.pages.enqueue(a.tab, () => { ran++; });
  assert.equal(ran, 1, 'the idle lease was renewed, so the act ran');
  assert.deepEqual(ops, ['acquire', 'acquire']);
  clock = 60002; holder = 'session-b';
  await assert.rejects(s.pages.enqueue(a.tab, () => { ran++; }), /ELECTRON_BUSY/, 'another holder still refuses');
  assert.equal(ran, 1);
});

test('a destroyed or recycled target revokes its tab at once; the recycled ID needs a new admission and a new tab', async t => {
  const f = fakeUpstream([page('a')]); f.geometry.set('a', geometryOf(rect(0, 0)));
  const s = await world({ extra: { upstream: f, windows: fakeWindows([nativeWindow(11, rect(0, 0))]) } });
  t.after(() => s.filter.dispose());
  await s.pages.seed();
  const [a] = await s.pages.list();
  f.destroy('a');
  assert.throws(() => s.pages.tab(a.tab), /gone/);
  assert.equal(s.filter.owns('a'), false, 'routes go synchronously');
  f.create(page('a')); f.geometry.set('a', geometryOf(rect(0, 0)));
  const rows = await s.pages.list();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].tab, a.tab);
  assert.throws(() => s.pages.tab(a.tab), /gone/);
});

test('a second window that later matches the same rectangle parks the admitted page instead of guessing', async t => {
  const f = fakeUpstream([page('a')]); f.geometry.set('a', geometryOf(rect(0, 0)));
  const w = fakeWindows([nativeWindow(11, rect(0, 0))]);
  const s = await world({ extra: { upstream: f, windows: w } });
  t.after(() => s.filter.dispose());
  await s.pages.seed();
  const [a] = await s.pages.list();
  w.windows = [nativeWindow(11, rect(0, 0)), nativeWindow(15, rect(0, 0))];
  let ran = 0;
  await assert.rejects(s.pages.enqueue(a.tab, () => { ran++; }), /ELECTRON_PARKED/);
  assert.equal(ran, 0);
  assert.equal((await s.pages.list())[0].reason, 'ambiguous');
});

test('list admits a window that appeared without a target event', async t => {
  const f = fakeUpstream([page('a')]); f.geometry.set('a', geometryOf(rect(0, 0)));
  const w = fakeWindows([nativeWindow(11, rect(0, 0)), nativeWindow(12, rect(900, 0))]);
  const s = await world({ extra: { upstream: f, windows: w } });
  t.after(() => s.filter.dispose());
  await s.pages.seed();
  f.targets.set('b', page('b', 'app://main/b.html')); f.geometry.set('b', geometryOf(rect(900, 0)));
  assert.deepEqual((await s.pages.list()).map(row => row.targetId), ['a', 'b']);
});

test('a renderer that reports itself hidden joins its window and carries renderer: hidden to the entry and the list row', async t => {
  const f = fakeUpstream([page('a')]); f.geometry.set('a', { ...geometryOf(rect(0, 0)), visible: false });
  const s = await world({ extra: { upstream: f, windows: fakeWindows([nativeWindow(11, rect(0, 0))]) } });
  t.after(() => s.filter.dispose());
  await s.pages.seed();
  const [row] = await s.pages.list();
  assert.equal(row.status, 'joined'); assert.equal(row.renderer, 'hidden');
  assert.equal(await s.pages.enqueue(row.tab, entry => entry.renderer), 'hidden');
  f.geometry.set('a', geometryOf(rect(0, 0)));
  const [shown] = await s.pages.list();
  assert.equal(shown.renderer, undefined, 'the mark follows the latest read');
});
