import { windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWindowsDriverClient } from '../plugins/sleight/lib/windows-driver/client.mjs';
import { windowsReplFixture } from './fixtures/windows-repl-client.mjs';
import { createWindowsCua } from '../plugins/sleight/lib/windows-repl/cua.mjs';

const identityModule = new URL('../plugins/sleight/lib/windows-repl/identity.mjs', import.meta.url);
const nativeRoot = new URL('../plugins/sleight/lib/direct-browser/native/win/', import.meta.url);
const birth = '134059077770000001';
const window = { windowId: '18446744073709551615', pid: 41, processStart: birth,
  image: 'C:\\Windows\\notepad.exe', aumid: null, title: 'old', threadId: 51, className: 'Notepad', integrity: 'medium', refused: null };
async function identityApi() {
  assert.ok(existsSync(identityModule), 'Windows identity validation must exist');
  return import(identityModule.href);
}
function clientFixture(t, scenario = '') {
  const client = createWindowsDriverClient({ platform: 'win32', prepare: async () => ({ status: 'ready', spawn({ nonce }) {
    return spawn(process.execPath, [fileURLToPath(new URL('./fixtures/windows-driver-fake.mjs', import.meta.url)), scenario],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { SLEIGHT_DRIVER_NONCE: nonce } });
  } }) });
  t.after(() => client.close()); return client;
}

test('Windows identity preserves 64-bit HWND and FILETIME and permits a title change', async () => {
  const { verifyWindowIdentity } = await identityApi();
  assert.deepEqual(verifyWindowIdentity(window, { ...window, title: 'new' }), { ...window, title: 'new' });
  assert.deepEqual(verifyWindowIdentity({ window: window.windowId, processStart: birth }, window), window);
  for (const [key, value] of [['windowId', '101'], ['pid', 42], ['processStart', '134059077770000002'],
    ['image', 'C:\\other.exe'], ['aumid', 'Other.App'], ['threadId', 52], ['className', 'OtherWindow']]) {
    assert.throws(() => verifyWindowIdentity(window, { ...window, [key]: value }), { code: 'IDENTITY_CHANGED' }, key);
  }
});

test('Windows identity refuses missing, lossy, noncanonical and out-of-range bindings', async () => {
  const { verifyWindowIdentity } = await identityApi();
  for (const value of [undefined, null, 101, '0', '01', '-1', '1e2', '1\n', '18446744073709551616']) {
    assert.throws(() => verifyWindowIdentity({ windowId: value, processStart: birth }, window), { code: 'INVALID_PARAMS' });
  }
  for (const value of [undefined, Number(birth), '0', '01', '9223372036854775808']) {
    assert.throws(() => verifyWindowIdentity({ windowId: '101', processStart: value }, window), { code: 'INVALID_PARAMS' });
  }
  assert.throws(() => verifyWindowIdentity(window, null), { code: 'IDENTITY_CHANGED' });
  assert.throws(() => verifyWindowIdentity(window, { ...window, processStart: Number(birth) }), { code: 'IDENTITY_CHANGED' });
});

test('own-host, elevated, unknown-integrity and unavailable identities refuse before use', async () => {
  const { verifyWindowIdentity } = await identityApi();
  for (const refused of ['OWN_HOST', 'ELEVATED_TARGET', 'OTHER_SESSION', 'TARGET_UNAVAILABLE', 'MINIMIZED_PACKAGED_WINDOW']) {
    assert.throws(() => verifyWindowIdentity(window, { ...window, refused }), { code: refused });
  }
  for (const integrity of ['unknown', null]) {
    assert.throws(() => verifyWindowIdentity(window, { ...window, integrity }),
      { code: 'TARGET_UNAVAILABLE' });
  }
});

test('native integrity verdict allows low and medium, refuses high and system, and refuses even a medium target above a low driver', async () => {
  const { verifyWindowIdentity } = await identityApi();
  for (const integrity of ['low', 'medium']) {
    const observed = { ...window, integrity };
    assert.equal(verifyWindowIdentity(window, observed), observed);
  }
  // The High-integrity ceiling holds even when the driver itself runs elevated (UC3LB).
  for (const integrity of ['high', 'system'])
    assert.throws(() => verifyWindowIdentity(window, { ...window, integrity }), { code: 'ELEVATED_TARGET' });
  assert.throws(() => verifyWindowIdentity(window, { ...window, integrity: 'medium', refused: 'ELEVATED_TARGET' }),
    { code: 'ELEVATED_TARGET' });
  assert.throws(() => verifyWindowIdentity(window, { ...window, integrity: 'unknown', refused: 'ELEVATED_TARGET' }),
    { code: 'ELEVATED_TARGET' });
});

test('executable replacement changes a bound Windows identity', async () => {
  const { verifyWindowIdentity } = await identityApi();
  const expected = { ...window, imageIdentity: '134059077770000000:4096' };
  assert.throws(() => verifyWindowIdentity(expected, { ...expected, imageIdentity: '134059077770000001:4096' }),
    { code: 'IDENTITY_CHANGED' });
  assert.throws(() => verifyWindowIdentity(expected, { ...expected, imageIdentity: '134059077770000000:8192' }),
    { code: 'IDENTITY_CHANGED' });
});

test('client capture and combined read bind the same HWND and process incarnation', async t => {
  const client = clientFixture(t);
  assert.equal(typeof client.getScreenshot, 'function');
  assert.equal(typeof client.getAXStateAndScreenshot, 'function');
  assert.equal(typeof client.verifyWindowIdentity, 'function');
  const first = await client.getApp('Notepad');
  const image = await client.getScreenshot('101', { processStart: birth });
  assert.equal(image.screenshot.mimeType, 'image/png'); assert.equal(image.capture.status, 'ok');
  assert.equal(image.capture.width, 2); assert.equal(image.capture.height, 2);
  assert.equal(Buffer.from(image.screenshot.data, 'base64').readUInt32BE(16), 2);
  assert.equal((await client.verifyWindowIdentity('101', { processStart: birth })).window.processStart, birth);
  const both = await client.getAXStateAndScreenshot('101', { processStart: birth });
  assert.match(both.text, /Window: "Untitled - Notepad", App: Notepad\./);
  assert.ok(both.readId > first.readId); assert.deepEqual(both.screenshot, image.screenshot);
  await assert.rejects(client.getScreenshot('101', { processStart: '1' }), { code: 'IDENTITY_CHANGED' });
  assert.equal((await client.ping()).protocol, 'sleight.windows-driver/1');
});

test('forged driver capture parameters refuse even without the cua API', async t => {
  const client = clientFixture(t);
  for (const method of ['getScreenshot', 'getAXStateAndScreenshot', 'verifyWindowIdentity', 'getAXState']) {
    for (const params of [{}, { windowId: '101' }, { windowId: 101, processStart: birth },
      { windowId: '101', processStart: Number(birth) }, { windowId: '101', processStart: birth, arbitrary: true }]) {
      await assert.rejects(client.request(method, params), { code: 'INVALID_PARAMS' }, method);
    }
  }
});

test('capture refusal preserves child and does not return an image', async t => {
  for (const scenario of ['capture-own-host', 'capture-elevated', 'capture-changed']) {
    const client = clientFixture(t, scenario);
    const code = { 'capture-own-host': 'OWN_HOST', 'capture-elevated': 'ELEVATED_TARGET', 'capture-changed': 'IDENTITY_CHANGED' }[scenario];
    await assert.rejects(client.request('getScreenshot', { windowId: '101', processStart: birth }), { code });
    assert.equal((await client.ping()).protocol, 'sleight.windows-driver/1');
  }
});

test('minimized and cloaked captures return a note with no fabricated image', async t => {
  for (const scenario of ['capture-minimized', 'capture-cloaked', 'capture-black', 'capture-failed']) {
    const client = clientFixture(t, scenario);
    const result = await client.request('getScreenshot', { windowId: '101', processStart: birth });
    assert.equal(result.screenshot, undefined); assert.equal(result.capture.status, scenario.slice(8));
    assert.equal(typeof result.capture.note, 'string');
  }
});

test('cua emits a combined tree and image, keeps identity and handles no-image captures', { skip: windowsWorkerSkip }, async t => {
  const { js, requests } = windowsReplFixture(t);
  await js('let note = await cua.getApp("Notepad", {emit:false});');
  const result = await js('await note.getAXStateAndScreenshot();');
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok(result.content.some(item => item.type === 'image' && item.mimeType === 'image/png'));
  assert.ok(result.content.some(item => /Window:/.test(item.text)));
  assert.deepEqual(requests.find(row => row.method === 'getAXStateAndScreenshot').params, { windowId: '101', processStart: birth });
});

test('hand geometry converts physical client pixels once and suppresses unknown exposure', async () => {
  const { cursorGeometry } = await identityApi();
  for (const dpi of [96, 120, 144, 192]) {
    const geometry = { clientOrigin: [-1920, -200], clientSize: [800, 600], rect: [-1930, -230, 820, 640],
      dpi, scale: dpi / 96, exposure: 'exposed', covers: [], monitors: [[-1920, -300, 1920, 1080]] };
    const result = cursorGeometry({ ...window, windowId: '101' }, geometry, [200, 100]);
    assert.deepEqual(result.point, [-1720, -100]); assert.equal(result.window.exposure, 'exposed');
    assert.equal(result.display.scale, dpi / 96); assert.equal(result.window.app, 'notepad.exe');
    assert.equal(JSON.stringify(result).includes('C:'), false); assert.equal(JSON.stringify(result).includes('old'), false);
    assert.equal(result.window.bundle, undefined);
    assert.equal(cursorGeometry(window, { ...geometry, exposure: 'unknown' }, [1, 1]), undefined);
    assert.equal(cursorGeometry(window, geometry, [800, 1]), undefined);
    assert.equal(cursorGeometry({ ...window, windowId: '101' }, { ...geometry, covers: [[-1800, -150, 300, 200]] }, [200, 100]).window.exposure, 'covered');
  }
});

test('every driver source excludes foreground APIs and newer C# syntax; screen copy stays in capture', () => {
  const names = readdirSync(nativeRoot).filter(name => /^Driver.*\.cs$/.test(name));
  assert.ok(names.length >= 5);
  for (const name of names) {
    const file = new URL(name, nativeRoot);
    assert.ok(existsSync(file), name + ' must exist');
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\b(?:SendInput|SetForegroundWindow|AttachThreadInput|SetFocus|BringWindowToTop|ShowWindow|CopyFromScreen)\s*\(/, name);
    assert.doesNotMatch(source, /\$"|\?\.|nameof\(|using var /, name);
    if (name !== 'DriverCapture.cs') assert.doesNotMatch(source, /\b(?:BitBlt|GetDC)\s*\(/, name);
    else {
      assert.match(source, /source = GetDC\(window\.Handle\)/);
      assert.doesNotMatch(source, /GetDC\(IntPtr\.Zero\)/);
      assert.match(source, /screen && !ScreenCopyAllowed\(geometry\)/);
    }
  }
});

test('cua withholds pixels on changed or missing identity and refuses an own-host first read', async () => {
  const make = (first, next) => {
    const writes = [], images = [];
    const cua = createWindowsCua({ request: async method => method === 'getApp' ? first : next,
      write: value => writes.push(value), emitImage: image => images.push(image) });
    return { cua, writes, images };
  };
  const first = { window: { ...window, windowId: '101' }, text: 'Window: "old", App: notepad.', readId: 1 };
  for (const next of [{ window: { ...first.window, pid: 99 }, screenshot: { data: 'secret' } }, { screenshot: { data: 'secret' } }]) {
    const { cua, writes, images } = make(first, next);
    const app = await cua.getApp('Notepad', { emit: false });
    await assert.rejects(app.getScreenshot()); assert.deepEqual(writes, []); assert.deepEqual(images, []);
  }
  const { cua, writes } = make({ ...first, window: { ...first.window, refused: 'OWN_HOST' } });
  await assert.rejects(cua.getApp('Host'), { code: 'OWN_HOST' }); assert.deepEqual(writes, []);
});

test('cua emits a capture note or returns null under emit:false, and combined reads keep their tree', async () => {
  const first = { window: { ...window, windowId: '101' }, text: 'Window: "old", App: notepad.', readId: 1 };
  const writes = [], images = [];
  const cua = createWindowsCua({ request: async method => method === 'getApp' ? first :
    { ...first, readId: 2, capture: { status: 'minimized', note: 'Screenshot unavailable: minimized.' } },
  write: value => writes.push(value), emitImage: image => images.push(image) });
  const app = await cua.getApp('Notepad', { emit: false });
  assert.equal(await app.getScreenshot({ emit: false }), null); assert.deepEqual(writes, []);
  assert.deepEqual(await app.getAXStateAndScreenshot(), { state: first.text, screenshot: null });
  assert.deepEqual(writes, [first.text, 'Screenshot unavailable: minimized.']); assert.deepEqual(images, []);
});

test('combined capture error notes retain the numbered tree without emitting pixels', async () => {
  for (const code of ['CAPTURE_LIMIT', 'CAPTURE_UNAVAILABLE', 'GEOMETRY_CHANGED']) {
    const first = { window: { ...window, windowId: '101' }, text: 'Window: "old", App: notepad.\n0 standard window old\n\t1 button Save', readId: 1 };
    const writes = [], images = [];
    const note = 'Screenshot unavailable: ' + code + '.';
    const cua = createWindowsCua({ request: async method => method === 'getApp' ? first :
      { ...first, readId: 2, capture: { status: 'failed', method: 'PrintWindow', code, note } },
    write: value => writes.push(value), emitImage: image => images.push(image) });
    const app = await cua.getApp('Notepad', { emit: false });
    assert.deepEqual(await app.getAXStateAndScreenshot(), { state: first.text, screenshot: null });
    assert.deepEqual(writes, [first.text, note]); assert.deepEqual(images, []);
  }
});

test('unknown, malformed or refused hand facts never produce a public point', async () => {
  const { cursorGeometry } = await identityApi();
  const geometry = { clientOrigin: [-1920, -200], clientSize: [800, 600], rect: [-1930, -230, 820, 640],
    dpi: 96, scale: 1, exposure: 'exposed', covers: [], monitors: [[-1920, -300, 1920, 1080]] };
  for (const override of [{ exposure: 'unknown' }, { dpi: NaN }, { covers: null },
    { covers: [[1, 2, -3, 4]] }, { clientOrigin: [Infinity, 0] }, { rect: [0, 0, -1, 4] }]) {
    assert.equal(cursorGeometry({ ...window, windowId: '101' }, { ...geometry, ...override }, [1, 1]), undefined);
  }
  assert.equal(cursorGeometry({ ...window, windowId: '101', refused: 'OWN_HOST' }, geometry, [1, 1]), undefined);
  assert.equal(cursorGeometry({ ...window, windowId: '101' }, { ...geometry, scale: 2 }, [1, 1]).display.scale, 1);
  assert.equal(cursorGeometry({ ...window, windowId: '101' }, { ...geometry, scale: undefined }, [1, 1]).display.scale, 1);
});

test('hand points outside monitor bounds are offscreen even inside a partly visible client', async () => {
  const { cursorGeometry } = await identityApi();
  const target = { ...window, windowId: '101' };
  const geometry = { clientOrigin: [-100, 0], clientSize: [800, 600], rect: [-110, -30, 820, 640],
    dpi: 144, scale: 1.5, exposure: 'exposed', covers: [], monitors: [[0, 0, 1920, 1080]] };
  assert.equal(cursorGeometry(target, geometry, [10, 10]).window.exposure, 'offscreen');
  assert.equal(cursorGeometry(target, geometry, [100, 10]).window.exposure, 'exposed');
  assert.equal(cursorGeometry(target, { ...geometry, monitors: [] }, [100, 10]), undefined);
  assert.equal(cursorGeometry(target, { ...geometry, monitors: undefined }, [100, 10]), undefined);
});

test('driver capture source pins resource cleanup, physical DPI, identity brackets and fixed target-only capture', () => {
  const source = readFileSync(new URL('DriverCapture.cs', nativeRoot), 'utf8');
  const identity = readFileSync(new URL('DriverIdentity.cs', nativeRoot), 'utf8');
  const driver = readFileSync(new URL('Driver.cs', nativeRoot), 'utf8');
  assert.match(source, /PrintWindow\(window\.Handle, dc, PrintFlags\)/);
  assert.match(source, /PrintFlags = 1 \| 2/); assert.match(source, /Height = -geometry\.Height/);
  assert.match(source, /finally[\s\S]*SelectObject\(dc, previous\)[\s\S]*DeleteObject\(dib\)[\s\S]*DeleteDC\(dc\)/);
  assert.doesNotMatch(source, /CopyFromScreen|CreateWindow|System\.Windows\.Forms/);
  assert.match(source, /source = GetDC\(window\.Handle\)/);
  assert.doesNotMatch(source, /GetDC\(IntPtr\.Zero\)/);
  assert.match(source, /VerifySurface\(before, geometry, screen\)/);
  assert.match(source, /SetThreadDpiAwarenessContext\(new IntPtr\(-4\)\)/);
  assert.match(source, /DriverIdentity\.Verify\(before, DriverInventory\.Observe\(before\.Handle\)\)/);
  assert.match(source, /geometry\.Stable\(observed\)/);
  assert.match(identity, /Json\.Keys\(p, "windowId processStart bindingId"\)/);
  assert.match(identity, /Regex\.IsMatch\(Json\.Text\(p\["bindingId"\]\), "\\\\A\[a-f0-9\]\{32\}\\\\z"\)\) throw new DriverFault\("INVALID_PARAMS"\)/);
  assert.match(identity, /SHGetKnownFolderPath/); assert.match(identity, /SHA256\.Create\(\)/);
  assert.match(identity, /catalog\.Contains\(window\.Image\)/);
  assert.doesNotMatch(identity, /Directory\.Exists|File\.Exists/, 'access errors must not become an empty host catalog');
  assert.ok(driver.indexOf('DriverIdentity.Binding(p)') < driver.indexOf('DriverIdentity.BeginRequest()'));
  assert.match(driver, /DriverCapture\.Capture\(window\)/);
});

test('native subtree fetches certify both identities and only a vanished popup can become partial', () => {
  const source = readFileSync(new URL('DriverUia.cs', nativeRoot), 'utf8');
  const fetch = source.slice(source.indexOf('bool Fetch('), source.indexOf('internal static string Serialize'));
  assert.match(fetch, /FetchChecked\(window/);
  assert.match(fetch, /DriverIdentity\.Verify\(window, before\)/);
  assert.match(fetch, /DriverIdentity\.Verify\(window, after\)/);
  assert.match(fetch, /window\.Popup && after == null/);
  assert.match(fetch, /nodes\.RemoveRange\(start, nodes\.Count - start\)/);
});

test('catalog probes target size before opening and memoizes construction failures per request', () => {
  const source = readFileSync(new URL('DriverIdentity.cs', nativeRoot), 'utf8');
  const contains = source.slice(source.indexOf('internal bool Contains('));
  assert.ok(contains.indexOf('new FileInfo(full).Length') < contains.indexOf('new FileStream(full'));
  assert.doesNotMatch(contains, /Ordinary\(/);
  assert.match(source, /BeginRequest\(\) \{ hosts = null; catalogFault = null; \}/);
  assert.match(source, /if \(catalogFault != null\) throw catalogFault/);
  assert.match(source, /catalogFault = error; throw/);
  assert.match(source, /if \(entries >= 256\) break/);
  assert.match(source, /if \(Bank\(directory\)\) entries\+\+/);
});

test('combined capture fallback certifies identity and preserves error codes; frame bounds apply to both windows', () => {
  const source = readFileSync(new URL('DriverCapture.cs', nativeRoot), 'utf8');
  const driver = readFileSync(new URL('Driver.cs', nativeRoot), 'utf8');
  assert.match(driver, /var captured = DriverCapture\.CaptureForRead\(window\)/);
  assert.match(driver, /catch \(Exception\) \{ result\["geometry"\] = Json\.Map\("exposure", "unknown"\)/);
  assert.match(source, /error\.Code != "CAPTURE_LIMIT" && error\.Code != "CAPTURE_UNAVAILABLE" && error\.Code != "GEOMETRY_CHANGED"/);
  assert.ok(source.indexOf('var after = verify()') < source.indexOf('var note = Note("failed")'));
  assert.match(source, /note\["code"\] = error\.Code/);
  assert.match(source, /DWMWA_EXTENDED_FRAME_BOUNDS/);
  assert.match(source, /DwmGetWindowAttribute\(hwnd, 9,/);
  assert.match(source, /FrameBounds\(window\.Handle, out bounds\)/);
  assert.match(source, /FrameBounds\(hwnd, out rect\)/);
});
