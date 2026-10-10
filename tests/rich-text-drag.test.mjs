import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

function fixture({ enabled = '1', dest = 16, pasteFails = false, changed = false, attributesLost = false, before = 'alpha beta gamma\n', src = 0, deleteFails = false, selectFails = false, preparationFails = false, preparationChanges } = {}) {
  const context = vm.createContext({ ObjC: { import() {}, unwrap: value => value },
    $: { NSProcessInfo: { processInfo: { environment: { objectForKey: () => enabled } } } } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  context.dropIndex = () => dest;
  let text = before, pasted = false, selection = { location: src, length: 5 };
  const writes = [];
  const rich = { rtf: 'fixture-rtf', sourceRTF: 'source-rtf' };
  const area = {
    value: () => changed ? 'owner edit\n' : text,
    selection: () => selection,
    richMove: () => {
      if (preparationChanges === 'text') text = 'OWNER beta gamma\n';
      if (preparationChanges === 'selection') selection = { location: 6, length: 4 };
      if (preparationFails || preparationChanges) throw new Error('RTF unavailable'); return rich;
    },
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
test('only the exact rich-move opt-in uses the clipboard path', () => {
  for (const enabled of [undefined, '', '0', 'true', '01']) {
    // Passing null represents an absent native environment value; the fixture defaults to opt-in.
    const f = fixture({ enabled: enabled ?? null }), result = f.move();
    assert.equal(f.value(), 'beta gamma alpha\n');
    assert.equal(result.richTextMove, undefined);
    assert.deepEqual(f.writes.slice(0, 2), [['replace', 16, 0, ' alpha'], ['replace', 0, 6, '']]);
    const prepared = fixture({ enabled: enabled ?? null });
    assert.throws(() => prepared.move(prepared.plan), /opt-in|disabled/);
    assert.deepEqual(prepared.writes, []);
  }
  assert.ok(fixture({ enabled: '1' }).move().richTextMove);
});
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
test('initial rich preparation failure keeps the existing plain AX move', () => {
  const f = fixture({ preparationFails: true }), result = f.move();
  assert.equal(f.value(), 'beta gamma alpha\n');
  assert.equal(result.textChanged, true);
  assert.equal(f.writes.some(w => w[0] === 'paste'), false);
  assert.deepEqual(f.writes.slice(0, 2), [['replace', 16, 0, ' alpha'], ['replace', 0, 6, '']]);
});
test('a prepared rich child cannot turn preparation failure into plain edits', () => {
  const f = fixture({ preparationFails: true });
  assert.throws(() => f.move(f.plan), /RTF unavailable/);
  assert.deepEqual(f.writes, []);
});
test('initial preparation failure never lets plain fallback overwrite a concurrent text or selection change', () => {
  for (const preparationChanges of ['text', 'selection']) {
    const f = fixture({ preparationChanges });
    assert.throws(() => f.move(), /changed before the move/);
    assert.equal(f.value(), preparationChanges === 'text' ? 'OWNER beta gamma\n' : 'alpha beta gamma\n');
    assert.deepEqual(f.writes, []);
  }
});
test('spelling annotations do not count as formatting and visual changes do', () => {
  const nil = { isNil: () => true };
  const dictionary = values => ({ objectForKey: key => values[key] ?? nil });
  const font = name => dictionary({ AXFontName: name, AXFontSize: 14 });
  const context = vm.createContext({ ObjC: { import() {} }, $: { CFEqual: (a, b) => a === b } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  const normal = { AXFont: font('Helvetica'), AXForegroundColor: 'black' };
  const spelling = { ...normal, AXMisspelled: true, AXMarkedMisspelled: true, AXATextAlignmentValue: 3 };
  assert.equal(context.sameTextEditFormatting(dictionary(normal), dictionary(spelling)), true);
  for (const change of [{ AXFont: font('Helvetica-Bold') }, { AXFont: font('Helvetica-Oblique') },
    { AXFont: dictionary({ AXFontName: 'Helvetica', AXFontSize: 18 }) }, { AXForegroundColor: 'red' }, { AXUnderline: 1 }]) {
    assert.equal(context.sameTextEditFormatting(dictionary(normal), dictionary({ ...normal, ...change })), false);
  }
  assert.equal(context.sameTextEditFormatting(dictionary({}), dictionary({ AXUnderline: 0 })), true);
});
test('background rich paste searches only Edit and stops at its first enabled Command-V item', () => {
  const context = vm.createContext({ ObjC: { import() {},
    castRefToObject: ref => ref.native,
    unwrap: value => { if (value && 'native' in Object(value)) throw new Error('Raw CF reference'); return value; } } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  const item = (modifiers = 0, enabled = true) => ({ AXRole: 'AXMenuItem', AXMenuItemCmdChar: 'v', AXMenuItemCmdModifiers: modifiers, AXEnabled: enabled });
  const children = items => ({ count: items.length, objectAtIndex: i => items[i] });
  const file = { AXTitle: 'File', AXChildren: children([]) }, after = { AXTitle: 'Format', AXChildren: children([]) };
  const menu = items => ({ AXMenuBar: { AXChildren: children([
    file,
    { AXTitle: 'Edit', AXChildren: children([{ AXChildren: children(items) }]) },
    after,
  ]) } });
  const accesses = [];
  const get = (el, name) => { accesses.push([el, name]); if (!(name in el)) throw new Error('Unsupported attribute'); return { native: el[name] }; };
  const paste = item();
  assert.equal(context.textEditPasteItem(menu([item(3), item(0, false), paste]), get), paste);
  assert.equal(accesses.some(([el, name]) => el === file && name === 'AXChildren' || el === after), false);
  assert.throws(() => context.textEditPasteItem(menu([item(3)]), get), /enabled.*Paste/);
  const later = item(); accesses.length = 0;
  assert.equal(context.textEditPasteItem(menu([paste, later]), get), paste);
  assert.equal(accesses.some(([el]) => el === later), false);
});

test('missing foreground color equals opaque black in RGB or grayscale, but not red or transparency', () => {
  const nil = { isNil: () => true }, dictionary = values => ({ objectForKey: key => values[key] ?? nil });
  const color = (r, g, b, a = 1) => ({ colorUsingColorSpace: () => ({ redComponent: r, greenComponent: g, blueComponent: b, alphaComponent: a }) });
  const context = vm.createContext({ ObjC: { import() {}, castRefToObject: value => value },
    $: { CFEqual: (a, b) => a === b, NSColor: { colorWithCGColor: value => value }, NSColorSpace: { genericRGBColorSpace: {} } } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  for (const black of [color(0, 0, 0), color(0, 0, 0)]) {
    assert.equal(context.sameTextEditFormatting(dictionary({}), dictionary({ AXForegroundColor: black })), true);
    assert.equal(context.sameTextEditFormatting(dictionary({ AXForegroundColor: black }), dictionary({})), true);
  }
  for (const other of [color(1, 0, 0), color(0, 0, 0, 0.5)]) {
    assert.equal(context.sameTextEditFormatting(dictionary({}), dictionary({ AXForegroundColor: other })), false);
  }
});
test('native CGColor values compare against the missing foreground default without app access', { skip: process.platform !== 'darwin' }, () => {
  const context = vm.createContext({ ObjC: { import() {} } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  const code = `ObjC.import('AppKit'); ObjC.import('CoreGraphics');
    ObjC.bindFunction('objc_msgSend', ['id', ['id', 'selector']]);
    const attempt = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
    ${context.sameTextEditFormatting.toString()}
    const empty = $({});
    const attributes = color => { const d = $.NSMutableDictionary.alloc.init;
      d.setObjectForKey($.objc_msgSend(color, 'CGColor'), 'AXForegroundColor'); return d; };
    JSON.stringify([
      sameTextEditFormatting(empty, attributes($.NSColor.colorWithSRGBRedGreenBlueAlpha(0, 0, 0, 1))),
      sameTextEditFormatting(empty, attributes($.NSColor.colorWithCalibratedWhiteAlpha(0, 1))),
      sameTextEditFormatting(empty, attributes($.NSColor.redColor)),
      sameTextEditFormatting(empty, attributes($.NSColor.colorWithSRGBRedGreenBlueAlpha(0, 0, 0, 0.5)))
    ]);`;
  const result = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', code], { encoding: 'utf8', timeout: 10000 });
  assert.deepEqual(JSON.parse(result), [true, true, false, false]);
});

test('Paste refuses less than five seconds of parent budget and reports a bounded AX failure', () => {
  let now = 10000, pressed = 0, posted = 0, status = 0, timeoutStatus = 0;
  const calls = [], paste = {};
  const $ = value => ({ dataUsingEncoding: () => value });
  Object.assign($, {
    AXUIElementSetMessagingTimeout: (el, seconds) => { assert.equal(el, paste); calls.push(['timeout', seconds]); return timeoutStatus; },
    AXUIElementPerformAction: () => { pressed++; return status; },
    NSFileHandle: { fileHandleWithStandardError: { writeData: value => calls.push(['receipt', value]) } },
  });
  const context = vm.createContext({ $, ObjC: { import() {} }, Date: { now: () => now } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  assert.throws(() => context.pressRichPaste(paste, 14999, () => posted++), /5 s|five seconds/);
  assert.equal(pressed, 0); assert.equal(posted, 0); assert.equal(calls.some(c => c[0] === 'receipt'), false);
  timeoutStatus = -25205;
  assert.throws(() => context.pressRichPaste(paste, 20000, () => posted++), /timeout.*-25205/);
  assert.equal(pressed, 0); assert.equal(posted, 0);
  timeoutStatus = 0; status = -25204;
  assert.throws(() => context.pressRichPaste(paste, 15000, () => posted++), /not acknowledged.*-25204/);
  assert.equal(pressed, 1); assert.equal(posted, 1);
  assert.ok(calls.some(c => c[0] === 'timeout' && c[1] === 1));
});

test('recovery notices queue for the relay and are taken once', async () => {
  const { queueRichTextNotice, takeRichTextNotices } = await import('../plugins/sleight/lib/rich-text-drag.mjs');
  takeRichTextNotices();
  const error = console.error; console.error = () => {};
  try { queueRichTextNotice('one'); queueRichTextNotice('two'); } finally { console.error = error; }
  assert.deepEqual(takeRichTextNotices(), ['one', 'two']);
  assert.deepEqual(takeRichTextNotices(), []);
});
