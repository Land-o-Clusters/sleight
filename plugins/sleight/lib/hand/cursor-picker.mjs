// The menu catalog and its nonce-bound clicks. Packs use VC3's snapshot validator and atomic importer unchanged.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { charactersDirectory, checkCharacter, prepareCharacterImport, installCharacter, characterCallout } from './character.mjs';
import { installedCursorCatalog } from './cursor-picker-catalog.mjs';
import { installedCharacterPlugins, characterPackDigest, codexPluginSnapshot } from './character-plugins.mjs';
import { importPluginCharacter } from './character-sharing.mjs';
import { loadCharacter } from './character.mjs';
import { writeHandSetting } from './command.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sort = entries => [...entries].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
const slug = id => id.toLowerCase().replace(/[^a-z0-9-]/g, '-');
const title = name => typeof name === 'string' && name.length > 0 && name.length <= 60;
const menuTitle = (name, fallback) => [...name.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '')].slice(0, 60).join('') || fallback;
const pluginWarning = ' (warning: check plugin)';
export function cursorMenuModel({ installed = [], found = [], plugins = [], style = 'glove', character, lines = 'on' } = {}) {
  const ids = new Set(installed.map(c => c.id));
  return [
    ...[['ring', 'Ring (Split Seam+)'], ['seam', 'Plain ring'], ['glove', 'Glove']].map(([value, name]) => ({ title: name, op: 'select', style: value, selected: style === value })),
    ...sort(installed).map(c => ({ title: menuTitle(c.name, c.id), op: 'select', style: 'sprite', character: c.id, selected: style === 'sprite' && character === c.id })),
    // A2: the character's lines, a toggle shown with a sprite selected.
    ...style === 'sprite' ? [{ title: 'Character lines', op: 'lines', selected: lines !== 'off' }] : [],
    { title: 'Add your Codex pets', children: sort(found.filter(p => !ids.has(p.id))).map(p => ({ title: menuTitle(p.name, p.id), op: 'import', key: p.key })) },
    ...plugins.filter(p => p.packs.length).map(p => ({ title: p.warning
      ? [...menuTitle(p.pluginId, p.pluginId)].slice(0, 60 - pluginWarning.length).join('') + pluginWarning
      : menuTitle(p.pluginId, p.pluginId), children: sort(p.packs).map(pack => ids.has(pack.id)
        ? { title: [...menuTitle(pack.name, pack.id)].slice(0, 60 - ' (already installed)'.length).join('') + ' (already installed)', op: 'installed' }
        : { title: menuTitle(pack.name, pack.id), op: 'import', key: pack.key }) })),
    { title: 'Open characters folder', op: 'folder' },
  ];
}

// Discovery reads only manifests. The click re-reads and validates the whole pack, including its atlas.
export function findCodexPets({ home = userInfo().homedir, env = process.env, uid = process.getuid(), trace = () => {} } = {}) {
  const roots = new Set([join(home, '.codex/pets'), ...isAbsolute(env.CODEX_HOME ?? '') ? [join(env.CODEX_HOME, 'pets')] : []]);
  const found = [], seen = new Set();
  for (const root of roots) {
    try {
      if (fs.realpathSync(root) !== root) { trace('hand-picker-discovery-skipped', { reason: 'symlink-codex-root' }); continue; }
      const directory = fs.lstatSync(root);
      if (!directory.isDirectory() || directory.uid !== uid || directory.mode & 0o022) continue;
      for (const entry of fs.readdirSync(root).sort()) {
        const folder = join(root, entry);
        try {
          const st = fs.lstatSync(folder), path = join(folder, 'pet.json'), info = fs.lstatSync(path);
          if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || st.mode & 0o022 || fs.realpathSync(folder) !== folder ||
              !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== uid || info.mode & 0o022 || info.size >= 16384) continue;
          const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          let pet;
          try {
            const opened = fs.fstatSync(fd);
            if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) continue;
            const bytes = Buffer.alloc(16384), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
            pet = JSON.parse(bytes.subarray(0, count).toString('utf8'));
          } finally { fs.closeSync(fd); }
          if (typeof pet.id !== 'string' || !/^[A-Za-z0-9_ -]{1,48}$/.test(pet.id) || !title(pet.displayName)) continue;
          const id = slug(pet.id); if (seen.has(id)) continue;
          seen.add(id); found.push({ id, name: pet.displayName, key: hash(folder), folder });
        } catch {}
      }
    } catch {}
  }
  return sort(found);
}

export function createCursorPicker({ home = userInfo().homedir, env = process.env, root = charactersDirectory(), uid = process.getuid(),
  writeSetting = writeHandSetting, trace = () => {}, cwd = process.cwd(), pluginCatalog = installedCharacterPlugins, hostCheck,
  codexSnapshot = pluginCatalog === installedCharacterPlugins ? codexPluginSnapshot : async () => ({ installed: [] }) } = {}) {
  let offered = new Map(), pluginOffers = new Map(), installed = new Set(), busy = false;
  const pluginOptions = { home, env: { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CLAUDE_CODE_PLUGIN_CACHE_DIR: env.CLAUDE_CODE_PLUGIN_CACHE_DIR, CODEX_HOME: env.CODEX_HOME }, uid, cwd };
  let codexRecord;
  let tracedSymlink = false;
  const discoveryTrace = (...args) => { if (!tracedSymlink) { tracedSymlink = true; try { trace(...args); } catch {} } };
  return {
    async catalog({ style = 'glove', character, lines, open = true } = {}) {
      if (open || !codexRecord) {
        const start = performance.now(); codexRecord = await codexSnapshot(pluginOptions);
        try { trace('hand-picker-codex-list', { ms: performance.now() - start }); } catch {}
      }
      // Every installed folder gets a row, including refused packs, so a click can explain the refusal.
      const { characters, thumbnails } = await installedCursorCatalog({ root, uid });
      const found = findCodexPets({ home, env, uid, trace: discoveryTrace }).filter(p => !characters.some(c => c.id === p.id));
      const plugins = await pluginCatalog({ ...pluginOptions, codexRecord });
      pluginOffers = new Map(plugins.flatMap(group => group.packs.filter(pack => !characters.some(c => c.id === pack.id)).map(pack => [pack.key, { ...pack, warning: group.warning }])));
      offered = new Map(found.map(p => [p.key, p])); installed = new Set(characters.map(c => c.id));
      return { installed: characters, pets: found.map(({ folder, ...p }) => p), plugins: plugins.map(({ folder, packs, ...p }) => ({ ...p, packs: packs.map(({ folder, ...pack }) => pack) })), thumbnails,
        rows: cursorMenuModel({ installed: characters, found, plugins, style, character, lines }) };
    },
    async apply(event) {
      if (busy) return { ok: false, text: 'A character import is already running. Try again when it finishes.' };
      busy = true;
      try {
        if (event.op === 'import' && Object.keys(event).sort().join() === 'key,op') {
          const offer = pluginOffers.get(event.key);
          if (offer) {
            const groups = await pluginCatalog({ ...pluginOptions, codexRecord }), group = groups.find(g => g.packs.some(p => p.key === event.key));
            const current = group?.packs.find(p => p.key === event.key);
            if (!current || current.digest !== offer.digest || group.warning !== offer.warning) throw Error('That character plugin changed or is no longer installed. Open Cursor again.');
            const pack = loadCharacter(current.folder, { uid, shared: true });
            if (characterPackDigest(pack.files) !== offer.digest) throw Error('That character changed while opening it. Open Cursor again.');
            const checked = await importPluginCharacter(pack, { root, uid, hostCheck });
            const text = `Plugin: ${group.pluginId}\n${group.warning ? group.warning + '\n' : ''}${characterCallout(checked, { installed: true })}`;
            try { await writeSetting({ style: 'sprite', character: checked.manifest.id }); }
            catch (error) { return { ok: false, text: `Imported, but could not select it: ${error.message}\n${text}` }; }
            return { ok: true, text, style: 'sprite', character: checked.manifest.id };
          }
          const pet = offered.get(event.key); if (!pet) throw Error('That pet is no longer in this menu. Open Cursor again.');
          const pack = prepareCharacterImport(pet.folder, { uid });
          if (!pack.manifest.codex || pack.manifest.id !== pet.id) throw Error('That pet changed. Open Cursor again.');
          installCharacter(pack, { root, uid });
          try { await writeSetting({ style: 'sprite', character: pack.manifest.id }); }
          catch (error) { return { ok: false, text: `Imported, but could not select it: ${error.message}\n${characterCallout(pack, { installed: true })}` }; }
          return { ok: true, text: characterCallout(pack, { installed: true }), style: 'sprite', character: pack.manifest.id };
        }
        if (event.op === 'lines' && Object.keys(event).sort().join() === 'lines,op' && ['on', 'off'].includes(event.lines)) {
          await writeSetting({ lines: event.lines }); return { ok: true, lines: event.lines };
        }
        if (event.op === 'select' && (Object.keys(event).sort().join() === 'op,style' && ['ring', 'seam', 'glove'].includes(event.style) ||
            Object.keys(event).sort().join() === 'character,op,style' && event.style === 'sprite' && installed.has(event.character))) {
          if (event.style === 'sprite') {
            checkCharacter(event.character, { root, uid });
          }
          const setting = { style: event.style, ...event.character ? { character: event.character } : {} };
          await writeSetting(setting); return { ok: true, ...setting };
        }
        throw Error('That choice is no longer in this menu. Open Cursor again.');
      } catch (error) { return { ok: false, text: `Character import or selection failed: ${error.message}` }; }
      finally { busy = false; }
    },
  };
}
