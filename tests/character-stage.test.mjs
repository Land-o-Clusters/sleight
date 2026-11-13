import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as api from '../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../plugins/sleight/lib/hand/character-frame.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const states = ['stage-lie', 'stage-lie-reach', 'stage-lie-peek', 'stage-sleep', 'stage-sit', 'stage-sit-notes', 'stage-wait', 'stage-cheer', 'stage-hang', 'stage-hang-peek', 'stage-climb', 'stage-stand', 'stage-point', 'stage-carry', 'stage-wince', 'stage-handoff', 'stage-paused', 'stage-leap', 'stage-run'];
// Header-only fixtures exercise the importer's container checks, not native pixel decoding.
function png(w, h) {
  const b = Buffer.alloc(57); Buffer.from('89504e470d0a1a0a', 'hex').copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
  b.write('IDAT', 37); b.write('IEND', 49); return b;
}
function fixture(t, count = 18) {
  const root = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-stage-'))));
  const folder = join(root, 'stage-cat'); fs.mkdirSync(folder, { mode: 0o700 }); fs.mkdirSync(join(folder, 'stage'), { mode: 0o700 });
  const m = { format: 'sleight-character', version: 1, id: 'stage-cat', name: 'Stage Cat', author: 'Test', description: '', license: 'MIT',
    sheet: 'sheet.png', frame: { w: 192, h: 208 }, grid: { cols: 8, rows: 1 }, anchor: { x: 96, y: 196 }, hotspot: { x: 96, y: 104 },
    states: { idle: { row: 0, frames: 1, ms: 100, loop: true } }, stage: { cell: { w: 384, h: 416 }, anchor: { x: 192, y: 392 }, states: {} } };
  const put = (name, bytes) => fs.writeFileSync(join(folder, name), bytes, { mode: 0o600 });
  put('sheet.png', png(1536, 208));
  for (const name of states.slice(0, count)) {
    const file = `stage/${name.slice(6)}.png`;
    m.stage.states[name] = { file, frames: 6, ms: [100, 100, 100, 100, 100, 100], loop: true };
    put(file, png(2304, 416));
  }
  const save = () => put('character.json', JSON.stringify(m)); save();
  return { root, folder, m, put, save, load: () => api.loadCharacter(folder) };
}

test('18 strips survive import and private installation and reach the native frame', t => {
  const w = fixture(t), pack = w.load();
  assert.equal(Object.keys(pack.stage.states).length, 21);
  assert.equal(Object.values(pack.stage.states).filter(s => s.own).length, 18);
  const options = { nonce: 'a'.repeat(64), seq: 0, resolve: api.resolveCharacterStates, size: 315.5, stageAttention: false };
  const wire = characterFrame(pack, options);
  assert.equal(wire.size, 315.5); assert.equal(wire.stageAttention, false);
  for (const size of [true, 'huge', '315', NaN, Infinity, 103, 561]) assert.throws(() => characterFrame(pack, { ...options, size }), /size options/);
  assert.throws(() => characterFrame(pack, { ...options, stageAttention: 0 }), /size options/);
  assert.equal(wire.stage.table['stage-point'].file, join(w.folder, 'stage/point.png'));
  assert.deepEqual(wire.stage.table['stage-point'].cell, [384, 416]);
  assert.equal(wire.stage.table['stage-startle'].fallback, 'startle');
  const target = api.installCharacter(api.prepareCharacterImport(w.folder), { root: join(w.root, 'installed') });
  assert.equal(fs.statSync(join(target, 'stage')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(join(target, 'stage/point.png')).mode & 0o777, 0o600);
  assert.equal(api.loadCharacter(target, { installed: true }).stage.states['stage-point'].own, true);
});

test('missing stage strip and absent stage block resolve to medium perch art', t => {
  const w = fixture(t, 1); fs.unlinkSync(join(w.folder, 'stage/lie.png'));
  let pack = w.load();
  assert.equal(pack.stage.states['stage-lie'].own, false);
  assert.equal(pack.stage.states['stage-lie'].fallback.source, 'idle');
  assert.match(api.characterCallout(pack), /Stage: 0 of 21 states/);
  assert.match(api.characterCallout(pack), /shown at medium/);
  delete w.m.stage; w.save(); fs.rmdirSync(join(w.folder, 'stage'));
  pack = w.load(); assert.equal(pack.stage.available, false);
  assert.doesNotMatch(api.characterCallout(pack), /Stage:/);
  assert.equal(pack.stage.states['stage-wait'].fallback.state, 'perch-wait');
});

test('picker stage availability follows validated strips and invalidates when the last strip goes missing', async t => {
  const { installedCursorCatalog } = await import('../plugins/sleight/lib/hand/cursor-picker-catalog.mjs');
  const w = fixture(t, 1), root = join(w.root, 'installed');
  const target = api.installCharacter(api.prepareCharacterImport(w.folder), { root });
  const options = { root, uid: process.getuid(), builtins: false };
  assert.equal((await installedCursorCatalog(options)).characters[0].stage, true);
  fs.unlinkSync(join(target, 'stage/lie.png'));
  const next = await installedCursorCatalog(options);
  assert.equal(next.characters[0].stage, false); assert.equal(next.characters[0].id, 'stage-cat');
});

for (const [name, change, pattern] of [
  ['traversal', w => { w.m.stage.states['stage-lie'].file = 'stage/../sheet.png'; }, /stage.*file/i],
  ['invalid cell', w => { w.m.stage.cell.w = 191; }, /stage.*cell/i],
  ['strip dimensions', w => w.put('stage/lie.png', png(2303, 416)), /stage.*dimensions/i],
  ['strip height', w => w.put('stage/lie.png', png(2304, 1025)), /stage/i],
  ['duration count', w => { w.m.stage.states['stage-lie'].ms = [100]; }, /stage.*ms/i],
  ['duration overflow', w => { w.m.stage.states['stage-lie'].ms = 2000; }, /stage.*ms/i],
  ['too many frames', w => { w.m.stage.states['stage-lie'].frames = 9; }, /stage.*frames/i],
  ['invalid filter', w => { w.m.stage.filter = 'blur'; }, /stage.*filter/i],
  ['invalid anchor', w => { w.m.stage.anchor.x = Infinity; }, /stage.*anchor/i],
  ['animated strip', w => { const b = png(2304, 416); b.write('acTL', 37); w.put('stage/lie.png', b); }, /animated/i],
  ['symlink directory', w => { fs.renameSync(join(w.folder, 'stage'), join(w.root, 'elsewhere')); fs.symlinkSync(join(w.root, 'elsewhere'), join(w.folder, 'stage')); }, /symlink/i],
  ['symlink strip', w => { fs.unlinkSync(join(w.folder, 'stage/lie.png')); fs.symlinkSync(join(w.folder, 'sheet.png'), join(w.folder, 'stage/lie.png')); }, /symlink/i],
  ['unreferenced file', w => w.put('stage/extra.png', png(384, 416)), /extra.*file|unreferenced/i],
]) test(`stage refuses ${name}`, t => {
  const w = fixture(t, 1); change(w); w.save(); assert.throws(w.load, pattern);
});

test('stage uses independent wide lie cells and nearest filtering', t => {
  const w = fixture(t, 1); w.m.stage.filter = 'nearest';
  w.m.stage.lie = { cell: { w: 640, h: 416 }, anchor: { x: 192, y: 300 } };
  w.put('stage/lie.png', png(3840, 416)); w.save();
  const pack = w.load(), lie = pack.stage.states['stage-lie'];
  assert.deepEqual(lie.cell, { w: 640, h: 416 }); assert.deepEqual(lie.anchor, { x: 192, y: 300 }); assert.equal(lie.filter, 'nearest');
});

test('stage refuses a declared aggregate above 24 megapixels even with missing strips', t => {
  const w = fixture(t);
  for (const s of Object.values(w.m.stage.states)) { s.cell = { w: 512, h: 416 }; s.frames = 8; s.ms = 100; fs.unlinkSync(join(w.folder, s.file)); }
  w.save(); assert.throws(w.load, /stage.*pixel/i);
});

test('stage strips round-trip through the bounded archive and sharing snapshot', async t => {
  const { encodeCharacterArchive, decodeCharacterArchive } = await import('../plugins/sleight/lib/hand/character-archive.mjs');
  const { withSharedCharacter } = await import('../plugins/sleight/lib/hand/character-sharing.mjs');
  const w = fixture(t), pack = w.load(), files = decodeCharacterArchive(encodeCharacterArchive(pack.files));
  assert.deepEqual(files.get('stage/point.png'), pack.files.get('stage/point.png'));
  let checks = 0;
  const shared = await withSharedCharacter(files, { hostCheck: async frame => {
    checks++; assert.ok(fs.existsSync(frame.stage.table['stage-point'].file)); return { loaded: true, warnings: [] };
  } });
  assert.equal(checks, 1); assert.equal(shared.stage.states['stage-point'].own, true);
});

test('one strip cannot have conflicting cell geometry under different state names', t => {
  const w = fixture(t, 1);
  w.m.stage.states['stage-point'] = { ...w.m.stage.states['stage-lie'], cell: { w: 768, h: 416 }, frames: 3, ms: 100 };
  w.save(); assert.throws(w.load, /stage.*geometry/i);
});

test('3x strips keep their own anchor and hotspot without changing the base atlas', t => {
  const w = fixture(t, 0); w.m.stage.cell = { w: 576, h: 624 }; w.m.stage.anchor = { x: 288, y: 588 };
  w.m.stage.states['stage-point'] = { file: 'stage/point.png', frames: 3, ms: [70, 90, 320], loop: false, hotspot: { x: 525, y: 90 }, flip: 'h' };
  w.put('stage/point.png', png(1728, 624)); w.save();
  const p = w.load(), f = characterFrame(p, { nonce: 'a'.repeat(64), seq: 0, resolve: api.resolveCharacterStates });
  assert.deepEqual(f.cell, [192, 208]); assert.deepEqual(f.stage.table['stage-point'].cell, [576, 624]);
  assert.deepEqual(f.stage.table['stage-point'].hotspot, [525, 90]); assert.equal(f.stage.table['stage-point'].flip, true);
});

test('stage packs have idle-only thumbnails and catalog invalidates an edited strip', async t => {
  const { installedCursorCatalog } = await import('../plugins/sleight/lib/hand/cursor-picker-catalog.mjs');
  const w = fixture(t, 1), root = join(w.root, 'installed');
  const target = api.installCharacter(api.prepareCharacterImport(w.folder), { root });
  const options = { root, uid: process.getuid(), builtins: false };
  const first = await installedCursorCatalog(options);
  assert.equal(first.thumbnails.length, 1);
  assert.equal(first.thumbnails[0].frame.stage, undefined, 'thumbnail cannot carry stage entries after removing the perch sheet');
  const path = join(target, 'stage/lie.png'), bytes = fs.readFileSync(path); bytes[0] = 0; fs.writeFileSync(path, bytes);
  const second = await installedCursorCatalog(options);
  assert.equal(second.hits, 0); assert.equal(second.thumbnails.length, 0);
});

test('Finder metadata is ignored in stage and excluded from installed files', t => {
  const w = fixture(t, 1); w.put('stage/.DS_Store', 'metadata');
  const pack = w.load(); assert.equal(pack.files.has('stage/.DS_Store'), false);
  const target = api.installCharacter(api.prepareCharacterImport(w.folder), { root: join(w.root, 'installed') });
  assert.equal(fs.existsSync(join(target, 'stage/.DS_Store')), false);
});

for (const kind of ['symlink', 'hardlink', 'directory']) test(`stage metadata still refuses ${kind}`, t => {
  const w = fixture(t, 1), path = join(w.folder, 'stage/.DS_Store');
  if (kind === 'symlink') fs.symlinkSync(join(w.folder, 'sheet.png'), path);
  if (kind === 'hardlink') {
    const other = join(w.root, 'metadata'); fs.writeFileSync(other, 'metadata', { mode: 0o600 }); fs.linkSync(other, path);
  }
  if (kind === 'directory') fs.mkdirSync(path);
  assert.throws(w.load, /metadata must be regular/);
});

test('an unknown stage state and successor are ignored with a callout while known art survives', t => {
  const w = fixture(t, 1);
  w.m.stage.states['stage-future'] = { ...w.m.stage.states['stage-lie'], file: 'stage/future.png' };
  w.m.stage.states['stage-lie'].next = ['stage-future', 'stage-think'];
  w.put('stage/future.png', png(2304, 416)); w.save();
  const pack = w.load(), frame = characterFrame(pack, { nonce: 'a'.repeat(64), seq: 0, resolve: api.resolveCharacterStates });
  assert.equal(pack.stage.states['stage-lie'].own, true);
  assert.equal(frame.stage.table['stage-future'], undefined);
  assert.deepEqual(frame.stage.table['stage-lie'].next, ['stage-think']);
  assert.match(api.characterCallout(pack), /Unknown stage state ignored/);
  assert.match(api.characterCallout(pack), /Unknown stage successor ignored/);
  const target = api.installCharacter(api.prepareCharacterImport(w.folder), { root: join(w.root, 'installed') });
  assert.equal(api.loadCharacter(target, { installed: true }).stage.states['stage-lie'].own, true);
});

test('the seat table stage-think strip reaches the host with the perch-peek fallback', t => {
  const w = fixture(t, 1); w.m.stage.states['stage-think'] = w.m.stage.states['stage-lie']; w.save();
  const pack = w.load(); assert.equal(pack.stage.states['stage-think'].own, true);
  assert.equal(pack.stage.states['stage-think'].fallback.state, 'perch-peek');
});

test('a stage directory without a manifest block is refused before any strip read', t => {
  const w = fixture(t, 1); delete w.m.stage; w.save();
  let reads = 0;
  const io = { ...fs, openSync(path, ...args) { if (path.includes('/stage/')) reads++; return fs.openSync(path, ...args); } };
  assert.throws(() => api.loadCharacter(w.folder, { io }), /requires a stage block/); assert.equal(reads, 0);
});

test('JS and Swift stage state tables and bounds stay in step and full frames fit the channel', t => {
  const swift = fs.readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const section = swift.split('let spriteStageFallbacks: [String: String] = [')[1].split(']')[0];
  const native = Object.fromEntries([...section.matchAll(/"(stage-[a-z-]+)": "([a-z-]+)"/g)].map(m => [m[1], m[2]]));
  assert.deepEqual(native, api.STAGE_STATES);
  assert.match(swift, /let spriteStageCacheCap = 24 \* 1024 \* 1024/); assert.equal(api.STAGE_LIMITS.cache, 24 * 1024 ** 2);
  assert.match(swift, /stage == nil \? 8 : 4\) \* 1024 \* 1024/); assert.equal(api.STAGE_LIMITS.strip, 4 * 1024 ** 2);
  for (const pattern of [/files.count <= 24, pixels <= 24_000_000/, /pair\(entry\["cell"\], 192\.\.\.1024/, /count \* c\[0\] <= 4096/,
    /n\(entry\["frames"\], 1\.\.\.8/, /loop \? 40.0 : 20.0/, /ms.reduce\(0, \+\) <= 8000/, /next.count <= 4/]) assert.match(swift, pattern);
  assert.equal(api.STAGE_LIMITS.files, 24); assert.equal(api.STAGE_LIMITS.pixels, 24_000_000);
  for (const id of ['tsugi', 'yori']) {
    const pack = api.checkBuiltinCharacter(id), manifest = structuredClone(pack.manifest), files = new Map(pack.files);
    manifest.stage = { cell: { w: 384, h: 416 }, anchor: { x: 192, y: 392 }, states: {} };
    for (const state of Object.keys(api.STAGE_STATES)) {
      const file = `stage/${state.slice(6)}.png`;
      manifest.stage.states[state] = { file, frames: 6, ms: 100, loop: true, next: Object.keys(api.STAGE_STATES).slice(0, 4) };
      files.set(file, png(2304, 416));
    }
    const root = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-stage-frame-'))));
    const folder = join(root, id); fs.mkdirSync(folder, { mode: 0o700 }); fs.mkdirSync(join(folder, 'stage'), { mode: 0o700 });
    files.set('character.json', Buffer.from(JSON.stringify(manifest)));
    for (const [name, bytes] of files) fs.writeFileSync(join(folder, name), bytes, { mode: 0o600 });
    const checked = api.loadCharacter(folder);
    const frame = characterFrame(checked, { nonce: 'a'.repeat(64), seq: 0, resolve: api.resolveCharacterStates });
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= 32768);
  }
});

// Raw ustar fixtures bypass the encoder's protections to test the decoder's independent boundary.
function rawArchive(entries) {
  const chunks = [];
  for (const { name, bytes = Buffer.alloc(0), type = '0', size = bytes.length } of entries) {
    const h = Buffer.alloc(512); h.write(name, 0, 100, 'ascii');
    const octal = (at, n, value) => h.write(value.toString(8).padStart(n - 1, '0') + '\0', at, n, 'ascii');
    octal(100, 8, 0o600); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, size); octal(136, 12, 0);
    h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
    const sum = h.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

test('archive stage path, type, count and byte bounds hold independently of the folder loader', async t => {
  const { decodeCharacterArchive } = await import('../plugins/sleight/lib/hand/character-archive.mjs');
  const w = fixture(t, 1), pack = w.load();
  const base = [...pack.files].filter(([name]) => !name.startsWith('stage/')).map(([name, bytes]) => ({ name, bytes }));
  for (const name of ['stage/../a.png', 'stage/nested/a.png', 'stage/A.png', '/stage/a.png', 'stage/.DS_Store']) {
    assert.throws(() => decodeCharacterArchive(rawArchive([...base, { name }])), /entry name/);
  }
  for (const type of ['5', '2', '1']) assert.throws(() => decodeCharacterArchive(rawArchive([...base, { name: 'stage/a.png', type }])), /links, paths/);
  assert.throws(() => decodeCharacterArchive(rawArchive([...base, { name: 'stage/a.png', size: 4 * 1024 ** 2 + 1 }])), /size cap/);
  const strips = Array.from({ length: 25 }, (_, i) => ({ name: `stage/strip-${String.fromCharCode(97 + i)}.png`, bytes: png(384, 416) }));
  assert.equal(decodeCharacterArchive(rawArchive([...base, ...strips.slice(0, 24)])).size, base.length + 24);
  assert.throws(() => decodeCharacterArchive(rawArchive([...base, ...strips])), /stage entry count/);
  const plain = structuredClone(w.m); delete plain.stage;
  assert.throws(() => decodeCharacterArchive(rawArchive([{ name: 'character.json', bytes: Buffer.from(JSON.stringify(plain)) },
    { name: 'sheet.png', bytes: png(1536, 208) }, strips[0]])), /stage files refused/);
  assert.throws(() => decodeCharacterArchive(Buffer.alloc(52 * 1024 ** 2)), /invalid archive size/);
});
