import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createContext, runInContext } from 'node:vm';
import { differentFocusTarget, guardedCode, sameElement } from '../plugins/sleight/lib/document-scope.mjs';
import { isFilteredRead } from '../plugins/sleight/lib/input-lease.mjs';

// Firefox's address bar (handoff, demoid and inject-order runs, 2026-10-18): the engine numbers the field's inner
// text node, a click on it focuses the combo box that holds it, and typeText stopped with "another element has focus".
const tree = (focus, extra = '') => [
  'Window: "Mozilla Firefox", App: Firefox.',
  '0 standard window Mozilla Firefox',
  '\t14 container',
  '\t\t15 button Description: View site information',
  '\t\t17 combo box (settable) Description: Search with Google or enter address, Value: https://example.test/',
  '\t\t\t18 text https://example.test/',
  '\t\t19 button Bookmark this page',
  '\t20 container',
  '\t\t21 text field (settable) Value: other',
  extra,
  '',
  `The focused UI element is ${focus}`,
].join('\n');
const inner = { number: 18, line: 'text https://example.test/' };
const combo = '17 combo box (settable) Description: Search with Google or enter address, Value: https://example.test/';

test('SL3: focus on the settable field that holds the clicked text node is the clicked field', () => {
  assert.equal(differentFocusTarget(tree(combo), inner), undefined);
});

test('SL3: focus on the clicked node itself still passes', () => {
  assert.equal(differentFocusTarget(tree('18 text https://example.test/'), inner), undefined);
});

for (const [name, focus] of [
  ['another field', '21 text field (settable) Value: other'],
  ['a button beside the field', '19 button Bookmark this page'],
  ['a container above the field', '14 container'],
  ['the web content', '1 container Mozilla Firefox'],
]) test(`SL3: focus on ${name} still stops`, () => {
  assert.equal(differentFocusTarget(tree(focus).replace('\t20 container', '\t20 container\n\t1 container Mozilla Firefox'), inner), 18);
});

test('SL3: an ancestor that is not a field does not stand for the clicked text', () => {
  const plain = tree('17 container Search').replace(combo, '17 container Search');
  assert.equal(differentFocusTarget(plain, { number: 18, line: 'text https://example.test/' }), 18);
});

test('SL3: only the nearest field ancestor counts, not one further out', () => {
  const nested = [
    'Window: "W", App: A.', '0 standard window W',
    '\t1 text area (settable) Description: Outer',
    '\t\t2 text field (settable) Description: Inner',
    '\t\t\t3 text inner',
    '', 'The focused UI element is 1 text area (settable) Description: Outer',
  ].join('\n');
  assert.equal(differentFocusTarget(nested, { number: 3, line: 'text inner' }), 3);
  assert.equal(differentFocusTarget(nested.replace('is 1 text area (settable) Description: Outer', 'is 2 text field (settable) Description: Inner'), { number: 3, line: 'text inner' }), undefined);
});

test('SL3: a sibling field after the clicked one is not an ancestor', () => {
  const siblings = [
    'Window: "W", App: A.', '0 standard window W',
    '\t1 text field (settable) Description: First',
    '\t\t2 text first',
    '\t3 text field (settable) Description: Second',
    '', 'The focused UI element is 3 text field (settable) Description: Second',
  ].join('\n');
  assert.equal(differentFocusTarget(siblings, { number: 2, line: 'text first' }), 2);
});

// Through the guard: click the editable node, then typeText runs when focus is on its parent field, stops elsewhere.
function fixture(focusOn) {
  let clicked = false;
  const events = [];
  const field = 'search field Description: Query, ID: query';
  const parent = 'combo box (settable) Description: Address, ID: address';
  const other = 'text field (settable) Description: Other, ID: other';
  const raw = {
    getAXState: async () => `Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n\t1 ${parent}\n\t\t2 ${field}\n\t3 ${other}` +
      (clicked ? `\n\nThe focused UI element is ${focusOn === 'parent' ? '1 ' + parent : focusOn === 'other' ? '3 ' + other : '2 ' + field}` : ''),
    click: async n => { events.push(['click', n]); clicked = true; },
    typeText: async text => { events.push(['typeText', text]); return 'typed'; },
  };
  const context = createContext({ app: raw, cua: { getApp: async () => raw }, performance: { now: () => 1000 }, nodeRepl: { write() {} },
    setTimeout: (resolve) => resolve() });
  const window = { title: 'Draft', app: 'Fixture Editor', url: null };
  const run = code => runInContext(`(async () => { ${guardedCode(code, window, undefined, undefined, { quietEdits: true })} })()`, context,
    { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return { run, events };
}

test('SL3: typeText runs after a click on a field node when focus is on the parent field', async () => {
  const f = fixture('parent');
  await f.run('await app.click(2); await app.typeText("https://example.test/");');
  assert.deepEqual(f.events.map(event => event[0]), ['click', 'typeText']);
});

test('SL3: typeText still stops when focus moved to another control', async () => {
  const f = fixture('other');
  await assert.rejects(f.run('await app.click(2); await app.typeText("https://example.test/");'), /another element has focus.*app\.setValue\(2, /);
  assert.deepEqual(f.events.map(event => event[0]), ['click']);
});

// The address bar after a background click (mdn r1:41, wikipedia r3:41, size-guide r3:40): the engine reports focus on the
// window's root container, an ancestor of the clicked combo box. LCU and Codex type there and the page loads.
const mdn = (focus, root = 'container Mozilla Firefox') => [
  'Window: "Mozilla Firefox", App: Firefox.',
  '0 standard window Mozilla Firefox, Secondary Actions: Raise',
  `\t1 ${root}`,
  '\t\t2 toolbar Browser tabs',
  '\t\t9 toolbar Navigation',
  '\t\t\t15 container',
  '\t\t\t\t16 button Pick a search engine',
  '\t\t\t\t18 combo box (settable) Description: Search with Google or enter address',
  '\t\t29 scroll area',
  '\t\t\t30 HTML Content Description: New Tab, URL: about:newtab',
  '\t\t\t\t31 container',
  '\t\t\t\t\t32 heading Mozilla Firefox, Value: 1',
  '',
  `The focused UI element is ${focus}`,
].join('\n');
const address = { number: 18, line: 'combo box (settable) Search with Google or enter address' };

test('FOC: focus on the window root container after a click on the address bar does not stop', () => {
  assert.equal(differentFocusTarget(mdn('1 container Mozilla Firefox'), address), undefined);
  assert.equal(differentFocusTarget(mdn('1 container Mozilla Firefox'), { ...address, focus: '1 container Mozilla Firefox' }), undefined);
});

test('FOC: root focus after a click on text inside the field does not stop either', () => {
  const inner = mdn('1 container Mozilla Firefox').replace('\t\t\t\t18 combo box (settable) Description: Search with Google or enter address',
    '\t\t\t\t18 combo box (settable) Description: Search with Google or enter address\n\t\t\t\t\t19 text https://example.test/');
  assert.equal(differentFocusTarget(inner, { number: 19, line: 'text https://example.test/' }), undefined);
});

test('FOC: focus on the window row itself still stops, as the guard treats it as keys with no target', () => {
  assert.equal(differentFocusTarget(mdn('0 standard window Mozilla Firefox, Secondary Actions: Raise'), address), 18);
});

test('FOC: root focus after a click on a button stops', () => {
  assert.equal(differentFocusTarget(mdn('1 container Mozilla Firefox'), { number: 16, line: 'button Pick a search engine' }), 16);
});

test('FOC: root focus stops when the root container is one of several children of the window', () => {
  const several = mdn('1 container Mozilla Firefox').replace('\n\nThe focused', '\n\t40 container Sidebar\n\nThe focused');
  assert.equal(differentFocusTarget(several, address), 18);
});

test('FOC: an Electron-like web root titled like the window stops a click on a non-editable node', () => {
  const docs = ['Window: "Docs", App: Notes.', '0 standard window Docs', '\t1 container Docs', '\t\t5 link Home', '\t\t6 text field (settable) Description: Search', '',
    'The focused UI element is 1 container Docs'].join('\n');
  assert.equal(differentFocusTarget(docs, { number: 5, line: 'link Home' }), 5);
  assert.equal(differentFocusTarget(docs, { number: 6, line: 'text field (settable) Description: Search' }), undefined, 'the editable field in the same tree passes');
});

test('FOC: root focus stops when focus before the click was on a specific element', () => {
  assert.equal(differentFocusTarget(mdn('1 container Mozilla Firefox'), { ...address, focus: '16 button Pick a search engine' }), 18);
  assert.equal(differentFocusTarget(mdn('1 container Mozilla Firefox'), { ...address, focus: '30 HTML Content Description: New Tab, URL: about:newtab' }), 18);
});

for (const [name, focus] of [
  ['a sibling control', '16 button Pick a search engine'],
  ['the page document', '30 HTML Content Description: New Tab, URL: about:newtab'],
  ['content in the page', '32 heading Mozilla Firefox, Value: 1'],
  ['a container that is not the root', '15 container'],
  ['the tab bar', '2 toolbar Browser tabs'],
]) test(`FOC: focus on ${name} still stops`, () => {
  assert.equal(differentFocusTarget(mdn(focus), address), 18);
});

test('FOC: a container under the root with another title is not the root', () => {
  assert.equal(differentFocusTarget(mdn('1 container Another Window', 'container Another Window'), address), 18);
});

test('FOC: an untitled root never counts as the window root container', () => {
  const untitled = mdn('1 container', 'container').replace('0 standard window Mozilla Firefox, Secondary Actions: Raise', '0 standard window');
  assert.equal(differentFocusTarget(untitled, address), 18);
});

test('FOC: a same-titled container deeper in the tree is not the root', () => {
  const deeper = mdn('2 container Mozilla Firefox', 'toolbar Top').replace('\t\t2 toolbar Browser tabs', '\t\t2 container Mozilla Firefox');
  assert.equal(differentFocusTarget(deeper, address), 18);
});

// After setValue the engine adds the description and value to the field's line (mdn r1:48), and the guard refused click(18).
test('FOC: a field line keeps its identity when setValue adds a description and a value', () => {
  const was = 'combo box (settable) Search with Google or enter address';
  const now = 'combo box (settable) Description: Search with Google or enter address, Value: https://developer.mozilla.org/en-US/';
  assert.equal(sameElement(was, now), true);
  assert.equal(sameElement(now, was), true);
  assert.equal(sameElement('combo box Search with Google or enter address', now), true);
});

test('FOC: an unlisted parenthetical is part of the label, and a line that becomes disabled is another element', () => {
  assert.equal(sameElement('link next (page 2)', 'link next (page 3)'), false);
  assert.equal(sameElement('menu item paste', 'menu item (disabled) paste'), false);
  assert.equal(sameElement('menu item (disabled) paste', 'menu item paste'), false);
  assert.equal(sameElement('button Description: Save, ID: save', 'button (disabled) Description: Save, ID: save'), false);
  assert.equal(sameElement('button (disabled, float) Save', 'button Description: Save, ID: save'), false);
});

test('FOC: other state words, as the engine lists them after the role, still match the label', () => {
  assert.equal(sameElement('tab (selected) Inbox', 'tab Description: Inbox, ID: inbox'), true);
  assert.equal(sameElement('tab Inbox', 'tab (selectable, expanded) Description: Inbox, ID: inbox'), true);
  assert.equal(sameElement('text field (disabled, settable) Name', 'text field (disabled, settable) Description: Name, Value: x'), true);
});

for (const [name, was, now] of [
  ['a changed label', 'combo box (settable) Search with Google or enter address', 'combo box (settable) Description: Search with Bing or enter address, Value: x'],
  ['a different role', 'combo box (settable) Search with Google or enter address', 'text field (settable) Description: Search with Google or enter address, Value: x'],
  ['a label that only starts the same', 'combo box (settable) Search', 'combo box (settable) Description: Search with Google, Value: x'],
  ['a different button', 'button (disabled) Back', 'button Description: Forward, ID: forward'],
]) test(`FOC: ${name} is still another element`, () => {
  assert.equal(sameElement(was, now), false);
});

// S2/wikipedia:38: a read that filters the tree before printing it was counted as an action and refused as stale.
const filtered = 'const s = await ff.getAXState();\nconst lines = s.split("\\n");\nnodeRepl.write(lines.slice(0, 3).join("\\n") + "\\n---\\n" + lines.filter(l => /Kilimanjaro|wikipedia|Wikipedia|metre|meter|m \\(|Mount/i.test(l)).slice(0, 40).join("\\n"));';

test('FOC: a getAXState read that filters its tree with string methods is read-only', () => {
  assert.equal(isFilteredRead(filtered), true);
  assert.equal(isFilteredRead('const s = await ff.getAXState({ disableDiffing: true }); nodeRepl.write(s.split("\\n").filter(l => l.includes("button")).join("\\n"));'), true);
});

for (const [name, code] of [
  ['an action method', 'const s = await ff.getAXState(); await ff.click(1); nodeRepl.write(s);'],
  ['an unawaited action', 'const s = await ff.getAXState(); ff.click(1); nodeRepl.write(s);'],
  ['an action first', 'await ff.click(1); const s = await ff.getAXState(); nodeRepl.write(s);'],
  ['a method alias', 'const s = await ff.getAXState(); const c = ff.click; c(1); nodeRepl.write(s);'],
  ['a computed method', 'const s = await ff.getAXState(); ff["click"](1); nodeRepl.write(s);'],
  ['a comma call', 'const s = await ff.getAXState(); (0, ff.click)(1); nodeRepl.write(s);'],
  ['a template literal', 'const s = await ff.getAXState(); nodeRepl.write(`${ff.click(1)}`);'],
  ['call and apply', 'const s = await ff.getAXState(); ff.click.call(ff, 1);'],
  ['an action in a callback', 'const s = await ff.getAXState(); s.split("x").map(l => ff.click(1)); nodeRepl.write(s);'],
  ['an action between divisions', 'const s = await ff.getAXState(); const a = 1 / ff.click(1) / 2; nodeRepl.write(s);'],
  ['a comment', 'const s = await ff.getAXState(); // note\nnodeRepl.write(s);'],
  ['a property assignment', 'const s = await ff.getAXState(); ff.value = 3; nodeRepl.write(s);'],
  ['a write with no read', 'nodeRepl.write("x");'],
  ['a string method on the handle', 'const s = await ff.getAXState(); ff.split("x"); nodeRepl.write(s);'],
  ['another global', 'const s = await ff.getAXState(); console.log(s);'],
  ['eval', 'const s = await ff.getAXState(); eval("ff.click(1)");'],
  ['a loop', 'const s = await ff.getAXState(); while (true) {}'],
  ['a handle method passed to map', 'const s = await ff.getAXState(); s.split("\\n").map(ff.typeText);'],
  ['a handle method passed to some', 'const s = await ff.getAXState(); ["x"].some(ff.click);'],
  ['a destructured handle method', 'const s = await ff.getAXState(); const {click}=ff; [5].map(click);'],
  ['a handle method passed to replace', 'const s = await ff.getAXState(); "abc".replace(/b/, ff.typeText);'],
  ['bracket access on the handle', 'const s = await ff.getAXState(); const f = ff["click"]; nodeRepl.write(s);'],
  ['the handle bound to a name', 'const s = await ff.getAXState(); const h = ff; nodeRepl.write(s);'],
  ['an unrelated handle passed to map', 'const s = await ff.getAXState(); s.split("x").map(app.typeText);'],
  ['a read method called through a string', 'const s = await ff.getAXState(); s.getAXState();'],
  ['an array destructuring', 'const s = await ff.getAXState(); const [a] = s.split("x"); nodeRepl.write(a);'],
  ['a second awaited call', 'const s = await ff.getAXState(); await cua.getApp("Safari"); nodeRepl.write(s);'],
]) test(`FOC: ${name} is not read-only`, () => {
  assert.equal(isFilteredRead(code), false);
});

// Through the guard: the read before the click carries the focus line the root rule compares with.
function rootFixture({ before, after }) {
  let clicked = false;
  const events = [];
  const raw = {
    getAXState: async () => 'Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n\t1 container Draft\n\t\t2 combo box (settable) Description: Address\n\t\t3 button Go\n\n' +
      `The focused UI element is ${clicked ? after : before}`,
    click: async n => { events.push(['click', n]); clicked = true; },
    typeText: async text => { events.push(['typeText', text]); return 'typed'; },
  };
  const context = createContext({ app: raw, cua: { getApp: async () => raw }, performance: { now: () => 1000 }, nodeRepl: { write() {} }, setTimeout: resolve => resolve() });
  const window = { title: 'Draft', app: 'Fixture Editor', url: null };
  const run = code => runInContext(`(async () => { ${guardedCode(code, window, undefined, undefined, { quietEdits: true })} })()`, context,
    { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return { run, events };
}

test('FOC: through the guard, typeText runs on root focus when focus was on the root before the click too', async () => {
  const f = rootFixture({ before: '1 container Draft', after: '1 container Draft' });
  await f.run('await app.click(2); await app.typeText("https://example.test/");');
  assert.deepEqual(f.events.map(event => event[0]), ['click', 'typeText']);
});

test('FOC: through the guard, typeText stops on root focus when focus was on a specific element before the click', async () => {
  const f = rootFixture({ before: '3 button Go', after: '1 container Draft' });
  await assert.rejects(f.run('await app.click(2); await app.typeText("https://example.test/");'), /another element has focus/);
  assert.deepEqual(f.events.map(event => event[0]), ['click']);
});
