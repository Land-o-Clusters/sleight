import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GUARD_MARK, createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { promptNotice } from '../plugins/sleight/lib/prompt-notice.mjs';

const text = value => ({ type: 'text', text: value });
const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'org.test.defaults',
  app: 'Editor', title: 'Draft', identityVerified: true };
const tree = 'Window: "Draft", App: Editor.\n0 standard window Draft\n\t1 text Value: Ready\n' +
  Array.from({ length: 60 }, (_, i) => `\t${i + 2} link Story ${i}`).join('\n');
const shifted = tree.replace('\t3 link Story 1', '\t3 link Breaking story\n\t4 link Story 1')
  .split('\n').map(line => line.replace(/^(\t)(\d+) link Story (\d+)$/,
    (_, indent, number, story) => `${indent}${Number(story) > 1 ? Number(number) + 1 : number} link Story ${story}`)).join('\n');

// Exact default and lean renumber notes at 3d2053516bb0e66df0e11ef917df3a3d3d0bf5fc.
const historicalNotes = {
  default: '\nsleight: 59 other elements have new numbers. Use numbers from + lines above or from a full read. Read the window again with getAXState() for changed lines with current numbers before acting on any other element; sleight refuses actions on numbers that changed.',
  lean: '\nsleight: 59 other elements renumbered; sleight refuses actions on changed numbers. Read again with getAXState() before acting on any other.',
};
for (const prompt of [undefined, 'lean']) {
  test(`UC2E3 ChatGPT renumber note matches 3d205351 bytes, prompt=${prompt}`, () => {
    const compactor = createReadCompactor({ prompt });
    compactor.process([text(tree)]);
    const output = compactor.process([text(GUARD_MARK + shifted)])[0].text;
    const note = output.slice(output.indexOf('\nsleight: 59'));
    assert.deepEqual(Buffer.from(note), Buffer.from(historicalNotes[prompt ?? 'default']));
    assert.deepEqual(compactor.staleIndex({ title: 'Draft', app: 'Editor', url: null }, 'await app.click(10)'), { number: 10 });
  });
  test(`UC2E3 Glide renumber option removes only the refusal sentence, prompt=${prompt}`, () => {
    const compactor = createReadCompactor({ prompt, renumberRefusalNote: false });
    compactor.process([text(tree)]);
    const output = compactor.process([text(GUARD_MARK + shifted)])[0].text;
    const note = output.slice(output.indexOf('\nsleight: 59'));
    assert.equal(note, historicalNotes[prompt ?? 'default']
      .replace('; sleight refuses actions on numbers that changed.', '.')
      .replace('; sleight refuses actions on changed numbers.', '.'));
  });
}
test('UC2E3 shared notice rewriting preserves the historical renumber refusal', () => {
  assert.deepEqual(Buffer.from(promptNotice(historicalNotes.default)), Buffer.from(historicalNotes.default));
  assert.deepEqual(Buffer.from(promptNotice(historicalNotes.default, 'lean')), Buffer.from(historicalNotes.lean));
});

const moduleURL = new URL('../plugins/sleight/lib/mac-driver/diff.mjs', import.meta.url);
const source = readFileSync(moduleURL, 'utf8').replace(/(from\s+)(['"])(\.[^'"]+)\2/g,
  (_, prefix, quote, path) => prefix + quote + new URL(path, moduleURL).href + quote);
const counted = source.replace('if (partialCache.has(item)) return partialCache.get(item);',
  'if (partialCache.has(item)) return partialCache.get(item); partialCalls++;') + '\nexport let partialCalls = 0;';
const load = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('UC2E3 partial matching skips the default path and scans each other item once', async () => {
  const module = await load(counted);
  for (const [options, expected] of [[{}, 0], [{ compact: false, allowDelivery: true }, 0],
    [{ compact: true }, 1], [{ compact: false, allowDelivery: false }, 1],
    [{ compact: true, allowDelivery: false }, 1]]) {
    const state = module.createMacReadState();
    const snapshot = state.read({ window, readId: 1, text: tree });
    state.endCell([text(tree)], [snapshot]);
    const before = module.partialCalls;
    const content = [text('ordinary non-tree output')];
    const batch = state.prepareDisplay(content, [snapshot], options);
    assert.deepEqual(batch.content, content);
    assert.equal(module.partialCalls - before, expected);
    batch.commit();
  }
  const skip = 'const partialKeys = !compact && allowDelivery ? () => [] : item => {';
  assert.ok(counted.includes(skip));
  const broken = await load(counted.replace(skip, 'const partialKeys = item => {'));
  const state = broken.createMacReadState();
  state.prepareDisplay([text('ordinary non-tree output')], []);
  assert.throws(() => assert.equal(broken.partialCalls, 0), { name: 'AssertionError' });
});

function exactPartial(factory) {
  const state = factory();
  const first = state.read({ window, readId: 1, text: tree });
  const otherWindow = { ...window, windowId: '202', title: 'Other' };
  const otherTree = tree.replaceAll('Draft', 'Other').replaceAll('Story', 'Other story');
  const other = state.read({ window: otherWindow, readId: 1, text: otherTree });
  state.endCell([text(tree), text(otherTree)], [first, other]);
  const intermediate = state.read({ window, readId: 2, text: shifted });
  const latest = state.read({ window, readId: 3, text: tree });
  state.prepareDisplay([text('\t4 link Story 1')], [intermediate, latest], { compact: true }).commit();
  assert.throws(() => state.assertCurrent('click', { ...window, readId: 3, args: [10] }), { code: 'STALE_READ' });
  assert.doesNotThrow(() => state.assertCurrent('click', { ...otherWindow, readId: 1, args: [10] }));
}
test('UC2E3 exact partial rows retain their own window with several retained trees', async () => {
  exactPartial(createMacReadState);
  const lookup = 'if (treeLines.has(line))';
  assert.ok(source.includes(lookup));
  const broken = await load(source.replace(lookup, 'if (false)'));
  assert.throws(() => exactPartial(broken.createMacReadState), { name: 'AssertionError' });
});

for (const format of ['wrapped', 'json']) test(`UC2E3 mixed exact and ${format} rows mark every possible window`, async () => {
  function check(factory) {
    const state = factory();
    const first = state.read({ window, readId: 1, text: tree });
    const otherWindow = { ...window, windowId: '202', title: 'Other' };
    const otherTree = tree.replaceAll('Draft', 'Other').replaceAll('Story', 'Other story');
    const other = state.read({ window: otherWindow, readId: 1, text: otherTree });
    state.endCell([text(tree), text(otherTree)], [first, other]);
    const row = '\t10 link Other story 8';
    const print = '\t10 link Story 8\n' + (format === 'json' ? JSON.stringify([row]) : 'Earlier rows: ' + row + ' | omitted');
    state.prepareDisplay([text(print)], [], { compact: true }).commit();
    for (const target of [window, otherWindow]) assert.throws(() =>
      state.assertCurrent('click', { ...target, readId: 1, args: [10] }), { code: 'STALE_READ' });
  }
  check(createMacReadState);
  const fallback = 'const keys = unknownTree ? [...windows.keys()] : [...matches];';
  assert.ok(source.includes(fallback));
  const broken = await load(source.replace(fallback, 'const keys = [...matches];'));
  assert.throws(() => check(broken.createMacReadState), { name: 'AssertionError' });
});
