import test from 'node:test';
import assert from 'node:assert/strict';
import { cardText } from '../plugins/sleight/lib/card-text.mjs';
import { approvalCardText } from '../plugins/sleight/lib/launch.mjs';

for (const [name, codes] of [
  ['DEL', [0x7f]],
  ['C1', Array.from({ length: 32 }, (_, i) => 0x80 + i)],
  ['direction marks', [0x200e, 0x200f]],
  ['invisible controls', [0x061c, 0xfeff, 0x200b, 0x200d, 0x2060]],
]) test(`SA2K card text escapes ${name} before capping and indenting`, () => {
  const input = codes.map(code => String.fromCharCode(code)).join('');
  const escaped = codes.map(code => `\\u${code.toString(16).padStart(4, '0')}`).join('');
  assert.equal(cardText(input), escaped);
  assert.equal(cardText(input, { indent: true }), '  ' + escaped);
  const capped = cardText(input.repeat(100), { indent: true, maxBytes: 256 });
  assert.ok(Buffer.byteLength(capped) <= 256);
  assert.doesNotMatch(capped, /[\x7f-\x9f\u061c\u200b\u200d-\u200f\u2060\ufeff]/);
  assert.ok(capped.startsWith('  ' + escaped.slice(0, 6)));
});

test('native review card describes Undo independently of the capped preview', () => {
  const { detail } = approvalCardText('Review edits?', true, { kind: 'review', detail: '[diff truncated, 10 lines not shown]' });
  assert.match(detail, /Undo restores the saved copy\. A capped preview is shown above\./);
  assert.doesNotMatch(detail, /saved copy shown above/);
});

test('SA2K 4000 control-free strings preserve the original payment sanitizer bytes', () => {
  const original = value => {
    const text = String(value).replace(/[\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16)}`);
    return Buffer.byteLength(text) <= 2048 ? text
      : Buffer.from(text).subarray(0, 2020).toString('utf8').replace(/\uFFFD$/, '') + '\n[request truncated]';
  };
  const alphabet = ['x', 'é', '€', '😀', '\n', '\t', '\u202e', '\u2066'];
  let state = 0x5a2;
  for (let i = 0; i < 4000; i++) {
    let input = '';
    const length = 1900 + i % 200;
    while (input.length < length) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      input += alphabet[state >>> 29];
    }
    // Never manufacture a lone surrogate at the length boundary.
    if (input.length > length) input = input.slice(0, -2);
    assert.equal(cardText(input), original(input), `fixture ${i}`);
  }
});
