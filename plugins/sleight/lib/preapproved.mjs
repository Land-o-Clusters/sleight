import { platformPaths, platformJoin } from './platform/paths.mjs';
// Authority comes only from the OS user's private file, never project settings or HOME.
import * as fs from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { observeSettingsFile, readSettingsBytes, trustedSettingsContent, SETTINGS_BUILD_POLICY } from './sealed-settings.mjs';

const RISK = new Map([['low', 0], ['medium', 1], ['high', 2]]);
const error = message => new Error(`Preapproved apps: ${message}`);
const fields = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) &&
  Object.keys(object).every(key => keys.includes(key));

export class PreapprovedApps {
  #apps = new Map();
  duplicates = false;
  constructor(config) {
    if (!fields(config, ['version', 'apps']) || config.version !== 1 || !Array.isArray(config.apps)) {
      throw error('expected version 1 and an apps array');
    }
    for (const entry of config.apps) {
      // `added` and `source` record an "Always allow" click (owner, 2026-10-10); hand-written entries omit them.
      // 2.0 records `launchTeam`, the app's signing team. This version accepts it and grants nothing from it (owner, 2026-11-10).
      if (!fields(entry, ['app', 'riskLevel', 'added', 'source', 'launchTeam']) || typeof entry.app !== 'string' || !entry.app.trim() ||
          (entry.launchTeam !== undefined && !validLaunchTeam(entry.launchTeam)) ||
          (entry.added !== undefined && !/^\d{4}-\d\d-\d\d$/.test(entry.added)) ||
          (entry.source !== undefined && entry.source !== 'always-allow') ||
          entry.app !== entry.app.trim() || /[\u0000-\u001f\u007f*]/.test(entry.app) ||
          !RISK.has(entry.riskLevel)) throw error('invalid app entry');
      if (this.#apps.has(entry.app)) this.duplicates = true;
      this.#apps.set(entry.app, Math.min(this.#apps.get(entry.app) ?? Infinity, RISK.get(entry.riskLevel)));
    }
  }
  get size() { return this.#apps.size; }
  // The user's own "Always allow" click, applied for the rest of this session as well.
  add(app, riskLevel) {
    if (RISK.has(riskLevel) && RISK.get(riskLevel) > (this.#apps.get(app) ?? -1)) this.#apps.set(app, RISK.get(riskLevel));
  }
  // The listed apps, as a copy: reading it changes nothing.
  list() { return [...this.#apps.keys()]; }
  allows(app, riskLevel) {
    return this.#apps.has(app) && RISK.has(riskLevel) && RISK.get(riskLevel) <= this.#apps.get(app);
  }
}
// The values 2.0's writer records: `apple` or a 10-character Team ID.
const validLaunchTeam = team => typeof team === 'string' && /^(?:apple|[A-Z0-9]{10})$/.test(team);

// Duplicate IDs are valid only at their lowest ceiling. All other schema errors still reject the entire list.
// A rewrite keeps `launchTeam` only when every copy records the same team, as 2.0's cleaner does.
export function cleanPreapproved(config) {
  new PreapprovedApps(config);
  const entries = new Map(), teams = new Map();
  for (const entry of config.apps) {
    const before = entries.get(entry.app);
    teams.set(entry.app, before && teams.get(entry.app) !== entry.launchTeam ? undefined : entry.launchTeam);
    if (!before || RISK.get(entry.riskLevel) < RISK.get(before.riskLevel)) entries.set(entry.app, { ...entry });
  }
  return { version: 1, apps: [...entries.values()].map(entry => {
    if (teams.get(entry.app) === undefined) delete entry.launchTeam;
    return entry;
  }) };
}

// Conditional result text, pinned separately in prompt-budget.test.mjs. Healthy sessions emit no text.
export const PREAPPROVED_PROBLEM_NOTICE = 'Preapproved apps ignored. Every app asks. Rename ~/Library/Application Support/sleight/preapproved.json and allow apps again.';
export const PREAPPROVED_DUPLICATE_NOTICE = 'Duplicate apps in ~/Library/Application Support/sleight/preapproved.json use the lowest risk. Always allow cleans the list; sleight-mcp allow remove <app> removes every copy.';

// Only code supplies storage. No environment or HOME override can select approval authority.
export function sessionPreapproved(storage = { load: loadPreapproved, live: livePreapproved, add: addPreapproved }) {
  let initial, notice;
  try { initial = storage.load(); if (initial.duplicates) notice = PREAPPROVED_DUPLICATE_NOTICE; }
  catch { initial = new PreapprovedApps({ version: 1, apps: [] }); notice = PREAPPROVED_PROBLEM_NOTICE; }
  const preapproved = storage.live(initial);
  return { preapproved, appendNotice(message) {
    if (!notice || message?.method !== undefined || !Array.isArray(message?.result?.content)) return;
    message.result.content.push({ type: 'text', text: notice }); notice = undefined;
  } };
}

function validate(stat, uid) {
  if (stat.isSymbolicLink()) throw error('symlinks are refused');
  if (!stat.isFile()) throw error('expected a regular file');
  if (stat.nlink !== 1) throw error('hard links are refused');
  if (stat.uid !== uid) throw error('file owner must be the current user');
  if (stat.mode & 0o022) throw error('group- or world-writable files are refused');
  if (stat.size > 1024 * 1024) throw error('file exceeds 1 MiB');
}

// The optional filesystem boundary lets unit tests use private fixtures. Startup
// calls this with no arguments; there is no environment or settings path option.
export const preapprovedFile = (home = userInfo().homedir) => platformJoin()(platformPaths({ home }).settings, 'preapproved.json');

// The list's raw entries, for showing and editing. Missing means empty; anything invalid throws.
function readList(io, file, uid) {
  const verified = io === fs ? observeSettingsFile(file) : undefined;
  if (verified?.enforcing) {
    const data = JSON.parse(trustedSettingsContent(verified, 'preapproved.json', 'grant') ?? '{"version":1,"apps":[]}');
    new PreapprovedApps(data); return data;
  }
  let fd;
  try {
    let before;
    try { before = io.lstatSync(file); } catch (err) { if (err.code === 'ENOENT') return { version: 1, apps: [] }; throw err; }
    validate(before, uid);
    fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = io.fstatSync(fd);
    validate(opened, uid);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw error('file changed while opening');
    if (io.realpathSync(file) !== file) throw error('symlinked paths are refused');
    const config = JSON.parse(io === fs ? readSettingsBytes(file, () => io.readFileSync(fd, 'utf8')) : io.readFileSync(fd, 'utf8'));
    new PreapprovedApps(config); // validates
    return config;
  } finally { if (fd !== undefined) io.closeSync(fd); }
}

// Writes the whole list through a private temporary file and a rename, so a reader never sees half of it.
function writeList(io, file, config) {
  io.mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const bytes = JSON.stringify(cleanPreapproved(config), null, 2) + '\n';
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw error('file exceeds 1 MiB');
  let fd, created = false;
  try {
    fd = io.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    io.writeFileSync(fd, bytes);
    io.closeSync(fd); fd = undefined;
    io.renameSync(temp, file);
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    if (created) try { io.unlinkSync(temp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

// A process's birth second is shared with the native writer. Unknown identity never proves death.
function processStartFromText(text) {
  const time = Date.parse(text.trim() + ' GMT');
  return Number.isFinite(time) ? String(Math.floor(time / 1000)) : undefined;
}
export function preapprovedProcessStart(pid) {
  try {
    const text = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' }, encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return processStartFromText(text);
  } catch { return undefined; }
}
function preapprovedProcessStartAsync(pid, until) {
  return new Promise(resolve => {
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' }, encoding: 'utf8',
      timeout: Math.max(1, Math.min(1000, until - Date.now())), killSignal: 'SIGKILL',
    }, (err, stdout) => resolve(err ? undefined : processStartFromText(stdout)));
  });
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const lockError = (lock, reason) => error(`${reason}: ${lock}. After stopping approval writers, clear it with: rm -f -- ${quote(lock)} ${quote(lock + '.reclaim')}`);
function* gone(owner, until) {
  try { process.kill(owner.pid, 0); }
  catch (err) { return err.code === 'ESRCH'; }
  const current = typeof owner.startTime === 'string' && /^[1-9][0-9]{0,15}$/.test(owner.startTime)
    ? yield { processStart: owner.pid, until } : undefined;
  return current !== undefined && current !== owner.startTime;
}
function lockStat(io, path, uid, limit = 1024) {
  const stat = io.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit ||
      process.platform !== 'win32' && (stat.uid !== uid || (stat.mode & 0o777) !== 0o600)) throw lockError(path.replace(/\.reclaim$/, ''), 'unreadable or unsafe writer lock');
  return stat;
}
function runAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, timeout: 1000, killSignal: 'SIGKILL' });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(error(`recovery lock refused (${code ?? signal})`)));
  });
}
// lockf's descriptor mode acquires flock on the parent's open file description. Closing the parent's fd releases it.
// The recovery inode stays in place, so even an empty legacy .reclaim cannot strand recovery after a crash.
function recoveryGuard(lock, io, uid) {
  const guard = lock + '.reclaim';
  let fd;
  // Preserve the legacy exclusive guard on parked platforms without a reviewed flock utility.
  if (!['darwin', 'linux'].includes(process.platform)) {
    try {
      fd = io.openSync(guard, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      return { fd, exclusive: true, guard, owned: io.fstatSync(fd) };
    } catch (err) {
      if (fd !== undefined) io.closeSync(fd);
      if (err.code === 'EEXIST') return undefined;
      throw lockError(lock, 'unreadable or unsafe writer lock');
    }
  }
  try {
    fd = io.openSync(guard, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    const before = lockStat(io, guard, uid, Infinity), opened = io.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== before.uid || opened.mode !== before.mode) throw lockError(lock, 'writer recovery lock changed');
    const args = process.platform === 'darwin' ? ['/usr/bin/lockf', ['-s', '-t', '0', '3']] :
      process.platform === 'linux' ? ['/usr/bin/flock', ['-n', '3']] : undefined;
    if (!args) throw lockError(lock, 'writer lock recovery unavailable');
    return { fd, command: args, options: { timeout: 1000, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'ignore', fd] } };
  } catch (err) { if (fd !== undefined) io.closeSync(fd); throw lockError(lock, 'unreadable or unsafe writer lock'); }
}
function* acquirePreapprovedLock(file, { io = fs, uid = userInfo().uid, timeoutMs = 5000, createParent = true } = {}) {
  const folder = join(file, '..');
  if (createParent) io.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const parent = io.lstatSync(folder);
  if (!parent.isDirectory() || parent.isSymbolicLink() || io.realpathSync(folder) !== folder ||
      process.platform !== 'win32' && (parent.uid !== uid || parent.mode & 0o022)) throw error('unsafe settings folder');
  const lock = file + '.lock', until = Date.now() + timeoutMs;
  const startTime = yield { processStart: process.pid, until };
  while (true) {
    let fd, owned;
    try {
      fd = io.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      owned = io.fstatSync(fd);
      io.writeFileSync(fd, JSON.stringify({ pid: process.pid, startTime, token: randomUUID() }));
      return () => {
        io.closeSync(fd);
        try { const current = io.lstatSync(lock); if (current.dev === owned.dev && current.ino === owned.ino) io.unlinkSync(lock); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
      };
    } catch (err) {
      if (fd !== undefined) { io.closeSync(fd); try { io.unlinkSync(lock); } catch {} throw err; }
      if (err.code !== 'EEXIST') throw lockError(lock, 'cannot open writer lock');
    }
    let ownerFD;
    try {
      const before = lockStat(io, lock, uid);
      ownerFD = io.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const opened = io.fstatSync(ownerFD);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode || opened.uid !== before.uid) continue;
      let owner;
      try { owner = JSON.parse(io.readFileSync(ownerFD, 'utf8')); } catch {}
      if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.pid <= 2147483647 && (yield* gone(owner, until))) {
        if (Date.now() >= until) throw lockError(lock, 'writer busy; retry the change');
        const guard = recoveryGuard(lock, io, uid);
        if (!guard) { yield { wait: 10 }; continue; }
        try {
          if (guard.exclusive || (yield guard)) {
            const current = io.lstatSync(lock);
            if (current.dev === before.dev && current.ino === before.ino) io.unlinkSync(lock);
          }
        } finally {
          io.closeSync(guard.fd);
          if (guard.exclusive) {
            try { const current = io.lstatSync(guard.guard); if (current.dev === guard.owned.dev && current.ino === guard.owned.ino) io.unlinkSync(guard.guard); }
            catch (err) { if (err.code !== 'ENOENT') throw err; }
          }
        }
        continue;
      }
      if (Date.now() >= until) throw lockError(lock, owner?.pid ? 'writer busy; retry the change' : 'unreadable or unsafe writer lock');
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    finally { if (ownerFD !== undefined) io.closeSync(ownerFD); }
    if (Date.now() >= until) throw lockError(lock, 'writer busy; retry the change');
    yield { wait: Math.min(10, Math.max(1, until - Date.now())) };
  }
}
export function withPreapprovedLock(file, action, options) {
  const acquire = acquirePreapprovedLock(file, options), wait = new Int32Array(new SharedArrayBuffer(4));
  let step, acquired;
  try {
    while (!(step = acquire.next(acquired)).done) {
      acquired = false;
      if (step.value.processStart) acquired = preapprovedProcessStart(step.value.processStart);
      else if (step.value.command) {
        try { execFileSync(...step.value.command, { ...step.value.options, timeout: 1000, killSignal: 'SIGKILL' }); acquired = true; } catch { Atomics.wait(wait, 0, 0, 10); }
      } else Atomics.wait(wait, 0, 0, step.value.wait);
    }
    try { return action(); } finally { step.value(); }
  } finally { acquire.return(); }
}
export async function withPreapprovedLockAsync(file, action, options) {
  const acquire = acquirePreapprovedLock(file, options);
  let step, acquired;
  try {
    while (!(step = acquire.next(acquired)).done) {
      acquired = false;
      if (step.value.processStart) acquired = await preapprovedProcessStartAsync(step.value.processStart, step.value.until);
      else if (step.value.command) { try { await runAsync(...step.value.command, step.value.options); acquired = true; } catch { await delay(10); } }
      else await delay(step.value.wait);
    }
    try { return await action(); } finally { step.value(); }
  } finally { acquire.return(); }
}

// The user clicked "Always allow" for this app: add it at the request's risk level with the date,
// or raise a lower level already listed. Only sleight's approval prompt calls this, never Claude.
export function addPreapproved(app, riskLevel, options = {}) { return editPreapproved(app, riskLevel, options, withPreapprovedLock); }
export function addPreapprovedAsync(app, riskLevel, options = {}) {
  const { io = fs, home = userInfo().homedir, uid = userInfo().uid } = options;
  const initial = cleanPreapproved(readList(io, preapprovedFile(home), uid)).apps.find(entry => entry.app === app);
  return editPreapproved(app, riskLevel, options, withPreapprovedLockAsync, RISK.get(initial?.riskLevel));
}
function editPreapproved(app, riskLevel, { io = fs, home = userInfo().homedir, uid = userInfo().uid, now = new Date() }, lock, initialCeiling) {
  if (typeof app !== 'string' || !app.trim() || !RISK.has(riskLevel)) throw error('invalid app or risk level');
  const file = preapprovedFile(home);
  return lock(file, () => {
    const raw = readList(io, file, uid), config = cleanPreapproved(raw);
    const existing = config.apps.find(entry => entry.app === app);
    // A revoke or reduction during asynchronous contention must not be undone by the earlier click.
    if (initialCeiling !== undefined && (RISK.get(existing?.riskLevel) ?? -1) < initialCeiling) {
      throw error('approval changed while waiting; click Always allow again');
    }
    if (existing && RISK.get(existing.riskLevel) >= RISK.get(riskLevel)) {
      if (raw.apps.length !== config.apps.length) writeList(io, file, config);
      return false;
    }
    if (existing) existing.riskLevel = riskLevel;
    else config.apps.push({ app, riskLevel, added: now.toISOString().slice(0, 10), source: 'always-allow' });
    writeList(io, file, config);
    return true;
  }, { io, uid });
}

export function removePreapproved(app, { io = fs, home = userInfo().homedir, uid = userInfo().uid } = {}) {
  const file = preapprovedFile(home);
  return withPreapprovedLock(file, () => {
    const config = readList(io, file, uid);
    const kept = config.apps.filter(entry => entry.app !== app);
    if (kept.length === config.apps.length) return false;
    writeList(io, file, { ...config, apps: kept });
    return true;
  }, { io, uid });
}

export function removeAllPreapproved({ io = fs, home = userInfo().homedir, uid = userInfo().uid } = {}) {
  const file = preapprovedFile(home);
  return withPreapprovedLock(file, () => {
    const config = readList(io, file, uid), count = new PreapprovedApps(config).size;
    if (count) writeList(io, file, { version: 1, apps: [] });
    return count;
  }, { io, uid });
}

export function listPreapproved({ io = fs, home = userInfo().homedir, uid = userInfo().uid } = {}) {
  return cleanPreapproved(readList(io, preapprovedFile(home), uid)).apps;
}

export function preapprovedStatus({ io = fs, home = userInfo().homedir, uid = userInfo().uid } = {}) {
  const raw = readList(io, preapprovedFile(home), uid);
  return { apps: cleanPreapproved(raw).apps, notice: new PreapprovedApps(raw).duplicates ? PREAPPROVED_DUPLICATE_NOTICE : undefined };
}

export function preapprovedDoctorLine(io) {
  try {
    const list = loadPreapproved(io);
    return list.duplicates ? 'PROBLEM   ' + PREAPPROVED_DUPLICATE_NOTICE : `preapproved ${list.size} apps`;
  } catch { return 'PROBLEM   ' + PREAPPROVED_PROBLEM_NOTICE; }
}

// The list as a running session sees it: loaded again whenever the file changes (a revoke from sleight's menu or
// `sleight-mcp permissions`, `allow remove`, or the user's own edit), so a removal applies at once in every session. A file
// that turns unreadable or unsafe mid-session allows nothing from the list, and every app asks. onRemoved(listener) hears
// the apps a reload took off, so the relay can drop this session's approvals for them too.
export function livePreapproved(initial, { io = fs, file = preapprovedFile(), load = () => loadPreapproved(io) } = {}) {
  const statKey = path => { try { const s = io.lstatSync(path); return [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':'); } catch (err) { return err.code ?? 'error'; } };
  const key = () => statKey(file) + (SETTINGS_BUILD_POLICY.enforce && io === fs ? '|' + statKey(file + '.seal') : '');
  const listeners = new Set();
  let apps = initial, seen = key();
  const fresh = () => {
    const now = key();
    if (now !== seen) {
      seen = now;
      const before = apps.list();
      try { apps = load(); } catch { apps = new PreapprovedApps({ version: 1, apps: [] }); }
      const after = new Set(apps.list()), removed = before.filter(app => !after.has(app));
      if (removed.length) for (const listener of listeners) { try { listener(removed); } catch {} }
    }
    return apps;
  };
  return Object.freeze({ get size() { return fresh().size; }, add: (app, riskLevel) => fresh().add(app, riskLevel),
    list: () => fresh().list(), allows: (app, riskLevel) => fresh().allows(app, riskLevel), onRemoved: listener => { listeners.add(listener); } });
}

export function loadPreapproved(io = fs, { seals } = {}) {
  let fd;
  try {
    const user = userInfo();
    const file = preapprovedFile(user.homedir);
    const verified = seals ?? (io === fs ? observeSettingsFile(file) : undefined);
    if (verified?.enforcing) return new PreapprovedApps(JSON.parse(trustedSettingsContent(verified, 'preapproved.json', 'grant') ?? '{"version":1,"apps":[]}'));
    let before;
    try { before = io.lstatSync(file); } catch (err) {
      if (err.code === 'ENOENT') return new PreapprovedApps({ version: 1, apps: [] });
      throw err;
    }
    validate(before, user.uid);
    if (io.realpathSync(file) !== file) throw error('symlinked paths are refused');
    fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = io.fstatSync(fd);
    validate(opened, user.uid);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw error('file changed while opening');
    return new PreapprovedApps(JSON.parse(io === fs ? readSettingsBytes(file, () => io.readFileSync(fd, 'utf8')) : io.readFileSync(fd, 'utf8')));
  } catch (err) { throw err.message.startsWith('Preapproved apps:') ? err : error(err.message); }
  finally { if (fd !== undefined) io.closeSync(fd); }
}
