import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { guardedCode, readCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

test('headers require one exact identity, including a document URL', () => {
  assert.deepEqual(windowFromText('Window: "", App: Chess.\n0 standard window'), { title: '', app: 'Chess', url: null });
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
  assert.equal(outputs.at(-1), 'Window: "second", App: TextEdit');
});
