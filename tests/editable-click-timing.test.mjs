import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createContext, runInContext } from 'node:vm';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { guardStopMark, takeGuardStop } from '../plugins/sleight/lib/menu-continuation.mjs';

const window = { title: 'Draft', app: 'Fixture Editor', url: null };
function fixture({ role = 'text field', focused = true, readDelay = 0, afterClickRead = () => {}, failClick = false } = {}) {
  let now = 1000, clicked = false;
  const events = [], waits = [], output = [], reads = [], mark = guardStopMark();
  const raw = {
    getAXState: async options => {
      reads.push({ ...options });
      if (clicked) { now += readDelay; afterClickRead(); }
      const field = `${role} Description: Query, ID: query`;
      const other = 'combo box (settable) Description: Other, ID: other';
      return `Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n\t1 ${field}\n\t2 ${other}` +
        (clicked ? `\n\nThe focused UI element is ${focused ? '1 ' + field : '2 ' + other}` : '');
    },
    click: async n => { now += 80; events.push(['click', now, n]); if (failClick) throw Error('click failed'); clicked = true; },
    typeText: async text => { events.push(['typeText', now, text]); return 'typed'; },
    paste: async text => { events.push(['paste', now, text]); return 'pasted'; },
    pressKey: async key => events.push(['key', now, key]),
  };
  const context = createContext({ app: raw, other: { ...raw }, cua: { getApp: async () => raw },
    performance: { now: () => now }, nodeRepl: { write: value => output.push(value) },
    setTimeout: (resolve, ms) => { waits.push(ms); now += ms; resolve(); } });
  const run = (code, options = {}, lease) => runInContext(`(async () => { ${guardedCode(code, window, undefined, lease, { guardStopMark: mark, ...options })} })()`, context,
    { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return { run, context, raw, events, waits, reads, output, mark };
}

for (const role of ['text field', 'text area', 'text entry area', 'search field', 'search text field', 'combo box (settable)']) {
  for (const method of ['typeText', 'paste']) test(`${method} checks the clicked ${role}'s focus before input`, async () => {
    const f = fixture({ role, readDelay: 17 });
    await f.run(`await app.click(1); const result = await app.${method}("query"); if (result !== "${method === 'paste' ? 'pasted' : 'typed'}") throw Error('lost return value');`, { quietEdits: true });
    assert.deepEqual(f.waits, []);
    assert.equal(f.events[1][1] - f.events[0][1], 17, 'only the AX read delays input');
    assert.equal(f.reads.length, 3, 'one read before click, one focus check, one after call');
    assert.ok(f.reads.every(options => options.disableDiffing && options.emit === false));
  });
}

for (const method of ['typeText', 'paste']) test(`${method} stops when another field kept focus and reports the stop`, async () => {
  const f = fixture({ role: 'combo box (settable)', focused: false });
  await assert.rejects(f.run(`await app.click(1); await app.${method}("violet"); await app.pressKey("Return");`, { quietEdits: true }), /another element has focus.*app\.setValue\(1, /);
  assert.deepEqual(f.events.map(event => event[0]), ['click']);
  assert.deepEqual(Array.from(f.context.__sleightDocumentGuard.typed), []);
  const taken = takeGuardStop([{ type: 'text', text: f.output.join('\n') }], f.mark);
  assert.equal(taken.receipt.index, 1);
  assert.equal(taken.input, true, 'the earlier click ran');
  assert.match(taken.receipt.error, /another element has focus/);
});

for (const selector of ['{ id: "query" }', '{ label: "Query" }', '"Query"']) {
  test(`resolved editable selector ${selector} checks its own row`, async () => {
    const f = fixture({ focused: false });
    await assert.rejects(f.run(`await app.click(${selector}); await app.typeText("query");`, { quietEdits: true }), /app\.setValue\(1, /);
    assert.deepEqual(f.events.map(event => event[0]), ['click']);
  });
}

for (const options of [{}, { careful: true }, { quietEdits: true }]) test(`focus check reuses the current guard read: ${JSON.stringify(options)}`, async () => {
  const f = fixture();
  await f.run('await app.click(1); await app.paste("query");', options);
  assert.equal(f.reads.length, 3, 'never add a second pre-input read');
  assert.deepEqual(f.waits, []);
});

test('a caller read after the click supplies the focus check', async () => {
  const f = fixture();
  await f.run('await app.click(1); await app.getAXState({ emit: false }); await app.typeText("query");', { quietEdits: true });
  assert.equal(f.reads.length, 3);
});

// Focus wording copied from the 2026-10-16T05-43-44-389Z save transcript, line 8.
test('the real engine trailing focus line confirms the clicked field', async () => {
  const f = fixture();
  f.raw.getAXState = async () => 'Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n\t1 text entry area (settable) First Text View\n\nThe focused UI element is 1 text entry area (settable) First Text View';
  await f.run('await app.click(1); await app.typeText("query");', { quietEdits: true });
  assert.equal(f.events.at(-1)[0], 'typeText');
});

test('the focus check uses the resolved number after a target remap', async () => {
  const f = fixture({ focused: false });
  await assert.rejects(f.run('await app.click(7); await app.typeText("query");', { quietEdits: true, literals: [7],
    seenLines: { 7: 'text field Description: Query, ID: query' }, uniqueSeen: [7] }), /app\.setValue\(1, /);
  assert.equal(f.events[0][2], 1);
  assert.equal(f.events.length, 1);
});

for (const role of ['button Description: text field', 'tab', 'static text']) test(`${role} adds no focus read`, async () => {
  const f = fixture({ role });
  await f.run('await app.click(1); await app.typeText("query");', { quietEdits: true });
  assert.equal(f.reads.length, 3, 'only the existing window guard reads');
  assert.deepEqual(f.waits, []);
});

test('coordinates, another handle, another call and an intervening key do not reuse an editable click', async () => {
  for (const code of ['await app.click([1, 2]); await app.typeText("query");',
    'const other = await cua.getApp("fixture"); await app.click(1); await other.typeText("query");',
    'await app.click(1); await app.pressKey("Tab"); await app.typeText("query");']) {
    const f = fixture({ focused: false });
    f.context.cua.getApp = async () => f.context.other;
    await f.run(code);
    assert.deepEqual(f.waits, []);
    assert.equal(f.events.at(-1)[0], 'typeText');
  }
  const f = fixture({ focused: false });
  await f.run('await app.click(1);');
  f.reads.length = 0;
  await f.run('await app.typeText("query");', { reuseSetup: true });
  assert.equal(f.reads.length, 2, 'no extra read across calls');
});

test('only the first text action checks focus, and a failed click never qualifies', async () => {
  const f = fixture();
  await f.run('await app.click(1); await app.typeText("one"); await app.paste("two");', { quietEdits: true });
  assert.equal(f.reads.length, 3);
  const failed = fixture({ failClick: true, focused: false });
  await failed.run('try { await app.click(1); } catch {} await app.typeText("query");', { quietEdits: true });
  assert.deepEqual(failed.waits, []);
  assert.equal(failed.events.at(-1)[0], 'typeText');
});

for (const loss of ['takeover', 'expiry']) test(`lease ${loss} during the focus read stops the text action`, async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-editable-click-')));
  t.after(() => removeTemp(directory));
  const path = join(directory, 'lease.json');
  const record = { token: 'owned', expires: Date.now() + 60000 };
  writeFileSync(path, JSON.stringify(record));
  const f = fixture({ afterClickRead: () => writeFileSync(path, JSON.stringify(loss === 'takeover'
    ? { ...record, token: 'new-owner' } : { ...record, expires: 0 })) });
  await assert.rejects(f.run('await app.click(1); await app.typeText("query");', { quietEdits: true }, { path, token: 'owned' }), /ownership lost or expired/);
  assert.deepEqual(f.waits, []);
  assert.deepEqual(f.events.map(event => event[0]), ['click']);
  assert.deepEqual(Array.from(f.context.__sleightDocumentGuard.typed), [], 'no typed receipt before sending input');
});

const postClickCases = [
  ['focused descendant', '\t1 text field Description: Query, ID: query\n\t\t3 group\n\t\t\t4 text entry area (settable) First Text View\n\t2 combo box Description: Other', '4 text entry area (settable) First Text View', true],
  ['different sibling after a descendant', '\t1 text field Description: Query, ID: query\n\t\t3 text entry area Inner\n\t2 combo box Description: Other', '2 combo box Description: Other', false],
  ['no focus line', '\t1 text field Description: Query, ID: query', null, true],
  ['degraded tree', '\t1 text field Query', null, true],
  ['degraded tree with unresolved focus', '\t1 text field Query', '4 text entry area First Text View', true],
  ['renumbered clicked field', '\t1 combo box Description: Other\n\t7 text field Description: Query, ID: query', '7 text field Description: Query, ID: query', true],
  ['renumbered clicked field with different focus', '\t1 combo box Description: Other\n\t7 text field Description: Query, ID: query', '1 combo box Description: Other', false],
  ['renumbered focused descendant', '\t7 text field Description: Query, ID: query\n\t\t8 text entry area Inner', '8 text entry area Inner', true],
  ['focus line with stale number', '\t7 text field Description: Query, ID: query', '1 text field Description: Query, ID: query', true],
];
for (const method of ['typeText', 'paste']) for (const [label, rows, focus, allowed] of postClickCases) test(`${method}: ${label}`, async () => {
  const f = fixture();
  const read = f.raw.getAXState;
  let reads = 0;
  f.raw.getAXState = async options => ++reads === 1 ? read(options) :
    `Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n${rows}` + (focus ? `\n\nThe focused UI element is ${focus}` : '');
  const run = f.run(`await app.click(1); await app.${method}("query");`, { quietEdits: true });
  if (allowed) {
    await run;
    assert.equal(f.events.at(-1)[0], method);
    assert.equal(f.reads.length, 1, 'only the initial fixture read; two overridden reads follow');
  } else {
    await assert.rejects(run, error => {
      assert.match(error.message, /another element has focus/);
      assert.doesNotMatch(error.message, /Window:|standard window|combo box Description/);
      return true;
    });
    assert.deepEqual(f.events.map(event => event[0]), ['click']);
  }
  assert.deepEqual(f.waits, []);
});

test('an unreadable focus check sends no text', async () => {
  const f = fixture({ afterClickRead: () => { throw Error('AX unavailable'); } });
  await assert.rejects(f.run('await app.click(1); await app.paste("query");', { quietEdits: true }), /AX unavailable/);
  assert.deepEqual(f.events.map(event => event[0]), ['click']);
});

test('the focus read still enforces document scope', async () => {
  const f = fixture();
  const read = f.raw.getAXState;
  let reads = 0;
  f.raw.getAXState = async options => (++reads === 1 ? await read(options) : (await read(options)).replaceAll('Draft', 'Other'));
  await assert.rejects(f.run('await app.click(1); await app.typeText("query");', { quietEdits: true }), /Document scope stopped/);
  assert.deepEqual(f.events.map(event => event[0]), ['click']);
});
