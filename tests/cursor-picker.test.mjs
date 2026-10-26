import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { encodePng } from '../bench/hand/synthetic-character.mjs';
import * as picker from '../plugins/sleight/lib/hand/cursor-picker.mjs';
import { prepareCharacterImport, installCharacter, characterCallout } from '../plugins/sleight/lib/hand/character.mjs';

function world(t) {
  const home = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-picker-'))));
  const root = join(home, 'characters'), pets = join(home, '.codex/pets');
  fs.mkdirSync(pets, { recursive: true, mode: 0o700 });
  const put = (id, more = {}) => {
    const folder = join(pets, id); fs.mkdirSync(folder, { mode: 0o700 });
    const png = encodePng(1536, 2288, new Uint8Array(1536 * 2288 * 4));
    fs.writeFileSync(join(folder, 'atlas.png'), png, { mode: 0o600 });
    fs.writeFileSync(join(folder, 'pet.json'), JSON.stringify({ id, displayName: id, spriteVersionNumber: 2, spritesheetPath: 'atlas.png', ...more }), { mode: 0o600 });
    return folder;
  };
  return { home, root, pets, put };
}
test('pure menu model has built-ins, sorted characters, only unimported pets and folder action', () => {
  const rows = picker.cursorMenuModel({ installed: [{ id: 'zed', name: 'Zed' }, { id: 'a', name: 'Ada' }],
    found: [{ id: 'zed', key: '1', name: 'Zed' }, { id: 'b', key: '2', name: 'Bee' }], style: 'sprite', character: 'a' });
  assert.deepEqual(rows.map(r => r.title), ['Ring (Split Seam+)', 'Plain ring', 'Glove', 'Ada', 'Zed', 'Add your Codex pets', 'Open characters folder']);
  assert.equal(rows[3].selected, true); assert.equal(rows.filter(r => r.selected).length, 1);
  assert.deepEqual(rows[5].children.map(r => [r.title, r.key]), [['Bee', '2']]);
  assert.deepEqual(picker.cursorMenuModel({}).slice(0, 3).map(r => r.style), ['ring', 'seam', 'glove']);
});
test('discovery finds both Codex roots, deduplicates and refuses linked pet folders', t => {
  const w = world(t); w.put('cat');
  const other = join(w.home, 'codex-home'); fs.mkdirSync(join(other, 'pets'), { recursive: true, mode: 0o700 });
  fs.renameSync(w.put('dog'), join(other, 'pets/dog'));
  fs.symlinkSync(join(w.pets, 'cat'), join(w.pets, 'linked'));
  const found = picker.findCodexPets({ home: w.home, env: { CODEX_HOME: other } });
  assert.deepEqual(found.map(p => p.id).sort(), ['cat', 'dog']);
  assert.equal(picker.findCodexPets({ home: w.home, env: { CODEX_HOME: join(w.home, '.codex') } }).length, 1);
});
test('menu import uses VC3 validation, writes the selection, returns VC3 callout and leaves source unchanged', async t => {
  const w = world(t), source = w.put('My_Cat');
  const before = fs.readFileSync(join(source, 'pet.json'));
  const writes = [], controller = picker.createCursorPicker({ home: w.home, env: {}, root: w.root, writeSetting: s => writes.push(s) });
  const catalog = await controller.catalog(); assert.equal(catalog.pets.length, 1);
  const result = await controller.apply({ op: 'import', key: catalog.pets[0].key });
  assert.equal(result.ok, true, result.text); assert.deepEqual(writes, [{ style: 'sprite', character: 'my-cat' }]);
  assert.equal(result.text, characterCallout(prepareCharacterImport(source), { installed: true }));
  assert.deepEqual(fs.readFileSync(join(source, 'pet.json')), before);
  assert.equal((await controller.catalog()).pets.length, 0);
  assert.equal((await controller.catalog()).installed[0].id, 'my-cat');
});
test('offered identities bind selection and imports; failed import preserves validation reason', async t => {
  const w = world(t), folder = w.put('cat'), writes = [];
  const controller = picker.createCursorPicker({ home: w.home, env: {}, root: w.root, writeSetting: s => writes.push(s) });
  assert.equal((await controller.apply({ op: 'select', style: 'sprite', character: 'cat' })).ok, false);
  assert.equal((await controller.apply({ op: 'import', key: folder })).ok, false);
  const catalog = await controller.catalog();
  fs.writeFileSync(join(folder, 'pet.json'), '{"spritesheetPath":"atlas.png"}', { mode: 0o600 });
  const failure = await controller.apply({ op: 'import', key: catalog.pets[0].key });
  assert.equal(failure.ok, false); assert.match(failure.text, /Codex pet must have spriteVersionNumber 2/); assert.equal(writes.length, 0);
});
test('installed idle thumbnail descriptors contain only idle and have content keys that change with art', async t => {
  const w = world(t), folder = w.put('cat'); installCharacter(prepareCharacterImport(folder), { root: w.root });
  const controller = picker.createCursorPicker({ home: w.home, env: {}, root: w.root, writeSetting: () => {} });
  const first = (await controller.catalog()).thumbnails[0];
  assert.deepEqual(Object.keys(first.frame.table), ['idle']); assert.match(first.key, /^[0-9a-f]{64}$/);
  assert.equal(first.frame.table.idle.frames.length, 1);
  const path = join(w.root, 'cat/sheet.png'), bytes = fs.readFileSync(path); bytes[32] = 1; fs.writeFileSync(path, bytes);
  assert.notEqual((await controller.catalog()).thumbnails[0].key, first.key);
});
test('a settings refusal after import says the pet was installed and retains the fallback callout', async t => {
  const w = world(t); w.put('cat');
  const controller = picker.createCursorPicker({ home: w.home, env: {}, root: w.root, writeSetting() { throw Error('HAND_CONFIG_UNSAFE'); } });
  const catalog = await controller.catalog(), result = await controller.apply({ op: 'import', key: catalog.pets[0].key });
  assert.equal(result.ok, false); assert.match(result.text, /Imported, but could not select it: HAND_CONFIG_UNSAFE/);
  assert.match(result.text, /To animate all of them it needs/); assert.ok(fs.existsSync(join(w.root, 'cat/character.json')));
});
test('installed titles lose format characters before reaching the native menu contract', async t => {
  const w = world(t), source = w.put('cat', { displayName: 'C\u00adat\ufeff' });
  installCharacter(prepareCharacterImport(source), { root: w.root });
  const controller = picker.createCursorPicker({ home: w.home, env: {}, root: w.root, writeSetting() {} });
  const rows = (await controller.catalog()).rows;
  assert.equal(rows.find(r => r.character === 'cat').title, 'Cat');
});
