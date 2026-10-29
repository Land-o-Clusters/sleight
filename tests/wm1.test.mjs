import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay, openMenuNote } from '../plugins/sleight/lib/relay.mjs';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';

const header = 'Window: "Draft", App: Editor.\n0 standard window Draft';
// Reduced exact lines from the 2026-10-17 10:25 word-edit rerun (runs 3 and 1).
const menu = '124 menu bar\n\t129 Insert\n\t132 (selected) Table\n\t133 Window, ID: WindowMenu_MenuItem';
const search = '\t\t\t\t\t\t12 combo box (settable) Description: Search Document, Secondary Actions: Confirm';
const body = '\t\t\t\t\t\t\t29 text entry area (disabled, settable) Description: Page 1 content, Value: Amber';
const beforeBody = body.replace('Amber', 'Report');
const tree = rows => header + '\n' + rows.join('\n');
const item = text => ({ type: 'text', text });
const mark = '[sleight:filtered-read:wm1]';
const warning = /typed text landed in/;

// word-edit-2 (2026-10-18, lines 104-114): Escape and clicking the menu-bar item reopened the menu; its Cancel closed it.
const cancelItem = /Close it(?: with|:) `await app\.performSecondaryAction\(132, "Cancel"\)`, not Escape/;
// word-edit-1 (2026-10-18, lines 120 to 150): with no menu showing, Cancel on the title did nothing; clicking it opened
// its menu, and that menu's Cancel closed it.
const cancelFirst = /Click 132(?: to open its menu, then close that menu with|, then) `await app\.performSecondaryAction\(<its menu>, "Cancel"\)`/;
test('a selected menu-bar title with no menu says to open its menu, then cancel that menu', () => {
  for (const prompt of [undefined, 'lean']) {
    const note = openMenuNote(header + '\n' + menu, prompt);
    assert.match(note, prompt === 'lean' ? /^sleight: menu-bar item 132 traps input\. Click 132, then `await app\.performSecondaryAction\(<its menu>, "Cancel"\)`\.$/
      : /^sleight: a menu may be stuck open: menu-bar item 132 is selected with no menu showing, and keys may not reach the document\. [^\n]*; Cancel on the menu-bar item alone does nothing\.$/);
    assert.match(note, cancelFirst);
    assert.doesNotMatch(note, /performSecondaryAction\(132|Try one Escape|Escape once|app\.click\(|closes it|won't land/);
  }
  // The title's own Cancel action keeps the direct advice, with its caveat.
  for (const prompt of [undefined, 'lean']) {
    const note = openMenuNote(header + '\n' + menu.replace('(selected) Table', '(selected) Table, Secondary Actions: Cancel, Pick'), prompt);
    assert.match(note, cancelItem);
    assert.match(note, /; if (?:it stays open|still stuck), tell the user\.$/);
  }
});

test('selected menu-bar items with an explicit role also warn', () => {
  assert.match(openMenuNote(header + '\n' + menu.replace('(selected) Table', 'menu bar item (selected) Table')), cancelFirst);
});

test('a menu element with Cancel for the selected title is the one the note cancels', () => {
  // The menu read as its own root, as in word-edit-2 line 107, and the item's own line carrying Cancel.
  assert.match(openMenuNote(header + '\n' + menu + '\n140 Table, Secondary Actions: Cancel, Pick'), /performSecondaryAction\(140, "Cancel"\)/);
  assert.match(openMenuNote(header + '\n' + menu.replace('(selected) Table', '(selected) Table, Secondary Actions: Cancel, Pick')), cancelItem);
  // Another title's Cancel or a button named like it is not the menu.
  for (const extra of ['140 Insert, Secondary Actions: Cancel, Pick', '\t141 button Table, Secondary Actions: Cancel']) {
    assert.match(openMenuNote(header + '\n' + menu + '\n' + extra), cancelFirst, extra);
  }
});

test('the relay gives full advice once until selection disappears, then starts a new episode', t => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const replies = [];
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: false, changeReview: false });
  t.after(() => { relay.dispose(); streams.forEach(stream => stream.destroy()); });
  clientOut.on('data', data => replies.push(...data.toString().trim().split('\n').map(JSON.parse)));
  let id = 0;
  const read = rows => {
    clientIn.write(JSON.stringify({ id: ++id, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.getAXState();' } } }) + '\n');
    serverOut.write(JSON.stringify({ id, result: { content: [item(rows)] } }) + '\n');
    return replies.find(reply => reply.id === id).result.content.map(part => part.text ?? '').join('\n');
  };
  assert.match(read('## Computer Use\n\nNative reference.\n' + header + '\n' + menu), cancelFirst);
  for (const rows of [menu, menu.replace('132', '142'), menu.replace('Table', 'Insert')]) {
    const out = read(header + '\n' + rows);
    assert.doesNotMatch(out, /Close it with|if it stays open/);
    const notes = out.split('\n').filter(line => /^sleight:.*menu.*(?:stuck|open)/.test(line));
    assert.ok(notes.length <= 1);
  }
  read('No tree in this reply.');
  assert.doesNotMatch(read(header + '\n' + menu), cancelFirst);
  read(header + '\n…(20)');
  assert.doesNotMatch(read(header + '\n' + menu), cancelFirst);
  read(header + '\n+ 20 button Save');
  assert.doesNotMatch(read(header + '\n' + menu), cancelFirst);
  assert.doesNotMatch(read('## Computer Use\n\nNative reference.\n' + header + '\n' + menu), cancelFirst);
  read(header + '\n' + menu.replace('(selected) ', ''));
  assert.match(read(header + '\n' + menu), cancelFirst);
});

// word-edit-1 (2026-10-17): the short note repeated through 15 calls of Escape and clicks while keys were swallowed.
test('the third stuck note for the same window and item says to check typing and switch route', t => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const replies = [];
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: false, changeReview: false });
  t.after(() => { relay.dispose(); streams.forEach(stream => stream.destroy()); });
  clientOut.on('data', data => replies.push(...data.toString().trim().split('\n').map(JSON.parse)));
  let id = 0;
  const read = rows => {
    clientIn.write(JSON.stringify({ id: ++id, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.pressKey("Escape");' } } }) + '\n');
    serverOut.write(JSON.stringify({ id, result: { content: [item(header + '\n' + rows)] } }) + '\n');
    return replies.find(reply => reply.id === id).result.content.map(part => part.text ?? '').join('\n');
  };
  const escalated = /keys may be swallowed[^\n]*\. Check that typing landed \(a value or count in the tree changed\), and switch route \(a toolbar or ribbon control, or a keyboard shortcut\) instead of repeating Escape or clicks\./;
  assert.match(read(menu), cancelFirst);
  assert.doesNotMatch(read(menu), escalated);
  for (let i = 0; i < 3; i++) assert.match(read(menu), escalated);
  // No menu shows and the title has no Cancel, so the escalation keeps the reopen-then-cancel route.
  assert.match(read(menu), /instead of repeating Escape or clicks\. Or click 132 to open its menu, then close that menu with `await app\.performSecondaryAction\(<its menu>, "Cancel"\)`/);
  // Another selected title starts its count again, then escalates.
  const other = menu.replace('Table', 'Insert');
  assert.doesNotMatch(read(other), escalated);
  assert.match(read(other), escalated);
  // The item clears: the next episode starts with the full note.
  read(menu.replace('(selected) ', ''));
  assert.match(read(menu), cancelFirst);
  assert.doesNotMatch(read(menu), escalated);
  assert.match(read(menu), escalated);
});

test('menu warnings require selection under the menu bar and keep Cancel recovery', () => {
  for (const text of [header, header + '\n' + menu.replace('(selected) ', ''),
    header + '\n\t132 (selected) Table', header + '\n124 menu bar\n\t125 File\n126 group\n\t132 (selected) Table',
    header + '\n124 menu bar\n\t125 menu\n\t\t132 row (selected) Table',
    'Window: "", App: Editor.\n0 menu Table\n' + menu]) {
    assert.equal(openMenuNote(text), undefined, text);
  }
  const note = openMenuNote('Window: "", App: Editor.\n0 menu Secondary Actions: Cancel\n' + menu);
  assert.match(note, /performSecondaryAction\(0, "Cancel"\)/);
  assert.doesNotMatch(note, /tracking loop/);
});

function result(after, { code = 'await app.click(12); await app.typeText(query);', typed = ['amber'],
  before = [search, beforeBody], failed = false, overlap = false, suffix = '', otherWindow = false } = {}) {
  const c = createReadCompactor();
  c.process([item(tree(before))]);
  const action = c.beginAction(code);
  if (action) action.overlap = overlap;
  const current = tree(after).replace('App: Editor.', otherWindow ? 'App: Other.' : 'App: Editor.') + suffix;
  return c.process([item(GUARD_MARK + current + GUARD_END + mark + JSON.stringify({ typed }) + '\n')],
    { action, code, failed, filterMark: mark }).map(i => i.text).join('\n');
}

test('runtime typed text in the changed body names it and the clicked Search field once', () => {
  const out = result([search, body]);
  assert.match(out, /typed text landed in element 29 \(Page 1 content\), not in the clicked element 12 \(Search Document\)/);
  assert.equal(out.match(warning)?.length, 1);
  assert.doesNotMatch(out, /filtered-read|"typed"/);
});

test('the word-edit call shape permits a trailing Return and AX read', () => {
  const code = 'await app.click(12); await app.typeText("amber"); await app.pressKey("Return"); await app.getAXState();';
  assert.match(result([search, body], { code }), warning);
  assert.match(result([search, body], { code: 'await app.click(12); await app.typeText(query); await app.getAXState();' }), warning);
  for (const code of ['await app.click(12); await app.pressKey("Return"); await app.typeText(query);',
    'await app.click(12); await app.typeText(query); await other.pressKey("Return");']) {
    assert.doesNotMatch(result([search, body], { code }), warning);
  }
});

test('a field cleared on Return and its newly added row never imply misplaced typing', () => {
  const code = 'await app.click(12); await app.typeText(query); await app.pressKey("Return"); await app.getAXState();';
  const added = '\t13 row\n\t\t14 text field (settable) Description: Task, Value: amber';
  assert.doesNotMatch(result([search, added], { before: [search], code }), warning);
});

test('short input and common text already in the destination stay silent', () => {
  for (const typed of ['a', ' a ', 'ab', '  ab  ']) {
    assert.doesNotMatch(result([search, body.replace('Amber', typed)], { typed: [typed] }), warning);
  }
  assert.doesNotMatch(result([search, body.replace('Amber', 'the report')],
    { before: [search, beforeBody.replace('Report', 'the draft')], typed: ['the'] }), warning);
});

test('new settable elements and matching fields at a different position path stay silent', () => {
  assert.doesNotMatch(result([search, body], { before: [search] }), warning);
  assert.doesNotMatch(result([search, '\t90 group\n' + body], { before: [search, beforeBody] }), warning);
  assert.doesNotMatch(result([search, beforeBody.replace('29 text', '30 text').replace('Page 1 content', 'Other content'), body]), warning);
});

test('the clicked field showing the typed text suppresses the warning even if the body changed too', () => {
  assert.doesNotMatch(result([search.replace(', Secondary', ', Value: amber, Secondary'), body]), warning);
});

test('matching follows a renumbered field and does not confuse its new number with another field', () => {
  assert.match(result([search.replace('12 combo', '14 combo'), body]), warning);
  assert.doesNotMatch(result([search.replace('12 combo', '14 combo').replace(', Secondary', ', Value: Amber, Secondary'), body]), warning);
});

test('unchanged text, labels and Help are not evidence that input landed there', () => {
  for (const [after, options] of [
    [[search, body], { before: [search, body] }],
    [[search, beforeBody + ', Help: amber'], {}],
    [[search, beforeBody.replace('Page 1 content', 'amber')], {}],
    [[search, body], { typed: [] }],
    [[search, body], { typed: ['   '] }],
    [[search, body], { typed: ['different'] }],
  ]) assert.doesNotMatch(result(after, options), warning);
});

test('ambiguous recipients, missing clicked fields and non-settable clicks stay silent', () => {
  for (const [after, options] of [
    [[search, body, body.replace('29 text', '30 text').replace('Page 1 content', 'Other content')], {}],
    [[body], {}],
    [[search, body], { before: [search, search.replace('12 combo', '14 combo'), beforeBody] }],
    [[search, body], { before: [search.replace(' (settable)', ''), beforeBody] }],
  ]) assert.doesNotMatch(result(after, options), warning);
});

test('failed, overlapping, incomplete and different-window observations stay silent', () => {
  for (const options of [{ failed: true }, { overlap: true }, { suffix: '\n…(20)' }, { otherWindow: true }]) {
    assert.doesNotMatch(result([search, body], options), warning);
  }
});

test('typing before the click, another handle, multiple clicks or a focus-moving key stay silent', () => {
  for (const code of ['await app.typeText(query); await app.click(12);',
    'await app.click(12); await other.typeText(query);',
    'await app.click(12); await app.click(29); await app.typeText(query);',
    'await app.click(12); await app.pressKey("Tab"); await app.typeText(query);',
    'await app.click(12); await app.setValue(29, query);']) {
    assert.doesNotMatch(result([search, body], { code }), warning);
  }
});

test('typed receipts coexist with a filtered-read receipt and are removed from the result', () => {
  const c = createReadCompactor();
  const out = c.process([item(mark + JSON.stringify({ full: true }) + '\n' + mark + JSON.stringify({ typed: ['amber'] }) + '\n')],
    { filterMark: mark });
  assert.deepEqual(out, []);
});

test('the document guard emits this call\'s runtime typed value, then resets it on reuse', async () => {
  const output = [];
  const raw = { getAXState: async () => tree([search, beforeBody]) + '\n\nThe focused UI element is 12 ' + search.trim().replace(/^12 /, ''), click: async () => {}, typeText: async () => {} };
  const context = createContext({ app: raw, query: 'amber', setTimeout, cua: { getApp: async () => raw }, nodeRepl: { write: text => output.push(text) } });
  const window = { title: 'Draft', app: 'Editor', url: null };
  await runInContext(`(async () => { ${guardedCode('await app.click(12); await app.typeText(query);', window, undefined, undefined, { resultMark: mark })} })()`, context);
  assert.ok(output.includes(mark + JSON.stringify({ typed: ['amber'] }) + '\n'));
  output.length = 0;
  await runInContext(`(async () => { ${guardedCode('await app.click(12);', window, undefined, undefined, { reuseSetup: true, resultMark: mark })} })()`, context);
  assert.ok(!output.some(text => text.startsWith(mark)), 'no previous call\'s typed text');
});

test('the relay carries the runtime receipt into the compactor without driving an app', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-wm1-'));
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const pending = new Map();
  let content = [], changed = false, id = 0;
  const write = text => content.push(item(text));
  // Even a focused field's AX claim cannot prove where the engine sent text; keep the post-check.
  const current = () => tree([search, changed ? body : beforeBody]) + '\n\nThe focused UI element is 12 ' + search.trim().replace(/^12 /, '');
  const raw = { getAXState: async () => current(), click: async () => {}, typeText: async () => { changed = true; }, pressKey: async () => {} };
  const context = createContext({ query: 'amber', setTimeout, cua: { getApp: async () => { write(current()); return raw; }, listApps: async () => [] }, nodeRepl: { write } });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'wm1-fixture', changeReview: false,
    inputLease: new InputLease({ directory, holder: 'fixture' }) });
  t.after(() => { relay.dispose(); streams.forEach(s => s.destroy()); removeTemp(directory); });
  clientOut.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const msg = JSON.parse(line); pending.get(msg.id)?.(msg.result);
    }
  });
  let queue = Promise.resolve();
  serverIn.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const msg = JSON.parse(line);
      if (msg.method !== 'tools/call') continue;
      queue = queue.then(async () => {
        content = [];
        let isError = false;
        try { await runInContext(`(async () => { ${msg.params.arguments.code.replace(/\bvar app\s*=/, 'globalThis.app =')} })()`, context,
          { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
        catch (error) { isError = true; write(error.message); }
        serverOut.write(JSON.stringify({ id: msg.id, result: { content, isError, _meta: { 'codex/toolSurface': { app: { appId: 'example.fixture' } } } } }) + '\n');
      });
    }
  });
  const call = code => new Promise(resolve => {
    pending.set(++id, resolve);
    clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  });
  assert.equal((await call('var app = await cua.getApp("example.fixture")')).isError, false);
  const reply = await call('await app.click(12); await app.typeText("amber"); await app.pressKey("Return"); await app.getAXState();');
  assert.equal(reply.isError, false, JSON.stringify(reply.content));
  const out = reply.content.map(i => i.text).join('\n');
  assert.match(out, warning);
  assert.doesNotMatch(out, /filtered-read|"typed"/);
});

// word-edit-1 at 2026-10-17T23-30-19 (lines 139-141): after Insert > Table, typing with no click went into the
// sidebar's Replace With combo box, and no note fired (no click, four typed strings, a degraded read).
const sidebarRows = value => ['1 split group', '\t2 Task Pane Sidebar',
  `\t\t12 combo box (settable) Description: Search Document, Value: amber, Secondary Actions: Confirm`,
  `\t\t15 combo box (settable) Description: Replace With, Value: ${value}, Secondary Actions: Confirm`,
  '\t\t23 table', '\t24 split group Document Pane',
  '\t\t36 text entry area (disabled, settable) Description: Page 1 content, Value: **Report**', 'The violet shipment is ready.',
  '\t92 button Checking for proofing errors.', '132 menu bar', '\t137 Insert'];
const stray = /typed text landed in element 15 \(Replace With\), not the document; click the document before typing\./;
function typing(previous, code, { after = sidebarRows('Item'), prompt, focus = '\nThe focused UI element is 23 table', was = 'violet' } = {}) {
  const c = createReadCompactor({ prompt });
  const before = tree(sidebarRows(was)) + '\n\nSelected text: ```\nviolet\n```';
  c.process([item(before)]);
  if (previous) {
    const action = c.beginAction(previous);
    c.process([item(GUARD_MARK + before + GUARD_END)], { action, code: previous });
  }
  const action = c.beginAction(code);
  return c.process([item(GUARD_MARK + tree(after) + '\n' + focus + GUARD_END)], { action, code }).map(i => i.text).join('\n');
}
const cells = 'await app.typeText("Item"); await app.pressKey("Tab"); await app.typeText("Count"); await app.pressKey("Tab"); await app.typeText("7");';

test('typing aimed at the document that lands in a sidebar field says where it went', () => {
  assert.match(typing('await app.click(137);', cells), stray);
  // The same call clicking a document element first. The document field exposed a value and kept it, so SB3's
  // wrong-field notice (which names both fields) replaces this note instead of giving two kinds of advice.
  assert.match(typing(undefined, 'await app.click(36); ' + cells),
    /The text is now in 15 \(Replace With combo box\); clear it before continuing\. Requested write not done: 36 /);
  assert.match(typing('await app.click(137);', cells, { prompt: 'lean' }), /typed text landed in element 15 \(Replace With\); click the document first\./);
});

test('typing into the field Claude aimed at, or after unknown focus moves, stays silent', () => {
  for (const [previous, code] of [
    [undefined, cells], // nothing aimed in this window yet
    ['await app.click(15);', cells], ['await app.setValue(15, "x");', cells],
    ['await app.pressKey("super+f");', cells], ['await app.click([400, 196]);', cells],
    ['await app.click(137);', 'await app.pressKey("Tab"); ' + cells], ['await app.click(137);', 'await app.click([10, 10]); ' + cells],
  ]) assert.doesNotMatch(typing(previous, code), /typed text landed/, `${previous} ${code}`);
  // The field already held the text, the text is too short, or it went into the document.
  assert.doesNotMatch(typing('await app.click(137);', cells, { was: 'Item', after: sidebarRows('Item') }), /typed text landed/);
  assert.doesNotMatch(typing('await app.click(137);', 'await app.typeText("It");', { after: sidebarRows('It') }), /typed text landed/);
  assert.doesNotMatch(typing('await app.click(137);', cells, { after: sidebarRows('violet').map(row => row.replace('**Report**', '**Report** Item')) }), /typed text landed/);
});

// Same run, lines 173-180: with the sidebar closed the window kept focus, and typing and Tab reached nothing.
const windowFocus = '\nThe focused UI element is 0 standard window Draft';
const noTarget = /keyboard focus is on the window itself, so typed keys have no target\. Click the document first\./;
const docRows = (text = '**Report**', button = 'No proofing errors.') => ['1 split group', '\t2 split group Document Pane',
  `\t\t16 text entry area (disabled, settable) Description: Page 1 content, Value: ${text}`, `\t81 button ${button}`];
function focusless(code, { after = docRows(), focus = windowFocus, prompt } = {}) {
  const c = createReadCompactor({ prompt });
  c.process([item(tree(docRows('**Report**', 'Checking for proofing errors.')) + '\n' + windowFocus)]);
  const action = c.beginAction(code);
  return c.process([item(GUARD_MARK + tree(after) + '\n' + focus + GUARD_END)], { action, code }).map(i => i.text).join('\n');
}

test('typing while the window itself has focus says keys have no target', () => {
  assert.match(focusless(cells + ' await app.getScreenshot();'), noTarget);
  assert.match(focusless('await app.click([100, 224]); await app.typeText("Item");'), noTarget);
  assert.match(focusless(cells, { prompt: 'lean' }), /window has focus; keys have no target\. Click the document first\./);
});

test('focus on an element, typed text that arrived, a changed value or no typing stays silent', () => {
  assert.doesNotMatch(focusless(cells, { focus: '\nThe focused UI element is 16 text entry area' }), noTarget);
  assert.doesNotMatch(focusless(cells, { focus: '' }), noTarget);
  assert.doesNotMatch(focusless(cells, { after: docRows('**Report** Item') }), noTarget);
  assert.doesNotMatch(focusless(cells, { after: docRows('**Report** 7') }), noTarget);
  assert.doesNotMatch(focusless('await app.paste("Item");'), noTarget);
  assert.doesNotMatch(focusless('await app.typeText(text);'), noTarget);
});

// word-edit-2 (2026-10-18, lines 81-234) and word-edit-1 (2026-10-17, lines 61-217): with the Table menu selected in
// the menu bar, typed text reached nothing and the word count stayed the same, whatever element had focus.
const deadTyping = /typing reached nothing/;
const stuckRows = (text = '**Report**', words = '12 words') => [...docRows(text), `\t82 button Status: ${words}`, ...menu.split('\n')];
function dead(code, { before = stuckRows(), after = stuckRows(), focus = '\nThe focused UI element is 16 text entry area', prompt } = {}) {
  const c = createReadCompactor({ prompt });
  c.process([item(tree(before) + '\n' + focus)]);
  const action = c.beginAction(code);
  return c.process([item(GUARD_MARK + tree(after) + '\n' + focus + GUARD_END)], { action, code }).map(i => i.text).join('\n');
}

test('typing that changes nothing while a menu-bar item is selected names the item', () => {
  for (const focus of ['\nThe focused UI element is 16 text entry area', windowFocus, '']) {
    assert.match(dead(cells, { focus }), /sleight: typing reached nothing; menu-bar item 132 is still selected: cancel the menu first\./, focus);
  }
  assert.match(dead('await app.typeText("Quarterly summary");', { prompt: 'lean' }), /sleight: typing lost; menu-bar item 132 selected: cancel its menu first\./);
});

test('typing that changes nothing with focus on an element and no menu says so', () => {
  const rows = () => stuckRows().filter(row => !/menu bar|\t1(?:29|32|33) /.test(row));
  assert.match(dead(cells, { before: rows(), after: rows() }), /sleight: typing reached nothing; no typed text or value appears\. Click the target first\./);
  assert.match(dead(cells, { before: rows(), after: rows(), prompt: 'lean' }), /sleight: typing lost \(nothing changed\); click the target first\./);
  // Focus on the window itself keeps its own wording.
  assert.match(dead(cells, { before: rows(), after: rows(), focus: windowFocus }), noTarget);
});

test('dead-typing stays silent when the text arrived, a value or count changed, or the field is secure', () => {
  const secure = [...stuckRows(), '\t91 secure text field (settable) Description: Password'];
  const valueless = stuckRows().filter(row => !/text entry area/.test(row));
  for (const [name, options, code = cells] of [
    ['typed text in the body', { after: stuckRows('**Report** Item Count 7') }],
    ['typed text anywhere in the tree', { after: [...stuckRows(), '\t90 text Item'] }],
    ['text already present before', { before: stuckRows('Item list'), after: stuckRows('Item list') }],
    ['the word count changed', { after: stuckRows('**Report**', '13 words') }],
    ['a value changed', { after: stuckRows('**Report** x') }],
    ['short text only', {}, 'await app.typeText("ab"); await app.pressKey("Tab"); await app.typeText("7");'],
    ['a non-literal string', {}, 'await app.typeText(text);'],
    ['a secure field', { before: secure, after: secure }],
    ['no text value to show typing', { before: valueless, after: valueless }],
  ]) assert.doesNotMatch(dead(code, options), deadTyping, name);
});
