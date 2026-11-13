import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { fixtureWindow, replay, virtualList } from './fixtures/native-picker-replay.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

const { listPicker } = await import('../plugins/sleight/lib/native-list-pick.mjs');

for (const family of ['numeric', 'words', 'accented']) {
  for (const targetIndex of [7, 67, 127, 207, 235]) {
    test(`NF2 settles a frameless ${family} row ${targetIndex} across a changing band`, async () => {
      const { model, result, error } = await replay(listPicker, { family, targetIndex, delayedFrame: true, changingBand: true });
      assert.equal(error, undefined);
      assert.equal(result.clicked, true, JSON.stringify(result));
      assert.deepEqual(model.chosen, [model.target]);
      assert.ok(model.attempts <= 2 && model.reads <= 60 && model.keys <= 400 && model.ticks <= 400);
    });
  }
}

for (const mutate of ['duplicate', 'reorder', 'missing', 'focus', 'list']) {
  test(`NF2 refuses a ${mutate} tree before recovery input`, async () => {
    const { model, result } = await replay(listPicker, { delayedFrame: true, mutate });
    assert.equal(result?.clicked, false);
    assert.equal(model.attempts, 1);
    assert.deepEqual(model.chosen, []);
    assert.equal(model.movesAfterFailure, 0);
  });
}

for (const geometry of [
  { visible: 6, overscan: 2, keyRows: 1, wheelRows: 3 },
  { visible: 18, overscan: 5, keyRows: 4, wheelRows: 13 },
  { visible: 11, overscan: 3, keyRows: 9, wheelRows: 2 },
]) {
  test(`NF2 recovery is independent of viewport and mover geometry ${JSON.stringify(geometry)}`, async () => {
    for (const family of ['numeric', 'words', 'accented']) {
      const { model, result, error } = await replay(listPicker, { ...geometry, family,
        count: 257, targetIndex: 148, start: 15, changingBand: true, delayedFrame: true });
      assert.equal(error, undefined);
      assert.equal(result.clicked, true, JSON.stringify(result));
      assert.deepEqual(model.chosen, [model.target]);
      assert.ok(model.attempts <= 2 && model.reads <= 60 && model.keys <= 400 && model.ticks <= 400);
    }
  });
}

test('NF2 redraws slower than the settling budget stop with two final attempts', async () => {
  const { model, result } = await replay(listPicker, { delayedFrame: true, frameDelay: 400, changingBand: true });
  assert.equal(result.reason, 'click-failed');
  assert.equal(model.attempts, 2);
  assert.ok(model.waits.reduce((a, b) => a + b, 0) <= 160);
});

for (const afterClick of ['duplicate', 'list', 'role']) {
  test(`NF2 refuses a selected row with ${afterClick} changed in the final read`, async () => {
    const { result } = await replay(listPicker, { afterClick });
    assert.equal(result.clicked, false);
    assert.equal(result.reason, 'click-unverified');
  });
}

test('NF2 a permanently frameless exact match stops after two final attempts', async () => {
  const { model, result } = await replay(listPicker, { permanentFrame: true, changingBand: true });
  assert.equal(result.reason, 'click-failed');
  assert.equal(model.attempts, 2);
  assert.ok(model.reads <= 60 && model.time < 4000);
});

test('NF2 a missing target stops without a final click', async () => {
  const { model, result } = await replay(listPicker, { missing: true });
  assert.equal(result.clicked, false);
  assert.equal(model.attempts, 0);
  assert.ok(model.reads <= 60 && model.keys <= 400 && model.ticks <= 400);
});

test('NF2 reserves a read for final selection and never clicks at the deadline', async () => {
  for (const searchOptions of [{ maxReads: 2 }, { timeoutMs: 0 }]) {
    const { model, result } = await replay(listPicker, { targetIndex: 7 }, { searchOptions });
    assert.equal(result.clicked, false);
    assert.equal(model.attempts, 0);
    assert.ok(model.reads <= (searchOptions.maxReads ?? 60));
  }
});

test('NF2 recovery observes time and read caps before repeating input', async () => {
  for (const searchOptions of [{ maxReads: 5 }, { timeoutMs: 100 }]) {
    const { model, result } = await replay(listPicker, { targetIndex: 7, delayedFrame: true }, { searchOptions });
    assert.equal(result.clicked, false);
    assert.equal(model.attempts, 1);
    assert.ok(model.reads <= (searchOptions.maxReads ?? 60));
    assert.ok(model.time <= (searchOptions.timeoutMs ?? 4000));
  }
});

test('NF2 serialized final-frame recovery stops on a revoked lease', async () => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-nf2-lease-')));
  const path = join(dir, 'lease.json');
  writeFileSync(path, JSON.stringify({ token: 'owner', expires: Date.now() + 30000 }));
  const model = virtualList({ delayedFrame: true });
  const raw = { getAXState: model.tree, pressKey: model.press,
    scroll: async (_number, direction, ticks) => model.scroll('list Catalog', direction, ticks),
    click: async number => {
      const row = model.rendered[number - 10];
      try { await model.click(`text (selectable) ${row}`); }
      catch (error) {
        writeFileSync(path, JSON.stringify({ token: 'revoked', expires: Date.now() + 30000 }));
        throw error;
      }
    } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    const code = guardedCode(`const picked = await app.pickFromList(${JSON.stringify(model.target)});`, fixtureWindow,
      undefined, { path, token: 'owner' }) + '\nreturn picked;';
    await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', code)(raw, { getApp: async () => raw }, { write() {} }), /Input lease stopped/);
    assert.equal(model.attempts, 1);
    assert.equal(model.movesAfterFailure, 0);
    assert.deepEqual(model.chosen, []);
  } finally {
    delete globalThis.__sleightDocumentGuard; delete globalThis.__sleightDocumentGuardSetup;
    removeTemp(dir);
  }
});
