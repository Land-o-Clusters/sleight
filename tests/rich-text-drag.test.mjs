import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture({ dest = 16, pasteFails = false, changed = false, attributesLost = false, before = 'alpha beta gamma\n', src = 0, deleteFails = false, selectFails = false } = {}) {
  const context = vm.createContext({ ObjC: { import() {} } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  context.dropIndex = () => dest;
  let text = before, pasted = false;
  const writes = [];
  const rich = { rtf: 'fixture-rtf', sourceRTF: 'source-rtf' };
  const area = {
    value: () => changed ? 'owner edit\n' : text,
    selection: () => ({ location: src, length: 5 }),
    richMove: () => rich,
    pasteRich: (location, insert, _count, posted) => { posted(); writes.push(['paste', location, insert]); if (!pasteFails) { text = text.slice(0, location) + insert + text.slice(location); pasted = true; } },
    verifyRich: () => pasted && !attributesLost,
    replace: (location, length, value) => { if (deleteFails) throw new Error('Source deletion failed'); writes.push(['replace', location, length, value]); text = text.slice(0, location) + value + text.slice(location + length); },
    select: (location, length) => { if (selectFails) throw new Error('Selection failed'); writes.push(['select', location, length]); },
    settle: () => writes.push(['settle']),
  };
  const snapshot = { text, selected: 'alpha', app: 'TextEdit', isTextEdit: true };
  return { writes, value: () => text,
    move: prepared => context.accessibilityMove(area, snapshot, {}, { id: 11, title: 'fixture.rtf' }, prepared),
    plan: { ...rich, text, selected: 'alpha', windowId: 11, dest, src, cutFrom: src ? src - 1 : 0, cutTo: src ? src + 5 : 6, insert: dest === 0 ? 'alpha ' : ' alpha' } };
}
test('a rich text move prepares RTF without plain text writes or deleting the source', () => {
  const f = fixture(), result = f.move();
  assert.equal(result.richTextMove.rtf, 'fixture-rtf');
  assert.equal(f.value(), 'alpha beta gamma\n');
  assert.deepEqual(f.writes, []);
});
test('a prepared rich move pastes before deleting and verifies both text and attributes', () => {
  const f = fixture(), result = f.move(f.plan);
  assert.equal(f.value(), 'beta gamma alpha\n');
  assert.equal(result.richTextPreserved, true);
  assert.deepEqual(f.writes.slice(0, 2), [['paste', 16, ' alpha'], ['replace', 0, 6, '']]);
  assert.deepEqual(f.writes.at(-1), ['select', 11, 5]);
});
test('an unconfirmed rich paste never deletes the source or falls back to plain text', () => {
  const f = fixture({ pasteFails: true }), result = f.move(f.plan);
  assert.match(result.error, /paste|rich text/i);
  assert.equal(f.value(), 'alpha beta gamma\n');
  assert.equal(f.writes.some(w => w[0] === 'replace'), false);
  assert.equal(result.richPasteState, 'pending');
});
test('format loss leaves the original source in place', () => {
  const f = fixture({ attributesLost: true }), result = f.move(f.plan);
  assert.match(result.error, /format|attributes/i);
  assert.notEqual(result.richTextPreserved, true);
  assert.equal(f.value(), 'alpha beta gamma alpha\n');
  assert.equal(f.writes.some(w => w[0] === 'replace'), false);
  assert.equal(result.richPasteState, 'consumed');
  assert.match(result.error, /Cmd\+Z once/);
});
test('a changed source RTF is refused before the prepared paste', () => {
  const f = fixture();
  assert.throws(() => f.move({ ...f.plan, sourceRTF: 'changed' }), /changed before the move/);
  assert.deepEqual(f.writes, []);
});
test('a changed drop index is refused before the prepared paste', () => {
  const f = fixture();
  assert.throws(() => f.move({ ...f.plan, dest: 11 }), /changed before the move/);
  assert.deepEqual(f.writes, []);
});
test('a rich move toward the start adjusts source deletion after inserting', () => {
  const f = fixture({ before: 'beta gamma alpha\n', src: 11, dest: 0 }), result = f.move(f.plan);
  assert.equal(result.richTextPreserved, true);
  assert.equal(f.value(), 'alpha beta gamma\n');
  assert.deepEqual(f.writes.slice(0, 2), [['paste', 0, 'alpha '], ['replace', 16, 6, '']]);
  assert.deepEqual(f.writes.at(-1), ['select', 0, 5]);
});
test('a failed rich source deletion reports the partial move without repeating input', () => {
  const f = fixture({ deleteFails: true }), result = f.move(f.plan);
  assert.equal(result.textChanged, true); assert.match(result.error, /Source deletion failed/);
  assert.equal(f.value(), 'alpha beta gamma alpha\n');
  assert.equal(f.writes.filter(w => w[0] === 'paste').length, 1);
});
test('failure after source deletion advises two Undos', () => {
  const f = fixture({ selectFails: true }), result = f.move(f.plan);
  assert.equal(f.value(), 'beta gamma alpha\n');
  assert.equal(result.richPasteState, 'consumed');
  assert.match(result.error, /Cmd\+Z twice/);
});
test('background rich paste requires one enabled menu item with Command-V alone', () => {
  const context = vm.createContext({ ObjC: { import() {},
    castRefToObject: ref => ref.native,
    unwrap: value => { if (value && 'native' in Object(value)) throw new Error('Raw CF reference'); return value; } } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  const item = (modifiers = 0, enabled = true) => ({ AXRole: 'AXMenuItem', AXMenuItemCmdChar: 'v', AXMenuItemCmdModifiers: modifiers, AXEnabled: enabled });
  const menu = items => ({ AXMenuBar: { AXRole: 'AXMenuBar', AXChildren: { count: items.length, objectAtIndex: i => items[i] } } });
  const get = (el, name) => { if (!(name in el)) throw new Error('Unsupported attribute'); return { native: el[name] }; };
  const paste = item();
  assert.equal(context.textEditPasteItem(menu([item(3), item(0, false), paste]), get), paste);
  assert.throws(() => context.textEditPasteItem(menu([item(3)]), get), /one enabled/);
  assert.throws(() => context.textEditPasteItem(menu([paste, item()]), get), /one enabled/);
});
