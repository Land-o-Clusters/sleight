import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

const tree = (order = ['Alpha', 'Beta', 'Gamma'], selected = 'Beta', title = 'Draft') =>
  `Window: "${title}", App: Editor.\n0 standard window ${title}\n\t1 group Pages\n` +
  order.map((name, i) => `\t\t${i + 2} button ${name === selected ? 'Selected, ' : ''}${name}`).join('\n');
const text = value => ({ type: 'text', text: value });
const moved = /the click on Alpha moved it from position 1 to 3; if that wasn't intended, Undo \(Cmd\+Z\) restores the order; a move dialog is the fallback\./;
function session() {
  const c = createReadCompactor();
  c.process([text(tree())]);
  const read = (value, code, options = {}) => {
    const action = c.beginAction(code);
    if (options.overlap && action) action.overlap = true;
    return c.process([text(GUARD_MARK + value + GUARD_END)], { action, ...options }).map(i => i.text).join('\n');
  };
  return { c, read };
}

for (const code of ['await app.click(2)', 'await app.click({ label: "Alpha" })',
  'await app.click({ line: "button Alpha" })', 'await app.click(2); await app.pressKey("super+s")']) {
  test(`the clicked sibling moving to the end is reported: ${code}`, () => {
    const { read } = session();
    const out = read(tree(['Beta', 'Gamma', 'Alpha'], 'Alpha'), code);
    assert.match(out, moved);
    assert.equal(out.match(/moved it from/g)?.length, 1);
  });
}

test('a move first visible on the next read of that window is reported once', () => {
  const { read } = session();
  assert.doesNotMatch(read(tree(), 'await app.click(2)'), /moved it from/);
  assert.doesNotMatch(read(tree(['Beta', 'Gamma', 'Alpha'], 'Alpha', 'Other')), /moved it from/);
  assert.match(read(tree(['Beta', 'Gamma', 'Alpha'], 'Alpha')), moved);
  assert.doesNotMatch(read(tree(['Beta', 'Gamma', 'Alpha'], 'Alpha')), /moved it from/);
});

test('the delayed move can be observed by a plain full read or a save call', () => {
  for (const plain of [false, true]) {
    const { c, read } = session();
    read(tree(), 'await app.click(2)');
    const out = plain ? c.process([text(tree(['Beta', 'Gamma', 'Alpha'], 'Alpha'))]).map(i => i.text).join('\n')
      : read(tree(['Beta', 'Gamma', 'Alpha'], 'Alpha'), 'await app.pressKey("super+s")');
    assert.match(out, moved);
  }
});

test('selection alone, insertions, ambiguous labels and a click outside the list are silent', () => {
  for (const [before, after, code] of [
    [tree(), tree(undefined, 'Alpha'), 'await app.click(2)'],
    [tree(), tree(['Beta', 'Gamma', 'Alpha', 'Delta']), 'await app.click(2)'],
    [tree(['Alpha', 'Alpha', 'Beta']), tree(['Alpha', 'Beta', 'Alpha']), 'await app.click(2)'],
    [tree(), tree(['Beta', 'Gamma', 'Alpha']), 'await app.click(1)'],
    [tree(), tree(['Beta', 'Gamma', 'Alpha']), 'await app.click([20, 30])'],
  ]) {
    const { c, read } = session(); c.process([text(before)]);
    assert.doesNotMatch(read(after, code), /moved it from/);
  }
});

test('failed, stopped, overlapping, incomplete and different-window clicks never arm a move notice', () => {
  for (const options of [{ failed: true }, { overlap: true }, { forceFull: true }]) {
    const { read } = session();
    assert.doesNotMatch(read(tree(['Beta', 'Gamma', 'Alpha']), 'await app.click(2)', options), /moved it from/);
    assert.doesNotMatch(read(tree(['Beta', 'Gamma', 'Alpha'])), /moved it from/);
  }
  for (const value of [tree() + '\n…(20)', 'Input lease stopped\n' + tree(), tree(undefined, 'Alpha', 'Other')]) {
    const { read } = session();
    assert.doesNotMatch(read(value, 'await app.click(2)'), /moved it from/);
    assert.doesNotMatch(read(tree(['Beta', 'Gamma', 'Alpha'])), /moved it from/);
  }
});

test('a subsequent input or an unchanged next read expires delayed attribution', () => {
  for (const code of [undefined, 'await app.typeText("edit")']) {
    const { read } = session();
    read(tree(), 'await app.click(2)');
    read(tree(), code);
    assert.doesNotMatch(read(tree(['Beta', 'Gamma', 'Alpha'])), /moved it from/);
  }
});

test('full attribute-rich sibling lines report the label rather than help or range metadata', () => {
  const rich = (order, selected) => tree(order, selected)
    .replace(/button (Selected, )?Alpha$/m, 'button $1Alpha, , Used range: A1 to D4, Description: Alpha, Help: Press to select')
    .replace(/button (Selected, )?Beta$/m, 'button $1Beta, , Blank sheet, Description: Beta, Help: Press to select');
  const { c, read } = session(); c.process([text(rich(['Alpha', 'Beta', 'Gamma']))]);
  assert.match(read(rich(['Beta', 'Gamma', 'Alpha'], 'Alpha'), 'await app.click(2)'), moved);
});

test('another sibling moving across the clicked one does not blame the click', () => {
  const { read } = session();
  const out = read(tree(['Gamma', 'Alpha', 'Beta']), 'await app.click(2)');
  assert.doesNotMatch(out, /moved it from/);
  assert.doesNotMatch(read(tree(['Gamma', 'Alpha', 'Beta'])), /moved it from/);
});

test('a two-way swap carries only the swap line', () => {
  const { read } = session();
  const out = read(tree(['Beta', 'Alpha', 'Gamma'], 'Alpha'), 'await app.click(2)');
  assert.match(out, /clicking also swapped Alpha and Beta/);
  assert.doesNotMatch(out, /moved it from/);
});

const KEY_ADVICE = "To switch tabs, use the app's next/previous-tab key or go-to control, not a click.";

test('a moved tab gets Undo plus the switch-by-key advice; a moved list button gets Undo only', () => {
  const strips = [
    ['tab group Sheets', 'tab'], ['tab bar Sheets', 'button'], ['layout area Content Area', 'button'],
    ['group Pages', 'radio button'], ['group Pages', 'tab'],
  ];
  for (const [parent, role] of strips) {
    const strip = (order, selected) => tree(order, selected).replace('group Pages', parent).replaceAll(' button ', ` ${role} `);
    const { c, read } = session(); c.process([text(strip(['Alpha', 'Beta', 'Gamma'], 'Beta'))]);
    const out = read(strip(['Beta', 'Gamma', 'Alpha'], 'Alpha'), 'await app.click(2)');
    assert.match(out, moved, parent);
    assert.ok(out.includes(`a move dialog is the fallback. ${KEY_ADVICE}`), `${parent} / ${role}`);
  }
  for (const [parent, role] of [['group Pages', 'button'], ['list Results', 'row'], ['outline Files', 'cell']]) {
    const list = (order, selected) => tree(order, selected).replace('group Pages', parent).replaceAll(' button ', ` ${role} `);
    const { c, read } = session(); c.process([text(list(['Alpha', 'Beta', 'Gamma'], 'Beta'))]);
    const out = read(list(['Beta', 'Gamma', 'Alpha'], 'Alpha'), 'await app.click(2)');
    assert.match(out, moved, parent);
    assert.doesNotMatch(out, /next\/previous-tab/, `${parent} / ${role}`);
  }
});

test('an untitled tab group or layout area parent still marks a moved button as a tab', () => {
  for (const parent of ['tab group', 'layout area']) {
    const strip = (order, selected) => tree(order, selected).replace('group Pages', parent);
    const { c, read } = session(); c.process([text(strip(['Alpha', 'Beta', 'Gamma'], 'Beta'))]);
    const out = read(strip(['Beta', 'Gamma', 'Alpha'], 'Alpha'), 'await app.click(2)');
    assert.match(out, moved, parent);
    assert.ok(out.includes(`a move dialog is the fallback. ${KEY_ADVICE}`), parent);
  }
});

test('a delayed tab move keeps the switch-by-key advice', () => {
  const strip = (order, selected) => tree(order, selected).replace('group Pages', 'tab group Sheets').replaceAll(' button ', ' tab ');
  const { c, read } = session(); c.process([text(strip())]);
  read(strip(), 'await app.click(2)');
  assert.ok(read(strip(['Beta', 'Gamma', 'Alpha'], 'Alpha')).includes(KEY_ADVICE));
});

test('a move that adds an Edited marker to the title is still reported', () => {
  for (const delayed of [false, true]) {
    const { read } = session();
    const edited = tree(['Beta', 'Gamma', 'Alpha'], 'Alpha', 'Draft — Edited');
    const out = delayed ? (read(tree(), 'await app.click(2)'), read(edited)) : read(edited, 'await app.click(2)');
    assert.match(out, moved);
  }
});

// excel-edit #3 (claim run, 2026-10-18): the call printed a filtered 3-line tree in the same text item after the
// engine's tree, so remember() kept the printed lines and the later tab move had nothing to compare against.
const strip = (order, selected) => tree(order, selected).replace('group Pages', 'tab group Sheets').replaceAll(' button ', ' tab ');
const clickAfter = (c, value) => {
  const action = c.beginAction('await app.click(2)');
  return c.process([text(GUARD_MARK + value + GUARD_END)], { action }).map(i => i.text).join('\n');
};

test('a tree the call printed after the real one in the same text item does not replace it', () => {
  const c = createReadCompactor(), before = strip(['Alpha', 'Beta', 'Gamma'], 'Beta');
  c.process([text(before + '\n' + before.split('\n').slice(0, 3).join('\n'))]);
  assert.match(clickAfter(c, strip(['Beta', 'Gamma', 'Alpha'], 'Alpha')), moved);
});

test('a degraded block after the real tree in the same text item never becomes the latest read', () => {
  const c = createReadCompactor(), lines = strip(['Alpha', 'Beta', 'Gamma'], 'Beta').split('\n');
  // No window root: the shape observe() already marks as degraded.
  c.process([text(lines.join('\n') + '\n' + [lines[0], ...lines.slice(2, 5)].join('\n'))]);
  assert.match(clickAfter(c, strip(['Beta', 'Gamma', 'Alpha'], 'Alpha')), moved);
});
