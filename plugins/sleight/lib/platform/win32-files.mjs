// Fixed native ACL operations. JSON on stdin is data; no caller text becomes PowerShell source.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { win32 } from 'node:path';
import { gzipSync } from 'node:zlib';
import { win32Environment } from './paths.mjs';
import { withPreapprovedLock } from '../preapproved.mjs';

// Update from sha256sum plugins/sleight/lib/platform/win32-files.ps1 after reviewing the native changes.
const bootstrapSHA256 = 'ed1c4e20b3d726b3836f93dc3d31edcfe1236fbef8633865da3add1a89d1f5d6';
function fileCommand(worker = false, read = readFileSync) {
  const bytes = read(new URL('win32-files.ps1', import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== bootstrapSHA256) throw Error('Windows ACL bootstrap hash mismatch');
  const source = bytes.toString('utf8');
  // Compress only hash-verified source. Windows' 32,767-character CreateProcess limit includes the executable
  // and all flags; cap the encoded bootstrap at 22,000, leaving over 10,000 characters for that overhead.
  const compressed = gzipSync(Buffer.from((worker ? '$sleightWorker = $true\n' : '') + source)).toString('base64');
  const bootstrap = `$b=[Convert]::FromBase64String('${compressed}');$m=[IO.MemoryStream]::new($b);` +
    '$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);' +
    '$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);try { & ([scriptblock]::Create($r.ReadToEnd())) } finally { $r.Dispose() }';
  const encoded = Buffer.from(bootstrap, 'utf16le').toString('base64');
  if (encoded.length > 22000) throw Error('WINDOWS_FILE_COMMAND_BUDGET');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
}

export function windowsFileOperation(request, { platform = process.platform, run = execFileSync, environment, read = readFileSync } = {}) {
  if (platform !== 'win32') throw Error('WINDOWS_ONLY');
  const env = environment ?? win32Environment();
  const args = fileCommand(false, read);
  let reply;
  try { reply = JSON.parse(run(win32.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args, {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 20000, maxBuffer: 1048576,
      windowsHide: true, env, cwd: win32.join(env.SystemRoot, 'System32'), stdio: ['pipe', 'pipe', 'pipe'],
     killSignal: 'SIGKILL' }).replace(/^\uFEFF/, '')); }
  catch { throw Error('WINDOWS_FILE_UNSAFE'); }
  if (reply?.ok !== true) throw Error('WINDOWS_FILE_UNSAFE');
  return reply;
}

// One compiler/startup per session. Every request still checks native handles and their descriptors.
export function createWindowsFileWorker({ platform = process.platform, run = spawn, environment, read = readFileSync,
  startupMs = 20000, timeoutMs = 4000 } = {}) {
  let child, ready, pending, buffer = '', nextId = 0, closed = false, failed;
  let rejectReady, startupTimer, ended;
  const fail = error => {
    if (failed) return;
    failed = error; clearTimeout(startupTimer); rejectReady?.(error); rejectReady = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
    child?.stdin.destroy(); child?.kill();
  };
  function start() {
    if (platform !== 'win32' || closed || failed) throw failed ?? Error('WINDOWS_FILE_WORKER_UNAVAILABLE');
    if (ready) return ready;
    const env = environment ?? win32Environment();
    child = run(win32.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), fileCommand(true, read),
      { windowsHide: true, env, cwd: win32.join(env.SystemRoot, 'System32'), stdio: ['pipe', 'pipe', 'ignore'] });
    ended = new Promise(resolve => child.once('close', resolve));
    ready = new Promise((resolve, reject) => {
      rejectReady = reject;
      startupTimer = setTimeout(() => fail(Error('WINDOWS_FILE_STARTUP_TIMEOUT')), startupMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1048576) return fail(Error('WINDOWS_FILE_RESPONSE_BUDGET'));
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, end).replace(/^\uFEFF/, ''); buffer = buffer.slice(end + 1);
          let reply;
          try { reply = JSON.parse(line); } catch { return fail(Error('WINDOWS_FILE_INVALID_REPLY')); }
          if (rejectReady) {
            if (reply.ready !== true || Object.keys(reply).length !== 1) return fail(Error('WINDOWS_FILE_INVALID_READY'));
            clearTimeout(startupTimer); rejectReady = undefined; resolve(); continue;
          }
          const request = pending;
          if (!request || reply.id !== request.id || typeof reply.ok !== 'boolean') return fail(Error('WINDOWS_FILE_INVALID_REPLY'));
          pending = undefined; clearTimeout(request.timer);
          if (reply.ok) request.resolve(reply); else request.reject(Error('WINDOWS_FILE_UNSAFE'));
        }
      });
      for (const stream of [child, child.stdin, child.stdout]) stream.on('error', () => fail(Error('WINDOWS_FILE_WORKER_FAILED')));
      child.once('close', () => { if (!closed) fail(Error('WINDOWS_FILE_WORKER_EXITED')); });
    });
    return ready;
  }
  return {
    async operate(request) {
      await start();
      if (closed || failed) throw failed ?? Error('WINDOWS_FILE_WORKER_CLOSED');
      if (pending) throw Error('WINDOWS_FILE_WORKER_BUSY');
      return new Promise((resolve, reject) => {
        const id = ++nextId, timer = setTimeout(() => fail(Error('WINDOWS_FILE_TIMEOUT')), timeoutMs);
        pending = { id, timer, resolve, reject };
        child.stdin.write(JSON.stringify({ ...request, id }) + '\n');
      });
    },
    async close() {
      if (closed) return ended;
      closed = true;
      clearTimeout(startupTimer); rejectReady?.(Error('WINDOWS_FILE_WORKER_CLOSED')); rejectReady = undefined;
      if (pending) { clearTimeout(pending.timer); pending.reject(Error('WINDOWS_FILE_WORKER_CLOSED')); pending = undefined; }
      if (!child) return;
      const timer = setTimeout(() => child.kill(), 2000);
      child.stdin.end();
      try { await ended; } finally { clearTimeout(timer); }
    },
  };
}

const NAMES = new Set(['hand.json', 'turbo.json', 'permissions.json', 'preapproved.json', 'electron-grants.json', 'turbo-apps.json']);
export function createWindowsSettingsStore({ adapter, operate = windowsFileOperation } = {}) {
  const path = name => {
    if (!NAMES.has(name)) throw Error('WINDOWS_SETTING_INVALID');
    return adapter.join(adapter.paths().settings, name);
  };
  return {
    withPreapprovedLock(action) {
      // Absence is a no-op at this observation point. Node must never bootstrap a Windows settings root without its ACL.
      try { lstatSync(adapter.paths().settings); }
      catch (error) { if (error.code === 'ENOENT') return action({ absent: true }); throw error; }
      // The native reader proves the private parent and ACL before Node creates the adjacent lock.
      this.read('preapproved.json');
      return withPreapprovedLock(path('preapproved.json'), action, { timeoutMs: 30000, createParent: false });
    },
    read(name) {
      const file = path(name);
      const reply = operate({ operation: 'read', path: file });
      if (reply.absent === true) return undefined;
      try { return JSON.parse(reply.text); } catch { throw Error('WINDOWS_SETTING_INVALID'); }
    },
    repair(name) {
      if (name !== 'permissions.json') throw Error('WINDOWS_SETTING_INVALID');
      operate({ operation: 'repair', path: path(name) });
    },
    write(name, data, { replaceUnsafe = false } = {}) {
      if (replaceUnsafe && name !== 'hand.json') throw Error('WINDOWS_SETTING_INVALID');
      const file = path(name), text = JSON.stringify(data) + '\n';
      if (Buffer.byteLength(text) > 262144) throw Error('WINDOWS_SETTING_TOO_LARGE');
      const after = operate({ operation: replaceUnsafe ? 'replace' : 'write', path: file, text });
      if (after.text !== text) throw Error('WINDOWS_SETTING_READBACK');
    },
  };
}
