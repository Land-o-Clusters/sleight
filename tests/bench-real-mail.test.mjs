import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mail from '../bench/real-mail.mjs';
import { mailTasks } from '../bench/tasks-mail.mjs';
import { runOwned } from '../bench/preapproved-process.mjs';

function context(t) {
  const ctx = { dir: mkdtempSync(join(tmpdir(), 'sleight-mail-')), nonce: 'mailtest42' };
  t.after(() => rmSync(ctx.dir, { recursive: true, force: true }));
  mail.prepareMailFixture(ctx);
  return ctx;
}
function imported(ctx) {
  // Synthetic app exports exercise the independent file/checker contract. They
  // prove neither Mail's native export format nor its host-side flag coverage.
  const root = join(ctx.dir, 'app-export');
  mkdirSync(root, { recursive: true });
  return {
    source: 'apple-mail-imported-data', nonce: ctx.nonce, location: 'On My Mac',
    coverage: ['content', 'attachments', 'membership', 'flags', 'read', 'added', 'deleted'],
    folders: [...ctx.mail.folders],
    topology: { complete: true, folders: [...ctx.mail.topology] },
    exports: ctx.mail.files.map((source, i) => {
      const path = join(root, `${i}.mbox`); copyFileSync(source, path);
      return { folder: ctx.mail.folders[i], path };
    }),
    messages: ctx.mail.messages.map(m => ({ id: m.id, folder: m.folder, contentHash: m.contentHash,
      attachmentHashes: m.attachments.map(a => a.hash), flags: [], read: true })),
  };
}
async function acquired(ctx, overrides = {}) {
  let state = imported(ctx), calls = [];
  const lease = {
    nonce: ctx.nonce, localOnly: true, retainedWindow: true, retainedMailbox: true, launched: false,
    snapshot: async () => structuredClone(state), close: async () => { calls.push('close'); },
    removeMailbox: async () => { calls.push('remove'); return true; },
    dispose: async () => { calls.push('dispose'); return true; },
    quit: async () => { calls.push('quit'); }, ...overrides,
  };
  await mail.setupMailImport(ctx, { importer: async () => lease });
  return { state, calls, lease };
}

test('fixture contains sixty invented MIME messages, reply references, attachments and nested mbox files', t => {
  const ctx = context(t);
  assert.equal(ctx.mail.messages.length, 60);
  assert.equal(new Set(ctx.mail.messages.map(m => m.id)).size, 60);
  assert.ok(ctx.mail.folders.includes('Projects/Orchard/Design'));
  const text = ctx.mail.files.map(p => readFileSync(p, 'utf8')).join('\n');
  assert.equal((text.match(/^From /gm) ?? []).length, 60);
  assert.equal((text.match(/^Message-ID:/gm) ?? []).length, 60);
  assert.ok(text.includes('In-Reply-To:'));
  assert.ok(text.includes('Content-Type: multipart/mixed'));
  assert.ok(text.includes('Content-Disposition: attachment; filename="orchard-map.csv"'));
  assert.ok(text.includes('>From this invented archive'));
  assert.ok(ctx.mail.messages.every(m => m.sender.endsWith('@example.test')));
});

test('setup fails before any Mail operation when native import ownership is unproved', async t => {
  const ctx = context(t);
  await assert.rejects(mail.setupMailImport(ctx), e => e.noMutation === true && e.code === 'MAIL_IMPORT_OWNERSHIP_UNPROVED');
  assert.equal(ctx.mailImport, undefined);
  await mail.cleanupMailImport(ctx);
  assert.equal(ctx.fixtureDiagnostics[0].cleanup, 'nothing created');
});

test('injected import receipt must have retained window ownership and local mailbox identity', async t => {
  const ctx = context(t);
  await assert.rejects(acquired(ctx, { retainedWindow: false }), /retained.*local.*ownership/i);
  assert.equal(await mail.checkMailAnswer({ ...ctx, answer: JSON.stringify({ answer: ctx.mail.answers['mail-message'] }) }, 'mail-message'),
    'Mail imported-data baseline is unavailable');
});

for (const id of ['mail-folder', 'mail-message', 'mail-thread', 'mail-attachment', 'mail-search']) {
  test(`${id} checker accepts exact fixture answer only with unchanged imported app data`, async t => {
    const ctx = context(t);
    assert.equal(await mail.checkMailAnswer(ctx, id), 'Mail imported-data baseline is unavailable');
    const { state } = await acquired(ctx);
    ctx.answer = JSON.stringify({ answer: ctx.mail.answers[id] });
    assert.equal(await mail.checkMailAnswer(ctx, id), true);
    ctx.answer = JSON.stringify({ answer: `${ctx.mail.answers[id]} wrong` });
    assert.match(await mail.checkMailAnswer(ctx, id), /answer/);
    ctx.answer = JSON.stringify({ answer: ctx.mail.answers[id] });
    state.messages[0].flags.push('flagged');
    assert.match(await mail.checkMailAnswer(ctx, id), /changed/);
  });
}

test('checker refuses changed content, attachment, membership, read state, additions and deletions', async t => {
  const mutations = [s => s.messages[0].contentHash = 'changed', s => s.messages[0].attachmentHashes.push('changed'),
    s => s.messages[0].folder = 'Elsewhere', s => s.messages[0].read = false,
    s => s.messages.push({ ...s.messages[0], id: 'new' }), s => s.messages.pop(), s => s.folders.pop(),
    s => s.topology.folders.push('Projects/Empty'), s => s.topology.complete = false];
  for (const mutate of mutations) {
    const ctx = context(t), { state } = await acquired(ctx);
    ctx.answer = JSON.stringify({ answer: ctx.mail.answers['mail-search'] });
    mutate(state);
    assert.match(await mail.checkMailAnswer(ctx, 'mail-search'), /changed|snapshot/);
  }
});

test('source mbox snapshots or incomplete flag coverage cannot qualify an import', async t => {
  for (const mutate of [s => s.source = 'fixture-mbox', s => s.coverage = ['content'],
    s => s.messages[0].read = false, s => s.messages[0].id = 'owner-message']) {
    const ctx = context(t), state = imported(ctx); mutate(state);
    await assert.rejects(acquired(ctx, { snapshot: async () => state }), /imported|snapshot/);
    assert.equal(await mail.checkMailAnswer(ctx, 'mail-search'), 'Mail imported-data baseline is unavailable');
  }
});

test('checker hashes app exports separately from original mbox and rejects changed exported bytes', async t => {
  const ctx = context(t), { state } = await acquired(ctx);
  ctx.answer = JSON.stringify({ answer: ctx.mail.answers['mail-message'] });
  appendFileSync(ctx.mail.files[0], 'source-only change\n');
  assert.equal(await mail.checkMailAnswer(ctx, 'mail-message'), true);
  appendFileSync(state.exports[0].path, 'changed app export\n');
  assert.match(await mail.checkMailAnswer(ctx, 'mail-message'), /changed/);
});

test('source paths and symlinks cannot stand in for exact app exports', async t => {
  for (const mutate of [
    (state, ctx) => state.exports[0].path = ctx.mail.files[0],
    (state, ctx) => { const path = join(ctx.dir, 'link'); symlinkSync(state.exports[0].path, path); state.exports[0].path = path; },
  ]) {
    const ctx = context(t), state = imported(ctx); mutate(state, ctx);
    await assert.rejects(acquired(ctx, { snapshot: async () => state }), /export/);
  }
});

test('partial import errors retain acquisition uncertainty rather than silently deleting evidence', async t => {
  const ctx = context(t);
  await assert.rejects(mail.setupMailImport(ctx, { importer: async () => { throw new Error('import started but failed'); } }), /import started/);
  assert.ok(ctx.pendingAcquisitions.has('mailImport'));
  await mail.cleanupMailImport(ctx);
  assert.ok(ctx.pendingAcquisitions.has('mailImport'));
});

test('cleanup closes retained fixture, removes only owned import, collects helper and preserves existing Mail', async t => {
  const ctx = context(t), { calls } = await acquired(ctx);
  await mail.cleanupMailImport(ctx);
  assert.deepEqual(calls, ['close', 'remove', 'dispose']);
  await mail.cleanupMailImport(ctx);
  assert.deepEqual(calls, ['close', 'remove', 'dispose']);
});

test('cleanup refuses deletion after close failure and quitting before helper collection', async t => {
  const ctx = context(t), { calls } = await acquired(ctx, { close: async () => { throw new Error('lost owned reference'); } });
  await assert.rejects(mail.cleanupMailImport(ctx), /lost owned reference/);
  assert.deepEqual(calls, ['dispose']);
  const other = context(t), result = await acquired(other, { launched: true, dispose: async () => false });
  await assert.rejects(mail.cleanupMailImport(other), /collection/);
  assert.deepEqual(result.calls, ['close', 'remove']);
});

test('permission cleanup stop never closes or removes Mail data', async t => {
  const ctx = context(t), { calls } = await acquired(ctx);
  ctx.cleanupSignal = AbortSignal.abort();
  await assert.rejects(mail.cleanupMailImport(ctx), /permission|aborted/i);
  assert.deepEqual(calls, ['dispose']);
});

test('five Mail tasks prohibit owner mail access and every mailbox mutation', t => {
  const ctx = context(t);
  assert.deepEqual(mailTasks.map(task => task.id), ['mail-folder', 'mail-message', 'mail-thread', 'mail-attachment', 'mail-search']);
  for (const task of mailTasks) {
    assert.equal(task.app, 'Mail');
    const prompt = task.prompt(ctx);
    for (const word of ['compose', 'reply', 'move', 'flag', 'delete', 'owner', 'accounts', 'On My Mac']) assert.ok(prompt.includes(word), word);
    assert.ok(prompt.includes(ctx.mail.name));
    assert.ok(prompt.includes('JSON'));
  }
});

test('production owner-away guard precedes helper compilation or Mail access', async t => {
  const ctx = context(t);
  await assert.rejects(mail.setupMailImport(ctx), e => e.noMutation === true && e.code === 'MAIL_IMPORT_OWNERSHIP_UNPROVED');
  assert.equal(ctx.pendingAcquisitions, undefined);
});

test('native pre-import stop accepts only explicit retained cleanup and helper collection receipts', async t => {
  const ctx = context(t); ctx.ownerAway = true;
  await assert.rejects(mail.setupMailImport(ctx, { importer: (fixture, current) => mail.openMailImport(fixture, current, {
    helper: async () => 'isolated-test-helper',
    run: async (_, __, options) => {
      options.onStdout(JSON.stringify({ stage: 'closed', removed: true, appQuit: false }) + '\n');
      options.onStdout(JSON.stringify({ stage: 'setup-failure', cleanup: 'closed retained fixture', imported: false }) + '\n');
      return { groupClean: true, exit: { code: 1 }, stdout: '', stderr: 'MAIL_IMPORT_LOCAL_DESTINATION_UNPROVED' };
    },
  }) }), e => e.noMutation === true);
  await mail.cleanupMailImport(ctx);
  assert.equal(ctx.mailImport.cleaned, true);
  assert.equal(ctx.mailImport.launched, false);
  assert.equal(ctx.pendingAcquisitions.size, 0);
  assert.equal(ctx.fixtureDiagnostics[0].appQuit, false);
});

test('native export parser derives body, MIME attachments and read/flag state from exported files', t => {
  const ctx = context(t), state = imported(ctx);
  const proof = { source: 'ax-fixture-message-state', complete: true, nonce: ctx.nonce, messages: state.messages };
  const snapshot = mail.snapshotMailExports(ctx, state.exports, state.topology, proof);
  assert.equal(snapshot.source, 'apple-mail-imported-data');
  assert.equal(snapshot.messages.length, 60);
  assert.ok(snapshot.messages.every(m => m.read === true && m.flags.length === 0));
  assert.deepEqual(snapshot.messages.map(m => m.contentHash).sort(), ctx.mail.messages.map(m => m.contentHash).sort());
  const attachment = snapshot.messages.find(m => m.id === ctx.mail.messages[20].id);
  assert.deepEqual(attachment.attachmentHashes, ctx.mail.messages[20].attachments.map(a => a.hash));
});

test('native export parser refuses missing flag/read headers rather than claiming content-only mutation coverage', t => {
  const ctx = context(t), state = imported(ctx);
  const path = state.exports[0].path;
  const text = readFileSync(path, 'utf8').replace(/^X-Status:.*\n/gm, '');
  rmSync(path); appendFileSync(path, text);
  const proof = { source: 'ax-fixture-message-state', complete: true, nonce: ctx.nonce, messages: state.messages };
  assert.throws(() => mail.snapshotMailExports(ctx, state.exports, state.topology, proof), /flag.*coverage/i);
});

test('native export parser checks path ownership before reading source or symlinked files', t => {
  const ctx = context(t), state = imported(ctx);
  const proof = { source: 'ax-fixture-message-state', complete: true, nonce: ctx.nonce, messages: state.messages };
  assert.throws(() => mail.snapshotMailExports(ctx, [{ folder: 'Archive', path: ctx.mail.files[0] }], state.topology, proof), /export/);
  const path = join(ctx.dir, 'export-link'); symlinkSync(state.exports[0].path, path);
  assert.throws(() => mail.snapshotMailExports(ctx, [{ folder: 'Archive', path }], state.topology, proof), /export/);
});

test('export Status headers cannot claim current app flags or read state without an independent receipt', t => {
  const ctx = context(t), state = imported(ctx);
  assert.throws(() => mail.snapshotMailExports(ctx, state.exports, state.topology), /MAIL_FLAG_READ_COVERAGE_UNPROVED/);
  const proof = { source: 'ax-fixture-message-state', complete: true, nonce: ctx.nonce, messages: structuredClone(state.messages) };
  proof.messages[0].flags.push('F');
  assert.throws(() => mail.snapshotMailExports(ctx, state.exports, state.topology, proof), /flag.*disagree/i);
});

test('native dialog stop publishes category and collects exact registered helper without AX cleanup', async t => {
  const ctx = context(t), cleanup = new AbortController(), dialogs = [];
  ctx.ownerAway = true; ctx.cleanupSignal = cleanup.signal;
  ctx.onAppDialog = dialog => { dialogs.push(dialog); cleanup.abort(); };
  await assert.rejects(mail.setupMailImport(ctx, { importer: (fixture, current) => mail.openMailImport(fixture, current, {
    helper: async () => 'isolated-test-helper',
    run: async (_, __, options) => {
      assert.equal(ctx.windowLeases[0], ctx.mailImport);
      const collected = new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ groupClean: true,
        exit: { code: null }, stdout: '', stderr: 'Mail signin stopped' }), { once: true }));
      options.onStdout(JSON.stringify({ stage: 'app-dialog', dialog: { app: 'Mail', bundle: 'com.apple.mail', category: 'signin' } }) + '\n');
      return collected;
    },
  }) }), /signin/);
  assert.equal(dialogs[0].category, 'signin');
  await assert.rejects(ctx.windowLeases[0].close(), /aborted/i);
  assert.equal(await ctx.windowLeases[0].dispose(), true);
  assert.ok(ctx.pendingAcquisitions.has('mailImport'));
});

test('native Mail ownership self-test rejects focus-only and ambiguous creation, and requires local destination proof', async () => {
  const helper = await mail.mailHelper();
  const result = await runOwned(helper, ['--self-test'], { timeoutMs: 15000 });
  assert.equal(result.exit.code, 0, result.stderr);
  assert.equal(result.groupClean, true);
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.existingWindowsRead, 0);
  assert.equal(evidence.ambiguousCreationRefused, true);
  assert.equal(evidence.localDestinationRequired, true);
  assert.equal(evidence.unsettledCreationRefused, true);
  assert.equal(evidence.dialogStops, true);
});
