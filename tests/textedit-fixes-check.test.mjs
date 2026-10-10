import { test } from 'node:test';
import assert from 'node:assert/strict';
const { textEditFormatPreserved } = await import('../bench/textedit-fixes-check.mjs').catch(() => ({}));
const character = index => ({ index, font: 'Helvetica-Bold', size: 14, rgba: [220 / 255, 0, 0, 1] });
const states = () => [{ characters: [character(0), character(4)] }, ...[1, 2].map(() => ({ characters: [character(11), character(15)] }))];
test('the formatting checker requires observed initial, final and saved attributes', () => {
  assert.equal(typeof textEditFormatPreserved, 'function');
  assert.equal(textEditFormatPreserved(...states()), true);
  assert.equal(textEditFormatPreserved({}, {}, {}), false);
  for (let missing = 0; missing < 3; missing++) {
    const input = states(); input[missing] = {};
    assert.equal(textEditFormatPreserved(...input), false);
  }
});
test('matching wrong or incomplete formatting cannot pass the fixture', () => {
  for (const change of [c => { c.font = 'Helvetica'; }, c => { c.size = 12; }, c => { c.rgba = [0, 0, 0, 1]; }, c => { delete c.rgba; }]) {
    const input = states();
    for (const state of input) state.characters.forEach(change);
    assert.equal(textEditFormatPreserved(...input), false);
  }
});
test('format loss at either end of the moved word fails before or after saving', () => {
  for (const stage of [1, 2]) for (const index of [0, 1]) {
    const input = states(); input[stage].characters[index].font = 'Helvetica';
    assert.equal(textEditFormatPreserved(...input), false);
  }
});
