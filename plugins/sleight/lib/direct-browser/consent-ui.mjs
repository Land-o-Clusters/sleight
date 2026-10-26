import { workerCursorStatus } from '../hand/events.mjs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { validateOperationPrincipal, describeOperationDocument, validateCardOperation, cardChoices } from './electron-identity.mjs';

// Native host protocol only. No page bridge or model-facing approval endpoint.
// BP2-1 repeats its policy/lease/document checks through checkCurrent at dispatch.
const identityKeys = ['browserIncarnation', 'brokerEpoch', 'clientSession', 'turn', 'leaseGeneration',
  'target', 'frame', 'document', 'sequence', 'origin', 'action', 'args', 'destination', 'payment'];
const integerKeys = new Set(['brokerEpoch', 'leaseGeneration', 'sequence']);
const verbs = new Set(['open', 'read', 'act', 'fill', 'click', 'key', 'select', 'scroll', 'drag', 'hover', 'wait', 'dialog', 'capture', 'download']);
function fail(code) { throw new Error(code); }

export function escapeLabel(value) {
  return String(value).replace(/[&<>"'\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// Accept data, never getters or executable objects. Stable ordering binds the
// whole request privately; no values, hashes or equality oracle leave this module.
function canonical(value, depth = 0) {
  if (depth > 16) fail('INVALID_OPERATION');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object') fail('INVALID_OPERATION');
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail('INVALID_OPERATION');
    const descriptors = Object.getOwnPropertyDescriptors(value), length = descriptors.length.value;
    if (length > 65536 || Reflect.ownKeys(descriptors).length !== length + 1) fail('INVALID_OPERATION');
    const entries = [];
    for (let i = 0; i < length; i++) {
      const descriptor = descriptors[i];
      if (!Object.hasOwn(descriptors, i) || !descriptor || !('value' in descriptor)) fail('INVALID_OPERATION');
      entries.push(canonical(descriptor.value, depth + 1));
    }
    return `[${entries.join(',')}]`;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_OPERATION');
  const entries = Object.keys(value).sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) fail('INVALID_OPERATION');
    return `${JSON.stringify(key)}:${canonical(descriptor.value, depth + 1)}`;
  });
  return `{${entries.join(',')}}`;
}
function webOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) fail('INVALID_ORIGIN');
  return value;
}
// An operation inside an Electron app carries one extra key, a typed principal. It is
// checked against origin, destination and incarnation; without it only web origins pass.
function operationKey(operation) {
  const key = canonical(operation), typed = Object.hasOwn(operation, 'principal');
  if (Buffer.byteLength(key) > 65536 || Object.keys(operation).length !== identityKeys.length + (typed ? 1 : 0)) fail('INVALID_OPERATION');
  for (const field of identityKeys) {
    if (!Object.hasOwn(operation, field)) fail('INVALID_OPERATION');
    const value = operation[field];
    if (integerKeys.has(field)) { if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_OPERATION'); }
    else if (field === 'args') { if (!value || Array.isArray(value) || typeof value !== 'object') fail('INVALID_OPERATION'); }
    else if (field === 'payment') { if (value !== null && (typeof value !== 'object' || Array.isArray(value))) fail('INVALID_OPERATION'); }
    else if (typeof value !== 'string' || !value || value.length > 4096) fail('INVALID_OPERATION');
  }
  if (!verbs.has(operation.action)) fail('INVALID_OPERATION');
  if (typed) { validateOperationPrincipal(operation); return key; }
  webOrigin(operation.origin);
  const destination = new URL(operation.destination);
  if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) fail('INVALID_DESTINATION');
  return key;
}
// Debugger and relaunch cards name an app and a requesting turn instead of a page action.
function cardKey(kind, operation) {
  const key = canonical(operation);
  if (Buffer.byteLength(key) > 65536) fail('INVALID_OPERATION');
  validateCardOperation(kind, operation);
  return key;
}

export function selectedBrowser(browser) {
  canonical(browser);
  for (const key of ['application', 'name', 'userDataRoot', 'incarnation'])
    if (typeof browser[key] !== 'string' || !browser[key] || browser[key].length > 4096) fail('INVALID_SELECTION');
  if (!isAbsolute(browser.userDataRoot) || normalize(browser.userDataRoot) !== browser.userDataRoot) fail('INVALID_SELECTION');
  return { application: browser.application, name: browser.name, userDataRoot: browser.userDataRoot, incarnation: browser.incarnation };
}

export function createConsentUi({ authenticate, present, checkCurrent = () => false, now = Date.now, ttlMs = 30000, cursorStatus = workerCursorStatus } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 300000) fail('INVALID_EXPIRY');
  const pending = new Map();
  let tickets = new WeakMap();
  let epoch = 1;
  return {
    request(operation, { kind = 'action', label = '' } = {}) {
      if (typeof authenticate !== 'function' || typeof present !== 'function') fail('TRUSTED_UI_UNAVAILABLE');
      const card = kind === 'debugger' || kind === 'relaunch';
      if (!card && (kind !== 'action' || !operation?.payment)) fail('INVALID_CONFIRMATION');
      for (const [id, record] of pending) if (now() >= record.expires) pending.delete(id);
      if (pending.size >= 32) fail('CONFIRMATION_BACKPRESSURE');
      const key = card ? cardKey(kind, operation) : operationKey(operation), id = randomUUID();
      const snapshot = JSON.parse(key), choices = card ? cardChoices(kind, snapshot) : ['once', 'cancel'];
      pending.set(id, { key, snapshot, kind, choices, epoch, expires: now() + ttlMs });
      try { cursorStatus('waiting'); } catch {}
      try {
        // The host renders escaped observations as text outside page DOM. It
        // renders exact data/payment details from the second, private argument
        // in its native surface. That argument must never enter logs/model output.
        if (card) present(Object.freeze({ id, kind, operation: snapshot.sequence, clientSession: escapeLabel(snapshot.session),
          app: Object.freeze({ name: escapeLabel(snapshot.app.name), bundleId: escapeLabel(snapshot.app.bundleId), version: escapeLabel(snapshot.app.version),
            profile: escapeLabel(snapshot.app.profile), pid: snapshot.app.pid }), choices }), JSON.parse(key));
        else {
          const document = describeOperationDocument(snapshot);
          present(Object.freeze({ id, kind, operation: snapshot.sequence, clientSession: escapeLabel(snapshot.clientSession),
            origin: escapeLabel(document.origin), destinationOrigin: escapeLabel(document.destinationOrigin), documentKind: document.documentKind,
            ...(document.app ? { app: escapeLabel(document.app) } : {}),
            action: snapshot.action, pageLabel: escapeLabel(label), data: 'protected', payment: snapshot.payment ? 'protected' : null,
            choices }), JSON.parse(key));
        }
      } catch { pending.delete(id); fail('TRUSTED_UI_UNAVAILABLE'); }
      return id;
    },
    respond(event) {
      if (typeof authenticate !== 'function' || authenticate(event) !== true) fail('UNAUTHENTICATED_UI');
      const record = pending.get(event.id);
      pending.delete(event.id);
      if (!record || record.epoch !== epoch || now() >= record.expires) fail('STALE_CONFIRMATION');
      if (['cancel', 'close'].includes(event.choice)) return null;
      // Each card kind allows only the choices it offered. A debugger reply cannot answer a payment, and
      // Always exists only on a debugger card for a profile that persists.
      if (!record.choices.includes(event.choice)) fail('INVALID_CHOICE');
      const ticket = Object.freeze({});
      tickets.set(ticket, { ...record, choice: event.choice });
      return ticket;
    },
    consume(ticket, operation) {
      const record = ticket && typeof ticket === 'object' ? tickets.get(ticket) : undefined;
      if (record) tickets.delete(ticket);
      let key;
      try { key = record && ['debugger', 'relaunch'].includes(record.kind) ? cardKey(record.kind, operation) : operationKey(operation); } catch { fail('STALE_CONFIRMATION'); }
      if (!record || record.epoch !== epoch || now() >= record.expires || record.key !== key) fail('STALE_CONFIRMATION');
      if (checkCurrent(JSON.parse(record.key)) !== true) fail('CURRENT_AUTHORITY_REQUIRED');
      if (record.kind === 'action') return { phase: 'prepared', effect: 'none', completed: [], next: 'broker authorization and dispatch fence' };
      return { phase: 'prepared', effect: 'none', completed: [], kind: record.kind, choice: record.choice, next: 'grant bookkeeping' };
    },
    revoke() { epoch++; pending.clear(); tickets = new WeakMap(); },
  };
}
