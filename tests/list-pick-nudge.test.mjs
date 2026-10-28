// CC1 (codex-vs-cc-1019): Haiku scrolled the travel airport list before trying app.pickFromList in 5 of 6 Firefox runs.
// The first scroll or Page_Down call that moves a sorted list's rows gets one line naming the helper with that list's
// number, once per list. The skill's list line sits in "Calls", next to the form line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUARD_MARK, GUARD_END, SCROLL_LOOP_NOTE, createReadCompactor, listPickNote } from '../plugins/sleight/lib/compact-reads.mjs';
import { sortedListShift } from '../plugins/sleight/lib/native-list-pick.mjs';
import { skillRules } from '../plugins/sleight/lib/launch.mjs';
import { promptNotice } from '../plugins/sleight/lib/prompt-notice.mjs';

// A held-out page (not the travel form): a "Country" list box with 12 rendered rows from `first`, in a Safari window.
const countries = Array.from({ length: 300 }, (_, i) => `Land ${String.fromCharCode(65 + Math.floor(i / 26) % 26)}${String.fromCharCode(97 + i % 26)}`);
function page(first, { rows = countries, title = 'Shipping · Example', list = 'list box (settable) Country' } = {}) {
  return [`Window: "${title}", App: Safari.`, `0 standard window ${title}`, '\t1 HTML content Description: Shipping, URL: example.test/ship',
    '\t\t2 text Country', `\t\t3 ${list}`,
    ...rows.slice(first, first + 12).map((name, i) => `\t\t\t${4 + i} text ${name}`),
    '\t\t20 button Continue', '', `The focused UI element is 3 ${list}`].join('\n');
}
const text = value => ({ type: 'text', text: value });
const join_ = result => result.map(item => item.text).join('\n');
const call = (c, code, tree) => join_(c.process([text(GUARD_MARK + tree + GUARD_END)], { code, action: c.beginAction(code) }));
const note = (handle, n) => promptNotice(listPickNote(handle, n));

test('CC1: the first scroll that moves a sorted list names the helper with the list number, once per list', () => {
  const c = createReadCompactor({ scrollNote: true });
  c.process([text(page(0))]);
  const first = call(c, 'await safari.scroll(3, "down", 2);', page(10));
  assert.ok(first.includes(note('safari', 3)), first.slice(-400));
  assert.match(first, /sleight: 3 is a sorted list\. Pick its row in one call: `await safari\.pickFromList\(3, "<whole row text>"\)`\./);
  assert.ok(!first.includes(SCROLL_LOOP_NOTE), 'the three-call note is separate');
  assert.ok(!call(c, 'await safari.scroll(3, "down", 2);', page(20)).includes('is a sorted list'), 'once per list');
  // Page_Down batches count too.
  const keys = createReadCompactor({ scrollNote: true });
  keys.process([text(page(0))]);
  assert.ok(call(keys, 'await app.pressKey("Page_Down"); await app.pressKey("Page_Down");', page(18)).includes(note('app', 3)));
});

test('CC1: no line for an unsorted list, an unmoved list, a call that already picks, a click, or SLEIGHT_SCROLL_NOTE=0', () => {
  const shuffled = [...countries]; [shuffled[14], shuffled[15]] = [shuffled[15], shuffled[14]];
  const cases = [
    ['await safari.scroll(3, "down", 2);', page(0, { rows: shuffled }), page(10, { rows: shuffled })],
    ['await safari.scroll(3, "down", 2);', page(0), page(0)],
    ['await safari.scroll(3, "down", 2); await safari.pickFromList(3, "Land Kb");', page(0), page(10)],
    ['await safari.click(5);', page(0), page(10)],
    ['await safari.pressKey("Tab");', page(0), page(10)],
  ];
  for (const [code, before, after] of cases) {
    const c = createReadCompactor({ scrollNote: true });
    c.process([text(before)]);
    assert.doesNotMatch(call(c, code, after), /is a sorted list/, code);
  }
  const off = createReadCompactor({ scrollNote: false });
  off.process([text(page(0))]);
  assert.doesNotMatch(call(off, 'await safari.scroll(3, "down", 2);', page(10)), /is a sorted list/);
});

test('CC1: sortedListShift reads the list role, states and the Firefox name and code lines', () => {
  const firefox = first => ['Window: "Book", App: Firefox.', '0 standard window Book', '\t\t\t\t\t49 list Departing from',
    ...Array.from({ length: 16 }, (_, i) => `\t\t\t\t\t\t${50 + i} text (selectable) Port ${String(first + i).padStart(3, '0')} Field\nPort ${String(first + i).padStart(3, '0')} Field\nX${i}`),
    '\t\t\t\t\t66 button Next'].join('\n').split('\n');
  assert.deepEqual(sortedListShift(firefox(0), firefox(9)), { number: 49, body: 'list Departing from' });
  assert.equal(sortedListShift(firefox(0), firefox(0)), undefined);
  // A list of two rows says nothing about order.
  const two = ['0 standard window W', '\t1 list L', '\t\t2 text B', '\t\t3 text C'];
  assert.equal(sortedListShift(['0 standard window W', '\t1 list L', '\t\t2 text A', '\t\t3 text B'], two), undefined);
});

test('CC1: the skill puts the list line in Calls, right after the form line, with the list number first', () => {
  const rules = skillRules();
  const calls = rules.slice(rules.indexOf('## Calls'), rules.indexOf('## Text, menus and files'));
  const form = calls.indexOf('- In a form, fill every independent'), list = calls.indexOf('- List exceeds visible rows:');
  assert.ok(form >= 0 && list > form, 'in Calls after the form line');
  assert.equal(calls.slice(form, list).match(/^- /gm).length, 1, 'next to it');
  assert.match(calls, /`await app\.pickFromList\(<list number>, "<whole row text>"\)`/);
  assert.equal(rules.split('pickFromList(<list number>').length - 1, 1, 'said once');
  assert.match(skillRules(undefined, { SLEIGHT_PROMPT: 'lean' }), /Long list: `await app\.pickFromList\(<list number>, "<whole row text>"\)`\./);
});

test('CC13 review: no line for a list of buttons or tabs, which the helper would refuse', () => {
  const buttons = first => ['0 standard window W', '\t1 list Toolbar', ...countries.slice(first, first + 12).map((name, i) => `\t\t${2 + i} button ${name}`)];
  assert.equal(sortedListShift(buttons(0), buttons(10)), undefined);
  const tabs = first => ['0 standard window W', '\t1 list Tabs', ...countries.slice(first, first + 12).map((name, i) => `\t\t${2 + i} tab ${name}`)];
  assert.equal(sortedListShift(tabs(0), tabs(10)), undefined);
  const c = createReadCompactor({ scrollNote: true });
  c.process([text(page(0, { list: 'list Toolbar', rows: countries }).replace(/^(\t+\d+) text (?=Land )/gm, '$1 button '))]);
  assert.doesNotMatch(call(c, 'await safari.scroll(3, "down", 2);', page(10, { list: 'list Toolbar' }).replace(/^(\t+\d+) text (?=Land )/gm, '$1 button ')), /is a sorted list/);
});
