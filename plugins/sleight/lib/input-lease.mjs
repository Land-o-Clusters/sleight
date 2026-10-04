// Cooperative window leases. SQLite supplies crash-safe, nonwaiting file locks;
// JSON holds the actual lease and is removed on release. Keep the lock sidecar:
// unlinking an open coordinator would let two processes lock different inodes.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDocumentRead } from './document-scope.mjs';

export const LEASE_MS = 30000;
export const leaseKey = (window, scope = 'window') => createHash('sha256')
  .update(JSON.stringify([scope, scope === 'desktop' ? '*' : window.appId || window.app,
    scope === 'window' ? window.url || window.title : '*'])).digest('hex');

// Only literal, standalone reads pass without a lease. Arbitrary JS is treated
// as an action, including read/action mixtures and expressions in read options.
export function isLeaseRead(code = '') {
  if (isDocumentRead(code)) return true;
  const options = String.raw`\s*(?:\{\s*(?:(?:disableDiffing|emit)\s*:\s*(?:true|false)\s*,?\s*)*\})?\s*`;
  const call = String.raw`app\.(?:getAXState|getAXStateAndScreenshot|getScreenshot)\(${options}\)`;
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
  transact(key, operation) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, key + '.json');
    const coordinator = join(this.directory, '.coordinator.sqlite');
    const db = new DatabaseSync(coordinator);
    chmodSync(coordinator, 0o600);
    try {
      try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
      catch (err) {
        if (err.errcode === 5 || /locked|busy/i.test(err.message)) {
          const refusal = this.refusal(this.read(path)); refusal.leaseBusy = true; throw refusal;
        }
        throw err;
      }
      try { return operation(path, this.read(path)); }
      finally { db.exec('ROLLBACK'); }
    } finally { db.close(); }
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
  close() { this.release(); }
}
