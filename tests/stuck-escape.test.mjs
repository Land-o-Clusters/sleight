import { test, describe } from 'node:test';
import { localBackendSkip, localBackends, nativeLocal, nativeToolsClient, nativeToolsSkip, prepareNativeToolsFixture, localSpaceFixture } from './fixtures/mac-driver-tools.mjs';
import { createMacDriverTools, macDriverStuckEscapeNote } from '../plugins/sleight/lib/mac-driver/tools.mjs';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { createRelay, stuckEscapeNote } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { createStuckEscapes, sendStuckEscape, stuckEscapeOption } from '../plugins/sleight/lib/stuck-escape.mjs';

// The helper: one Escape down and up to the verified pid, after reading the app's own menu bar. `ax` is that app's
// menu bar: a title selected, a menu open, and what the title shows after the Escape.
for (const backend of localBackends) describe(backend, { skip: localBackendSkip(backend) }, () => {
const source = readFileSync(new URL('../plugins/sleight/lib/stuck-escape.js', import.meta.url), 'utf8');
const stuckBar = () => ({ selected: true, open: false, after: false });
function helper(options = {}) {
  if (backend === 'driver') {
    prepareNativeToolsFixture();
    const ax = options.ax ?? stuckBar();
    const request = { appId: 'org.test.editor', pid: 321, processStart: 42, lease: { path: '/lease', token: 'owned' },
      quietSeconds: 0.5, waitSeconds: 1.5, ...options.request };
    const app = { appId: request.appId, pid: options.pid ?? 321, processStart: options.processStart ?? 42 };
    const spaceInventory = localSpaceFixture(app.pid, app.appId);
    spaceInventory.windows[0].processStart = String(app.processStart);
    const actual = { ...spaceInventory.windows[0], identityVerified: true };
    const expected = { ...actual, pid: request.pid, processStart: String(request.processStart) };
    request.processStart = expected.processStart;
    request.driverIdentity = expected;
    request.resultAt ??= Date.now();
    const f = nativeLocal('stuck-escape.js', request, { apps: Array.from({ length: options.count ?? 1 }, () => app),
      spaceInventory, driverIdentities: [actual], focusedWindowId: '7',
      idle: options.idle ?? 5, menuState: { selected: ax.noMenuBar ? null : ax.selected, open: ax.open || ['AXMenu', 'AXMenuItem'].includes(ax.focused) },
      afterEscape: ax.after ?? null, lease: { token: options.token ?? 'owned', expires: options.expired ? 0 : Date.now() + 30000,
        window: { appId: options.appId ?? request.appId, title: 'Fixture', windowNumber: 7, url: null } } });
    const posted = f.events.filter(e => e[0] === 'key').map(e => e.slice(1));
    if (posted.length) ax.selected = ax.after;
    return { result: f.result, posted, waits: f.events.filter(e => e[0] === 'wait').map(e => e[1]),
      stderr: posted.length ? ['[sleight:stuck-escape-posted]\n'] : [] };
  }
  const posted = [], waits = [], stderr = [];
  let reads = 0;
  const ax = options.ax ?? stuckBar();
  const request = { appId: 'org.test.editor', pid: 321, processStart: 42, lease: { path: '/lease', token: 'owned' }, quietSeconds: 0.5, waitSeconds: 1.5, ...options.request };
  const running = { processIdentifier: options.pid ?? 321, launchDate: { timeIntervalSince1970: options.processStart ?? 42 } };
  const list = items => ({ count: items.length, objectAtIndex: i => items[i] });
  const item = { get AXSelected() { return ax.selected; } };
  const bar = { AXRole: 'AXMenuBar', AXChildren: list([{ AXSelected: false }, item]) };
  const app = { get AXMenuBar() { return ax.noMenuBar ? undefined : bar; },
    get AXChildren() { return list([bar, ...(ax.open ? [{ AXRole: 'AXMenu' }] : [])]); },
    get AXFocusedUIElement() { return ax.focused ? { AXRole: ax.focused } : undefined; } };
  const $ = value => typeof value === 'string' ? Object.assign(new String(value), { dataUsingEncoding: () => value }) : value;
  Object.assign($, {
    NSUTF8StringEncoding: 4,
    NSString: { stringWithContentsOfFileEncodingError: () => ({ isNil: () => false,
      raw: JSON.stringify({ token: options.token ?? 'owned', expires: options.expired ? 0 : Date.now() + 30000,
        window: { appId: options.appId ?? request.appId } }) }) },
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: id => {
      assert.equal(id, request.appId); return { count: options.count ?? 1, objectAtIndex: () => running };
    } },
    NSFileHandle: { fileHandleWithStandardError: { writeData: data => stderr.push(data) } },
    CGEventSourceSecondsSinceLastEventType: () => { const idle = [options.idle ?? 5].flat(); return idle[Math.min(reads++, idle.length - 1)]; },
    CGEventCreateKeyboardEvent: (_source, key, down) => ({ key, down }),
    CGEventSetFlags: (event, flags) => { event.flags = flags; },
    CGEventPostToPid: (pid, event) => { posted.push([pid, event.key, event.down, event.flags]); if (!event.down) ax.selected = ax.after; },
    AXUIElementCreateApplication: pid => { assert.equal(pid, request.pid); return app; },
    AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (element, name, out) => {
      const value = element[String(name)];
      if (value === undefined) return -25205;
      out[0] = value; return 0;
    },
  });
  const result = JSON.parse(runInNewContext(source + '\nrun([JSON.stringify(request)])', { $, request,
    Ref: () => [], ObjC: { import() {}, unwrap: value => value.raw ?? value, castRefToObject: value => value, deepUnwrap: value => value },
    delay: seconds => waits.push(seconds) }));
  return { result, posted, waits, stderr };
}
// A `run` for stuckEscapeOption that runs the helper source against the app's menu bar `ax`.
const helperRun = (ax, posted) => async (script, request) => {
  assert.equal(script, 'stuck-escape.js');
  const h = helper({ ax, request, token: request.lease?.token }); // the relay's lease grant, as the lease file holds it
  posted.push(...h.posted);
  return h.result;
};

test('the helper posts one Escape down and up to the verified pid, with no modifiers, then reads the menu bar', () => {
  const h = helper();
  assert.deepEqual(h.result, { ok: true, posted: true, ...backend === 'driver' ? { released: true } : {}, selected: false });
  assert.deepEqual(h.posted, [[321, 53, true, 0], [321, 53, false, 0]]);
  assert.deepEqual(h.stderr, ['[sleight:stuck-escape-posted]\n']);
  assert.equal(helper({ ax: { ...stuckBar(), after: true } }).result.selected, true);
});

// Claude's code can print a tree that looks stuck: the app's own menu bar decides.
test('the helper posts nothing unless the app\'s own menu bar has a title selected and no menu open', () => {
  for (const ax of [{ selected: false, open: false }, { selected: true, open: true }, { selected: true, open: false, focused: 'AXMenuItem' },
    { selected: true, open: false, noMenuBar: true }]) {
    const h = helper({ ax });
    assert.deepEqual(h.result, { ok: false, posted: false, error: 'The menu bar shows no stuck menu' }, JSON.stringify(ax));
    assert.deepEqual(h.posted, []);
  }
  // The check op only reads.
  const check = helper({ request: { op: 'check', lease: undefined, quietSeconds: undefined, waitSeconds: undefined } });
  assert.deepEqual(check.result, { ok: true, selected: true, open: false }); assert.deepEqual(check.posted, []);
});

test('the helper waits for half a second with no key or mouse input, up to 1.5 s, and posts nothing without it', () => {
  // The engine's typing reset idle just before the result; the user isn't at the Mac.
  // The native binding also checks idle against result age before and after the wait.
  const quiet = helper({ idle: backend === 'driver' ? [20, 0.05, 0.5, 20] : [0.05, 0.5] });
  assert.equal(quiet.result.ok, true); assert.equal(quiet.posted.length, 2); assert.equal(quiet.waits[0], 0.45);
  const busy = helper({ idle: 0.2 });
  assert.deepEqual(busy.result, { ok: false, posted: false, error: 'User input at the Mac' }); assert.deepEqual(busy.posted, []);
  assert.ok(busy.waits.reduce((a, b) => a + b, 0) <= 1.5);
});

test('the helper posts nothing for a changed process, ambiguous app, lost lease or recent user input', () => {
  for (const options of [{ pid: 99 }, { processStart: 99 }, { count: 2 }, { count: 0 }, { expired: true }, { token: 'other' },
    { appId: 'org.test.other' }, { idle: 0.2 }, { request: { pid: 0 } }, { request: { quietSeconds: 0.1 } }, { request: { waitSeconds: 9 } }]) {
    const h = helper(options);
    assert.equal(h.result.ok, false, JSON.stringify(options)); assert.equal(h.result.posted, false); assert.deepEqual(h.posted, []);
  }
});

// The episode: a selected menu-bar item with no menu on two results in a row for one app.
test('an Escape is due on the second stuck result in a row, once per episode', () => {
  const escapes = createStuckEscapes(), app = 'org.test.editor';
  assert.equal(escapes.observe(app, { stuck: true }), undefined);
  assert.equal(escapes.observe(app, { stuck: true }), 'escape');
  escapes.tried(app);
  assert.equal(escapes.observe(app, { stuck: true }), undefined);
  // The helper's own read showed the bar clear after it; a whole clean tree then starts a new episode.
  escapes.posted(app, false);
  escapes.observe(app, { cleared: true });
  assert.equal(escapes.observe(app, { stuck: true }), undefined);
  assert.equal(escapes.observe(app, { stuck: true }), 'escape');
});

test('an open menu or a partial view between stuck results breaks the run, and apps count apart', () => {
  const escapes = createStuckEscapes();
  escapes.observe('a', { stuck: true });
  escapes.observe('a', { stuck: false });
  assert.equal(escapes.observe('a', { stuck: true }), undefined);
  escapes.observe('b', { stuck: true });
  assert.equal(escapes.observe('a', { stuck: true }), 'escape');
  assert.equal(escapes.observe(undefined, { stuck: true }), undefined);
});

test('after an Escape the bar didn\'t show cleared, only the app\'s own read re-arms it, never result text', () => {
  const escapes = createStuckEscapes(), app = 'org.test.editor';
  escapes.observe(app, { stuck: true }); escapes.observe(app, { stuck: true }); escapes.tried(app); escapes.posted(app, null);
  assert.equal(escapes.observe(app, { cleared: true }), 'confirm');
  // One read at a time; text alone does nothing while it runs.
  assert.equal(escapes.observe(app, { cleared: true }), undefined);
  escapes.confirmed(app, { selected: true, open: false });
  for (let i = 0; i < 3; i++) assert.equal(escapes.observe(app, { stuck: true }), undefined);
  assert.equal(escapes.observe(app, { cleared: true }), 'confirm');
  escapes.confirmed(app, undefined);
  escapes.observe(app, { stuck: true });
  assert.equal(escapes.observe(app, { stuck: true }), undefined);
  assert.equal(escapes.observe(app, { cleared: true }), 'confirm');
  escapes.confirmed(app, { selected: false, open: false });
  escapes.observe(app, { stuck: true });
  assert.equal(escapes.observe(app, { stuck: true }), 'escape');
});

const target = { appId: 'org.test.editor', app: 'Editor', title: 'Draft', url: undefined };
const identityOk = (extra = {}) => ({ status: 'ok', matches: 1, headerMatches: 1, appId: 'org.test.editor', title: 'Draft', url: undefined,
  epoch: 'e', window: 7, pid: 321, processStart: 42, hidIdleSeconds: 10, ...extra });
test('sendStuckEscape posts to the pid the identity check names, with no user input since the stuck result', async () => {
  const runs = [];
  const run = async (script, request) => { runs.push([script, request]); return { ok: true, posted: true, selected: false }; };
  const result = await sendStuckEscape(target, { path: '/lease', token: 't' }, { identity: async () => identityOk(), run, since: 0, clock: () => 2000 });
  assert.deepEqual(result, { posted: true, selected: false });
  assert.equal(runs.length, 1); assert.equal(runs[0][0], 'stuck-escape.js');
  assert.deepEqual(runs[0][1], { appId: 'org.test.editor', pid: 321, processStart: 42, lease: { path: '/lease', token: 't' }, quietSeconds: 0.5, waitSeconds: 1.5 });
  // The engine typed right before its result: idle covers only the 50 ms since, which is enough here.
  assert.equal((await sendStuckEscape(target, {}, { identity: async () => identityOk({ hidIdleSeconds: 0.06 }), run, since: 1950, clock: () => 2000 })).posted, true);
  assert.equal((await sendStuckEscape(target, {}, { identity: async () => identityOk(), run })).posted, false);
  assert.equal(runs.length, 2);
});

test('sendStuckEscape posts nothing for another process, a changed window or user input since the result', async () => {
  let ran = 0;
  const run = async () => { ran++; return { ok: true, posted: true }; };
  const pinned = { ...target, nativeIdentity: { epoch: 'e', window: 7, pid: 321, processStart: 42 } };
  for (const [window, observed] of [[pinned, identityOk({ pid: 400 })], [pinned, identityOk({ processStart: 43 })],
    [target, identityOk({ title: 'Other' })], [target, identityOk({ matches: 2 })], [target, { status: 'mismatch', error: 'gone' }],
    [target, identityOk({ hidIdleSeconds: 0.5 })], [target, identityOk({ hidIdleSeconds: null })]]) {
    const result = await sendStuckEscape(window, {}, { identity: async () => observed, run, since: 0, clock: () => 1500 });
    assert.equal(result.posted, false, JSON.stringify(observed)); assert.ok(result.reason);
  }
  assert.equal(ran, 0);
  const failed = await sendStuckEscape(target, {}, { identity: async () => identityOk(), run: async () => ({ ok: false, posted: false, error: 'Input lease ownership lost or expired' }), since: 0, clock: () => 10 });
  assert.deepEqual(failed, { posted: false, reason: 'Input lease ownership lost or expired' });
});

test('a helper killed by its 5 s timeout after the key-down still reports the post; killed before it, nothing posted', async () => {
  const { runScript } = await import('../plugins/sleight/lib/launch.mjs');
  for (const [stderr, posted] of [['[sleight:stuck-escape-posted]\n', true], ['', false]]) {
    // A real child that the timeout kills after it wrote (or didn't write) the mark.
    const child = (_command, _args, options, callback) => {
      assert.equal(options.timeout, 5000);
      return execFile(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(stderr)}); setTimeout(() => {}, 5000)`], { ...options, timeout: 300 }, callback);
    };
    const result = await sendStuckEscape(target, {}, { identity: async () => identityOk(), run: (script, request) => runScript(script, request, child), since: 0, clock: () => 10 });
    assert.equal(result.posted, posted, JSON.stringify(result));
    if (posted) assert.equal(result.selected, null);
  }
});

test('SLEIGHT_STUCK_ESCAPE=0 turns the Escape off; it is on otherwise', () => {
  const deps = { identity: () => {}, run: () => {} };
  assert.equal(stuckEscapeOption({ SLEIGHT_STUCK_ESCAPE: '0' }, deps), undefined);
  for (const env of [{}, { SLEIGHT_STUCK_ESCAPE: '1' }]) {
    const option = stuckEscapeOption(env, deps);
    assert.equal(typeof option.send, 'function'); assert.equal(typeof option.check, 'function');
  }
});

// The relay: Word's Table title selected with no menu (word-edit-1, 2026-10-17), reduced as in wm1.test.mjs.
const header = 'Window: "Draft", App: Editor.\n0 standard window Draft';
const stuckTree = header + '\n124 menu bar\n\t129 Insert\n\t132 (selected) Table\n\t133 Window';
const cleanTree = header + '\n124 menu bar\n\t129 Insert\n\t132 Table\n\t133 Window';
const tick = () => new Promise(resolve => setImmediate(resolve));
// `send` alone gets a check that reads the bar clear; `option` is a whole { send, check }, as stuckEscapeOption makes.
function fixture(t, send, option) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [], traces = [], escapes = [], checks = [];
  const base = option ?? (send && { send, check: async () => ({ selected: false, open: false }) });
  for (const [stream, messages] of [[serverIn, sent], [clientOut, received]]) {
    stream.on('data', data => messages.push(...data.toString().trim().split('\n').map(JSON.parse)));
  }
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-stuck-escape-'))));
  const inputLease = new InputLease({ directory, holder: 'escape test' });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease, changeReview: false,
    trace: (direction, msg) => traces.push([direction, msg]),
    ...(base ? { stuckEscape: {
      send: async (window, grant, options) => { escapes.push({ window, grant, options }); return base.send(window, grant, options); },
      check: async window => { checks.push(window); return base.check(window); },
    } } : {}) });
  t.after(() => { relay.close(); for (const s of [clientIn, clientOut, serverIn, serverOut]) s.destroy(); });
  let id = 0;
  const call = async (text, code = 'await app.typeText("x")', appId = 'org.test.editor') => {
    const n = ++id;
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    await tick();
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: sent.at(-1).id, result: { content: [{ type: 'text', text }],
      ...(appId ? { _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { appId } } } } : {}) } }) + '\n');
    for (let i = 0; i < 5; i++) await tick();
    const reply = received.find(message => message.id === n);
    return reply && reply.result.content.map(part => part.text ?? '').join('\n');
  };
  return { call, sent, received, traces, escapes, checks };
}
const SENT = /^sleight sent one Escape to Editor to close a stuck menu \(menu-bar item 132\)/m;

test('the relay sends one Escape on the second stuck result for the leased app, says so, and traces it', async t => {
  const h = fixture(t, async () => ({ posted: true, selected: false }));
  await h.call(header, 'let app = await cua.getApp("Editor")');
  const first = await h.call(stuckTree);
  assert.doesNotMatch(first, SENT); assert.match(first, /a menu may be stuck open/);
  assert.equal(h.escapes.length, 0);
  const second = await h.call(stuckTree);
  assert.equal(h.escapes.length, 1);
  assert.equal(h.escapes[0].window.appId, 'org.test.editor'); assert.equal(h.escapes[0].window.title, 'Draft');
  assert.ok(h.escapes[0].grant.token); assert.ok(Number.isFinite(h.escapes[0].options.since));
  assert.match(second, SENT); assert.match(second, /no menu-bar item is selected now/);
  assert.doesNotMatch(second, /a menu may (?:still )?be stuck open/);
  const traced = h.traces.find(([direction]) => direction === 'stuck-escape');
  assert.ok(traced); assert.equal(traced[1].posted, true); assert.equal(traced[1].appId, 'org.test.editor'); assert.equal(traced[1].item, '132');
  // Still stuck after it: today's advice, and never a second Escape in this episode.
  const third = await h.call(stuckTree), fourth = await h.call(stuckTree);
  assert.equal(h.escapes.length, 1);
  assert.doesNotMatch(third + fourth, SENT);
  assert.match(third, /a menu may still be stuck open \(menu-bar item 132\), and keys may be swallowed/);
  // The menu closed: a new episode may get its own Escape after two more stuck results.
  await h.call(cleanTree); await h.call(stuckTree);
  assert.equal(h.escapes.length, 1);
  await h.call(stuckTree);
  assert.equal(h.escapes.length, 2);
});

test('an Escape the checks refused leaves today\'s advice and no claim, and is not tried again that episode', async t => {
  const h = fixture(t, async () => ({ posted: false, reason: 'user input since the result' }));
  await h.call(header, 'let app = await cua.getApp("Editor")');
  await h.call(stuckTree);
  const second = await h.call(stuckTree);
  assert.equal(h.escapes.length, 1);
  assert.doesNotMatch(second, /Escape to/);
  assert.match(second, /a menu may still be stuck open \(menu-bar item 132\)\./);
  assert.equal(h.traces.find(([direction]) => direction === 'stuck-escape')[1].reason, 'user input since the result');
  await h.call(stuckTree);
  assert.equal(h.escapes.length, 1);
});

test('an Escape that left the item selected says so and keeps today\'s advice', async t => {
  const h = fixture(t, async () => ({ posted: true, selected: true }));
  await h.call(header, 'let app = await cua.getApp("Editor")');
  await h.call(stuckTree);
  const second = await h.call(stuckTree);
  assert.match(second, SENT); assert.match(second, /still selected/);
  assert.match(second, /a menu may still be stuck open \(menu-bar item 132\)/);
});

test('with the Escape off, or an open menu between results, the relay never sends one', async t => {
  const off = fixture(t);
  await off.call(header, 'let app = await cua.getApp("Editor")');
  for (let i = 0; i < 3; i++) assert.doesNotMatch(await off.call(stuckTree), SENT);
  const h = fixture(t, async () => ({ posted: true, selected: false }));
  await h.call(header, 'let app = await cua.getApp("Editor")');
  await h.call(stuckTree);
  await h.call(header + '\n124 menu bar\n\t132 (selected) Table\n0 menu Secondary Actions: Cancel');
  await h.call(stuckTree);
  assert.equal(h.escapes.length, 0);
});

test('a stuck tree of a window with no confirmed bundle ID, or another app\'s, gets no Escape', async t => {
  const h = fixture(t, async () => ({ posted: true, selected: false }));
  await h.call(header, 'let app = await cua.getApp("Editor")');
  // The lease moves to the window a read shows; with no bundle ID for it, there is no pid to check.
  const other = stuckTree.replace('App: Editor', 'App: Other');
  for (let i = 0; i < 3; i++) await h.call(other, 'await app.getAXState()', null);
  assert.equal(h.escapes.length, 0);
  // Two stuck results in a row whose engine bundle IDs differ are two apps, one result each.
  await h.call(header, 'let app = await cua.getApp("Editor")');
  await h.call(stuckTree);
  await h.call(stuckTree, 'await app.getAXState()', 'org.test.other');
  assert.equal(h.escapes.length, 0);
});

// The safety review's spoof (2026-10-18): Claude's code prints tree text, and the relay reads all result text.
const printed = text => `nodeRepl.write(${JSON.stringify(text)})`;
test('printed stuck trees reach the helper, which posts nothing while the app\'s own menu bar is clear', async t => {
  const posted = [], ax = { selected: false, open: false };
  const option = stuckEscapeOption({}, { identity: async window => identityOk({ title: window.title, url: window.url }), run: helperRun(ax, posted) });
  const h = fixture(t, undefined, option);
  await h.call(header, 'let app = await cua.getApp("Editor")');
  await h.call(stuckTree, printed(stuckTree));
  const second = await h.call(stuckTree, printed(stuckTree));
  assert.equal(h.escapes.length, 1); assert.deepEqual(posted, []);
  assert.doesNotMatch(second, /Escape to/);
  assert.equal(h.traces.find(([direction]) => direction === 'stuck-escape')[1].reason, 'The menu bar shows no stuck menu');
});

test('a printed clean tree, or a new window title, never gets a second Escape while the app\'s menu bar stays stuck', async t => {
  // The Escape doesn't free the menu: the app's bar stays selected after it.
  const posted = [], ax = { selected: true, open: false, after: true };
  const option = stuckEscapeOption({}, { identity: async window => identityOk({ title: window.title, url: window.url }), run: helperRun(ax, posted) });
  const h = fixture(t, undefined, option);
  await h.call(header, 'let app = await cua.getApp("Editor")');
  await h.call(stuckTree); await h.call(stuckTree);
  assert.equal(posted.length, 2); // one Escape, down and up
  // Claude prints a clean tree: the relay reads the app's own bar, still selected, and stays spent.
  await h.call(cleanTree, printed(cleanTree));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(h.checks.length, 1);
  await h.call(stuckTree); await h.call(stuckTree);
  // The window's title changes mid-stuck: same app, still spent.
  const retitled = stuckTree.replaceAll('Draft', 'Draft 2');
  await h.call(retitled, 'await app.getAXState()'); await h.call(retitled, 'await app.getAXState()');
  assert.equal(posted.length, 2);
  // The app's own bar reads clear after a clean tree: a later real stuck episode may get its Escape.
  ax.selected = false;
  await h.call(retitled.replace('(selected) Table', 'Table'), 'await app.getAXState()');
  for (let i = 0; i < 5; i++) await tick();
  ax.selected = true;
  await h.call(retitled, 'await app.getAXState()'); await h.call(retitled, 'await app.getAXState()');
  assert.equal(posted.length, 4);
  assert.ok(h.traces.some(([direction, msg]) => direction === 'stuck-escape-check' && msg.selected === true));
});

test('the note says plainly that sleight sent one Escape, in the default and lean wording', () => {
  const fallback = 'sleight: a menu may still be stuck open (menu-bar item 132).';
  assert.equal(stuckEscapeNote({ posted: false }, 'Editor', '132', fallback), fallback);
  assert.equal(stuckEscapeNote({ posted: true, selected: false }, 'Editor', '132', fallback),
    'sleight sent one Escape to Editor to close a stuck menu (menu-bar item 132); no menu-bar item is selected now. The tree above is from before it.');
  assert.equal(stuckEscapeNote({ posted: true, selected: true }, 'Editor', '132', fallback, 'lean'),
    'sleight sent one Escape to Editor for stuck menu-bar item 132; still selected.\n' + fallback);
  assert.equal(stuckEscapeNote({ posted: true, selected: null }, 'Editor', '132', fallback, 'lean'),
    'sleight sent one Escape to Editor for stuck menu-bar item 132. Read to check it closed.');
});

});

const releaseWindow = { windowId: '42', pid: 321, processStart: '100.25', bundleId: 'org.test.editor',
  identityVerified: true, title: 'Draft' };
function escapeSpaceFixture() {
  const data = localSpaceFixture(321, releaseWindow.bundleId);
  data.windows[0] = { ...data.windows[0], ...releaseWindow };
  data.trees = { 42: { ...data.trees[7], AXWindowNumber: 42, AXTitle: 'Draft' } };
  return data;
}
function boundEscape(patch = {}, argsPatch = {}) {
  prepareNativeToolsFixture();
  const args = { appId: releaseWindow.bundleId, pid: 321, processStart: '100.25', driverIdentity: releaseWindow,
    lease: { path: '/fixture/lease', token: 'owned' }, quietSeconds: 0.5, waitSeconds: 1.5,
    resultAt: Date.now() - 100, ...argsPatch };
  return nativeLocal('stuck-escape.js', args, { apps: [{ appId: releaseWindow.bundleId, pid: 321 }],
    spaceInventory: escapeSpaceFixture(),
    driverIdentities: [releaseWindow], focusedWindowId: '42', idle: 20,
    menuState: { selected: true, open: false }, afterEscape: false,
    lease: { token: 'owned', expires: Date.now() + 30000,
      window: { appId: releaseWindow.bundleId, title: 'Draft', url: null, windowNumber: 42 } }, ...patch });
}
const escapeKeys = reply => reply.events.filter(event => event[0] === 'key');

test('Escape binds the leased window among siblings and cannot borrow another window', { skip: nativeToolsSkip }, () => {
  const data = escapeSpaceFixture();
  data.windows.unshift({ ...data.windows[0], windowId: '43', title: 'Sibling',
    bounds: { x: 400, y: 0, width: 200, height: 200 } });
  const admitted = boundEscape({ spaceInventory: data });
  assert.equal(admitted.result.ok, true, JSON.stringify(admitted));
  assert.deepEqual(escapeKeys(admitted), [['key', 321, 53, true, 0], ['key', 321, 53, false, 0]]);
  for (const patch of [
    f => { f.windows[1].onScreen = false; },
    f => { f.windows = [f.windows[0]]; },
    f => { f.windows[1].processStart = 'replaced'; },
    f => { delete f.trees[42]; },
    f => { f.windowSnapshots = [f.windows, [f.windows[0], { ...f.windows[1], onScreen: false }]]; },
  ]) {
    const invalid = structuredClone(data); patch(invalid);
    const refused = boundEscape({ spaceInventory: invalid });
    assert.equal(refused.result.posted, false, JSON.stringify(refused));
    assert.deepEqual(escapeKeys(refused), []);
  }
  for (const idle of [[20, 20, 20, 0], [20, 20, 20, 20, 20, 0]]) {
    const refused = boundEscape({ spaceInventory: data, idle });
    assert.equal(refused.result.posted, false, JSON.stringify(refused));
    assert.match(refused.result.error, /User input at the Mac/);
    assert.deepEqual(escapeKeys(refused), []);
  }
});

test('Escape refuses an absent leased window even with one visible app window', { skip: nativeToolsSkip }, () => {
  const reply = boundEscape({ apps: [{ appId: releaseWindow.bundleId, pid: 321, processStart: 9 }],
    lease: { token: 'owned', expires: Date.now() + 30000, window: { appId: releaseWindow.bundleId } } },
  { driverIdentity: undefined, processStart: 9 });
  assert.equal(reply.result.posted, false, JSON.stringify(reply));
  assert.deepEqual(escapeKeys(reply), []);
});

test('Escape releases to the same process after its window changes following key-down', { skip: nativeToolsSkip }, () => {
  const reply = boundEscape({ driverIdentities: [releaseWindow, releaseWindow, { ...releaseWindow, windowId: '43', title: 'Other' }] });
  assert.equal(reply.result.ok, true, JSON.stringify(reply));
  assert.equal(reply.result.released, true);
  assert.deepEqual(escapeKeys(reply), [['key', 321, 53, true, 0], ['key', 321, 53, false, 0]]);
});

test('Escape sends no release to a replaced or vanished process and reports why', { skip: nativeToolsSkip }, async t => {
  for (const [name, last] of [['pid', { ...releaseWindow, pid: 322 }], ['start', { ...releaseWindow, processStart: '101.25' }], ['gone', {}]]) await t.test(name, () => {
    const reply = boundEscape({ driverIdentities: [releaseWindow, releaseWindow, last] });
    assert.equal(reply.result.ok, false, JSON.stringify(reply));
    assert.equal(reply.result.posted, true); assert.equal(reply.result.released, false);
    assert.match(reply.result.releaseError, /target process changed/);
    assert.deepEqual(escapeKeys(reply), [['key', 321, 53, true, 0]]);
  });
});

test('Escape release failure is reported without retrying the key-up', { skip: nativeToolsSkip }, async t => {
  await t.test('release fault', () => {
    const reply = boundEscape({ escapeReleaseFails: true });
    assert.equal(reply.result.ok, false, JSON.stringify(reply));
    assert.equal(reply.result.posted, true); assert.equal(reply.result.released, false);
    assert.match(reply.result.releaseError, /Escape release failed/);
    assert.deepEqual(escapeKeys(reply), [['key', 321, 53, true, 0]]);
    assert.equal(reply.events.filter(event => event[0] === 'release-attempt').length, 1);
  });
  await t.test('wait and release faults', () => {
    const both = boundEscape({ escapeReleaseFails: true, escapeWaitFails: true });
    assert.equal(both.result.posted, true); assert.equal(both.result.released, false);
    assert.match(both.result.error, /Escape wait failed/); assert.match(both.result.releaseError, /Escape release failed/);
    assert.deepEqual(escapeKeys(both), [['key', 321, 53, true, 0]]);
    assert.equal(both.events.filter(event => event[0] === 'release-attempt').length, 1);
  });
  await t.test('wait fault still releases', () => {
    const waitOnly = boundEscape({ escapeWaitFails: true });
    assert.equal(waitOnly.result.posted, true); assert.equal(waitOnly.result.released, true);
    assert.match(waitOnly.result.error, /Escape wait failed/);
    assert.deepEqual(escapeKeys(waitOnly), [['key', 321, 53, true, 0], ['key', 321, 53, false, 0]]);
  });
});

test('native Escape refuses appId, pid and processStart arguments that disagree with driverIdentity', { skip: nativeToolsSkip }, async t => {
  for (const patch of [{ appId: 'org.test.other' }, { pid: 322 }, { processStart: '101.25' }]) await t.test(Object.keys(patch)[0], () => {
    const reply = boundEscape({}, patch);
    assert.equal(reply.result.posted, false, JSON.stringify(patch));
    assert.match(reply.result.error, /Invalid stuck-menu Escape target/);
    assert.deepEqual(escapeKeys(reply), []);
  });
});

test('native Escape refuses a leased window with a non-null url in both lease shapes', { skip: nativeToolsSkip }, async t => {
  for (const window of [
    { appId: releaseWindow.bundleId, title: 'Draft', windowNumber: 42, url: 'https://example.test/' },
    { appId: releaseWindow.bundleId, title: JSON.stringify(['42', 321, '100.25']), url: 'https://example.test/' },
  ]) await t.test(window.title === 'Draft' ? 'displayed' : 'identity-keyed', () => {
    const reply = boundEscape({ lease: { token: 'owned', expires: Date.now() + 30000, window } });
    assert.equal(reply.result.posted, false); assert.match(reply.result.error, /leased window changed/);
    assert.deepEqual(escapeKeys(reply), []);
  });
});

test('registerLocalTools refuses a non-check Escape without driverIdentity', { skip: nativeToolsSkip }, async t => {
  const driver = nativeToolsClient({ localTools: {} }); t.after(() => driver.close());
  await assert.rejects(driver.request('localTool', { args: ['stuck-escape.js', {
    appId: releaseWindow.bundleId, pid: 321, processStart: 42,
    lease: { path: '/fixture/lease', token: 'owned' }, quietSeconds: 0.5, waitSeconds: 1.5,
  }] }), { code: 'INVALID_PARAMS' });
  const window = { ...releaseWindow, app: 'Editor', onScreen: true, layer: 0, hidden: false,
    bounds: { x: 0, y: 0, width: 400, height: 300 } };
  const bound = nativeToolsClient({ windows: [window],
    trees: { 42: { AXRole: 'AXWindow', AXTitle: 'Draft', AXMinimized: false, AXFullScreen: false,
      pid: 321, frame: window.bounds } },
    localTools: { apps: [{ appId: window.bundleId, name: 'Editor', pid: 321 }], focusedWindowId: '42',
      spaceInventory: escapeSpaceFixture(),
      idle: 20, menuState: { selected: true, open: false }, afterEscape: false,
      lease: { token: 'owned', expires: Date.now() + 30000,
        window: { appId: window.bundleId, title: JSON.stringify(['42', 321, '100.25']), url: null } } } });
  t.after(() => bound.close());
  const escape = createMacDriverTools({ driver: bound }).stuckEscape({ env: {}, binding: () => window });
  assert.deepEqual(await escape.send({ appId: window.bundleId, title: 'Draft', url: null },
    { path: '/fixture/lease', token: 'owned' }, { since: 0, clock: () => 100 }), { posted: true, selected: false });
});

test('runtime Escape refuses a non-finite since before binding or driver access', async t => {
  const tools = createMacDriverTools({ driver: { ping: () => assert.fail('no ping'), request: () => assert.fail('no driver access') } });
  const escape = tools.stuckEscape({ binding: () => assert.fail('no binding'), env: {} });
  for (const since of [NaN, Infinity, -Infinity, undefined]) await t.test(String(since), async () => {
    assert.deepEqual(await escape.send({ appId: releaseWindow.bundleId }, {}, { since }),
      { posted: false, reason: 'result time unknown' });
  });
});

test('runtime Escape preserves the helper release outcome in its result and notice', async () => {
  const result = { ok: false, posted: true, released: false, releaseError: 'Escape release failed' };
  const tools = createMacDriverTools({ driver: { ping: async () => ({}), request: async method =>
    method === 'verifyWindowIdentity' ? { window: releaseWindow } : method === 'health' ? { hidIdleSeconds: 20 } : result } });
  const escape = tools.stuckEscape({ binding: () => releaseWindow, env: {} });
  const reply = await escape.send({ appId: releaseWindow.bundleId, title: 'Draft', url: null }, {}, { since: 0, clock: () => 100 });
  assert.equal(reply.posted, true); assert.equal(reply.released, false); assert.equal(reply.releaseError, result.releaseError);
  assert.equal(macDriverStuckEscapeNote(reply), result.releaseError);
});
