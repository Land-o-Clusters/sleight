import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeLabel } from './direct-browser/consent-ui.mjs';

// AppKit renders plain text. Escape directional controls and bound every untrusted visible field in UTF-8 bytes.
function cardText(value) {
  const text = String(value).replace(/[\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16)}`);
  return Buffer.byteLength(text) <= 2048 ? text
    : Buffer.from(text).subarray(0, 2020).toString('utf8').replace(/\uFFFD$/, '') + '\n[request truncated]';
}

// sleight's own payment card for the engine-path payment gate (payment-gate.mjs): the consent host's operation sheet, the one
// turbo's payment confirmations use (direct-browser/consent-ui.mjs and host.mjs). LAWS: trusted confirmations use sleight's own
// window, outside the page. Only the person's click in that window answers it: the host's reply carries the channel's nonce and
// only an event the channel authenticates counts, so neither the page nor a tool can answer it.
//
// ask({ session, site, shown, control }) resolves 'once' (Allow once), 'cancel' (Cancel, closed or timed out) or undefined when
// no card can be shown (no helper build, no window server, the host lost). open() gives the channel or undefined; tests pass one.
export function createPaymentCard({ open = openConsentHost, prepare = open === openConsentHost ? prepareConsentHost : undefined,
  now = Date.now, timeoutMs = 120000, prepareTimeoutMs = 20000, presentation, requestContext,
  onStatus, clock = { setTimeout, clearTimeout } } = {}) {
  let channel, building, prepared, closing, closed = false;
  const controller = new AbortController(), requests = new Set();
  // This promise owns only compilation. Request expiry never turns its eventual
  // completion into permission to launch a host or present an old request.
  const warm = () => {
    if (closed) return Promise.resolve();
    if (!prepare) return Promise.resolve({ status: 'ready' });
    return building ??= Promise.resolve().then(() => {
      if (!closed) return prepare({ signal: controller.signal });
    }).then(value => {
      if (!closed && value?.status === 'ready') prepared = value;
      else building = undefined;
      return prepared;
    }, () => { building = undefined; });
  };
  // A host that exits or never starts leaves no channel, and the next payment opens one again.
  // A lost host is also closed, so a late answer doesn't leave one running beside the next (review F15).
  const forget = () => { const old = channel; channel = undefined; old?.then(ui => ui?.close?.(), () => {}); };
  const connect = (built, current) => channel ??= Promise.resolve().then(() => {
    if (current()) return open({ prepared: built, onLoss: forget, isCurrent: current });
  }).then(value => {
    if (!current()) { value?.close?.(); channel = undefined; return; }
    if (!value) { channel = undefined; return; }
    return value;
  }, () => { channel = undefined; });
  // This layer has no trusted logical request identity. Every ask gets a separate decision, even with equal terms.
  // The relay joins repeated pending engine request IDs; the socket bridge joins retries of its active call.
  return {
    ask: show,
    prepare: warm,
    close() {
      return closing ??= (async () => {
        closed = true;
        controller.abort();
        for (const request of requests) request.cancel();
        // prepareNativeHelpers settles only after its compiler closes, retaining
        // its source bank and build lock until then.
        const build = building, host = channel;
        const ui = await host?.catch(() => undefined);
        channel = undefined;
        await ui?.close?.();
        await build;
      })();
    },
  };
  async function show({ session, site, shown, control, request, scoped, app, presentation: cardPresentation }) {
    if (closed) return;
    const context = requestContext?.();
    if (requestContext && (!context || !Number.isFinite(context.deadline))) return;
    const prepareDeadline = Math.min(now() + prepareTimeoutMs,
      (context?.deadline ?? Infinity) - timeoutMs - 5000);
    if (prepareDeadline <= now() || context?.signal?.aborted) return;
    return new Promise(resolve => {
      const id = 'payment-' + randomUUID();
      let settled = false, timer, deadline = prepareDeadline, presented = false;
      // These observations grant nothing. The channel still authenticates every answer.
      const status = state => { try { onStatus?.({ id, state, app: app || site || 'this Mac', deadline }); } catch {} };
      const done = (choice, state = 'answered') => {
        if (settled) return;
        settled = true; clock.clearTimeout(timer);
        context?.signal?.removeEventListener('abort', cancel);
        requests.delete(pending); status(state); resolve(choice);
      };
      const cancel = () => { done(undefined, 'unavailable'); if (presented) forget(); };
      const pending = { cancel };
      requests.add(pending);
      context?.signal?.addEventListener('abort', cancel, { once: true });
      const current = () => !closed && !settled && !context?.signal?.aborted && now() < prepareDeadline;
      timer = clock.setTimeout(() => done(undefined, 'unavailable'), prepareDeadline - now());
      timer?.unref?.();
      if (prepare && !prepared) status('preparing');
      void (async () => {
        const built = await warm();
        if (!current()) { done(undefined, 'unavailable'); return; }
        if (!built) { done(undefined, 'unavailable'); return; }
        const ui = await connect(built, current);
        if (!current() || !ui) { done(undefined, 'unavailable'); return; }
        const scope = scoped ? 'Allow for this Grok Bot session only' : 'Allow this action once';
        // Bound untrusted engine text by UTF-8 bytes, with an explicit truncation marker.
        const bounded = request === undefined ? undefined : cardText(request);
        // Shell engine-payment stops use the same styled surface as shell elicitations.
        const styled = cardPresentation ?? (presentation && { style: 'ask', host: session || 'Grok Bot', kind: 'action',
          icon: presentation.icon, question: `Allow this payment at ${site || 'this page'}?`,
          detail: `Amount: ${shown ?? 'no amount shown'}\nControl: ${control ?? 'not named'}\nAllow this payment once.` });
        // Recheck after preparation and host creation, immediately before UI.
        if (!current()) { done(undefined, 'unavailable'); return; }
        deadline = now() + timeoutMs;
        clock.clearTimeout(timer);
        timer = clock.setTimeout(() => done('cancel', 'unanswered'), timeoutMs);
        timer?.unref?.();
        presented = true;
        ui.present(id,
          { view: { clientSession: escapeLabel(session), origin: escapeLabel(site || 'this page'), ...(request === undefined ? {} : { scope }) },
            ...(styled ? { presentation: { ...styled, question: cardText(styled.question), detail: cardText(styled.detail) } } : {}),
            operation: request === undefined
              ? { site: cardText(site || 'this page'), amount: cardText(shown ?? 'no amount shown'), button: control === undefined ? undefined : cardText(control) }
              : { request: bounded, scope } },
          ['once', 'cancel'], event => {
            if (closed || context?.signal?.aborted) { cancel(); return; }
            if (now() >= deadline) { done('cancel', 'unanswered'); return; }
            if (ui.authenticate(event) === true) done(event.choice === 'once' ? 'once' : 'cancel');
          },
          { deadline });
        if (!settled) status('waiting');
      })().catch(() => done(undefined, 'unavailable'));
    });
  }
}

// Compile this plugin's accepted helper sources without starting a UI process.
export async function prepareConsentHost({ signal, platform = process.platform,
  loadHost = () => import('./direct-browser/host.mjs') } = {}) {
  if (platform !== 'darwin') return;
  const host = await loadHost();
  if (signal?.aborted) return;
  const native = fileURLToPath(new URL('./direct-browser/native/', import.meta.url));
  const files = ['consent-host.swift', 'peer-host.c'].map(name => {
    const bytes = readFileSync(native + name);
    return { path: 'native/' + name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  });
  const inventory = { accepted: true, protocol: 1, node: process.version, helperMode: 'source', files };
  if (!host.nativeHelpersBuilt({ inventory }) && !await host.appleToolsPresent()) return;
  if (signal?.aborted) return;
  return host.prepareNativeHelpers({ inventory, signal });
}
async function openConsentHost({ prepared, onLoss, isCurrent } = {}) {
  if (prepared?.status !== 'ready' || !isCurrent()) return;
  const host = await import('./direct-browser/host.mjs');
  if (!isCurrent()) return;
  return host.createNativeUi(prepared.receipt, onLoss);
}
