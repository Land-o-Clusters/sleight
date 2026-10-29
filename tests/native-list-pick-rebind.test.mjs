import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { listPicker } from '../plugins/sleight/lib/native-list-pick.mjs';
import { guardedCode, readCode, sameElement, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

// Initial and refreshed full trees from validation try 7, with local URL and window tokens replaced.
// The next read's diff shows Alder Depot selected and Save collection enabled after the focusing click.
const recordings = JSON.parse(readFileSync(new URL('./fixtures/native-list-pick-pl1.json', import.meta.url)));
const row = 'text (selectable) Alder Depot COL-0005';
const picked = 'text (selected) Alder Depot COL-0005';

function fixture(recording, { focus = 'container', nested = false, duplicate = false, missing = false,
  focusAfterScroll = focus, nestedBody = 'text Detail', wrapperBody = 'group Row detail' } = {}) {
  let clicked, advanced = false, started = false;
  const clicks = [], clickLines = [], keys = [], scrolls = [], notes = [];
  const tree = () => {
    let text = recording.current;
    if (duplicate) text = text.replace('\t44 close button', '\t100 list Collection\n\t44 close button');
    if (missing) text = text.replace('32 list Collection', '32 list Other');
    if (clicked) text = text.replace(row, picked).replace('42 text No collection selected', '42 text Alder Depot COL-0005')
      .replace('43 button (disabled) Save collection', '43 button Save collection');
    if (advanced) {
      // A wheel step has reached a sorted band around the recorded distant target. Geometry is modeled, not timed.
      const [name, number] = recording.target.split(' COL-');
      const targetNumber = Number(number);
      text = text.replace(/^(\t{6})\d+ text \((?:selectable|selected)\) Alder [^\n]+/gm, (line, indent) => {
        const index = Number(/^\s*(\d+)/.exec(line)[1]) - 33;
        const label = name + ' COL-' + String(targetNumber + index - 4).padStart(4, '0');
        return indent + (33 + index) + ' text (' + (clicked === label ? 'selected' : 'selectable') + ') ' + label;
      });
    }
    if (nested) text = text.replace(/^(\t{6})(37 text \([^\n]+)/m, '$1$2\n$1\t101 ' + wrapperBody + '\n$1\t\t102 ' + nestedBody);
    const currentFocus = advanced ? focusAfterScroll : focus;
    if (clicked && currentFocus === 'row') text = text.replace(/The focused UI element is .*/, 'The focused UI element is 37 ' +
      (advanced ? 'text (' + (clicked === recording.target ? 'selected' : 'selectable') + ') ' + recording.target : picked));
    if (clicked && currentFocus === 'nested') text = text.replace(/The focused UI element is .*/, 'The focused UI element is 102 ' + nestedBody);
    if (clicked && currentFocus === 'outside') text = text.replace(/The focused UI element is .*/, 'The focused UI element is 43 button Save collection');
    if (clicked && currentFocus === 'selected') {
      const selectedRow = /^\t+37 (.*)$/m.exec(text)[1];
      text = text.replace(/The focused UI element is .*/, 'Selected:\n\t37 ' + selectedRow);
    }
    return text;
  };
  const handle = {
    getAXState: async () => { if (!started) { started = true; return recording.initial; } return tree(); },
    click: async number => {
      const line = tree().split('\n').find(line => new RegExp('^\\s*' + number + ' ').test(line));
      assert.ok(line, 'click must name a current element');
      assert.match(line, /text \((?:selectable|selected)\)/, 'only plain list rows clicked');
      clickLines.push(line.replace(/^\s*\d+ /, ''));
      clicked = line.replace(/^\s*\d+ text \([^)]*\) /, ''); clicks.push(number);
    },
    pressKey: async key => { assert.ok(['row', 'nested'].includes(focus), 'no key with focus outside the list'); keys.push(key); advanced = true; },
    scroll: async (number, direction, ticks) => { assert.equal(number, 32); scrolls.push({ number, direction, ticks }); advanced = true; },
  };
  const context = { cua: { getApp: async () => handle }, setTimeout, nodeRepl: { write: note => notes.push(note) } };
  const run = code => runInNewContext(`(async () => { ${code}\nreturn globalThis.picked; })()`, context);
  const start = () => run(readCode('globalThis.app = await cua.getApp("Firefox"); await app.getAXState();'));
  const pick = (number, options = {}) => run(guardedCode(`globalThis.picked = await app.pickFromList(${number}, ${JSON.stringify(recording.target)});`,
    windowFromText(recording.current), undefined, undefined,
    { literals: [number], seenLines: { [number]: 'list Collection' }, uniqueSeen: [number], ...options }));
  return { start, pick, clicks, clickLines, keys, scrolls, notes, tree };
}

for (const recording of recordings) {
  test('PL1d ' + recording.run + ': old number 29 rebinds to 32 then container focus stops before paging', async () => {
    const h = fixture(recording);
    await h.start();
    await assert.rejects(h.pick(29), /focus-lost.*The click did not focus the named list\. No key was sent\./);
    assert.deepEqual(h.clicks, [37, 37]);
    assert.deepEqual(h.clickLines, [row, picked]);
    assert.deepEqual(h.keys, []);
    assert.deepEqual(h.scrolls, []);
    assert.match(h.notes.join('\n'), /pickFromList\(29\) went to element 32, the same "list Collection".*renumbered/);
  });

  test('PL1d ' + recording.run + ': current number 32 stops at container focus before paging', async () => {
    const h = fixture(recording);
    await h.start();
    await assert.rejects(h.pick(32), /focus-lost.*The click did not focus the named list\. No key was sent\./);
    assert.deepEqual(h.clicks, [37, 37]);
    assert.deepEqual(h.clickLines, [row, picked]);
    assert.deepEqual(h.keys, []);
    assert.deepEqual(h.scrolls, []);
  });
}

test('PL1: focused rows and nested plain text may receive page keys', async () => {
  for (const focus of ['row', 'nested']) {
    const h = fixture(recordings[0], { focus, nested: focus === 'nested' });
    await h.start();
    assert.equal((await h.pick(32)).clicked, true);
    assert.ok(h.keys.length > 0);
  }
});

for (const role of ['text field (settable)', 'combo box', 'text (settable)',
  'text (selectable), Secondary Actions: Press', 'cell, Secondary Actions: Press']) {
  for (const nested of [false, true]) {
    test('PL1c: ' + (nested ? 'text inside a direct ' : 'a direct ') + role + ' uses only the wheel', async () => {
      let advanced = false;
      const keys = [], scrolls = [], clicks = [];
      const read = async () => {
        const labels = advanced ? ['Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor'] : ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
        const body = label => {
          const name = clicks.length && label === 'Tango' ? '(selected) ' + label : label;
          return role.includes(', ') ? role.replace(', ', ' ' + name + ', ') : role + ' ' + name;
        };
        return ['Window: "Collection", App: Fixture', '1 window Collection', '\t2 list Collection',
          ...labels.flatMap((label, i) => ['\t\t' + (3 + i) + ' ' + body(label),
            ...(nested && i === 0 ? ['\t\t\t100 static text Detail'] : [])]), '',
          'The focused UI element is ' + (nested ? '100 static text Detail' : '3 ' + body(labels[0]))].join('\n');
      };
      const result = await listPicker({ read, observe() {}, parse: windowFromText, sameElement, sleep: async () => {},
        press: async key => { keys.push(key); advanced = true; },
        scroll: async (...args) => { scrolls.push(args); advanced = true; },
        click: async line => clicks.push(line) })('Tango');
      assert.deepEqual(keys, []);
      assert.equal(result.clicked, true, JSON.stringify(result));
      assert.equal(result.label, 'Tango');
      assert.ok(scrolls.length > 0);
      assert.equal(clicks.length, 1);
      assert.match(clicks[0], /\bTango\b/);
    });
  }
}

for (const nestedBody of ['text field (settable) Detail', 'combo box (settable) Detail', 'slider (settable) Detail',
  'pop up button Detail', 'check box Detail', 'button Detail', 'link Detail', 'text (settable) Detail',
  'group Detail, Secondary Actions: Press', 'cell Detail, Actions: Press']) {
  test('PL1b: nested ' + nestedBody + ' blocks keys while the wheel can search the list', async () => {
    const h = fixture(recordings[0], { focus: 'nested', nested: true, nestedBody });
    await h.start();
    assert.equal((await h.pick(32)).clicked, true);
    assert.deepEqual(h.keys, []);
    assert.ok(h.scrolls.length > 0);
  });
}

for (const wrapperBody of ['text field (settable) Row detail', 'combo box Row detail', 'slider Row detail',
  'group (settable) Row detail', 'cell Row detail, Secondary Actions: Press']) {
  test('PL1b: static text inside ' + wrapperBody + ' blocks keys', async () => {
    const h = fixture(recordings[0], { focus: 'nested', nested: true, wrapperBody });
    await h.start();
    assert.equal((await h.pick(32)).clicked, true);
    assert.deepEqual(h.keys, []);
    assert.ok(h.scrolls.length > 0);
  });
}

test('PL1b: nested static text, image, group and cell without actions allow keys', async () => {
  for (const nestedBody of ['static text Detail', 'image Detail', 'group Detail', 'cell Detail']) {
    const h = fixture(recordings[0], { focus: 'nested', nested: true, nestedBody, wrapperBody: 'cell Row detail' });
    await h.start();
    assert.equal((await h.pick(32)).clicked, true);
    assert.ok(h.keys.length > 0);
  }
});

test('PL1b: moving focus to the ancestor after keys reports possible input to another control', async () => {
  const h = fixture(recordings[0], { focus: 'row', focusAfterScroll: 'container' });
  await h.start();
  await assert.rejects(h.pick(32), /focus-lost.*Keys may have reached another control\./);
  assert.deepEqual(h.keys, ['Page_Down']);
  assert.deepEqual(h.scrolls, []); assert.deepEqual(h.clicks, [37]);
});

test('PL1c: a read with only a selection after keys stops before any wheel or final click', async () => {
  const h = fixture(recordings[0], { focus: 'row', focusAfterScroll: 'selected' });
  await h.start();
  await assert.rejects(h.pick(32), /focus-lost.*Keys may have reached another control\./);
  assert.deepEqual(h.keys, ['Page_Down']);
  assert.deepEqual(h.scrolls, []);
  assert.deepEqual(h.clicks, [37]);
});

test('PL1: ambiguous, missing and nonunique prior list identities stop before any input', async () => {
  for (const [settings, options] of [[{ duplicate: true }, {}], [{ missing: true }, {}], [{}, { uniqueSeen: [] }]]) {
    const h = fixture(recordings[0], settings);
    await h.start();
    await assert.rejects(h.pick(29, options), /not-a-list.*changed since you read/);
    assert.deepEqual(h.clicks, []); assert.deepEqual(h.keys, []); assert.deepEqual(h.scrolls, []);
  }
});

test('PL1: focus outside the list stops after its one focusing click, before any key or wheel', async () => {
  const h = fixture(recordings[0], { focus: 'outside' });
  await h.start();
  await assert.rejects(h.pick(32), /focus-lost/);
  assert.deepEqual(h.clicks, [37]); assert.deepEqual(h.keys, []); assert.deepEqual(h.scrolls, []);
});

test('PL1: an old number absent from the current tree still rebinds its unique list', async () => {
  const h = fixture({ ...recordings[0], current: recordings[0].current.replace(/^\t+29 text Display mode \n/m, '') }, { focus: 'row' });
  await h.start();
  assert.equal((await h.pick(29)).clicked, true);
  assert.match(h.notes.join('\n'), /went to element 32/);
});

test('PL1: changed roles, disabled state and bare roles cannot stand in for the old list', async () => {
  for (const [current, old] of [[recordings[0].current.replace('32 list Collection', '32 container Collection'), 'list Collection'],
    [recordings[0].current.replace('32 list Collection', '32 list (disabled) Collection'), 'list Collection'],
    [recordings[0].current.replace('32 list Collection', '32 list'), 'list']]) {
    const h = fixture({ ...recordings[0], current });
    await h.start();
    await assert.rejects(h.pick(29, { seenLines: { 29: old } }), /not-a-list.*changed since you read/);
    assert.deepEqual(h.clicks, []); assert.deepEqual(h.keys, []); assert.deepEqual(h.scrolls, []);
  }
});

test('PL1: focus without a matching descendant in the tree never authorizes a key', async () => {
  const text = recordings[0].current.replace(/The focused UI element is .*/, 'The focused UI element is 102 text Detail');
  const keys = [], clicks = [];
  const result = await listPicker({ read: async () => text, observe() {}, press: async key => keys.push(key),
    click: async line => clicks.push(line), parse: windowFromText, sameElement })(32, recordings[0].target);
  assert.equal(result.reason, 'focus-lost');
  assert.deepEqual(keys, []); assert.equal(clicks.length, 1);
});
