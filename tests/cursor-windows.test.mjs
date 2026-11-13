import { assertChildStatus } from './fixtures/child-status.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { createRendererSink, cursorRecord, createCursorEvents } from '../plugins/sleight/lib/hand/events.mjs';
import * as windows from '../plugins/sleight/lib/hand/windows-transport.mjs';
import { createCursorListener, parseEvent } from '../examples/cursor-renderer/listen.mjs';
import { replayFile } from '../examples/cursor-renderer/replay.mjs';

const sid = 'S-1-5-21-100-200-300-1001';
const pipe = '\\\\.\\pipe\\sleight-cursor-S-1-5-21-100-200-300-1001-ring';
const event = { v: 'sleight.cursor/1', seq: 1, ts: 100, session: 'a'.repeat(32), type: 'action',
  call: 'b'.repeat(32), index: 0, kind: 'click', phase: 'aim', source: 'turbo', timing: 'confirmed', point: [-1200, 450] };
async function until(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('fixture deadline');
}
function socket({ pressure = false, stalled = false } = {}) {
  const s = new EventEmitter();
  Object.assign(s, { lines: [], destroyed: false, unref() {}, resume() {}, end() { this.destroy(); },
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } },
    write(line, cb) { this.lines.push(line); if (!stalled) queueMicrotask(() => cb?.()); return !pressure; } });
  return s;
}
function security() {
  const records = new Map();
  return { records, sid: async () => sid, prepare: async () => {},
    list: async () => [...records.values()], seal: async () => true,
    verify: async entry => records.get(entry.name)?.token === entry.token,
    publish: async entry => { records.set(entry.name, entry); return true; },
    remove: async entry => { if (records.get(entry.name)?.token === entry.token) records.delete(entry.name); } };
}
function platform() {
  const native = security();
  native.records.set('ring', { name: 'ring', sid, pipe, pid: 42, token: 'c'.repeat(32) });
  return { native, transport: windows.createWindowsTransport({ security: native }) };
}

test('Windows pipe names bind a validated SID and renderer name, with a current-user-only protected DACL', () => {
  assert.equal(windows.pipeName(sid, 'ring'), pipe);
  assert.equal(windows.pipeName('S-1-12-1-10-20-30-40', 'entra'), '\\\\.\\pipe\\sleight-cursor-S-1-12-1-10-20-30-40-entra');
  assert.equal(windows.pipeSecurityDescriptor(sid), `O:${sid}D:P(A;;GA;;;${sid})`);
  for (const bad of ['S-1-1-0', sid + '\\evil', '', 'S-1-5-21-01-2-3-4']) assert.throws(() => windows.pipeName(bad, 'ring'));
  for (const bad of ['../ring', 'a\\b', '', 'x'.repeat(33), 'ring.sock']) assert.throws(() => windows.pipeName(sid, bad));
});

function helperRun(calls, response = request => ({ id: request.id, ok: true, result: true })) {
  return (executable, args, options) => {
    const child = new EventEmitter(), call = { executable, args, options, requests: [], killed: false };
    calls.push(call);
    child.stdout = new PassThrough();
    queueMicrotask(() => child.stdout.write(JSON.stringify({ ready: true }) + '\n'));
    child.stdin = new Writable({ write(data, encoding, done) {
      const request = JSON.parse(data.toString()); call.requests.push(request);
      const reply = response(request);
      if (reply !== undefined) queueMicrotask(() => child.stdout.write(typeof reply === 'string' ? reply + '\n' : JSON.stringify(reply) + '\n'));
      done();
    } });
    child.kill = () => { call.killed = true; }; child.unref = () => {};
    return child;
  };
}

test('Windows security uses one encoded worker for repeated checks, with caller data only on stdin', async () => {
  const calls = [];
  const adapter = windows.createWindowsSecurity({ platform: 'win32', testEnv: { SystemRoot: 'C:\\Windows', NODE_OPTIONS: 'bad' }, run: helperRun(calls) });
  const entry = { name: "'; Write-Output stolen; '" };
  assert.equal(await adapter.verify(entry), true);
  assert.equal(await adapter.verify(entry), true);
  assert.equal(await adapter.sid(), true); assert.equal(await adapter.sid(), true);
  assert.equal(calls.length, 1); assert.equal(calls[0].requests.length, 3);
  assert.equal(calls[0].executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(calls[0].args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.match(Buffer.from(calls[0].args[4], 'base64').toString('utf16le'), /CursorPipeSecurity/);
  assert.doesNotMatch(calls[0].args.join(' '), /Write-Output stolen|ExecutionPolicy|Bypass|Unrestricted|\s-File\s/);
  assert.deepEqual(calls[0].requests[0].entry, entry);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.env.NODE_OPTIONS, undefined);
  assert.ok(calls[0].args.join(' ').length + calls[0].executable.length < 32000);
});

test('Windows security ignores inherited SystemRoot when launching PowerShell', () => {
  const module = new URL('../plugins/sleight/lib/hand/windows-transport.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { EventEmitter } from 'node:events';
    import { PassThrough, Writable } from 'node:stream';
    const inspected = [];
    fs.lstatSync = folder => {
      inspected.push(folder);
      assert.ok(['C:\\\\Windows', 'C:\\\\Windows\\\\System32'].includes(folder));
      return { isDirectory: () => true, isSymbolicLink: () => false };
    };
    fs.realpathSync.native = folder => folder;
    syncBuiltinESMExports();
    const { createWindowsSecurity } = await import(${JSON.stringify(module)});
    const calls = [];
    const adapter = createWindowsSecurity({ platform: 'win32', run: (${helperRun.toString()})(calls) });
    assert.equal(await adapter.verify({}), true);
    assert.deepEqual(inspected, ['C:\\\\Windows', 'C:\\\\Windows\\\\System32']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, 'C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe');
    assert.deepEqual(calls[0].options.env, { SystemRoot: 'C:\\\\Windows', PATH: 'C:\\\\Windows\\\\System32;C:\\\\Windows' });
  `], { encoding: 'utf8', env: { ...process.env, SystemRoot: 'C:\\evil', SYSTEMROOT: 'C:\\evil',
    TEMP: 'C:\\evil', TMP: 'C:\\evil', LOCALAPPDATA: 'C:\\evil', APPDATA: 'C:\\evil' }, timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
});

test('Windows security rejects malformed replies and restarts after a deadline', async () => {
  const malformed = []; let now = 0;
  const adapter = windows.createWindowsSecurity({ now: () => now, platform: 'win32', testEnv: { SystemRoot: 'C:\\Windows' }, run: helperRun(malformed, () => 'invalid') });
  await assert.rejects(adapter.verify({}), /Invalid Windows cursor security response/);
  assert.equal(malformed[0].killed, true);
  const calls = []; let stall = true;
  const timed = windows.createWindowsSecurity({ now: () => now, platform: 'win32', testEnv: { SystemRoot: 'C:\\Windows' },
    run: helperRun(calls, request => stall ? undefined : { id: request.id, ok: true, result: true }) });
  await assert.rejects(timed.verify({}, { timeoutMs: 15 }), /deadline/);
  assert.equal(calls[0].killed, true);
  now = 1000; stall = false; assert.equal(await timed.verify({}), true); assert.equal(calls.length, 2);
});

test('physical pixels map to monitor-local DIPs without scaling the global origin', () => {
  assert.deepEqual(windows.monitorPoint([-1200, 450], { origin: [-1920, 0], scale: 1.5 }), [480, 300]);
  assert.deepEqual(windows.monitorPoint([600, -900], { origin: [0, -1440], scale: 2 }), [300, 270]);
  assert.throws(() => windows.monitorPoint([1, 2], { origin: [0, 0], scale: 0 }));
});

test('Windows app projection emits only the executable basename and additive AppUserModelID', () => {
  const out = cursorRecord({ platform: 'win32', frame: { windowId: 9, pid: 42 },
    target: { exePath: 'C:\\private\\Apps\\notepad.exe', appUserModelId: 'Microsoft.Notepad_abc!App', appId: 'private-path' } });
  assert.deepEqual(out.window, { id: 9, pid: 42, app: 'notepad.exe', appUserModelId: 'Microsoft.Notepad_abc!App', exposure: 'exposed' });
  assert.doesNotMatch(JSON.stringify(out), /private|bundle/);
  const parsed = parseEvent(JSON.stringify({ ...event, ...out }));
  assert.equal(parsed.window.appUserModelId, 'Microsoft.Notepad_abc!App');
});

test('Windows discovery rejects foreign SIDs, forged pipe names and failed ACL attestations', async () => {
  const { native, transport } = platform();
  native.records.set('foreign', { name: 'foreign', sid: 'S-1-5-21-1-2-3-4', pipe, pid: 42, token: 'd'.repeat(32) });
  native.records.set('forged', { name: 'forged', sid, pipe: '\\\\.\\pipe\\elsewhere', pid: 42, token: 'e'.repeat(32) });
  native.records.set('bad', { name: 'bad', sid, pipe: windows.pipeName(sid, 'bad'), pid: 42, token: 'f'.repeat(32) });
  native.verify = async e => e.name !== 'bad';
  assert.deepEqual((await transport.discover()).map(e => e.path), [pipe]);
});

test('win32 sink uses pipes, replays start before status and bounds stalled writes at 256', async t => {
  const { transport } = platform(), sockets = [];
  const sink = createRendererSink({ platform: 'win32', windows: transport, connect(path) {
    assert.equal(path, pipe); const s = socket({ pressure: true, stalled: true }); sockets.push(s);
    queueMicrotask(() => s.emit('connect')); return s;
  } });
  t.after(() => sink.close());
  sink.write({ ...event, type: 'session', state: 'start' });
  sink.write({ ...event, seq: 2, type: 'status', state: 'waiting' });
  await until(() => sink.stats().connected === 1);
  for (let i = 0; i < 1000; i++) assert.equal(sink.write({ ...event, seq: i + 3 }), undefined);
  assert.equal(sink.stats().queued, 256);
  assert.equal(sink.stats().dropped, 746);
  assert.equal(JSON.parse(sockets[0].lines[0]).state, 'start');
  sockets[0].emit('error', Error('pipe gone'));
  assert.equal(sink.stats().connected, 0);
});

test('Windows sink revalidates the connected pipe and sends no replay when the registry changes', async t => {
  const { native, transport } = platform(); let s;
  const sink = createRendererSink({ platform: 'win32', windows: transport, connect() {
    s = socket(); native.records.get('ring').token = 'd'.repeat(32);
    queueMicrotask(() => s.emit('connect')); return s;
  } });
  t.after(() => sink.close()); sink.write(event);
  await until(() => s?.destroyed);
  assert.deepEqual(s.lines, []);
});

test('Windows listener binds without public access flags and publishes only after sealing', async t => {
  const native = security(), steps = []; let accept, server;
  native.seal = async entry => { assert.equal(entry.pipe, pipe); assert.equal(entry.sddl, `O:${sid}D:P(A;;GA;;;${sid})`); steps.push('seal'); return true; };
  const publish = native.publish; native.publish = async e => { steps.push('publish'); return publish(e); };
  const net = { createServer(cb) {
    accept = cb; server = new EventEmitter();
    Object.assign(server, { listen(options) { assert.deepEqual(options, { path: pipe, readableAll: false, writableAll: false }); steps.push('bind'); queueMicrotask(() => server.emit('listening')); }, close(cb) { cb?.(); } });
    return server;
  } };
  const dir = registerTemp(t, await mkdtemp(join(tmpdir(), 'cursor-win-')));
  const seen = [], listener = await createCursorListener({ dir, platform: 'win32', windows: windows.createWindowsTransport({ security: native }), net,
    name: 'ring', onEvent: e => seen.push(e) });
  t.after(() => listener.close());
  assert.deepEqual(steps, ['bind', 'seal', 'publish']);
  const s = socket(); accept(s); s.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  assert.equal(seen.length, 1);
  await listener.close(); assert.equal(native.records.size, 0);
});

test('Windows replay discovers and revalidates named pipes, preserving raw JSON and timestamp gaps', async t => {
  const dir = registerTemp(t, await mkdtemp(join(tmpdir(), 'cursor-win-'))), file = join(dir, 'input.jsonl');
  const raw = JSON.stringify(event).replaceAll(':', ': '), gaps = [];
  await writeFile(file, raw + '\n' + JSON.stringify({ ...event, seq: 2, ts: 180 }) + '\n');
  const { transport } = platform(), s = socket();
  const result = await replayFile({ file, platform: 'win32', windows: transport,
    net: { createConnection(path) { assert.equal(path, pipe); queueMicrotask(() => s.emit('connect')); return s; } },
    speed: 4, sleep: async ms => gaps.push(ms) });
  assert.deepEqual(result, { events: 2, renderers: 1 });
  assert.deepEqual(gaps, [20]); assert.equal(s.lines[0], raw + '\n');
});

test('Windows sink drains in order, counts writes awaiting callbacks and retries dead pipes after two seconds', async t => {
  const { transport } = platform(), sockets = []; let now = 0;
  const sink = createRendererSink({ platform: 'win32', windows: transport, now: () => now,
    connect() { const s = socket({ pressure: true }); sockets.push(s); queueMicrotask(() => s.emit('connect')); return s; } });
  t.after(() => sink.close()); sink.write({ ...event, type: 'session', state: 'start' });
  await until(() => sink.stats().connected === 1);
  sink.write({ ...event, seq: 2 }); sink.write({ ...event, seq: 3 });
  sockets[0].emit('drain'); await until(() => sockets[0].lines.length === 2);
  sockets[0].emit('drain'); await until(() => sockets[0].lines.length === 3);
  assert.deepEqual(sockets[0].lines.map(s => JSON.parse(s).seq), [1, 2, 3]);
  sockets[0].emit('error', Error('disconnect'));
  now = 1999; sink.write({ ...event, seq: 4 }); await new Promise(r => setImmediate(r)); assert.equal(sockets.length, 1);
  now = 2000; sink.write({ ...event, seq: 5 }); await until(() => sockets.length === 2 && sink.stats().connected === 1);
  assert.equal(JSON.parse(sockets[1].lines[0]).state, 'start');
});

test('Windows discovery failure keeps connected peers and cannot throw from a sink write', async t => {
  const { native, transport } = platform(); let s;
  const sink = createRendererSink({ platform: 'win32', windows: transport,
    connect() { s = socket(); queueMicrotask(() => s.emit('connect')); return s; },
    inspect() { assert.fail('Windows must not use Unix ownership checks'); } });
  t.after(() => sink.close()); sink.write(event); await until(() => sink.stats().connected === 1);
  native.list = async () => { throw Error('registry refused'); };
  let scanned = false;
  native.list = async () => { scanned = true; throw Error('registry refused'); };
  assert.doesNotThrow(() => sink.refresh()); await until(() => scanned);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.destroyed, false); assert.equal(sink.stats().connected, 1);
  sink.write({ ...event, seq: 2 }); assert.equal(s.lines.length, 1);
});

test('Windows listener refuses failed sealing without publishing or unlinking a pipe', async () => {
  const native = security(); let closed = false;
  native.seal = async () => false;
  const server = new EventEmitter();
  Object.assign(server, { listen() { queueMicrotask(() => this.emit('listening')); }, close() { closed = true; } });
  await assert.rejects(windows.createWindowsTransport({ security: native }).listen(server, 'ring'), /seal/);
  assert.equal(closed, true); assert.equal(native.records.size, 0);
});

test('Windows replay rejects a changed registry entry after connecting without writing events', async t => {
  const dir = registerTemp(t, await mkdtemp(join(tmpdir(), 'cursor-win-'))), file = join(dir, 'input.jsonl');
  await writeFile(file, JSON.stringify(event) + '\n');
  const { native, transport } = platform(), s = socket();
  const result = await replayFile({ file, platform: 'win32', windows: transport, net: {
    createConnection() { native.records.get('ring').token = 'd'.repeat(32); queueMicrotask(() => s.emit('connect')); return s; },
  } });
  assert.deepEqual(result, { events: 1, renderers: 0 }); assert.deepEqual(s.lines, []);
});

test('Windows application identity survives outbound reprojection and invalid AUMIDs cannot leak paths', () => {
  const out = cursorRecord({ platform: 'win32', frame: { windowId: 1 },
    geometry: { window: { app: 'C:\\Apps\\paint.exe', appUserModelId: 'C:\\private\\app.exe', bundle: 'ignored' } } });
  assert.deepEqual(out.window, { id: 1, app: 'paint.exe', exposure: 'exposed' });
  const events = [];
  const emitter = createCursorEvents({ platform: 'win32', setting: () => ({ stream: true }), onEvent: e => events.push(e),
    sink: { write() {}, close() {} } });
  emitter.action({ ...event, window: { id: 1, app: 'C:\\Apps\\paint.exe', appUserModelId: 'Paint_abc!App' } }); emitter.close();
  assert.deepEqual(events.find(e => e.type === 'action').window, { id: 1, app: 'paint.exe', appUserModelId: 'Paint_abc!App', exposure: 'exposed' });
});

test('C# example uses passive styles in CreateParams and checks the capture-exclusion call result', async () => {
  const source = await readFile(new URL('../examples/cursor-renderer/RingOverlay.cs', import.meta.url), 'utf8');
  const styles = source.match(/protected override CreateParams CreateParams\s*{([\s\S]*?)return p;/)?.[1];
  assert.ok(styles);
  assert.match(styles, /p\.ExStyle\s*\|=\s*WS_EX_LAYERED\s*\|\s*WS_EX_TRANSPARENT\s*\|\s*WS_EX_TOOLWINDOW\s*\|\s*WS_EX_NOACTIVATE\s*;/);
  const handle = source.match(/protected override void OnHandleCreated\(EventArgs e\)\s*{([\s\S]*?)\n    }/)?.[1];
  assert.match(handle, /if\s*\(!SetWindowDisplayAffinity\(Handle, WDA_EXCLUDEFROMCAPTURE\)\)\s*throw new Win32Exception/);
  assert.match(source, /if\s*\(!SetProcessDpiAwarenessContext\(new IntPtr\(-4\)\)\)\s*throw/);
  assert.match(source, /protected override bool ShowWithoutActivation\s*{\s*get\s*{\s*return true;/);
  assert.match(source, /version\.build < 19041/);
  assert.match(source, /if \(!Visible\) Show\(\)/);
  assert.doesNotMatch(source, /SetForegroundWindow|SendInput|SetCursorPos|static string Text\(/);
  assert.match(source, /json\.Deserialize<[\s\S]*?catch \(Exception\) \{ \}\s*used = 0; oversized = false;/);
  assert.match(source, /phase == "done"[\s\S]*?view\.drags\.Remove\(key\);[\s\S]*?view\.overflow = false;/);
});

test('discovery verifies new or changed incarnations and connect, with zero repeat checks for connected peers', async t => {
  const { native, transport } = platform(); let checks = 0, scans = 0, now = 0;
  native.verify = async entry => { checks++; return native.records.get(entry.name)?.token === entry.token; };
  const list = native.list; native.list = async () => { scans++; return list(); };
  const sockets = [];
  const sink = createRendererSink({ platform: 'win32', windows: transport, now: () => now, connect() {
    const s = socket(); sockets.push(s); queueMicrotask(() => s.emit('connect')); return s;
  } });
  t.after(() => sink.close()); sink.write(event);
  await until(() => sink.stats().connected === 1);
  assert.equal(checks, 2);
  for (let i = 0; i < 3; i++) {
    now += 2000; sink.refresh(); await until(() => scans === i + 2);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(checks, 2); assert.equal(sockets.length, 1);
  native.records.set('ring', { ...native.records.get('ring'), token: 'd'.repeat(32), pid: 43 });
  now += 2000; sink.refresh(); await until(() => sockets.length === 2 && sink.stats().connected === 1);
  assert.equal(checks, 4); assert.equal(sockets[0].destroyed, true);
  sockets[1].destroy(); now += 2000; sink.refresh();
  await until(() => sockets.length === 3 && sink.stats().connected === 1);
  assert.equal(checks, 6);
});

test('discovery has one budget across identity, registry and all verifies, and prunes failed tokens', async () => {
  const native = security(); let now = 0, checks = 0;
  const make = name => ({ name, sid, pipe: windows.pipeName(sid, name), pid: 42, token: 'a'.repeat(32) });
  for (let i = 0; i < 16; i++) native.records.set('ring' + i, make('ring' + i));
  native.sid = async ({ timeoutMs }) => { assert.equal(timeoutMs, 100); now += 20; return sid; };
  native.list = async ({ timeoutMs }) => { assert.equal(timeoutMs, 80); now += 20; return [...native.records.values()]; };
  native.verify = async (_, { timeoutMs }) => { assert.ok(timeoutMs <= 60); checks++; now += 30; return true; };
  const transport = windows.createWindowsTransport({ security: native, now: () => now, discoveryMs: 100 });
  await assert.rejects(transport.discover(), /deadline/); assert.equal(checks, 2);
  const stale = platform(); stale.native.verify = async () => false;
  assert.deepEqual(await stale.transport.discover(), []); assert.equal(stale.native.records.size, 0);
});

test('a discovery deadline retains a connected peer and later scans can recover', async t => {
  const { native } = platform(); let stalled = false, scans = 0;
  const list = native.list;
  native.list = async () => { scans++; return stalled ? new Promise(() => {}) : list(); };
  const transport = windows.createWindowsTransport({ security: native, discoveryMs: 25 });
  let s;
  const sink = createRendererSink({ platform: 'win32', windows: transport, connect() {
    s = socket(); queueMicrotask(() => s.emit('connect')); return s;
  } });
  t.after(() => sink.close()); sink.write(event); await until(() => sink.stats().connected === 1);
  stalled = true; sink.refresh(); await until(() => scans === 2);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(sink.stats().connected, 1); assert.equal(s.destroyed, false);
  stalled = false; sink.refresh(); await until(() => scans === 3);
  sink.write({ ...event, seq: 2 }); assert.equal(s.lines.length, 1);
});

test('pre-publication connections never parse events, including after the listener becomes ready', async t => {
  const native = security(), seen = []; let accept, release, sealing = false;
  native.seal = async () => { sealing = true; return new Promise(resolve => { release = resolve; }); };
  const net = { createServer(cb) {
    accept = cb; const server = new EventEmitter();
    return Object.assign(server, { listen() { queueMicrotask(() => server.emit('listening')); }, close(cb) { cb?.(); } });
  } };
  const starting = createCursorListener({ platform: 'win32', name: 'ring', net,
    windows: windows.createWindowsTransport({ security: native }), onEvent: e => seen.push(e) });
  await until(() => sealing);
  const early = socket(); accept(early); early.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  assert.equal(early.listenerCount('data'), 0); assert.deepEqual(seen, []);
  release(true); const listener = await starting; t.after(() => listener.close());
  assert.equal(early.destroyed, true);
  early.emit('data', Buffer.from(JSON.stringify(event) + '\n')); assert.deepEqual(seen, []);
  const ready = socket(); accept(ready); ready.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  assert.equal(seen.length, 1);
});

test('macOS event import and sink creation never load the Windows transport', () => {
  const module = new URL('../plugins/sleight/lib/hand/events.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (/windows-transport\\.mjs|win32-cursor\\.mjs/.test(specifier)) throw Error('Windows cursor code loaded on macOS');
      return next(specifier, context);
    } });
    const { createRendererSink } = await import(${JSON.stringify(module)});
    const sink = createRendererSink({ platform: 'darwin' }); sink.close();
  `], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
});

test('unchanged discovered entries are cached, changed tokens are verified, and failed connects invalidate the cache', async () => {
  const { native, transport } = platform(); let checks = 0;
  native.verify = async () => { checks++; return true; };
  const [entry] = await transport.discover(); await transport.discover(); assert.equal(checks, 1);
  native.records.get('ring').token = 'd'.repeat(32);
  await transport.discover(); assert.equal(checks, 2);
  native.verify = async () => { checks++; return false; };
  assert.equal(await transport.validate(entry), false); assert.equal(checks, 3);
  assert.deepEqual(await transport.discover(), []); assert.equal(checks, 4);
  assert.equal(native.records.size, 0);
});

test('macOS listener handles server errors while awaiting socket permissions', async t => {
  const dir = registerTemp(t, await mkdtemp(join(tmpdir(), 'cursor-chmod-'))), warnings = [];
  const net = { createServer() {
    const server = new EventEmitter(); let bound = false;
    server.on('newListener', event => {
      if (bound && event === 'error') queueMicrotask(() => server.emit('error', Error('during chmod')));
    });
    return Object.assign(server, { listen() {
      queueMicrotask(() => { bound = true; server.emit('listening'); });
    }, close(cb) { cb?.(); } });
  } };
  // The fake bind leaves no socket to chmod, but emits an error during that real filesystem await.
  await assert.rejects(createCursorListener({ platform: 'darwin', dir, net, onWarning: w => warnings.push(w) }), { code: 'ENOENT' });
  assert.deepEqual(warnings, ['Renderer server error: during chmod']);
});

test('security startup has a separate compile budget and writes no requests before ready', async () => {
  const calls = []; let child;
  const run = (executable, args, options) => {
    child = helperRun(calls)(executable, args, options);
    // Suppress helperRun's automatic ready frame, then deliver readiness after the call budget.
    const write = child.stdout.write.bind(child.stdout);
    child.stdout.write = data => String(data).includes('"ready"') ? true : write(data);
    setTimeout(() => write('{"ready":true}\n'), 30);
    return child;
  };
  const adapter = windows.createWindowsSecurity({ platform: 'win32', testEnv: { SystemRoot: 'C:\\Windows' }, startupMs: 200, run });
  const promise = adapter.verify({}, { timeoutMs: 15 });
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(calls[0].requests.length, 0);
  assert.equal(await promise, true); assert.equal(calls[0].requests.length, 1);
});

test('a connect failure clears cached proof before the next pipe attempt', async t => {
  const { native, transport } = platform(); let checks = 0, now = 0;
  native.verify = async () => { checks++; return true; };
  const sink = createRendererSink({ platform: 'win32', windows: transport, now: () => now,
    connect() { const s = socket(); queueMicrotask(() => s.emit('error', Error('access denied'))); return s; } });
  t.after(() => sink.close()); sink.write(event); await until(() => checks === 1);
  await new Promise(resolve => setImmediate(resolve)); now = 2000; sink.refresh();
  await until(() => checks === 2); assert.equal(sink.stats().connected, 0);
});

test('one unreadable renderer does not discard later verified entries and scans cap at 16 names', async () => {
  const native = security(); let checks = 0;
  for (let i = 0; i < 20; i++) native.records.set('ring' + i, { name: 'ring' + i, sid, pipe: windows.pipeName(sid, 'ring' + i), pid: 42, token: 'a'.repeat(32) });
  native.verify = async entry => { checks++; if (entry.name === 'ring0') throw Error('gone'); return true; };
  const entries = await windows.createWindowsTransport({ security: native }).discover();
  assert.equal(checks, 16); assert.equal(entries.length, 15); assert.equal(entries[0].name, 'ring1');
});

test('security startup timeout refuses all waiting calls and backs off before a fresh worker', async () => {
  const calls = []; let withhold = true, now = 0;
  const run = (...args) => {
    const child = helperRun(calls)(...args), write = child.stdout.write.bind(child.stdout);
    child.stdout.write = data => withhold && String(data).includes('"ready"') ? true : write(data);
    return child;
  };
  const adapter = windows.createWindowsSecurity({ platform: 'win32', testEnv: { SystemRoot: 'C:\\Windows' }, startupMs: 15, run, now: () => now });
  const results = await Promise.allSettled([adapter.verify({}), adapter.list()]);
  assert.ok(results.every(r => r.status === 'rejected' && /startup deadline/.test(r.reason.message) && !/non-elevated/.test(r.reason.message)));
  assert.equal(calls[0].killed, true); assert.equal(calls[0].requests.length, 0);
  await assert.rejects(adapter.verify({}), /backoff/); assert.equal(calls.length, 1);
  now = 1000; withhold = false; assert.equal(await adapter.verify({}), true); assert.equal(calls.length, 2);
});

test('bootstrap hash is checked before every worker start and refuses a one-byte mutation', async () => {
  let bytes = readFileSync(new URL('../plugins/sleight/lib/hand/windows-security.ps1', import.meta.url));
  const calls = []; let now = 0;
  const adapter = windows.createWindowsSecurity({ now: () => now, platform: 'win32', testEnv: { SystemRoot: 'C:\\Windows' },
    read: () => bytes, run: helperRun(calls, () => 'invalid') });
  const changed = Buffer.from(bytes); changed[0] ^= 1;
  const original = bytes; bytes = changed;
  await assert.rejects(adapter.verify({}), /bootstrap hash mismatch/); assert.equal(calls.length, 0);
  bytes = original;
  await assert.rejects(adapter.verify({}), /Invalid Windows cursor security response/); assert.equal(calls.length, 1);
  bytes = changed; now = 1000;
  await assert.rejects(adapter.verify({}), /bootstrap hash mismatch/); assert.equal(calls.length, 1);
});

test('Add-Type completes at top level before the worker announces readiness', async () => {
  const source = await readFile(new URL('../plugins/sleight/lib/hand/windows-security.ps1', import.meta.url), 'utf8');
  const compile = source.indexOf('Add-Type -TypeDefinition'), end = source.indexOf("'@ | Out-Null", compile);
  const ready = source.indexOf(`Write-Reply '{"ready":true}'`);
  assert.ok(compile > 0 && end > compile && ready > end);
  assert.ok(compile < source.indexOf('function Test-Pipe'));
  assert.ok(ready < source.indexOf('while ($null -ne ($line'));
  assert.match(source.slice(end, ready), /catch[\s\S]*startupError[\s\S]*exit 1/);
  assert.equal(source.includes('\r'), false);
  assert.match(source, /\[Console\]::OpenStandardOutput\(\)/);
  assert.match(source, /\$utf8\.GetBytes\(\$text/);
  assert.match(source, /\$output\.Write\(\$bytes, 0, \$bytes\.Length\)/);
  assert.match(source, /\$output\.Flush\(\)/);
  assert.doesNotMatch(source, /\[Console\]::(?:OutputEncoding|WriteLine)|SetConsoleOutputCP/);
});

test('Add-Type startup failures back off 1 s, 5 s, 30 s, then stop and report once', async () => {
  const calls = [], reports = []; let now = 0;
  const run = (...args) => {
    const child = helperRun(calls)(...args);
    child.stdout.write = () => true;
    queueMicrotask(() => child.emit('exit', 1));
    return child;
  };
  const adapter = windows.createWindowsSecurity({ platform: 'win32', testEnv: { SystemRoot: 'C:\\Windows' },
    run, now: () => now, report: text => reports.push(text) });
  for (const delay of [1000, 5000, 30000]) {
    await assert.rejects(adapter.ready(), /check failed/);
    const count = calls.length;
    now += delay - 1; await assert.rejects(adapter.ready(), /backoff/); assert.equal(calls.length, count);
    now++;
  }
  await assert.rejects(adapter.ready(), /check failed/);
  for (let i = 0; i < 3; i++) { now += 60000; await assert.rejects(adapter.ready(), /stopped after 4 failures.*restart this session/); }
  assert.equal(calls.length, 4); assert.equal(reports.length, 1);
});

test('only access-denied security failures carry the elevated-shell hint', async () => {
  for (const error of ['CHECK_FAILED', 'ACCESS_DENIED']) {
    const adapter = windows.createWindowsSecurity({ platform: 'win32', testEnv: { SystemRoot: 'C:\\Windows' },
      run: helperRun([], request => ({ id: request.id, ok: false, error })) });
    await assert.rejects(adapter.verify({}), e => /non-elevated/.test(e.message) === (error === 'ACCESS_DENIED'));
  }
});

test('Add-Type startup error frames reject before any request and hint only for access denied', async () => {
  for (const startupError of ['CHECK_FAILED', 'ACCESS_DENIED']) {
    const calls = [];
    const adapter = windows.createWindowsSecurity({ platform: 'win32', testEnv: { SystemRoot: 'C:\\Windows' }, run: (...args) => {
      const child = helperRun(calls)(...args), write = child.stdout.write.bind(child.stdout);
      child.stdout.write = data => String(data).includes('"ready"') ? write(JSON.stringify({ startupError }) + '\n') : write(data);
      return child;
    } });
    await assert.rejects(adapter.verify({}), error => /startup failed/.test(error.message) &&
      /non-elevated/.test(error.message) === (startupError === 'ACCESS_DENIED'));
    assert.equal(calls[0].killed, true); assert.deepEqual(calls[0].requests, []);
    await assert.rejects(adapter.ready(), /backoff/); assert.equal(calls.length, 1);
  }
});

test('security backs off after a ready worker exits and reports EPERM as access denied', async () => {
  const calls = [], children = []; let now = 0;
  const adapter = windows.createWindowsSecurity({ platform: 'win32', testEnv: { SystemRoot: 'C:\\Windows' },
    run: (...args) => { const child = helperRun(calls)(...args); children.push(child); return child; }, now: () => now });
  await adapter.ready(); children[0].emit('exit', 1);
  await assert.rejects(adapter.ready(), /backoff/); assert.equal(calls.length, 1);
  now = 1000; await adapter.ready(); assert.equal(calls.length, 2);
  children[1].emit('exit', 1);
  const denied = windows.createWindowsSecurity({ platform: 'win32', testEnv: { SystemRoot: 'C:\\Windows' },
    run: () => { throw Object.assign(Error('denied'), { code: 'EPERM' }); } });
  await assert.rejects(denied.ready(), /non-elevated/);
});
