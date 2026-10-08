import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { GUARD_END, GUARD_MARK, guardedCode, hasIdentifier, hasLabel, readCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

test('headers require one exact identity, including a document URL', () => {
  assert.deepEqual(windowFromText('Window: "", App: Chess.\n0 standard window'), { title: '', app: 'Chess', url: null });
  assert.deepEqual(windowFromText('Window: "a.txt", App: TextEdit\nURL: file:///tmp/a.txt'), { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' });
  assert.deepEqual(windowFromText('Window: "a.txt", App: TextEdit.\n0 standard window a.txt, URL: file:///tmp/a.txt, Secondary Actions: Raise\n\t1 text entry area'), { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' });
  assert.equal(windowFromText('Window: "a.txt", App: TextEdit\nURL: file:///tmp/a.txt\nWindow: "b.txt", App: TextEdit\nURL: file:///tmp/b.txt'), undefined);
  assert.equal(windowFromText('Window: "a.txt", App: TextEdit\nURL: file:///tmp/a.txt\nURL: file:///tmp/b.txt'), undefined);
});

test('file-only guard refuses another file while cached read and cancel paths remain usable', async () => {
  const writes = [];
  const raw = { getAXState: async () => 'Window: "b.txt", App: TextEdit\nURL: file:///tmp/b.txt\n63 button Cancel, ID: CancelButton',
    typeText: async text => writes.push(text), click: async id => writes.push(id), pressKey: async key => writes.push(key) };
  const context = { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  const expected = { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' };
  const run = code => runInNewContext(`(async () => { ${code} })()`, context);
  await assert.rejects(run(guardedCode('await app.typeText("oops")', expected, 'stopped', undefined, { fileOnly: true })), /stopped/);
  await run(guardedCode('await app.click(63); await app.pressKey("Escape");', expected, 'stopped', undefined, { fileOnly: true }));
  await run(readCode('await app.getAXState();'));
  await assert.rejects(run(guardedCode('await app.typeText("oops")', expected, 'stopped', undefined, { fileOnly: true })), /stopped/);
  assert.deepEqual(writes, [63, 'Escape']);
});

test('Escape cancellation does not depend on a successful window read', async () => {
  let cancelled = false;
  const app = { getAXState: async () => { if (!cancelled) throw new Error('unreadable dialog'); return 'Window: "Open", App: TextEdit'; },
    pressKey: async () => { cancelled = true; } };
  const code = guardedCode('await app.pressKey("Escape")', { title: 'Open', app: 'TextEdit', url: null }, 'stopped', undefined, { fileOnly: true, cancelOnly: true });
  await runInNewContext(`(async () => { ${code} })()`, { app, cua: { getApp: async () => app }, nodeRepl: { write() {} } });
  assert.equal(cancelled, true);
});

test('the advisory guard checks the cached app before mutating it', async () => {
  for (const name of ['a.txt', 'b.txt']) {
    const writes = [];
    const app = {
      getAXState: async () => `Window: "${name}", App: TextEdit\nURL: file:///tmp/${name}`,
      typeText: async value => writes.push(value),
    };
    const context = { app, cua: { getApp: async () => app }, nodeRepl: { write() {} } };
    const code = guardedCode('await app.typeText("hello")', { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' });
    const action = runInNewContext(`(async () => { ${code} })()`, context);
    if (name === 'a.txt') { await action; assert.deepEqual(writes, ['hello']); }
    else { await assert.rejects(action, /Document scope stopped/); assert.deepEqual(writes, []); }
  }
});

test('a newly acquired app handle is guarded before its first action', async () => {
  const writes = [];
  const other = { getAXState: async () => 'Window: "b.txt", App: TextEdit\nURL: file:///tmp/b.txt', typeText: async text => writes.push(text) };
  const code = guardedCode('const other = await cua.getApp("TextEdit"); await other.typeText("oops")', { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' });
  await assert.rejects(runInNewContext(`(async () => { ${code} })()`, { cua: { getApp: async () => other }, nodeRepl: { write() {} } }), /Document scope stopped/);
  assert.deepEqual(writes, []);
});

test('const and alternate handles acquired by reads still receive the action guard', async () => {
  for (const binding of ['const te', 'const app', 'let app2', 'var chess']) {
    const writes = [];
    const raw = { getAXState: async () => 'Window: "b.txt", App: TextEdit\nURL: file:///tmp/b.txt',
      typeText: async value => writes.push(value) };
    const name = binding.split(' ')[1];
    const context = { cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
    const code = readCode(binding + ' = await cua.getApp("TextEdit");') + '\n' +
      guardedCode('await ' + name + '.typeText("oops")', { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' });
    await assert.rejects(runInNewContext(`(async () => { ${code} })()`, context), /Document scope stopped/);
    assert.deepEqual(writes, []);
  }
});

test('a bare acquisition restores app and a later full read lets its guard recover', async () => {
  let title = 'a.txt';
  const writes = [];
  const raw = { getAXState: async () => `Window: "${title}", App: TextEdit\nURL: file:///tmp/${title}`,
    typeText: async value => writes.push(value) };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  const expected = { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' };
  await runInNewContext(`(async () => { ${readCode('await cua.getApp("TextEdit")')} })()`, context);
  title = 'b.txt';
  await assert.rejects(runInNewContext(`(async () => { ${guardedCode('await app.typeText("blocked")', expected)} })()`, context), /Document scope stopped/);
  await runInNewContext(`(async () => { ${readCode('await app.getAXState({disableDiffing:true})')} })()`, context);
  await runInNewContext(`(async () => { ${guardedCode('await app.typeText("restored")', { ...expected, title, url: 'file:///tmp/b.txt' })} })()`, context);
  assert.deepEqual(writes, ['restored']);
});

test('a bare read works after const app, and post-action state follows the acted handle', async () => {
  const outputs = [];
  const raw = title => ({ getAXState: async () => `Window: "${title}", App: TextEdit`,
    typeText: async () => {} });
  const context = { cua: { getApp: async title => raw(title) }, nodeRepl: { write: text => outputs.push(text) } };
  const code = readCode('const app = await cua.getApp("first");') + '\n' +
    readCode('let te = await cua.getApp("second");') + '\n' +
    readCode('await cua.getApp("third");') + '\n' +
    readCode('await te.getAXState({disableDiffing:true});') + '\n' +
    guardedCode('await te.typeText("x")', { title: 'second', app: 'TextEdit', url: null });
  await runInNewContext(`(async () => { ${code} })()`, context);
  assert.equal(outputs.at(-1), GUARD_MARK + 'Window: "second", App: TextEdit' + GUARD_END);
});

test("Claude's read doubles as the guard's: one engine read per read, none extra after the call", async () => {
  const outputs = [], calls = [];
  const raw = { getAXState: async options => { calls.push(options); return 'Window: "a.txt", App: TextEdit'; }, click: async () => calls.push('click') };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write: text => outputs.push(text) } };
  const window = { title: 'a.txt', app: 'TextEdit', url: null };
  const run = code => runInNewContext(`(async () => { ${code} })()`, context);
  await run(readCode('await cua.getApp("TextEdit");'));
  calls.length = 0;
  await run(guardedCode('await app.getAXState(); await app.click(3); await app.getAXState();', window));
  assert.deepEqual(calls.map(c => (c === 'click' ? c : `read diff=${!c.disableDiffing} emit=${c.emit}`)),
    ['read diff=false emit=false', 'click', 'read diff=false emit=false'], 'the pre-action check reused the first read and the guard skipped its own');
  assert.equal(outputs.filter(o => o.startsWith(GUARD_MARK)).length, 2);
  calls.length = 0; outputs.length = 0;
  await run(guardedCode('await app.click(3);', window));
  assert.deepEqual(calls.map(c => (c === 'click' ? c : 'read')), ['read', 'click', 'read'], 'a new call reads before and after');
  assert.equal(outputs.length, 1);
  calls.length = 0; outputs.length = 0;
  await run(guardedCode('const s = await app.getAXState({ emit: false }); nodeRepl.write(String(s.length));', window));
  assert.equal(calls.length, 1, 'an unemitted read is reused for the header');
  assert.deepEqual(outputs, ['30', GUARD_MARK + 'Window: "a.txt", App: TextEdit' + GUARD_END]);
});

test('a window that only gains a URL mid-call stays the same window, unless document scope or change review is on', async () => {
  let url = null;
  const raw = { getAXState: async () => `Window: "Untitled 6", App: TextEdit.\n0 standard window Untitled 6${url ? `, URL: ${url}` : ''}`,
    setValue: async () => { url = 'file:///tmp/Untitled%206.txt'; }, pressKey: async () => {} };
  const window = { title: 'Untitled 6', app: 'TextEdit', url: null };
  for (const [options, ok] of [[{ adoptUrl: true }, true], [{ adoptUrl: false }, false]]) {
    url = null;
    const context = { cua: { getApp: async () => raw }, nodeRepl: { write: () => {} } };
    const run = code => runInNewContext(`(async () => { ${code} })()`, context);
    await run(readCode('await cua.getApp("TextEdit");'));
    const done = run(guardedCode('await app.setValue(2, "x"); await app.pressKey("super+s");', window, 'stopped', undefined, options));
    if (ok) await done; else await assert.rejects(done, /stopped/);
  }
  const other = { getAXState: async () => 'Window: "Other", App: TextEdit.\n0 standard window Other, URL: file:///tmp/o.txt', pressKey: async () => {} };
  const context = { cua: { getApp: async () => other }, nodeRepl: { write: () => {} } };
  const run = code => runInNewContext(`(async () => { ${code} })()`, context);
  await run(readCode('await cua.getApp("TextEdit");'));
  await assert.rejects(run(guardedCode('await app.pressKey("a");', window, 'stopped', undefined, { adoptUrl: true })), /stopped/,
    'a different title is still a different window');
});

test('an element given by its AX ID is found in the read before each action, even after a renumber', async () => {
  let shifted = false; const clicked = [];
  const keys = [['AllClear', 'All Clear'], ['Seven', '7'], ['Equals', '=']];
  const tree = () => ['Window: "Calculator", App: Calculator.', '0 standard window Calculator',
    ...(shifted ? [] : ['\t1 list HistoryView']),
    ...keys.map(([id, label], i) => `\t${i + (shifted ? 1 : 2)} button Description: ${label}, ID: ${id}`),
    `\t${shifted ? 4 : 5} button Description: Seven Up, ID: SevenUp`].join('\n');
  const raw = { getAXState: async () => tree(), click: async n => { clicked.push(n); shifted = true; } };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write: () => {} } };
  const run = code => runInNewContext(`(async () => { ${code} })()`, context);
  await run(readCode('await cua.getApp("Calculator");'));
  const window = { title: 'Calculator', app: 'Calculator', url: null };
  await run(guardedCode('for (const id of ["AllClear", "Seven", "Equals"]) await app.click({ id });', window));
  assert.deepEqual(clicked, [2, 2, 3], 'All Clear at 2, then Seven and Equals at their new numbers');
  await assert.rejects(run(guardedCode('await app.click({ id: "Eight" });', window)), /no element with ID "Eight"/);
  clicked.length = 0;
  await run(guardedCode('await app.click({ label: "=" }); await app.click({ label: "7" });', window));
  assert.deepEqual(clicked, [3, 2], 'labels match descriptions');
  raw.getAXState = async () => tree() + '\n\t9 button Description: 7, ID: Seven';
  await assert.rejects(run(guardedCode('await app.click({ id: "Seven" });', window)), /2 elements with ID "Seven"/);
});

test('labels match a description or a title, whole, never part of one', () => {
  assert.equal(hasLabel('button Multiply', 'Multiply'), true);
  assert.equal(hasLabel('toggle button Bold, Value: 0', 'Bold'), true);
  assert.equal(hasLabel('button Description: 7, ID: Seven', '7'), true);
  assert.equal(hasLabel('button Multiply Twice', 'Multiply'), false);
  assert.equal(hasLabel('button Description: 70, ID: X', '7'), false);
  assert.equal(hasLabel('text Description: Last Expression, Value: 7', '7'), false);
  assert.equal(hasIdentifier('button Description: Mode, ID: Mode: scientific; unitConversion: false, Secondary Actions: Raise', 'Mode: scientific; unitConversion: false'), true);
  assert.equal(hasIdentifier('button Description: 7, ID: SevenUp', 'Seven'), false);
});

test('a batch stops when an earlier action in the call renumbers its target', async () => {
  let shifted = false; const clicked = [];
  const tree = () => ['Window: "Calculator", App: Calculator.', '0 standard window Calculator',
    ...(shifted ? [] : ['\t1 list HistoryView']), ...['7', '8', '9'].map((k, i) => `\t${i + (shifted ? 1 : 2)} button ${k}`)].join('\n');
  const raw = { getAXState: async () => tree(), click: async n => { clicked.push(n); shifted = true; } };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write: () => {} } };
  const run = code => runInNewContext(`(async () => { ${code} })()`, context);
  await run(readCode('await cua.getApp("Calculator");'));
  const window = { title: 'Calculator', app: 'Calculator', url: null };
  await assert.rejects(run(guardedCode('for (const i of [2, 3, 4]) await app.click(i);', window)),
    /stopped before click\(3\).*was "button 8", now "button 9"/);
  assert.deepEqual(clicked, [2], 'only the first click ran');
  clicked.length = 0;
  await run(guardedCode('await app.click(1); await app.click(1);', window));
  assert.deepEqual(clicked, [1, 1], 'an unchanged target goes through');
});
