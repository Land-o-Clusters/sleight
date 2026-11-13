// Fixed installed-loader connection provider. No discovery scan, HTTP lookup,
// browser launch or socket connection occurs until explicit connect(), and a lost socket never reconnects.
import { constants, lstatSync, realpathSync, readlinkSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { isAbsolute, normalize, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { parseActivePort, validateEndpoint } from './discovery.mjs';
import { createCDPFilter } from './cdp-filter.mjs';
import { createNativeProcessProvider, isNativeProcessProvider } from './host.mjs';
import { proofKey, proveRunningCode, signedBrowserAt, writeClass } from './executable-trust.mjs';
import { retryCodes, runOnceMore } from './transient.mjs';

const fail = code => { throw Error(code); };
const ordinaryObject = value => value && typeof value === 'object' && !Array.isArray(value);
const equalStat = (a, b) => ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs'].every(k => a[k] === b[k]);
// The profile folder is the same folder with the same owner and permissions. Its size and times are left out: Chrome
// adds, renames and removes entries there on its own (Local State's atomic rewrite, about 10 s after a pref change),
// which failed 2 of about 290 real-Chrome turbo starts on 2026-10-18 and 2026-10-19. The entries turbo reads
// (SingletonLock, DevToolsActivePort) keep their own exact comparisons.
const sameDirectory = (a, b) => ['dev', 'ino', 'uid', 'gid', 'mode'].every(k => a[k] === b[k]);
const methodName = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(value);

// signed: the executable is a signed browser at its fixed place (executable-trust.mjs), so a group write bit for
// admin or the user's primary group (primaryGid) is allowed here and observe() demands the running process's
// signature proof instead. World write, and group write for any other group, are always refused.
function securePath(path, uid, directory = false, executable = false, signed = false, primaryGid) {
  try {
    const stat = lstatSync(path);
    if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path ||
        stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== uid && !(executable && stat.uid === 0) ||
        (executable && signed ? !writeClass(stat, primaryGid) : stat.mode & 0o022) || executable && !(stat.mode & 0o100)) throw Error();
    return stat;
  } catch { fail('SELECTED_PATH_UNSAFE'); }
}

function endpointFile(root, uid, start) {
  const path = join(root, 'DevToolsActivePort'), before = securePath(path, uid);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!equalStat(before, stat) || !stat.isFile() || stat.size < 1 || stat.size > 512 ||
        !Number.isFinite(stat.mtimeMs) || stat.mtimeMs <= start) throw Error();
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length ||
        !equalStat(stat, fstatSync(fd)) || !equalStat(stat, securePath(path, uid))) throw Error();
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw Error();
    const hint = parseActivePort(text);
    return Object.freeze({ port: hint.port, browserPath: hint.path, text, path, canonicalPath: path,
      mtime: stat.mtimeMs, inode: stat.ino, device: stat.dev, ctime: stat.ctimeMs });
  } catch { fail('SELECTED_ENDPOINT_UNPROVED'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function selectedPid(root, uid) {
  try {
    const path = join(root, 'SingletonLock'), stat = lstatSync(path);
    // The selected profile's lock is a symlink, not a file to follow. Its
    // exact local hostname-PID value is only a hint until native birth/path and
    // listener ownership prove the selected browser process.
    if (!stat.isSymbolicLink() || stat.uid !== uid) throw Error();
    const prefix = hostname() + '-', target = readlinkSync(path);
    if (!target.startsWith(prefix) || !/^[1-9]\d{0,9}$/.test(target.slice(prefix.length))) throw Error();
    const pid = Number(target.slice(prefix.length));
    if (!Number.isSafeInteger(pid) || pid > 2147483647 || !equalStat(stat, lstatSync(path)) || readlinkSync(path) !== target) throw Error();
    return { pid, target, inode: stat.ino, device: stat.dev, ctime: stat.ctimeMs };
  } catch { fail('SELECTED_PROCESS_UNPROVED'); }
}

async function listenerOwner(run, port, pid, uid, retryDelay = 100) {
  try {
    // Inspect all TCP listeners at this exact port. Restricting to -p would hide
    // an ambiguous/foreign listener; wildcard binds cannot prove loopback-only.
    // An lsof that its timeout killed (a loaded Mac) runs once more; an lsof that answered is final.
    const { stdout } = await runOnceMore(run, '/usr/sbin/lsof', ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-Fpun'],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 3000, maxBuffer: 16384 }, { delayMs: retryDelay });
    if (typeof stdout !== 'string' || stdout.length > 16384) throw Error();
    let processId, userId, fileRecord = false, files = 0;
    for (const line of stdout.split('\n').filter(Boolean)) {
      const value = line.slice(1);
      if (line[0] === 'p') { if (fileRecord || !/^[1-9]\d*$/.test(value) || Number(value) !== pid) throw Error(); processId = Number(value); userId = undefined; }
      else if (line[0] === 'u') { if (!/^\d+$/.test(value) || Number(value) !== uid || processId !== pid) throw Error(); userId = Number(value); }
      else if (line[0] === 'f') { if (fileRecord || processId !== pid || userId !== uid || !/^\d+$/.test(value)) throw Error(); fileRecord = true; }
      else if (line[0] === 'n') {
        if (!fileRecord || processId !== pid || userId !== uid || value !== '127.0.0.1:' + port && value !== '[::1]:' + port) throw Error();
        fileRecord = false; files++;
      } else throw Error();
    }
    if (!files || fileRecord) throw Error();
    return true;
  } catch { fail('SELECTED_LISTENER_UNPROVED'); }
}

/** Private factory dependencies are trusted loader/test capabilities, never
 * config fields, MCP arguments, page data or environment overrides. Production
 * process observations require a locally branded compiled-native provider. */
export async function createSelectedConnection({ config, nativeReceipt, processMetadata, testDependencies } = {}) {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || !config) fail('SELECTED_CONFIG_REQUIRED');
  const root = config.profileRoot, application = config.executable;
  const deps = testDependencies ?? {};
  const metadata = deps.processMetadata ?? processMetadata ?? createNativeProcessProvider(nativeReceipt);
  if (!testDependencies && !isNativeProcessProvider(metadata)) fail('SELECTED_PROCESS_UNPROVED');
  const Socket = deps.WebSocket ?? globalThis.WebSocket;
  if (typeof Socket !== 'function' || !testDependencies && Number(process.versions.node.split('.')[0]) < 24) fail('SELECTED_SOCKET_UNAVAILABLE');
  const run = deps.execFile ?? promisify(execFile);
  const closeTimeout = deps.closeTimeoutMs ?? 3000, openTimeout = deps.openTimeoutMs ?? 10000, retryDelay = deps.retryDelayMs ?? 100;
  if (![closeTimeout, openTimeout, retryDelay].every(v => Number.isSafeInteger(v) && v > 0 && v <= 30000)) fail('SELECTED_CONFIG_REQUIRED');
  // Only a signed browser at its fixed place may have a group-writable executable, and only for a process whose
  // signature was proven (executable-trust.mjs). A proof is kept for one incarnation and executable inode.
  const requirement = signedBrowserAt(application, { appRoots: deps.signedAppRoots, browsers: deps.signedBrowsers })?.requirement;
  const signed = typeof requirement === 'string', primaryGid = deps.primaryGid ?? process.getgid?.();
  // The live code-signing status comes from the same native provider as the metadata (host.mjs), or a test's.
  const codeStatus = deps.codeStatus ?? metadata.codeStatus;
  let proven;
  const validInfo = (info, pid) => ordinaryObject(info) && info.pid === pid && info.uid === uid && Number.isFinite(info.start) && info.start > 0 &&
    typeof info.incarnation === 'string' && new RegExp('^p' + pid + '-s[1-9]\\d*-u\\d+$').test(info.incarnation);
  async function proveSignature(executableStat, info) {
    const writers = writeClass(executableStat, primaryGid);
    if (writers === 'strict') return;
    if (!signed || writers !== 'signature') fail('SELECTED_PATH_UNSAFE');
    const key = proofKey(info.incarnation, executableStat);
    if (proven === key) return;
    if (typeof codeStatus !== 'function') fail('SELECTED_SIGNATURE_UNPROVED');
    let status;
    try { status = await codeStatus(info.pid, application); } catch { fail('SELECTED_SIGNATURE_UNPROVED'); }
    if (!validInfo(status, info.pid) || status.incarnation !== info.incarnation || status.start !== info.start) fail('SELECTED_PROCESS_UNPROVED');
    await proveRunningCode(run, status, requirement, application);
    // The same incarnation before and after the status read and codesign, so they examined this process and no reused pid.
    const after = await metadata(info.pid, application);
    if (!validInfo(after, info.pid) || after.incarnation !== info.incarnation || after.start !== info.start) fail('SELECTED_PROCESS_UNPROVED');
    proven = key;
  }
  async function observe() {
    const rootStat = securePath(root, uid, true), executableStat = securePath(application, uid, false, true, signed, primaryGid);
    const lock = selectedPid(root, uid), info = await metadata(lock.pid, application);
    if (!validInfo(info, lock.pid)) fail('SELECTED_PROCESS_UNPROVED');
    await proveSignature(executableStat, info);
    const file = endpointFile(root, uid, info.start);
    if (!sameDirectory(rootStat, securePath(root, uid, true)) || !equalStat(executableStat, securePath(application, uid, false, true, signed, primaryGid)) ||
        JSON.stringify(lock) !== JSON.stringify(selectedPid(root, uid))) fail('STALE_INSTANCE');
    return { root, application, uid, pid: info.pid, start: info.start, incarnation: info.incarnation,
      rootDevice: rootStat.dev, rootInode: rootStat.ino, executableDevice: executableStat.dev, executableInode: executableStat.ino, lock, file };
  }
  // The first look waits boundedly (3 reads, 100 ms apart) through a DevToolsActivePort that Chrome is still writing
  // or an entry that changed between two reads. Later looks (current()) compare against this identity and never retry.
  const identity = Object.freeze(await retryCodes(observe, ['STALE_INSTANCE', 'SELECTED_ENDPOINT_UNPROVED'], { delayMs: retryDelay })),
    identityJSON = JSON.stringify(identity);
  const browserIncarnation = 'p' + createHash('sha256').update(identityJSON).digest('hex');
  const selectedBrowser = 'b' + createHash('sha256').update(root + '\0' + application).digest('hex').slice(0, 32);
  const endpoint = validateEndpoint('ws://127.0.0.1:' + identity.file.port + identity.file.browserPath);
  let socket, opened = false, fenced = false, attempted = false, closeIssued = false, closeConfirmed = false, opening, closing;
  let finishOpen, failOpen;
  const losses = new Set(); let lossNotified = false, lossReason = 'UNKNOWN';
  // Why the connection was fenced, kept as a code from a fixed list, never a frame's content. The first reason stays: later fences are consequences of it.
  const reasonCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,47}$/.test(value) ? value : 'UNKNOWN';
  function notifyLoss(reason) {
    if (lossNotified) return;
    lossNotified = true; lossReason = reason;
    for (const callback of losses) try { callback(lossReason); } catch {}
  }
  const callbacks = new Set(), pending = new Map(); let sequence = 0;
  function confirmedClose() {
    fenced = true; opened = false; closeConfirmed = true;
    notifyLoss('SOCKET_CLOSED');
    failOpen?.(Error('SELECTED_CONNECTION_CLOSED'));
    for (const command of pending.values()) command.reject(Error('SELECTED_CONNECTION_CLOSED'));
    pending.clear();
  }
  function fenceClose(reason = 'FENCED') {
    fenced = true; opened = false;
    notifyLoss(reasonCode(reason));
    failOpen?.(Error('SELECTED_CONNECTION_CLOSED'));
    if (socket && !closeIssued && !closeConfirmed) {
      closeIssued = true;
      try { socket.close(); } catch { /* An exception cannot prove socket closure. */ }
    }
  }
  function disconnect(candidate = session) {
    if (candidate !== session) return Promise.resolve(false);
    fenceClose('DISCONNECTED');
    if (!socket || closeConfirmed) return Promise.resolve(true);
    if (closing) return closing;
    closing = new Promise(resolve => {
      const done = () => { clearTimeout(timer); socket.removeEventListener('close', done); resolve(true); };
      const timer = setTimeout(() => { socket.removeEventListener('close', done); resolve(closeConfirmed); }, closeTimeout);
      socket.addEventListener('close', done, { once: true });
      if (closeConfirmed) done();
    }).finally(() => { closing = undefined; });
    return closing;
  }
  async function current() {
    if (JSON.stringify(await observe()) !== identityJSON) fail('STALE_INSTANCE');
    await listenerOwner(run, identity.file.port, identity.pid, uid, retryDelay);
  }
  function message(event) {
    let reason = 'FRAME_INVALID';
    try {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 8388608) { reason = 'FRAME_NOT_TEXT_OR_TOO_LARGE'; throw Error(); }
      const frame = JSON.parse(event.data);
      if (!ordinaryObject(frame)) { reason = 'FRAME_NOT_OBJECT'; throw Error(); }
      if (Object.hasOwn(frame, 'id')) {
        const command = pending.get(frame.id);
        if (!command) { reason = 'REPLY_UNKNOWN_ID'; throw Error(); }
        // Chromium answers a command for a session whose target has since closed (a popup that closed itself) with
        // -32001 and no sessionId. That is the one reply allowed to miss its route, and it fails only its own command.
        const sessionGone = command.route !== undefined && frame.sessionId === undefined && ordinaryObject(frame.error) && frame.error.code === -32001;
        if (frame.sessionId !== command.route && !sessionGone) { reason = 'REPLY_ROUTE_MISMATCH'; throw Error(); }
        if (Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error')) { reason = 'REPLY_SHAPE'; throw Error(); }
        pending.delete(frame.id);
        if (Object.hasOwn(frame, 'error')) command.reject(Error('CDP_COMMAND_FAILED'));
        else command.resolve(frame.result);
      } else {
        if (!methodName(frame.method) || !ordinaryObject(frame.params) || frame.sessionId !== undefined && typeof frame.sessionId !== 'string') {
          reason = 'EVENT_SHAPE'; throw Error();
        }
        if (!fenced) for (const callback of callbacks) {
          try { callback(Object.freeze({ method: frame.method, params: frame.params, ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }) })); } catch {}
        }
      }
    } catch { fenceClose(reason); }
  }
  const session = Object.freeze({ sessionId: 'r' + randomBytes(24).toString('hex'),
    send(method, params = {}, sessionId = session.sessionId) {
      if (fenced || !opened) return Promise.reject(Error('SELECTED_CONNECTION_CLOSED'));
      const route = sessionId === session.sessionId ? undefined : sessionId;
      if (!methodName(method) || !ordinaryObject(params) || route !== undefined && (typeof route !== 'string' || !route || route.length > 512) ||
          pending.size >= 1024 || sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(Error('INVALID_CDP_COMMAND'));
      const id = ++sequence;
      let text;
      try {
        text = JSON.stringify({ id, method, params, ...(route === undefined ? {} : { sessionId: route }) });
        if (Buffer.byteLength(text) > 1048576) throw Error();
      } catch { return Promise.reject(Error('INVALID_CDP_COMMAND')); }
      return new Promise((resolve, reject) => {
        pending.set(id, { route, resolve, reject });
        try { socket.send(text); } catch { fenceClose('SOCKET_SEND_FAILED'); }
      });
    },
    on(name, callback) { if (name !== 'event' || typeof callback !== 'function') fail('INVALID_CDP_EVENT'); callbacks.add(callback); },
    off(name, callback) { if (name !== 'event' || typeof callback !== 'function') fail('INVALID_CDP_EVENT'); callbacks.delete(callback); },
  });
  async function connect() {
    if (fenced || attempted && !opening) fail('SELECTED_CONNECTION_CLOSED');
    if (opening) return opening;
    attempted = true;
    opening = (async () => {
      try {
        await current(); if (fenced) fail('SELECTED_CONNECTION_CLOSED');
        socket = new Socket(endpoint);
        socket.addEventListener('close', confirmedClose, { once: true });
        socket.addEventListener('message', message);
        socket.addEventListener('error', () => fenceClose('SOCKET_ERROR'));
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { reject(Error('SELECTED_CONNECTION_TIMEOUT')); fenceClose('OPEN_TIMEOUT'); }, openTimeout);
          finishOpen = () => { clearTimeout(timer); resolve(); };
          failOpen = error => { clearTimeout(timer); reject(error); };
          socket.addEventListener('open', finishOpen, { once: true });
          if (fenced) failOpen(Error('SELECTED_CONNECTION_CLOSED'));
        });
        if (fenced) fail('SELECTED_CONNECTION_CLOSED');
        await current(); if (fenced || socket.readyState !== 1) fail('SELECTED_CONNECTION_CLOSED');
        opened = true; return session;
      } catch (error) { await disconnect(); throw error; }
      finally { finishOpen = undefined; failOpen = undefined; }
    })();
    return opening;
  }
  async function verifyConnection(candidate, expectedIncarnation = browserIncarnation) {
    if (candidate !== session || expectedIncarnation !== browserIncarnation || !opened || fenced || socket?.readyState !== 1) return false;
    try { await current(); return opened && !fenced && socket.readyState === 1; }
    catch (error) { fenceClose(/^(?:STALE_INSTANCE|SELECTED_[A-Z_]{1,40})$/.test(error?.message) ? error.message : 'VERIFY_FAILED'); return false; }
  }
  return Object.freeze({ session, connect, verifyConnection, disconnect, browserIncarnation, selectedBrowser, identity, endpoint,
    createFilter(ownedTargets = []) {
      if (!opened || fenced) fail('SELECTED_CONNECTION_CLOSED');
      const filter = createCDPFilter({ session, ownedTargets, protectedPort: identity.file.port });
      const lost = () => { filter.dispose(); losses.delete(lost); };
      losses.add(lost);
      return Object.freeze({ ...filter, dispose() { losses.delete(lost); return filter.dispose(); } });
    },
    onConnectionLoss(callback) {
      if (typeof callback !== 'function') fail('TRUSTED_ROUTE_REQUIRED');
      losses.add(callback); if (lossNotified) callback(lossReason);
      return () => losses.delete(callback);
    } });
}
