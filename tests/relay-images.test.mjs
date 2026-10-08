import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropRepeatedImages } from '../plugins/sleight/lib/relay.mjs';

const image = (data, mimeType = 'image/png') => ({ type: 'image', data, mimeType });

test('a screenshot shown twice in one result reaches Claude once, with a note', () => {
  const out = dropRepeatedImages([{ type: 'text', text: 'ok' }, image('AAA', 'image/jpeg'), image('AAA'), image('BBB')]);
  assert.deepEqual(out.filter(b => b.type === 'image').map(b => b.data), ['AAA', 'BBB']);
  assert.match(out.at(-1).text, /dropped a repeated copy.*getScreenshot\(\) already shows its picture/);
});

test('distinct images and results without repeats are left exactly as they were', () => {
  const content = [image('AAA'), image('BBB'), { type: 'text', text: 'ok' }];
  assert.equal(dropRepeatedImages(content), content);
});
