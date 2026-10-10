// Cooperative window leases. SQLite supplies crash-safe, nonwaiting file locks;
// JSON holds the actual lease and is removed on release. Keep the lock sidecar:
// unlinking an open coordinator would let two processes lock different inodes.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, chmodSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDocumentRead } from './document-scope.mjs';
import { isInventoryRead } from './inventory-read.mjs';

export const LEASE_MS = 30000;
const sameFile = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
function coordinatorIdentity(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile()) throw new Error('Input lease: coordinator is not a regular file; stop actions.');
    return stat;
  } catch (err) { if (err.code === 'ENOENT') return undefined; throw err; }
}
export const leaseKey = (window, scope = 'window') => createHash('sha256')
  .update(JSON.stringify([scope, scope === 'desktop' ? '*' : window.appId || window.app,
    scope === 'window' ? window.url || window.title : '*'])).digest('hex');

// Only literal, standalone reads pass without a lease. Arbitrary JS is treated
// as an action, including read/action mixtures and expressions in read options.
export function isLeaseRead(code = '') {
  if (isDocumentRead(code) || isInventoryRead(code)) return true;
  const options = String.raw`\s*(?:\{\s*(?:(?:disableDiffing|emit)\s*:\s*(?:true|false)\s*,?\s*)*\})?\s*`;
  const call = String.raw`[A-Za-z_$][\w$]*\.(?:getAXState|getAXStateAndScreenshot|getScreenshot)\(${options}\)`;
  return new RegExp(String.raw`^await\s+${call}\s*;?$`).test(code.trim()) ||
    new RegExp(String.raw`^(?:await\s+)?nodeRepl\.(?:emitImage|write)\(\s*await\s+${call}\s*\)\s*;?$`).test(code.trim()) ||
    /^await\s+cua\.rewriteDocumentation\(\s*\)\s*;?$/.test(code.trim());
}

export class InputLease {
  constructor({ directory = join(homedir(), 'Library', 'Application Support', 'sleight', 'leases'),
    holder = `session ${randomUUID()} (pid ${process.pid})`, now = Date.now } = {}) {
    this.directory = directory;
    this.holder = holder;
    this.now = now;
    this.owned = new Map();
  }
  read(path) {
    let value;
    try { value = JSON.parse(readFileSync(path, 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return undefined; throw new Error('Input lease: invalid lease file; stop actions.'); }
    if (typeof value.holder !== 'string' || typeof value.token !== 'string' || !Number.isFinite(value.expires) ||
        !value.window || typeof value.window.appId !== 'string' || !['window', 'app', 'desktop'].includes(value.scope)) {
      throw new Error('Input lease: invalid lease record; stop actions.');
    }
    return value;
  }
  refusal(record) {
    return new Error(record
      ? `Input lease: held by ${record.holder}; ${Math.max(0, Math.ceil((record.expires - this.now()) / 1000))} s remaining. Stop actions and retry after that turn ends or the lease expires.`
      : 'Input lease: another session is updating this window lease. Stop actions and retry with a fresh read.');
  }
  disposeCoordinator() {
    const db = this.db ?? this.failedDb;
    this.db = undefined; this.dbIdentity = undefined;
    try { db?.close(); this.failedDb = undefined; this.dbFailure = undefined; }
    catch (err) { this.failedDb = db; this.dbFailure = err; throw err; }
  }
  coordinator() {
    if (this.dbFailure) throw new Error('Input lease: coordinator cleanup failed; stop actions and close this session.', { cause: this.dbFailure });
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, '.coordinator.sqlite');
    if (this.db && sameFile(this.dbIdentity, coordinatorIdentity(path))) return this.db;
    this.disposeCoordinator();
    for (let attempt = 0; attempt < 3; attempt++) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      // Establish the inode before SQLite opens it. Never open/close a verification fd:
      // a POSIX close on that inode could release this process's SQLite locks.
      try { writeFileSync(path, '', { flag: 'wx', mode: 0o600 }); }
      catch (err) { if (err.code !== 'EEXIST') throw err; }
      const before = coordinatorIdentity(path);
      if (!before) continue;
      const db = new DatabaseSync(path);
      this.db = db;
      this.dbIdentity = before;
      try {
        chmodSync(path, 0o600);
        if (sameFile(before, coordinatorIdentity(path))) return db;
      } catch (err) {
        try { this.disposeCoordinator(); }
        catch (closeError) { throw new AggregateError([err, closeError], 'Input lease: coordinator open and cleanup failed; stop actions.'); }
        throw err;
      }
      this.disposeCoordinator();
    }
    throw new Error('Input lease: coordinator changed repeatedly while opening; stop actions.');
  }
  transact(key, operation) {
    const path = join(this.directory, key + '.json');
    const db = this.coordinator();
    try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
    catch (err) {
      if (err.errcode === 5 || /locked|busy/i.test(err.message)) {
        const refusal = this.refusal(this.read(path)); refusal.leaseBusy = true; throw refusal;
      }
      throw err;
    }
    try {
      if (!sameFile(this.dbIdentity, coordinatorIdentity(join(this.directory, '.coordinator.sqlite')))) {
        throw new Error('Input lease: coordinator changed while taking its lock; stop actions.');
      }
    } catch (err) {
      try { this.disposeCoordinator(); }
      catch (closeError) { throw new AggregateError([err, closeError], 'Input lease: coordinator changed and cleanup failed; stop actions.'); }
      throw err;
    }
    let value, failure, failed = false;
    try { value = operation(path, this.read(path)); }
    catch (err) { failure = err; failed = true; }
    try { db.exec('ROLLBACK'); }
    catch (err) {
      const errors = failed ? [failure, err] : [err];
      try { this.disposeCoordinator(); } catch (closeError) { errors.push(closeError); }
      if (errors.length > 1) throw new AggregateError(errors, 'Input lease: operation or rollback failed; stop actions.', { cause: err });
      throw err;
    }
    if (failed) throw failure;
    return value;
  }
  store(path, record) {
    const temporary = path + '.' + randomUUID();
    try {
      writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } finally { try { unlinkSync(temporary); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
  }
  acquire(window, scope = 'window') {
    if (!window?.appId || !['window', 'app', 'desktop'].includes(scope)) throw new Error('Input lease: missing bundle ID or invalid scope.');
    const key = leaseKey(window, scope);
    this.transact(key, (path, record) => {
      const own = this.owned.get(key);
      for (const name of readdirSync(this.directory).filter(n => n.endsWith('.json'))) {
        const other = this.read(join(this.directory, name));
        if (!other || other.expires <= this.now() || this.owned.get(name.slice(0, -5)) === other.token) continue;
        const otherScope = other.scope || 'window';
        const overlaps = scope === 'desktop' || otherScope === 'desktop' ||
          (other.window.appId === window.appId && (scope === 'app' || otherScope === 'app' || name === key + '.json'));
        if (overlaps) throw this.refusal(other);
      }
      const token = record && record.token === own ? own : randomUUID();
      this.store(path, { holder: this.holder, token, expires: this.now() + LEASE_MS, window, scope });
      this.owned.set(key, token);
    });
    return key;
  }
  renew(keys = this.owned.keys()) {
    for (const key of keys) this.transact(key, (path, record) => {
      if (!record || record.token !== this.owned.get(key) || record.expires <= this.now()) {
        throw new Error('Input lease: ownership lost or expired; stop actions and read the window again.');
      }
      this.store(path, { ...record, expires: this.now() + LEASE_MS });
    });
  }
  grant(key) {
    return { path: join(this.directory, key + '.json'), token: this.owned.get(key) };
  }
  release(keys = this.owned.keys()) {
    const errors = [];
    for (const key of keys) {
      const token = this.owned.get(key);
      if (!token) continue;
      try {
        this.transact(key, (path, record) => { if (record?.token === token) unlinkSync(path); });
        this.owned.delete(key);
      } catch (err) { errors.push(err); }
    }
    if (errors.length) throw new AggregateError(errors, 'Input lease: release failed; remaining leases expire without renewal.');
  }
  close() {
    const errors = [];
    try { this.release(); } catch (err) { errors.push(err); }
    try { this.disposeCoordinator(); } catch (err) { errors.push(err); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Input lease: release and coordinator cleanup failed.');
  }
  releaseChecked() {
    const tokens = new Set(this.owned.values());
    this.release();
    let names;
    try { names = readdirSync(this.directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
    for (const name of names.filter(name => name.endsWith('.json'))) {
      if (tokens.has(this.read(join(this.directory, name))?.token)) throw new Error('Input lease: owned record remains after release.');
    }
    if (this.owned.size) throw new Error('Input lease: owned reservations remain.');
  }
}
