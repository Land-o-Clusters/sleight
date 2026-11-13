import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createNativeJoin } from '../plugins/sleight/lib/direct-browser/electron-native-join.mjs';

// EPV3-6: the native window reader. electron-windows.js is the JXA helper (selected by PID, content-free),
// electron-windows.mjs the JS side that validates its reply and numbers window epochs.
const api = await import('../plugins/sleight/lib/direct-browser/electron-windows.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; return {};
});
const helperUrl = new URL('../plugins/sleight/lib/direct-browser/electron-windows.js', import.meta.url);
const source = existsSync(helperUrl) ? readFileSync(helperUrl, 'utf8') : '';
const PID = 4100, BIRTH = '1700000000.000001';

// A strict JXA world: only what the helper may touch exists, so a bundle-id lookup, a title read or an
// unexpected API throws or is recorded.
function jxa({ windows = [], cg, screens, trusted = true, processes = { [PID]: { sec: 1700000000, usec: 1, status: 2 } }, request = { pid: PID, pidBirth: BIRTH }, appError } = {}) {
  const reads = [], created = [], bound = [];
  const list = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const app = { AXWindows: list(windows) };
  const data = length => { const holder = { value: undefined, buffer: new Uint8Array(length) };
    return { bytes: holder, mutableBytes: holder, base64EncodedStringWithOptions: () => Buffer.from(holder.buffer).toString('base64') }; };
  const $ = value => value;
  Object.assign($, {
    AXIsProcessTrusted: () => trusted,
    AXUIElementCreateApplication: pid => { created.push(pid); return app; },
    AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (element, name, value) => {
      reads.push(name);
      if (element === app && appError) return appError;
      if (!(name in element)) return -25205;
      value[0] = element[name]; return 0;
    },
    AXValueGetValue: (value, _type, bytes) => { bytes.value = value; return !!value; },
    NSMutableData: { dataWithLength: data },
    NSValue: { valueWithBytesObjCType: bytes => ({ pointValue: bytes.value, sizeValue: bytes.value }) },
    kCGWindowListOptionAll: 0, kCGWindowListExcludeDesktopElements: 16,
    CGWindowListCopyWindowInfo: () => list(cg ?? windows.map((window, i) => ({ kCGWindowOwnerPID: PID, kCGWindowLayer: 0, kCGWindowNumber: 11 + i,
      kCGWindowIsOnscreen: true, kCGWindowBounds: { X: window.AXPosition.x, Y: window.AXPosition.y, Width: window.AXSize.width, Height: window.AXSize.height } }))),
    NSScreen: { screens: list(screens ?? [{ frame: { origin: { x: 0, y: 0 }, size: { width: 1600, height: 1000 } }, backingScaleFactor: 2 },
      { frame: { origin: { x: 1600, y: 0 }, size: { width: 1920, height: 1080 } }, backingScaleFactor: 1 }]) },
  });
  const ObjC = { import() {}, unwrap: value => value, deepUnwrap: value => value, castRefToObject: value => value,
    bindFunction(name, signature) {
      bound.push([name, signature]);
      $[name] = (pid, flavor, arg, buffer, size) => {
        assert.deepEqual([flavor, arg, size], [3, 0, 136]);
        const row = processes[pid];
        if (!row) return 0;
        const view = new DataView(buffer.buffer.buffer);
        view.setUint32(4, row.status, true); view.setUint32(12, pid, true);
        view.setBigUint64(120, BigInt(row.sec), true); view.setBigUint64(128, BigInt(row.usec), true);
        return 136;
      };
    } };
  const reply = JSON.parse(runInNewContext(source + '\nrun([JSON.stringify(request)])', { $, Ref: () => [], ObjC, Date, request }));
  return { reply, reads, created, bound };
}
const win = (x, y, extra = {}) => ({ AXPosition: { x, y }, AXSize: { width: 800, height: 600 }, AXMinimized: false, AXTitle: 'secret.txt', AXDocument: 'file:///secret', ...extra });

test('the helper reports content-free rows for the PID it was given, numbered from CG bounds', () => {
  assert.ok(source, 'EPV3-6 must provide electron-windows.js');
  const { reply, reads, created, bound } = jxa({ windows: [win(10, 30), win(1700, 40, { AXMinimized: true })] });
  assert.equal(reply.status, 'ok');
  assert.deepEqual(Object.keys(reply).sort(), ['observedAt', 'processStart', 'status', 'windows']);
  assert.equal(reply.processStart, BIRTH);
  assert.ok(Math.abs(reply.observedAt - Date.now()) < 5000);
  assert.deepEqual(reply.windows, [
    { id: 11, pid: PID, frame: { x: 10, y: 30, width: 800, height: 600 }, scale: 2, onScreen: true, minimized: false, modal: false },
    { id: 12, pid: PID, frame: { x: 1700, y: 40, width: 800, height: 600 }, scale: 1, onScreen: true, minimized: true, modal: false },
  ]);
  assert.deepEqual(created, [PID], 'selected by PID, never by bundle id');
  for (const name of ['AXTitle', 'AXDocument', 'AXValue', 'AXDescription']) assert.ok(!reads.includes(name), name + ' is never read');
  assert.equal(JSON.stringify(bound), JSON.stringify([['proc_pidinfo', ['int', ['int', 'int', 'unsigned long long', 'void *', 'int']]]]));
});

test('modal state: a sheet child, AXModal or a dialog subrole, and an on-screen layer-101 menu of the PID on every row', () => {
  const sheet = win(10, 30, { AXChildren: { count: 1, objectAtIndex: () => ({ AXRole: 'AXSheet' }) } });
  const all = jxa({ windows: [sheet, win(900, 30, { AXModal: true }), win(10, 700, { AXSubrole: 'AXDialog' }), win(900, 700)] }).reply;
  assert.equal(all.status, 'ok', JSON.stringify(all));
  const rows = all.windows;
  assert.deepEqual(rows.map(row => row.modal), ['sheet', 'dialog', 'dialog', false]);
  const windows = [win(10, 30), { ...sheet, AXPosition: { x: 900, y: 30 } }];
  const cg = extra => [...windows.map((window, i) => ({ kCGWindowOwnerPID: PID, kCGWindowLayer: 0, kCGWindowNumber: 11 + i, kCGWindowIsOnscreen: true,
    kCGWindowBounds: { X: window.AXPosition.x, Y: window.AXPosition.y, Width: 800, Height: 600 } })), extra];
  const menu = { kCGWindowOwnerPID: PID, kCGWindowLayer: 101, kCGWindowNumber: 90, kCGWindowIsOnscreen: true, kCGWindowBounds: { X: 0, Y: 0, Width: 200, Height: 300 } };
  assert.deepEqual(jxa({ windows, cg: cg(menu) }).reply.windows.map(row => row.modal), ['menu', 'sheet']);
  assert.deepEqual(jxa({ windows, cg: cg({ ...menu, kCGWindowOwnerPID: 999 }) }).reply.windows.map(row => row.modal), [false, 'sheet'], 'another app\'s menu');
  assert.deepEqual(jxa({ windows, cg: cg({ ...menu, kCGWindowIsOnscreen: undefined }) }).reply.windows.map(row => row.modal), [false, 'sheet'], 'a closed menu');
});

test('onScreen comes from CG, and a window without a unique CG number is left out unless it is modal', () => {
  const windows = [win(10, 30), win(900, 30)];
  const cg = [{ kCGWindowOwnerPID: PID, kCGWindowLayer: 0, kCGWindowNumber: 11, kCGWindowBounds: { X: 10, Y: 30, Width: 800, Height: 600 } }];
  assert.deepEqual(jxa({ windows, cg }).reply.windows.map(row => [row.id, row.onScreen]), [[11, false]]);
  const modal = jxa({ windows: [win(10, 30), win(900, 30, { AXModal: true })], cg }).reply;
  assert.equal(modal.status, 'error', 'an unnumbered dialog fails the whole read so nothing joins past it');
  const twins = jxa({ windows: [win(10, 30), win(10, 30)], cg: [cg[0], { ...cg[0], kCGWindowNumber: 12 }] }).reply;
  assert.deepEqual(twins.windows, [], 'two CG candidates for one frame number nothing');
});

test('the helper denies without trust, reports a gone or zombie process as no birth, and fails closed on bad input', () => {
  assert.deepEqual(jxa({ trusted: false }).reply, { status: 'denied' });
  assert.equal(jxa({ processes: {} }).reply.processStart, null);
  assert.equal(jxa({ processes: { [PID]: { sec: 1, usec: 2, status: 5 } } }).reply.processStart, null);
  assert.equal(jxa({ processes: { [PID]: { sec: 1700000001, usec: 250, status: 2 } } }).reply.processStart, '1700000001.000250');
  for (const request of [{ pid: 0, pidBirth: BIRTH }, { pid: '4100', pidBirth: BIRTH }, { pid: PID }]) assert.equal(jxa({ request }).reply.status, 'error');
  assert.equal(jxa({ windows: Array.from({ length: 65 }, (_, i) => win(i, 0)) }).reply.status, 'error');
  assert.equal(jxa({ appError: -25204 }).reply.status, 'error');
  assert.deepEqual(jxa({ appError: -25212 }).reply.windows, [], 'an app with no windows yet');
});

test('the helper shares axPair with window-identity.js', () => {
  const pick = text => text.match(/\nfunction axPair\([\s\S]*?\n}\n/)?.[0];
  const identity = readFileSync(new URL('../plugins/sleight/lib/window-identity.js', import.meta.url), 'utf8');
  assert.ok(pick(identity));
  assert.equal(pick(source), pick(identity));
});

// Real osascript for the bridging the fakes cannot show: proc_pidinfo through ObjC.bindFunction and NSScreen frames.
const launchPy = ['../bench/direct-electron/launch.py', '../plugins/sleight/lib/direct-browser/electron/launch.py']
  .map(path => fileURLToPath(new URL(path, import.meta.url))).find(existsSync);
test('real JXA: the birth string matches launch.py\'s for this process, and screens report a scale', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'electron-windows-'));
  try {
    const script = join(dir, 'probe.js');
    writeFileSync(script, source + `\nfunction run() { return JSON.stringify([processBirth(${process.pid}), screenScale({ x: 0, y: 0, width: 10, height: 10 })]); }`);
    const [birth, scale] = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', script], { encoding: 'utf8', timeout: 20000 }));
    const expected = execFileSync('python3', ['-I', '-c', 'import importlib.util, sys\nspec = importlib.util.spec_from_file_location("launch", sys.argv[1])\n' +
      'module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); print(module.process_birth(int(sys.argv[2])))', launchPy, String(process.pid)],
    { encoding: 'utf8', timeout: 20000 }).trim();
    assert.match(birth, /^\d+\.\d{6}$/);
    assert.equal(birth, expected);
    assert.ok(Number.isFinite(scale) && scale > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The JS reader.
const row = (id, extra = {}) => ({ id, pid: PID, frame: { x: 10, y: 30, width: 800, height: 600 }, scale: 2, onScreen: true, minimized: false, modal: false, ...extra });
function helper(replies) {
  const calls = [];
  let i = 0;
  const run = async request => { calls.push(request); const next = typeof replies === 'function' ? replies(calls.length) : replies[Math.min(i++, replies.length - 1)];
    if (next instanceof Error) throw next; return typeof next === 'string' ? next : JSON.stringify(next); };
  return { run, calls };
}
const ok = (windows, extra = {}) => ({ status: 'ok', observedAt: 5000, processStart: BIRTH, windows, ...extra });

test('the reader validates the reply, adds epochs and the birth, and asks for exactly its PID', async () => {
  assert.equal(typeof api.createWindowReader, 'function', 'EPV3-6 must provide the window reader');
  const h = helper([ok([row(11), row(12, { modal: 'sheet' })])]);
  const reader = api.createWindowReader({ pid: PID, pidBirth: BIRTH, run: h.run, cacheMs: 0 });
  const snapshot = await reader.read();
  assert.deepEqual(h.calls, [{ pid: PID, pidBirth: BIRTH }]);
  assert.deepEqual(snapshot, { observedAt: 5000, windows: [{ ...row(11), epoch: 1, pidBirth: BIRTH }, { ...row(12, { modal: 'sheet' }), epoch: 2, pidBirth: BIRTH }] });
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.windows[0].frame));
});

test('epochs: a CG number seen first gets the next value and keeps it for the reader\'s lifetime', async () => {
  const h = helper([ok([row(11)]), ok([row(12), row(11)]), ok([row(12)]), ok([row(11), row(13)])]);
  const reader = api.createWindowReader({ pid: PID, pidBirth: BIRTH, run: h.run, cacheMs: 0 });
  const epochs = [];
  for (let i = 0; i < 4; i++) epochs.push((await reader.read()).windows.map(window => [window.id, window.epoch]));
  assert.deepEqual(epochs, [[[11, 1]], [[12, 2], [11, 1]], [[12, 2]], [[11, 1], [13, 3]]]);
  const fresh = api.createWindowReader({ pid: PID, pidBirth: BIRTH, run: helper([ok([row(13)])]).run });
  assert.equal((await fresh.read()).windows[0].epoch, 1, 'a new reader numbers from 1');
});

test('the cache: a result younger than cacheMs is reused, concurrent reads share one helper call', async () => {
  let clock = 0;
  const h = helper(() => ok([row(11)]));
  const reader = api.createWindowReader({ pid: PID, pidBirth: BIRTH, run: h.run, cacheMs: 250, now: () => clock });
  const [a, b] = await Promise.all([reader.read(), reader.read()]);
  assert.equal(h.calls.length, 1); assert.equal(a, b);
  clock = 249; await reader.read(); assert.equal(h.calls.length, 1);
  clock = 250; await reader.read(); assert.equal(h.calls.length, 2);
});

test('denied, helper errors and a changed process are typed refusals and are not cached', async () => {
  const read = async reply => api.createWindowReader({ pid: PID, pidBirth: BIRTH, run: helper([reply]).run }).read();
  await assert.rejects(read({ status: 'denied' }), /^Error: ELECTRON_WINDOWS_DENIED$/);
  await assert.rejects(read({ status: 'error', message: 'AX deadline unavailable' }), /^Error: ELECTRON_WINDOWS_UNAVAILABLE$/);
  await assert.rejects(read(Error('osascript died')), /^Error: ELECTRON_WINDOWS_UNAVAILABLE$/);
  await assert.rejects(read(ok([row(11)], { processStart: '1700000099.000001' })), /^Error: ELECTRON_WINDOWS_PID_CHANGED$/);
  await assert.rejects(read(ok([row(11)], { processStart: null })), /^Error: ELECTRON_WINDOWS_PID_CHANGED$/);
  const h = helper([{ status: 'denied' }, ok([row(11)])]);
  const reader = api.createWindowReader({ pid: PID, pidBirth: BIRTH, run: h.run, cacheMs: 5000 });
  await assert.rejects(reader.read(), /DENIED/);
  assert.equal((await reader.read()).windows.length, 1);
});

test('a reply with a title, URL or any key outside the schema is refused', async () => {
  const read = async reply => api.createWindowReader({ pid: PID, pidBirth: BIRTH, run: helper([reply]).run }).read();
  for (const reply of [ok([row(11, { title: 'secret.txt' })]), ok([row(11)], { url: 'file:///x' }), ok([row(11, { epoch: 4 })]), ok([row(11, { pid: 999 })]),
    ok([row(11, { modal: 'popover' })]), ok([row(11), row(11)]), ok([row(0)]), ok([row(11, { frame: { x: 0, y: 0, width: 0, height: 5 } })]),
    ok([row(11, { scale: 0 })]), ok([row(11, { onScreen: 'yes' })]), ok(Array.from({ length: 65 }, (_, i) => row(i + 1))), { status: 'denied', why: 'x' },
    { status: 'other' }, '{ not json', '[]'])
    await assert.rejects(read(reply), /^Error: ELECTRON_WINDOWS_INVALID$/, JSON.stringify(reply).slice(0, 80));
});

test('close: later reads and a read in flight refuse', async () => {
  let release;
  const reader = api.createWindowReader({ pid: PID, pidBirth: BIRTH, run: () => new Promise(resolve => { release = resolve; }) });
  const pending = reader.read();
  reader.close();
  release(JSON.stringify(ok([row(11)])));
  await assert.rejects(pending, /^Error: ELECTRON_WINDOWS_CLOSED$/);
  await assert.rejects(reader.read(), /^Error: ELECTRON_WINDOWS_CLOSED$/);
  for (const options of [{ pid: 0, pidBirth: BIRTH, run() {} }, { pid: PID, pidBirth: '', run() {} }, { pid: PID, pidBirth: BIRTH }, { pid: PID, pidBirth: BIRTH, run() {}, cacheMs: -1 }])
    assert.throws(() => api.createWindowReader(options), /^Error: ELECTRON_WINDOWS_REQUIRED$/);
});

test('the reader feeds the native join: one window joins, a sheet parks', async () => {
  const replies = [ok([row(11)], { observedAt: 1000 }), ok([row(11, { modal: 'sheet' })], { observedAt: 1000 })];
  const reader = api.createWindowReader({ pid: PID, pidBirth: BIRTH, run: helper(replies).run, cacheMs: 0 });
  const join = createNativeJoin({ app: { pid: PID, pidBirth: BIRTH }, approved: () => true, readWindows: reader.read, now: () => 1000 });
  const geometry = { x: 10, y: 30, width: 800, height: 600, scale: 2, visible: true };
  assert.deepEqual((await join.resolve([{ targetId: 'a', geometry }])).get('a'), { status: 'joined', window: { id: 11, epoch: 1 } });
  assert.equal((await join.resolve([{ targetId: 'a', geometry }])).get('a').status, 'parked');
});
