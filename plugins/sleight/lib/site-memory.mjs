// Generated hints from opt-in action-log annotations. No values, selectors, URLs beyond the origin, or free text.
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { ActionLog, actionLogPath } from './action-outcomes.mjs';

// A closed vocabulary, independent of page spelling. These are control words, never instructions or field labels.
export const RECIPE_NAMES = Object.freeze(['More', 'Export', 'Options', 'Settings', 'File', 'Edit', 'View', 'Tools', 'Help', 'Open', 'Close', 'Cancel',
  'Done', 'Next', 'Back', 'Search', 'Find', 'Copy', 'Print', 'Download', 'Refresh', 'Preview']);
const ROLES = new Set(['button', 'menuitem', 'tab']);
const BYTES = 131072;
const RETENTION = 90 * 86400000;
const unsafe = () => Error('SITE_MEMORY_UNSAFE');
const LOCK_TIMEOUT = 30000, emptyEpochs = new Map();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
function ownedFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw unsafe();
  return stat;
}
function memoryError(code, path) {
  return Object.assign(Error(code), { line: code === 'SITE_MEMORY_BUSY'
    ? `${path} is busy. Retry sleight-mcp permissions memory clear all after the writer exits or its 30 s lock expires.\n`
    : `${path} is unreadable or unsafe. sleight-mcp permissions memory clear all removes an owned ordinary store; repair linked paths, folder permissions or a wrong owner first.\n` });
}
export const siteMemoryPath = (home = userInfo().homedir) => join(home, 'Library', 'Application Support', 'sleight', 'site-memory.json');
export function recipeOrigin(value) {
  try {
    if (typeof value !== 'string' || value.length > 256 || !/^https?:\/\/(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:.]+\])(?::\d{1,5})?$/.test(value)) return;
    const url = new URL(value);
    return url.origin === value ? value : undefined;
  } catch { return; }
}
export function recipeControl(value) {
  if (!value || !ROLES.has(value.role) || value.secure || typeof value.name !== 'string' || value.name.length > 24) return;
  const name = RECIPE_NAMES.find(name => name.toLowerCase() === value.name.toLowerCase().replace(/(?:…|\.\.\.)$/, '').trim());
  return name ? { role: value.role, name } : undefined;
}
function recipe(value) {
  const target = recipeControl(value?.target), via = value?.via === undefined ? undefined : recipeControl(value.via);
  if (!target || value.via !== undefined && !via) return;
  return { target, ...(via ? { via } : {}) };
}
export const recipeLine = value => `${value.target.role} ${JSON.stringify(value.target.name)}` +
  (value.via ? ` after ${value.via.role} ${JSON.stringify(value.via.name)}` : '');

export class SiteMemory {
  constructor({ home = userInfo().homedir, log, now = Date.now } = {}) { this.path = siteMemoryPath(home); this.log = log; this.now = now; }
  empty() {
    // A file deleted by another session must not reuse this process's initial absent-store generation.
    if (!emptyEpochs.has(this.path) || emptyEpochs.get(this.path).present) emptyEpochs.set(this.path, { epoch: randomUUID(), present: false });
    return { version: 1, epoch: emptyEpochs.get(this.path).epoch, origins: [] };
  }
  directory(create = false) {
    const dir = dirname(this.path);
    if (create) {
      // Prove the nearest existing ancestor before mkdir can follow it outside the account's ordinary folders.
      let at = dir;
      for (;;) {
        try {
          const parent = lstatSync(at);
          if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o022 || realpathSync(at) !== at) throw unsafe();
          break;
        } catch (error) { if (error.code !== 'ENOENT' || dirname(at) === at) throw error; at = dirname(at); }
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o022 || realpathSync(dir) !== dir) throw unsafe();
  }
  read() {
    let fd;
    try {
      this.directory();
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > BYTES) throw unsafe();
      const data = JSON.parse(readFileSync(fd, 'utf8'));
      if (data?.version !== 1 || !/^(?:0|[a-f0-9-]{36})$/.test(data.epoch) || !Array.isArray(data.origins) || data.origins.length > 64 ||
          Object.keys(data).some(k => !['version', 'epoch', 'origins'].includes(k))) throw unsafe();
      const seen = new Set();
      let expired = false;
      for (const entry of data.origins) {
        if (!recipeOrigin(entry?.origin) || seen.has(entry.origin) || !Array.isArray(entry.recipes) || entry.recipes.length > 20 ||
            Object.keys(entry).some(k => !['origin', 'recipes'].includes(k))) throw unsafe();
        seen.add(entry.origin);
        for (const item of entry.recipes) {
          const { lastUsed, ...control } = item ?? {};
          if (JSON.stringify(recipe(control)) !== JSON.stringify(control) || lastUsed !== undefined && !(Number.isSafeInteger(lastUsed) && lastUsed >= 0)) throw unsafe();
          // Existing v1 recipes start their retention window at the last file write, without extending it on reads.
          item.lastUsed = lastUsed ?? Math.floor(stat.mtimeMs);
        }
        const active = entry.recipes.filter(item => this.now() - item.lastUsed < RETENTION);
        if (active.length !== entry.recipes.length) expired = true;
        entry.recipes = active;
      }
      data.origins = data.origins.filter(entry => entry.recipes.length);
      Object.defineProperty(data, 'expired', { value: expired });
      emptyEpochs.set(this.path, { epoch: data.epoch, present: true });
      return data;
    } catch (error) { if (error.code === 'ENOENT') return this.empty(); throw memoryError('SITE_MEMORY_UNSAFE', this.path); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  // Reclaim only an owned ordinary stale lock, with its identity checked again before removal.
  acquire() {
    const deadline = performance.now() + 200, waiting = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try { return this.tryAcquire(); }
      catch (error) {
        if (error.message !== 'SITE_MEMORY_BUSY' || performance.now() >= deadline) throw error;
        Atomics.wait(waiting, 0, 0, Math.min(10, deadline - performance.now()));
      }
    }
  }
  tryAcquire() {
    const lock = this.path + '.lock', flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    let fd;
    try { fd = openSync(lock, flags, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw memoryError('SITE_MEMORY_UNSAFE', lock);
      let reader;
      try {
        const stat = ownedFile(lock);
        if (Date.now() - stat.mtimeMs <= LOCK_TIMEOUT) {
          reader = openSync(lock, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          if (!sameFile(stat, fstatSync(reader))) throw unsafe();
          let pid, dead = false;
          if (stat.size <= 1024) try { pid = JSON.parse(readFileSync(reader, 'utf8')).pid; } catch {}
          if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
          if (!dead) throw memoryError('SITE_MEMORY_BUSY', lock);
        }
        if (!sameFile(stat, ownedFile(lock))) throw memoryError('SITE_MEMORY_BUSY', lock);
        unlinkSync(lock);
      } catch (error) { throw error.line ? error : memoryError(error.code === 'ENOENT' ? 'SITE_MEMORY_BUSY' : 'SITE_MEMORY_UNSAFE', lock); }
      finally { if (reader !== undefined) closeSync(reader); }
      try { fd = openSync(lock, flags, 0o600); } catch { throw memoryError('SITE_MEMORY_BUSY', lock); }
    }
    const held = { fd, lock, stat: fstatSync(fd) };
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); return held; }
    catch { this.release(held); throw memoryError('SITE_MEMORY_BUSY', lock); }
  }
  release({ fd, lock, stat }) {
    closeSync(fd);
    try { if (sameFile(stat, ownedFile(lock))) unlinkSync(lock); } catch {}
  }
  // Optional updates try once; only an explicit clear waits for another writer. Every update rereads under the lock.
  update(change, { wait = false } = {}) {
    try { this.directory(true); } catch { throw memoryError('SITE_MEMORY_UNSAFE', this.path); }
    const held = wait ? this.acquire() : this.tryAcquire(), temp = this.path + '.' + randomUUID() + '.tmp';
    try {
      const data = this.read(), result = change(data);
      if (result === false) return false;
      let bytes = JSON.stringify(data) + '\n';
      // Origin order is least to most recently used. Keep the newest origin when either bound fills.
      while (Buffer.byteLength(bytes) > BYTES && data.origins.length > 1) {
        data.origins.shift(); bytes = JSON.stringify(data) + '\n';
      }
      if (Buffer.byteLength(bytes) > BYTES) throw memoryError('SITE_MEMORY_UNSAFE', this.path);
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(temp, this.path);
      emptyEpochs.set(this.path, { epoch: data.epoch, present: true });
      return result;
    } finally { try { unlinkSync(temp); } catch {} this.release(held); }
  }
  generation() {
    if (!this.log) return undefined;
    try {
      // Persist the first generation before observing input, even for an empty store. A different process can then
      // invalidate it by deleting the file; no observation ever carries only a process-local absent-store token.
      let data = this.read();
      if (!existsSync(this.path)) { this.update(() => true); data = this.read(); }
      return data.epoch;
    } catch { return undefined; }
  }
  record(event, epoch = this.generation()) {
    const item = recipe(event), origin = recipeOrigin(event?.origin);
    if (!this.log || !item || !origin || epoch === undefined || event?.outcome !== 'control changed') return false;
    try {
      const saved = this.update(data => {
        if (data.epoch !== epoch) return false;
        const entry = data.origins.find(entry => entry.origin === origin) ?? { origin, recipes: [] };
        entry.recipes = [...entry.recipes.filter(old => JSON.stringify(recipe(old)) !== JSON.stringify(item)), { ...item, lastUsed: this.now() }].slice(-20);
        data.origins = [...data.origins.filter(old => old.origin !== origin), entry].slice(-64);
        return true;
      });
      // Stats ignores kind:recipe. A failed optional annotation never undoes a store already published by rename.
      if (saved) try { this.log.write([{ tool: 'browser_act', kind: 'recipe', origin, ...item, result: 'ok', outcome: 'control changed' }]); } catch {}
      return saved;
    } catch { return false; } // Optional learning never changes the action's result.
  }
  list() {
    const data = this.read();
    if (data.expired) try { this.update(() => true); } catch {} // Retry pruning on the next access if a writer is busy.
    return data.origins.map(entry => ({ origin: entry.origin, recipes: entry.recipes.map(recipe) }));
  }
  hints(url) {
    if (!this.log) return '';
    try {
      const origin = new URL(url).origin;
      const recipes = this.list().find(entry => entry.origin === origin)?.recipes;
      if (recipes?.length) try { this.update(data => {
        const entry = data.origins.find(entry => entry.origin === origin);
        if (!entry) return false;
        for (const item of entry.recipes.slice(-19)) item.lastUsed = this.now();
        data.origins = [...data.origins.filter(old => old !== entry), entry];
        return true;
      }); } catch {} // Hints remain readable while another writer owns the lock.
      return recipes?.length ? ['Past controls (untrusted hints; use fresh refs; never permission):',
        ...recipes.slice(-19).map(item => recipeLine(item))].join('\n') : '';
    } catch { return ''; }
  }
  // No learning means no store to clear. Preserve a live writer's lock even before its first publication.
  absent() {
    try {
      this.directory();
      for (const path of [this.path, this.path + '.lock']) {
        try { lstatSync(path); return false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return true;
    } catch (error) { if (error.code === 'ENOENT') return true; throw memoryError('SITE_MEMORY_UNSAFE', this.path); }
  }
  clear(origin) {
    if (origin !== undefined && !recipeOrigin(origin)) throw Error('INVALID_ORIGIN');
    if (this.absent()) return 0;
    if (origin === undefined) {
      try { this.directory(); } catch { throw memoryError('SITE_MEMORY_UNSAFE', this.path); }
      const held = this.acquire();
      try {
        let removed = 0;
        try { removed = this.read().origins.reduce((n, entry) => n + entry.recipes.length, 0); } catch {}
        // Do not parse or require a private mode to erase corrupt data. Ownership and link checks still apply.
        try { const stat = ownedFile(this.path);
          if (!sameFile(stat, ownedFile(this.path))) throw unsafe();
          unlinkSync(this.path);
        } catch (error) { if (error.code !== 'ENOENT') throw memoryError('SITE_MEMORY_UNSAFE', this.path); }
        emptyEpochs.set(this.path, { epoch: randomUUID(), present: false });
        return removed;
      } finally { this.release(held); }
    }
    return this.clearMatching(site => site === origin);
  }
  clearMatching(matches) {
    if (this.absent()) return 0;
    return this.update(data => {
      // A preceding writer may have removed the store while this clear waited for its lock.
      if (!existsSync(this.path)) return false;
      const removed = data.origins.filter(entry => matches(entry.origin)).reduce((n, entry) => n + entry.recipes.length, 0);
      data.origins = data.origins.filter(entry => !matches(entry.origin));
      data.epoch = randomUUID();
      return removed;
    }, { wait: true }) || 0;
  }
}
export function siteMemoryFromEnvironment(env = process.env) {
  const path = actionLogPath(env.SLEIGHT_ACTION_LOG);
  return path ? new SiteMemory({ log: new ActionLog({ path }) }) : undefined;
}
