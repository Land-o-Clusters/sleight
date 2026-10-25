import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { PNG, average, differences, inset, rawFrame, record, savedGrade, recognize, imageGrader } from './fixtures/recording-grade.mjs';

const cases = [
  ['pointer-transparent toast', '<button id=target>Continue</button><div id=leak class=toast style="pointer-events:none">Visa ending 4242</div>', 48],
  ['36 px toast with a 48 px heading', '<h1>Account</h1><button id=target>Continue</button><div id=leak class=toast style="height:36px;top:183px">Visa ending 4242</div>', 96],
  ['link-wrapped list', '<a id=target href="#"><ul id=leak><li>Ada Example, 7 Test Street</li></ul></a>', 48],
  ['link-wrapped table', '<a id=target href="#"><table id=leak><tr><td>Ada Example, 7 Test Street</td></tr></table></a>', 48],
  ['paragraph button role', '<p id=target role=button>Visa ending 4242, 7 Test Street</p>', 48],
  ['control label with email', '<button id=target>Continue as alice@example.com</button>', 48],
];
for (const dpr of [1, 2]) for (const [name, html, block] of cases) test(`${name}, DPR ${dpr}: target has an outline and no clear pixels`, { skip, timeout: 120000 }, async t => {
  const f = await fixture(t, `<style>body{margin:0;background:#ccc;font:24px monospace}h1{font:48px monospace;margin:0}
    #target{display:block;margin:0;box-sizing:border-box;position:absolute;left:160px;top:160px;width:640px;height:240px;background:white;color:black;border:0;font:24px monospace}
    .toast{position:fixed;z-index:9;left:200px;top:200px;height:64px;background:white;color:black;font:24px monospace}
    ul,table{margin:24px;font:24px monospace}</style>${html}`, {}, { deviceScaleFactor: dpr });
  const handle = await f.entry.page.locator('#target').elementHandle(); t.after(() => handle.dispose());
  // A clear region must not depend on sampling elementFromPoint, even in the isolated world.
  const utility = await f.entry.page._connection.toImpl(f.entry.page).mainFrame().utilityContext();
  await utility.evaluateExpression('() => { Document.prototype.elementFromPoint = () => { throw Error("recording hit test removed"); }; }', { isFunction: true });
  const raw = await rawFrame(f.entry.page), expected = average(raw, block), frame = await record(f, handle, t);
  const box = inset(await handle.boundingBox());
  assert.equal(differences(frame, expected, box), 0, 'entire target interior matches pixelation');
  const at = ((160 - 2) * frame.width + 200) * 4;
  assert.deepEqual([...frame.data.subarray(at, at + 4)], [0, 255, 255, 255], 'synthetic target outline');
  const source = recognize(t, PNG.sync.write(raw));
  if (source) assert.ok(source.text.length > 0, 'OCR reads source text');
  await savedGrade(t, frame, expected, box);
});

for (const dpr of [1, 2]) for (const moduleSize of [24, 40]) test(`target QR ${moduleSize} px, DPR ${dpr}: no clear payload`, { skip, timeout: 120000 }, async t => {
  const tool = imageGrader(t);
  if (!tool) return t.skip('Core Image QR fixture generator requires macOS');
  const path = join(tool.dir, 'target-qr.png');
  const made = spawnSync(tool.executable, ['qr', String(moduleSize), path], { encoding: 'utf8', timeout: 15000 });
  assert.equal(made.status, 0, made.stderr);
  const f = await fixture(t, `<style>body{margin:0;background:white;font:20px monospace}a{position:absolute;left:40px;top:40px}</style>
    <a id=target href="#"><img src="data:image/png;base64,${readFileSync(path).toString('base64')}"></a>`, {}, { deviceScaleFactor: dpr });
  await f.entry.page.setViewportSize({ width: 1800, height: 1700 });
  await f.entry.page.locator('img').evaluate(img => img.decode());
  const handle = await f.entry.page.locator('#target').elementHandle(); t.after(() => handle.dispose());
  const raw = await rawFrame(f.entry.page), frame = await record(f, handle, t), box = inset(await handle.boundingBox());
  const original = recognize(t, PNG.sync.write(raw), 'decode-qr');
  assert.ok(original.qr.includes('https://fixture.invalid/4242'), 'source QR decodes');
  const expected = average(raw, 57);
  assert.equal(differences(frame, expected, box), 0);
  await savedGrade(t, frame, expected, box);
});
