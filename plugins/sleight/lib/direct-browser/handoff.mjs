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

// Runs in the isolated utility world. Return a boolean only, never field
// values. Even hidden credential controls must be gone before snapshot's DOM
// reader runs. A premature Continue leaves the user in charge of the tab.
function secretControlsGone(root, _arg, read) {
  const pending = [read(root, 'ownerDocument')];
  const sensitive = /password|passcode|secret|one.?time|\botp\b|\bpin\b|\bcode\b|verification.?code|security.?code|auth(?:entication)?.?code/i;
  while (pending.length) for (const node of read(pending.pop(), 'querySelectorAll')('*')) {
    const shadow = read(node, 'shadowRoot'); if (shadow) pending.push(shadow);
    const tag = read(node, 'localName');
    if (!['input', 'textarea'].includes(tag) && !['textbox', 'spinbutton'].includes(read(node, 'getAttribute')('role'))) continue;
    const hints = ['type', 'name', 'id', 'placeholder', 'autocomplete', 'aria-label'].map(name => read(node, 'getAttribute')(name) ?? '');
    for (const label of read(node, 'labels') ?? []) hints.push(read(label, 'textContent') ?? '');
    if (sensitive.test(hints.join(' '))) return false;
  }
  return true;
}
export async function handoffReadReady(page) {
  await assertEndpointRead(page);
  for (const frame of page.frames()) {
    const root = await frame.locator(':root').elementHandle({ timeout: 1000 });
    if (!root) return false;
    try { if (await trustedRead(root, secretControlsGone) !== true) return false; }
    finally { await root.dispose(); }
  }
  return true;
}

// Only the nonce-bound native host can supply an event. Nothing reads the page
// during this wait, and Continue grants a fresh read, never a submit or payment.
export function createHandoffWaiter({ ui, current, session, turn, timeoutMs = HANDOFF_WAIT_MS } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > HANDOFF_WAIT_MS) throw Error('INVALID_HANDOFF_WAIT');
  const pending = new Set();
  let disposed = false;
  const active = () => { try { return !disposed && current() === true; } catch { return false; } };
  return Object.freeze({
    wait(tab) {
      if (!active() || typeof ui?.present !== 'function' || typeof ui?.authenticate !== 'function') return Promise.resolve(false);
      return new Promise(resolve => {
        const id = randomUUID(), deadline = Date.now() + timeoutMs;
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true; clearTimeout(timer); clearInterval(watch); pending.delete(finish); resolve(value);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        const watch = setInterval(() => { if (!active()) finish(false); }, 100);
        pending.add(finish);
        try {
          ui.present(id, { kind: 'handoff', session, turn, tab }, ['continue', 'cancel'], event => {
            try {
              if (settled || event?.id !== id || !ui.authenticate(event)) return;
              finish(active() && Date.now() < deadline && event.choice === 'continue');
            } catch { finish(false); }
          }, { deadline });
        } catch { finish(false); }
      });
    },
    dispose() { disposed = true; for (const finish of pending) finish(false); },
  });
}
