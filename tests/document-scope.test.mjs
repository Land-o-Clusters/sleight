import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { guardedCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

test('headers require one exact identity, including a document URL', () => {
  assert.deepEqual(windowFromText('Window: "a.txt", App: TextEdit\nURL: file:///tmp/a.txt'), { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' });
  assert.deepEqual(windowFromText('Window: "a.txt", App: TextEdit.\n0 standard window a.txt, URL: file:///tmp/a.txt, Secondary Actions: Raise\n\t1 text entry area'), { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' });
  assert.equal(windowFromText('Window: "a.txt", App: TextEdit\nURL: file:///tmp/a.txt\nWindow: "b.txt", App: TextEdit\nURL: file:///tmp/b.txt'), undefined);
  assert.equal(windowFromText('Window: "a.txt", App: TextEdit\nURL: file:///tmp/a.txt\nURL: file:///tmp/b.txt'), undefined);
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
