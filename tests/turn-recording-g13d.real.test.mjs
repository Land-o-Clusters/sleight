import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { captureRecordingFrame } from '../plugins/sleight/lib/direct-browser/recording.mjs';
import { createTurnRecording } from '../plugins/sleight/lib/turn-recording.mjs';

// Optional macOS image decoders operate only on synthetic fixture pixels.
let grader;
test.after(() => { if (grader) rmSync(grader.dir, { recursive: true, force: true }); });
function imageGrader(t) {
  if (process.platform !== 'darwin') return undefined;
  if (!grader) {
    const dir = mkdtempSync(join(tmpdir(), 'sleight-g13d-decoder-'));
    const executable = join(dir, 'grade');
    grader = { dir, executable, images: 0 };
    const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(dir, 'cache'),
      new URL('./fixtures/recording-image-grade.swift', import.meta.url).pathname, '-o', executable], {
      encoding: 'utf8', timeout: 120000, env: { ...process.env, DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' } });
    assert.equal(compiled.status, 0, `${compiled.error?.code ?? compiled.signal ?? ''}\n${compiled.stderr}`);
  }
  return grader;
}
function recognize(t, data, mode = 'ocr') {
  const tool = imageGrader(t);
  if (!tool) return undefined;
  const path = join(tool.dir, `image-${tool.images++}.png`); writeFileSync(path, data);
  const result = spawnSync(tool.executable, [mode, path], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.error?.code ?? result.signal ?? ''}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

const require = createRequire(import.meta.url);
const { PNG } = require('../plugins/sleight/vendor/playwright-core/lib/utilsBundle.js');
// Independent image reference. The fixture supplies the expected CSS block size.
function average(raw, size) {
  const data = Buffer.from(raw.data);
  for (let y = 0; y < raw.height; y += size) for (let x = 0; x < raw.width; x += size) {
    const endX = Math.min(x + size, raw.width), endY = Math.min(y + size, raw.height), sums = [0, 0, 0];
    for (let j = y; j < endY; j++) for (let i = x; i < endX; i++)
      for (let c = 0; c < 3; c++) sums[c] += raw.data[(j * raw.width + i) * 4 + c];
    const colour = [...sums.map(sum => Math.round(sum / ((endX - x) * (endY - y)))), 255];
    for (let j = y; j < endY; j++) for (let i = x; i < endX; i++) data.set(colour, (j * raw.width + i) * 4);
  }
  return data;
}
function differences(frame, reference, box) {
  let count = 0;
  for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y++)
    for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
      const at = (y * frame.width + x) * 4;
      if (frame.data.subarray(at, at + 4).some((value, i) => value !== reference[at + i])) count++;
    }
  return count;
}
const inset = (box, n = 4) => ({ x: box.x + n, y: box.y + n, width: box.width - 2 * n, height: box.height - 2 * n });
async function rawFrame(page) { return PNG.sync.read(await page.screenshot({ type: 'png', scale: 'css', caret: 'hide' })); }
async function record(f, handle) {
  return captureRecordingFrame(f.entry, { pages: f.registry, current: () => true, target: handle ? { handle } : undefined });
}
async function savedGrade(t, frame, reference, box) {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-g13d-grade-')), path = join(dir, 'actions.gif');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recorder = createTurnRecording({ current: () => true, capture: async () => frame,
    createFile: () => ({ path, fd: openSync(path, 'wx', 0o600) }) });
  await recorder.capture({ state: {} }); await recorder.end();
  const result = spawnSync('python3', ['-c', `from PIL import Image
import sys,json,math
w,h,box=json.loads(sys.argv[2]); raw=sys.stdin.buffer.read(); im=Image.open(sys.argv[1]).convert('RGB')
s=min(1,640/w,480/h); left=(640-math.floor(w*s))//2; top=(480-math.floor(h*s))//2; count=0
for y in range(math.ceil(box['y']*s)+top,math.floor((box['y']+box['height'])*s)+top):
 for x in range(math.ceil(box['x']*s)+left,math.floor((box['x']+box['width'])*s)+left):
  at=(min(h-1,math.floor((y-top)/s))*w+min(w-1,math.floor((x-left)/s)))*4
  r,g,b=raw[at:at+3]; want=(round((r>>5)*255/7),round((g>>5)*255/7),round((b>>6)*255/3))
  count+=im.getpixel((x,y))!=want
print(count)
assert count==0,('unmasked GIF pixels',count)
`, path, JSON.stringify([frame.width, frame.height, box])], { input: reference, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  t.diagnostic(`saved GIF: ${result.stdout.trim()} differing pixels`);
  return readFileSync(path);
}

for (const overlay of ['popup', 'toast', 'sticky header']) test(`${overlay} over the target remains pixelated`, { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, `<style>body{margin:0;background:#ccc;font:20px monospace}button{position:absolute;left:160px;top:160px;width:480px;height:240px;background:white;font:20px monospace}
    #leak{position:${overlay === 'sticky header' ? 'sticky' : 'fixed'};z-index:9;left:240px;top:200px;width:240px;height:80px;background:#fff;color:#000}</style>
    <button id=target><b>Continue</b></button><div id=leak>Visa ending 4242<br>ada@example.com</div>`);
  if (overlay === 'sticky header') await f.entry.page.locator('#leak').evaluate(el => { el.style.marginLeft = '240px'; });
  // Main-world hit-test tampering must not make the overlay count as the button.
  await f.entry.page.evaluate(() => { Document.prototype.elementFromPoint = () => document.querySelector('button'); });
  const handle = await f.entry.page.locator('#target').elementHandle(); t.after(() => handle.dispose());
  const raw = await rawFrame(f.entry.page), expected = average(raw, 40), frame = await record(f, handle);
  const leak = inset(await f.entry.page.locator('#leak').boundingBox());
  const n = differences(frame, expected, leak); t.diagnostic(`${overlay}: ${n} differing pixels`);
  assert.equal(n, 0, 'overlay is not part of the clear control');
  assert.equal(differences(frame, raw.data, { x: 176, y: 320, width: 48, height: 48 }), 0, 'uncovered control stays clear');
  await savedGrade(t, frame, expected, leak);
});

for (const size of [96, 128, 200]) test(`${size} px visible text scales pixelation to ${size * 2} px`, { skip, timeout: 240000 }, async t => {
  const f = await fixture(t, `<style>body{margin:0;background:white;font:16px monospace}#leak{position:absolute;left:32px;top:80px;font:${size}px monospace}button{position:absolute;left:960px;top:600px;font:16px monospace}</style><div id=leak>4242</div><button>Continue</button>`);
  const handle = await f.entry.page.locator('button').elementHandle(); t.after(() => handle.dispose());
  const raw = await rawFrame(f.entry.page), expected = average(raw, size * 2), frame = await record(f, handle);
  const box = inset(await f.entry.page.locator('#leak').boundingBox());
  const n = differences(frame, expected, box); t.diagnostic(`${size} px text: ${n} differing pixels`);
  assert.equal(n, 0, 'large text uses content-scaled blocks');
  const original = recognize(t, PNG.sync.write(raw)), masked = recognize(t, PNG.sync.write(frame));
  if (original) {
    assert.ok(original.text.join(' ').includes('4242'), 'OCR reads the original fixture');
    assert.equal(masked.text.some(text => /4242/.test(text)), false, 'OCR cannot recover the fixture digits');
    t.diagnostic(`Vision fast OCR ${size} px: original digits readable, masked digits unreadable`);
  }
  const gif = await savedGrade(t, frame, expected, box);
  if (original) assert.equal(recognize(t, gif).text.some(text => /4242/.test(text)), false, 'saved GIF does not recover the fixture digits');
});

for (const moduleSize of [16, 24, 32]) test(`QR with ${moduleSize} px modules loses its payload`, { skip, timeout: 90000 }, async t => {
  const tool = imageGrader(t);
  if (!tool) return t.skip('Core Image QR fixture generator requires macOS');
  const path = join(tool.dir, 'qr.png');
  const made = spawnSync(tool.executable, ['qr', String(moduleSize), path], { encoding: 'utf8', timeout: 15000 });
  assert.equal(made.status, 0, made.stderr);
  const bytes = readFileSync(path);
  const f = await fixture(t, `<style>body{margin:0;background:white;font:20px monospace}img{position:absolute;left:40px;top:40px}</style><img id=leak src="data:image/png;base64,${bytes.toString('base64')}">`);
  await f.entry.page.setViewportSize({ width: 1280, height: 1200 });
  await f.entry.page.locator('img').evaluate(img => img.decode());
  const raw = await rawFrame(f.entry.page), frame = await record(f), box = inset(await f.entry.page.locator('img').boundingBox());
  const original = recognize(t, PNG.sync.write(raw), 'decode-qr'), masked = recognize(t, PNG.sync.write(frame), 'decode-qr');
  assert.ok(original.qr.includes('https://fixture.invalid/4242'), 'decoder reads the original QR');
  assert.deepEqual(masked.qr, [], 'decoder cannot recover the masked QR');
  const expected = average(raw, 40);
  assert.equal(differences(frame, expected, box), 0);
  t.diagnostic(`QR ${moduleSize} px modules: original decoded, masked payload absent`);
  const gif = await savedGrade(t, frame, expected, box);
  assert.deepEqual(recognize(t, gif, 'decode-qr').qr, [], 'saved GIF does not recover the QR payload');
});

for (const tag of ['ul', 'table', 'tr', 'form', 'div']) test(`a targeted ${tag} is pixelated`, { skip, timeout: 30000 }, async t => {
  const content = tag === 'table' || tag === 'tr' ? '<td>Visa ending 4242, Ada Example</td>' : 'Visa ending 4242, Ada Example';
  const target = `<${tag} id=target>${content}</${tag}>`;
  const f = await fixture(t, `<style>body{margin:0;background:white;font:20px monospace}#target{position:absolute;left:160px;top:160px;width:640px;height:240px;background:#eee;font:20px monospace}</style>${tag === 'tr' ? '<table>' + target + '</table>' : target}`);
  const handle = await f.entry.page.locator('#target').elementHandle(); t.after(() => handle.dispose());
  const raw = await rawFrame(f.entry.page), expected = average(raw, 40), frame = await record(f, handle), box = inset(await handle.boundingBox());
  assert.equal(differences(frame, expected, box), 0, `${tag} cannot reveal its content`);
  await savedGrade(t, frame, expected, box);
});

for (const [width, clear] of [[640, true], [641, false]]) test(`control area ${clear ? 'at' : 'above'} 25% of the viewport`, { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, `<style>body{margin:0;background:#aaa;font:20px monospace}button{position:absolute;left:160px;top:160px;width:${width}px;height:360px;background:white;font:20px monospace}</style><button>Visa ending 4242</button>`);
  const handle = await f.entry.page.locator('button').elementHandle(); t.after(() => handle.dispose());
  const raw = await rawFrame(f.entry.page), frame = await record(f, handle), box = inset(await handle.boundingBox());
  assert.equal(differences(frame, clear ? raw.data : average(raw, 40), box), 0);
});

test('native and explicit control roles can be clear; text and layout roles cannot', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>body{margin:0;font:20px monospace}#target{display:block;position:absolute;left:160px;top:160px;width:240px;height:80px;background:#eee}</style><div id=target>Continue 4242</div>');
  const handle = await f.entry.page.locator('#target').elementHandle(); t.after(() => handle.dispose());
  const box = { x: 164, y: 164, width: 232, height: 72 };
  for (const role of ['button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'option', 'summary', 'list', 'table', 'row', 'form', 'generic']) {
    await handle.evaluate((el, role) => { el.setAttribute('role', role); }, role);
    const raw = await rawFrame(f.entry.page), frame = await record(f, handle);
    const clear = ['button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'option', 'summary'].includes(role);
    assert.equal(differences(frame, clear ? raw.data : average(raw, 40), box), 0, role);
  }
  for (const markup of ['<button id=target>Continue 4242</button>', '<a id=target href="#next">Continue 4242</a>', '<details open><summary id=target>Continue 4242</summary></details>']) {
    await f.entry.page.evaluate(markup => { document.body.innerHTML = markup; }, markup);
    const native = await f.entry.page.locator('#target').elementHandle();
    try {
      const raw = await rawFrame(f.entry.page), frame = await record(f, native);
      assert.equal(differences(frame, raw.data, inset(await native.boundingBox())), 0, markup);
    } finally { await native.dispose(); }
  }
});

test('minimum and viewport block sizes ignore hidden and offscreen large fonts', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>body{margin:0;background:white;font:12px monospace}#leak{position:absolute;left:40px;top:80px}.hidden{display:none;font-size:200px}.offscreen{position:absolute;left:10000px;font-size:200px}</style><div id=leak>Visa ending 4242</div><div class=hidden>Hidden</div><div class=offscreen>Offscreen</div>');
  for (const [width, height, size] of [[1280, 720, 32], [1800, 1500, 50]]) {
    await f.entry.page.setViewportSize({ width, height });
    const raw = await rawFrame(f.entry.page), frame = await record(f), expected = average(raw, size);
    assert.equal(differences(frame, expected, inset(await f.entry.page.locator('#leak').boundingBox(), 1)), 0, `${width} by ${height}`);
  }
});

test('field query ignores thousands of ordinary layout elements', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>body{font:16px monospace}</style>' + '<div></div>'.repeat(6000) + '<input style="position:absolute;left:160px;top:160px;width:200px;height:50px;background:red" value=4242>');
  const frame = await record(f);
  const black = Buffer.alloc(frame.data.length); for (let i = 3; i < black.length; i += 4) black[i] = 255;
  assert.equal(differences(frame, black, { x: 170, y: 170, width: 180, height: 30 }), 0);
});

test('5,000 fields record; a page above the field cap skips and says so', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>input{display:none}body{font:16px monospace}</style>' + '<input>'.repeat(5000));
  const frame = await record(f); assert.equal(frame.width, 1280);
  await f.entry.page.evaluate(() => { document.body.append(document.createElement('input')); });
  const recorder = createTurnRecording({ current: () => true, capture: () => record(f), createFile: () => assert.fail('over-cap frame cannot reach disk') });
  await recorder.capture(f.entry); await recorder.end();
  assert.match(recorder.note(), /1 skipped/); assert.match(recorder.note(), /5,000|5000|field cap/);
  assert.equal(await f.entry.page.evaluate(() => 1 + 1), 2, 'scripts resumed after the cap skip');
});
