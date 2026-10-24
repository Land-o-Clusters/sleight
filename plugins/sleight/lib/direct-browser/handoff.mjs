import { randomUUID } from 'node:crypto';
import { trustedRead } from './trusted-dom.mjs';
import { assertEndpointRead } from './endpoint-guard.mjs';

export const HANDOFF_WAIT_MS = 240000;
export const handoffMessages = Object.freeze({
  pending: 'Handoff pending; the user must finish in the tab.',
  cancelled: 'Handoff not resumed; tabs kept for the user.',
  resumed: 'Continue received; fresh untrusted read below. Sign-in is unverified.',
  secrets: 'Secret fields remain; handoff not resumed; tabs kept.',
  cleanup: 'Handoff cleanup unproved; tabs kept.',
});

// Runs in the isolated utility world. Return boolean evidence only, never field
// values. Even hidden credential controls must be gone before snapshot's DOM
// reader runs. A premature Continue leaves the user in charge of the tab.
function handoffControlState(root, _arg, read) {
  const pending = [read(root, 'ownerDocument')];
  const sensitive = /password|passcode|secret|one.?time|\botp\b|(?:verification|security|auth(?:entication)?|login|sign.?in)[\s_-]*(?:code|pin)|(?:2fa|mfa)/i;
  const auth = /\b(?:log[\s_-]*in|sign[\s_-]*in|authenticate|authentication|verify[\s_-]*(?:identity|account))\b/i;
  const fields = [];
  let authForm = false;
  while (pending.length) for (const node of read(pending.pop(), 'querySelectorAll')('*')) {
    const shadow = read(node, 'shadowRoot'); if (shadow) pending.push(shadow);
    const tag = read(node, 'localName');
    const attr = read(node, 'getAttribute');
    if (tag === 'form' && read(node, 'checkVisibility')({ checkVisibilityCSS: true }) &&
        auth.test(['name', 'id', 'action', 'aria-label'].map(name => attr(name) ?? '').join(' '))) authForm = true;
    if ((tag === 'button' || tag === 'input' && ['submit', 'button'].includes(attr('type'))) &&
        read(node, 'form') && read(node, 'checkVisibility')({ checkVisibilityCSS: true }) &&
        auth.test(tag === 'input' ? attr('value') ?? '' : read(node, 'textContent') ?? '')) authForm = true;
    if (!['input', 'textarea'].includes(tag) && !['textbox', 'spinbutton'].includes(attr('role')) && attr('contenteditable') === null) continue;
    const hints = ['type', 'name', 'id', 'placeholder', 'autocomplete', 'aria-label'].map(name => read(node, 'getAttribute')(name) ?? '');
    for (const label of read(node, 'labels') ?? []) hints.push(read(label, 'textContent') ?? '');
    const hint = hints.join(' '), benignCode = /promo|coupon|postal|zip|discount|voucher|referral|product|area.?code|country.?code/i.test(hint);
    if (sensitive.test(hint) || /\b(?:code|pin)\b/i.test(hint) && !benignCode) return { secret: true, auth: true, filled: false };
    if (/username|current-password|new-password|one-time-code/i.test(attr('autocomplete') ?? '') &&
        read(node, 'checkVisibility')({ checkVisibilityCSS: true })) authForm = true;
    if (tag === 'input' && ['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'reset'].includes((attr('type') ?? '').toLowerCase())) continue;
    fields.push(node);
  }
  // Values stay inside this synchronous utility-world boolean check. Unnamed
  // visible fields on a remaining auth form must not reach the snapshot reader.
  for (const node of fields) {
    if (read(node, 'checkVisibility')({ checkVisibilityCSS: true }) &&
        String(read(node, 'value') ?? read(node, 'textContent') ?? '').length > 0) return { secret: false, auth: authForm, filled: true };
  }
  return { secret: false, auth: authForm, filled: false };
}
export async function handoffReadReady(page) {
  await assertEndpointRead(page);
  let auth = false, filled = false;
  for (const frame of page.frames()) {
    const root = await frame.locator(':root').elementHandle({ timeout: 1000 });
    if (!root) return false;
    try {
      const state = await trustedRead(root, handoffControlState);
      if (!state || typeof state.auth !== 'boolean' || typeof state.filled !== 'boolean' || state.secret !== false) return false;
      auth ||= state.auth; filled ||= state.filled;
    }
    finally { await root.dispose(); }
  }
  return !(auth && filled);
}

// Only the nonce-bound native host can supply an event. Nothing reads the page
// during this wait, and Continue grants a fresh read, never a submit or payment.
export function createHandoffWaiter({ ui, current, session, turn, timeoutMs = HANDOFF_WAIT_MS } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > HANDOFF_WAIT_MS) throw Error('INVALID_HANDOFF_WAIT');
  const pending = new Set();
  let disposed = false;
  const active = () => { try { return !disposed && current() === true; } catch { return false; } };
  return Object.freeze({
    wait(tab, ready = async () => true, onDeadline = () => {}) {
      if (!active() || typeof ui?.present !== 'function' || typeof ui?.authenticate !== 'function') return Promise.resolve(false);
      return new Promise(resolve => {
        const deadline = Date.now() + timeoutMs;
        onDeadline(deadline, timeoutMs);
        let settled = false, id;
        const dismiss = () => { if (id) { try { ui.dismiss?.(id); } catch {} id = undefined; } };
        const finish = value => {
          if (settled) return;
          settled = true; dismiss(); clearTimeout(timer); clearInterval(watch); pending.delete(finish); resolve(value);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        const watch = setInterval(() => { if (!active()) finish(false); }, 100);
        pending.add(finish);
        const present = () => { try {
          if (settled) return;
          if (!active() || Date.now() >= deadline) return finish(false);
          id = randomUUID();
          const cardId = id;
          const target = typeof tab === 'string' ? { tab } : { app: tab.app };
          ui.present(id, { kind: 'handoff', session, turn, ...target }, ['continue', 'cancel'], async event => {
            try {
              if (settled || event?.id !== cardId || cardId !== id || !ui.authenticate(event)) return;
              if (!active() || Date.now() >= deadline || event.choice !== 'continue') return finish(false);
              dismiss();
              const resumed = await ready();
              if (settled) return;
              if (resumed) finish(active() && Date.now() < deadline);
              else present();
            } catch { finish(false); }
          }, { deadline });
        } catch { finish(false); } };
        present();
      });
    },
    dispose() { disposed = true; for (const finish of pending) finish(false); },
  });
}
