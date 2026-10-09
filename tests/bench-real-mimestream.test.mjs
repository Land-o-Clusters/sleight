import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mail from '../bench/real-mimestream.mjs';
import { runOwned } from '../bench/preapproved-process.mjs';
import { probeMimestream } from '../bench/mimestream-probe.mjs';

function context(t) {
  const ctx = { dir: mkdtempSync(join(tmpdir(), 'sleight-private-mail-')), nonce: 'private-test' };
  t.after(() => rmSync(ctx.dir, { recursive: true, force: true }));
  return ctx;
}
function snapshot() {
  return { source: 'mimestream-ax', nonce: 'private-test',
    fullList: { scope: 'all-mail', unreadCount: 3, countProof: 'ax-explicit-count' },
    folder: { id: 'invented-folder', messageCount: 60, countProof: 'ax-explicit-count' },
    target: { id: 'invented-message', read: true, readProof: 'ax-explicit-read' },
    navigation: { folderId: 'invented-folder', messageId: null, threadId: null, scrollPosition: 0, searchQuery: null } };
}
async function acquired(ctx, kind = 'message', options = {}) {
  const before = snapshot(), after = structuredClone(before), calls = [];
  after.navigation.messageId = 'invented-message';
  if (kind === 'thread') { after.navigation.threadId = 'invented-thread'; after.navigation.thirdMessageId = 'invented-third'; after.navigation.threadMessagesRead = true; }
  if (kind === 'scroll') { after.navigation.scrollPosition = 1; after.navigation.scrollRegion = 'message-body'; after.navigation.scrollBottom = true; }
  if (kind === 'search') { after.navigation.searchQuery = 'Invented exact subject'; after.navigation.searchResultsBound = true; }
  const receipt = { running: true, launched: false, retainedWindow: true, creationOwned: true,
    expected: 'Invented answer', labels: ['Invented label'], before,
    target: { folderId: 'invented-folder', messageId: 'invented-message', threadId: kind === 'thread' ? 'invented-thread' : null,
      searchQuery: kind === 'search' ? 'Invented exact subject' : null, thirdMessageId: kind === 'thread' ? 'invented-third' : null },
    prompt: 'Read the invented message.', ...options.receipt };
  const adapter = async (ctx, kind, attach) => {
    attach({ snapshot: async () => structuredClone(after), close: async () => calls.push('close'),
      dispose: async () => { calls.push('dispose'); return true; }, ...options.handles });
    if (options.failure) throw options.failure;
    return receipt;
  };
  await mail.setupMimestream(ctx, kind, { adapter });
  ctx.answer = JSON.stringify({ answer: 'Invented answer' });
  return { before, after, calls, receipt };
}

test('dry preparation stores no private mailbox data and refuses live setup while owner-away is unproved', async t => {
  const ctx = context(t);
  mail.prepareMimestream(ctx);
  assert.equal(mail.expectedMimestream(ctx), null);
  assert.deepEqual(mail.labelsMimestream(ctx), []);
  await assert.rejects(mail.setupMimestream(ctx, 'message'), e => e.code === 'MIMESTREAM_OWNER_AWAY_UNPROVED' && e.noMutation === true);
  assert.equal(ctx.windowLeases, undefined);
  await mail.cleanupMimestream(ctx);
});

for (const kind of ['label', 'message', 'thread', 'scroll', 'search']) {
  test(`${kind} checker accepts an independently observed answer with unchanged mailbox counts`, async t => {
    const ctx = context(t);
    await acquired(ctx, kind);
    assert.equal(await mail.checkMimestream({ ...ctx }), true);
    ctx.answer = JSON.stringify({ answer: 'Wrong invented answer' });
    assert.equal(await mail.checkMimestream(ctx), 'MIMESTREAM_ANSWER_MISMATCH');
    ctx.answer = JSON.stringify({ answer: 'Invented answer', extra: 'not permitted' });
    assert.equal(await mail.checkMimestream(ctx), 'MIMESTREAM_ANSWER_INVALID');
  });
}

test('checker detects either count change and refuses missing or partial scope coverage', async t => {
  for (const mutate of [s => s.fullList.unreadCount++, s => s.folder.messageCount--,
    s => s.fullList.scope = 'visible-rows', s => delete s.fullList.countProof,
    s => s.folder.messageCount = null, s => s.target.read = false, s => delete s.target.readProof]) {
    const ctx = context(t), { after } = await acquired(ctx);
    mutate(after);
    assert.notEqual(await mail.checkMimestream(ctx), true);
  }
});

test('setup refuses unread and unknown-read targets before the model can receive a prompt', async t => {
  for (const change of [s => s.target.read = false, s => delete s.target.readProof,
    s => s.fullList.unreadCount = null, s => s.folder.messageCount = null]) {
    const ctx = context(t), before = snapshot();
    change(before);
    await assert.rejects(acquired(ctx, 'message', { receipt: { before } }), e => e.code === 'MIMESTREAM_BASELINE_UNPROVED');
    assert.equal(mail.expectedMimestream(ctx), null);
    assert.throws(() => mail.promptMimestream(ctx), /MIMESTREAM_BASELINE_UNAVAILABLE/);
    await mail.cleanupMimestream(ctx);
  }
});

test('each task requires its independent navigation result rather than answer matching alone', async t => {
  for (const [kind, field, value] of [['label', 'folderId', 'wrong-folder'], ['message', 'messageId', null],
    ['thread', 'threadId', null], ['scroll', 'scrollPosition', 0], ['search', 'searchQuery', 'wrong-query']]) {
    const ctx = context(t), { after } = await acquired(ctx, kind);
    after.navigation[field] = value;
    assert.equal(await mail.checkMimestream(ctx), 'MIMESTREAM_NAVIGATION_UNPROVED');
  }
});

test('private receipt strings never become enumerable context or diagnostic properties', async t => {
  const ctx = context(t);
  await acquired(ctx);
  const text = JSON.stringify({ ...ctx, answer: undefined });
  for (const privateValue of ['Invented answer', 'Invented label', 'invented-folder', 'invented-message']) {
    assert.equal(text.includes(privateValue), false);
  }
  assert.equal(mail.expectedMimestream({ ...ctx }), 'Invented answer');
  assert.deepEqual(mail.labelsMimestream({ ...ctx }), ['Invented label']);
  const prompt = mail.promptMimestream(ctx);
  assert.match(prompt, /Never compose, reply, forward, archive, move, label, flag, mark read or unread, delete, or change settings/);
  assert.match(prompt, /JSON.*one.*answer/s);
});

test('cleanup closes only a creation-owned window, collects the helper, and retains terms for privacy audit', async t => {
  const ctx = context(t), { calls } = await acquired(ctx);
  await mail.cleanupMimestream(ctx);
  assert.deepEqual(calls, ['close', 'dispose']);
  assert.equal(ctx.windowLeases[0].launched, false);
  assert.equal(ctx.windowLeases[0].cleaned, true);
  assert.equal(mail.expectedMimestream(ctx), 'Invented answer');
  assert.deepEqual(mail.labelsMimestream(ctx), ['Invented label']);
  await mail.cleanupMimestream(ctx);
  assert.deepEqual(calls, ['close', 'dispose']);
});

test('ambiguous window ownership and a stopped dialog never trigger AX cleanup but still collect the helper', async t => {
  for (const receipt of [{ creationOwned: false }, { launched: true }]) {
    const ctx = context(t), calls = [];
    await assert.rejects(acquired(ctx, 'message', { receipt, handles: {
      close: async () => calls.push('close'), dispose: async () => { calls.push('dispose'); return true; },
    } }), e => e.code === 'MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED');
    await assert.rejects(mail.cleanupMimestream(ctx), /MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED/);
    assert.deepEqual(calls, ['dispose']);
  }
  const ctx = context(t), calls = [];
  const failure = Object.assign(new Error('Invented private error content'), { code: 'MIMESTREAM_APP_DIALOG_STOP' });
  await assert.rejects(acquired(ctx, 'message', { failure, handles: {
    close: async () => calls.push('close'), dispose: async () => { calls.push('dispose'); return true; },
  } }), e => e.message === 'MIMESTREAM_APP_DIALOG_STOP');
  await mail.cleanupMimestream(ctx);
  assert.deepEqual(calls, ['dispose']);
});

test('collector lease exists before adapter launch and an aborted setup awaits collection', async t => {
  const ctx = context(t), controller = new AbortController();
  ctx.signal = controller.signal;
  let collected = false;
  await assert.rejects(mail.setupMimestream(ctx, 'label', { adapter: async (passed, kind, attach) => {
    assert.equal(passed.windowLeases.length, 1);
    attach({ snapshot: async () => snapshot(), close: async () => assert.fail('no receipt owns a window'),
      dispose: async () => { await new Promise(resolve => setTimeout(resolve, 5)); collected = true; return true; } });
    controller.abort();
    throw new Error('Invented account subject must not escape');
  } }), e => e.message === 'MIMESTREAM_SETUP_FAILED');
  await mail.cleanupMimestream(ctx);
  assert.equal(collected, true);
});

test('checker errors never disclose private AX failure text', async t => {
  const ctx = context(t);
  await acquired(ctx, 'message', { handles: { snapshot: async () => { throw new Error('Invented private sender@example.test'); } } });
  assert.equal(await mail.checkMimestream(ctx), 'MIMESTREAM_SNAPSHOT_UNPROVED');
});

test('failed setup retains observed label terms for the post-cleanup privacy audit', async t => {
  const ctx = context(t), before = snapshot();
  before.fullList.unreadCount = null;
  await assert.rejects(acquired(ctx, 'label', { receipt: { before } }), /MIMESTREAM_BASELINE_UNPROVED/);
  assert.deepEqual(mail.labelsMimestream(ctx), ['Invented label']);
  await mail.cleanupMimestream(ctx);
  assert.deepEqual(mail.labelsMimestream({ ...ctx }), ['Invented label']);
});

test('scroll requires the message-body bottom and thread requires a current displayed third reply', async t => {
  for (const [kind, mutate] of [['scroll', s => s.navigation.scrollPosition = 0.5],
    ['scroll', s => s.navigation.scrollRegion = 'message-list'], ['scroll', s => s.navigation.scrollBottom = false],
    ['thread', s => s.navigation.thirdMessageId = null], ['thread', s => s.navigation.threadMessagesRead = false],
    ['search', s => s.navigation.searchResultsBound = false]]) {
    const ctx = context(t), { after } = await acquired(ctx, kind); mutate(after);
    assert.equal(await mail.checkMimestream(ctx), 'MIMESTREAM_NAVIGATION_UNPROVED');
  }
});

test('native unconfirmed setup cleanup is preserved after helper collection', async t => {
  const ctx = context(t); ctx.ownerAway = true;
  const adapter = (ctx, kind, attach) => mail.openMimestream(ctx, kind, attach, {
    helper: async () => 'invented-helper', run: async (command, args, options) => {
      options.onStdout(JSON.stringify({ stage: 'private-terms', labels: ['Invented observed label'] }) + '\n');
      options.onStdout(JSON.stringify({ stage: 'setup-failure', actionTaken: true, cleanup: 'unconfirmed' }) + '\n');
      return { exit: { code: 1 }, groupClean: true, stderr: 'MIMESTREAM_BASELINE_UNPROVED', stdout: '' };
    },
  });
  await assert.rejects(mail.setupMimestream(ctx, 'label', { adapter }), /MIMESTREAM_BASELINE_UNPROVED/);
  await assert.rejects(mail.cleanupMimestream(ctx), /MIMESTREAM_CLEANUP_UNCONFIRMED/);
  assert.equal(ctx.fixtureDiagnostics[0].cleanup, 'unconfirmed');
  assert.equal(ctx.fixtureDiagnostics[0].actionTaken, true);
  assert.deepEqual(mail.labelsMimestream(ctx), ['Invented observed label']);
  assert.notEqual(ctx.windowLeases[0].cleaned, true);
});

test('a dialog callback failure still stops and collects the helper without AX cleanup', async t => {
  const ctx = context(t); ctx.ownerAway = true;
  ctx.onAppDialog = () => { throw new Error('Invented callback private content'); };
  let stopped = false;
  const adapter = (ctx, kind, attach) => mail.openMimestream(ctx, kind, attach, {
    helper: async () => 'invented-helper', run: async (command, args, options) => {
      options.signal.addEventListener('abort', () => stopped = true);
      options.onStdout(JSON.stringify({ stage: 'app-dialog', category: 'account', actionTaken: true }) + '\n');
      return { exit: { code: 1 }, groupClean: true, stderr: 'MIMESTREAM_APP_DIALOG_STOP', stdout: '' };
    },
  });
  await assert.rejects(mail.setupMimestream(ctx, 'label', { adapter }), /MIMESTREAM_APP_DIALOG_STOP/);
  await assert.rejects(mail.cleanupMimestream(ctx), /MIMESTREAM_CLEANUP_UNCONFIRMED/);
  assert.equal(stopped, true);
  assert.equal(ctx.fixtureDiagnostics[0].appDialog.category, 'account');
});

test('a launched helper lost before any receipt cannot clear unresolved acquisition', async t => {
  const ctx = context(t); ctx.ownerAway = true;
  const adapter = (ctx, kind, attach) => mail.openMimestream(ctx, kind, attach, {
    helper: async () => 'invented-helper', run: async () => ({ exit: { code: null, signal: 'SIGTERM' },
      groupClean: true, stderr: '', stdout: '', cancelled: true }),
  });
  await assert.rejects(mail.setupMimestream(ctx, 'label', { adapter }), /MIMESTREAM_SETUP_FAILED/);
  await assert.rejects(mail.cleanupMimestream(ctx), /MIMESTREAM_CLEANUP_UNCONFIRMED/);
  assert.equal(ctx.pendingAcquisitions.has('mimestream'), true);
  assert.notEqual(ctx.windowLeases[0].cleaned, true);
  assert.equal(ctx.fixtureDiagnostics[0].cleanup, 'unconfirmed');
});

test('private terms from the source window survive a different ready-window label receipt and cleanup', async t => {
  const ctx = context(t); ctx.ownerAway = true;
  const adapter = (ctx, kind, attach) => mail.openMimestream(ctx, kind, attach, {
    helper: async () => 'invented-helper', run: async (command, args, options) => {
      options.onStdout(JSON.stringify({ stage: 'private-terms', labels: ['Invented source label'] }) + '\n');
      options.onStdout(JSON.stringify({ stage: 'ready', receipt: { running: true, launched: false, retainedWindow: true,
        creationOwned: true, expected: 'Invented answer', labels: ['Invented ready label'], before: snapshot(),
        target: { folderId: 'invented-folder', messageId: 'invented-message' }, prompt: 'Read invented label.' } }) + '\n');
      options.onStdout(JSON.stringify({ stage: 'closed' }) + '\n');
      return { exit: { code: 0 }, groupClean: true, stderr: '', stdout: '' };
    },
  });
  await mail.setupMimestream(ctx, 'label', { adapter });
  await mail.cleanupMimestream(ctx);
  assert.deepEqual(mail.labelsMimestream(ctx), ['Invented source label', 'Invented ready label']);
});

test('read-only probe retains its lock if compiler collection is unconfirmed', async () => {
  let released = false;
  const output = [];
  const code = await probeMimestream({ acquireLock: () => {}, releaseLock: () => released = true, write: value => output.push(value),
    helper: async () => { throw Object.assign(new Error(), { code: 'MIMESTREAM_HELPER_UNCOLLECTED' }); } });
  assert.equal(code, 1);
  assert.equal(released, false);
  assert.equal(JSON.parse(output[0]).code, 'MIMESTREAM_HELPER_UNCOLLECTED');
});

test('native capability decisions require explicit counts, read proof, and unique creation events', async t => {
  const helper = await mail.mimestreamHelper(t.signal);
  const result = await runOwned(helper, ['--self-test'], { timeoutMs: 15000, signal: t.signal });
  assert.equal(result.exit.code, 0);
  assert.equal(result.groupClean, true);
  assert.deepEqual(JSON.parse(result.stdout), { selfTest: true, explicitCountRequired: true,
    explicitReadRequired: true, ambiguousCreationRefused: true, dialogStops: true, existingWindowsClosed: 0,
    preactionCountsRequired: true, onlyProvedLabels: true, unreadSelectionRefused: true,
    duplicateSubjectsRefused: true, searchQueryBoundRequired: true });
});
