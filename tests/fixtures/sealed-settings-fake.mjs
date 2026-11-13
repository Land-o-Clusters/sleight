// Test seam only. Production never imports a MAC implementation in Node.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { PreapprovedApps } from '../../plugins/sleight/lib/preapproved.mjs';

export const fixtureStore = () => ({ installId: 'AAECAwQFBgcICQoLDA0ODw',
  key: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', counters: {}, present: [] });
export const fixedFiles = ['preapproved.json', 'permissions.json', 'turbo.json', 'turbo-owner.json', 'turbo-apps.json',
  'electron-grants.json', 'hand.json', 'settings-link.json', 'routine-launcher.mjs'];
export const sealedName = name => fixedFiles.includes(name) || /^(routines|watches)\/[a-f0-9]{20}\/[a-z][a-z0-9-]*\.json$/.test(name);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const mac = (store, file, counter, bytes) => createHmac('sha256', Buffer.from(store.key, 'base64url'))
  .update(['sleight-seal', 1, file, store.installId, counter, digest(bytes)].join('\0')).digest('base64url');
export const sidecar = (store, file, counter, bytes) => JSON.stringify({ version: 1, file, counter, mac: mac(store, file, counter, bytes) });

export function fakeSettings(root, { store = fixtureStore(), enforce = false } = {}) {
  const safe = (path, mode, limit) => {
    const st = fs.lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o7777) !== mode ||
        st.size > limit || fs.realpathSync(path) !== path) throw Error('unsafe');
    for (let parent = dirname(path); parent.startsWith(root); parent = dirname(parent)) {
      const dir = fs.lstatSync(parent);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || dir.mode & 0o022 || fs.realpathSync(parent) !== parent) throw Error('unsafe');
    }
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try { const opened = fs.fstatSync(fd); if (st.ino !== opened.ino || st.dev !== opened.dev) throw Error('unsafe'); return fs.readFileSync(fd); }
    finally { fs.closeSync(fd); }
  };
  const schema = (file, bytes) => {
    if (file === 'routine-launcher.mjs') return;
    const data = JSON.parse(bytes.toString('utf8'));
    if (file === 'preapproved.json') new PreapprovedApps(data);
    else if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('unsafe');
  };
  const verify = file => {
    let bytes, seal;
    const limit = ({ 'hand.json': 4096, 'settings-link.json': 4096, 'permissions.json': 262144, 'turbo-owner.json': 8192 })[file] ?? 1048576;
    try { bytes = safe(join(root, file), 0o600, limit); schema(file, bytes); }
    catch (error) {
      if (error.code !== 'ENOENT') return { file, state: 'unsafe' };
      let sidecarExists = false;
      try { fs.lstatSync(join(root, file + '.seal')); sidecarExists = true; } catch { /* No trusted bytes are returned. */ }
      return { file, state: store?.present.includes(file) || sidecarExists ? 'tampered' : 'absent' };
    }
    try { seal = safe(join(root, file + '.seal'), 0o600, 1024); }
    catch (error) { return { file, state: error.code === 'ENOENT' ? 'unsealed' : 'tampered' }; }
    try {
      const s = JSON.parse(seal);
      if (Object.keys(s).sort().join() !== 'counter,file,mac,version' || s.version !== 1 || s.file !== file ||
          !Number.isSafeInteger(s.counter) || s.counter < 1 || typeof s.mac !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s.mac) ||
          Buffer.from(s.mac, 'base64url').length !== 32 || Buffer.from(s.mac, 'base64url').toString('base64url') !== s.mac || !store) throw Error();
      const expected = Buffer.from(mac(store, file, s.counter, bytes), 'base64url'), given = Buffer.from(s.mac, 'base64url');
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw Error();
      if (s.counter !== store.counters[file]) return { file, state: 'stale' };
      return { file, state: 'trusted', content: bytes.toString('utf8') };
    } catch { return { file, state: 'tampered' }; }
  };
  function names() {
    const names = new Set([...fixedFiles, ...store?.present ?? []]);
    for (const kind of ['routines', 'watches']) {
      let ids; try { ids = fs.readdirSync(join(root, kind)); } catch { continue; }
      for (const id of ids) {
        let files; try { files = fs.readdirSync(join(root, kind, id)); } catch { continue; }
        for (const name of files) {
          const relative = `${kind}/${id}/${name.replace(/\.seal$/, '')}`;
          if (sealedName(relative)) names.add(relative);
        }
      }
    }
    return [...names].sort();
  }
  const helper = args => {
    if (args.join(' ') !== '--settings verify') throw Error('SETTINGS_INTENT_REFUSED');
    return { stdout: names().map(name => JSON.stringify(verify(name))).join('\n') + '\n', enforcement: enforce };
  };
  const put = (file, content, { interrupted = false } = {}) => {
    if (!sealedName(file)) throw Error('name');
    const bytes = Buffer.from(content); schema(file, bytes);
    const path = join(root, file); fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const counter = (store.counters[file] ?? 0) + 1;
    fs.writeFileSync(path + '.tmp', bytes, { mode: 0o600 });
    store.counters[file] = counter;
    if (!store.present.includes(file)) store.present.push(file);
    if (interrupted) return;
    fs.writeFileSync(path + '.seal', sidecar(store, file, counter, bytes), { mode: 0o600 });
    fs.renameSync(path + '.tmp', path);
  };
  return { helper, verify, put, store, root, names };
}
