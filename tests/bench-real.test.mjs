import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as benchmark from '../bench/tasks.mjs';

const getTask = id => {
  const task = benchmark.getTasks?.('real').find(t => t.id === id);
  assert.ok(task, `real suite must provide ${id}`);
  return task;
};
const context = t => {
  const dir = mkdtempSync(join(tmpdir(), 'real-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, nonce: 'abc123' };
};

test('suite selection preserves the default tasks and rejects an unknown suite', () => {
  assert.equal(typeof benchmark.getTasks, 'function');
  assert.equal(benchmark.getTasks(), benchmark.tasks);
  assert.equal(benchmark.tasks.length, 7);
  assert.deepEqual(benchmark.getTasks('real').map(t => t.id), [
    'safari-form', 'helium-form', 'preview-pdf', 'finder-files', 'textedit-calculator', 'simulator-flow',
    'safari-grid', 'helium-grid', 'safari-editor', 'helium-editor', 'safari-dense', 'helium-dense',
    'safari-spa', 'helium-spa', 'safari-nested', 'helium-nested', 'safari-infinite', 'helium-infinite',
    'word-edit', 'excel-edit', 'powerpoint-edit',
    'mail-folder', 'mail-message', 'mail-thread', 'mail-attachment', 'mail-search',
    'mimestream-label', 'mimestream-message', 'mimestream-thread', 'mimestream-scroll', 'mimestream-search',
  ]);
  for (const task of benchmark.getTasks('real')) {
    for (const method of ['prepare', 'setup', 'prompt', 'check', 'cleanup']) {
      assert.equal(typeof task[method], 'function', `${task.id} needs ${method}`);
    }
  }
  assert.throws(() => benchmark.getTasks('other'), /unknown suite/);
});

for (const id of ['safari-form', 'helium-form']) {
  test(`${id} checks submitted fields, select and checkbox, ignoring the agent's answer`, async t => {
    const task = getTask(id), ctx = context(t);
    await task.prepare(ctx);
    t.after(() => task.cleanup(ctx));
    assert.match(task.prompt(ctx), /Morgan Reed/);
    assert.doesNotMatch(task.prompt(ctx), /sleight|mcp__|getApp/);
    const response = await fetch(ctx.url);
    assert.match(await response.text(), /<select/);
    assert.notEqual(await task.check({ ...ctx, answer: 'I submitted everything' }), true);
    await fetch(ctx.url, { method: 'POST', body: new URLSearchParams({
      name: 'Morgan Reed', email: 'morgan@example.test', team: 'Design', updates: 'yes', code: 'abc123',
    }) });
    assert.equal(await task.check(ctx), true);
  });

  test(`${id} rejects missing checkbox, changed select and a nonce from another run`, async t => {
    const task = getTask(id), ctx = context(t);
    await task.prepare(ctx);
    t.after(() => task.cleanup(ctx));
    for (const changes of [{ updates: '' }, { team: 'Engineering' }, { code: 'stale' }]) {
      await fetch(ctx.url, { method: 'POST', body: new URLSearchParams({
        name: 'Morgan Reed', email: 'morgan@example.test', team: 'Design', updates: 'yes', code: 'abc123', ...changes,
      }) });
      assert.notEqual(await task.check(ctx), true);
    }
  });
}

test('preview-pdf checks the saved second page rotation and preserves page one', async t => {
  const task = getTask('preview-pdf'), ctx = context(t);
  await task.prepare(ctx);
  assert.notEqual(await task.check({ ...ctx, answer: 'Rotated and saved' }), true);
  await benchmark.writeTestPDF(ctx.pdf, [0, 90]);
  assert.equal(await task.check(ctx), true);
  await benchmark.writeTestPDF(ctx.pdf, [90, 90]);
  assert.notEqual(await task.check(ctx), true);
  await benchmark.writeTestPDF(ctx.pdf, [0]);
  assert.notEqual(await task.check(ctx), true);
});

test('finder-files checks the exact renamed and moved files with their contents', async t => {
  const task = getTask('finder-files'), ctx = context(t);
  await task.prepare(ctx);
  assert.notEqual(await task.check({ ...ctx, answer: 'Done' }), true);
  renameSync(join(ctx.folder, 'alpha.txt'), join(ctx.folder, 'renamed.txt'));
  renameSync(join(ctx.folder, 'bravo.txt'), join(ctx.folder, 'Archive', 'bravo.txt'));
  assert.equal(await task.check(ctx), true);
  writeFileSync(join(ctx.folder, 'charlie.txt'), 'changed\n');
  assert.notEqual(await task.check(ctx), true);
});

test('finder-files rejects a copied file left behind or an unexpected folder', async t => {
  const task = getTask('finder-files'), ctx = context(t);
  await task.prepare(ctx);
  renameSync(join(ctx.folder, 'alpha.txt'), join(ctx.folder, 'renamed.txt'));
  renameSync(join(ctx.folder, 'bravo.txt'), join(ctx.folder, 'Archive', 'bravo.txt'));
  writeFileSync(join(ctx.folder, 'bravo.txt'), 'bravo abc123\n');
  assert.notEqual(await task.check(ctx), true);
  rmSync(join(ctx.folder, 'bravo.txt'));
  mkdirSync(join(ctx.folder, 'Extra'));
  assert.notEqual(await task.check(ctx), true);
});

test('textedit-calculator checks the saved result and rejects the source number or a claimed answer', async t => {
  const task = getTask('textedit-calculator'), ctx = context(t);
  await task.prepare(ctx);
  assert.notEqual(await task.check({ ...ctx, answer: '391' }), true);
  writeFileSync(ctx.document, '391\n');
  assert.equal(await task.check(ctx), true);
  writeFileSync(ctx.document, '391 extra\n');
  assert.notEqual(await task.check(ctx), true);
});

test('simulator-flow checks the saved value and the required screen sequence', async t => {
  const task = getTask('simulator-flow'), ctx = context(t);
  await task.prepare(ctx);
  t.after(() => task.cleanup(ctx));
  assert.notEqual(await task.check({ ...ctx, answer: 'Saved' }), true);
  await fetch(ctx.url + 'edit');
  await fetch(ctx.url + 'save', { method: 'POST', body: new URLSearchParams({ value: 'Flow abc123' }) });
  assert.notEqual(await task.check(ctx), true);
  const back = await fetch(ctx.url + 'home');
  assert.match(await back.text(), /Flow abc123/);
  assert.equal(await task.check(ctx), true);
  await fetch(ctx.url + 'edit');
  assert.notEqual(await task.check(ctx), true);
});

test('simulator-flow rejects wrong saved text and an unordered or incomplete flow', async t => {
  const task = getTask('simulator-flow'), ctx = context(t);
  await task.prepare(ctx);
  t.after(() => task.cleanup(ctx));
  await fetch(ctx.url + 'save', { method: 'POST', body: new URLSearchParams({ value: 'Flow abc123' }) });
  await fetch(ctx.url + 'home');
  assert.notEqual(await task.check(ctx), true);
  await fetch(ctx.url + 'edit');
  await fetch(ctx.url + 'save', { method: 'POST', body: new URLSearchParams({ value: 'Wrong value' }) });
  await fetch(ctx.url + 'home');
  assert.notEqual(await task.check(ctx), true);
  assert.match(task.prompt(ctx), /Edit profile/);
});
