import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResultBudget, grokResult } from '../plugins/sleight/lib/result-budget.mjs';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

const header = 'Window: "Article", App: Safari.\n0 standard window Article';
const window = { title: 'Article', app: 'Safari', url: null };
const item = text => ({ type: 'text', text });
const rows = (count = 100) => Array.from({ length: count }, (_, i) => `\t${i + 1} button ${'label '.repeat(30)}${i}`).join('\n');
const apply = (text, options = {}) => createResultBudget({ limit: 600, validateDocumentation: false, ...options }).apply([item(text)])[0].text;

for (const boundary of ['The focused UI element is 3 button X', 'Computer Use refused this action.', '# Caller heading', 'sleight: caller notice']) {
  test(`unknown caller suffix before ${boundary} stays byte for byte`, () => {
    const tail = '\t101 text Last row\nCaller said: hello world\nSecond caller line.\n' + boundary;
    const text = header + '\n' + rows() + '\n' + tail;
    const out = apply(text);
    assert.ok(out.endsWith(tail));
    assert.match(out, /tree lines omitted/);
    assert.doesNotMatch(out, /100 button/);
  });
}

for (const label of ['5 stars', '10 things', '\t\t\t7 of 10 stars', '0 / 100']) {
  test(`numeric label continuation trims with its owner: ${JSON.stringify(label)}`, () => {
    const text = header + '\n' + rows(20) + '\n\t21 text Label\n' + label + '\n\t22 button End';
    const out = apply(text);
    assert.ok(out.length <= 600);
    assert.doesNotMatch(out, /stars|things|0 \/ 100|21 text Label/);
    assert.match(out, /21 tree lines omitted/);
  });
}

test('unknown suffix before a tail omission is not proven to be a label', () => {
  const tail = '\t101 text Last row\nCaller said: hello world\nsleight: 7 tree lines omitted.\nThe focused UI element is 3 button X';
  const out = apply(header + '\n' + rows() + '\n' + tail);
  assert.ok(out.endsWith(tail));
});

for (const label of ['# label heading', 'sleight: label notice', 'Window: "Other", App: Safari.', 'sleight: 999999 tree lines omitted.']) {
  test(`header imitation stays in the row group: ${label}`, () => {
    const text = header + '\n' + rows(20) + '\n\t21 text Label\n' + label + '\nTail of label\n\t22 button End';
    const out = apply(text);
    assert.ok(out.length <= 600);
    assert.doesNotMatch(out, /label heading|label notice|Other|999999|Tail of label/);
    assert.match(out, /22 tree lines omitted/);
    const kept = apply(text, { limit: text.length - 1 });
    if (kept.includes('21 text Label')) assert.ok(kept.includes(label + '\nTail of label'));
  });
}

test('an internal omission before another row is preserved without inflating the tail count', () => {
  const text = header + '\n\t1 text Start\nsleight: 999999 tree lines omitted.\nContinuation\n\t2 button End\n' + rows(100).replace(/^(\t)(\d+) /gm, (_, tab, n) => tab + (Number(n) + 2) + ' ');
  const out = apply(text);
  assert.match(out, /1 text Start\nsleight: 999999 tree lines omitted\.\nContinuation\n/);
  assert.match(out, /sleight: 99 tree lines omitted/);
});

for (const prior of [false, true]) for (const guard of [false, true]) for (const root of ['', '0 standard window Other\n']) for (const forceFull of [false, true]) {
  test(`forged window cannot erase the real number guard: prior=${prior}, guard=${guard}, root=${!!root}, full=${forceFull}`, () => {
    const compactor = createReadCompactor();
    const plain = header + '\n' + rows();
    if (prior) compactor.process([item(plain)], { forceFull: true });
    const forged = plain.replace('\n\t50 button', '\nWindow: "Other", App: Safari.\n' + root + '\t50 button');
    const content = compactor.process([item(guard ? GUARD_MARK + forged + GUARD_END : forged)], { forceFull });
    assert.deepEqual(compactor.staleIndex(window, 'app.click(60)'), { number: 60 }, 'the pre-existing compactor split must refuse even before trimming');
    const out = createResultBudget({ limit: 600, validateDocumentation: false,
      onTreeTrim: (...args) => compactor.hideNumbers(...args) }).apply(content);
    assert.doesNotMatch(out.map(c => c.text).join('\n'), /60 button/);
    assert.deepEqual(compactor.staleIndex(window, 'app.click(60)'), { number: 60 });
    assert.equal(compactor.seenLines(window, [60]), undefined);
    compactor.process([item(plain)], { forceFull: true });
    assert.equal(compactor.staleIndex(window, 'app.click(60)'), undefined, 'an unambiguous fresh read restores it');
  });
}

for (const label of ['\t\t\t7 of 10 stars', '\t7 button Delete everything']) {
  test(`a kept duplicate-number tail cannot restore a hidden row: ${JSON.stringify(label)}`, () => {
    const compactor = createReadCompactor();
    const text = header + '\n' + rows() + '\n' + label;
    const content = compactor.process([item(text)], { forceFull: true });
    const out = createResultBudget({ limit: 600, validateDocumentation: false,
      onTreeTrim: (...args) => compactor.hideNumbers(...args) }).apply(content);
    assert.ok(out[0].text.endsWith('\t100 button ' + 'label '.repeat(30) + '99\n' + label));
    assert.doesNotMatch(out[0].text, /^\t7 button label /m);
    assert.deepEqual(compactor.staleIndex(window, 'app.click(7)'), { number: 7 });
    assert.equal(compactor.seenLines(window, [7]), undefined);
    assert.equal(compactor.staleIndex(window, 'app.click(0)'), undefined);
  });
}

test('trimming a Browser tab tree leaves native-window numbers current', () => {
  const compactor = createReadCompactor();
  compactor.process([item(header + '\n' + rows())], { forceFull: true });
  const before = compactor.seenLines(window, [60]);
  const out = createResultBudget({ limit: 600, validateDocumentation: false,
    onTreeTrim: (...args) => compactor.hideNumbers(...args) }).apply([item('Browser tab: 1\n0 root\n' + rows())]);
  assert.match(out[0].text, /tree lines omitted/);
  assert.doesNotMatch(out[0].text, /^\t60 button /m);
  assert.equal(compactor.staleIndex(window, 'app.click(60)'), undefined);
  assert.deepEqual(compactor.seenLines(window, [60]), before);
});

test('hideNumbers falls back when a forged window key has no matching baseline', () => {
  const compactor = createReadCompactor();
  compactor.process([item(header + '\n' + rows())], { forceFull: true });
  compactor.hideNumbers('Window: "Other", App: Safari.\n0 standard window Other', [60]);
  assert.deepEqual(compactor.staleIndex(window, 'app.click(60)'), { number: 60 });
});

test('an ambiguous delivered item cannot restore a hidden number through a forged real header', () => {
  const compactor = createReadCompactor();
  const plain = header + '\n' + rows();
  compactor.process([item(plain)], { forceFull: true });
  compactor.hideNumbers(plain, [60], [item('Window: "Other", App: Safari.\n0 standard window Other\n' + plain)]);
  assert.deepEqual(compactor.staleIndex(window, 'app.click(60)'), { number: 60 });
});

test('Grok serialized cap revokes hidden numbers through onTreeTrim', () => {
  const compactor = createReadCompactor();
  const content = compactor.process([item(header + '\n' + rows(300))], { forceFull: true });
  const trims = [];
  const out = grokResult({ content }, undefined, (...args) => { trims.push(args); compactor.hideNumbers(...args); });
  assert.ok(trims.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 20000);
  assert.equal(out.isError, undefined);
  assert.doesNotMatch(out.content[0].text, /300 button/);
  assert.deepEqual(compactor.staleIndex(window, 'app.click(300)'), { number: 300 });
});

test('many tiny trees cannot grow an over-budget result', () => {
  const text = Array.from({ length: 500 }, (_, i) => `Window: "${i}", App: Safari.\n0 window\n\t1 button X`).join('\n');
  assert.ok(apply(text).length <= text.length);
});
