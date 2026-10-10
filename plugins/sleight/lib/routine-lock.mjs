import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const aliveProcess = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

// One process only: with -ax, ps lists every process whatever -p says (849 lines here,
// 2026-10-10), so no stored start ever matched and a live owner's lock looked stale.
export function processStartTime(pid) {
  try {
    const text = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
    return text || undefined;
  } catch { return; }
}

export function sameProcessStart(stored, live) {
  if (!stored || !live) return false;
  if (stored === live) return true;
  const a = Date.parse(stored), b = Date.parse(live);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 2000;
}

// The kernel releases SQLite admission on death. Keep the owner receipt separate so
// an uncollected relay group still blocks recovery after its parent has crashed.
export function acquireRoutineLock({ directory, coordinator, alive = aliveProcess, started = processStartTime }) {
  const db = new DatabaseSync(coordinator);
  chmodSync(coordinator, 0o600);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
  catch (error) { db.close(); if (error.errcode === 5 || /locked|busy/i.test(error.message)) return null; throw error; }
  const unlock = () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
  const lock = join(directory, 'running'), file = join(lock, 'owner.json');
  try {
    if (existsSync(lock)) {
      let owner;
      try { owner = JSON.parse(readFileSync(file, 'utf8')); }
      catch { unlock(); return null; }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.startTime !== 'string' ||
          !Array.isArray(owner.groups) || owner.groups.some(pid => !Number.isSafeInteger(pid) || pid <= 0) ||
          owner.pendingLaunch) { unlock(); return null; }
      const live = alive(owner.pid);
      if (live && sameProcessStart(owner.startTime, started(owner.pid))) { unlock(); return null; }
      if (live && !started(owner.pid)) { unlock(); return null; }
      if (owner.groups.some(pid => alive(-pid))) { unlock(); return null; }
      rmSync(lock, { recursive: true });
    }
    mkdirSync(lock, { mode: 0o700 });
    const owner = { pid: process.pid, startTime: started(process.pid) ?? new Date(Date.now() - process.uptime() * 1000).toISOString(), groups: [], pendingLaunch: false };
    const save = () => writeFileSync(file, JSON.stringify(owner) + '\n', { mode: 0o600 });
    save();
    return {
      noteLaunching() { owner.pendingLaunch = true; save(); },
      addGroup(pid) { if (Number.isSafeInteger(pid) && pid > 0) { owner.groups.push(pid); owner.pendingLaunch = false; save(); } },
      release() { try { rmSync(lock, { recursive: true, force: true }); } finally { unlock(); } },
      preserve() { unlock(); },
    };
  } catch (error) { unlock(); throw error; }
}

export function clearRoutineLock({ directory, coordinator }) {
  const db = new DatabaseSync(coordinator);
  chmodSync(coordinator, 0o600);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
  catch (error) { db.close(); if (error.errcode === 5 || /locked|busy/i.test(error.message)) return false; throw error; }
  try {
    rmSync(join(directory, 'running'), { recursive: true, force: true });
    return true;
  } finally { try { db.exec('ROLLBACK'); } finally { db.close(); } }
}
