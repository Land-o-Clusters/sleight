import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as relay from '../plugins/sleight/lib/relay.mjs';

const image = (width, height) => {
  const bytes = Buffer.alloc(25);
  bytes.writeUInt32BE(0x89504e47); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') };
};
const note = (width, height, scale) => ({ type: 'text', text:
  `Screenshot frame: ${width}x${height} pixels; window bounds (-320.0, 41.5, 120.0, 80.0) points; scale ${scale}x${scale} pixels per point; origin top-left; window-only, overlays excluded.` });
const target = { app: 'Fixture', title: 'Covered' };

for (const [width, height, scale] of [[120, 80, '1.0000'], [240, 160, '2.0000'], [150, 100, '1.2500']]) {
  test(`frame reader retains ${scale} pixel-to-point geometry and a negative screen origin`, () => {
    const content = [note(width, height, scale), image(width, height)];
    assert.equal(typeof relay.screenshotFrame, 'function');
    assert.deepEqual(relay.screenshotFrame(content), {
      windowBounds: { x: -320, y: 41.5, width: 120, height: 80 },
      pixelWidth: width, pixelHeight: height, scaleX: Number(scale), scaleY: Number(scale),
    });
    assert.deepEqual(relay.screenshotOf(content, target), ['Fixture', { width, height }, 'Covered']);
  });
}
for (const [name, content] of [
  ['mismatched image dimensions', [note(240, 160, '2.0000'), image(120, 80)]],
  ['incorrect scale', [note(120, 80, '2.0000'), image(120, 80)]],
  ['two frame notes', [note(120, 80, '1.0000'), note(120, 80, '1.0000'), image(120, 80)]],
  ['invalid bounds', [{ type: 'text', text: note(120, 80, '1.0000').text.replace('120.0, 80.0', '0.0, 80.0') }, image(120, 80)]],
  ['malformed frame', [{ type: 'text', text: 'Screenshot frame: invalid' }, image(120, 80)]],
]) test(`frame reader refuses ${name} instead of recording misleading coordinate geometry`, () => {
  assert.equal(typeof relay.screenshotFrame, 'function');
  assert.equal(relay.screenshotFrame(content), undefined);
  assert.equal(relay.screenshotOf(content, target), undefined);
});
test('engine images without a native frame note retain their existing association', () => {
  assert.deepEqual(relay.screenshotOf([image(240, 160)], target), ['Fixture', { width: 240, height: 160 }, 'Covered']);
});
test('engine results keep their association when a text line merely starts with the frame prefix', () => {
  const content = [{ type: 'text', text: 'Screenshot frame: invalid' }, image(240, 160)];
  assert.deepEqual(relay.screenshotOf(content, target, { ownFrame: false }), ['Fixture', { width: 240, height: 160 }, 'Covered']);
  assert.equal(relay.screenshotOf(content, target), undefined);
});

test('rounded note ratios preserve the actual scale of fractional point bounds', () => {
  const text = note(120, 80, '1.0000').text.replace('120.0, 80.0', '119.75, 79.75').replace('1.0000x1.0000', '1.0021x1.0031');
  assert.equal(typeof relay.screenshotFrame, 'function');
  assert.deepEqual(relay.screenshotFrame([{ type: 'text', text }, image(120, 80)]), {
    windowBounds: { x: -320, y: 41.5, width: 119.75, height: 79.75 }, pixelWidth: 120, pixelHeight: 80,
    scaleX: 120 / 119.75, scaleY: 80 / 79.75,
  });
});
