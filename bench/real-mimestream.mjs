import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runOwned } from './preapproved-process.mjs';

const privateState = new WeakMap();
const kinds = new Set(['label', 'message', 'thread', 'scroll', 'search']);
const codes = new Set(['MIMESTREAM_OWNER_AWAY_UNPROVED', 'MIMESTREAM_APP_DIALOG_STOP', 'MIMESTREAM_NOT_RUNNING',
  'MIMESTREAM_ACCESSIBILITY_UNAVAILABLE', 'MIMESTREAM_PROCESS_AMBIGUOUS', 'MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED',
  'MIMESTREAM_BASELINE_UNPROVED', 'MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED', 'MIMESTREAM_HELPER_UNCOLLECTED',
  'MIMESTREAM_SETUP_FAILED', 'MIMESTREAM_CLEANUP_UNCONFIRMED', 'MIMESTREAM_COMPILATION_FAILED']);
const failure = (code, noMutation = false) => Object.assign(new Error(code), { code, noMutation });
const safeCode = error => codes.has(error?.code) ? error.code : 'MIMESTREAM_SETUP_FAILED';
let executable, compilation, helperBank, uncollected = false;
process.once('exit', () => { if (helperBank && !uncollected) rmSync(helperBank, { recursive: true, force: true }); });

export function prepareMimestream(ctx) {
  if (!ctx.mimestream || !privateState.has(ctx.mimestream)) {
    ctx.mimestream = {};
    privateState.set(ctx.mimestream, { labels: [], expected: null });
  }
  return ctx.mimestream;
}
const stateFor = ctx => privateState.get(ctx.mimestream);
export const expectedMimestream = ctx => stateFor(ctx)?.expected ?? null;
export const labelsMimestream = ctx => [...(stateFor(ctx)?.labels ?? [])];

function validSnapshot(state, nonce, target) {
  return state?.source === 'mimestream-ax' && state.nonce === nonce &&
    state.fullList?.scope === 'all-mail' && state.fullList.countProof === 'ax-explicit-count' &&
    Number.isSafeInteger(state.fullList.unreadCount) && state.fullList.unreadCount >= 0 &&
    state.folder?.id === target?.folderId && state.folder.countProof === 'ax-explicit-count' &&
    Number.isSafeInteger(state.folder.messageCount) && state.folder.messageCount > 0 &&
    state.target?.id === target?.messageId && state.target.read === true && state.target.readProof === 'ax-explicit-read' &&
    typeof state.navigation === 'object' && state.navigation !== null;
}
function ownedReceipt(receipt) {
  return receipt?.running === true && receipt.launched === false && receipt.retainedWindow === true && receipt.creationOwned === true;
}

export async function setupMimestream(ctx, kind, { adapter = openMimestream } = {}) {
  prepareMimestream(ctx);
  const state = stateFor(ctx);
  if (!kinds.has(kind)) throw failure('MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED', true);
  if (adapter === openMimestream && ctx.ownerAway !== true) throw failure('MIMESTREAM_OWNER_AWAY_UNPROVED', true);
  ctx.signal?.throwIfAborted();
  ctx.cleanupSignal?.throwIfAborted();
  const diagnostic = { app: 'Mimestream', bundle: 'com.mimestream.Mimestream', actionTaken: false, cleanup: 'nothing created' };
  (ctx.fixtureDiagnostics ??= []).push(diagnostic);
  state.kind = kind; state.diagnostic = diagnostic;
  const lease = { app: 'Mimestream', bundle: 'com.mimestream.Mimestream', nonce: ctx.nonce, launched: false,
    async close() { if (state.stopped) return; await state.handles?.close?.(); },
    async dispose() { return state.handles?.dispose ? await state.handles.dispose() : true; } };
  state.lease = lease;
  (ctx.windowLeases ??= []).push(lease);
  (ctx.pendingAcquisitions ??= new Set()).add('mimestream');
  const attach = handles => {
    if (state.handles || ['snapshot', 'close', 'dispose'].some(key => typeof handles?.[key] !== 'function')) {
      throw failure('MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED');
    }
    state.handles = handles;
  };
  try {
    state.receipt = await adapter(ctx, kind, attach);
    if (Array.isArray(state.receipt?.labels)) state.labels = [...new Set([...state.labels, ...state.receipt.labels.filter(value => typeof value === 'string')])];
    diagnostic.actionTaken = state.receipt?.actionTaken !== false;
    diagnostic.cleanup = 'unconfirmed';
    if (!state.handles || !ownedReceipt(state.receipt)) throw failure('MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED');
    const { before, target, expected, labels, prompt } = state.receipt;
    if (!validSnapshot(before, ctx.nonce, target) || typeof expected !== 'string' || !expected.trim() ||
      !Array.isArray(labels) || labels.some(value => typeof value !== 'string') || typeof prompt !== 'string' ||
      (kind === 'thread' && (typeof target.threadId !== 'string' || typeof target.thirdMessageId !== 'string')) ||
      (kind === 'search' && typeof target.searchQuery !== 'string') ||
      (kind === 'scroll' && !Number.isFinite(before.navigation.scrollPosition))) throw failure('MIMESTREAM_BASELINE_UNPROVED');
    state.before = structuredClone(before); state.target = structuredClone(target);
    state.expected = expected; state.labels = [...new Set([...state.labels, ...labels])]; state.prompt = prompt;
    ctx.pendingAcquisitions.delete('mimestream');
  } catch (error) {
    const code = safeCode(error);
    if (code === 'MIMESTREAM_APP_DIALOG_STOP') state.stopped = true;
    diagnostic.failureCode = code;
    throw failure(code, error?.noMutation === true);
  }
}

export function promptMimestream(ctx) {
  const state = stateFor(ctx);
  if (!state?.before) throw failure('MIMESTREAM_BASELINE_UNAVAILABLE');
  return `Use Mimestream (${state.lease.bundle}) in its retained benchmark window. ${state.prompt} ` +
    'Only navigate folders and labels, open already-read messages or threads, scroll, and search. ' +
    'Never compose, reply, forward, archive, move, label, flag, mark read or unread, delete, or change settings. ' +
    'If sign-in, an account prompt, or a macOS permission prompt appears, stop immediately and do not answer it. ' +
    'Return JSON with exactly one answer field containing the requested text.';
}

export async function checkMimestream(ctx) {
  const state = stateFor(ctx);
  if (!state?.before || state.stopped || state.lease?.cleaned) return 'MIMESTREAM_BASELINE_UNAVAILABLE';
  let after;
  try { after = await state.handles.snapshot(); } catch { return 'MIMESTREAM_SNAPSHOT_UNPROVED'; }
  if (!validSnapshot(after, ctx.nonce, state.target)) return 'MIMESTREAM_SNAPSHOT_UNPROVED';
  if (after.fullList.unreadCount !== state.before.fullList.unreadCount || after.folder.messageCount !== state.before.folder.messageCount) {
    return 'MIMESTREAM_MAILBOX_CHANGED';
  }
  const nav = after.navigation, target = state.target;
  if (nav.folderId !== target.folderId || state.kind !== 'label' && nav.messageId !== target.messageId ||
    state.kind === 'thread' && (nav.threadId !== target.threadId || nav.thirdMessageId !== target.thirdMessageId || nav.threadMessagesRead !== true) ||
    state.kind === 'scroll' && !(Number.isFinite(nav.scrollPosition) && nav.scrollPosition >= 0.99 &&
      nav.scrollPosition > state.before.navigation.scrollPosition && nav.scrollRegion === 'message-body' && nav.scrollBottom === true) ||
    state.kind === 'search' && (nav.searchQuery !== target.searchQuery || nav.searchResultsBound !== true)) return 'MIMESTREAM_NAVIGATION_UNPROVED';
  let answer;
  try { answer = JSON.parse(ctx.answer); } catch { return 'MIMESTREAM_ANSWER_INVALID'; }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== 1 || typeof answer.answer !== 'string') return 'MIMESTREAM_ANSWER_INVALID';
  return answer.answer === state.expected || 'MIMESTREAM_ANSWER_MISMATCH';
}

export async function cleanupMimestream(ctx) {
  const state = stateFor(ctx), lease = state?.lease;
  if (!lease || lease.cleaned) return;
  let problem;
  if (state.helperLaunched && !state.receipt && state.nativeCleanupConfirmed !== true) problem = 'MIMESTREAM_CLEANUP_UNCONFIRMED';
  if ((!state.receipt || state.stopped) && state.diagnostic.actionTaken === true && state.diagnostic.cleanup === 'unconfirmed') {
    problem = 'MIMESTREAM_CLEANUP_UNCONFIRMED';
  }
  try {
    if (!state.stopped && state.receipt) {
      if (!ownedReceipt(state.receipt)) throw failure('MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED');
      await ctx.beforeFixtureCleanup?.();
      ctx.cleanupSignal?.throwIfAborted();
      await lease.close();
    }
  } catch { problem = !ownedReceipt(state.receipt) ? 'MIMESTREAM_WINDOW_OWNERSHIP_UNPROVED' : 'MIMESTREAM_CLEANUP_UNCONFIRMED'; }
  try { if (await lease.dispose() !== true) problem ??= 'MIMESTREAM_HELPER_UNCOLLECTED'; }
  catch { problem ??= 'MIMESTREAM_HELPER_UNCOLLECTED'; }
  if (problem) throw failure(problem);
  lease.cleaned = true;
  ctx.pendingAcquisitions?.delete('mimestream');
  state.diagnostic.cleanup = state.stopped ? 'dialog stop, helper collected' : state.receipt || state.diagnostic.actionTaken ? 'closed creation-owned window' : 'nothing created, helper collected';
  // Keep expected/label strings alive for the caller's post-cleanup privacy audit.
}

export async function mimestreamHelper(signal) {
  signal?.throwIfAborted();
  if (uncollected) throw failure('MIMESTREAM_HELPER_UNCOLLECTED');
  if (executable) return executable;
  compilation ??= (async () => {
    helperBank = mkdtempSync(join(tmpdir(), 'sleight-mimestream-helper-'));
    const path = join(helperBank, 'mimestream-fixture');
    const result = await runOwned('/usr/bin/xcrun', ['swiftc', '-module-cache-path', helperBank,
      fileURLToPath(new URL('./real-mimestream.swift', import.meta.url)), '-o', path], { signal, timeoutMs: 180000 });
    if (!result.groupClean) { uncollected = true; throw failure('MIMESTREAM_HELPER_UNCOLLECTED'); }
    if (result.exit?.code !== 0 || result.cancelled || result.timedOut || result.spawnError) {
      rmSync(helperBank, { recursive: true, force: true }); helperBank = undefined;
      throw Object.assign(failure('MIMESTREAM_COMPILATION_FAILED', true), { compileDiagnostic: result.stderr.replaceAll(homedir(), '~').trim() });
    }
    executable = path; return path;
  })();
  try { return await compilation; } finally { compilation = undefined; }
}

export async function openMimestream(ctx, kind, attach, { helper = mimestreamHelper, run = runOwned } = {}) {
  if (ctx.ownerAway !== true) throw failure('MIMESTREAM_OWNER_AWAY_UNPROVED', true);
  const control = join(ctx.dir, 'mimestream-control.json'), controller = new AbortController(), stages = new Map();
  const stage = id => { if (!stages.has(id)) stages.set(id, Promise.withResolvers()); return stages.get(id); };
  let response, buffered = '', counter = 0, stopped = false;
  attach({
    async snapshot() {
      ctx.signal?.throwIfAborted(); ctx.cleanupSignal?.throwIfAborted();
      const id = `snapshot-${++counter}`;
      writeFileSync(control, JSON.stringify({ id, command: 'snapshot' }), { mode: 0o600 });
      return (await waitStage(id)).snapshot;
    },
    async close() {
      if (stopped) return;
      ctx.cleanupSignal?.throwIfAborted();
      writeFileSync(control, JSON.stringify({ id: `close-${++counter}`, command: 'close' }), { mode: 0o600 });
      await waitStage('closed');
    },
    async dispose() {
      controller.abort();
      if (!response) return true;
      return (await response).groupClean === true;
    },
  });
  const command = await helper(ctx.signal);
  const nativeState = stateFor(ctx);
  nativeState.helperLaunched = true;
  nativeState.diagnostic.cleanup = 'unconfirmed';
  response = run(command, [JSON.stringify({ nonce: ctx.nonce, kind, control, ownerAway: true })], {
    signal: AbortSignal.any([controller.signal, ctx.cleanupSignal, ctx.signal].filter(Boolean)), timeoutMs: 600000,
    onStdout: chunk => {
      buffered += String(chunk);
      for (let newline; (newline = buffered.indexOf('\n')) >= 0;) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.stage === 'private-terms' && Array.isArray(event.labels)) {
          const state = stateFor(ctx);
          state.labels = [...new Set([...state.labels, ...event.labels.filter(value => typeof value === 'string')])];
        }
        if (event.stage === 'app-dialog') {
          stopped = true;
          const state = stateFor(ctx); state.stopped = true;
          const category = ['permission', 'signin', 'account', 'first-run', 'unrelated-modal'].includes(event.category) ? event.category : 'unrelated-modal';
          const dialog = { app: 'Mimestream', bundle: 'com.mimestream.Mimestream', category };
          state.diagnostic.appDialog = dialog;
          state.diagnostic.actionTaken ||= event.actionTaken === true;
          state.diagnostic.cleanup = 'unconfirmed';
          try { ctx.onAppDialog?.(dialog); } catch { /* The dialog still stops this helper. */ }
          controller.abort();
          stage('ready').reject(failure('MIMESTREAM_APP_DIALOG_STOP'));
        }
        if (event.stage === 'setup-failure') {
          const state = stateFor(ctx), diagnostic = state?.diagnostic;
          if (diagnostic) {
            diagnostic.actionTaken = event.actionTaken === true;
            diagnostic.cleanup = event.cleanup === 'closed creation-owned window' ? 'closed creation-owned window' : 'unconfirmed';
            state.nativeCleanupConfirmed = event.cleanup === 'closed creation-owned window';
          }
        }
        if (event.stage === 'untouched' && event.actionTaken === false) {
          const state = stateFor(ctx);
          state.nativeCleanupConfirmed = true;
          state.diagnostic.actionTaken = false;
          state.diagnostic.cleanup = 'nothing created';
        }
        stage(event.id ?? event.stage).resolve(event);
      }
    },
  });
  async function waitStage(id) {
    let timer;
    try {
      return await Promise.race([stage(id).promise, response.then(result => {
        const match = /^MIMESTREAM_[A-Z_]+$/.exec(result.stderr.trim());
        throw failure(stopped ? 'MIMESTREAM_APP_DIALOG_STOP' : match && codes.has(match[0]) ? match[0] : 'MIMESTREAM_SETUP_FAILED');
      }), new Promise((_, reject) => { timer = setTimeout(() => reject(failure('MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED')), 40000); })]);
    } finally { clearTimeout(timer); }
  }
  return (await waitStage('ready')).receipt;
}
