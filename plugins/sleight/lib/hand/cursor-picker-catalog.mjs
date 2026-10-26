// Read and hash installed sheets on a utility worker, never on the MCP event loop.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { checkCharacter, listCharacters, resolveCharacterStates, checkBuiltinCharacter, builtinCharactersDirectory, BUILTIN_CHARACTER_IDS } from './character.mjs';
import { characterFrame } from './character-frame.mjs';

const banks = new Map();
const stamp = path => {
  const st = fs.lstatSync(path, { bigint: true });
  return [st.dev, st.ino, st.mode, st.uid, st.nlink, st.size, st.mtimeNs, st.ctimeNs].join(':');
};
function fingerprint(folder) {
  try {
    const st = fs.lstatSync(folder);
    if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(folder) !== folder) return;
    const names = fs.readdirSync(folder).sort();
    if (names.length > 9) return;
    return [stamp(folder), ...names.map(name => name + ':' + stamp(join(folder, name)))].join('|');
  } catch { return; }
}
function buildBank({ root, uid, builtin = false }) {
  try {
    const st = fs.lstatSync(root);
    if (!builtin && (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(root) !== root || st.uid !== uid || (st.mode & 0o7777) !== 0o700)) {
      listCharacters({ root, uid }); // Preserve the validator's refusal and wording.
    }
  } catch (error) { if (error.code === 'ENOENT') return { characters: [], thumbnails: [], hashes: 0, hits: 0 }; throw error; }
  const bankKey = JSON.stringify([root, uid, builtin]), old = banks.get(bankKey) ?? new Map(), next = new Map();
  const characters = [], thumbnails = []; let hashes = 0, hits = 0;
  for (const id of builtin ? BUILTIN_CHARACTER_IDS : fs.readdirSync(root).filter(id => !id.startsWith('.import-') && !BUILTIN_CHARACTER_IDS.includes(id)).sort()) {
    const folder = join(root, id);
    let st; try { st = fs.lstatSync(folder); } catch { continue; }
    if (!st.isSymbolicLink() && (!st.isDirectory() || !/^[a-z0-9-]{1,48}$/.test(id))) continue;
    if (!/^[a-z0-9-]{1,48}$/.test(id)) continue;
    const pinStamp = () => { try { return builtin ? stamp(root) + stamp(join(root, 'manifest.json')) : ''; } catch { return; } };
    const signatureOf = () => { const f = fingerprint(folder), p = pinStamp(); return f && p !== undefined ? f + p : undefined; };
    const signature = signatureOf(), previous = old.get(id);
    let entry;
    if (signature && signature === previous?.signature) { entry = previous; hits++; }
    else {
      entry = { signature, character: { id, name: id, ...builtin ? { builtin: true } : {} } };
      try {
        const pack = builtin ? checkBuiltinCharacter(id, { builtinRoot: root, uid }) : checkCharacter(id, { root, uid });
        entry.character.name = pack.manifest.name;
        const frame = characterFrame(pack, { nonce: '0'.repeat(64), seq: 0, resolve: resolveCharacterStates });
        const idle = frame.table.idle;
        frame.table = { idle: { ...idle, frames: [idle.frames[0]], ms: [100], loop: false } };
        delete frame.perch; delete frame.perchSheet; delete frame.lines; // a thumbnail is the idle cell alone
        const digest = createHash('sha256').update(JSON.stringify(frame)).update(pack.files.get(pack.manifest.sheet));
        if (pack.manifest.extra) digest.update(pack.files.get(pack.manifest.extra));
        entry.thumbnail = { id, key: digest.digest('hex'), frame }; hashes++;
      } catch { if (builtin) continue; } // Refused built-ins are skipped; imported packs retain their repair row.
      // Do not memoize data if any file changed while it was being validated and hashed.
      if (signature !== signatureOf()) entry.signature = undefined;
    }
    next.set(id, entry); characters.push(entry.character);
    if (entry.thumbnail) thumbnails.push(entry.thumbnail);
  }
  banks.delete(bankKey); banks.set(bankKey, next);
  while (banks.size > 8) banks.delete(banks.keys().next().value);
  return { characters, thumbnails, hashes, hits };
}
function buildCatalog({ root, uid, builtins = true, builtinRoot = builtinCharactersDirectory() }) {
  const user = buildBank({ root, uid });
  if (!builtins) return user;
  const bundled = buildBank({ root: builtinRoot, uid, builtin: true });
  return { characters: [...bundled.characters, ...user.characters], thumbnails: [...bundled.thumbnails, ...user.thumbnails],
    hashes: bundled.hashes + user.hashes, hits: bundled.hits + user.hits };
}
if (!isMainThread) parentPort.on('message', ({ id, options }) => {
  try { parentPort.postMessage({ id, result: buildCatalog(options) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message }); }
});

let worker, serial = 0;
const pending = new Map();
export function installedCursorCatalog(options) {
  if (!worker) {
    const current = new Worker(new URL(import.meta.url)); worker = current;
    const fail = error => {
      if (worker !== current) return;
      worker = undefined;
      for (const { reject } of pending.values()) reject(error);
      pending.clear();
    };
    current.on('message', ({ id, result, error }) => {
      const request = pending.get(id); if (!request) return;
      pending.delete(id);
      if (error) request.reject(Error(error)); else request.resolve(result);
      if (!pending.size) current.unref();
    });
    current.on('error', fail);
    current.on('exit', code => fail(Error(`Cursor catalog worker exited (${code}).`)));
    current.unref();
  }
  return new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, { resolve, reject });
    worker.ref(); worker.postMessage({ id, options });
  });
}
