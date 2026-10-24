// Copied to a stable user-data path at explicit installation; no versioned imports.
import { readFileSync, statSync, lstatSync, existsSync, writeFileSync, mkdirSync, rmSync, renameSync, readdirSync, appendFileSync, chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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
      let last;
      try { last = JSON.parse(readFileSync(marker, 'utf8'))?.at; } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (Number.isFinite(last) && at - last < 3600000) return false;
    }
    writeFileSync(temporary, JSON.stringify({ at }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, marker);
    return true;
  } finally {
    rmSync(temporary, { force: true }); rmSync(admission, { recursive: true });
  }
}

function watchPaths(home, id) {
  if (!/^[a-f0-9]{20}$/.test(id ?? '')) throw Error('invalid watch ID');
  const root = ordinary(join(home, 'Library/Application Support/sleight/watches'));
  const label = `com.landoclusters.sleight-watch-${id}`;
  return { root, label, directory: ordinary(join(root, id)), marker: ordinary(join(root, `.retiring-${id}.json`)),
    plist: ordinary(join(home, 'Library/LaunchAgents', `${label}.plist`)),
    log: ordinary(join(home, 'Library/Logs/sleight/watches', `${id}.jsonl`)) };
}
function privateJSON(path, value) {
  const temporary = ordinary(`${path}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, ordinary(path));
  } finally { rmSync(temporary, { force: true }); }
}
const bootout = args => promisify(execFile)('/bin/launchctl', args, { timeout: 10000 });

// Serialize retirement, sweeps and reinstallations. SQLite releases admission on self-bootout.
export async function withWatchLifecycle(home, id, action) {
  const { root } = watchPaths(home, id), locks = ordinary(join(root, '.locks'));
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  const coordinator = ordinary(join(locks, `retirement-${id}.sqlite`));
  const db = new DatabaseSync(coordinator); chmodSync(coordinator, 0o600);
  try {
    try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
    catch (error) { if (error.errcode === 5 || /locked|busy/i.test(error.message)) throw Error('WATCH_LIFECYCLE_BUSY'); throw error; }
    try { return await action(); } finally { db.exec('ROLLBACK'); }
  } finally { db.close(); }
}

// This must also work from the copied launcher when the plugin has been uninstalled.
export async function retireWatch(id, { home = userInfo().homedir, result, launchctl = bootout,
  notify = async () => {}, now = Date.now } = {}) {
  return withWatchLifecycle(home, id, async () => {
    const paths = watchPaths(home, id);
    const receipt = value => {
      mkdirSync(dirname(paths.log), { recursive: true, mode: 0o700 });
      appendFileSync(paths.log, JSON.stringify({ at: new Date(now()).toISOString(), id, result: value }) + '\n', { mode: 0o600 });
    };
    let pending;
    if (existsSync(paths.marker)) {
      try { pending = JSON.parse(readFileSync(paths.marker, 'utf8')); } catch { /* A damaged tombstone still needs bootout. */ }
    } else if (!existsSync(paths.directory)) return { ok: false, error: 'WATCH_NOT_FOUND' };
    else {
      const error = /^WATCH_[A-Z_]+$/.test(result?.error) ? result.error : 'WATCH_REMOVED';
      pending = { ok: false, error, ...(Number.isSafeInteger(result?.missingTabs) && result.missingTabs > 0 ? { missingTabs: result.missingTabs } : {}) };
      // Persist the once-only decision before attempting delivery, then delete all installed files.
      privateJSON(paths.marker, pending);
      if (!result?.noticeAttempted) {
        try { if (claimWatchNotice(paths.directory, now())) await notify(`Watch retired (${error}).`); } catch { /* Delivery cannot prevent retirement. */ }
      }
    }
    pending = { ok: false, error: /^WATCH_[A-Z_]+$/.test(pending?.error) ? pending.error : 'WATCH_REMOVED',
      ...(Number.isSafeInteger(pending?.missingTabs) && pending.missingTabs > 0 ? { missingTabs: pending.missingTabs } : {}) };
    rmSync(paths.plist, { force: true });
    rmSync(paths.directory, { recursive: true, force: true });
    receipt({ ...pending, installationRemoved: true, bootout: 'pending' });
    try { await launchctl(['bootout', `gui/${process.getuid()}/${paths.label}`]); }
    catch (error) {
      if (error.code !== 3) {
        const unconfirmed = { ok: false, error: 'WATCH_REMOVAL_UNCONFIRMED', installationRemoved: true, removed: false };
        receipt(unconfirmed); return unconfirmed;
      }
    }
    rmSync(paths.marker, { force: true });
    const removed = { ...pending, removed: true }; receipt(removed); return removed;
  });
}

export async function sweepRetiredWatches({ home = userInfo().homedir, launchctl = bootout, now = Date.now } = {}) {
  const root = watchPaths(home, '0'.repeat(20)).root;
  if (!existsSync(root)) return;
  for (const file of readdirSync(root)) {
    const id = /^\.retiring-([a-f0-9]{20})\.json$/.exec(file)?.[1];
    if (!id) continue;
    try { await retireWatch(id, { home, launchctl, now }); }
    catch (error) { if (error.message !== 'WATCH_LIFECYCLE_BUSY') throw error; }
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
export async function launchRoutine(id, { home = userInfo().homedir, notify = notifyFailure, spawnChild = spawn, kind = 'routine',
  launchctl = bootout, now = Date.now } = {}) {
  let directory;
  try {
    if (!/^[a-f0-9]{20}$/.test(id ?? '')) throw new Error('invalid routine ID');
    if (!['routine', 'watch'].includes(kind)) throw new Error('invalid scheduled task kind');
    if (kind === 'watch') {
      directory = ordinary(join(home, 'Library/Application Support/sleight/watches', id));
      await sweepRetiredWatches({ home, launchctl, now });
      if (!existsSync(directory)) return 1;
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
        let previous;
        try { previous = JSON.parse(readFileSync(paused, 'utf8'))?.error; }
        catch (failure) { if (failure.code !== 'ENOENT' && !(failure instanceof SyntaxError)) throw failure; }
        if (previous !== 'WATCH_INSTALL_MISSING') {
          privateJSON(paused, { ok: false, error: 'WATCH_INSTALL_MISSING' });
          queueWatchNotice(directory, 'WATCH_INSTALL_MISSING');
        }
        const pending = ordinary(join(directory, 'notice-pending.json'));
        if (JSON.parse(readFileSync(paused, 'utf8')).error !== 'WATCH_INSTALL_MISSING' || !existsSync(pending) ||
            JSON.parse(readFileSync(pending, 'utf8')).error !== 'WATCH_INSTALL_MISSING') return 1;
        if (!claimWatchNotice(directory, now())) return 1;
        rmSync(pending, { force: true });
        try { await notify('Watch retired: the current sleight plugin install is unavailable. Reinstall the plugin and create a new public watch.'); }
        finally { await retireWatch(id, { home, launchctl, now, result: { error: 'WATCH_INSTALL_MISSING', noticeAttempted: true } }); }
      } else await notify(`Current plugin install or registry unavailable: ${error.message}`);
    }
    catch (failure) { process.stderr.write(`sleight: notification failed: ${failure.message}\n`); }
    return 1;
  }
}
// This file is copied alone to Application Support, so it must have no relative imports.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await launchRoutine(process.argv[2], { kind: process.argv[3] ?? 'routine' });
