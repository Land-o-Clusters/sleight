// Notepad NP/0 saved-file metadata only. Never read the document payload.
import { openSync, closeSync, readSync, fstatSync, lstatSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { join, win32 } from 'node:path';

const refuse = () => { throw Object.assign(Error('NOTEPAD_FOREIGN_TABS'), { code: 'NOTEPAD_FOREIGN_TABS' }); };
const id = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const baseName = new RegExp(`^${id}\\.bin$`, 'i');
const sideName = new RegExp(`^(${id})\\.[01]\\.bin$`, 'i');
const signature = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
function ordinary(path, directory = false) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile())) refuse();
  return signature(s);
}

export function harnessTabPath(path) {
  // Canonical drive paths only. Traversal, ADS, UNC and device aliases refuse.
  return typeof path === 'string' && path === win32.normalize(path) &&
    /^C:\\sleight-setup\\uc3f-[a-f0-9]{16}\\[^\\/:\x00-\x1f]+$/i.test(path) &&
    !/[. ]$/.test(path) &&
    !/^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(?:[ .]|$)/i.test(win32.basename(path));
}

export function readNotepadPath(read) {
  const one = () => { const b = read(1); if (b.length !== 1) refuse(); return b[0]; };
  if (one() !== 0x4e || one() !== 0x50 || one() !== 0 || one() !== 1) refuse();
  let length = 0, factor = 1;
  for (let i = 0; i < 3; i++) {
    const b = one(); length += (b & 127) * factor;
    if (!(b & 128)) {
      if (!length || length > 1024 || (i && b === 0)) refuse();
      const bytes = read(length * 2);
      if (bytes.length !== length * 2) refuse();
      const path = bytes.toString('utf16le');
      if (/[\x00-\x1f]/.test(path)) refuse();
      return path;
    }
    factor *= 128;
  }
  refuse();
}

export async function preserveNotepadState(localState, { assertIdle, now = () => new Date(), move = renameSync,
  audit = () => {} } = {}) {
  await assertIdle();
  const folder = join(localState, 'TabState');
  // Check each ancestor before using the package directory, including junctions.
  for (let p = localState; ; p = win32.dirname(p)) {
    if (p === '.' || p === win32.dirname(p)) break;
    if (existsSync(p)) ordinary(p, true);
    // Portable fixtures use the host's separator and have no Windows ancestors.
    if (!p.includes('\\')) break;
  }
  if (!existsSync(folder)) return { moved: false, tabs: [] };
  const folderIdentity = ordinary(folder, true), entries = readdirSync(folder).sort();
  if (entries.length > 512) refuse();
  const tabs = [], snapshots = new Map();
  for (const name of entries) {
    const path = join(folder, name);
    snapshots.set(name, ordinary(path));
    const side = sideName.exec(name);
    if (side) { if (!entries.some(n => n.toLowerCase() === `${side[1]}.bin`.toLowerCase())) refuse(); continue; }
    if (!baseName.test(name)) refuse();
    const fd = openSync(path, 'r');
    try {
      if (signature(fstatSync(fd)) !== snapshots.get(name)) refuse();
      let offset = 0;
      const filePath = readNotepadPath(length => {
        const b = Buffer.alloc(length), count = readSync(fd, b, 0, length, offset); offset += count;
        return b.subarray(0, count);
      });
      if (signature(fstatSync(fd)) !== snapshots.get(name)) refuse();
      tabs.push({ stateFile: name, filePath });
      audit({ moved: false, tab: tabs.at(-1) });
      if (!harnessTabPath(filePath)) refuse();
    } finally { closeSync(fd); }
  }
  // Do not rename even an empty or unrecognized state bank without a tab proof.
  if (!tabs.length && entries.length) refuse();
  await assertIdle();
  if (ordinary(folder, true) !== folderIdentity || JSON.stringify(readdirSync(folder).sort()) !== JSON.stringify(entries)) refuse();
  for (const [name, identity] of snapshots) if (ordinary(join(folder, name)) !== identity) refuse();
  const destination = join(localState, `TabState-preserved-${now().toISOString().replace(/[:.]/g, '-')}`);
  if (existsSync(destination)) refuse();
  const receipt = { moved: true, from: folder, to: destination, tabs };
  audit({ ...receipt, moved: false, planned: true });
  move(folder, destination);
  audit(receipt);
  return receipt;
}

export async function preflightNotepad({ call, check, audit }) {
  const { localState } = await call('notepad-idle');
  return preserveNotepadState(localState, { assertIdle: async () => { await check(); await call('notepad-idle'); }, audit });
}
