import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as api from '../plugins/sleight/lib/hand/character.mjs';
import { cursorMenuModel, createCursorPicker } from '../plugins/sleight/lib/hand/cursor-picker.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
const ids = ['tsugi', 'shizu', 'bit', 'kit', 'yori', 'tab'];
function world(t) {
  const base = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-builtins-'))));
  return { base, root: join(base, 'characters') };
}
test('six bundled characters load before any user bank exists without writing it', t => {
  const w = world(t), packs = api.listCharacters({ root: w.root });
  assert.deepEqual(packs.map(c => c.manifest?.id), ids);
  for (const c of packs) {
    assert.equal(c.builtin, true); assert.equal(c.manifest.license, 'MIT');
    assert.equal(c.manifest.sheet, 'sheet.webp');
    assert.equal(c.resolved.filter(s => s.own).length, 19);
    assert.equal(Object.keys(c.manifest.lines).length, 10);
    assert.equal(api.checkCharacter(c.manifest.id, { root: w.root }).folder, c.folder);
    assert.throws(() => api.removeCharacter(c.manifest.id, { root: w.root }), /built.in/i);
  }
  assert.ok(packs.reduce((n, c) => n + c.total, 0) < 8_000_000);
  assert.equal(fs.existsSync(w.root), false);
});
test('built-in ids are reserved even if an import changes its display name', t => {
  const w = world(t), pack = api.checkCharacter('tsugi', { root: w.root });
  const source = join(w.base, 'source'); fs.mkdirSync(source, { mode: 0o700 });
  for (const [name, bytes] of pack.files) fs.writeFileSync(join(source, name), bytes, { mode: 0o600 });
  const m = JSON.parse(fs.readFileSync(join(source, 'character.json'))); m.name = 'My Tsugi';
  fs.writeFileSync(join(source, 'character.json'), JSON.stringify(m));
  assert.throws(() => api.prepareCharacterImport(source), /built.in.*id/i);
  assert.throws(() => api.installCharacter(pack, { root: w.root }), /built.in.*id/i);
  assert.equal(fs.existsSync(w.root), false);
});
test('picker labels built-ins and offers them before imported characters', async t => {
  const w = world(t), writes = [], controller = createCursorPicker({ home: w.base, env: {}, root: w.root, writeSetting: s => writes.push(s) });
  const catalog = await controller.catalog({ style: 'ring' });
  assert.deepEqual(catalog.installed.map(c => c.id), ids);
  assert.equal(catalog.thumbnails.length, 6);
  assert.ok(catalog.rows.filter(r => r.character).every(r => /built.in/i.test(r.title)));
  assert.equal((await controller.apply({ op: 'select', style: 'sprite', character: 'kit' })).ok, true);
  assert.deepEqual(writes, [{ style: 'sprite', character: 'kit' }]);
  const rows = cursorMenuModel({ installed: [{ id: 'aaa', name: 'Aaa' }, ...catalog.installed] });
  assert.deepEqual(rows.filter(r => r.character).map(r => r.character), [...ids, 'aaa']);
  assert.equal(fs.existsSync(w.root), false);
});
test('tampering with any bundled file skips that pack and produces a doctor line', t => {
  const w = world(t), builtinRoot = join(w.base, 'bundled');
  fs.cpSync(api.builtinCharactersDirectory(), builtinRoot, { recursive: true });
  for (const name of ['sheet.webp', 'extra.webp', 'perch.webp', 'preview.png', 'character.json']) {
    const path = join(builtinRoot, 'tsugi', name), saved = fs.readFileSync(path), changed = Buffer.from(saved);
    if (name === 'character.json') {
      const m = JSON.parse(saved); m.name = 'Other'; fs.writeFileSync(path, JSON.stringify(m));
    } else { changed[changed.length - 1] ^= 1; fs.writeFileSync(path, changed); }
    assert.throws(() => api.checkCharacter('tsugi', { root: w.root, builtinRoot }), /hash mismatch/);
    const listed = api.listCharacters({ root: w.root, builtinRoot });
    assert.equal(listed.filter(c => c.manifest).length, 5);
    assert.match(listed.find(c => c.id === 'tsugi').error, /hash mismatch/);
    assert.match(api.builtinCharacterDoctorLines({ builtinRoot }).join('\n'), /PROBLEM.*tsugi.*skipped.*hash mismatch/);
    fs.writeFileSync(path, saved);
  }
  const sheet = join(builtinRoot, 'tsugi', 'sheet.webp'); fs.chmodSync(sheet, 0o666);
  assert.throws(() => api.checkCharacter('tsugi', { root: w.root, builtinRoot }), /unsafe character file mode/);
});
test('a user pack cannot shadow a built-in, while a new id installs independently', t => {
  const w = world(t), builtin = api.checkCharacter('bit', { root: w.root });
  const files = new Map(builtin.files), m = structuredClone(builtin.manifest); m.id = 'my-bit'; m.name = 'My Bit';
  files.set('character.json', Buffer.from(JSON.stringify(m)));
  api.installCharacter({ files }, { root: w.root });
  fs.cpSync(join(w.root, 'my-bit'), join(w.root, 'bit'), { recursive: true });
  const list = api.listCharacters({ root: w.root });
  assert.deepEqual(list.filter(c => c.manifest).map(c => c.manifest.id), [...ids, 'my-bit']);
  assert.equal(api.checkCharacter('bit', { root: w.root }).builtin, true);
  assert.match(list.find(c => c.skipped).reason, /collision/);
});
test('picker cache drops a changed built-in and its thumbnail on the next catalog read', async t => {
  const w = world(t), builtinRoot = join(w.base, 'bundled');
  fs.cpSync(api.builtinCharactersDirectory(), builtinRoot, { recursive: true });
  const controller = createCursorPicker({ home: w.base, env: {}, root: w.root, builtinRoot, writeSetting: () => {} });
  const first = await controller.catalog(); assert.equal(first.installed.length, 6);
  const path = join(builtinRoot, 'kit', 'sheet.webp'), bytes = fs.readFileSync(path); bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(path, bytes);
  const next = await controller.catalog();
  assert.deepEqual(next.installed.map(c => c.id), ids.filter(id => id !== 'kit'));
  assert.equal(next.thumbnails.some(c => c.id === 'kit'), false);
  assert.equal((await controller.apply({ op: 'select', style: 'sprite', character: 'kit' })).ok, false);
  fs.chmodSync(builtinRoot, 0o777);
  assert.deepEqual((await controller.catalog()).installed, []);
});
