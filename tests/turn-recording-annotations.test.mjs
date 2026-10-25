import test from 'node:test';
import assert from 'node:assert/strict';
import { maskRecordingPixels } from '../plugins/sleight/lib/direct-browser/recording.mjs';
import { PNG, recognize, savedGrade, gradeSkip } from './fixtures/recording-grade.mjs';

test('blank layout and annotations can produce OCR glyphs without source text', { skip: gradeSkip(), timeout: 180000 }, async t => {
  const width = 1280, height = 720, data = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = x >= 160 && x < 800 && y >= 160 && y < 400;
    data.set(inside ? [255, 255, 255, 255] : [204, 204, 204, 255], (y * width + x) * 4);
  }
  const frame = maskRecordingPixels({ width, height, data }, { fields: [], blockSize: 48 }, { rect: [160, 160, 640, 240] }, { x: 0, y: 0 });
  const whole = recognize(t, PNG.sync.write(frame));
  if (whole) {
    t.diagnostic('blank annotated frame OCR: ' + JSON.stringify(whole));
    assert.equal(whole.text.some(text => /Visa|4242|alice|Street/.test(text)), false);
  }
  await savedGrade(t, frame, frame.data, { x: 164, y: 164, width: 632, height: 232 });
  const colour = (x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
  assert.deepEqual(colour(200, 158), [0, 255, 255], 'target outline');
  assert.deepEqual(colour(2, 7), [255, 255, 255], 'pointer interior');
});
