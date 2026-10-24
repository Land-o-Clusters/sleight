// Copied to a stable user-data path at explicit installation; no versioned imports.
import { readFileSync, statSync, lstatSync, existsSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Kept self-contained because launchd runs a copy of this module without its neighbours.
function ordinary(path) {
  for (let at = resolve(path); dirname(at) !== at; at = dirname(at)) {
    try { if (lstatSync(at).isSymbolicLink()) throw Error('scheduled storage refuses symlinks'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path;
}

export function queueWatchNotice(directory, error) {
  const pending = ordinary(join(directory, 'notice-pending.json'));
  const temporary = ordinary(join(directory, `notice-pending.${randomUUID()}.tmp`));
  try {
    writeFileSync(temporary, JSON.stringify({ error }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, pending);
  } finally { rmSync(temporary, { force: true }); }
}

// Reserve before attempting delivery. A failed delivery or crash cannot flood the next tick.
// A stale admission directory suppresses notices until removal, rather than risking duplicates.
export function claimWatchNotice(directory, at = Date.now()) {
  const admission = ordinary(join(directory, 'notice.lock')), marker = ordinary(join(directory, 'notice.json'));
  try { mkdirSync(admission, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  const temporary = ordinary(join(directory, `notice.${randomUUID()}.tmp`));
  try {
    if (!Number.isFinite(at)) throw Error('invalid notice time');
    if (existsSync(marker)) {
      const last = JSON.parse(readFileSync(marker, 'utf8')).at;
      if (!Number.isFinite(last)) throw Error('invalid notice marker');
      if (at - last < 3600000) return false;
    }
    writeFileSync(temporary, JSON.stringify({ at }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, marker);
    return true;
  } finally {
    rmSync(temporary, { force: true }); rmSync(admission, { recursive: true });
  }
}

export function resolveInstall(home = userInfo().homedir) {
  const registry = JSON.parse(readFileSync(join(home, '.claude/plugins/installed_plugins.json'), 'utf8'));
  const entries = (registry.plugins?.['sleight@sleight'] ?? []).filter(entry => entry.scope === 'user');
  if (entries.length !== 1 || typeof entries[0].installPath !== 'string') throw new Error('current user Sleight install is missing or ambiguous in the plugin registry');
  const root = entries[0].installPath;
  if (resolve(root) !== root) throw new Error('plugin install path must be absolute');
  for (const candidate of [join(root, 'bin/sleight-mcp'), join(root, 'plugins/sleight/bin/sleight-mcp')]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('current Sleight install has no launcher');
}
async function notifyFailure(message) {
  await promisify(execFile)('/usr/bin/osascript', ['-e',
    `display notification ${JSON.stringify(message)} with title "sleight routine could not start"`], { timeout: 5000 });
}
export async function launchRoutine(id, { home = userInfo().homedir, notify = notifyFailure, spawnChild = spawn, kind = 'routine' } = {}) {
  let directory;
  try {
    if (!/^[a-f0-9]{20}$/.test(id ?? '')) throw new Error('invalid routine ID');
    if (!['routine', 'watch'].includes(kind)) throw new Error('invalid scheduled task kind');
    if (kind === 'watch') {
      directory = ordinary(join(home, 'Library/Application Support/sleight/watches', id));
      // The installed CLI must still see paused watches so expiry and reboot cleanup can run.
    }
    const bin = resolveInstall(home);
    const child = spawnChild(bin, [kind, 'run-now', id, '--scheduled'], { stdio: 'inherit' });
    return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
  } catch (error) {
    process.stderr.write(`sleight: current plugin install or registry unavailable: ${error.message}\n`);
    try {
      if (kind === 'watch') {
        if (!directory || !existsSync(directory)) return 1;
        const paused = ordinary(join(directory, 'paused.json'));
        try {
          writeFileSync(paused, JSON.stringify({ ok: false, error: 'WATCH_INSTALL_MISSING' }) + '\n', { flag: 'wx', mode: 0o600 });
          queueWatchNotice(directory, 'WATCH_INSTALL_MISSING');
        } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
        const pending = ordinary(join(directory, 'notice-pending.json'));
        if (JSON.parse(readFileSync(paused, 'utf8')).error !== 'WATCH_INSTALL_MISSING' || !existsSync(pending) ||
            JSON.parse(readFileSync(pending, 'utf8')).error !== 'WATCH_INSTALL_MISSING') return 1;
        if (!claimWatchNotice(directory)) return 1;
        rmSync(pending, { force: true });
        await notify('Watch paused: the current sleight plugin install is unavailable. Check the installation, then use watch run-now.');
      } else await notify(`Current plugin install or registry unavailable: ${error.message}`);
    }
    catch (failure) { process.stderr.write(`sleight: notification failed: ${failure.message}\n`); }
    return 1;
  }
}
// This file is copied alone to Application Support, so it must have no relative imports.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await launchRoutine(process.argv[2], { kind: process.argv[3] ?? 'routine' });
