import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
import { guardStopMark, takeGuardStop, menuRemainder, splitMenuActions } from '../plugins/sleight/lib/menu-continuation.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const window = { title: 'Draft', app: 'Fixture Editor', url: null };
const tree = rows => 'Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n' + rows;
const text = value => ({ type: 'text', text: value });
async function execute(rows, code, options = {}) {
  const output = [], inputs = [], mark = guardStopMark();
  const raw = { getAXState: async () => tree(rows), click: async n => {
    inputs.push(n);
    if (options.engineError) throw new Error(options.engineError);
  }, pressKey: async key => inputs.push(key) };
  const context = { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: value => output.push(String(value)) } };
  let error;
  try { await runInNewContext(`(async () => { ${guardedCode(code, window, undefined, undefined, { guardStopMark: mark, ...options })} })()`, context); }
  catch (e) { error = e; output.push(String(e)); }
  return { inputs, error, taken: takeGuardStop([text(output.join('\n'))], mark) };
}

for (const line of ['close button', 'close button (enabled), ID: window-close',
  'close button Description: Close, ID: window-close']) {
  test('a numbered window close stops before input: ' + line, async () => {
    const f = await execute('\t1 ' + line, 'await app.click(1);');
    assert.deepEqual(f.inputs, []);
    assert.match(f.error?.message ?? '', /element 1 is the window's close button; close a window by label or with Cmd\+W/);
    assert.equal(f.taken.input, false);
    assert.equal(f.taken.receipt?.index, 0);
  });
}

for (const selector of ['"Close"', '{ label: "Close" }', '{ id: "window-close" }']) {
  test('an explicit window close still passes: ' + selector, async () => {
    const f = await execute('\t1 close button Description: Close, ID: window-close', `await app.click(${selector});`);
    assert.equal(f.error, undefined);
    assert.deepEqual(f.inputs, [1]);
  });
}

for (const line of ['button Target', 'button Close', 'button Description: close button',
  'button Target, ID: close button', 'minimize button', 'full screen button']) {
  test('other numbered controls still pass: ' + line, async () => {
    const f = await execute('\t1 ' + line, 'await app.click(1);');
    assert.equal(f.error, undefined);
    assert.deepEqual(f.inputs, [1]);
  });
}

test('a close number computed from the current read still stops before input', async () => {
  const f = await execute('\t1 close button',
    'const text = await app.getAXState(); const n = Number(/(\\d+) close button/.exec(text)[1]); await app.click(n);',
    { literals: [] });
  assert.deepEqual(f.inputs, []);
  assert.match(f.error?.message ?? '', /element 1 is the window's close button/);
});

for (const selector of ['"Insert"', '{ label: "Insert" }']) {
  test(`one content match beats menu-bar descendants for ${selector}`, async () => {
    const f = await execute('\t1 tab group Ribbon\n\t\t2 tab Insert\n3 menu bar\n\t4 Insert\n\t5 menu Extra\n\t\t6 menu item Insert', `await app.click(${selector});`);
    assert.equal(f.error, undefined);
    assert.deepEqual(f.inputs, [2]);
  });
}

for (const [name, rows] of [
  ['two content matches', '\t1 tab group Ribbon\n\t\t2 tab Insert\n\t3 group Tools\n\t\t4 button Insert\n5 menu bar\n\t6 Insert'],
  ['only menu matches', '1 menu bar\n\t2 Insert\n\t3 menu More\n\t\t4 menu item Insert'],
  ['unknown root', '\t1 group Tools\n\t\t2 button Insert\n3 button Insert'],
  ['menu words in a content label', '\t1 group menu bar\n\t\t2 button Insert\n\t3 button Insert'],
]) test(`${name} stays ambiguous and lists candidate numbers and parents`, async () => {
  const f = await execute(rows, 'await app.click({ label: "Insert" });');
  assert.match(f.error?.message ?? '', /elements with label "Insert"/);
  assert.deepEqual(f.inputs, []);
  if (name === 'two content matches') {
    // A menu-bar title among them is named apart from the other elements.
    assert.match(f.error.message, /menu-bar item 6; other elements 2 \(parent tab group Ribbon\), 4 \(parent group Tools\)\./);
    return;
  }
  for (const line of rows.split('\n').filter(line => /(?:tab|button|menu item) Insert$|\d+ Insert$/.test(line))) {
    const number = /\d+/.exec(line)[0];
    assert.match(f.error.message, new RegExp('candidate ' + number + ': parent '));
  }
});

// word-edit-1 and -2 (2026-10-17): { label: "Table" } clicked the menu-bar title, whose menu then trapped typing.
for (const selector of ['"Table"', '{ label: "Table" }']) {
  test(`a menu-bar title loses to the one element outside the menu bar for ${selector}`, async () => {
    // The toolbar is its own root, so no window-content preference applies.
    const f = await execute('3 toolbar Tools\n\t4 button Table\n5 menu bar\n\t6 Insert\n\t7 Table', `await app.click(${selector});`);
    assert.equal(f.error, undefined);
    assert.deepEqual(f.inputs, [4]);
  });
  test(`a label only a menu-bar title has still clicks it for ${selector}`, async () => {
    const f = await execute('\t1 button Insert\n5 menu bar\n\t6 Insert\n\t7 Table', `await app.click(${selector});`);
    assert.equal(f.error, undefined);
    assert.deepEqual(f.inputs, [7]);
  });
  test(`a menu-bar title and two other elements stop before input, naming both sides, for ${selector}`, async () => {
    const f = await execute('3 toolbar Tools\n\t4 button Table\n8 group Panel\n\t9 button Table\n5 menu bar\n\t7 Table', `await app.click(${selector});`);
    assert.deepEqual(f.inputs, []);
    assert.match(f.error?.message ?? '', /3 elements with label (?:or ID )?"Table" in this window\. menu-bar item 7; other elements 4 \(parent toolbar Tools\), 9 \(parent group Panel\)\./);
  });
}

test('duplicate IDs and full lines never get the content-label preference', async () => {
  for (const selector of ['{ id: "duplicate" }', '{ line: "button Insert, ID: duplicate" }']) {
    const f = await execute('\t1 button Insert, ID: duplicate\n2 menu bar\n\t3 button Insert, ID: duplicate', `await app.click(${selector});`);
    assert.match(f.error?.message ?? '', /2 elements/);
    assert.deepEqual(f.inputs, []);
  }
});

test('the window root itself is not a match inside window content', async () => {
  const f = await execute('1 menu bar\n\t2 Draft', 'await app.click("Draft");');
  assert.match(f.error?.message ?? '', /2 elements with label or ID "Draft"/);
  assert.deepEqual(f.inputs, []);
});

for (const [name, code, options, expected] of [
  ['first label stop', 'await app.click("Missing");', {}, 'no input was sent'],
  ['native denial', 'await app.click("Target");', { nativeDenied: 'native route denied' }, 'no input was sent'],
  ['window stop', 'await app.click("Target");', { }, 'no input was sent'],
  ['later stop', 'await app.click("Target"); await app.click("Missing");', {}, 'partial input possible'],
  ['engine rejection', 'await app.click("Target");', { engineError: 'engine target disappeared' }, 'partial input possible'],
  ['caught stop followed by input', 'try { await app.click("Missing"); } catch {} await app.click("Target");', {}, 'partial input possible'],
  ['cancel then stop', 'await app.pressKey("Escape"); await app.click("Missing");', { fileOnly: true }, 'partial input possible'],
]) test(`${name} reports the cause and actual input boundary`, async () => {
  const f = await execute('\t1 button Target', code, name === 'window stop' ? { ...options, prior: { text: tree('\t1 button Target').replaceAll('Draft', 'Other'), windows: null } } : options);
  const c = createReadCompactor(); c.process([text(tree('\t1 button Target'))]);
  const result = c.process(f.taken.content, { action: c.beginAction(code), failed: true,
    failure: { message: f.taken.receipt?.error, noInput: f.taken.receipt?.index === 0 && !f.taken.input } });
  const note = result.at(-1).text;
  assert.match(note, new RegExp(expected));
  const cause = f.taken.receipt?.error;
  assert.ok(cause && note.includes(cause), note);
  assert.doesNotMatch(JSON.stringify(f.taken.content), /sleight:guard-stop:/);
});

function relayFixture(t, options = {}) {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, received = [], sent = [];
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, ...options });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  for (const [stream, messages] of [[clientOut, received], [serverIn, sent]])
    stream.on('data', data => messages.push(...data.toString().trim().split('\n').map(JSON.parse)));
  return { sent, received,
    call: (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'),
    reply: msg => serverOut.write(JSON.stringify(msg) + '\n') };
}

test('the recorded missing-label path puts its buried cause in the final note', t => {
  const f = relayFixture(t), cause = 'sleight stopped before click: no element with label "Missing" in this window.';
  f.call(1, 'await app.click("Missing");');
  f.reply({ id: 1, result: { isError: true, content: [text(tree('\t1 button Target')), text(cause + '\n' + tree('\t1 button Target')), text(tree('\t1 button Target'))] } });
  assert.ok(f.received.at(-1).result.content.at(-1).text.includes(cause));
});

test('engine errors keep their cause in notes with and without an input action', t => {
  const f = relayFixture(t);
  for (const [id, code] of [[1, 'await app.click(1)'], [2, 'await app.getAXState()']]) {
    f.call(id, code);
    f.reply({ id, result: { isError: true, content: [text(tree('\t1 button Target')), text('[7:0]: engine target is unavailable')] } });
    const note = f.received.at(-1).result.content.at(-1).text;
    assert.match(note, id === 1 ? /call failed.*engine target is unavailable/ : /engine target is unavailable/);
    assert.doesNotMatch(note, /no input was sent/);
  }
});

test('JSON-RPC errors repeat their engine cause in the failure note', t => {
  const f = relayFixture(t);
  f.call(1, 'await app.click(1)');
  f.reply({ id: 1, error: { code: -32603, message: 'engine disconnected' } });
  assert.match(f.received.at(-1).error.message, /sleight: call failed.*engine disconnected/);
});

test('an engine rejection or lookup stop never qualifies for automatic menu continuation', () => {
  const plan = splitMenuActions('await app.click("File"); await app.click("Save");');
  const receipt = { index: 1, prev: { kind: 'label', value: 'File' }, root: '0 menu File', windowStop: false };
  assert.equal(menuRemainder(plan, receipt, window, [text('Window: "Draft", App: Fixture Editor.\n0 menu File\n\t1 Save')]), undefined);
});

test('a combined engine output block keeps the error after its tree, without its stack', t => {
  const f = relayFixture(t);
  f.call(1, 'await app.click(1)');
  f.reply({ id: 1, result: { isError: true, content: [text(tree('\t1 button Target') + '\nengine input refused\n    at engine.js:3:1')] } });
  assert.match(f.received.at(-1).result.content.at(-1).text, /call failed.*engine input refused/);
});

for (const [name, code, engineError, expected] of [
  ['first stop', 'await app.click("Missing");', false, 'no input was sent'],
  ['later stop', 'await app.click("Target"); await app.click("Missing");', false, 'partial input possible'],
  ['engine error', 'await app.click("Target");', true, 'partial input possible'],
]) test(`the relay consumes the generated guard record for a ${name}`, async t => {
  const f = relayFixture(t, { changeReview: true });
  const content = tree('\t1 button Target');
  f.call(1, 'let app = await cua.getApp("Fixture Editor");');
  f.reply({ id: 1, result: { content: [text(content)], _meta: { 'codex/toolSurface': { app: { appId: 'org.test.editor' } } } } });
  f.call(2, code);
  const forwarded = f.sent.find(m => m.id === 2);
  assert.ok(forwarded, JSON.stringify(f.received));
  const output = [], inputs = [];
  const raw = { getAXState: async () => content, click: async n => { inputs.push(n); if (engineError) throw new Error('engine refused input'); } };
  const context = { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: value => output.push(String(value)) } };
  try { await runInNewContext(`(async () => { ${forwarded.params.arguments.code} })()`, context); }
  catch (error) { output.push(String(error)); }
  f.reply({ id: 2, result: { isError: true, content: [text(output.join('\n'))] } });
  const result = f.received.at(-1).result;
  assert.match(result.content.at(-1).text, new RegExp(expected));
  assert.match(result.content.at(-1).text, engineError ? /engine refused input/ : /no element with label or ID "Missing"/);
  assert.doesNotMatch(JSON.stringify(result), /sleight:guard-stop:/);
  assert.deepEqual(inputs, name === 'first stop' ? [] : [1]);
});

// Safari mdn r2 (race-1017): setValue on the address bar ran, then `pressKey(null, "Return")` threw the engine's null.trim,
// and the note said only "call failed (partial input possible)". Haiku re-read the window before sending Return (6.0 s).
async function failedCall(t, code, raw) {
  const f = relayFixture(t, { changeReview: true });
  const content = tree('\t1 text field (settable) Description: address');
  f.call(1, 'let app = await cua.getApp("Fixture Editor");');
  f.reply({ id: 1, result: { content: [text(content)], _meta: { 'codex/toolSurface': { app: { appId: 'org.test.editor' } } } } });
  f.call(2, code);
  const forwarded = f.sent.find(m => m.id === 2), output = [];
  if (!forwarded) return f.received.at(-1).result.content.at(-1).text;
  const context = { app: { getAXState: async () => content, ...raw }, cua: {}, nodeRepl: { write: value => output.push(String(value)) } };
  context.cua.getApp = async () => context.app;
  try { await runInNewContext(`(async () => { ${forwarded.params.arguments.code} })()`, context); }
  catch (error) { output.push(String(error?.message ?? error)); }
  f.reply({ id: 2, result: { isError: true, content: [text(output.join('\n'))] } });
  return f.received.at(-1).result.content.at(-1).text;
}

test('a malformed literal key stops the batch before its earlier setValue', async t => {
  const sent = [];
  const note = await failedCall(t, 'await app.setValue(1, "https://example.org/teapot"); await app.pressKey(null, "Return"); await app.getAXState();',
    { setValue: async (n, value) => sent.push(value), pressKey: async key => sent.push(key.trim()) });
  assert.deepEqual(sent, []);
  assert.match(note, /Engine App\.pressKey\(key: string, options\?: PressKeyOptions\); nothing was sent\.$/);
  assert.doesNotMatch(note, /partial input possible|outcome unconfirmed/);
  // Set text stays out of the note.
  assert.doesNotMatch(note, /example\.org/);
});

test('typeText with an element first stops before its earlier click, and typed text stays out', async t => {
  let clicks = 0;
  const note = await failedCall(t, 'await app.click(1); await app.typeText(1, "secret words");',
    { click: async () => { clicks++; }, typeText: async value => value.trim() });
  assert.equal(clicks, 0);
  assert.match(note, /Engine App\.typeText\(text: string\); nothing was sent\.$/);
  assert.doesNotMatch(note, /secret/);
});

test('a lone failing action with no shape to give keeps the plain note', async t => {
  const note = await failedCall(t, 'await app.click(1);', { click: async () => { throw new Error('engine target is unavailable'); } });
  assert.equal(note, 'sleight: call failed (partial input possible): engine target is unavailable.');
});

test('the content-label preference still refuses a different document', async () => {
  const rows = '\t1 group Ribbon\n\t\t2 tab Insert\n3 menu bar\n\t4 Insert';
  const f = await execute(rows, 'await app.click("Insert");', { prior: { text: tree(rows).replaceAll('Draft', 'Other'), windows: null } });
  assert.match(f.error?.message ?? '', /Document scope stopped/);
  assert.deepEqual(f.inputs, []);
});

for (const selector of ['"Apply"', '{ label: "Apply" }']) {
  for (const state of ['disabled', 'disabled, settable']) test(`one enabled label wins over ${state}: ${selector}`, async () => {
    const f = await execute(`\t1 button (${state}) Apply\n\t2 button Apply`, `await app.click(${selector});`);
    assert.equal(f.error, undefined);
    assert.deepEqual(f.inputs, [2]);
  });
}

for (const rows of ['\t1 button Apply\n\t2 button Apply',
  '\t1 button (disabled) Apply\n\t2 button (disabled) Apply',
  '\t1 button Description: Apply, Help: (disabled)\n\t2 button Apply']) {
  test('enabled-label preference keeps ambiguous candidates: ' + rows, async () => {
    const f = await execute(rows, 'await app.click({ label: "Apply" });');
    assert.match(f.error?.message ?? '', /2 elements with label/);
    assert.deepEqual(f.inputs, []);
  });
}

test('enabled-label preference precedes the menu-content preference', async () => {
  const f = await execute('\t1 button (disabled) Apply\n2 menu bar\n\t3 menu item Apply', 'await app.click("Apply");');
  assert.equal(f.error, undefined);
  assert.deepEqual(f.inputs, [3]);
});

test('duplicate IDs do not acquire an enabled-label preference', async () => {
  const f = await execute('\t1 button (disabled) Apply, ID: duplicate\n\t2 button Apply, ID: duplicate', 'await app.click({ id: "duplicate" });');
  assert.match(f.error?.message ?? '', /2 elements with ID/);
  assert.deepEqual(f.inputs, []);
});

test('the enabled-label preference still refuses a different document', async () => {
  const rows = '\t1 button (disabled) Apply\n\t2 button Apply';
  const f = await execute(rows, 'await app.click("Apply");', { prior: { text: tree(rows).replaceAll('Draft', 'Other'), windows: null } });
  assert.match(f.error?.message ?? '', /Document scope stopped/);
  assert.deepEqual(f.inputs, []);
});

// One guard across calls, as the engine's session keeps it, with typing and the engine's focus line.
function guardSession() {
  let current = '';
  const inputs = [];
  const raw = { getAXState: async () => current, click: async n => { inputs.push(n); },
    pressKey: async key => { inputs.push(key); }, typeText: async value => { inputs.push(value); } };
  const context = { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: () => {} } };
  return { inputs, run: async (rows, focus, code, options = {}) => {
    current = tree(rows) + '\n\nThe focused UI element is ' + focus;
    inputs.length = 0;
    try { await runInNewContext(`(async () => { ${guardedCode(code, window, undefined, undefined, { guardStopMark: guardStopMark(), ...options })} })()`, context); }
    catch (error) { return error; }
  } };
}
const docRows = '\t1 split group\n\t\t29 text entry area (disabled, settable) Description: Page 1 content, Value: **Report**';
const docFocus = '29 text entry area (disabled, settable) Description: Page 1 content, Value: **Report**';
// word-edit-1, 22-03-44 (transcript line 113) and 23-58-39: (selected) Table on every result while typing reached nothing.
const trapped = docRows + '\n123 menu bar\n\t124 Insert\n\t131 (selected) Table';
// Cancel on 131 alone did nothing at word-edit-1 lines 120 and 150 (2026-10-18); clicking 131 opened the menu, whose Cancel closed it.
const trapStop = /sleight stopped before (?:typeText\(<4 characters>\)|pressKey\("Tab"\)): menu-bar item 131 \(Table\) is selected and its menu takes the keys\. Click it to open its menu, then close that menu with `await app\.performSecondaryAction\(<its menu>, "Cancel"\)`; Cancel on the menu-bar item alone does nothing\./;

test('typing or keys while a menu-bar title is selected and no menu shows stop before input', async () => {
  for (const code of ['await app.typeText("Item"); await app.pressKey("Tab");', 'await app.pressKey("Tab"); await app.typeText("Item");']) {
    const s = guardSession();
    const error = await s.run(trapped, docFocus, code);
    assert.match(error?.message ?? '', trapStop, code);
    assert.deepEqual(s.inputs, []);
  }
  // The call's own acquisition read is the evidence when its first key skips the read.
  const s = guardSession();
  const error = await s.run(docRows, docFocus, 'await app.typeText("Item");',
    { firstOff: true, focused: true, prior: { text: tree(trapped), windows: null } });
  assert.match(error?.message ?? '', trapStop);
  assert.deepEqual(s.inputs, []);
});

// word-edit-1, 2026-10-18 (lines 106 to 113): the click's result showed (selected) Table, and the next call's
// typeText skipped its read with no acquisition before it.
test('the previous call\'s last tree stops the first key when this call reads nothing', async () => {
  for (const code of ['await app.typeText("Item");', 'await app.pressKey("Tab");']) {
    const s = guardSession();
    const error = await s.run(docRows, docFocus, code, { firstOff: true, focused: true, lastTree: tree(trapped) });
    assert.match(error?.message ?? '', trapStop, code);
    assert.deepEqual(s.inputs, []);
  }
  // Without it the key goes ahead; it counts for the first action only, and Escape still passes.
  for (const [options, code, sent] of [[{}, 'await app.typeText("Item");', ['Item']],
    [{ lastTree: tree(docRows) }, 'await app.typeText("Item");', ['Item']],
    [{ lastTree: tree(trapped) }, 'await app.pressKey("Escape"); await app.typeText("Item");', ['Escape', 'Item']]]) {
    const s = guardSession();
    assert.equal(await s.run(docRows, docFocus, code, { firstOff: true, focused: true, ...options }), undefined, code);
    assert.deepEqual(s.inputs, sent);
  }
});

// word-edit-1, 2026-10-18 (line 92): the Insert Table dialog had focus while the menu bar still showed (selected) Table.
test('a dialog or sheet takes the keys while a menu-bar title shows selected', async () => {
  const dialog = 'Window: "Insert Table", App: Fixture Editor.\n0 dialog Insert Table\n\t1 text field (settable) 5\n23 menu bar\n\t31 (selected) Table';
  const sheet = tree('\t1 sheet Save\n\t\t2 text field (settable) Name\n123 menu bar\n\t131 (selected) Table');
  for (const [text, code, sent] of [[dialog, 'await app.click(1); await app.pressKey("super+a"); await app.typeText("2");', [1, 'super+a', '2']],
    [sheet, 'await app.typeText("Item");', ['Item']]]) {
    const inputs = [];
    const raw = { getAXState: async () => text, click: async n => { inputs.push(n); }, pressKey: async key => { inputs.push(key); }, typeText: async value => { inputs.push(value); } };
    const scope = text === dialog ? { title: 'Insert Table', app: 'Fixture Editor', url: null } : window;
    await runInNewContext(`(async () => { ${guardedCode(code, scope, undefined, undefined, { guardStopMark: guardStopMark() })} })()`,
      { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: () => {} } });
    assert.deepEqual(inputs, sent);
  }
});

// word-edit-1, 2026-10-18 (line 64): click(3) on Table > Insert alone closed the menu and left the title selected.
const tableMenu = 'Window: "Draft", App: Fixture Editor.\n0 Table, Secondary Actions: Cancel, Pick\n\t1 menu Secondary Actions: Cancel\n' +
  '\t\t2 Draw Table, ID: oui_performOfficeSpaceMenuAction:\n\t\t3 Insert\n\t\t\t4 menu Secondary Actions: Cancel\n' +
  '\t\t\t\t5 Table..., ID: oui_performOfficeSpaceMenuAction:\n\t\t\t\t6 (disabled) Columns to the Left, ID: oui_performOfficeSpaceMenuAction:\n' +
  '\t\t\t\t7 Rows Above, ID: oui_performOfficeSpaceMenuAction:\n\t\t\t\t8 Rows Below\n\t\t\t\t9 Cells...\n\t\t10 Delete\n' +
  '11 menu bar\n\t12 (selected) Table\n\t\t13 menu\n\t\t\t14 Formula';
async function menuCall(code, options = {}) {
  const inputs = [];
  const raw = { getAXState: async () => tableMenu, click: async n => { inputs.push(n); }, pressKey: async key => { inputs.push(key); } };
  let error;
  try {
    await runInNewContext(`(async () => { ${guardedCode(code, window, undefined, undefined, { guardStopMark: guardStopMark(), ...options })} })()`,
      { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: () => {} } });
  } catch (e) { error = e; }
  return { inputs, error };
}

test('a submenu header clicked with nothing after it in the call stops before input and names its items', async () => {
  for (const [code, actions] of [['await app.click(3); await app.getAXState();', ['click']], ['await app.click({ label: "Insert" });', ['click']],
    ['await app.click(2 + 1); await app.typeText("x");', ['click', 'typeText']]]) {
    const f = await menuCall(code, { actions });
    assert.match(f.error?.message ?? '', /^sleight stopped before click\([^)]*\): element 3 \(Insert\) opens a submenu; click the item you want inside it in the same call \(e\.g\. 5 Table\.\.\., 7 Rows Above, 8 Rows Below\)\./, code);
    assert.deepEqual(f.inputs, [], code);
  }
});

test('a submenu header followed by a click, a leaf item, a menu-bar title or a call without the action list goes ahead', async () => {
  for (const [code, actions, sent] of [['await app.click(3); await app.click(5);', ['click', 'click'], [3, 5]],
    ['await app.click(3); await app.pressKey("Return");', ['click', 'pressKey'], [3, 'Return']],
    ['await app.click(2);', ['click'], [2]], ['await app.click(10);', ['click'], [10]],
    ['await app.click(12);', ['click'], [12]], ['await app.click(3);', undefined, [3]]]) {
    const f = await menuCall(code, { actions });
    assert.equal(f.error, undefined, code);
    assert.deepEqual(f.inputs, sent, code);
  }
});

test('Escape, a click, a normal tree or a visible menu let keys through', async () => {
  for (const [rows, code, sent] of [
    [trapped, 'await app.pressKey("Escape");', ['Escape']],
    [trapped, 'await app.click(131);', [131]],
    [docRows + '\n123 menu bar\n\t124 Insert\n\t131 Table', 'await app.typeText("Item");', ['Item']],
    [trapped + '\n\t\t140 menu\n\t\t\t141 menu item Insert Table...', 'await app.typeText("Item");', ['Item']],
  ]) {
    const s = guardSession();
    assert.equal(await s.run(rows, docFocus, code), undefined, rows + code);
    assert.deepEqual(s.inputs, sent);
  }
});

// word-edit-1 23-30-19 (R24-R29) and excel 23-54 (pressKey("Down") with "0 standard window" focused).
const windowFocus = '0 standard window Draft';
const focusStop = /sleight stopped before (?:pressKey\("Down"\)|typeText\(<4 characters>\)|pressKey\("Tab"\)): keyboard focus is on the window itself, so keys have no target\. Click the document or the target field first\./;

test('plain keys and typing stop when the window has focus after its document had it', async () => {
  for (const code of ['await app.pressKey("Down");', 'await app.typeText("Item");', 'await app.pressKey("Tab");']) {
    const s = guardSession();
    assert.equal(await s.run(docRows, docFocus, 'await app.getAXState();'), undefined);
    const error = await s.run(docRows, windowFocus, code);
    assert.match(error?.message ?? '', focusStop, code);
    assert.deepEqual(s.inputs, []);
  }
});

test('window focus right after opening, shortcuts, Escape and element focus let keys through', async () => {
  // Just opened: the document never had focus in this session.
  const opened = guardSession();
  assert.equal(await opened.run(docRows, windowFocus, 'await app.pressKey("Down");'), undefined);
  assert.deepEqual(opened.inputs, ['Down']);
  const s = guardSession();
  await s.run(docRows, docFocus, 'await app.getAXState();');
  for (const [code, sent] of [['await app.pressKey("super+End");', ['super+End']], ['await app.pressKey("Escape");', ['Escape']]]) {
    assert.equal(await s.run(docRows, windowFocus, code), undefined, code);
    assert.deepEqual(s.inputs, sent);
  }
  assert.equal(await s.run(docRows, docFocus, 'await app.pressKey("Down");'), undefined);
  assert.deepEqual(s.inputs, ['Down']);
});
