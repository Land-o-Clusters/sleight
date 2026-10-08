import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { guardedCode, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/document-scope.mjs';

const expected = { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' };
const tree = (window = expected, rows = '\t2 button Save, ID: Save') =>
  `Window: ${JSON.stringify(window.title)}, App: ${window.app}.\n0 standard window, URL: ${window.url}\n${rows}`;
function fixture() {
  const calls = [], text = [], images = [], bytes = new Uint8Array([1, 2, 3]);
  const f = { current: tree(), action: () => {}, bytes, calls, text, images };
  const raw = {
    async getAXState() { calls.push('read'); return f.current; },
    async getAXStateAndScreenshot(options) {
      calls.push('both');
      assert.equal(options.emit, false);
      assert.equal(options.disableDiffing, true);
      return { state: f.current, screenshot: bytes };
    },
    async getScreenshot() { calls.push('screenshot'); return bytes; },
  };
  for (const name of ['click', 'pressKey', 'typeText']) raw[name] = async (...args) => {
    calls.push([name, ...args]); f.action();
  };
  const context = { app: raw, cua: { getApp: async () => ({ ...raw }) },
    nodeRepl: { write: s => text.push(s), emitImage: async b => images.push(b) } };
  f.raw = raw;
  f.run = (code, options = {}) => runInNewContext(`(async () => { ${guardedCode(code, expected, 'changed window', undefined, options)} })()`, context);
  return f;
}

test('screenshot supplies the guard header from the same capture and keeps image output semantics', async () => {
  for (const emit of [true, false]) {
    const f = fixture();
    await f.run(`const bytes = await app.getScreenshot({ emit: ${emit} });
      if (bytes[2] !== 3) throw new Error('bytes changed');`);
    assert.deepEqual(f.calls, ['both']);
    assert.deepEqual(f.images, emit ? [f.bytes] : []);
    assert.deepEqual(f.text, [GUARD_MARK + tree() + GUARD_END]);
  }
});

test('screenshot after input supplies the full final header without a second capture', async () => {
  const f = fixture();
  f.action = () => { f.current = tree({ ...expected, title: 'b.txt' }); };
  await f.run('await app.pressKey("a"); await app.getScreenshot({ emit: false });');
  assert.deepEqual(f.calls, ['read', ['pressKey', 'a'], 'both']);
  assert.deepEqual(f.text, [GUARD_MARK + f.current + GUARD_END]);
});

test('screenshot snapshots check title, app and URL before input and expire after input', async () => {
  for (const key of ['title', 'app', 'url']) {
    const f = fixture();
    f.action = () => { f.current = tree({ ...expected, [key]: 'other' }); };
    await assert.rejects(f.run('await app.getScreenshot(); await app.click(2); await app.typeText("blocked");'), /changed window/);
    assert.deepEqual(f.calls, ['both', ['click', 2], 'read']);
    const wrong = fixture(); wrong.current = f.current;
    await assert.rejects(wrong.run('await app.getScreenshot(); await app.click(2);'), /changed window/);
    assert.deepEqual(wrong.calls, ['both']);
  }
});

test('numbered actions stop on changed elements after screenshot; IDs and labels resolve again', async () => {
  for (const selector of ['2', '{ id: "Save" }', '{ label: "Save" }']) {
    const f = fixture();
    f.action = () => { f.current = tree(expected, '\t2 button Delete\n\t3 button Save, ID: Save'); };
    const run = f.run(`await app.getScreenshot(); await app.click(2); await app.click(${selector});`);
    if (selector === '2') {
      await assert.rejects(run, /changed what element 2 is/);
      assert.deepEqual(f.calls, ['both', ['click', 2], 'read']);
    } else {
      await run;
      assert.deepEqual(f.calls, ['both', ['click', 2], 'read', ['click', 3], 'read']);
    }
  }
});

test('screenshot cache expires across calls and input through an alias', async () => {
  const f = fixture();
  await f.run('await app.getScreenshot();');
  f.calls.length = 0; f.current = tree({ ...expected, title: 'other' });
  await assert.rejects(f.run('await app.click(2);'), /changed window/);
  assert.deepEqual(f.calls, ['read']);
  const alias = fixture();
  alias.action = () => { alias.current = f.current; };
  await assert.rejects(alias.run('await app.getScreenshot(); const other = await cua.getApp("TextEdit"); await other.pressKey("a"); await app.click(2);'), /changed window/);
  assert.equal(alias.calls.filter(c => Array.isArray(c) && c[0] === 'click').length, 0);
});

test('late screenshot cannot refill the cache after an action or replace a newer observation', async () => {
  for (const intervene of ['await app.pressKey("a");', 'await app.getAXState({ emit: false });']) {
    const f = fixture();
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    f.raw.getAXStateAndScreenshot = async () => { const state = f.current; await pending; return { state, screenshot: f.bytes }; };
    f.raw.getAXState = async () => {
      f.current = tree({ ...expected, title: 'other' }); finish(); return f.current;
    };
    // The action's guard sees the original document; only that action changes it.
    if (intervene.includes('pressKey')) {
      f.raw.getAXState = async () => f.current;
      f.action = () => { f.current = tree({ ...expected, title: 'other' }); finish(); };
    }
    await assert.rejects(f.run(`const pending = app.getScreenshot(); ${intervene} await pending; await app.click(2);`), /changed window/);
    assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === 'click').length, 0);
  }
});

test('incomplete, ambiguous and failed screenshot observations cannot reuse an older read', async () => {
  for (const state of [undefined, '', '+ 2 button Changed', tree() + '\n' + tree({ ...expected, title: 'other' })]) {
    const f = fixture();
    f.raw.getAXStateAndScreenshot = async () => {
      f.current = tree({ ...expected, title: 'other' }); return { state, screenshot: f.bytes };
    };
    await assert.rejects(f.run('await app.getAXState({ emit: false }); await app.getScreenshot(); await app.click(2);'), /changed window/);
    assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === 'click').length, 0);
  }
  const f = fixture();
  f.raw.getAXStateAndScreenshot = async () => { f.current = tree({ ...expected, title: 'other' }); throw new Error('capture failed'); };
  await assert.rejects(f.run('await app.getAXState({ emit: false }); try { await app.getScreenshot(); } catch {} await app.click(2);'), /changed window/);
});

test('missing screenshot fails without emitting or caching the accompanying tree', async () => {
  const f = fixture();
  f.raw.getAXStateAndScreenshot = async () => ({ state: tree() });
  await assert.rejects(f.run('await app.getScreenshot();'), /Screenshot unavailable/);
  assert.deepEqual(f.images, []);
  assert.deepEqual(f.text, []);
});

test('a target without combined observations keeps the screenshot fallback', async () => {
  const f = fixture();
  delete f.raw.getAXStateAndScreenshot;
  await f.run('await app.getScreenshot({ emit: false }); await app.click(2);');
  assert.deepEqual(f.calls, ['screenshot', 'read', ['click', 2], 'read']);
});

test('a screenshot snapshot cannot outlive lease ownership or expiry', async t => {
  const bank = mkdtempSync(join(tmpdir(), 'sleight-screenshot-lease-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const path = join(bank, 'lease.json');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const record of [{ token: 'successor', expires: Date.now() + 30000 }, { token: 'owner', expires: 0 }]) {
    writeFileSync(path, JSON.stringify({ token: 'owner', expires: Date.now() + 30000 }));
    let actions = 0;
    const app = {
      getAXState: async () => tree(),
      getScreenshot: async () => new Uint8Array([1]),
      getAXStateAndScreenshot: async () => {
        writeFileSync(path, JSON.stringify(record));
        return { state: tree(), screenshot: new Uint8Array([1]) };
      },
      click: async () => { actions++; },
    };
    const code = guardedCode('await app.getScreenshot({ emit: false }); await app.click(2);',
      expected, 'changed window', { path, token: 'owner' });
    try {
      await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', code)(app, { getApp: async () => app }, { write() {} }), /ownership lost or expired/);
      assert.equal(actions, 0);
    } finally { delete globalThis.__sleightDocumentGuard; }
  }
});

test('native access denial prevents the screenshot capture', async () => {
  const f = fixture();
  await assert.rejects(f.run('await app.getScreenshot();', { nativeDenied: 'no native grant' }), /no native grant/);
  assert.deepEqual(f.calls, []);
});
