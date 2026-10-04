import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function script(name) {
  const context = vm.createContext({ ObjC: { import() {} }, Application: () => ({}) });
  vm.runInContext(readFileSync(new URL(`../plugins/sleight/lib/${name}.js`, import.meta.url), 'utf8'), context);
  return context;
}
const drag = script('drag');
test('TextEdit word moved to a joined line end gets one preceding space', () => {
  assert.equal(drag.textDropSpace('alpha beta gamma\n', 'alpha', 'beta gammaalpha\n', 'alpha'), ' alpha');
  assert.equal(drag.textDropSpace('alpha beta gamma', 'alpha', ' beta gammaalpha', 'alpha'), ' alpha');
  assert.equal(drag.textDropSpace('un café\n', 'un', ' caféun\n', 'un'), ' un');
});
test('spacing repair refuses unchanged, ambiguous, failed and non-line-end drops', () => {
  const cases = [
    ['alpha beta gamma\n', 'alpha', 'beta gamma alpha\n', 'alpha'],
    ['alpha beta gamma\n', 'alpha', 'alpha beta gamma\n', 'alpha'],
    ['alpha beta gamma\n', 'alpha', 'beta gammaalpha\n', ''],
    ['alpha beta gamma\n', 'alpha', 'beta gammaalpha\n', 'beta'],
    ['alpha beta gamma\n', 'alpha', 'beta alpha gamma\n', 'alpha'],
    ['alpha beta alpha\n', 'alpha', 'beta alphaalpha\n', 'alpha'],
    ['alpha beta gamma\n', 'alpha', 'changed gammaalpha\n', 'alpha'],
    ['alpha beta gamma\n', 'alpha', 'beta gammaalphaX\n', 'alpha'],
    ['alpha beta gamma\n', 'alpha', 'beta gammaalpha.\n', 'alpha'],
    ['alpha beta gamma\n', '', 'beta gammaalpha\n', ''],
    ['alphabet beta\n', 'alpha', 'bet betaalpha\n', 'alpha'],
  ];
  for (const args of cases) assert.equal(drag.textDropSpace(...args), null, JSON.stringify(args));
});

test('verified TextEdit replacement adds the space and reports unsupported AX writes', () => {
  let text = 'beta gammaalpha\n', selected = 'alpha';
  const attribute = { get value() { return () => selected; }, set value(replacement) { text = 'beta gamma' + replacement + '\n'; selected = replacement; } };
  const snapshot = { text: 'alpha beta gamma\n', selected: 'alpha', el: { value: () => text, attributes: { byName: () => attribute } } };
  assert.equal(drag.repairTextDrop(snapshot).spaceInserted, true);
  assert.equal(text, 'beta gamma alpha\n');
  text = 'beta gammaalpha\n'; selected = 'alpha';
  Object.defineProperty(attribute, 'value', { get: () => () => selected, set: () => { throw new Error('AX write refused'); } });
  assert.match(drag.repairTextDrop(snapshot).spacingError, /AX write refused/);
  assert.equal(text, 'beta gammaalpha\n');
});
test('a changed selection or unexpected post-write text never reports a repair', () => {
  const attribute = { get value() { return () => 'beta'; }, set value(_) { assert.fail('must not write'); } };
  const snapshot = { text: 'alpha beta gamma\n', selected: 'alpha', el: { value: () => 'beta gammaalpha\n', attributes: { byName: () => attribute } } };
  assert.equal(drag.repairTextDrop(snapshot).spaceInserted, false);
  Object.defineProperty(attribute, 'value', { get: () => () => 'alpha', set: () => {} });
  assert.match(drag.repairTextDrop(snapshot).spacingError, /did not confirm/);
});

function element(role, position, size, children = [], extra = {}) {
  return { role: () => role, position: () => position, size: () => size,
    title: () => '', description: () => '', value: () => '', help: () => '',
    attributes: { byName: () => ({ value: () => '' }) }, uiElements: () => children, ...extra };
}
const menu = script('menubar');
const read = win => JSON.parse(JSON.stringify(menu.readWindow(win)));
test('unnamed menu controls get role and window-relative position names', () => {
  const win = element('AXWindow', [800, 100], [200, 300], [
    element('AXButton', [810, 120], [20, 20]),
    element('AXButton', [850, 120], [20, 20]),
    element('AXSlider', [810, 160], [100, 20]),
  ]);
  assert.deepEqual(read(win).map(e => e.text), ['Button at (10, 20)', 'Button at (50, 20)', 'Slider at (10, 60)']);
  win.position = () => [100, 500];
  for (const [i, pos] of [[0, [110, 520]], [1, [150, 520]], [2, [110, 560]]]) win.uiElements()[i].position = () => pos;
  assert.equal(read(win)[1].text, 'Button at (50, 20)');
});
test('semantic names stay intact and unavailable positions still have distinct names', () => {
  const win = element('AXWindow', [0, 0], [200, 300], [
    element('AXButton', [10, 20], [20, 20], [], { help: () => 'Refresh' }),
    element('AXButton', null, null), element('AXButton', null, null),
  ]);
  assert.deepEqual(read(win).map(e => e.text), ['Refresh', 'Button 1', 'Button 2']);
});
test('the number beside an unnamed menu button presses that same button', () => {
  const clicked = [];
  const win = element('AXWindow', [800, 100], [200, 300], [
    element('AXButton', [810, 120], [20, 20], [], { click: () => clicked.push('left') }),
    element('AXButton', [850, 120], [20, 20], [], { click: () => clicked.push('right') }),
  ], { subrole: () => 'AXUnknown' });
  menu.statusItems = () => ({ proc: { windows: () => [win] } });
  menu.delay = () => {};
  const button = read(win).find(e => e.text === 'Button at (50, 20)');
  const result = menu.press('TextEdit', button.element);
  assert.deepEqual(clicked, ['right']);
  assert.equal(result.pressed, 1);
});
