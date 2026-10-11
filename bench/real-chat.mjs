import { appRunning } from './real-electron.mjs';

const privateState = new WeakMap();
export const CHAT_APPS = {
  slack: { id: 'slack-read', app: 'Slack', bundle: 'com.tinyspeck.slackmacgap' },
  discord: { id: 'discord-read', app: 'Discord', bundle: 'com.hnc.Discord' },
  whatsapp: { id: 'whatsapp-read', app: 'WhatsApp', bundle: 'net.whatsapp.WhatsApp' },
};
const kinds = new Set(Object.keys(CHAT_APPS));
const codes = new Set(['CHAT_OWNER_PRESENT_UNPROVED', 'CHAT_NOT_RUNNING', 'CHAT_LAUNCH_REFUSED',
  'CHAT_BASELINE_UNPROVED', 'CHAT_WINDOW_OWNERSHIP_UNPROVED', 'CHAT_SETUP_FAILED']);
const failure = (code, noMutation = false) => Object.assign(new Error(code), { code, noMutation });
const safeCode = error => codes.has(error?.code) ? error.code : 'CHAT_SETUP_FAILED';

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

// Independent observation from an AX node list. Titles only: no message bodies.
export function observationFromAX(nodes) {
  if (!Array.isArray(nodes)) return null;
  const selected = nodes.find(node => node?.selected === true && typeof node.title === 'string' && node.title.trim());
  const authors = nodes.filter(node => node?.role === 'static text' && typeof node.title === 'string' && node.title.trim())
    .map(node => node.title.trim()).filter(title => title !== selected?.title);
  const author = authors.at(-1);
  if (!selected?.title || !author) return null;
  return { target: selected.title, author };
}

export async function setupChat(ctx, kind, { adapter = openChat, running = appRunning } = {}) {
  prepareChat(ctx);
  const state = stateFor(ctx);
  const spec = CHAT_APPS[kind];
  if (!spec || !kinds.has(kind)) throw failure('CHAT_SETUP_FAILED', true);
  if (adapter === openChat && ctx.ownerPresent !== true) throw failure('CHAT_OWNER_PRESENT_UNPROVED', true);
  ctx.signal?.throwIfAborted();
  const diagnostic = { app: spec.app, bundle: spec.bundle, actionTaken: false, cleanup: 'nothing created' };
  (ctx.fixtureDiagnostics ??= []).push(diagnostic);
  state.kind = kind; state.spec = spec; state.diagnostic = diagnostic;
  const lease = { app: spec.app, bundle: spec.bundle, launched: false, running: true,
    async close() {}, async dispose() { return true; }, async quit() {} };
  state.lease = lease;
  (ctx.windowLeases ??= []).push(lease);
  try {
    if (adapter === openChat && !await running(spec.bundle)) throw failure('CHAT_NOT_RUNNING', true);
    const receipt = adapter === openChat ? await openChat(ctx, kind, { running }) : await adapter(ctx, kind);
    if (receipt?.launched === true) throw failure('CHAT_LAUNCH_REFUSED', true);
    if (receipt?.running !== true || typeof receipt.expected !== 'string' || !receipt.expected.trim()
      || typeof receipt.target !== 'string' || !receipt.target.trim()
      || typeof receipt.prompt !== 'string' || !Array.isArray(receipt.terms)
      || receipt.terms.some(value => typeof value !== 'string')) throw failure('CHAT_BASELINE_UNPROVED');
    state.expected = receipt.expected;
    state.target = receipt.target;
    state.prompt = receipt.prompt;
    state.terms = [...new Set(receipt.terms.filter(Boolean))];
    diagnostic.actionTaken = receipt.actionTaken === true;
    diagnostic.cleanup = 'unchanged running app';
  } catch (error) {
    throw failure(safeCode(error), error?.noMutation === true);
  }
}

export function promptChat(ctx) {
  const state = stateFor(ctx);
  if (!state?.expected || !state.spec) throw failure('CHAT_BASELINE_UNPROVED');
  return `Using computer use in the background, work only in ${state.spec.app}. ${state.prompt} ` +
    'Open that conversation if it is not already visible. Report only the display name of the newest message\'s author. ' +
    'Never send, compose, reply, react, forward, delete, archive, pin, mark unread, or change settings. Do not type into the message field. ' +
    'If a sign-in, permission or first-run dialog appears, stop and do not answer it. ' +
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
  const lease = stateFor(ctx)?.lease;
  if (!lease || lease.cleaned) return;
  if (await lease.dispose() !== true) throw failure('CHAT_SETUP_FAILED');
  lease.cleaned = true;
}

export async function openChat(ctx, kind, { running = appRunning, observe } = {}) {
  const spec = CHAT_APPS[kind];
  if (!await running(spec.bundle)) throw failure('CHAT_NOT_RUNNING', true);
  const observed = observe ? await observe(ctx, kind) : null;
  const parsed = observed?.target ? observed : observationFromAX(observed?.nodes);
  if (!parsed?.target || !parsed?.author) throw failure('CHAT_BASELINE_UNPROVED', true);
  return {
    running: true, launched: false, expected: parsed.author, target: parsed.target,
    terms: [parsed.target, parsed.author], actionTaken: false,
    prompt: `Open the conversation named ${JSON.stringify(parsed.target)} and read only its newest message.`,
  };
}
