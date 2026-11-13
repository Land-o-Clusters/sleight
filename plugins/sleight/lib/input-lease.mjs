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
const validKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
const publicLease = (key, { token: _token, ...record }, now) => ({ key, ...record, active: record.expires > now });
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

// A read that filters its tree before printing it, such as
//   const s = await ff.getAXState(); const lines = s.split("\n"); nodeRepl.write(lines.filter(l => /Kilimanjaro/.test(l)).join("\n"));
// was refused as stale when the page had retitled since the last result (wikipedia, 2026-10-18), though it sends
// no input. It stays an action for the lease and the guard, which filter and track its output; this only lets the
// relay run it against the window its own acquisition just showed. It is a read-only call when its awaited calls
// are all getAXState, getAXStateAndScreenshot or getScreenshot, and every other call is a string or array method
// below, nodeRepl.write or nodeRepl.emitImage. Anything else, a bare call, a computed or chained call, a template
// literal, a comment, a keyword that runs code, or an assignment into a property, is not.
const PURE_METHODS = new Set(['split', 'slice', 'join', 'filter', 'map', 'trim', 'includes', 'indexOf', 'test', 'match',
  'replace', 'toLowerCase', 'startsWith', 'endsWith', 'substring', 'concat', 'some']);
const READ_METHODS = ['getAXState', 'getAXStateAndScreenshot', 'getScreenshot'];
export function isFilteredRead(code) {
  if (typeof code !== 'string' || code.length > 4000 || code.includes('`')) return false;
  // Strings and regular expression literals become placeholders, so the calls inside them aren't seen as calls.
  let source = '', last = '';
  for (let i = 0; i < code.length;) {
    const c = code[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) { if (code[j] === '\\') j++; if (code[j] === '\n') return false; j++; }
      if (j >= code.length) return false;
      source += '""'; last = '"'; i = j + 1;
    } else if (c === '/') {
      if (code[i + 1] === '/' || code[i + 1] === '*') return false;
      // A slash after an operand divides; after punctuation it can only start a regular expression.
      if (last === '' || '(,=:[!&|?{};><+-*%~^'.includes(last)) {
        let j = i + 1, inClass = false;
        while (j < code.length && (code[j] !== '/' || inClass)) {
          if (code[j] === '\\') j++; else if (code[j] === '[') inClass = true; else if (code[j] === ']') inClass = false;
          if (code[j] === '\n') return false;
          j++;
        }
        if (j >= code.length) return false;
        j++;
        while (/[a-z]/i.test(code[j] ?? '')) j++;
        source += '\u0001'; last = 'R'; i = j;
      } else { source += c; last = c; i++; }
    } else { source += c; if (!/\s/.test(c)) last = c; i++; }
  }
  if (/\b(?:function|class|new|import|eval|with|while|for|do|if|try|throw|delete|void|yield|async|globalThis|window|this|require|process|constructor|prototype|__proto__)\b/.test(source)) return false;
  if (/\.\s*[\w$]+\s*(?:[-+*\/|&]|\?\?)?=(?!=)/.test(source) || /\]\s*=(?!=)/.test(source)) return false;
  // The handle may appear only as the receiver of a direct awaited read: passing `ff.click` to map, destructuring it
  // or indexing it would reach an action without a call site named click.
  const handles = new Set();
  const readCall = new RegExp(String.raw`\bawait\s+([A-Za-z_$][\w$]*)\.(?:${READ_METHODS.join('|')})\(\s*(?:\{\s*(?:(?:disableDiffing|emit)\s*:\s*(?:true|false)\s*,?\s*)*\})?\s*\)`, 'g');
  const body = source.replace(readCall, (_, handle) => { handles.add(handle); return 'await \u0002'; });
  const reads = [...body.matchAll(/\bawait \u0002/g)].length;
  if (!reads || reads !== [...body.matchAll(/\bawait\b/g)].length) return false;
  if (/[{}]/.test(body) || /[\w$)\]"\u0001\u0002]\s*\[/.test(body) || /\b(?:const|let|var)\s*[^A-Za-z_$\s]/.test(body)) return false;
  const locals = new Set([...body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
  for (const m of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) locals.add(m[1]);
  for (const m of body.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const param of m[1].split(',').map(x => x.trim()).filter(Boolean)) { if (!/^[A-Za-z_$][\w$]*$/.test(param)) return false; locals.add(param); }
  }
  if (locals.has('nodeRepl') || [...handles].some(handle => locals.has(handle))) return false;
  for (const m of body.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)) {
    if (body.slice(0, m.index).trimEnd().endsWith('.')) continue;
    if (!['await', 'return', 'const', 'let', 'var', 'true', 'false', 'null', 'undefined', 'nodeRepl'].includes(m[0]) && !locals.has(m[0])) return false;
  }
  for (const m of body.matchAll(/\(/g)) {
    const before = body.slice(0, m.index).replace(/\s+$/, '');
    const name = /[A-Za-z_$][\w$]*$/.exec(before)?.[0];
    if (name === undefined) {
      if (/[)\]"\u0001\u0002.]$/.test(before)) return false;
      continue;
    }
    const rest = before.slice(0, before.length - name.length).replace(/\s+$/, '');
    if (!rest.endsWith('.')) { if (name === 'await' || name === 'return') continue; return false; }
    const object = /([A-Za-z_$][\w$]*)$/.exec(rest.slice(0, -1).replace(/\s+$/, ''))?.[1];
    if (name === 'write' || name === 'emitImage') { if (object !== 'nodeRepl') return false; continue; }
    if (!PURE_METHODS.has(name)) return false;
  }
  return true;
}

// Only literal, standalone reads pass without a lease. Arbitrary JS is treated
// as an action, including read/action mixtures and expressions in read options.
export function isLeaseRead(code = '') {
  if (isDocumentRead(code) || isInventoryRead(code)) return true;
  // `const state = await cua.getState(); return state;` is the same read bound to a name: the
  // bound expression must pass on its own. Refusing it cost a turn (calculator-click, 2026-10-10).
  const bound = String(code).trim().match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+?)\s*;?\s*(?:return\s+)?\1\s*;?$/);
  if (bound && isLeaseRead(bound[2])) return true;
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
    return this.acquireGrant(window, scope).key;
  }
  acquireGrant(window, scope = 'window') {
    if (!window?.appId || !['window', 'app', 'desktop'].includes(scope)) throw new Error('Input lease: missing bundle ID or invalid scope.');
    const key = leaseKey(window, scope);
    return this.transact(key, (path, record) => {
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
      const next = { holder: this.holder, token, expires: this.now() + LEASE_MS, window, scope };
      this.store(path, next);
      this.owned.set(key, token);
      return { ...publicLease(key, next, this.now()), token };
    });
  }
  inspect(key) {
    if (!validKey(key)) throw new Error('Input lease: invalid lease key.');
    return this.transact(key, (_path, record) => record ? publicLease(key, record, this.now()) : null);
  }
  withGrant(key, token, operation) {
    if (!validKey(key) || typeof token !== 'string' || !token) throw new Error('Input lease: invalid lease key or token.');
    return this.transact(key, (path, record) => {
      if (!record || record.token !== token || record.expires <= this.now()) {
        throw new Error('Input lease: ownership lost or expired; stop actions and read the window again.');
      }
      return operation(path, record);
    });
  }
  renewGrant(key, token) {
    return this.withGrant(key, token, (path, record) => {
      const next = { ...record, expires: this.now() + LEASE_MS };
      this.store(path, next);
      return publicLease(key, next, this.now());
    });
  }
  releaseGrant(key, token) {
    return this.withGrant(key, token, path => {
      unlinkSync(path);
      if (this.owned.get(key) === token) this.owned.delete(key);
    });
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
