// Sharing checks the immutable snapshot in a private bank, then publishes that same snapshot.
import * as fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadCharacter, parseCharacterJSON, resolveCharacterStates, checkCharacter, installCharacter } from './character.mjs';
import { characterFrame } from './character-frame.mjs';
import { encodeCharacterArchive, readCharacterArchive } from './character-archive.mjs';
import { prepareHandHost } from '../direct-browser/host.mjs';

export async function checkSharedCharacterInHost(frame, root) {
  const host = await prepareHandHost();
  if (host.status !== 'ready') throw Error(`the hand host is unavailable (${host.code ?? host.status})`);
  return host.checkCharacter(frame, { root });
}

export async function withSharedCharacter(files, { uid = process.getuid(), hostCheck = checkSharedCharacterInHost } = {}, action = character => character) {
  // The encoder enforces file names and byte caps before any name reaches the filesystem.
  encodeCharacterArchive(files);
  const manifest = parseCharacterJSON(files.get('character.json'));
  if (!manifest || manifest.format !== 'sleight-character' || manifest.version !== 1 || typeof manifest.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(manifest.id)) throw Error('Character: invalid character format or id');
  const root = fs.mkdtempSync(join(fs.realpathSync('/tmp'), 'sleight-character-check-'));
  fs.chmodSync(root, 0o700);
  try {
    const folder = join(root, manifest.id); fs.mkdirSync(folder, { mode: 0o700 });
    for (const [name, bytes] of files) fs.writeFileSync(join(folder, name), bytes, { flag: 'wx', mode: 0o600 });
    const character = loadCharacter(folder, { uid, installed: true, shared: true });
    const result = await hostCheck(characterFrame(character, { nonce: randomBytes(32).toString('hex'), seq: 0, resolve: resolveCharacterStates }), root);
    if (!result?.loaded) throw Error(`Character sandboxed decode refused (${result?.reason ?? 'unavailable'}).`);
    character.warnings.push(...(result.warnings ?? []).map(w => `Image check: ${w}`));
    return await action(character);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

export function importCharacterArchive(file, options = {}) {
  return withSharedCharacter(readCharacterArchive(file, options), options, character => {
    installCharacter(character, options); return character;
  });
}
export function importPluginCharacter(pack, options = {}) {
  return withSharedCharacter(pack.files, options, character => { installCharacter(character, options); return character; });
}
export async function exportCharacterArchive(id, file, options = {}) {
  const character = checkCharacter(id, options);
  return withSharedCharacter(character.files, options, checked => {
    // A new file only. Opening a preexisting file, including a dangling symlink, never truncates it.
    const target = resolve(file), parent = dirname(target);
    if (fs.realpathSync(parent) !== parent) throw Error('Character archive: symlink output parent refused');
    const bytes = encodeCharacterArchive(checked.files);
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const created = fs.fstatSync(fd);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    catch (error) {
      fs.closeSync(fd);
      try { const current = fs.lstatSync(target); if (current.dev === created.dev && current.ino === created.ino) fs.unlinkSync(target); } catch {}
      throw error;
    }
    fs.closeSync(fd); return { bytes: bytes.length, id };
  });
}
