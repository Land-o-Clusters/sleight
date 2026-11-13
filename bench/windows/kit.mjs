// Guest-kit utilities. Importing this module never starts a process.
import { spawn as nodeSpawn } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import { lstatSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const isMain = url => !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url);

export function integer(value, min, max, name) {
  if (!/^\d+$/.test(String(value))) throw new Error(`Invalid ${name}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Invalid ${name}`);
  return number;
}

export function writeReport(path, report) {
  // Exclusive creation also refuses an existing symlink. The parent must already exist.
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export function checkReportPath(path) {
  try { lstatSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!statSync(dirname(resolve(path))).isDirectory()) throw new Error('Report parent must be a directory');
    return;
  }
  throw new Error('Report already exists; choose a new output name');
}

const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redactText(value, env = process.env) {
  let text = String(value ?? '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  if (env.USERPROFILE) {
    const pattern = env.USERPROFILE.split(/[\\/]/).map(escaped).join('[\\\\/]');
    text = text.replace(new RegExp(pattern + '(?=[\\\\/]|$)', 'gi'), '%USERPROFILE%');
  }
  // Also cover other users and DOS short profile names. Custom paths still need review.
  text = text.replace(/[a-z]:[\\/]Users[\\/][^\\/\s"<>:]+/gi, '%USERPROFILE%');
  for (const key of ['USERNAME', 'COMPUTERNAME']) {
    if (env[key]) {
      const token = '[\\p{L}\\p{N}]';
      text = text.replace(new RegExp(`(?<!${token})${escaped(env[key])}(?!${token})`, 'giu'), () => `%${key}%`);
    }
  }
  return text;
}

export function redactReport(value, env = process.env) {
  const scrub = (entry, root = false) => {
    if (typeof entry === 'string') return redactText(entry, env);
    if (Array.isArray(entry)) return entry.map(item => scrub(item));
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry)
      // Only the writers' top-level schema and verdict strings bypass scrubbing.
      .map(([key, item]) => [key, root && ['schema', 'verdict'].includes(key) && typeof item === 'string' ? item : scrub(item)]));
    return entry;
  };
  return scrub(value, true);
}

export function stderrTail(value, env = process.env) {
  const characters = Array.from(redactText(value, env));
  let bytes = 0, start = characters.length;
  while (start > 0 && bytes + Buffer.byteLength(characters[start - 1]) <= 512) bytes += Buffer.byteLength(characters[--start]);
  return characters.slice(start).join('');
}

export function runChild(command, args, { cwd = ROOT, env = process.env, input = '', timeout = 60_000,
  maxBytes = 4 * 1024 * 1024, windowsVerbatimArguments = false, lowPriority = false, normalPriority = false, onStderr, signal: abortSignal, platform = process.platform, spawn = nodeSpawn } = {}) {
  return new Promise(resolveResult => {
    const stdout = [], stderr = [];
    let stderrEnd = Buffer.alloc(0);
    let size = 0, reason = null, timer, cleanup = null, closed = false, settled = false, status = null, signal = null;
    const child = spawn(command, args, { cwd, env, windowsHide: true, windowsVerbatimArguments, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = () => {
      if (settled || (!closed && cleanup !== 'restore-required')) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      abortSignal?.removeEventListener('abort', abort);
      if (!closed) {
        // Only the VM restore owns guest cleanup. Release the local pipes.
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref?.();
      }
      resolveResult({ status, signal, reason, cleanup, stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: (reason === 'output-limit' ? stderrEnd : Buffer.concat(stderr)).toString('utf8') });
    };
    const stop = why => {
      if (reason || closed) return;
      reason = why;
      if (platform !== 'win32') { child.kill(); return; }
      cleanup = 'restore-required'; finish();
    };
    const interrupt = () => stop('interrupted');
    const abort = () => stop('aborted');
    abortSignal?.addEventListener('abort', abort, { once: true });
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    child.once('spawn', () => {
      if (lowPriority || normalPriority) {
        try { setPriority(child.pid, normalPriority ? constants.priority.PRIORITY_NORMAL : constants.priority.PRIORITY_LOW); }
        catch { stop('priority-failed'); }
      }
    });
    const collect = key => chunk => {
      if (key === 'stderr') stderrEnd = Buffer.concat([stderrEnd, chunk.subarray(-8192)]).subarray(-8192);
      size += chunk.length;
      if (size > maxBytes) { stop('output-limit'); return; }
      (key === 'stdout' ? stdout : stderr).push(chunk);
      if (key === 'stderr' && onStderr) onStderr(chunk.toString('utf8'));
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', () => {});
    child.once('error', () => { reason = 'spawn-failed'; });
    child.once('close', (code, receivedSignal) => {
      clearTimeout(timer);
      status = code; signal = receivedSignal; closed = true; finish();
    });
    timer = setTimeout(() => stop('timeout'), timeout);
    child.stdin.end(input);
    if (abortSignal?.aborted) abort();
  });
}
