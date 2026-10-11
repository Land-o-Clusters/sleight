import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEditor, cleanupElectron, openElectron, prepareEditor, setupEditor } from '../bench/real-electron.mjs';
import { checkChat, cleanupChat, expectedChat, labelsChat, observationFromAX, prepareChat,
  promptChat, setupChat } from '../bench/real-chat.mjs';
import { getTasks } from '../bench/tasks.mjs';

function context(t) {
  const dir = mkdtempSync(join(tmpdir(), 'electron-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, nonce: 'abc123' };
}

test('running probe matches bundle IDs on the workspace list', async () => {
  const calls = [];
  const { appRunning } = await import('../bench/real-electron.mjs');
  await appRunning('com.apple.finder', {
    exec: async (file, args) => {
      calls.push([file, args.join(' ')]);
      return { stdout: '1\n' };
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /NSWorkspace\.sharedWorkspace\.runningApplications/);
  assert.match(calls[0][1], /const want = "com.apple.finder"/);
  assert.doesNotMatch(calls[0][1], /runningApplicationsWithBundleIdentifier/);
});

test('editor checker requires the replaced word on disk', t => {
  const ctx = context(t);
  prepareEditor(ctx);
  assert.equal(readFileSync(ctx.document, 'utf8'), 'alpha beta gamma\n');
  assert.notEqual(checkEditor(ctx), true);
  writeFileSync(ctx.document, 'alpha delta gamma\n');
  assert.equal(checkEditor(ctx), true);
  writeFileSync(ctx.document, 'alpha delta gamma extra\n');
  assert.notEqual(checkEditor(ctx), true);
  rmSync(ctx.document);
  assert.equal(checkEditor(ctx), 'edit document is missing');
});

test('editor setup records launch ownership and cleanup quits only a launched app', async t => {
  const calls = [];
  const running = async () => false;
  const ctx = context(t);
  await setupEditor(ctx, { app: 'Visual Studio Code', bundle: 'com.microsoft.VSCode' }, {
    running, open: async () => calls.push('open'), quit: async bundle => calls.push(['quit', bundle]),
  });
  assert.equal(ctx.electronLease.launched, true);
  assert.equal(ctx.electronLease.running, false);
  assert.deepEqual(calls, []);
  await cleanupElectron(ctx);
  assert.deepEqual(calls, [['quit', 'com.microsoft.VSCode']]);
});

test('editor cleanup leaves an already-running app, including Cursor', async t => {
  const calls = [];
  const ctx = context(t);
  await setupEditor(ctx, { app: 'Cursor', bundle: 'com.todesktop.230313mzl4w4u92' }, {
    running: async () => true, open: async () => calls.push('open'),
    quit: async () => calls.push('quit'),
  });
  assert.equal(ctx.electronLease.launched, false);
  await cleanupElectron(ctx);
  assert.deepEqual(calls, []);
});

test('Firefox setup opens the fixture URL in the background and quits only if it launched Firefox', async () => {
  const calls = [];
  const ctx = { url: 'http://127.0.0.1:9/abc123/', windowLeases: [] };
  await openElectron(ctx, { app: 'Firefox', bundle: 'org.mozilla.firefox', target: ctx.url }, {
    running: async () => false,
    open: async (bundle, target) => calls.push(['open', bundle, target]),
    quit: async bundle => calls.push(['quit', bundle]),
  });
  assert.deepEqual(calls, [['open', 'org.mozilla.firefox', ctx.url]]);
  assert.equal(ctx.electronLease.launched, true);
  await cleanupElectron(ctx);
  assert.deepEqual(calls, [['open', 'org.mozilla.firefox', ctx.url], ['quit', 'org.mozilla.firefox']]);
});

test('Firefox already running is opened and not quit', async () => {
  const calls = [];
  const ctx = { url: 'http://127.0.0.1:9/abc123/', windowLeases: [] };
  await openElectron(ctx, { app: 'Firefox', bundle: 'org.mozilla.firefox', target: ctx.url }, {
    running: async () => true,
    open: async (bundle, target) => calls.push(['open', bundle, target]),
    quit: async () => calls.push('quit'),
  });
  await cleanupElectron(ctx);
  assert.deepEqual(calls, [['open', 'org.mozilla.firefox', ctx.url]]);
});

test('AX observation returns only the selected conversation and newest static-text author', () => {
  assert.deepEqual(observationFromAX([
    { role: 'row', title: 'Invented channel', selected: true },
    { role: 'row', title: 'Other channel', selected: false },
    { role: 'static text', title: 'Invented Older' },
    { role: 'static text', title: 'Invented Author' },
    { role: 'text area', title: 'Message' },
  ]), { target: 'Invented channel', author: 'Invented Author' });
  assert.equal(observationFromAX([{ role: 'row', title: 'Invented channel', selected: true }]), null);
  assert.equal(observationFromAX(undefined), null);
});

async function acquiredChat(t, kind = 'slack', options = {}) {
  const ctx = context(t);
  const receipt = {
    running: true, launched: false, expected: 'Invented Author', target: 'Invented channel',
    terms: ['Invented channel', 'Invented Author'], prompt: 'Open the conversation named "Invented channel".',
    ...options.receipt,
  };
  await setupChat(ctx, kind, { adapter: async () => receipt });
  ctx.answer = JSON.stringify({ answer: 'Invented Author' });
  return ctx;
}

for (const kind of ['slack', 'discord', 'whatsapp']) {
  test(`${kind}-read accepts only the independently observed author`, async t => {
    const ctx = await acquiredChat(t, kind);
    assert.equal(checkChat(ctx), true);
    ctx.answer = JSON.stringify({ answer: 'Wrong invented author' });
    assert.equal(checkChat(ctx), 'CHAT_ANSWER_MISMATCH');
    ctx.answer = JSON.stringify({ answer: 'Invented Author', extra: true });
    assert.equal(checkChat(ctx), 'CHAT_ANSWER_INVALID');
    ctx.answer = 'Invented Author';
    assert.equal(checkChat(ctx), 'CHAT_ANSWER_INVALID');
  });
}

test('chat setup refuses a launch and keeps author strings off enumerable context', async t => {
  const ctx = context(t);
  await assert.rejects(setupChat(ctx, 'slack', { adapter: async () => ({
    running: true, launched: true, expected: 'Invented Author', target: 'Invented channel',
    terms: ['Invented channel'], prompt: 'Open it.',
  }) }), e => e.code === 'CHAT_LAUNCH_REFUSED');
  const ready = await acquiredChat(t);
  const text = JSON.stringify({ ...ready, answer: undefined });
  for (const secret of ['Invented Author', 'Invented channel']) assert.equal(text.includes(secret), false);
  assert.equal(expectedChat(ready), 'Invented Author');
  assert.deepEqual(labelsChat(ready), ['Invented channel', 'Invented Author']);
  const prompt = promptChat(ready);
  assert.match(prompt, /Never send/);
  assert.match(prompt, /JSON.*one.*answer/s);
  assert.doesNotMatch(prompt, /mcp__|getApp/);
});

test('live chat adapter refuses a missing app and never launches', async t => {
  await assert.rejects(setupChat(context(t), 'slack', { running: async () => true }),
    e => e.code === 'CHAT_OWNER_PRESENT_UNPROVED' && e.noMutation === true);
  const missing = { ...context(t), ownerPresent: true };
  await assert.rejects(setupChat(missing, 'slack', { running: async () => false }), e => e.code === 'CHAT_NOT_RUNNING');
  const unproved = { ...context(t), ownerPresent: true };
  await assert.rejects(setupChat(unproved, 'slack', { running: async () => true }), e => e.code === 'CHAT_BASELINE_UNPROVED');
});

test('chat dry preparation stores no author and Firefox web tasks keep independent page checks', async t => {
  const ctx = context(t);
  prepareChat(ctx);
  assert.equal(expectedChat(ctx), null);
  assert.throws(() => promptChat(ctx), e => e.code === 'CHAT_BASELINE_UNPROVED');
  await cleanupChat(ctx);
  const grid = getTasks('real').find(task => task.id === 'firefox-grid');
  const spa = getTasks('real').find(task => task.id === 'firefox-spa');
  const page = { nonce: 'abc123' };
  await grid.prepare(page);
  t.after(() => page.closeServer?.());
  assert.notEqual(grid.check(page), true);
  assert.equal(spa.app, 'Firefox');
  assert.match(grid.prompt(page), /Orchid/);
  assert.doesNotMatch(grid.prompt(page), /open_file|mcp__/);
});
