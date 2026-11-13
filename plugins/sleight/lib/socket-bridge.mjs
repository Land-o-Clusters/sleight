// Grok Bot's local shell reaches one relay over a private, same-user Unix socket.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, execFile } from 'node:child_process';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { userInfo, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { environment } from './direct-browser/host.mjs';
import { readNativeAccessibility } from './grokbot-host.mjs';

const LIB = dirname(fileURLToPath(import.meta.url));
const TOOLS = new Set(['js', 'js_reset', 'open_file', 'select_window', 'drag']);
const MAX_REQUEST = 1024 * 1024;
const MAX_REPLY = 64 * 1024 * 1024;
const SOCKET_FILE = 'Library/Caches/sleight/shell/session.sock';
const approvalLabel = value => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, 160).trim() || 'this Mac' : 'this Mac';
const approvalError = app => new Error(`sleight: approval not answered for ${approvalLabel(app)} before the deadline; no approval was granted. Tell the user and do not retry.`);
const pendingApprovalError = status => status.state === 'preparing'
  ? new Error(`sleight: approval preparation for ${approvalLabel(status.app)} did not finish before the deadline; no approval was granted. Tell the user and do not retry.`)
  : approvalError(status.app);
export const socketDirectory = () => dirname(join(userInfo().homedir, SOCKET_FILE));

// Caller settings must never weaken a persistent session's guards or load caller code.
export function sessionEnvironment(env = process.env) {
  const user = userInfo();
  return { HOME: user.homedir, USER: user.username, PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: '/private/tmp', LANG: 'en_US.UTF-8',
    ...(env.SLEIGHT_CHATGPT_APP ? { SLEIGHT_CHATGPT_APP: env.SLEIGHT_CHATGPT_APP } : {}) };
}

export function enterSessionContext(directory = socketDirectory()) {
  checkDirectory(directory, true);
  const env = sessionEnvironment();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(directory);
}

function owned(path, kind, mode) {
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid() || (kind === 'directory' ? !stat.isDirectory() : !stat.isSocket()) ||
      (stat.mode & 0o777) !== mode) throw Object.assign(new Error(`Shell bridge ${kind} must be private and owned by this user: ${path}`),
        { code: kind === 'socket' && stat.isSocket() && stat.uid === process.getuid() ? 'ESOCKETPRIVATE' : 'EUNSAFE' });
  return stat;
}

function checkDirectory(directory, create = false) {
  // Check each existing ancestor before mkdir can follow it. Root-owned system ancestors are allowed.
  const uid = process.getuid();
  for (let path = dirname(directory); path !== dirname(path); path = dirname(path)) {
    let stat;
    try { stat = lstatSync(path); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    if (!stat.isDirectory() || ![0, uid].includes(stat.uid) || (stat.mode & 0o022 && !(stat.mode & 0o1000))) {
      throw new Error(`Shell bridge parent must be an owned directory: ${path}`);
    }
  }
  if (create) {
    try { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  owned(directory, 'directory', 0o700);
}

function validate(request) {
  if (request?.op === 'status' && Object.keys(request).length === 1) return request;
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(k => !['tool', 'args'].includes(k)) || !TOOLS.has(request.tool) ||
      !request.args || typeof request.args !== 'object' || Array.isArray(request.args) ||
      (request.tool === 'js' && typeof request.args.code !== 'string')) throw new Error('Invalid shell request or tool');
  return request;
}

// Node has no getpeereid API. This small helper receives the actual connected fd at fd 3.
export async function preparePeerCheck({ tools = async () => process.platform !== 'darwin' ||
  (await import('./direct-browser/host.mjs')).appleToolsPresent() } = {}) {
  if (!await tools()) throw new Error('Shell session needs Xcode Command Line Tools; install them before starting a session');
  const directory = mkdtempSync(join(tmpdir(), 'sleight-peer-'));
  const binary = join(directory, 'peer');
  try {
    await promisify(execFile)('/usr/bin/clang', ['-Wall', '-Werror', '-fmodules-cache-path=' + join(directory, 'modules'),
      join(LIB, 'socket-peer.c'), '-o', binary], { timeout: 60000, env: environment() });
  } catch (err) { rmSync(directory, { recursive: true, force: true }); throw err; }
  return {
    uid: socket => new Promise((resolve, reject) => {
      const child = spawn(binary, [], { env: {}, stdio: ['ignore', 'pipe', 'ignore', socket._handle.fd] });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.once('error', reject);
      child.once('close', code => code === 0 && /^\d+\n$/.test(output)
        ? resolve(Number(output.trim())) : reject(new Error('Unix peer credentials refused')));
    }),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

// A fixed MCP client. The shell cannot send initialize, elicitation answers, metadata or turn frames.
export async function createShellRelay({ command = process.execPath, args = [join(LIB, 'launch.mjs'), '--socket-relay'],
  timeoutMs = 300000, recoveryMs = 30000, termMs = 10000, killMs = 5000, env = sessionEnvironment(), cwd, signal,
  now = Date.now, spawnChild = spawn, requestClock = { setTimeout, clearTimeout } } = {}) {
  const child = spawnChild(command, args, { detached: true, stdio: ['pipe', 'pipe', 'inherit'], env, cwd });
  const pending = new Map();
  let next = 0, closing, ended = false, groupGone = !child.pid;
  const fail = error => {
    // A broken protocol or pipe cannot prove that the engine stopped input. Close before releasing callers.
    if (!closing) void close();
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const childClosed = new Promise(resolve => child.once('close', (code, signal) => {
    ended = true; fail(new Error(`Shell relay exited (${signal ?? code})`)); resolve({ code, signal });
  }));
  child.on('error', fail);
  child.stdin.on('error', fail);
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'notifications/sleight/approval' && msg.id === undefined) {
        const status = msg.params;
        if (typeof status?.id !== 'string' || !Number.isFinite(status.deadline) ||
            !['preparing', 'waiting', 'answered', 'unanswered', 'unavailable'].includes(status.state)) return;
        for (const entry of pending.values()) entry.approval(status);
      }
      else if (msg.method && msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'No host forms on shell route' } });
      else if (!msg.method && pending.has(msg.id)) {
        const reply = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? reply.reject(new Error(msg.error.message)) : reply.resolve(msg.result);
      }
    } catch (err) { fail(err); }
  });
  function request(method, params, onApproval) {
    let complete;
    const completed = new Promise(resolve => { complete = resolve; });
    const result = new Promise((resolve, reject) => {
      if (ended || closing) { complete(); return reject(new Error('Shell relay is closed')); }
      const id = next++;
      // A timeout ends the caller's wait, but only an engine reply or exit ends its input ownership.
      let recovery, expired = false;
      const approvals = new Map(), deadline = now() + timeoutMs;
      const expire = error => {
        if (expired) return;
        expired = true;
        reject(error);
        requestClock.clearTimeout(timer);
        recovery = requestClock.setTimeout(() => { void close(); }, recoveryMs);
      };
      const timer = requestClock.setTimeout(() => {
        const waiting = approvals.values().next().value;
        expire(waiting ? pendingApprovalError(waiting) : new Error('Shell relay call timed out; engine still busy until it replies or is collected; read state before retrying input'));
        // End any outstanding card with the call rather than allowing an answer after its deadline.
        if (waiting) void close();
      }, timeoutMs);
      const clear = () => { requestClock.clearTimeout(timer); requestClock.clearTimeout(recovery); };
      pending.set(id, { resolve: value => {
        clear(); complete();
        const waiting = approvals.values().next().value;
        if (waiting) { reject(pendingApprovalError(waiting)); void close(); }
        else resolve(value);
      },
        reject: err => {
          clear(); complete();
          const waiting = approvals.values().next().value;
          reject(waiting ? pendingApprovalError(waiting) : err);
          if (waiting) void close();
        },
        approval: status => {
          if (method !== 'tools/call' || expired) return;
          if (status.state === 'preparing' || status.state === 'waiting') {
            if (approvals.get(status.id)?.state === status.state) return;
            approvals.set(status.id, status);
            onApproval?.({ ...status, app: approvalLabel(status.app), deadline: Math.min(status.deadline, deadline) });
          } else {
            if (!approvals.delete(status.id)) return;
            onApproval?.({ ...status, app: approvalLabel(status.app) });
            if (status.state === 'unanswered') expire(approvalError(status.app));
          }
        } });
      // This parent owns the call lifetime. No caller tool argument supplies it.
      const trustedParams = method === 'tools/call' ? { ...params, _meta: { sleightShellDeadline: deadline } } : params;
      try { send({ id, method, params: trustedParams }); } catch (err) { pending.get(id).reject(err); pending.delete(id); }
    });
    return Object.assign(result, { completed });
  }
  function signalGroup(signal) {
    if (groupGone) return false;
    try { process.kill(-child.pid, signal); return true; }
    catch (err) {
      // Darwin can report EPERM for a group containing only unreaped zombies. Keep ownership until ESRCH.
      if (err.code === 'EPERM') return true;
      if (err.code !== 'ESRCH') throw err;
      groupGone = true; return false;
    }
  }
  const close = () => closing ||= (async () => {
    // EOF enters launch.mjs's shutdown path, which collects the engine before this child exits.
    child.stdin.end();
    const timer = setTimeout(() => signalGroup('SIGTERM'), termMs);
    const force = setTimeout(() => signalGroup('SIGKILL'), termMs + killMs);
    try {
      const result = await childClosed;
      // A launcher exit alone cannot prove its engine exited. Collect residual group members too.
      signalGroup('SIGTERM');
      while (signalGroup(0)) await delay(10);
      return result;
    } finally { clearTimeout(timer); clearTimeout(force); lines.close(); signal?.removeEventListener('abort', abort); }
  })();
  const closed = childClosed.then(() => close());
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Grok Bot', version: '1' } });
    send({ method: 'notifications/initialized' });
    return { call: (name, args, options) => request('tools/call', { name, arguments: args }, options?.onApproval), close, closed };
  } catch (err) { await close(); throw err; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { if (err.code === 'ESRCH') return false; throw err; }
}

function lockOwner(lock) {
  owned(lock, 'directory', 0o700);
  const path = join(lock, 'owner');
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 256) throw new Error('Unsafe shell startup owner');
    const owner = JSON.parse(readFileSync(fd, 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647 || !Number.isFinite(owner.time)) throw new Error('Invalid shell startup owner');
    return owner;
  } finally { if (fd !== undefined) closeSync(fd); }
}

// Keep ownership through collection, even after the listener stops accepting connections.
export async function startSocketSession(options = {}) {
  const directory = options.directory ?? socketDirectory();
  checkDirectory(directory, true);
  // Kernel-backed admission prevents competing reclaims and releases automatically on death.
  const coordinator = join(directory, 'session-start.sqlite');
  const fd = openSync(coordinator, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error('Shell session coordinator must be a private owned file');
  } finally { closeSync(fd); }
  const db = new DatabaseSync(coordinator);
  const unlock = () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
  try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
  catch (err) { db.close(); throw new Error('Shell socket is occupied by a starting or closing session', { cause: err }); }
  const lock = join(directory, 'starting');
  try {
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const before = owned(lock, 'directory', 0o700);
      let reclaim = false;
      try { reclaim = !pidAlive(lockOwner(lock).pid); }
      catch (error) { if (error.code !== 'ENOENT') throw error; reclaim = Date.now() - before.mtimeMs > 360000; }
      if (!reclaim) throw new Error('Shell socket is occupied by a starting or closing session');
      try { unlinkSync(join(lock, 'owner')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Preserve unexpected contents. No other new starter can enter while SQLite admission is held.
      rmdirSync(lock);
      mkdirSync(lock, { mode: 0o700 });
    }
  } catch (err) { unlock(); throw err; }
  const identity = lstatSync(lock);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const stat = lstatSync(lock);
      if (stat.dev === identity.dev && stat.ino === identity.ino) {
        unlinkSync(join(lock, 'owner')); rmdirSync(lock);
      }
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    finally { unlock(); }
  };
  try {
    writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: process.pid, time: Date.now() }), { flag: 'wx', mode: 0o600 });
    const session = await startSocketSessionLocked({ ...options, directory, release });
    return session;
  } catch (err) { release(); throw err; }
}

async function startSocketSessionLocked({ directory = socketDirectory(), startRelay = createShellRelay,
  peerUid, idleMs = 600000, requestTimeoutMs = 10000, writeTimeoutMs = 10000, signals = process, release = () => {},
  writeClock = { setTimeout, clearTimeout },
  idleClock = { setTimeout, clearTimeout }, accessibility = readNativeAccessibility, publishSocket = async () => {} } = {}) {
  checkDirectory(directory, true);
  const socketPath = join(directory, basename(SOCKET_FILE));
  // Darwin's sockaddr_un.sun_path has 104 bytes including the terminating NUL.
  if (Buffer.byteLength(socketPath) >= 104) throw new Error('Shell socket path must fit in 103 UTF-8 bytes (macOS sun_path is 104 bytes); use a shorter home/cache path');
  try {
    const before = owned(socketPath, 'socket', 0o600);
    try {
      await callSocket({ op: 'status' }, { directory, timeoutMs: 2000 });
      throw new Error('Shell socket path is occupied by a live session');
    } catch (err) {
      if (err.code !== 'ECONNREFUSED') throw err;
      const after = owned(socketPath, 'socket', 0o600);
      if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Shell socket changed during startup');
      unlinkSync(socketPath);
    }
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  // A previous session may have crashed. Prune only its private image folders under this cache.
  for (const name of readdirSync(directory).filter(name => /^(images|marker)-[A-Za-z0-9]+$/.test(name))) {
    const path = join(directory, name);
    try { owned(path, 'directory', 0o700); } catch { continue; }
    rmSync(path, { recursive: true });
  }
  const images = mkdtempSync(join(directory, 'images-'));
  const sessionId = randomUUID();
  const peers = new Set();
  const startupAbort = new AbortController();
  let relay, peer, timer, closing, socketStat, busy = false;
  let active;
  let finish, finishStartup;
  const closed = new Promise(resolve => { finish = resolve; });
  const startupReady = new Promise(resolve => { finishStartup = resolve; });
  const server = createServer({ pauseOnConnect: true }, socket => {
    if (closing || peers.size >= 8) { socket.destroy(); return; }
    socket.setEncoding('utf8');
    peers.add(socket);
    socket.on('error', () => {});
    let writeDeadline;
    const reply = value => {
      if (socket.destroyed) return;
      writeClock.clearTimeout(writeDeadline);
      writeDeadline = writeClock.setTimeout(() => socket.destroy(), writeTimeoutMs);
      socket.end(JSON.stringify(value) + '\n');
    };
    const deadline = setTimeout(() => socket.destroy(), requestTimeoutMs);
    socket.once('close', () => { clearTimeout(deadline); writeClock.clearTimeout(writeDeadline); peers.delete(socket); });
    void (async () => {
      try {
        if (await peerUid(socket) !== process.getuid()) throw new Error('Unix peer uid refused');
        if (closing) throw new Error('Shell session is closing');
        let input = '', handled = false;
        socket.on('data', chunk => {
          if (handled) { socket.destroy(); return; }
          input += chunk;
          if (Buffer.byteLength(input) > MAX_REQUEST) { socket.destroy(); return; }
          const newline = input.indexOf('\n');
          if (newline < 0) return;
          handled = true;
          clearTimeout(deadline);
          void (async () => {
            try {
              if (input.slice(newline + 1).trim()) throw new Error('One shell request per connection');
              const request = validate(JSON.parse(input.slice(0, newline)));
              if (request.op === 'status') {
                let nativeAccessibility;
                try { nativeAccessibility = accessibility(); } catch {}
                reply({ result: { ready: !!relay && !closing, sessionId, nativeAccessibility } });
                return;
              }
              const { tool, args } = request;
              const observe = approval => { if (!socket.destroyed) socket.write(JSON.stringify({ approval }) + '\n'); };
              if (!relay || closing || busy && !(tool === 'js' && active?.tool === tool && active.waiting.size &&
                  isDeepStrictEqual(args, active.args))) throw new Error('Shell session is starting, busy or closing; read state before retrying input');
              socket.setTimeout(0);
              if (busy) {
                for (const approval of active.waiting.values()) observe(approval);
              } else {
                busy = true; idleClock.clearTimeout(timer);
                const current = active = { tool, args, waiting: new Map(), observers: new Set() };
                // Store the subscriber before call(): fake and in-process relays may emit status synchronously.
                current.observers.add(observe);
                const call = Promise.resolve().then(() => {
                  const pending = relay.call(tool, args, { onApproval: approval => {
                    if (approval.state === 'preparing' || approval.state === 'waiting') current.waiting.set(approval.id, approval);
                    else current.waiting.delete(approval.id);
                    for (const subscriber of current.observers) subscriber(approval);
                  } });
                  current.completed = pending.completed;
                  return pending;
                });
                current.result = call.then(async result => {
                  const content = [];
                  for (const block of result?.content ?? []) {
                    if (block.type !== 'image') content.push(block);
                    else await printSocketResult({ content: [block] }, { directory: images,
                      out: text => content.push({ type: 'text', text: text.trimEnd() }) });
                  }
                  return { result: { ...result, content } };
                }).catch(err => ({ error: err.message }));
                // Input ownership lasts until the engine replies or is collected, even if every shell caller left.
                void current.result.finally(async () => {
                  await current.completed;
                  if (active === current) { active = undefined; busy = false; armIdle(); }
                });
              }
              const current = active;
              current.observers.add(observe);
              socket.once('close', () => current.observers.delete(observe));
              try { reply(await current.result); }
              finally { current.observers.delete(observe); }
            } catch (err) { reply({ error: err.message }); }
          })();
        });
        socket.resume();
      } catch { reply({ error: 'Unix peer credentials refused' }); }
    })();
  });
  function armIdle() { if (!closing) timer = idleClock.setTimeout(() => { void close(); }, idleMs); }
  const onSignal = () => { void close(); };
  function close() {
    return closing ||= (async () => {
      idleClock.clearTimeout(timer);
      startupAbort.abort();
      for (const socket of peers) socket.destroy();
      let error, stopped = Promise.resolve();
      try {
        await startupReady;
        stopped = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
        for (const socket of peers) socket.destroy();
        const result = await relay?.close();
        if (result && (result.code !== 0 || result.signal)) throw new Error('Shell relay did not report a clean engine collection');
      } catch (err) { error = err; }
      finally {
        await stopped;
        if (socketStat) {
          try { const stat = lstatSync(socketPath); if (stat.dev === socketStat.dev && stat.ino === socketStat.ino) unlinkSync(socketPath); }
          catch (err) { if (err.code !== 'ENOENT') error ||= err; }
        }
        try { peer?.close(); } catch (err) { error ||= err; }
        try { rmSync(images, { recursive: true, force: true }); } catch (err) { error ||= err; }
        try { release(); } catch (err) { error ||= err; }
        for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) signals.removeListener(signal, onSignal);
        finish({ error });
      }
      return { error };
    })();
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) signals.on(signal, onSignal);
  try {
    if (!peerUid) { peer = await preparePeerCheck(); peerUid = peer.uid; }
    if (closing) throw new Error('Shell session stopped during startup');
    // Bind before starting a relay so two session commands never start two engines.
    // The private parent protects the socket during the brief listen-to-chmod interval.
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    socketStat = lstatSync(socketPath);
    await publishSocket(socketPath);
    chmodSync(socketPath, 0o600); owned(socketPath, 'socket', 0o600);
    if (closing) throw new Error('Shell session stopped during startup');
    relay = await startRelay({ signal: startupAbort.signal, env: sessionEnvironment(), cwd: directory });
    if (closing) throw new Error('Shell session stopped during startup');
    relay.closed?.then(() => { void close(); });
    finishStartup();
    armIdle();
    return { socketPath, close, closed };
  } catch (err) { finishStartup(); await close(); throw err; }
}

export async function callSocket(request, { directory = socketDirectory(), timeoutMs = 310000, onApproval } = {}) {
  validate(request);
  const path = join(directory, basename(SOCKET_FILE));
  try { checkDirectory(directory); owned(path, 'socket', 0o600); }
  catch (err) {
    if (err.code === 'ENOENT') err.message = 'No shell session is listening; run sleight-mcp session (sleight-mcp js also starts one on demand)';
    throw err;
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setEncoding('utf8');
    let input = '', settled = false, bytes = 0, waiting;
    const fail = error => { if (!settled) { settled = true; reject(error); } socket.destroy(); };
    socket.setTimeout(timeoutMs, () => fail(waiting ? pendingApprovalError(waiting) : new Error('Shell call timed out; read state before retrying input')));
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      input += chunk;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REPLY) return fail(new Error('Shell reply too large; read state before retrying input'));
      try {
        let newline;
        while (!settled && (newline = input.indexOf('\n')) >= 0) {
          const reply = JSON.parse(input.slice(0, newline));
          input = input.slice(newline + 1);
          if (reply.approval) {
            waiting = ['preparing', 'waiting'].includes(reply.approval.state) ? reply.approval : undefined;
            onApproval?.(reply.approval); continue;
          }
          if (reply.error) throw new Error(reply.error);
          settled = true; resolve(reply.result); socket.end();
        }
      } catch (err) { fail(err); }
    });
    socket.once('error', fail);
    socket.once('close', () => { if (!settled) fail(new Error('Shell session closed before replying; read state before retrying input')); });
  });
}

export async function printSocketResult(result, { out = text => process.stdout.write(text), directory } = {}) {
  for (const block of result?.content ?? []) {
    if (block.type === 'image') {
      if (!directory) {
        const cache = socketDirectory();
        checkDirectory(cache, true);
        directory = mkdtempSync(join(cache, 'images-'));
      }
      owned(directory, 'directory', 0o700);
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[block.mimeType] ?? 'bin';
      const files = readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.(png|jpg|webp|bin)$/.test(name))
        .map(name => ({ name, stat: lstatSync(join(directory, name)) }))
        .filter(({ stat }) => stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600)
        .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
      while (files.length >= 50) unlinkSync(join(directory, files.shift().name));
      const path = join(directory, `${randomUUID()}.${extension}`);
      writeFileSync(path, Buffer.from(block.data, 'base64'), { mode: 0o600, flag: 'wx' });
      out(path + '\n');
    } else if (block.type === 'text') out(block.text + '\n');
    else out(JSON.stringify(block) + '\n');
  }
  return result?.isError ? 1 : 0;
}

export async function socketCommand([command, ...args], options = {}) {
  const { out = text => process.stdout.write(text), err = text => process.stderr.write(text) } = options;
  if (command === 'session' && args.length === 1 && args[0] === '--install-agent') {
    out(launchAgentInstructions(options));
    err('Owner step: save the printed plist as ~/Library/LaunchAgents/com.sleight.shell.plist, then run:\nlaunchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.sleight.shell.plist"\nsleight has not written or loaded this plist. The session still exits after ten idle minutes.\n');
    return 0;
  }
  if (['open_file', 'select_window', 'drag'].includes(command) && args.length === 1 && args[0] === '--help') {
    const { localToolDefinitions } = await import('./launch.mjs');
    out(JSON.stringify(localToolDefinitions({}).find(tool => tool.name === command), null, 2) + '\n');
    return 0;
  }
  if (command === 'session' && !args.length) {
    enterSessionContext();
    const session = await startSocketSession();
    process.stderr.write(`sleight: Grok Bot shell session ready at ${session.socketPath}; idle timeout 10 minutes\n`);
    const { error } = await session.closed;
    if (error) throw error;
    return 0;
  }
  let toolArgs;
  if (command === 'js' && args.length === 1) toolArgs = { code: args[0] };
  else if (command === 'js_reset' && !args.length) toolArgs = {};
  else if (['open_file', 'select_window', 'drag'].includes(command) && args.length === 1) toolArgs = JSON.parse(args[0]);
  else throw new Error("usage: sleight-mcp session [--install-agent] | js '<code>' | js_reset | open_file|select_window|drag '<JSON arguments>'");
  await ensureSocketSession({ ...options, notice: options.notice ?? out });
  return printSocketResult(await callSocket({ tool: command, args: toolArgs }, { ...options,
    onApproval: approval => {
      if (approval.state === 'preparing') out(`sleight: preparing the approval panel for ${approvalLabel(approval.app)}; no card is ready yet. The call is still pending.\n`);
      if (approval.state === 'waiting') out(`sleight: waiting for your approval in the sleight card on the Mac (also menu bar glove > Review sleight request) for ${approvalLabel(approval.app)}; the call continues when you answer, or cancels after ${Math.max(0, Math.ceil((approval.deadline - Date.now()) / 1000))} s\n`);
    },
  }), { out });
}

// Child becomes a process-group leader. Its session owns idle shutdown and relay collection.
export async function spawnDetachedSession({ command = process.execPath,
  args = [join(LIB, 'launch.mjs'), 'session'], spawnChild = spawn, directory = socketDirectory() } = {}) {
  checkDirectory(directory, true);
  const log = join(directory, 'session.log');
  const fd = openSync(log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let child;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error('Shell session log must be a private owned file');
    child = spawnChild(command, args, { detached: true, env: sessionEnvironment(), cwd: directory, stdio: ['ignore', 'ignore', fd] });
  } finally { closeSync(fd); }
  // Install before awaiting spawn so even an immediate exit is observed.
  child.sessionExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.sessionExit.then(result => { child.sessionExitResult = result; });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child;
}

export async function ensureSocketSession({ directory = socketDirectory(), spawnSession = spawnDetachedSession,
  notice = text => process.stdout.write(text), startupMs = 90000, probe = callSocket,
  now = Date.now, pause = delay } = {}) {
  checkDirectory(directory, true);
  const deadline = now() + startupMs;
  let started = false, child;
  do {
    try {
      const status = await probe({ op: 'status' }, { directory, timeoutMs: Math.min(2000, Math.max(1, deadline - now())) });
      if (status.ready) {
        // Every caller sees the identity. Another client's observation cannot hide a restart.
        notice(`sleight: shell session ${status.sessionId}; if this ID changed, JavaScript handles and session approvals are reset. Read the first call's engine docs.\n`);
        return;
      }
    } catch (err) {
      if (!['ENOENT', 'ECONNREFUSED', 'ESOCKETPRIVATE'].includes(err.code)) throw err;
      if (!started && err.code !== 'ESOCKETPRIVATE') { started = true; child = await spawnSession({ directory }); }
    }
    if (child?.sessionExitResult) {
      let competing = false;
      try { const owner = lockOwner(join(directory, 'starting')); competing = owner.pid !== child.pid && pidAlive(owner.pid); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (!competing) throw new Error(`Shell session starter exited (${child.sessionExitResult.signal ?? child.sessionExitResult.code}); inspect ${join(directory, 'session.log')}; handles and session approvals may have reset`);
    }
    await pause(50);
  } while (now() < deadline);
  throw new Error('Shell session did not become ready before its startup deadline; handles and session approvals may have reset; inspect sleight-mcp session before retrying input');
}

export function launchAgentInstructions({ executable = join(LIB, '../bin/sleight-mcp') } = {}) {
  const xml = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.sleight.shell</string>
<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>session</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`;
}
