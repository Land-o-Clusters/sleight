// Windows cursor security behind the platform sink interface.
import { spawn } from 'node:child_process';
import { win32Environment } from '../platform/paths.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';
import { readFileSync } from 'node:fs';

const bootstrapSHA256 = 'c5839b6a328a385fef887136862518b834265007c80f4b1b4c6049bb15918920';

const validSid = sid => typeof sid === 'string' && /^(?:S-1-5-21|S-1-12-1)-(?:0|[1-9]\d{0,9})-(?:0|[1-9]\d{0,9})-(?:0|[1-9]\d{0,9})-(?:0|[1-9]\d{0,9})$/.test(sid) &&
  sid.split('-').slice(4).every(n => Number(n) <= 0xffffffff);
const validName = name => typeof name === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(name);
export function pipeName(sid, name) {
  if (!validSid(sid) || !validName(name)) throw new Error('Invalid Windows SID or renderer name');
  return `\\\\.\\pipe\\sleight-cursor-${sid}-${name}`;
}
export function pipeSecurityDescriptor(sid) {
  if (!validSid(sid)) throw new Error('Invalid Windows user SID');
  return `O:${sid}D:P(A;;GA;;;${sid})`;
}
export function monitorPoint(point, { origin, scale }) {
  if (![point, origin].every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) || !Number.isFinite(scale) || scale <= 0 || scale > 8) throw new Error('Invalid monitor coordinates or scale');
  return point.map((p, i) => (p - origin[i]) / scale);
}

// One PowerShell worker per adapter, shared by the process's default transport.
// Execute fixed source as an encoded command, so Restricted does not block a .ps1 file.
// No execution-policy override. Request data remains JSONL on stdin.
export function createWindowsSecurity({ run = spawn, read = readFileSync, now = Date.now,
  report = message => process.stderr.write(`sleight: ${message}\n`), testEnv, platform = process.platform, startupMs = 15000 } = {}) {
  const helper = fileURLToPath(new URL('windows-security.ps1', import.meta.url));
  const operations = new Set(['identity', 'prepare', 'list', 'seal', 'verify', 'publish', 'remove']);
  const pending = new Map(); let worker, buffer = '', nextId = 0, identity, ready, readyResolve, readyReject, startupTimer, initialized = false;
  let startupFailures = 0, retryAt = 0, startupError;
  const failure = (message, code) => new Error(message + (code === 'ACCESS_DENIED' || code === 'EACCES' || code === 'EPERM' ?
    '. Use a normal, non-elevated Windows shell with the same user as the renderer.' : ''));
  function failedStart(error) {
    startupError = error;
    retryAt = now() + ([1000, 5000, 30000][startupFailures++] ?? Infinity);
    if (startupFailures === 4) {
      startupError = new Error(`Windows cursor security stopped after 4 failures: ${error.message}`);
      report(startupError.message);
    }
  }
  function stop(child, error) {
    if (worker !== child) return;
    failedStart(error);
    worker = undefined; buffer = ''; identity = undefined;
    clearTimeout(startupTimer); readyReject?.(error); readyResolve = readyReject = undefined; ready = undefined; initialized = false;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear(); child.stdin.destroy(); child.stdout.destroy(); child.kill();
  }
  function start() {
    const environment = testEnv === undefined ? win32Environment() : win32Environment({ env: testEnv });
    const executable = win32.join(environment.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const source = read(helper);
    if (createHash('sha256').update(source).digest('hex') !== bootstrapSHA256) throw Error('Windows cursor bootstrap hash mismatch');
    const encoded = Buffer.from(source.toString('utf8'), 'utf16le').toString('base64');
    if (encoded.length + executable.length + 100 > 32000) throw Error('Windows cursor bootstrap exceeds command budget');
    let child;
    try { child = run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, env: environment, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (error) { const reason = failure('Windows cursor security start failed', error.code); failedStart(reason); throw reason; }
    worker = child; child.unref?.(); child.stdin.unref?.(); child.stdout.unref?.();
    ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    startupTimer = setTimeout(() => stop(child, failure('Windows cursor security startup deadline exceeded')), startupMs);
    child.stdout.setEncoding('utf8');
    const fail = error => stop(child, failure('Windows cursor security check failed', error?.code));
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail); child.stdout.on('error', fail);
    child.stdout.on('data', chunk => {
      if (worker !== child) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 65536) return fail();
      for (let newline; (newline = buffer.indexOf('\n')) !== -1;) {
        const line = buffer.slice(0, newline).replace(/^\uFEFF/, '').trim(); buffer = buffer.slice(newline + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { return stop(child, new Error('Invalid Windows cursor security response')); }
        if (!initialized) {
          if (reply?.startupError) return stop(child, failure('Windows cursor security startup failed', reply.startupError));
          if (reply?.ready !== true || Object.keys(reply).length !== 1) return fail();
          retryAt = 0; startupError = undefined;
          initialized = true; clearTimeout(startupTimer); readyResolve(); readyResolve = readyReject = undefined; continue;
        }
        const request = pending.get(reply?.id);
        if (!request || typeof reply.ok !== 'boolean') return stop(child, new Error('Invalid Windows cursor security response'));
        pending.delete(reply.id); clearTimeout(request.timer);
        if (reply.ok) { startupFailures = 0; request.resolve(reply.result); } else request.reject(failure('Windows cursor security check failed', reply.error));
      }
    });
    return ready;
  }
  const ensure = () => {
    if (platform !== 'win32') throw new Error('Windows cursor security is unavailable on this platform');
    if (!ready && now() < retryAt) throw new Error(`${startupError.message}; ${retryAt === Infinity ? 'restart this session to retry' : 'startup retry backoff active'}`);
    return ready ?? start();
  };
  const call = async (operation, entry, { timeoutMs = 4000 } = {}) => {
    if (platform !== 'win32') throw new Error('Windows cursor security is unavailable on this platform');
    if (!operations.has(operation)) throw new Error('Invalid cursor security operation');
    await ensure();
    const child = worker, id = ++nextId;
    if (!child) throw new Error('Windows cursor security worker exited');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop(child, new Error('Windows cursor security deadline exceeded')), Math.max(1, timeoutMs));
      pending.set(id, { resolve, reject, timer });
      try { child.stdin.write(JSON.stringify({ id, operation, entry: entry ?? {} }) + '\n'); }
      catch { stop(child, new Error('Windows cursor security check failed')); }
    });
  };
  return { ready: async () => { await ensure(); },
    sid: options => identity ||= call('identity', undefined, options).catch(error => { identity = undefined; throw error; }),
    prepare: options => call('prepare', undefined, options), list: options => call('list', undefined, options), seal: (e, o) => call('seal', e, o),
    verify: (e, o) => call('verify', e, o), publish: (e, o) => call('publish', e, o), remove: (e, o) => call('remove', e, o) };
}

let defaultSecurity;
export function createWindowsTransport({ security = (defaultSecurity ??= createWindowsSecurity()), now = Date.now, discoveryMs = 4000 } = {}) {
  const entryOK = (entry, sid) => {
    try { return entry?.sid === sid && entry.pipe === pipeName(sid, entry.name) &&
      Number.isSafeInteger(entry.pid) && entry.pid > 0 && /^[a-f0-9]{32}$/.test(entry.token); } catch { return false; }
  };
  const verified = new Map();
  const signature = entry => `${entry.token}:${entry.pid}`;
  return {
    async discover({ connected = [] } = {}) {
      // Worker startup/compilation has its own budget, outside the whole-scan operation budget.
      await security.ready?.();
      const deadline = now() + discoveryMs;
      const bounded = async fn => {
        const timeoutMs = deadline - now();
        if (timeoutMs <= 0) throw new Error('Windows cursor discovery deadline exceeded');
        let timer;
        try {
          return await Promise.race([fn({ timeoutMs }), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Windows cursor discovery deadline exceeded')), timeoutMs);
          })]);
        } finally { clearTimeout(timer); }
      };
      const sid = await bounded(o => security.sid(o)); if (!validSid(sid)) return [];
      const entries = await bounded(o => security.list(o)), out = [];
      if (!Array.isArray(entries)) throw new Error('Invalid cursor registry listing');
      const present = new Set();
      for (const entry of entries.slice(0, 16)) {
        if (!entryOK(entry, sid)) continue;
        present.add(entry.pipe);
        // A scan cannot re-attest an already connected incarnation. Connect always validates again.
        const live = connected.some(p => p.path === entry.pipe && p.ino === entry.token && p.dev === entry.pid);
        let safe;
        try { safe = live || verified.get(entry.pipe) === signature(entry) || await bounded(o => security.verify(entry, o)) === true; }
        catch (error) { verified.delete(entry.pipe); if (now() >= deadline) throw error; continue; }
        if (safe) {
          verified.set(entry.pipe, signature(entry)); out.push({ ...entry, path: entry.pipe });
        } else {
          verified.delete(entry.pipe);
          try { await bounded(o => security.remove(entry, o)); } catch (error) { if (now() >= deadline) throw error; } // Token-matched stale marker only.
        }
      }
      for (const path of verified.keys()) if (!present.has(path)) verified.delete(path);
      return out;
    },
    invalidate(entry) { verified.delete(entry?.pipe ?? entry?.path); },
    async validate(entry) {
      try {
        const valid = entryOK(entry, await security.sid()) && await security.verify(entry) === true;
        if (!valid) verified.delete(entry?.pipe);
        return valid;
      } catch (error) { verified.delete(entry?.pipe); throw error; }
    },
    async listen(server, name) {
      const sid = await security.sid(), path = pipeName(sid, name);
      await security.prepare();
      const entry = { name, sid, pipe: path, pid: process.pid, token: randomBytes(16).toString('hex') };
      await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready);
        server.listen({ path, readableAll: false, writableAll: false });
      });
      try {
        if (await security.seal({ ...entry, sddl: pipeSecurityDescriptor(sid) }) !== true) throw new Error('Could not seal cursor pipe');
        if (await security.publish(entry) !== true) throw new Error('Could not publish cursor pipe');
      } catch (error) { server.close(); throw error; }
      return { path, remove: () => security.remove(entry) };
    },
  };
}
