// Trusted loader adapters only. These factories are never exposed as MCP tools or config overrides.
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { win32 as path } from 'node:path';
import { windowsHostExecutable, windowsCachedHostReceipt, windowsSystemRoot, prepareWindowsHandHost } from './windows-host.mjs';
import { validateEndpoint } from './discovery.mjs';

const fail = code => { throw Error(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const denied = reason => Object.freeze({ ok: false, reason });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export function windowsGatePath(value) {
  return typeof value === 'string' && value.length >= 4 && value.length <= 4096 && /^[A-Za-z]:\\/.test(value) &&
    !/[\x00-\x1f<>"|?*/~]/.test(value) && !value.slice(2).includes(':') && path.normalize(value) === value &&
    value.slice(3).split('\\').every(part => part && !/[. ]$/.test(part));
}
const modeFor = request => request.op === 'consent' ? '--consent' : '--browser-gate';
// One cold allowance per relay process, shared by all gate-helper adapters.
let coldGate = true;
function gateTimeout() { const timeout = coldGate ? 30000 : 10000; coldGate = false; return timeout; }
const gateFailure = cause => Error('WINDOWS_GATE_UNPROVED: cause=' + cause);
/** A receipt binds one in-box csc build. Sync checks use only a prebuilt, read-only lookup. */
export function createWindowsGateHelper({ platform = process.platform, receipt, run = spawn, runSync = spawnSync,
  cached = windowsCachedHostReceipt, executable = windowsHostExecutable,
  appCards = process.env.SLEIGHT_WINDOWS_APP_CARD === '1' } = {}) {
  if (platform !== 'win32') return undefined;
  function command() {
    const proof = receipt ?? cached({ platform });
    if (!proof) fail('WINDOWS_HOST_NOT_BUILT');
    return executable(proof, { platform });
  }
  const options = file => ({ windowsHide: true, shell: false, cwd: path.dirname(file),
    env: { SystemRoot: windowsSystemRoot, WINDIR: windowsSystemRoot, ...appCards ? { SLEIGHT_WINDOWS_APP_CARD: '1' } : {} }, stdio: ['pipe', 'pipe', 'pipe'] });
  return Object.freeze({
    requestSync(request) {
      if (request.op === 'consent') fail('WINDOWS_CONSENT_ASYNC_REQUIRED');
      const file = command();
      let result;
      const timeout = gateTimeout();
      try { result = runSync(file, ['--browser-gate'], { ...options(file), input: JSON.stringify(request), encoding: 'utf8', timeout, maxBuffer: 65536, killSignal: 'SIGKILL' }); }
      catch { throw gateFailure('spawn'); }
      if (result.error?.code === 'ETIMEDOUT') throw gateFailure('timeout');
      if (result.error?.code === 'ENOBUFS') throw gateFailure('reply');
      if (result.error) throw gateFailure('spawn');
      if (result.signal || result.status !== 0) throw gateFailure('exit');
      return result.stdout;
    },
    request(request, { signal, timeout } = {}) {
      signal?.throwIfAborted();
      const file = command();
      const allowance = request.op === 'consent' ? 10000 : gateTimeout();
      return new Promise((resolve, reject) => {
        let child;
        try { child = run(file, [modeFor(request)], options(file)); }
        catch { reject(gateFailure('spawn')); return; }
        let failure, bytes = 0, stopped = false, settled = false; const output = [];
        const finish = (code, killedBy) => {
          if (settled) return; settled = true;
          clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (failure || code !== 0 || killedBy) reject(gateFailure(failure ?? 'exit')); else resolve(Buffer.concat(output).toString('utf8'));
        };
        const stop = (cause = 'exit') => { if (settled) return; failure ??= cause; if (!stopped) { stopped = true; child.kill('SIGKILL'); } };
        const abort = () => stop('exit');
        const timer = setTimeout(() => stop('timeout'), timeout ?? allowance);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        // A failed spawn need not emit close. There is no live child to reap in that case.
        child.once('error', () => { failure ??= 'spawn'; finish(); });
        child.stdin.on('error', () => stop('spawn'));
        child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) stop('reply'); else output.push(Buffer.from(chunk)); });
        child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) stop('reply'); });
        child.once('close', finish);
        child.stdin.end(JSON.stringify(request));
      });
    },
  });
}
function result(reply, nonce) {
  if (typeof reply !== 'string' || Buffer.byteLength(reply) > 65536) throw gateFailure('reply');
  let value; try { value = JSON.parse(reply); } catch { throw gateFailure('reply'); }
  if (!object(value) || value.nonce !== nonce || value.ok !== true || !object(value.evidence)) throw gateFailure('reply');
  return value.evidence;
}
const nonce = () => randomBytes(32).toString('hex');
/** Deliberately uncached: every call checks handle ACLs, parents, volume and reparse points again. */
export function createWindowsFilePermissions({ platform = process.platform, helper = createWindowsGateHelper({ platform }) } = {}) {
  const request = (value, { kind = 'file' } = {}, read = false, browser = false) => {
    if (platform !== 'win32') fail('WINDOWS_PLATFORM_REQUIRED');
    if (!windowsGatePath(value) || !['file', 'directory'].includes(kind)) fail('WINDOWS_PATH_UNSAFE');
    if (browser && (kind !== 'file' || !same(path.basename(value), 'DevToolsActivePort'))) fail('WINDOWS_PATH_UNSAFE');
    return { nonce: nonce(), op: (read ? 'read-' : '') + (browser ? 'browser-file' : 'private-file'), path: value, kind };
  };
  function evidence(reply, req) {
    const e = result(reply, req.nonce);
    if (!same(e.path, req.path) || e.kind !== req.kind || !Number.isSafeInteger(e.volume) || e.volume < 0 ||
        typeof e.fileId !== 'string' || !/^\d+:\d+:\d+$/.test(e.fileId) || !Number.isInteger(e.parents) || e.parents < 1 || e.parents > 2048) fail('WINDOWS_FILE_UNPROVED');
    if (req.op.startsWith('read-') && (typeof e.text !== 'string' || Buffer.byteLength(e.text) < 1 || Buffer.byteLength(e.text) > 512 || !Number.isSafeInteger(e.mtime))) fail('WINDOWS_FILE_UNPROVED');
    return e;
  }
  function check(value, opts) {
    try { const req = request(value, opts); evidence(helper.requestSync(req), req); return Object.freeze({ ok: true, reason: undefined }); }
    catch (error) { return denied(error.message); }
  }
  async function checkAsync(value, opts) {
    try { const req = request(value, opts); evidence(await helper.request(req), req); return Object.freeze({ ok: true, reason: undefined }); }
    catch (error) { return denied(error.message); }
  }
  return Object.freeze({ privateFile: check, privateFileAsync: checkAsync,
    privateCoordinator(value) {
      try {
        const req = request(value);
        if (!same(path.basename(value), '.coordinator.sqlite') || !same(path.basename(path.dirname(value)), 'leases')) fail('WINDOWS_PATH_UNSAFE');
        req.op = 'lease-coordinator'; evidence(helper.requestSync(req), req);
        return Object.freeze({ ok: true, reason: undefined });
      } catch (error) { return denied(error.message); }
    },
    privateDirectory: (value, opts) => check(value, { ...opts, kind: 'directory' }),
    privateDirectoryAsync: (value, opts) => checkAsync(value, { ...opts, kind: 'directory' }),
    readPrivateFile(value) { const req = request(value, { kind: 'file' }, true); return evidence(helper.requestSync(req), req); },
    // Browser-created files may inherit safe ACEs. sleight state retains the protected-DACL rule above.
    readBrowserFile(value) { const req = request(value, { kind: 'file' }, true, true); return evidence(helper.requestSync(req), req); },
  });
}
export function createWindowsPeerVerifier({ platform = process.platform, selected, endpoint, helper = createWindowsGateHelper({ platform }) } = {}) {
  if (platform !== 'win32') fail('WINDOWS_PLATFORM_REQUIRED');
  validateEndpoint(endpoint);
  if (!object(selected) || !windowsGatePath(selected.application) || !Number.isSafeInteger(selected.pid) || selected.pid < 1 || selected.pid > 2147483647 ||
      !Number.isSafeInteger(selected.start) || selected.start <= 0 || !/^S-1-\d+(?:-\d+){1,15}$/.test(selected.ownerSid ?? '') ||
      !Number.isSafeInteger(selected.sessionId) || selected.sessionId < 0 || selected.sessionId > 2147483647) fail('WINDOWS_PROCESS_UNPROVED');
  const identity = Object.freeze(Object.fromEntries(['pid', 'application', 'start', 'ownerSid', 'sessionId'].map(k => [k, selected[k]])));
  const url = new URL(endpoint), port = Number(url.port), address = url.hostname.replace(/^\[|\]$/g, '');
  let incarnation, connectionBound = false, fenced = false;
  return Object.freeze({ identity, endpoint,
    async current(socket) {
      if (fenced) fail('WINDOWS_PEER_FENCED');
      const req = { nonce: nonce(), op: 'peer', ...identity, port, ...(incarnation ? { incarnation } : {}) };
      try {
        if (connectionBound && socket === undefined) fail('WINDOWS_CONNECTION_UNPROVED');
        if (socket !== undefined) {
          if (!object(socket) || socket.destroyed || !Number.isInteger(socket.localPort) || socket.localPort < 1 || socket.localPort > 65535 ||
              socket.localAddress !== address || socket.remoteAddress !== address || socket.remotePort !== port) fail('WINDOWS_CONNECTION_UNPROVED');
          req.connection = { localPort: socket.localPort, address };
          connectionBound = true;
        }
        const reply = await helper.request(req); if (fenced) fail('WINDOWS_PEER_FENCED');
        if (req.connection && (socket.destroyed || socket.localPort !== req.connection.localPort ||
            socket.localAddress !== address || socket.remoteAddress !== address || socket.remotePort !== port)) fail('WINDOWS_CONNECTION_UNPROVED');
        const e = result(reply, req.nonce);
        if (['pid', 'start', 'ownerSid', 'sessionId'].some(k => e[k] !== identity[k]) || !same(e.application, identity.application) ||
            e.port !== port || e.publisher !== true || !Number.isInteger(e.listeners) || e.listeners < 1 ||
            !new RegExp('^p' + identity.pid + '-t[1-9]\\d{1,19}$').test(e.incarnation ?? '') || incarnation && e.incarnation !== incarnation) fail('WINDOWS_PEER_UNPROVED');
        if (req.connection && (!object(e.connection) || e.connection.localPort !== req.connection.localPort ||
            e.connection.address !== address || e.connection.pid !== identity.pid || e.connection.matches !== 1)) fail('WINDOWS_CONNECTION_UNPROVED');
        incarnation = e.incarnation; return true;
      } catch { fenced = true; fail('WINDOWS_PEER_UNPROVED'); }
    },
    revoke() { fenced = true; },
  });
}
/** Fence an injected private CDP transport before opening, after opening and before each command.
 * Selection, profile proof, consent, tab ownership and CDP filtering remain the caller's responsibilities. */
export function createWindowsPeerConnection({ verifier, open, close, send } = {}) {
  if (!verifier || ![open, close, send].every(f => typeof f === 'function')) fail('WINDOWS_CONNECTION_REQUIRED');
  let connected = false, attempted = false, fenced = false, socket;
  const stop = async () => { fenced = true; connected = false; verifier.revoke(); await close(); };
  return Object.freeze({
    async connect() {
      if (attempted || fenced) fail('WINDOWS_PEER_FENCED'); attempted = true;
      try {
        await verifier.current(); if (fenced) fail('WINDOWS_PEER_FENCED');
        // open returns the private transport's connected net.Socket, before sending CDP commands.
        socket = await open(); if (!object(socket)) fail('WINDOWS_CONNECTION_REQUIRED');
        await verifier.current(socket); if (fenced) fail('WINDOWS_PEER_FENCED'); connected = true;
      }
      catch (error) { await stop(); throw error; }
    },
    async send(...args) {
      if (!connected || fenced) fail('WINDOWS_PEER_FENCED');
      try { await verifier.current(socket); if (!connected || fenced) fail('WINDOWS_PEER_FENCED'); return await send(...args); }
      catch (error) { await stop(); throw error; }
    }, disconnect: stop,
  });
}
/** Native replies are consumed once and branded by object identity for createConsentUi.authenticate. */
export function createWindowsConsent({ platform = process.platform, appCards = process.env.SLEIGHT_WINDOWS_APP_CARD === '1',
  helper = createWindowsGateHelper({ platform, appCards }), now = Date.now } = {}) {
  if (platform !== 'win32') fail('WINDOWS_PLATFORM_REQUIRED');
  const replies = new WeakMap(); const pending = new Set();
  return Object.freeze({
    authenticate(event) { if (!event || !replies.has(event)) return false; const deadline = replies.get(event); replies.delete(event); return now() < deadline; },
    async present({ id, kind, question, detail, choices, deadline }, { signal } = {}) {
      const req = { nonce: nonce(), id, kind, question, detail, choices: [...(choices ?? [])], deadline };
      if (!/^[A-Za-z0-9-]{1,80}$/.test(id ?? '') || pending.has(id) || pending.size >= 32 || !['debugger', 'payment', 'action', 'relaunch', ...appCards ? ['app'] : []].includes(kind) ||
          typeof question !== 'string' || !question || question.length > 512 || typeof detail !== 'string' || detail.length > 16384 ||
          /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(question + detail) ||
          req.choices.length < 2 || req.choices.length > 3 || req.choices[0] !== 'cancel' || new Set(req.choices).size !== req.choices.length ||
          req.choices.slice(1).some(c => !(kind === 'debugger' ? ['once', 'session', 'always'] : [kind === 'app' ? 'session' : kind === 'relaunch' ? 'relaunch' : 'once']).includes(c)) ||
          !Number.isSafeInteger(deadline) || deadline <= now() || deadline > now() + 300000) fail('WINDOWS_CONSENT_INVALID');
      pending.add(id);
      try {
        const reply = await helper.request({ ...req, op: 'consent' }, { signal, timeout: deadline - now() + 1000 });
        if (typeof reply !== 'string' || Buffer.byteLength(reply) > 4096) fail('WINDOWS_CONSENT_UNPROVED');
        let event; try { event = JSON.parse(reply); } catch { fail('WINDOWS_CONSENT_UNPROVED'); }
        if (!object(event) || Object.keys(event).sort().join(',') !== 'choice,id,nonce' || event.nonce !== req.nonce || event.id !== id ||
            !req.choices.includes(event.choice) || signal?.aborted || now() >= deadline) fail('WINDOWS_CONSENT_UNPROVED');
        const branded = Object.freeze({ id, choice: event.choice }); replies.set(branded, deadline); return branded;
      } finally { pending.delete(id); }
    },
  });
}

/** Prepare the single helper independently of the optional cursor, before discovery/connection.
 * The launcher still owns operator enablement, profile selection and browser qualification. */
export async function prepareWindowsBrowserGates({ platform = process.platform, signal,
  prepare = prepareWindowsHandHost, helperFactory = createWindowsGateHelper } = {}) {
  if (platform !== 'win32') return Object.freeze({ status: 'unavailable', code: 'PLATFORM' });
  const build = await prepare({ platform, signal });
  if (build.status !== 'ready') return build;
  signal?.throwIfAborted();
  const helper = helperFactory({ platform, receipt: build.receipt });
  return Object.freeze({ status: 'ready',
    filePermissions: createWindowsFilePermissions({ platform, helper }),
    peerVerifier: (selected, endpoint) => createWindowsPeerVerifier({ platform, selected, endpoint, helper }),
    consent: createWindowsConsent({ platform, helper }),
  });
}
