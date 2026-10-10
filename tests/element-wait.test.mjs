import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { guardedCode, readCode } from '../plugins/sleight/lib/document-scope.mjs';

const window = { title: 'Calculator', app: 'Calculator', url: null };
const header = 'Window: "Calculator", App: Calculator.\n0 standard window Calculator';
function fixture(trees) {
  const output = [], starts = [], inputs = [];
  const raw = { getAXState: async () => { starts.push(Date.now()); return trees.shift() ?? header; },
    click: async id => inputs.push(id) };
  const context = { cua: { getApp: async () => raw }, setTimeout,
    nodeRepl: { write: text => output.push(text) } };
  return { output, starts, inputs, run: code => runInNewContext(`(async () => { ${code} })()`, context) };
}
test('waitFor reads only when called, returns the matching full tree and traces every poll', async () => {
  const f = fixture([header, header + '\n\t1 button Description: 7, ID: Seven']);
  await f.run(readCode('await cua.getApp("Calculator");'));
  assert.equal(f.starts.length, 0);
  const tree = await f.run(guardedCode('return await app.waitFor({ id: "Seven" }, { timeoutMs: 1000 });', window, undefined, undefined, { timing: true }));
  assert.match(tree, /ID: Seven/);
  assert.equal(f.starts.length, 2);
  assert.ok(f.starts[1] - f.starts[0] >= 250);
  assert.equal(f.output.filter(x => x.includes('"phase":"wait"')).length, 2);
  assert.deepEqual(f.inputs, []);
});
test('waitFor accepts labels and exact lines and refuses duplicate matches', async () => {
  for (const selector of [{ label: '7' }, { line: 'button Description: 7, ID: Seven' }]) {
    const f = fixture([header + '\n\t1 button Description: 7, ID: Seven']);
    await f.run(readCode('await cua.getApp("Calculator");'));
    assert.match(await f.run(guardedCode(`return await app.waitFor(${JSON.stringify(selector)});`, window)), /ID: Seven/);
  }
  const f = fixture([header + '\n\t1 button 7\n\t2 button 7']);
  await f.run(readCode('await cua.getApp("Calculator");'));
  await assert.rejects(f.run(guardedCode('await app.waitFor({ label: "7" });', window)), /ambiguous.*2/i);
});
test('a late wait read cannot overwrite a newer observation', async () => {
  let resolveOld, reads = 0;
  const raw = { getAXState: async () => ++reads === 1 ? new Promise(resolve => { resolveOld = resolve; }) : header + '\n1 button New' };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write() {} }, setTimeout };
  const run = code => runInNewContext(`(async () => { ${code} })()`, context);
  await run(readCode('await cua.getApp("Calculator");'));
  const pending = run(guardedCode('await app.waitFor({ label: "Old" });', window));
  await run('await app.getAXState();');
  resolveOld(header + '\n1 button Old');
  await assert.rejects(pending, /another action or read/);
});
test('a wait follows an Open panel opened by this call only in the default lease mode', async () => {
  const initial = 'Window: "Untitled", App: TextEdit.\n0 standard window Untitled';
  const panel = 'Window: "Open", App: TextEdit.\n0 standard window Open, ID: open-panel\n1 button Open';
  for (const strict of [false, true]) {
    let opened = false;
    const raw = { getAXState: async () => opened ? panel : initial, pressKey: async () => { opened = true; } };
    const context = { cua: { getApp: async () => raw }, setTimeout, nodeRepl: { write() {} } };
    const run = code => runInNewContext(`(async () => { ${code} })()`, context);
    await run(readCode('await cua.getApp("TextEdit");'));
    const waiting = run(guardedCode('await app.pressKey("super+o"); return await app.waitFor({ id: "open-panel" });',
      { title: 'Untitled', app: 'TextEdit', url: null }, undefined, undefined, { adoptUrl: !strict }));
    if (strict) await assert.rejects(waiting, /window changed/);
    else assert.match(await waiting, /ID: open-panel/);
  }
});
test('waitFor timeout includes the last window, validates bounds and stops on window change or read failure', async () => {
  const f = fixture([header]);
  await f.run(readCode('await cua.getApp("Calculator");'));
  await assert.rejects(f.run(guardedCode('await app.waitFor({ id: "missing" }, { timeoutMs: 0 });', window)), /timed out[\s\S]*Window: "Calculator"/);
  for (const args of ['{}', '{ id: "a", label: "b" }', '{ id: "" }', '{ id: "a" }, { timeoutMs: -1 }', '{ id: "a" }, { timeoutMs: 10001 }']) {
    await assert.rejects(f.run(guardedCode(`await app.waitFor(${args});`, window)), /waitFor needs/);
  }
  const changed = fixture(['Window: "Other", App: Calculator.\n0 standard window Other\n1 button 7']);
  await changed.run(readCode('await cua.getApp("Calculator");'));
  await assert.rejects(changed.run(guardedCode('await app.waitFor({ label: "7" });', window)), /window changed/i);
  const failed = fixture([]);
  await failed.run(readCode('await cua.getApp("Calculator");'));
  // The actual engine method fails, rather than returning a fabricated missing element.
  failed.run = code => runInNewContext(`(async () => { ${code} })()`, {
    app: { getAXState: async () => { throw new Error('timeoutReached'); } },
    cua: { getApp() {} }, nodeRepl: { write() {} }
  });
  await assert.rejects(failed.run(guardedCode('await app.waitFor({ id: "missing" });', window)), /timeoutReached/);
});
