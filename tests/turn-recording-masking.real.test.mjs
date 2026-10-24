import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTurnRecording } from '../plugins/sleight/lib/turn-recording.mjs';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { captureRecordingFrame } from '../plugins/sleight/lib/direct-browser/recording.mjs';

const require = createRequire(import.meta.url);
const { PNG } = require('../plugins/sleight/vendor/playwright-core/lib/utilsBundle.js');
// Independent reference: average each fixture's CSS tile, then repeat its colour.
function reference(raw, size = 40) {
  const out = Buffer.from(raw.data);
  for (let y = 0; y < raw.height; y += size) for (let x = 0; x < raw.width; x += size) {
    const bottom = Math.min(y + size, raw.height), right = Math.min(x + size, raw.width), sum = [0, 0, 0];
    for (let j = y; j < bottom; j++) for (let i = x; i < right; i++) for (let c = 0; c < 3; c++) sum[c] += raw.data[(j * raw.width + i) * 4 + c];
    const rgb = sum.map(v => Math.round(v / ((bottom - y) * (right - x))));
    for (let j = y; j < bottom; j++) for (let i = x; i < right; i++) out.set([...rgb, 255], (j * raw.width + i) * 4);
  }
  return out;
}
function different(frame, expected, box) {
  let count = 0;
  for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y++) for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
    const at = (y * frame.width + x) * 4;
    if (frame.data.subarray(at, at + 4).some((v, i) => v !== expected[at + i])) count++;
  }
  return count;
}
async function gradeSaved(t, frame, expected, box) {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-g13c-grade-')), path = join(dir, 'actions.gif');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recorder = createTurnRecording({ current: () => true, capture: async () => frame,
    createFile: () => ({ path, fd: openSync(path, 'wx', 0o600) }) });
  await recorder.capture({ state: {} }); await recorder.end();
  const result = spawnSync('python3', ['-c', `from PIL import Image
import sys,json,math
w,h,box=json.loads(sys.argv[2]); raw=sys.stdin.buffer.read(); p=Image.open(sys.argv[1]).convert('RGB')
s=min(1,640/w,480/h); left=(640-math.floor(w*s))//2; top=(480-math.floor(h*s))//2; recovered=0
for y in range(math.ceil((box['y']+2)*s)+top,math.floor((box['y']+box['height']-2)*s)+top):
 for x in range(math.ceil((box['x']+2)*s)+left,math.floor((box['x']+box['width']-2)*s)+left):
  at=(min(h-1,math.floor((y-top)/s))*w+min(w-1,math.floor((x-left)/s)))*4
  r,g,b=raw[at:at+3]; rgb=(round((r>>5)*255/7),round((g>>5)*255/7),round((b>>6)*255/3))
  recovered+=p.getpixel((x,y))!=rgb
print(recovered)
assert recovered==0,('saved GIF differs from masked reference',recovered)
`, path, JSON.stringify([frame.width, frame.height, box])], { input: expected, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  t.diagnostic(`saved GIF: ${result.stdout.trim()} pixels differ from the masked reference`);
}
const qr = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="white"/>' +
  Array.from({ length: 64 * 64 }, (_, i) => (i * 17 + Math.floor(i / 64) * 7) % 11 < 5 ? `<rect x="${i % 64 * 2}" y="${Math.floor(i / 64) * 2}" width="2" height="2"/>` : '').join('') + '</svg>';
const media = `<img id=leak width=128 height=128 src="data:image/svg+xml,${encodeURIComponent(qr)}">`;
const cases = [
  ['sibling QR', '<section><h2>Set up two-factor</h2></section>' + media],
  ['header and main QR', '<header><h2>Security verification</h2></header><main>' + media + '</main>'],
  ['otp and QR', '<div class=otp><input value=123456></div>' + media],
  ['echoed address', '<form><input value="7 Test Street"></form><p id=leak>Ada Example, 7 Test Street, Apt 42, New York 10001</p>'],
  ['Visa ending 4242', '<div id=leak>Visa ending 4242</div>'],
  ['designMode', '<p id=leak>Editable account 987654 and 7 Test Street</p>', true],
];
for (const [name, body, designMode] of cases) test(`mask by default: ${name} has zero recoverable pixels`, { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>body{margin:0;background:white;font:20px monospace}#leak{display:block;margin:16px;width:640px;min-height:64px}img#leak{width:128px;height:128px}button{position:absolute;left:800px;top:400px;width:160px;height:48px}</style>' + body + '<button>Continue</button>');
  if (designMode) await f.entry.page.evaluate(() => { document.designMode = 'on'; });
  await f.entry.page.locator('img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
  const box = await f.entry.page.locator('#leak').boundingBox();
  const raw = PNG.sync.read(await f.entry.page.screenshot({ type: 'png', scale: 'css', caret: 'hide' }));
  const expected = designMode ? Buffer.alloc(raw.data.length) : reference(raw, name.includes('header') || name === 'sibling QR' ? 60 : 40);
  if (designMode) for (let at = 3; at < expected.length; at += 4) expected[at] = 255;
  const target = await f.entry.page.locator('button').elementHandle();
  t.after(() => target.dispose());
  const frame = await captureRecordingFrame(f.entry, { pages: f.registry, current: () => true, target: { handle: target } });
  const recovered = different(frame, expected, box);
  t.diagnostic(`${name}: ${recovered} pixels differ from the masked reference`);
  assert.equal(recovered, 0, `${name}: recoverable pixels`);
  await gradeSaved(t, frame, expected, box);
});

test('only the held control is clear; fields and opaque descendants stay black', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>body{margin:0;background:#aaa;font:20px monospace}button{position:absolute;left:160px;top:160px;width:320px;height:160px;background:white;color:black}input{position:absolute;left:600px;top:80px;width:240px;height:48px;background:red;color:red}img{width:80px;height:40px}</style><button>Continue 1234<img src="data:image/svg+xml,' + encodeURIComponent(qr) + '"></button><input value=secret>');
  await f.entry.page.locator('img').evaluate(img => img.decode());
  const handle = await f.entry.page.locator('button').elementHandle();
  t.after(() => handle.dispose());
  const raw = PNG.sync.read(await f.entry.page.screenshot({ type: 'png', scale: 'css', caret: 'hide' }));
  const frame = await captureRecordingFrame(f.entry, { pages: f.registry, current: () => true, target: { handle } });
  const button = await handle.boundingBox(), image = await f.entry.page.locator('img').boundingBox(), input = await f.entry.page.locator('input').boundingBox();
  const clear = { x: button.x + 8, y: button.y + 8, width: 80, height: button.height - 16 };
  assert.equal(different(frame, raw.data, clear), 0, 'held control pixels are clear');
  const black = Buffer.alloc(frame.data.length); for (let i = 3; i < black.length; i += 4) black[i] = 255;
  for (const box of [image, input]) assert.equal(different(frame, black, { x: box.x + 4, y: box.y + 4, width: box.width - 8, height: box.height - 8 }), 0);
  assert.deepEqual([...frame.data.subarray(((160 - 2) * frame.width + 200) * 4, ((160 - 2) * frame.width + 200) * 4 + 3)], [0, 255, 255], 'target outline');
  const point = f.entry.page._connection.toImpl(f.entry.page).mouse._currentPoint();
  assert.deepEqual([...frame.data.subarray(((Math.round(point.y) + 7) * frame.width + Math.round(point.x) + 2) * 4, ((Math.round(point.y) + 7) * frame.width + Math.round(point.x) + 2) * 4 + 3)], [255, 255, 255], 'pointer position');
});

test('targeted fields, editable controls and opaque media are black', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>body{margin:0}#targets>*{display:none;position:absolute;left:160px;top:160px;width:240px;height:64px;border:0;background:red;color:red}</style><div id=targets><input value=1234><textarea>address</textarea><select><option>Visa ending 4242</option></select><div contenteditable>987654</div><div role=textbox>987654</div><iframe srcdoc="<body style=background:red>1234</body>"></iframe><canvas></canvas><img src="data:image/svg+xml,' + encodeURIComponent(qr) + '"><svg><rect width=240 height=64 fill=red /></svg><video></video></div>');
  const handles = await f.entry.page.locator('#targets > *').elementHandles();
  t.after(async () => { for (const handle of handles) await handle.dispose(); });
  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];
    await handle.evaluate(el => { el.style.display = 'block'; });
    const frame = await captureRecordingFrame(f.entry, { pages: f.registry, current: () => true, target: { handle } });
    const black = Buffer.alloc(frame.data.length); for (let at = 3; at < black.length; at += 4) black[at] = 255;
    assert.equal(different(frame, black, { x: 170, y: 170, width: 220, height: 44 }), 0, 'black target ' + i);
    await handle.evaluate(el => { el.style.display = 'none'; });
  }
});

test('one isolated box query per frame; main-world tampering cannot hide fields', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<input value=4242 style="position:absolute;left:160px;top:160px;width:200px;height:50px;background:red">');
  await f.entry.page.evaluate(() => { Document.prototype.querySelectorAll = () => []; Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 }); });
  const utility = await f.entry.page._connection.toImpl(f.entry.page).mainFrame().utilityContext();
  await utility.evaluateExpression(`() => { const query = Document.prototype.querySelectorAll; globalThis.recordingQueries = []; Document.prototype.querySelectorAll = function(s) { globalThis.recordingQueries.push(s); return query.call(this, s); }; }`, { isFunction: true });
  // Recorder alone must never invoke DOMSnapshot, even on a page full of text.
  const attach = f.context.newCDPSession.bind(f.context), methods = [];
  f.context.newCDPSession = async (...args) => {
    const cdp = await attach(...args), send = cdp.send.bind(cdp);
    cdp.send = (method, ...params) => { methods.push(method); assert.notEqual(method, 'DOMSnapshot.captureSnapshot'); return send(method, ...params); };
    return cdp;
  };
  t.after(() => { f.context.newCDPSession = attach; });
  const frame = await captureRecordingFrame(f.entry, { pages: f.registry, current: () => true });
  const queries = await utility.evaluateExpression('globalThis.recordingQueries', { isFunction: false });
  assert.equal(queries.length, 1); assert.notEqual(queries[0], '*'); assert.ok(queries[0].includes('input'));
  const black = Buffer.alloc(frame.data.length); for (let at = 3; at < black.length; at += 4) black[at] = 255;
  assert.equal(different(frame, black, { x: 170, y: 170, width: 180, height: 30 }), 0);
  assert.ok(methods.includes('Runtime.evaluate'), 'resume was confirmed with a renderer probe');
});

test('the 50 ms isolated read budget skips a slow geometry read and resumes scripts', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<input value=4242>');
  const utility = await f.entry.page._connection.toImpl(f.entry.page).mainFrame().utilityContext();
  await utility.evaluateExpression(`() => { const rect = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function() { const until = performance.now() + 60; while (performance.now() < until) {} return rect.call(this); }; }`, { isFunction: true });
  await assert.rejects(captureRecordingFrame(f.entry, { pages: f.registry, current: () => true }), /RECORDING_TREE_LIMIT/);
  assert.equal(await f.entry.page.evaluate(() => 1 + 1), 2);
});

test('native viewport capture keeps content-scaled CSS blocks at device scale two', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>body{margin:0;font:20px monospace}</style><p id=leak>Visa ending 4242, address 7 Test Street</p>', {}, { deviceScaleFactor: 2 });
  const cdp = await f.context.newCDPSession(f.entry.page);
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1280, height: 720, scale: 0.5 } });
    const raw = PNG.sync.read(Buffer.from(shot.data, 'base64'));
    const frame = await captureRecordingFrame(f.entry, { pages: f.registry, current: () => true });
    assert.equal(frame.width, 1280); assert.equal(frame.height, 720);
    const expected = reference(raw);
    assert.equal(await f.entry.page.evaluate(() => devicePixelRatio), 2);
    assert.equal(raw.width, 1280); assert.equal(raw.height, 720);
    assert.equal(different(frame, expected, { x: 32, y: 16, width: 600, height: 64 }), 0);
  } finally { await cdp.detach(); }
});

test('a control containing a standard closed shadow host cannot reveal hidden fields', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<button style="position:absolute;left:160px;top:160px;width:320px;height:100px"><span id=host></span></button>');
  await f.entry.page.evaluate(() => { document.querySelector('#host').attachShadow({ mode: 'closed' }).innerHTML = '<input value="4242424242424242" style="background:red;width:240px;height:50px">'; });
  const handle = await f.entry.page.locator('button').elementHandle();
  t.after(() => handle.dispose());
  const frame = await captureRecordingFrame(f.entry, { pages: f.registry, current: () => true, target: { handle } });
  const black = Buffer.alloc(frame.data.length); for (let at = 3; at < black.length; at += 4) black[at] = 255;
  assert.equal(different(frame, black, { x: 170, y: 170, width: 300, height: 80 }), 0);
});
