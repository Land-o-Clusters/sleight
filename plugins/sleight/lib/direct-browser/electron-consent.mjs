import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { canonical } from './authority.mjs';
import { createConsentUi } from './consent-ui.mjs';
import { UNLAUNCHED, appKey, createAppBinding, validateAppInstance } from './electron-identity.mjs';

// The debugger is its own opt-in per app, separate from the engine's app approval (LAWS, 2026-10-14).
// Three things come only from an authenticated click on a native card: a debugger grant, an Always
// allow record on disk, and a one-use relaunch ticket. Tool JSON and page content reach none of them.
// Revocation stops commands by calling each grant's park hook. It never closes the app's pipe.
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const grants = new WeakMap(), clicks = new WeakSet(), relaunches = new WeakMap();
const recordKeys = ['key', 'name', 'bundleId', 'signer', 'version', 'runtime', 'profile', 'executable', 'cdhash'];
const fail = code => { throw Error(code); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
export const isDebuggerGrant = value => !!value && grants.has(value);

function validRecord(record) {
  if (!record || typeof record !== 'object' || Object.keys(record).length !== recordKeys.length || !recordKeys.every(key => Object.hasOwn(record, key))) fail('INVALID_GRANT_RECORD');
  const { key, ...rest } = record;
  if (appKey({ ...rest, pid: 1, pidBirth: 'x', temporary: false }) !== key) fail('INVALID_GRANT_RECORD');
  return Object.freeze({ ...record });
}

// Always allow records. Memory-only without a path. With a path, the file is operator-owned (mode 0600, this user,
// no links) and read again on every lookup so a revocation elsewhere applies at once. Each record carries an HMAC
// seal under a key in its own 0600 file (keyPath, by default grant-seal.key beside the records), so a record written
// by hand, an old unsealed one or one with a changed field is not consent. put() needs a receipt that only an
// authenticated Always click in createElectronConsent mints, and it burns that receipt.
// Limit (docs/known-problems.md): a process running as this user can read the key file and seal its own record.
export function createGrantStore({ path, keyPath } = {}) {
  const absolute = value => isAbsolute(value) && normalize(value) === value && value.length <= 4096;
  if (path !== undefined && !absolute(path) || keyPath !== undefined && (path === undefined || !absolute(keyPath))) fail('INVALID_GRANT_STORE');
  const sealPath = path === undefined ? undefined : keyPath ?? join(dirname(path), 'grant-seal.key');
  let memory = new Map(), unsafe = false, key;
  const safeFile = (file, stat) => stat.isFile() && !stat.isSymbolicLink() && realpathSync(file) === file && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600;
  // The seal key: read if it exists and is safe, created (exclusively, 0600) only when a sealed write needs it.
  function sealKey(create) {
    if (key) return key;
    let stat;
    try { stat = lstatSync(sealPath); } catch (error) {
      if (error.code !== 'ENOENT' || !create) return undefined;
      mkdirSync(dirname(sealPath), { recursive: true, mode: 0o700 });
      const fd = openSync(sealPath, 'wx', 0o600);
      try { writeSync(fd, randomBytes(32).toString('base64url')); fsyncSync(fd); } finally { closeSync(fd); }
      stat = lstatSync(sealPath);
    }
    if (!safeFile(sealPath, stat) || stat.size > 128) fail('GRANT_STORE_UNSAFE');
    const bytes = Buffer.from(readFileSync(sealPath, 'utf8').trim(), 'base64url');
    if (bytes.length !== 32) fail('GRANT_STORE_UNSAFE');
    return (key = bytes);
  }
  const sealOf = (secret, record) => createHmac('sha256', secret).update(canonical(record)).digest('base64url');
  function read() {
    if (path === undefined) return memory;
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') { unsafe = false; return new Map(); } unsafe = true; return new Map(); }
    try {
      if (!safeFile(path, stat) || stat.size > 1048576) fail('GRANT_STORE_UNSAFE');
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (!data || data.version !== 2 || !Array.isArray(data.grants) || data.grants.length > 4096) fail('GRANT_STORE_UNSAFE');
      const secret = sealKey(false);
      const records = new Map();
      for (const entry of data.grants) {
        // A record whose seal does not verify is skipped, never trusted and never kept by a later write.
        if (!secret || !entry || typeof entry.seal !== 'string' || Object.keys(entry).sort().join() !== 'record,seal') continue;
        let valid; try { valid = validRecord(entry.record); } catch { continue; }
        const expected = Buffer.from(sealOf(secret, valid)), given = Buffer.from(entry.seal);
        if (expected.length === given.length && timingSafeEqual(expected, given)) records.set(valid.key, valid);
      }
      unsafe = false; return records;
    } catch { unsafe = true; return new Map(); }
  }
  function write(records) {
    if (path === undefined) { memory = records; return; }
    const secret = sealKey(true);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomBytes(6).toString('hex') + '.tmp', fd = openSync(temporary, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify({ version: 2, grants: [...records.values()].map(record => ({ record, seal: sealOf(secret, record) })) })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  }
  return Object.freeze({
    get: key => read().get(key),
    list: () => [...read().values()],
    put(receipt, record) {
      if (!clicks.has(receipt)) fail('AUTHENTICATED_CLICK_REQUIRED');
      clicks.delete(receipt);
      const records = read();
      if (unsafe) fail('GRANT_STORE_UNSAFE');
      const valid = validRecord(record);
      if (records.size >= 4096 && !records.has(valid.key)) fail('GRANT_STORE_FULL');
      records.set(valid.key, valid); write(records);
    },
    // Removing permission needs no click.
    remove(key) { const records = read(); if (unsafe || !records.delete(key)) return false; write(records); return true; },
  });
}

// ui is the native consent channel (present/authenticate/revoke). engineApproval(instance) is the engine's own
// app approval, 'approved' | 'refused' | 'unknown'. Only 'approved' lets a card appear or a grant stay current.
// onAlwaysUsed(bundleId) hears each time a saved Always record grants the debugger, for the permissions list's last use.
export function createElectronConsent({ ui, store, engineApproval, now = Date.now, ttlMs = 120000, relaunchTtlMs = 60000, onAlwaysUsed } = {}) {
  if (typeof ui?.present !== 'function' || typeof ui.authenticate !== 'function' || typeof store?.get !== 'function' || typeof store.put !== 'function' ||
      typeof engineApproval !== 'function' || typeof now !== 'function') fail('TRUSTED_CONTRACT_REQUIRED');
  const live = new Set(), entries = new Map(), requests = new Map();
  let sequence = 0, consuming;
  const approved = instance => { try { return engineApproval(instance) === 'approved'; } catch { return false; } };
  const consent = createConsentUi({ now, ttlMs, authenticate: event => ui.authenticate(event) === true,
    checkCurrent: operation => consuming === canonical(operation),
    present(view, operation) {
      const entry = entries.get(canonical(operation));
      if (!entry) fail('TRUSTED_UI_UNAVAILABLE');
      ui.present(view.id, { kind: view.kind, app: operation.app, session: operation.session, turn: operation.turn, epoch: operation.sequence },
        view.choices, event => reply(entry, event), { deadline: Date.now() + ttlMs }); // the native channel keeps wall-clock time
    } });

  function kill(record, reason) {
    if (record.revoked) return;
    record.revoked = true; live.delete(record);
    for (const hook of [...record.hooks]) { try { hook({ reason }); } catch {} }
    record.hooks.clear();
  }
  function mint(instance, session, turn, scope) {
    const record = { id: 'g' + randomUUID().replaceAll('-', ''), scope, instance, key: appKey(instance), session, turn: scope === 'once' ? turn : null, revoked: false, hooks: new Set(), checked: now(), stored: true };
    // An Always grant lives only while its record does. Revoking it elsewhere applies within two seconds.
    const stillStored = () => {
      if (scope !== 'always') return true;
      if (now() - record.checked >= 2000 || now() < record.checked) {
        record.stored = !!store.get(record.key); record.checked = now();
        if (!record.stored) kill(record, 'record-removed');
      }
      return record.stored;
    };
    const grant = Object.freeze({ id: record.id, scope, session, turn: record.turn, app: record.key,
      current() { return !record.revoked && approved(record.instance) && stillStored(); },
      // The transport's park hook. It must stop commands and keep the pipe open.
      onRevoke(hook) { if (typeof hook !== 'function') fail('INVALID_HOOK'); if (record.revoked) { try { hook({ reason: 'revoked' }); } catch {} } else record.hooks.add(hook); } });
    record.grant = grant; grants.set(grant, record); live.add(record); return grant;
  }
  function find(instance, session, turn) {
    const key = appKey(instance);
    for (const record of live) if (!record.revoked && record.session === session && record.key === key &&
        record.instance.pid === instance.pid && record.instance.pidBirth === instance.pidBirth && (record.scope !== 'once' || record.turn === turn)) return record.grant;
    return undefined;
  }
  const checked = (instance, session, turn) => {
    const app = validateAppInstance(instance);
    if (!SESSION.test(session ?? '') || !text(turn)) fail('INVALID_REQUEST');
    return app;
  };

  function settleWith(entry, value) {
    if (entry.done) return;
    entry.done = true; clearTimeout(entry.timer); entries.delete(entry.key); requests.delete(entry.dedupe);
    entry.resolve(Object.freeze(value));
  }
  function reply(entry, event) {
    if (entry.done) return;
    let ticket;
    try { ticket = consent.respond(event); }
    catch (error) {
      // A reply the UI channel did not authenticate never touches the card the person still sees.
      if (error.message === 'UNAUTHENTICATED_UI') return;
      return settleWith(entry, { status: error.message === 'STALE_CONFIRMATION' ? 'expired' : 'refused', code: error.message });
    }
    if (!ticket) return settleWith(entry, { status: 'declined' });
    try {
      consuming = canonical(entry.operation);
      const receipt = consent.consume(ticket, entry.operation);
      consuming = undefined;
      if (!approved(entry.instance)) return settleWith(entry, { status: 'refused', code: 'ENGINE_APP_APPROVAL_REQUIRED' });
      if (entry.kind === 'relaunch') {
        const ticketOut = Object.freeze({});
        relaunches.set(ticketOut, { exact: canonical(entry.instance), session: entry.session, turn: entry.turn, expires: now() + relaunchTtlMs });
        return settleWith(entry, { status: 'approved', ticket: ticketOut });
      }
      let scope = receipt.choice, persisted = false;
      if (scope === 'always') {
        // The write is reachable only from here: an authenticated Always click on a persistent profile.
        try {
          const click = Object.freeze({}); clicks.add(click);
          const { pid, pidBirth, temporary, ...rest } = entry.instance;
          store.put(click, { key: appKey(entry.instance), ...rest }); persisted = true;
        } catch { scope = 'session'; }
      }
      settleWith(entry, { status: 'granted', persisted, grant: mint(entry.instance, entry.session, entry.turn, scope) });
    } catch (error) { consuming = undefined; settleWith(entry, { status: 'refused', code: String(error?.message ?? 'REFUSED') }); }
  }
  function ask(kind, instance, session, turn) {
    const dedupe = canonical({ kind, instance, session, turn }), existing = requests.get(dedupe);
    if (existing) return existing.promise;
    const operation = { app: instance, session, turn, sequence: ++sequence }, key = canonical(operation);
    const entry = { kind, instance, session, turn, operation, key, dedupe, done: false };
    entry.promise = new Promise(resolve => { entry.resolve = resolve; });
    entry.timer = setTimeout(() => settleWith(entry, { status: 'expired' }), ttlMs + 1000); entry.timer.unref?.();
    entries.set(key, entry); requests.set(dedupe, entry);
    try { consent.request(operation, { kind }); }
    catch (error) { settleWith(entry, { status: 'refused', code: String(error?.message ?? 'TRUSTED_UI_UNAVAILABLE') }); }
    return entry.promise;
  }
  const gate = instance => approved(instance) ? undefined : Promise.resolve(Object.freeze({ status: 'refused', code: 'ENGINE_APP_APPROVAL_REQUIRED' }));

  // Existing grant for this exact process, or one the Always record supplies for this build and profile.
  function grantFor(instance, { session, turn } = {}) {
    try {
      const app = checked(instance, session, turn);
      if (!approved(app)) return undefined;
      const existing = find(app, session, turn);
      if (existing) return existing;
      if (!app.temporary && store.get(appKey(app))) { try { onAlwaysUsed?.(app.bundleId); } catch {} return mint(app, session, turn, 'always'); }
    } catch {}
    return undefined;
  }

  return Object.freeze({
    grantFor,
    async requestDebugger(instance, { session, turn } = {}) {
      let app; try { app = checked(instance, session, turn); } catch { return Object.freeze({ status: 'refused', code: 'INVALID_REQUEST' }); }
      const blocked = gate(app); if (blocked) return blocked;
      const grant = grantFor(app, { session, turn });
      if (grant) return Object.freeze({ status: 'granted', persisted: grant.scope === 'always', grant });
      return ask('debugger', app, session, turn);
    },
    // A relaunch is its own card on every request. No debugger grant, Always or not, stands in for it.
    async requestRelaunch(instance, { session, turn } = {}) {
      let app; try { app = checked(instance, session, turn); } catch { return Object.freeze({ status: 'refused', code: 'INVALID_REQUEST' }); }
      return gate(app) ?? ask('relaunch', app, session, turn);
    },
    // Exact process, build and profile, this session and turn, once. A burned ticket never returns.
    consumeRelaunch(ticket, instance, { session, turn } = {}) {
      const record = ticket && typeof ticket === 'object' ? relaunches.get(ticket) : undefined;
      if (record) relaunches.delete(ticket);
      let exact; try { exact = canonical(validateAppInstance(instance)); } catch { exact = undefined; }
      if (!record || now() >= record.expires || exact !== record.exact || record.session !== session || record.turn !== turn || !approved(instance)) fail('RELAUNCH_NOT_AUTHORIZED');
      return Object.freeze({ phase: 'authorized', action: 'quit-and-relaunch', app: appKey(instance), pid: instance.pid });
    },
    bindApp({ grant, instance, window, brokerEpoch, recipe, verify } = {}) {
      const record = grants.get(grant);
      if (!record || !grant.current() || canonical(validateAppInstance(instance)) !== canonical(record.instance)) fail('DEBUGGER_GRANT_REQUIRED');
      if (verify !== undefined && typeof verify !== 'function') fail('INVALID_APP_BINDING');
      return createAppBinding({ instance: record.instance, window, brokerEpoch, recipe,
        authority: { id: record.id, session: record.session, turn: record.turn,
          current: () => grant.current() && (verify === undefined || verify() === true) } });
    },
    // A card for an app sleight has not launched yet names its build and profile with pid 0 ('unlaunched').
    // After the launch, the grant moves to the exact launched process once: every other field must match,
    // and no later process (a relaunch, a PID reuse) can take it over.
    adopt(grant, launched) {
      const record = grants.get(grant);
      if (!record || !grant.current()) fail('DEBUGGER_GRANT_REQUIRED');
      if (record.adopted || record.instance.pid !== 0) fail('GRANT_ALREADY_ADOPTED');
      let app; try { app = validateAppInstance(launched); } catch { fail('GRANT_ADOPT_MISMATCH'); }
      if (app.pid === 0 || canonical({ ...app, pid: 0, pidBirth: UNLAUNCHED }) !== canonical(record.instance)) fail('GRANT_ADOPT_MISMATCH');
      if (!approved(app)) fail('ENGINE_APP_APPROVAL_REQUIRED');
      record.instance = app; record.adopted = true;
      return grant;
    },
    // A once grant ends with its turn. Session and Always grants outlive turns.
    endTurn(session, turn) {
      for (const record of [...live]) if (record.scope === 'once' && record.session === session && record.turn === turn) kill(record, 'turn-ended');
    },
    revokeSession(session) {
      for (const record of [...live]) if (record.session === session) kill(record, 'session-revoked');
      for (const entry of [...entries.values()]) if (entry.session === session) settleWith(entry, { status: 'revoked' });
    },
    // Takes the Always record too, so the next request asks again.
    revokeApp(instance) {
      const key = appKey(instance);
      for (const record of [...live]) if (record.key === key) kill(record, 'app-revoked');
      for (const entry of [...entries.values()]) if (appKey(entry.instance) === key) settleWith(entry, { status: 'revoked' });
      return store.remove(key);
    },
    revokeAll() {
      for (const record of [...live]) kill(record, 'all-revoked');
      consent.revoke();
      for (const entry of [...entries.values()]) settleWith(entry, { status: 'revoked' });
      try { ui.revoke?.(); } catch {}
    },
    pending: () => entries.size,
  });
}
