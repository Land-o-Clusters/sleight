import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwned } from './preapproved-process.mjs';

const privateState = new WeakMap();
export const CHAT_APPS = {
  slack: { id: 'slack-read', app: 'Slack', bundle: 'com.tinyspeck.slackmacgap' },
  discord: { id: 'discord-read', app: 'Discord', bundle: 'com.hnc.Discord' },
  whatsapp: { id: 'whatsapp-read', app: 'WhatsApp', bundle: 'net.whatsapp.WhatsApp' },
};
const codes = new Set(['CHAT_NATIVE_UNAVAILABLE_IN_TESTS', 'CHAT_OWNER_PRESENT_UNPROVED', 'CHAT_NOT_RUNNING', 'CHAT_LAUNCH_FAILED',
  'CHAT_BASELINE_UNPROVED', 'CHAT_CONVERSATION_UNPROVED', 'CHAT_MESSAGE_LIST_UNPROVED', 'CHAT_NEWEST_UNPROVED',
  'CHAT_AUTHOR_UNPROVED', 'CHAT_WINDOW_OWNERSHIP_UNPROVED', 'CHAT_PROCESS_AMBIGUOUS', 'CHAT_PROCESS_CHANGED',
  'CHAT_ACCESSIBILITY_UNAVAILABLE', 'CHAT_AX_UNAVAILABLE', 'CHAT_AX_LIMIT', 'CHAT_AX_RESTORE_UNCONFIRMED',
  'CHAT_APP_DIALOG_STOP', 'CHAT_NATIVE_TIMEOUT', 'CHAT_HELPER_UNCOLLECTED', 'CHAT_COMPILATION_FAILED',
  'CHAT_CLEANUP_UNCONFIRMED', 'CHAT_SETUP_FAILED']);
const failure = (code, noMutation = false) => Object.assign(new Error(code), { code, noMutation });
const safeCode = error => codes.has(error?.code) ? error.code : 'CHAT_SETUP_FAILED';
const dialogCategories = new Set(['signin', 'update', 'permission', 'unrelated-modal']);
const conversationID = /^(?:conversation|channel|chat)-[\w.-]+$/;
const messageID = /^(?:message|message_container)-\d+(?:\.\d+)?$|^chat-messages-\d+-\d+$/;
const authorID = /^(?:message-username|message-author|sender)-\d+$/;
const listIDs = new Set(['chat-messages', 'message-list', 'messages']);
const role = node => String(node?.role ?? '').replace(/^AX/, '').replaceAll(' ', '').toLowerCase();
const title = node => typeof node?.title === 'string' && node.title.trim().length > 0 && node.title.length <= 1024 ? node.title.trim() : null;

export function prepareChat(ctx) {
  if (!ctx.chat || !privateState.has(ctx.chat)) {
    ctx.chat = {};
    privateState.set(ctx.chat, { expected: null, terms: [], target: null });
  }
  return ctx.chat;
}
const stateFor = ctx => privateState.get(ctx.chat);
export const expectedChat = ctx => stateFor(ctx)?.expected ?? null;
export const labelsChat = ctx => [...(stateFor(ctx)?.terms ?? [])];

function walk(nodes, depth = 0, result = []) {
  if (!Array.isArray(nodes) || depth > 32 || result.length + nodes.length > 6000) throw failure('CHAT_AX_LIMIT');
  for (const node of nodes) {
    if (result.length >= 6000) throw failure('CHAT_AX_LIMIT');
    if (!node || typeof node !== 'object') throw failure('CHAT_BASELINE_UNPROVED');
    result.push(node);
    if (node.children !== undefined) walk(node.children, depth + 1, result);
  }
  return result;
}
function baseline(nodes) {
  const all = walk(nodes);
  const selected = all.filter(node => node.selected === true && conversationID.test(node.identifier) &&
    ['row', 'link', 'tab', 'button'].includes(role(node)) && title(node));
  if (selected.length !== 1) throw failure('CHAT_CONVERSATION_UNPROVED');
  const lists = all.filter(node => listIDs.has(node.identifier) && ['list', 'group', 'outline'].includes(role(node)));
  if (lists.length !== 1) throw failure('CHAT_MESSAGE_LIST_UNPROVED');
  const list = lists[0], scroll = list.scroll;
  if (!Number.isFinite(scroll?.value) || !Number.isFinite(scroll?.min) || !Number.isFinite(scroll?.max) ||
    scroll.max <= scroll.min || scroll.value !== scroll.max) throw failure('CHAT_NEWEST_UNPROVED');
  const messages = walk(list.children ?? []).filter(node => messageID.test(node.identifier));
  if (!messages.length) throw failure('CHAT_NEWEST_UNPROVED');
  let previous, family;
  for (const message of messages) {
    if (walk(message.children ?? []).some(node => messageID.test(node.identifier))) throw failure('CHAT_NEWEST_UNPROVED');
    const parts = /^(.*)-(\d+)(?:\.(\d{1,9}))?$/.exec(message.identifier);
    if (!parts || family !== undefined && family !== parts[1]) throw failure('CHAT_NEWEST_UNPROVED');
    family = parts[1];
    const key = BigInt(parts[2]) * 1000000000n + BigInt((parts[3] ?? '').padEnd(9, '0'));
    if (previous !== undefined && key <= previous) throw failure('CHAT_NEWEST_UNPROVED');
    previous = key;
  }
  const authors = walk(messages.at(-1).children ?? []).filter(node => authorID.test(node.identifier) &&
    ['statictext', 'button', 'link'].includes(role(node)) && title(node));
  if (authors.length !== 1) throw failure('CHAT_AUTHOR_UNPROVED');
  return { target: title(selected[0]), author: title(authors[0]) };
}

// Generic static-text titles can be message bodies. Only explicit author controls qualify.
export function observationFromAX(nodes) {
  try { return baseline(nodes); } catch { return null; }
}
function publicAX(value) {
  const result = { roles: {}, accessibility: {} };
  for (const key of ['nodeCount', 'beforeNodeCount']) if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = value[key];
  for (const [name, count] of Object.entries(value?.roles ?? {})) {
    if (/^AX[A-Za-z]{1,48}$/.test(name) && Number.isSafeInteger(count) && count >= 0) result.roles[name] = count;
  }
  for (const name of ['AXManualAccessibility', 'AXEnhancedUserInterface']) {
    const entry = value?.accessibility?.[name];
    if (entry) result.accessibility[name] = {
      set: ['enabled', 'already-enabled', 'unsupported', 'unreadable', 'refused'].includes(entry.set) ? entry.set : 'unreadable',
      restored: entry.restored === true,
    };
  }
  return result;
}
const frontmost = value => value === null || typeof value === 'string' && /^[A-Za-z0-9.-]{1,200}$/.test(value) ? value : null;
function processes(table) {
  if (!Array.isArray(table?.processes) || table.processes.length > 1) throw failure('CHAT_PROCESS_AMBIGUOUS');
  if (table.processes.some(p => !Number.isSafeInteger(p?.pid) || p.pid <= 0 || !Number.isFinite(p.launchedAt))) throw failure('CHAT_PROCESS_CHANGED');
  return table.processes;
}

export async function setupChat(ctx, kind, { adapter = openChat, ...options } = {}) {
  prepareChat(ctx);
  const state = stateFor(ctx);
  const spec = CHAT_APPS[kind];
  if (!spec) throw failure('CHAT_SETUP_FAILED', true);
  if (adapter === openChat && ctx.ownerPresent !== true) throw failure('CHAT_OWNER_PRESENT_UNPROVED', true);
  ctx.signal?.throwIfAborted(); ctx.cleanupSignal?.throwIfAborted();
  state.expected = null; state.terms = []; state.target = null;
  const diagnostic = { app: spec.app, bundle: spec.bundle, launched: false, actionTaken: false, cleanup: 'nothing created' };
  (ctx.fixtureDiagnostics ??= []).push(diagnostic);
  Object.assign(state, { kind, spec, diagnostic, native: options.native ?? chatNative, identity: null,
    launchAttempted: false, axRestoreUnconfirmed: false });
  const lease = { app: spec.app, bundle: spec.bundle, launched: false, running: true,
    async close() {}, async dispose() { return !state.uncollected; },
    async quit() {
      if (!lease.launched || diagnostic.appQuit === true) return;
      diagnostic.cleanup = 'unconfirmed';
      try {
        await ctx.beforeFixtureCleanup?.(); ctx.cleanupSignal?.throwIfAborted();
        if (!state.identity || state.uncollected) throw failure('CHAT_CLEANUP_UNCONFIRMED');
        const result = await state.native(ctx, kind, 'quit', state.identity);
        if (result?.quit !== true) throw failure('CHAT_CLEANUP_UNCONFIRMED');
        diagnostic.appQuit = true; diagnostic.cleanup = 'quit launched app';
      } catch { throw failure('CHAT_CLEANUP_UNCONFIRMED'); }
    },
  };
  state.lease = lease;
  (ctx.windowLeases ??= []).push(lease);
  try {
    const receipt = await adapter(ctx, kind, options);
    if (receipt?.launched === true && !lease.launched) throw failure('CHAT_WINDOW_OWNERSHIP_UNPROVED');
    if (receipt?.running !== true || typeof receipt.expected !== 'string' || !receipt.expected.trim()
      || typeof receipt.target !== 'string' || !receipt.target.trim()
      || typeof receipt.prompt !== 'string' || !Array.isArray(receipt.terms)
      || receipt.terms.some(value => typeof value !== 'string')) throw failure('CHAT_BASELINE_UNPROVED');
    state.expected = receipt.expected;
    state.target = receipt.target;
    state.prompt = receipt.prompt;
    state.terms = [...new Set(receipt.terms.filter(Boolean))];
    diagnostic.cleanup = lease.launched ? 'unconfirmed' : 'unchanged running app';
  } catch (error) {
    diagnostic.failureCode = safeCode(error);
    throw failure(diagnostic.failureCode, !state.launchAttempted && !diagnostic.actionTaken);
  }
}

export function promptChat(ctx) {
  const state = stateFor(ctx);
  if (!state?.expected || !state.spec) throw failure('CHAT_BASELINE_UNPROVED');
  return `Using computer use in the background, work only in ${state.spec.app}. ${state.prompt} ` +
    'Open that conversation if it is not already visible. Report only the display name of the newest message\'s author. ' +
    'Never send, compose, reply, react, forward, delete, archive, pin, mark unread, or change settings. Do not type into the message field. ' +
    'If a sign-in, update, permission or first-run dialog appears, stop and do not answer it. ' +
    'Return JSON with exactly one answer field containing that author name.';
}

export function checkChat(ctx) {
  const state = stateFor(ctx);
  if (!state?.expected) return 'CHAT_BASELINE_UNPROVED';
  let answer;
  try { answer = JSON.parse(ctx.answer); } catch { return 'CHAT_ANSWER_INVALID'; }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== 1
    || typeof answer.answer !== 'string') return 'CHAT_ANSWER_INVALID';
  return answer.answer === state.expected || 'CHAT_ANSWER_MISMATCH';
}

export async function cleanupChat(ctx) {
  const state = stateFor(ctx), lease = state?.lease;
  if (!lease || lease.cleaned) return;
  if (await lease.dispose() !== true) throw failure('CHAT_HELPER_UNCOLLECTED');
  if (state.launchAttempted && !state.identity) throw failure('CHAT_CLEANUP_UNCONFIRMED');
  await lease.quit();
  if (state.axRestoreUnconfirmed && !state.diagnostic.appQuit) throw failure('CHAT_AX_RESTORE_UNCONFIRMED');
  lease.cleaned = true;
}

export async function openChat(ctx, kind, { native = chatNative, open, launch } = {}) {
  if (ctx.ownerPresent !== true) throw failure('CHAT_OWNER_PRESENT_UNPROVED', true);
  const state = stateFor(ctx), spec = CHAT_APPS[kind];
  if (!state?.lease || !spec) throw failure('CHAT_SETUP_FAILED', true);
  const { diagnostic, lease } = state;
  const before = await native(ctx, kind, 'table');
  if (before.trusted === false) throw failure('CHAT_ACCESSIBILITY_UNAVAILABLE');
  const initial = processes(before);
  lease.running = initial.length === 1;
  diagnostic.frontmostBefore = frontmost(before.frontmost);
  state.identity = initial[0] ?? null;
  if (!initial.length) {
    state.launchAttempted = true; diagnostic.actionTaken = true; diagnostic.cleanup = 'unconfirmed';
    let launchFailed = false;
    let after;
    if (launch || !open) {
      after = await (launch ? launch() : native(ctx, kind, 'launch'));
      if (typeof after?.launched !== 'boolean') throw failure('CHAT_WINDOW_OWNERSHIP_UNPROVED');
      if (!after.launched && after.processes?.length === 1) {
        // The native launch boundary found an app opened during preparation.
        state.launchAttempted = false; diagnostic.actionTaken = after.openIssued === true; diagnostic.cleanup = 'unchanged running app';
        lease.running = true;
      }
      launchFailed = after.failureCode !== undefined;
    } else {
      // Injected process-table adapters exercise open failures without host access.
      try { await open(spec.bundle); } catch { launchFailed = true; }
      after = await native(ctx, kind, 'table');
    }
    diagnostic.frontmostAfter = frontmost(after.frontmost);
    diagnostic.frontmostChanged = diagnostic.frontmostBefore === null || diagnostic.frontmostAfter === null ? null :
      diagnostic.frontmostBefore !== diagnostic.frontmostAfter;
    const started = processes(after);
    if (started.length === 1) {
      state.identity = started[0]; lease.launched = after.launched ?? state.launchAttempted; diagnostic.launched = lease.launched;
    }
    if (launchFailed || !state.identity) throw failure('CHAT_LAUNCH_FAILED');
  } else {
    diagnostic.frontmostAfter = diagnostic.frontmostBefore; diagnostic.frontmostChanged = false;
  }
  ctx.signal?.throwIfAborted(); ctx.cleanupSignal?.throwIfAborted();
  let observed;
  try { observed = await native(ctx, kind, 'observe', state.identity); }
  catch (error) {
    // A collected child without its receipt cannot prove it restored the AX switches.
    state.axRestoreUnconfirmed = true; diagnostic.actionTaken = true; diagnostic.cleanup = 'unconfirmed';
    throw error;
  }
  diagnostic.ax = publicAX(observed?.diagnostics);
  diagnostic.dialogs = [...new Set((observed?.dialogs ?? []).map(value => dialogCategories.has(value) ? value : 'unrelated-modal'))];
  if (observed?.failureCode === 'CHAT_AX_RESTORE_UNCONFIRMED') {
    state.axRestoreUnconfirmed = true; diagnostic.actionTaken = true; diagnostic.cleanup = 'unconfirmed';
  }
  if (diagnostic.dialogs.length) throw failure('CHAT_APP_DIALOG_STOP');
  if (observed?.failureCode) throw failure(codes.has(observed.failureCode) ? observed.failureCode : 'CHAT_AX_UNAVAILABLE');
  ctx.signal?.throwIfAborted(); ctx.cleanupSignal?.throwIfAborted();
  const parsed = baseline(observed?.nodes);
  return {
    running: true, launched: lease.launched, expected: parsed.author, target: parsed.target,
    terms: [parsed.target, parsed.author], actionTaken: diagnostic.actionTaken,
    prompt: `Open the conversation named ${JSON.stringify(parsed.target)} and read only its newest message.`,
  };
}

let executable, compilation, helperBank, uncollected = false;
process.once('exit', () => { if (helperBank && !uncollected) rmSync(helperBank, { recursive: true, force: true }); });
async function chatHelper(signal) {
  if (uncollected) throw failure('CHAT_HELPER_UNCOLLECTED');
  if (executable) return executable;
  compilation ??= (async () => {
    helperBank = mkdtempSync(join(tmpdir(), 'sleight-chat-helper-'));
    const path = join(helperBank, 'chat-observer');
    const result = await runOwned('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(helperBank, 'modules'),
      fileURLToPath(new URL('./real-chat.swift', import.meta.url)), '-o', path], { signal, timeoutMs: 180000 });
    if (!result.groupClean) { uncollected = true; throw failure('CHAT_HELPER_UNCOLLECTED'); }
    if (result.exit?.code !== 0 || result.cancelled || result.timedOut || result.spawnError) {
      rmSync(helperBank, { recursive: true, force: true }); helperBank = undefined;
      throw failure('CHAT_COMPILATION_FAILED');
    }
    executable = path; return path;
  })();
  try { return await compilation; } finally { compilation = undefined; }
}
export async function chatNative(ctx, kind, operation, identity) {
  // Never reach the owner's real chat apps from a test: one offline test launched Slack (2026-10-11).
  if (process.env.NODE_TEST_CONTEXT) throw failure('CHAT_NATIVE_UNAVAILABLE_IN_TESTS', true);
  const signal = operation === 'quit' ? ctx.cleanupSignal : ctx.signal;
  signal?.throwIfAborted();
  try {
    const command = await chatHelper(signal);
    const result = await runOwned(command, [JSON.stringify({ ownerPresent: ctx.ownerPresent === true,
      kind, operation, identity, waitForLaunch: operation === 'table' && stateFor(ctx)?.launchAttempted === true })], {
      // An in-flight AX observation finishes restoration before cancellation is honored.
      signal: operation === 'observe' ? undefined : signal, timeoutMs: 45000 });
    if (!result.groupClean) { uncollected = true; stateFor(ctx).uncollected = true; throw failure('CHAT_HELPER_UNCOLLECTED'); }
    if (result.timedOut) throw failure('CHAT_NATIVE_TIMEOUT');
    if (result.exit?.code !== 0 || result.cancelled || result.spawnError) {
      throw failure(codes.has(result.stderr.trim()) ? result.stderr.trim() : 'CHAT_SETUP_FAILED');
    }
    try { return JSON.parse(result.stdout); } catch { throw failure('CHAT_SETUP_FAILED'); }
  } catch (error) {
    if (error?.code === 'CHAT_HELPER_UNCOLLECTED') stateFor(ctx).uncollected = true;
    throw failure(safeCode(error));
  }
}
