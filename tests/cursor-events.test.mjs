import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, chmodSync, mkdirSync, symlinkSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createCursorEvents, cursorRecord, createRendererSink } from '../plugins/sleight/lib/hand/events.mjs';
import { readHandConfig, handSetting, createHandSettingReader } from '../plugins/sleight/lib/hand/settings.mjs';
import { writeHandSetting } from '../plugins/sleight/lib/hand/command.mjs';
import { createRelayHand } from '../plugins/sleight/lib/hand/relay-hand.mjs';
import { createBrowserHand, workerHandClient } from '../plugins/sleight/lib/hand/browser-hand.mjs';
import { withCursorCall } from '../plugins/sleight/lib/hand/events.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { lstat } from 'node:fs/promises';
import { createConsentUi } from '../plugins/sleight/lib/direct-browser/consent-ui.mjs';
import { createV3Bridge, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const until = async fn => { const end = Date.now() + 2000; while (!fn()) { assert.ok(Date.now() < end, 'fixture state did not arrive'); await new Promise(r => setTimeout(r, 5)); } };
const world = t => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vc1-'))); chmodSync(dir, 0o700); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const frame = { kind: 'type', pid: 42, windowId: 7, at: [10, 20], path: [[10, 20]], beats: 8, delayMs: 0 };

test('real settings cache refreshes at 250 ms for absent, changed, replaced and unsafe files', t => {
  const path = join(world(t), 'hand.json'); let now = 0;
  const setting = createHandSettingReader({ path, env: {}, platform: 'darwin', now: () => now });
  assert.equal(setting().enabled, false);
  writeFileSync(path, JSON.stringify({ version: 1, enabled: true, stream: true }), { mode: 0o600 });
  now = 249; assert.equal(setting().enabled, false);
  now = 250; assert.equal(setting().stream, true);
  writeFileSync(path, JSON.stringify({ version: 1, enabled: false, stream: false }));
  now = 500; assert.equal(setting().stream, false);
  chmodSync(path, 0o644); now = 750; assert.equal(setting().reason, 'unsafe');
  rmSync(path); writeFileSync(path, JSON.stringify({ version: 1, enabled: true }), { mode: 0o600 });
  now = 1000; assert.equal(setting().enabled, true);
  now = 0; assert.equal(setting().enabled, true, 'clock reversal refreshes safely');
});

test('cursor settings are read at most once per 250 ms and off builds no action record', () => {
  let clock = 0, reads = 0, touched = 0;
  const events = createCursorEvents({ now: () => clock, setting: () => { reads++; return { stream: false }; } });
  const input = { get call() { touched++; throw Error('record built while off'); } };
  for (let i = 0; i < 1000; i++) { events.action(input); events.status('thinking'); void events.enabled; void events.labels; }
  assert.equal(reads, 1); assert.equal(touched, 0);
  clock = 250; events.status('thinking'); assert.equal(reads, 2); events.close();
});

test('throwing cursor projection preserves native and browser ghost hand frames', async () => {
  const { events } = capture(), nativeFrames = [], browserFrames = [];
  const record = () => { throw Error('cursor projection bug'); };
  const native = createRelayHand({ events, record, client: { enabled: true, send: f => nativeFrames.push(f), close() {} },
    setting: () => ({ enabled: true, stream: true }), locate: async () => geometry });
  native.admit(1, { code: 'await app.click([20,20])', screenshotSize: [500, 400] }); await settle();
  assert.equal(nativeFrames.length, 1); native.result(1, false); native.close();
  const browser = createBrowserHand({ events, record, client: { enabled: true, send: f => browserFrames.push(f), close() {} },
    setting: () => ({ enabled: true, stream: true }), locate: async () => geometry,
    readMetrics: async () => ({ screenX: 0, screenY: 0, outerWidth: 500, outerHeight: 400, innerWidth: 500, innerHeight: 400, dpr: 1, visible: true }) });
  browser.step({ op: 'click', locator: { boundingBox: async () => ({ x: 10, y: 10, width: 20, height: 20 }) } }); await settle();
  assert.equal(browserFrames.length, 1); browser.close(); events.close();
});

test('stream off constructs no browser cursor token or record', async () => {
  let records = 0, frames = 0;
  const hand = createBrowserHand({ record: () => { records++; throw Error('must stay off'); },
    setting: () => ({ enabled: true, stream: false }), client: { enabled: true, send() { frames++; }, close() {} },
    locate: async () => geometry, readMetrics: async () => ({ screenX: 0, screenY: 0, outerWidth: 500, outerHeight: 400, innerWidth: 500, innerHeight: 400, dpr: 1, visible: true }) });
  const token = hand.step({ op: 'click', locator: { boundingBox: async () => ({ x: 10, y: 10, width: 20, height: 20 }) } });
  assert.equal(token.cursor, undefined); hand.finish(token); await settle();
  assert.equal(records, 0); assert.equal(frames, 1); hand.close();
});

test('a throwing cursor enabled getter cannot stop native or browser hand dispatch', async () => {
  let frames = 0;
  const events = { get enabled() { throw Error('cursor state bug'); } };
  const client = { enabled: true, send() { frames++; }, close() {} };
  const setting = () => ({ enabled: true, stream: true });
  const native = createRelayHand({ events, client, setting, locate: async () => geometry });
  native.admit(1, { code: 'await app.click([20,20])', screenshotSize: [500, 400] }); await settle();
  native.result(1, false); assert.equal(frames, 1); native.close();
  const browser = createBrowserHand({ events, client, setting, locate: async () => geometry,
    readMetrics: async () => ({ screenX: 0, screenY: 0, outerWidth: 500, outerHeight: 400, innerWidth: 500, innerHeight: 400, dpr: 1, visible: true }) });
  browser.step({ op: 'click', locator: { boundingBox: async () => ({ x: 10, y: 10, width: 20, height: 20 }) } });
  await settle(); assert.equal(frames, 2); browser.close();
});

test('browser skipped ignores operations outside the input vocabulary', () => {
  const { out, events } = capture();
  const hand = createBrowserHand({ events, setting: () => ({ stream: true }), locate() {} });
  for (const op of ['wait', 'dialog', 'download', 'read', 'viewport']) hand.skipped({ op });
  assert.equal(out.length, 0); hand.skipped({ op: 'click' });
  assert.equal(out.at(-1).kind, 'click'); assert.equal(out.at(-1).phase, 'skipped'); hand.close(); events.close();
});

test('hide keeps a running native call until its real result and close invents no outcome', async () => {
  for (const early of [false, true]) {
    const { out, events } = capture(); let resolve;
    const hand = createRelayHand({ events, setting: () => ({ enabled: true, stream: true }),
      client: { enabled: true, send() {}, hide() {}, close() {} }, locate: () => new Promise(r => { resolve = r; }) });
    hand.admit(1, { code: 'await app.click([20,20])', screenshotSize: [500, 400] }); await settle();
    if (!early) { resolve(geometry); await settle(); }
    hand.hide(); const before = out.length;
    if (early) { resolve(geometry); await settle(); }
    assert.equal(out.length, before, 'hide and late geometry cannot invent skipped/failed');
    hand.result(1, false); assert.equal(out.at(-1).phase, 'done');
    hand.admit(2, { code: 'await app.click([20,20])', screenshotSize: [500, 400] });
    const closing = out.length; hand.close(); await settle(); assert.equal(out.length, closing); events.close();
  }
});

test('idle discovery finds a renderer without another action and replays session plus current status', async t => {
  const dir = world(t), received = [], clients = [];
  const sink = createRendererSink({ dir });
  const events = createCursorEvents({ sink, setting: () => ({ stream: true }) }); t.after(() => events.close());
  events.status('waiting', { app: 'Editor' }); await settle();
  const path = join(dir, 'late.sock');
  const server = net.createServer(c => { clients.push(c); c.on('data', d => received.push(d.toString())); });
  await new Promise(r => server.listen(path, r)); chmodSync(path, 0o600);
  t.after(() => { clients.forEach(c => c.destroy()); server.close(); });
  const deadline = Date.now() + 4000;
  while (!received.join('').includes('waiting')) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); }
  const lines = received.join('').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(e => [e.type, e.state]), [['session', 'start'], ['status', 'waiting']]);
  assert.ok(lines[0].seq < lines[1].seq);
});

test('discovery timer is unreferenced, exists only while enabled, and closes once', () => {
  let clock = 0, stream = false, timers = 0, cancelled = 0, unrefs = 0, tick;
  const timer = { unref() { unrefs++; } };
  const events = createCursorEvents({ now: () => clock, setting: () => ({ stream }), sink: { write() {}, refresh() {}, close() {} },
    repeat(fn, ms) { assert.equal(ms, 2000); tick = fn; timers++; return timer; },
    cancelRepeat(handle) { if (handle) { assert.equal(handle, timer); cancelled++; } } });
  assert.equal(timers, 0);
  clock = 250; stream = true; assert.equal(events.enabled, true); assert.equal(timers, 1); assert.equal(unrefs, 1);
  tick(); assert.equal(timers, 1);
  clock = 500; stream = false; tick(); assert.equal(cancelled, 1);
  clock = 750; stream = true; assert.equal(events.enabled, true); assert.equal(timers, 2);
  events.close(); events.close(); assert.equal(cancelled, 2);
});

test('local approval refusal is declined and never followed by failed or done', async t => {
  const { out, events } = capture();
  const h = relayFixture(t, { cursor: events, ask: async () => 'decline',
    localTools: { tools: [{ name: 'drag', inputSchema: { type: 'object' } }], call: async (_name, _args, approve) => {
      const allowed = await approve(['drag', 'Editor'], 'Fixture approval');
      assert.equal(allowed, false); return { content: [], isError: true };
    } } });
  h.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drag', arguments: { app: 'Editor' } } }); await settle();
  assert.deepEqual(out.filter(e => e.type === 'action').map(e => e.phase), ['act', 'declined']);
  h.relay.close();
});

test('discovery requires socket mode 0600 before and after connecting', async t => {
  const dir = world(t), path = join(dir, 'mode.sock');
  const server = net.createServer(); await new Promise(r => server.listen(path, r));
  t.after(() => server.close());
  for (const mode of [0o000, 0o400, 0o644, 0o660, 0o700, 0o1600, 0o2600, 0o4600]) {
    chmodSync(path, mode); let connections = 0;
    const sink = createRendererSink({ dir, connect() { connections++; throw Error('unsafe socket'); } });
    sink.write({}); await settle(); assert.equal(connections, 0, mode.toString(8)); sink.close();
  }
  chmodSync(path, 0o600);
  const socket = new EventEmitter(); let writes = 0, destroyed = false;
  Object.assign(socket, { write() { writes++; return true; }, destroy() { destroyed = true; }, resume() {}, unref() {} });
  const sink = createRendererSink({ dir, connect() { chmodSync(path, 0o644); queueMicrotask(() => socket.emit('connect')); return socket; } });
  t.after(() => sink.close()); sink.write({}); await until(() => destroyed); assert.equal(writes, 0);
});

test('a forked worker with hand on and no shared host keeps turbo alive and draws nothing', async t => {
  const path = join(world(t), 'hand.json');
  writeFileSync(path, JSON.stringify({ version: 1, enabled: true, stream: false }), { mode: 0o600 });
  let child; const frames = [];
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }), shareConsent: () => undefined,
    forkWorker(_path, args) {
      assert.ok(!args.includes('--shared-ui'));
      child = fork(new URL('./fixtures/cursor-no-shared-worker.mjs', import.meta.url), args,
        { env: { ...process.env, CURSOR_FIXTURE_SETTING: path }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      child.on('message', f => { if (f.hand) frames.push(f); }); return child;
    } });
  const exited = once(child, 'exit');
  try {
    await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'fixture-turn', text: 'Fixture action' });
    for (let i = 0; i < 2; i++) {
      const result = await bridge.call({ name: 'browser_read', arguments: { tab: 't1' } });
      assert.equal(result.isError, false, result.text);
      assert.deepEqual(JSON.parse(result.text), { reads: 0, boxes: 0, sharedUi: false });
      assert.equal(child.connected, true);
    }
    assert.equal(frames.length, 2, 'only the two deliberately stray frames, no generated host frames');
  } finally { await bridge.detach(); await exited; }
});

test('one session has a private random identity, monotonic sequence, flat allowlisted records and lifecycle', () => {
  const out = [], events = createCursorEvents({ onEvent: e => out.push(e), setting: () => ({ stream: true }), sink: { write() {}, close() {} }, now: () => 123, version: '1.5.1' });
  const call = events.call();
  events.action({ ...cursorRecord({ frame }), call, index: 0, phase: 'act', source: 'native', timing: 'scheduled', text: 'PRIVATE', url: 'PRIVATE' });
  events.status('done', { call, title: 'PRIVATE' }); events.close();
  assert.match(out[0].session, /^[a-f0-9]{32}$/); assert.match(call, /^[a-f0-9]{32}$/);
  assert.deepEqual(out.map(e => e.seq), [1, 2, 3, 4, 5]); assert.ok(out.every(e => e.v === 'sleight.cursor/1' && e.ts === 123 && e.session === out[0].session));
  assert.deepEqual(out.map(e => e.type), ['session', 'status', 'action', 'status', 'session']);
  assert.equal(out[0].state, 'start'); assert.equal(out.at(-1).state, 'end'); assert.ok(!JSON.stringify(out).includes('PRIVATE'));
});

test('privacy projects geometry and never copies input, values, URLs, titles or arbitrary nested keys', () => {
  const record = cursorRecord({ frame: { ...frame, text: 'SECRET' }, action: { role: 'AXButton', title: 'SECRET', value: 'SECRET' },
    geometry: { window: { pid: 42, windowId: 7, title: 'SECRET', bounds: { X: 0, Y: 1, Width: 20, Height: 30 } } }, labels: 'off' });
  assert.equal(record.label, undefined); assert.ok(!JSON.stringify(record).includes('SECRET'));
  assert.deepEqual(record.window, { id: 7, pid: 42, rect: [0, 1, 20, 30], exposure: 'exposed' });
  assert.deepEqual(record.point, frame.at); assert.equal(record.count, 8);
  const path = cursorRecord({ frame: { ...frame, kind: 'drag', path: Array.from({ length: 200 }, (_, i) => [i, i]) } }).path;
  assert.equal(path.length, 64); assert.deepEqual(path.at(-1), [199, 199]);
});

test('labels off omits the key, role uses a generic noun, title truncates to 40, content roles reveal no page text', () => {
  const action = { kind: 'click', role: 'AXButton', title: 'a'.repeat(60) };
  assert.ok(!Object.hasOwn(cursorRecord({ frame, action }), 'label'));
  assert.equal(cursorRecord({ frame, action, labels: 'role' }).label, 'button');
  assert.equal(cursorRecord({ frame, action, labels: 'title' }).label, 'a'.repeat(40));
  for (const title of ['https://private.example', '/Users/private/file', 'file:///private/a']) assert.ok(!cursorRecord({ frame, action: { ...action, title }, labels: 'title' }).label);
  assert.ok(!cursorRecord({ frame, action: { role: 'AXStaticText', title: 'page text' }, labels: 'title' }).label);
});

test('secure AX, password and explicit secure input suppress label and count and replace type by key', () => {
  for (const action of [{ role: 'AXSecureTextField', title: 'password' }, { inputType: 'password', role: 'textbox' }, { secure: true }]) {
    const record = cursorRecord({ frame, action, labels: 'title' });
    assert.equal(record.kind, 'key'); assert.ok(!Object.hasOwn(record, 'label')); assert.ok(!Object.hasOwn(record, 'count'));
  }
});

test('v1 settings extend the private file and toggles preserve stream and labels', t => {
  const dir = world(t), path = join(dir, 'hand.json');
  writeFileSync(path, JSON.stringify({ version: 1, enabled: false, stream: true, labels: 'role' }), { mode: 0o600 });
  assert.deepEqual(readHandConfig(path), { state: 'off', stream: true, labels: 'role' });
  assert.equal(handSetting({ path, env: {}, platform: 'darwin' }).stream, true);
  assert.equal(handSetting({ path, env: { SLEIGHT_HAND: '0' }, platform: 'darwin' }).stream, false);
  writeHandSetting({ enabled: true }, { path }); assert.equal(JSON.parse(readFileSync(path)).stream, true);
  for (const extra of [{ stream: 'true' }, { labels: 'all' }, { stream: null }]) {
    writeFileSync(path, JSON.stringify({ version: 1, enabled: true, ...extra })); assert.equal(readHandConfig(path).state, 'unsafe');
  }
  chmodSync(path, 0o644); assert.equal(readHandConfig(path).state, 'unsafe');
});

test('disabled stream and SLEIGHT_HAND=0 do no discovery or writes', () => {
  for (const options of [{ setting: () => ({ stream: false }) }, { setting: () => ({ stream: true }), env: { SLEIGHT_HAND: '0' } }]) {
    let writes = 0; const events = createCursorEvents({ ...options, sink: { write() { writes++; }, close() {} } });
    events.status('thinking'); events.close(); assert.equal(writes, 0);
  }
});

test('discovery accepts only own sockets in an own 0700 real directory and discards inbound bytes', async t => {
  const dir = world(t), received = [], clients = [];
  const server = net.createServer(c => { clients.push(c); c.on('data', d => received.push(d.toString())); c.write('untrusted'); });
  t.after(() => { clients.forEach(c => c.destroy()); server.close(); });
  const path = join(dir, 'renderer.sock'); await new Promise(r => server.listen(path, r)); chmodSync(path, 0o600);
  symlinkSync(path, join(dir, 'link.sock')); writeFileSync(join(dir, 'file.sock'), ''); mkdirSync(join(dir, 'dir.sock'));
  const sink = createRendererSink({ dir }); t.after(() => sink.close());
  sink.write({ type: 'status', state: 'idle' }); await until(() => sink.stats().connected === 1);
  sink.write({ type: 'status', state: 'done' }); await until(() => received.join('').includes('done'));
  assert.equal(clients.length, 1); assert.ok(received.join('').includes('done')); assert.equal(sink.stats().connected, 1);
  for (const bad of [0o755, 0o770, 0o1700]) { chmodSync(dir, bad); sink.refresh(); await until(() => sink.stats().connected === 0); }
});

test('sink rejects symlink directories and foreign directory/socket ownership', async t => {
  const dir = world(t), link = dir + '-link'; symlinkSync(dir, link); t.after(() => rmSync(link));
  for (const options of [{ dir: link }, { dir, uid: process.getuid() + 1 }]) {
    const sink = createRendererSink(options); sink.write({}); await settle(); assert.equal(sink.stats().connected, 0); sink.close();
  }
});

test('backpressure never queues over 256 events, counts drops and does not await drain', async t => {
  const dir = world(t), path = join(dir, 'slow.sock');
  const server = net.createServer(); await new Promise(r => server.listen(path, r)); chmodSync(path, 0o600); t.after(() => server.close());
  const sockets = [];
  const sink = createRendererSink({ dir, connect: () => { const s = new EventEmitter(); Object.assign(s, { write: () => false, destroy() {}, unref() {}, resume() {} }); sockets.push(s); queueMicrotask(() => s.emit('connect')); return s; } });
  t.after(() => sink.close()); sink.write({}); await until(() => sink.stats().connected === 1);
  for (let i = 0; i < 1000; i++) assert.equal(sink.write({ i }), undefined);
  assert.ok(sink.stats().queued <= 256); assert.ok(sink.stats().dropped >= 744);
  sockets[0].emit('error', Error('dead')); assert.equal(sink.stats().connected, 0);
});

const geometry = { ok: true, window: { pid: 42, windowId: 7, bounds: { X: 0, Y: 0, Width: 500, Height: 400 } },
  windows: [{ id: 7, pid: 42, bounds: { X: 0, Y: 0, Width: 500, Height: 400 } }], displays: [{ X: 0, Y: 0, Width: 1000, Height: 800 }],
  elements: { 1: { X: 10, Y: 10, Width: 20, Height: 20 } } };
const capture = () => { const out = []; const events = createCursorEvents({ onEvent: e => out.push(e), setting: () => ({ stream: true, labels: 'role' }), sink: { write() {}, close() {} } }); return { out, events }; };

test('native records share the host point, aim immediately after planning, act on schedule, result confirmed', async () => {
  const { out, events } = capture(), frames = [], timers = [];
  const hand = createRelayHand({ events, client: { enabled: true, send: f => frames.push(f), close() {} }, setting: () => ({ enabled: true, stream: true }),
    locate: async () => geometry, now: () => 0, schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel() {} });
  assert.equal(hand.admit('MCP-PRIVATE', { code: 'await app.click(1)', lines: { 1: 'button Description: Save' }, screenshotSize: [500, 400], target: { app: 'Editor', title: 'PRIVATE' } }), undefined);
  assert.deepEqual(out.filter(e => e.type === 'action').map(e => e.phase), ['aim'], 'admission publishes aim before any deferred lookup');
  await settle();
  assert.deepEqual(out.filter(e => e.type === 'action').map(e => e.phase), ['aim', 'aim']); assert.equal(timers[0].ms, 470);
  timers[0].fn(); hand.result('MCP-PRIVATE', false);
  const actions = out.filter(e => e.type === 'action'); assert.deepEqual(actions.map(e => e.phase), ['aim', 'aim', 'act', 'done']);
  assert.deepEqual(actions.map(e => e.timing), ['scheduled', 'scheduled', 'scheduled', 'confirmed']); assert.ok(actions.slice(1).every(e => JSON.stringify(e.point) === JSON.stringify(frames[0].at)));
  assert.ok(!JSON.stringify(out).includes('PRIVATE')); assert.equal(new Set(actions.map(e => e.call)).size, 1); hand.close(); events.close();
});

test('native failures, declined approvals, cover and unknown plans emit explicit terminal events', async () => {
  for (const mode of ['failed', 'declined', 'covered', 'no-geometry', 'not-found', 'unplanned']) {
    const { out, events } = capture();
    const hand = createRelayHand({ events, client: { enabled: true, send() {}, hide() {}, close() {} }, setting: () => ({ enabled: true, stream: true }),
      locate: async () => mode === 'covered' ? { ...geometry, state: 'covered' } : mode === 'no-geometry' ? undefined : mode === 'not-found' ? { ...geometry, elements: {} } : geometry });
    hand.admit(9, { code: mode === 'unplanned' ? 'for (let i = 0; i < 2; i++) await app.click(1)' : mode === 'not-found' ? 'await app.click(1)' : 'await app.click([20,20])', lines: { 1: 'button Description: Save' }, screenshotSize: [500, 400] }); await settle();
    if (mode === 'declined') { hand.approval(10, { tool_name: 'click' }); hand.answered(10, 'decline'); }
    else hand.result(9, mode === 'failed');
    const actions = out.filter(e => e.type === 'action'); assert.ok(actions.length);
    if (['covered', 'no-geometry', 'not-found', 'unplanned'].includes(mode)) {
      assert.equal(actions.at(-1).phase, 'skipped'); assert.equal(actions.at(-1).reason, mode);
      const skip = actions.findIndex(e => e.phase === 'skipped'); assert.equal(skip, actions.length - 1, 'nothing follows a skipped action');
    }
    else assert.equal(actions.at(-1).phase, mode);
    if (mode === 'declined') assert.ok(out.some(e => e.state === 'waiting'));
    hand.close(); events.close();
  }
});

test('turbo and Electron publish shared per-call indices, confirmed outcomes, password redaction and hidden skips', async () => {
  const { out, events } = capture(), frames = [];
  const hand = createBrowserHand({ events, client: { enabled: true, send: f => frames.push(f), close() {} }, setting: () => ({ enabled: true, stream: true }), locate: async () => geometry,
    readMetrics: async page => ({ screenX: 0, screenY: 0, outerWidth: 500, outerHeight: 400, innerWidth: 500, innerHeight: 400, dpr: 1, visible: page !== 'hidden', focusOnBody: false }) });
  for (const source of ['turbo', 'electron']) await withCursorCall(source, async () => {
    const a = hand.step({ op: 'type', page: {}, locator: { boundingBox: async () => ({ x: 1, y: 2, width: 10, height: 10 }) }, text: 'SECRET', role: 'textbox', inputType: 'password' });
    hand.finish(a, false);
    const b = hand.step({ op: 'select', page: 'hidden', locator: {} }); hand.finish(b, true);
    await settle();
  }, true);
  const actions = out.filter(e => e.type === 'action');
  for (const source of ['turbo', 'electron']) {
    const a = actions.filter(e => e.source === source); assert.deepEqual(a.map(e => e.phase), ['aim', 'act', 'done', 'skipped']);
    assert.deepEqual(a.map(e => e.index), [0, 0, 0, 1]); assert.equal(new Set(a.map(e => e.call)).size, 1);
    assert.ok(a.every(e => e.timing === 'confirmed')); assert.equal(a[0].kind, 'key'); assert.ok(!Object.hasOwn(a[0], 'count'));
  }
  assert.ok(!JSON.stringify(out).includes('SECRET')); assert.equal(frames.length, 2); hand.close(); events.close();
});

function relayFixture(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], replies = [];
  serverIn.on('data', d => { for (const line of d.toString().trim().split('\n')) sent.push(JSON.parse(line)); });
  clientOut.on('data', d => { for (const line of d.toString().trim().split('\n')) replies.push(JSON.parse(line)); });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'PRIVATE-CLAUDE-SESSION', changeReview: false, ...options });
  t.after(() => relay.dispose());
  return { relay, sent, replies, request: msg => clientIn.write(JSON.stringify(msg) + '\n'), response: msg => serverOut.write(JSON.stringify(msg) + '\n') };
}

test('relay local hover and drag emit confirmed start/results, turn end marks done/idle and close ends session', async t => {
  const { out, events } = capture();
  const h = relayFixture(t, { cursor: events, localTools: { tools: ['drag', 'hover'].map(name => ({ name, inputSchema: { type: 'object' } })), call: async name => ({ content: [], isError: name === 'hover' }) } });
  for (const [id, name] of [[1, 'drag'], [2, 'hover']]) {
    h.request({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { app: 'Editor', from: [1, 1], to: [2, 2] } } }); await settle();
  }
  const actions = out.filter(e => e.type === 'action'); assert.deepEqual(actions.map(e => [e.kind, e.phase]), [['drag', 'act'], ['drag', 'done'], ['move', 'act'], ['move', 'failed']]);
  assert.ok(actions.every(e => e.source === 'local' && e.timing === 'confirmed')); assert.equal(new Set(actions.map(e => e.call)).size, 2);
  h.request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'turn_ended', arguments: {} } }); await settle();
  assert.ok(out.some(e => e.state === 'idle')); h.relay.close(); assert.equal(out.at(-1).state, 'end');
  assert.ok(!JSON.stringify(out).includes('PRIVATE'));
});

test('native stream stays usable with drawing disabled and late geometry emits no act after terminal result', async () => {
  const { out, events } = capture(); let resolve;
  const hand = createRelayHand({ events, setting: () => ({ enabled: false, stream: true }), locate: () => new Promise(r => { resolve = r; }),
    loadClient: () => { throw Error('stream must not load the drawing host'); } });
  hand.admit(1, { code: 'await app.typeText("SECRET")', screenshotSize: [500, 400] }); await settle(); hand.result(1, false);
  assert.deepEqual(out.filter(e => e.type === 'action').map(e => e.phase), ['aim', 'done'], 'call result confirms even before geometry');
  resolve({ ...geometry, focused: { inWindow: true, frame: { X: 1, Y: 2, Width: 10, Height: 10 }, role: 'AXSecureTextField' } }); await settle();
  const actions = out.filter(e => e.type === 'action'); assert.deepEqual(actions.map(e => e.phase), ['aim', 'done']);
  assert.ok(actions.every(e => e.kind === 'key' && !Object.hasOwn(e, 'count') && !Object.hasOwn(e, 'label')));
  hand.close(); events.close();
});

test('admission remains synchronous with two renderer sockets connected, measured against hand off and hand only', async t => {
  const dir = world(t), clients = [], servers = [];
  for (let i = 0; i < 2; i++) {
    const server = net.createServer(c => { clients.push(c); c.resume(); }); servers.push(server);
    await new Promise(r => server.listen(join(dir, i + '.sock'), r)); chmodSync(join(dir, i + '.sock'), 0o600);
  }
  t.after(() => { clients.forEach(c => c.destroy()); servers.forEach(s => s.close()); });
  const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const tree = 'Window: "Editor", App: Editor.\n0 standard window Editor\n\t1 button Description: Save, ID: Save';
  const png = Buffer.alloc(33); png.writeUInt32BE(0x89504e47); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(500, 16); png.writeUInt32BE(400, 20);
  async function measure(mode) {
    let frames = 0, count = 0;
    const sink = mode === 'stream' ? createRendererSink({ dir }) : { write() {}, close() {} };
    const path = join(world(t), 'hand.json');
    if (mode !== 'off') writeFileSync(path, JSON.stringify({ version: 1, enabled: true, stream: mode === 'stream' }), { mode: 0o600 });
    const setting = createHandSettingReader({ path, env: {}, platform: 'darwin' });
    const events = createCursorEvents({ setting, sink, onEvent: () => count++ });
    if (mode === 'stream') { events.status('idle'); await until(() => sink.stats().connected === 2); }
    const hand = mode === 'off' ? undefined : createRelayHand({ events, now: () => 0, setting,
      client: { enabled: true, send() { frames++; }, close() {} }, locate: async () => geometry });
    const h = relayFixture(t, { hand, cursor: events });
    const request = (id, code) => h.request({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
    const response = id => h.response({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: tree }] } });
    request(1, 'let app = await cua.getApp("Editor")'); await settle();
    h.response({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: tree }, { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] } }); await settle();
    const samples = [];
    for (let i = 0; i < 350; i++) {
      const id = i + 100, start = performance.now(); request(id, 'await app.click([20,20])');
      assert.equal(h.sent.at(-1)?.id, id, 'engine dispatch needs no event loop tick');
      const elapsed = performance.now() - start;
      if (i >= 50) samples.push(elapsed);
      response(id); await settle();
    }
    const connected = mode === 'stream' ? sink.stats().connected : 0;
    h.relay.close();
    return { medianMs: median(samples), frames, events: count, connected, samples: samples.length };
  }
  const off = await measure('off'), hand = await measure('hand'), stream = await measure('stream');
  t.diagnostic(JSON.stringify({ admission: { off, hand, stream } }));
  assert.equal(stream.connected, 2); assert.ok(stream.frames >= 300 && stream.events >= 600);
  assert.ok(stream.medianMs - hand.medianMs < 0.25, 'stream admission adds less than 0.25 ms');
});

test('writers reject invalid enum values and omit unknown nested and top-level fields', () => {
  const { out, events } = capture(), call = events.call();
  const valid = { call, index: 1, kind: 'drag', phase: 'act', source: 'electron', timing: 'scheduled', point: [1, 2],
    path: [[1, 2], [3, 4]], window: { id: 7, pid: 42, title: 'SECRET', url: 'SECRET', app: 'Editor', exposure: 'covered', rect: [0, 0, 5, 5] },
    display: { id: 1, scale: 2, url: 'SECRET' }, reason: 'SECRET', text: 'SECRET' };
  events.action(valid);
  const record = out.find(e => e.type === 'action'); assert.equal(record.timing, 'confirmed'); assert.ok(!JSON.stringify(out).includes('SECRET'));
  assert.deepEqual(record.display, { id: 1, scale: 2 }); assert.equal(record.window.exposure, 'covered'); assert.ok(!Object.hasOwn(record, 'reason'));
  for (const bad of [{ kind: 'read' }, { source: 'remote' }, { phase: 'approved' }, { call: 'MCP-1' }, { index: -1 }]) events.action({ ...valid, ...bad });
  events.status('unknown'); assert.equal(out.length, 3); events.close();
});

test('discovery refuses a foreign socket within an otherwise safe user-owned directory', async t => {
  const dir = world(t), path = join(dir, 'foreign.sock');
  const server = net.createServer(); await new Promise(r => server.listen(path, r)); chmodSync(path, 0o600); t.after(() => server.close());
  let inspected = false, connections = 0;
  const sink = createRendererSink({ dir, inspect: async file => {
    const stat = await lstat(file); if (file !== path) return stat;
    inspected = true; return { ...stat, uid: process.getuid() + 1, isSocket: () => true, isSymbolicLink: () => false };
  }, connect: () => { connections++; throw Error('must not connect'); } });
  t.after(() => sink.close()); sink.write({}); await until(() => inspected); assert.equal(connections, 0);
});

test('a dead renderer reconnects only after 2 seconds and receives the original session start first', async t => {
  const dir = world(t), path = join(dir, 'again.sock');
  const server = net.createServer(); await new Promise(r => server.listen(path, r)); chmodSync(path, 0o600); t.after(() => server.close());
  let clock = 0; const sockets = [], lines = [];
  const sink = createRendererSink({ dir, now: () => clock, connect: () => {
    const socket = new EventEmitter(); Object.assign(socket, { write: line => { lines.push(JSON.parse(line)); return true; }, destroy() {}, resume() {}, unref() {} });
    sockets.push(socket); queueMicrotask(() => socket.emit('connect')); return socket;
  } });
  t.after(() => sink.close());
  const start = { v: 'sleight.cursor/1', type: 'session', state: 'start', session: 'a'.repeat(32), seq: 1 };
  sink.write(start); await until(() => sink.stats().connected === 1); assert.deepEqual(lines[0], start);
  sockets[0].emit('error', Error('dead')); clock = 1999; sink.write({ seq: 2 }); await settle(); assert.equal(sockets.length, 1);
  clock = 2000; sink.write({ seq: 3 }); await until(() => sink.stats().connected === 1); assert.equal(sockets.length, 2); assert.deepEqual(lines.at(-1), start);
});

test('the 256-event bound includes socket writes whose callbacks have not completed', async t => {
  const dir = world(t), path = join(dir, 'buffer.sock');
  const server = net.createServer(); await new Promise(r => server.listen(path, r)); chmodSync(path, 0o600); t.after(() => server.close());
  let writes = 0;
  const sink = createRendererSink({ dir, connect: () => {
    const socket = new EventEmitter(); Object.assign(socket, { write: () => { writes++; return true; }, destroy() {}, resume() {}, unref() {} });
    queueMicrotask(() => socket.emit('connect')); return socket;
  } });
  t.after(() => sink.close()); sink.write({}); await until(() => sink.stats().connected === 1);
  for (let i = 0; i < 1000; i++) sink.write({ i });
  assert.equal(writes, 256); assert.equal(sink.stats().queued, 256); assert.equal(sink.stats().dropped, 744);
});

test('secure native element roles redact setValue, paste and typeText in every action phase', async () => {
  const { out, events } = capture();
  const hand = createRelayHand({ events, client: { enabled: true, send() {}, close() {} }, setting: () => ({ enabled: true, stream: true }), locate: async () => geometry });
  hand.admit(1, { code: 'await app.setValue(1,"SECRET"); await app.paste("SECRET"); await app.typeText("SECRET")',
    lines: { 1: 'secure text field Description: Password, ID: password' }, screenshotSize: [500, 400] });
  await settle(); hand.result(1, false);
  const actions = out.filter(e => e.type === 'action'); assert.ok(actions.length >= 6);
  assert.ok(actions.every(e => e.kind === 'key' && !Object.hasOwn(e, 'label') && !Object.hasOwn(e, 'count'))); assert.ok(!JSON.stringify(out).includes('SECRET'));
  hand.close(); events.close();
});

test('consent presentation publishes waiting without any page, payment or app-document data', () => {
  const seen = [], ui = createConsentUi({ authenticate: () => true, present() {}, checkCurrent: () => true, cursorStatus: (...args) => seen.push(args) });
  const operation = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'session', turn: 'turn', leaseGeneration: 1, target: 'target', frame: 'frame', document: 'doc',
    sequence: 1, origin: 'https://fixture.invalid', action: 'click', args: {}, destination: 'https://fixture.invalid/private', payment: { secret: 'SECRET' } };
  ui.request(operation, { label: 'SECRET' }); assert.deepEqual(seen, [['waiting']]);
});

test('worker IPC merges turbo and Electron events into the relay session with unchanged hand frames', async () => {
  const { out, events } = capture(), frames = [], child = new EventEmitter(), endpoint = new EventEmitter();
  child.connected = endpoint.connected = true;
  child.send = frame => queueMicrotask(() => endpoint.emit('message', structuredClone(frame)));
  endpoint.send = frame => queueMicrotask(() => child.emit('message', structuredClone(frame)));
  child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); }; child.unref = () => {};
  const worker = serveV3Worker({ channel: endpoint, browser: 'bfixture', begin: async () => ({ call: async () => ({ text: 'fixture', isError: false }), delivered: () => true, end: async () => ({ revoked: true, cleanup: [] }) }) });
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }), cursorEvents: events,
    shareConsent: () => ({ send: f => frames.push(f), release() {}, pid: 42, detached() {} }), forkWorker: () => { queueMicrotask(() => worker.ready()); return child; } });
  try {
    for (const source of ['turbo', 'electron']) endpoint.send({ version: 3, cursor: { call: events.call(), index: 0, kind: 'click', source, phase: 'act', point: [1, 2], label: 'SECRET', text: 'SECRET' } });
    endpoint.send({ version: 3, hand: frame }); endpoint.send({ version: 3, cursorStatus: { state: 'waiting', title: 'SECRET' } }); await settle();
    assert.deepEqual(out.filter(e => e.type === 'action').map(e => e.source), ['turbo', 'electron']);
    assert.equal(new Set(out.map(e => e.session)).size, 1); assert.deepEqual(frames, [frame]); assert.ok(!JSON.stringify(out).includes('SECRET'));
  } finally { await bridge.detach(); events.close(); }
});

test('a browser stream can publish with drawing disabled without loading the host client', async () => {
  const { out, events } = capture();
  const hand = createBrowserHand({ events, setting: () => ({ enabled: false, stream: true }),
    loadClient: () => { throw Error('drawing host must not load'); }, locate: async () => geometry,
    readMetrics: async () => ({ screenX: 0, screenY: 0, outerWidth: 500, outerHeight: 400, innerWidth: 500, innerHeight: 400, dpr: 1, visible: true }) });
  const token = hand.step({ op: 'click', page: {}, locator: { boundingBox: async () => ({ x: 5, y: 5, width: 10, height: 10 }) } }); hand.finish(token); await settle();
  assert.deepEqual(out.filter(e => e.type === 'action').map(e => e.phase), ['aim', 'act', 'done']);
  hand.close(); events.close();
});

test('the stream directory environment override routes only to an owned temporary fixture', async t => {
  const dir = world(t), received = [], clients = [];
  const server = net.createServer(c => { clients.push(c); c.on('data', data => received.push(data.toString())); });
  await new Promise(r => server.listen(join(dir, 'fixture.sock'), r)); chmodSync(join(dir, 'fixture.sock'), 0o600); t.after(() => { clients.forEach(c => c.destroy()); server.close(); });
  const events = createCursorEvents({ env: { SLEIGHT_CURSOR_STREAM_DIR: dir }, setting: () => ({ stream: true }) }); t.after(() => events.close());
  events.status('idle'); await until(() => received.join('').includes('"state":"start"'));
  events.status('thinking'); await until(() => received.join('').includes('"state":"thinking"'));
  const lines = received.join('').trim().split('\n').map(JSON.parse); assert.ok(lines.every(e => e.v === 'sleight.cursor/1'));
});
