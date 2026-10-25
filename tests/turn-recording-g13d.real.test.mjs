import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { createTurnRecording } from '../plugins/sleight/lib/turn-recording.mjs';
import { PNG, average, differences, inset, rawFrame, record, savedGrade, recognize, imageGrader } from './fixtures/recording-grade.mjs';

for (const overlay of ['popup', 'toast', 'sticky header']) test(`${overlay} over the target remains pixelated`, { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, `<style>body{margin:0;background:#ccc;font:20px monospace}button{position:absolute;left:160px;top:160px;width:480px;height:240px;background:white;font:20px monospace}
    #leak{position:${overlay === 'sticky header' ? 'sticky' : 'fixed'};z-index:9;left:240px;top:200px;width:240px;height:80px;background:#fff;color:#000}</style>
    <button id=target><b>Continue</b></button><div id=leak>Visa ending 4242<br>ada@example.com</div>`);
  if (overlay === 'sticky header') await f.entry.page.locator('#leak').evaluate(el => { el.style.marginLeft = '240px'; });
  // Main-world hit-test tampering must not make the overlay count as the button.
  await f.entry.page.evaluate(() => { Document.prototype.elementFromPoint = () => document.querySelector('button'); });
  const handle = await f.entry.page.locator('#target').elementHandle(); t.after(() => handle.dispose());
  const raw = await rawFrame(f.entry.page), expected = average(raw, 40), frame = await record(f, handle, t);
  const leak = inset(await f.entry.page.locator('#leak').boundingBox());
  const n = differences(frame, expected, leak); t.diagnostic(`${overlay}: ${n} differing pixels`);
  assert.equal(n, 0, 'overlay stays pixelated');
  assert.equal(differences(frame, expected, { x: 176, y: 320, width: 48, height: 48 }), 0, 'uncovered control stays pixelated');
  await savedGrade(t, frame, expected, leak);
});

for (const size of [96, 128, 200]) test(`${size} px visible text scales pixelation to ${size * 2} px`, { skip, timeout: 240000 }, async t => {
  const f = await fixture(t, `<style>body{margin:0;background:white;font:16px monospace}#leak{position:absolute;left:32px;top:80px;font:${size}px monospace}button{position:absolute;left:960px;top:600px;font:16px monospace}</style><div id=leak>4242</div><button>Continue</button>`);
  const handle = await f.entry.page.locator('button').elementHandle(); t.after(() => handle.dispose());
  const raw = await rawFrame(f.entry.page), expected = average(raw, size * 2), frame = await record(f, handle, t);
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

for (const moduleSize of [4, 8, 12, 16, 20, 24, 32]) test(`QR with ${moduleSize} px modules loses its payload`, { skip, timeout: 90000 }, async t => {
  const tool = imageGrader(t);
  if (!tool) return t.skip('Core Image QR fixture generator requires macOS');
  const path = join(tool.dir, 'qr.png');
  const made = spawnSync(tool.executable, ['qr', String(moduleSize), path], { encoding: 'utf8', timeout: 15000 });
  assert.equal(made.status, 0, made.stderr);
  const bytes = readFileSync(path);
  const f = await fixture(t, `<style>body{margin:0;background:white;font:20px monospace}img{position:absolute;left:40px;top:40px}</style><img id=leak src="data:image/png;base64,${bytes.toString('base64')}">`);
  await f.entry.page.setViewportSize({ width: 1280, height: 1200 });
  await f.entry.page.locator('img').evaluate(img => img.decode());
  const raw = await rawFrame(f.entry.page), frame = await record(f, undefined, t), box = inset(await f.entry.page.locator('img').boundingBox());
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
  const raw = await rawFrame(f.entry.page), expected = average(raw, 40), frame = await record(f, handle, t), box = inset(await handle.boundingBox());
  assert.equal(differences(frame, expected, box), 0, `${tag} cannot reveal its content`);
  await savedGrade(t, frame, expected, box);
});

for (const width of [640, 641]) test(`control area ${width === 640 ? 'at' : 'above'} 25% of the viewport remains pixelated`, { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, `<style>body{margin:0;background:#aaa;font:20px monospace}button{position:absolute;left:160px;top:160px;width:${width}px;height:360px;background:white;font:20px monospace}</style><button>Visa ending 4242</button>`);
  const handle = await f.entry.page.locator('button').elementHandle(); t.after(() => handle.dispose());
  const raw = await rawFrame(f.entry.page), frame = await record(f, handle, t), box = inset(await handle.boundingBox());
  assert.equal(differences(frame, average(raw, 40), box), 0);
});

test('native, explicit control, text and layout roles all stay pixelated', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>body{margin:0;font:20px monospace}#target{display:block;position:absolute;left:160px;top:160px;width:240px;height:80px;background:#eee}</style><div id=target>Continue 4242</div>');
  const handle = await f.entry.page.locator('#target').elementHandle(); t.after(() => handle.dispose());
  const box = { x: 164, y: 164, width: 232, height: 72 };
  for (const role of ['button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'option', 'summary', 'list', 'table', 'row', 'form', 'generic']) {
    await handle.evaluate((el, role) => { el.setAttribute('role', role); }, role);
    const raw = await rawFrame(f.entry.page), frame = await record(f, handle, t);
    assert.equal(differences(frame, average(raw, 40), box), 0, role);
  }
  for (const markup of ['<button id=target>Continue 4242</button>', '<a id=target href="#next">Continue 4242</a>', '<details open><summary id=target>Continue 4242</summary></details>']) {
    await f.entry.page.evaluate(markup => { document.body.innerHTML = markup; }, markup);
    const native = await f.entry.page.locator('#target').elementHandle();
    try {
      const raw = await rawFrame(f.entry.page), frame = await record(f, native, t);
      assert.equal(differences(frame, average(raw, 40), inset(await native.boundingBox())), 0, markup);
    } finally { await native.dispose(); }
  }
});

test('minimum and viewport block sizes ignore hidden and offscreen large fonts', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>body{margin:0;background:white;font:12px monospace}#leak{position:absolute;left:40px;top:80px}.hidden{display:none;font-size:200px}.offscreen{position:absolute;left:10000px;font-size:200px}</style><div id=leak>Visa ending 4242</div><div class=hidden>Hidden</div><div class=offscreen>Offscreen</div>');
  for (const [width, height, size] of [[1280, 720, 32], [1800, 1500, 50]]) {
    await f.entry.page.setViewportSize({ width, height });
    const raw = await rawFrame(f.entry.page), frame = await record(f, undefined, t), expected = average(raw, size);
    assert.equal(differences(frame, expected, inset(await f.entry.page.locator('#leak').boundingBox(), 1)), 0, `${width} by ${height}`);
  }
});

test('field query ignores thousands of ordinary layout elements', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>body{font:16px monospace}</style>' + '<div></div>'.repeat(6000) + '<input style="position:absolute;left:160px;top:160px;width:200px;height:50px;background:red" value=4242>');
  const frame = await record(f, undefined, t);
  const black = Buffer.alloc(frame.data.length); for (let i = 3; i < black.length; i += 4) black[i] = 255;
  assert.equal(differences(frame, black, { x: 170, y: 170, width: 180, height: 30 }), 0);
});

test('5,000 fields record; a page above the field cap skips and says so', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<style>input{display:none}body{font:16px monospace}</style>' + '<input>'.repeat(5000));
  const frame = await record(f, undefined, t); assert.equal(frame.width, 1280);
  await f.entry.page.evaluate(() => { document.body.append(document.createElement('input')); });
  const recorder = createTurnRecording({ current: () => true, capture: () => record(f, undefined, t), createFile: () => assert.fail('over-cap frame cannot reach disk') });
  await recorder.capture(f.entry); await recorder.end();
  assert.match(recorder.note(), /1 skipped/); assert.match(recorder.note(), /5,000|5000|field cap/);
  assert.equal(await f.entry.page.evaluate(() => 1 + 1), 2, 'scripts resumed after the cap skip');
});
