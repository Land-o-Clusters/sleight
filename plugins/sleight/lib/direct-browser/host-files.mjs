import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync,
  mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse, join, basename } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { immutableJSON } from './ipc.mjs';
import { knownAppDocument } from './electron-identity.mjs';
import { assertUploadLocation, assertUploadOwnership, checkUploadMetadata, uploadByteLimit, uploadRefusals } from './upload-paths.mjs';

const uid = userInfo().uid;

// Port of sleight's reviewed BP2-7 file authority. No third-party source copied.
const authorities = new WeakSet();
const transfers = new WeakMap();
export const isFileAuthority = value => !!value && authorities.has(value);
// Private typed actuator entry. A stage is an opaque identity, never JSON, a
// copied payload list, a new path approval or the already-consumed issue token.
export function consumeStagedFilePayloads(authority, stage, binding) {
  if (!authorities.has(authority)) throw Error('FILE_AUTHORITY_REQUIRED');
  return transfers.get(authority)(stage, binding);
}

const keys = ['browserIncarnation', 'brokerEpoch', 'clientSession', 'turn', 'leaseGeneration',
  'target', 'frame', 'document', 'origin', 'operation', 'ref'];
function bindingKey(binding) {
  binding = immutableJSON(binding);
  if (!binding || Object.keys(binding).length !== keys.length || keys.some(k => !['string', 'number'].includes(typeof binding[k])))
    throw new Error('Incomplete file authority binding');
  // An Electron app document has no web origin. Only an origin string a trusted app binding derived in this
  // process passes, so a page, a tool argument or a look-alike string cannot name one.
  if (!knownAppDocument(binding.origin)) {
    const url = new URL(binding.origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== binding.origin)
      throw new Error('Unsupported file destination');
  }
  return JSON.stringify(keys.map(k => binding[k]));
}
function snapshot(path, includeData = false) {
  assertUploadLocation(path);
  let current = parse(path).root;
  const chain = [current];
  assertUploadOwnership(lstatSync(current), uid, true);
  let entry;
  for (const part of path.slice(current.length).split('/')) {
    current = join(current, part);
    chain.push(current);
    entry = lstatSync(current, { bigint: true });
    if (entry.isSymbolicLink()) throw Error(uploadRefusals.links);
    assertUploadOwnership(entry, uid, current !== path);
  }
  // Check the type before opening: opening a FIFO read-only can wait forever.
  if (!entry?.isFile()) throw Error(uploadRefusals.type);
  if (entry.size > uploadByteLimit) throw Error(uploadRefusals.size);
  checkUploadMetadata(chain, uid);
  if (realpathSync(path) !== path) throw new Error('File path changed');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw Error(uploadRefusals.type);
    if (before.size > uploadByteLimit) throw Error(uploadRefusals.size);
    assertUploadOwnership(before, uid);
    if (before.dev !== entry.dev || before.ino !== entry.ino) throw Error('File path changed');
    // Read at most the observed size plus one, even if a writer keeps growing it.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (BigInt(length) !== before.size) throw Error('File changed while checking');
    const data = buffer.subarray(0, length);
    const digest = createHash('sha256').update(data).digest('hex');
    const after = fstatSync(fd, { bigint: true });
    const stat = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
    if (stat(before) !== stat(after)) throw new Error('File changed while checking');
    return { path, size: Number(after.size), signature: `${stat(after)}:${digest}`, ...(includeData ? { data } : {}) };
  } finally { closeSync(fd); }
}

function snapshots(paths, includeData = false) {
  let size = 0;
  return paths.map(path => {
    const file = snapshot(path, includeData);
    size += file.size;
    if (size > Number(uploadByteLimit)) throw Error(uploadRefusals.size);
    return file;
  });
}

// Trusted broker/UI adapter only. Page and model JSON cannot mint these opaque handles.
// CDP can read paths lazily after dispatch. Scoped adapters should transfer the
// checked byte payloads into browser-owned Files before staging cleanup, rather
// than retaining a File backed by a soon-deleted path. Same-user hostile
// software remains outside this local-process trust boundary.
export function createFileAuthority({ approve, now = Date.now, ttlMs = 30_000 } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 30_000 || typeof now !== 'function')
    throw new Error('Invalid file authority freshness');
  const clock = () => {
    let time;
    try { time = now(); } catch { throw new Error('Unreadable file authority freshness'); }
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > Number.MAX_SAFE_INTEGER - ttlMs)
      throw new Error('Invalid file authority freshness');
    return time;
  };
  const fresh = cap => {
    const time = clock();
    if (!Number.isFinite(cap.expires) || time < cap.issued || time >= cap.expires)
      throw new Error('Invalid file capability freshness');
  };
  const capabilities = new WeakMap(), stages = new WeakMap();
  const authority = Object.freeze({
    async issue(paths, binding) {
      clock();
      const key = bindingKey(binding);
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 16 || new Set(paths).size !== paths.length)
        throw new Error('Expected exact file list');
      const files = snapshots(paths);
      if (typeof approve !== 'function' || await approve({ binding: structuredClone(binding), paths: [...paths] }) !== true)
        throw new Error('Exact user file approval required');
      // Approval may take time. Check again before publishing the capability.
      if (paths.some((p, i) => snapshot(p).signature !== files[i].signature)) throw new Error('Approved file changed');
      const token = Object.freeze({});
      const issued = clock();
      capabilities.set(token, { key, files, issued, expires: issued + ttlMs });
      return token;
    },
    consume(token, binding) {
      const cap = token && capabilities.get(token);
      if (!cap || cap.key !== bindingKey(binding)) throw new Error('Invalid file capability');
      capabilities.delete(token); // Fail closed, even if the file check fails.
      fresh(cap);
      if (cap.files.some(f => snapshot(f.path).signature !== f.signature)) throw new Error('Approved file changed');
      fresh(cap);
      return cap.files.map(f => f.path);
    },
    stage(token, binding) {
      const cap = token && capabilities.get(token);
      if (!cap || cap.key !== bindingKey(binding)) throw new Error('Invalid file capability');
      capabilities.delete(token);
      fresh(cap);
      const files = snapshots(cap.files.map(f => f.path), true).map((read, index) => {
        const f = cap.files[index];
        if (read.signature !== f.signature) throw new Error('Approved file changed');
        return read;
      });
      fresh(cap);
      const directory = mkdtempSync(join(realpathSync(tmpdir()), 'bp2-7-upload-'));
      let retained = true, spent = false;
      const cleanup = () => {
        try { rmSync(directory, { recursive: true, force: true }); retained = false; }
        catch { return { retained: true }; }
        return { retained: false };
      };
      try {
        const paths = files.map((file, index) => {
          const parent = join(directory, String(index)); mkdirSync(parent, { mode: 0o700 });
          const path = join(parent, basename(file.path));
          writeFileSync(path, file.data, { flag: 'wx', mode: 0o600 });
          return path;
        });
        const staged = paths.map(p => snapshot(p));
        fresh(cap);
        // Private adapter data, never a model-visible capability or receipt.
        // Empty MIME lets the qualified upload adapter infer it from the name.
        const payloads = files.map(file => Object.freeze({ name: basename(file.path), mimeType: '', buffer: Buffer.from(file.data) }));
        const owned = files.map(file => ({ name: basename(file.path), mimeType: '', base64: file.data.toString('base64') }));
        const stage = Object.freeze({ paths, payloads, snapshot: staged, cleanup,
          receipt: () => ({ retained, spent }) });
        stages.set(stage, { cap, owned, take(binding) {
          if (!retained || spent || cap.key !== bindingKey(binding)) throw Error('Invalid staged file capability');
          spent = true; fresh(cap);
          return { payloads: structuredClone(owned), window: { issued: cap.issued, expires: cap.expires } };
        } });
        return stage;
      } catch (error) { cleanup(); throw error; }
    },
    checkPaths(paths) { return snapshots(paths); },
    unchanged(before) { return before.every(f => snapshot(f.path).signature === f.signature); },
  });
  transfers.set(authority, (stage, binding) => {
    const record = stage && stages.get(stage);
    if (!record) throw Error('Invalid staged file capability');
    return record.take(binding);
  });
  authorities.add(authority); return authority;
}
