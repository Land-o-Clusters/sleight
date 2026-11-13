#!/usr/bin/env node
// Offline release check: pinned data, lossless sheets, character budget and complete plugin bytes.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBuiltinCharacter, BUILTIN_CHARACTER_IDS, builtinCharactersDirectory } from '../../plugins/sleight/lib/hand/character.mjs';
const root = builtinCharactersDirectory(), packs = [];
for (const id of BUILTIN_CHARACTER_IDS) {
  const pack = checkBuiltinCharacter(id);
  for (const [name, bytes] of pack.files) if (name.endsWith('.webp')) {
    let images = 0;
    for (let at = 12; at < bytes.length;) {
      const kind = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4);
      if (kind === 'VP8 ') throw Error(`${id}/${name} is lossy`);
      if (kind === 'VP8L') images++;
      at += 8 + size + (size & 1);
    }
    if (images !== 1) throw Error(`${id}/${name} needs one lossless VP8L image`);
  }
  packs.push({ id, bytes: pack.total });
}
const diskBytes = folder => fs.readdirSync(folder).reduce((n, name) => {
  const path = join(folder, name), st = fs.lstatSync(path);
  if (st.isSymbolicLink()) throw Error('Plugin size check refuses symlinks');
  return n + (st.isDirectory() ? diskBytes(path) : st.size);
}, 0);
const characterBytes = diskBytes(root), pluginBytes = diskBytes(fileURLToPath(new URL('../../plugins/sleight/', import.meta.url)));
if (characterBytes >= 8_000_000) throw Error(`Bundled characters exceed 8 MB: ${characterBytes}`);
console.log(JSON.stringify({ packs, characterBytes, pluginBytes, budgetBytes: 8_000_000 }));
