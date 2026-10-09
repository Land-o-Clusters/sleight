import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedCode, GUARD_MARK, GUARD_END, sameElement } from '../plugins/sleight/lib/document-scope.mjs';

const expected = { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' };
const tree = (window = expected, rows = '\t1 button Save, ID: Save') =>
  `Window: ${JSON.stringify(window.title)}, App: ${window.app}.\n0 standard window${window.url ? `, URL: ${window.url}` : ''}\n${rows}`;
function fixture({ current = () => tree(), action = () => {}, screenshotState } = {}) {
  const calls = [], output = [];
  const raw = {
    async getAXState(options) { calls.push(['read', options]); return current(); },
    async getAXStateAndScreenshot(options) {
      calls.push(['both', options]);
      const state = screenshotState ? screenshotState(options) : current();
      if (options?.emit !== false) output.push(state);
      return { state, screenshot: new Uint8Array([1, 2, 3]) };
    },
    async getScreenshot() { calls.push(['screenshot']); return new Uint8Array([1]); },
  };
  for (const name of ['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText']) {
    raw[name] = async (...args) => { calls.push([name, ...args]); return action(name, args); };
  }
  const context = { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: value => output.push(value), emitImage: async () => {} } };
  const run = (code, options = {}, target = expected) => runInNewContext(`(async () => { ${guardedCode(code, target, 'changed window', undefined, options)} })()`, context);
  return { run, raw, calls, output, context };
}

test('a combined observation supplies the first action and a full post-call header', async () => {
  const f = fixture();
  await f.run('await app.getAXStateAndScreenshot(); await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['both', 'click', 'read']);
  assert.equal(f.calls[0][1].disableDiffing, true);
  assert.equal(f.output.at(-1), GUARD_MARK + tree() + GUARD_END);
});

test('a final combined read avoids an extra read and preserves hidden output semantics', async () => {
  for (const emit of [true, false]) {
    const f = fixture();
    await f.run(`await app.click(1); const observed = await app.getAXStateAndScreenshot({ emit: ${emit} });
      if (observed.screenshot[2] !== 3) throw new Error('screenshot changed');`);
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'both']);
    assert.equal(f.calls.at(-1)[1].emit, emit);
    if (!emit) assert.equal(f.output.at(-1), GUARD_MARK + tree() + GUARD_END);
    else assert.equal(f.output.at(-1), tree());
  }
});

test('combined read always requests a full tree, even when its caller requests a diff', async () => {
  const f = fixture({ screenshotState: options => options?.disableDiffing ? tree() : '+ 2 button Other' });
  await f.run('await app.getAXStateAndScreenshot({ disableDiffing: false }); await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['both', 'click', 'read']);
});

test('each action invalidates the combined snapshot before checking title, app and URL again', async () => {
  for (const key of ['title', 'app', 'url']) {
    let changed = false;
    const f = fixture({ current: () => tree(changed ? { ...expected, [key]: 'other' } : expected),
      action: () => { changed = true; } });
    await assert.rejects(f.run('await app.getAXStateAndScreenshot(); await app.click(1); await app.click(1);'), /changed window/);
    assert.deepEqual(f.calls.map(c => c[0]), ['both', 'click', 'read']);
  }
});

test('every native method checks the identity returned by a combined observation', async () => {
  for (const expression of ['click(1)', 'drag([1,1],[2,2])', 'scroll(1,"down",1)', 'selectText(1,"x")',
    'setValue(1,"x")', 'performSecondaryAction(1,"Raise")', 'paste("x")', 'pressKey("a")', 'typeText("x")']) {
    const f = fixture({ current: () => tree({ ...expected, url: 'file:///tmp/b.txt' }) });
    await assert.rejects(f.run(`await app.getAXStateAndScreenshot(); await app.${expression};`), /changed window/);
    assert.deepEqual(f.calls.map(c => c[0]), ['both']);
  }
});

test('a combined snapshot cannot preserve a stale number, ID or label after an action', async () => {
  for (const selector of ['2', '{ id: "Save" }', '{ label: "Save" }']) {
    let changed = false;
    const f = fixture({ current: () => tree(expected, changed ? '\t2 button Delete\n\t3 button Save, ID: Save' : '\t2 button Save, ID: Save'),
      action: () => { changed = true; } });
    const done = f.run(`await app.getAXStateAndScreenshot(); await app.click(2); await app.click(${selector});`);
    if (selector === '2') {
      await assert.rejects(done, /changed what element 2 is/);
      assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 2]]);
    } else {
      await done;
      assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 2], ['click', 3]]);
    }
  }
});

test('a read that drops an element\'s attributes under load still matches that element', async () => {
  // Under load the engine read "button Two" where it had read "button Description: 2, ID: Two".
  const full = '\t2 button Description: 1, ID: One\n\t3 button Description: 2, ID: Two';
  const bare = '\t2 button One\n\t3 button Two';
  let clicks = 0;
  const f = fixture({ current: () => tree(expected, clicks ? bare : full), action: () => { clicks++; } });
  await f.run('await app.click(2); await app.click(3);');
  assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 2], ['click', 3]]);
  let moved = 0;
  const g = fixture({ current: () => tree(expected, moved ? '\t2 button One\n\t3 button Three' : full), action: () => { moved++; } });
  await assert.rejects(g.run('await app.click(2); await app.click(3);'), /changed what element 3 is/);
});

test('sameElement accepts only a bare line named by the fuller line\'s ID or label', () => {
  assert.equal(sameElement('button Description: 2, ID: Two', 'button Two'), true);
  assert.equal(sameElement('button Two', 'button Description: 2, ID: Two'), true);
  assert.equal(sameElement('button Description: 2, ID: Two', 'button 2'), true, 'by description');
  assert.equal(sameElement('toggle button Description: Bold, ID: bold', 'toggle button Bold'), true);
  for (const now of ['button Three', 'checkbox Two', 'button Two, ID: Other', 'button', 'button Tw', undefined]) {
    assert.equal(sameElement('button Description: 2, ID: Two', now), false, String(now));
  }
  assert.equal(sameElement(undefined, undefined), true);
});

test('keys, text, paste and coordinates go ahead without a read only after typing, pasting or a plain key', async () => {
  // After a click, Return or a shortcut the next action reads, which also waits for a panel to open.
  const sequence = 'await app.click(1); await app.typeText("x"); await app.pressKey("Return"); await app.paste("y"); await app.click([5, 5]); await app.drag([1, 1], [2, 2]);';
  const f = fixture();
  await f.run(sequence);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read', 'typeText', 'pressKey', 'read', 'paste', 'click', 'read', 'drag', 'read']);
  const keys = fixture();
  await keys.run('await app.typeText("a"); await app.pressKey("b"); await app.pressKey("Left"); await app.pressKey("super+shift+g"); await app.typeText("/tmp"); await app.pressKey("Return");');
  assert.deepEqual(keys.calls.map(c => c[0]), ['read', 'typeText', 'pressKey', 'pressKey', 'pressKey', 'read', 'typeText', 'pressKey', 'read']);
  const careful = fixture();
  await careful.run(sequence, { careful: true });
  assert.deepEqual(careful.calls.map(c => c[0]), ['read', 'click', 'read', 'typeText', 'read', 'pressKey', 'read', 'paste', 'read', 'click', 'read', 'drag', 'read']);
  // The first action of a call is still checked, and a numbered action after another still reads.
  const first = fixture();
  await first.run('await app.typeText("x"); await app.click(1);');
  assert.deepEqual(first.calls.map(c => c[0]), ['read', 'typeText', 'read', 'click', 'read']);
});

test('a window change mid-batch stops the next numbered action, and careful mode stops keys too', async () => {
  for (const [code, options, stopped] of [['await app.typeText("a"); await app.typeText("x");', {}, false],
    ['await app.typeText("a"); await app.typeText("x");', { careful: true }, true], ['await app.click(1); await app.typeText("x");', {}, true],
    ['await app.click(1); await app.click(1);', {}, true]]) {
    let changed = false;
    const f = fixture({ current: () => tree(changed ? { ...expected, title: 'b.txt' } : expected), action: () => { changed = true; } });
    const done = f.run(code, options);
    if (stopped) await assert.rejects(done, /changed window/); else await done;
  }
});

test('a prior read with no inventory is used as it is, and a degraded read still finds an element by ID', async () => {
  const f = fixture({ current: () => tree(expected, '\t1 button One\n\t2 button Two') });
  f.context.cua.listApps = async () => { f.calls.push(['listApps']); return []; };
  await f.run('await app.click({ id: "Two" });', { prior: { text: tree(expected, '\t1 button One\n\t2 button Two'), windows: null } });
  assert.deepEqual(f.calls.map(c => c[0]), ['click', 'read'], 'no inventory and no read before the click');
  assert.deepEqual(f.calls.find(c => c[0] === 'click'), ['click', 2], 'the bare line named Two');
  const ambiguous = fixture({ current: () => tree(expected, '\t1 button Two\n\t2 button Two') });
  await assert.rejects(ambiguous.run('await app.click({ id: "Two" });'), /2 elements|no element/);
  const attributed = fixture({ current: () => tree(expected, '\t1 button Description: 2, ID: Deux') });
  await assert.rejects(attributed.run('await app.click({ id: "Two" });'), /no element/);
});

test('new calls expire a combined snapshot; screenshots replace it with a fresh combined capture', async () => {
  const f = fixture();
  await f.run('await app.getAXStateAndScreenshot();');
  f.calls.length = 0;
  await f.run('await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
  f.calls.length = 0;
  await f.run('await app.getScreenshot(); await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['both', 'click', 'read']);
  f.calls.length = 0;
  await f.run('await app.getAXStateAndScreenshot(); await app.getScreenshot(); await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['both', 'both', 'click', 'read']);
});

test('input through another handle invalidates a combined observation of the same window', async () => {
  let changed = false;
  const f = fixture({ current: () => tree(changed ? { ...expected, title: 'other.txt' } : expected),
    action: () => { changed = true; } });
  f.context.cua.getApp = async () => ({ ...f.raw });
  await assert.rejects(f.run('await app.getAXStateAndScreenshot(); const other = await cua.getApp("TextEdit"); await other.pressKey("a"); await app.click(1);'), /changed window/);
  assert.equal(f.calls.filter(c => c[0] === 'click').length, 0);
});

test('a failed or incomplete combined observation cannot preserve an older cached tree', async () => {
  for (const state of [undefined, '', '+ 2 button Changed']) {
    const f = fixture({ screenshotState: () => state });
    await f.run('await app.getAXState(); await app.getAXStateAndScreenshot(); await app.click(1);');
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'both', 'read', 'click', 'read']);
  }
  const f = fixture();
  f.raw.getAXStateAndScreenshot = async () => { throw new Error('unavailable'); };
  await f.run('await app.getAXState(); try { await app.getAXStateAndScreenshot(); } catch {} await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'read', 'click', 'read']);
});

test('a cached combined observation cannot outlive input lease ownership or expiry', async t => {
  const bank = mkdtempSync(join(tmpdir(), 'sleight-guard-lease-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const path = join(bank, 'lease.json');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const record of [{ token: 'successor', expires: Date.now() + 30000 }, { token: 'owner', expires: 0 }]) {
    writeFileSync(path, JSON.stringify({ token: 'owner', expires: Date.now() + 30000 }));
    let actions = 0;
    const app = {
      getAXState: async () => tree(),
      getAXStateAndScreenshot: async () => {
        writeFileSync(path, JSON.stringify(record));
        return { state: tree() };
      },
      click: async () => { actions++; },
    };
    const code = guardedCode('await app.getAXStateAndScreenshot({ emit: false }); await app.click(1);',
      expected, 'changed window', { path, token: 'owner' });
    try {
      await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', code)(app, { getApp: async () => app }, { write() {} }), /ownership lost or expired/);
      assert.equal(actions, 0);
    } finally { delete globalThis.__sleightDocumentGuard; }
  }
});

for (const method of ['getAXState', 'getAXStateAndScreenshot']) {
  test(`${method} begun before input cannot refill the cache after that input`, async () => {
    let changed = false, finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = fixture({ current: () => tree(changed ? { ...expected, title: 'other.txt' } : expected),
      action: () => { changed = true; finish(); } });
    if (method === 'getAXStateAndScreenshot') {
      f.raw[method] = async () => { const state = tree(); await pending; return { state }; };
    } else {
      let reads = 0;
      f.raw[method] = async () => {
        if (++reads === 1) { const state = tree(); await pending; return state; }
        return tree(changed ? { ...expected, title: 'other.txt' } : expected);
      };
    }
    await assert.rejects(f.run(`const pending = app.${method}({ emit: false });
      await app.pressKey("a"); await pending; await app.click(1);`), /changed window/);
    assert.equal(f.calls.filter(c => c[0] === 'click').length, 0);
  });

  test(`${method} begun before a screenshot cannot refill its invalidated cache`, async () => {
    let changed = false, finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = fixture({ current: () => tree(changed ? { ...expected, title: 'other.txt' } : expected) });
    if (method === 'getAXStateAndScreenshot') {
      let reads = 0;
      f.raw[method] = async () => {
        if (++reads === 1) { const state = tree(); await pending; return { state }; }
        changed = true; finish();
        return { state: tree({ ...expected, title: 'other.txt' }), screenshot: new Uint8Array([1]) };
      };
    } else {
      let reads = 0;
      f.raw[method] = async () => {
        if (++reads === 1) { const state = tree(); await pending; return state; }
        return tree(changed ? { ...expected, title: 'other.txt' } : expected);
      };
      f.raw.getAXStateAndScreenshot = async () => {
        changed = true; finish();
        return { state: tree({ ...expected, title: 'other.txt' }), screenshot: new Uint8Array([1]) };
      };
    }
    await assert.rejects(f.run(`const pending = app.${method}({ emit: false });
      await app.getScreenshot(); await pending; await app.click(1);`), /changed window/);
    assert.equal(f.calls.filter(c => c[0] === 'click').length, 0);
  });
}
