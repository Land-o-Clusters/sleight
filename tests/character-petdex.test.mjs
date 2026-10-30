import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { encodePng } from '../bench/hand/synthetic-character.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { prepareCharacterImport, installCharacter, checkCharacter, resolveCharacterStates, characterCallout } from '../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../plugins/sleight/lib/hand/character-frame.mjs';
import { cursorCommand } from '../plugins/sleight/lib/hand/cursor-command.mjs';

// Petdex documents nine states and two extra v2 rows. sleight uses its existing Codex row mapping.
// Draw colored squares ourselves. No pet files, images or remote services are used.
const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
const atlases = new Map();
function atlas(rows) {
  if (!atlases.has(rows)) {
    const width = 1536, height = rows * 208, pixels = new Uint8Array(width * height * 4);
    for (let row = 0; row < rows; row++) for (let col = 0; col < counts[row]; col++) {
      for (let y = 80; y < 96; y++) for (let x = 80; x < 96; x++) {
        pixels.set([160 + row, 40 + col, 180, 255], ((row * 208 + y) * width + col * 192 + x) * 4);
      }
    }
    atlases.set(rows, encodePng(width, height, pixels));
  }
  return atlases.get(rows);
}
function fixture(t, version = 1, rows = version === 2 ? 11 : 9) {
  // The native decoder's macOS test override accepts only canonical /tmp banks.
  const temporary = process.platform === 'darwin' ? '/tmp' : tmpdir();
  const base = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join(temporary, 'sleight-petdex-'))));
  const source = join(base, 'download'), root = join(base, 'characters'); fs.mkdirSync(source, { mode: 0o700 });
  const pet = { id: 'synthetic-pet', displayName: 'Synthetic pet', description: 'Generated squares.', spritesheetPath: 'spritesheet.png' };
  if (version !== undefined) pet.spriteVersionNumber = version;
  const save = () => fs.writeFileSync(join(source, 'pet.json'), JSON.stringify(pet), { mode: 0o600 });
  save(); fs.writeFileSync(join(source, 'spritesheet.png'), atlas(rows), { mode: 0o600 });
  return { base, source, root, pet, save };
}

for (const version of [1, 2, 'omitted']) test(`Petdex ${version} imports unchanged through the folder wizard and installed loader`, async t => {
  const w = fixture(t, version === 2 ? 2 : 1);
  if (version === 'omitted') { delete w.pet.spriteVersionNumber; w.save(); }
  const before = fs.readFileSync(join(w.source, 'pet.json')), rows = version === 2 ? 11 : 9;
  let output = '';
  const path = join(w.base, 'hand.json');
  assert.equal(await cursorCommand(['import', w.source, '--yes'], { root: w.root, path, out: s => output += s }), 0, output);
  const result = checkCharacter('synthetic-pet', { root: w.root });
  assert.equal(result.manifest.grid.rows, rows);
  assert.equal(result.manifest.codex.spriteVersionNumber, version === 2 ? 2 : 1);
  assert.equal(result.manifest.scale, 0.5);
  assert.equal(result.resolved.filter(s => s.own).length, version === 2 ? 9 : 7);
  assert.deepEqual(fs.readFileSync(join(result.folder, 'sheet.png')), atlas(rows));
  assert.deepEqual(fs.readFileSync(join(w.source, 'spritesheet.png')), atlas(rows));
  assert.deepEqual(fs.readFileSync(join(w.source, 'pet.json')), before);
  assert.equal(fs.existsSync(path), false, 'import must not select or display the sprite');
  assert.match(output, /The sprite stays hidden/);
  for (const file of fs.readdirSync(result.folder)) assert.equal(fs.statSync(join(result.folder, file)).mode & 0o777, 0o600);
  t.diagnostic(`rows=${rows} pngBytes=${atlas(rows).length} installedBytes=${result.total}`);
});

test('nine-row movement chooses left or right at every distance; aim and scroll never reference direction rows', t => {
  const w = fixture(t), imported = prepareCharacterImport(w.source);
  assert.equal(imported.manifest.states.look, undefined);
  for (let direction = 0; direction < 16; direction++) for (const distance of [0, 30, 100]) {
    const result = resolveCharacterStates(imported.manifest, { heading: direction * 22.5, distance });
    const by = Object.fromEntries(result.map(s => [s.state, s]));
    const row = direction <= 8 ? 1 : 2;
    for (const state of ['move', 'drag-carry']) { assert.equal(by[state].row, row); assert.equal(by[state].frames, 8); assert.equal(by[state].own, false); }
    assert.equal(by.aim.row, 0); assert.equal(by.aim.own, false);
    for (const state of ['scroll-up', 'scroll-down']) { assert.equal(by[state].row, 7); assert.equal(by[state].look, undefined); }
    for (const s of result) { assert.ok(s.row >= 0 && s.row < 9); assert.ok(s.start + s.frames <= 8); assert.equal(s.flip, false); }
  }
  const callout = characterCallout(imported);
  assert.match(callout, /7 of sleight's 19 moves.*12 more:/);
  for (const s of imported.resolved.filter(s => !s.own)) assert.ok(callout.includes(`${s.label}: uses its`), s.label);
  assert.match(callout, /Move: uses its running right animation/);
  assert.match(callout, /Aim: uses its resting animation/);
  assert.match(callout, /no look directions.*running left or right.*idle while aiming/);
  assert.doesNotMatch(callout, /looking up|looking down/);
});

for (const [version, rows] of [[1, 11], [2, 9], [0, 9], [3, 11], [null, 9], ['1', 9], ['2', 11]]) {
  test(`refuses Petdex version ${JSON.stringify(version)} with ${rows} rows`, t => {
    const w = fixture(t, version, rows);
    assert.throws(() => prepareCharacterImport(w.source), [1, 2].includes(version)
      ? new RegExp(`Codex v${version} sheet dimensions must be 1536x${version === 1 ? 1872 : 2288}`) : /spriteVersionNumber/);
    assert.equal(fs.existsSync(w.root), false);
  });
}

test('an omitted version remains v1 and cannot silently reinterpret an 11-row atlas', t => {
  const w = fixture(t, 2); delete w.pet.spriteVersionNumber; w.save();
  assert.throws(() => prepareCharacterImport(w.source), /Codex v1 sheet dimensions must be 1536x1872/);
});

test('nine-row pet imports retain the common path, file and image validation', t => {
  const w = fixture(t), image = join(w.source, 'spritesheet.png');
  for (const name of ['../spritesheet.png', 'https://example.invalid/pet.png']) {
    w.pet.spritesheetPath = name; w.save(); assert.throws(() => prepareCharacterImport(w.source), /spritesheetPath: invalid sheet filename/);
  }
  w.pet.spritesheetPath = 'spritesheet.png'; w.save();
  fs.chmodSync(image, 0o666); assert.throws(() => prepareCharacterImport(w.source), /unsafe character file mode/); fs.chmodSync(image, 0o600);
  fs.renameSync(image, join(w.base, 'outside.png')); fs.symlinkSync(join(w.base, 'outside.png'), image);
  assert.throws(() => prepareCharacterImport(w.source), /symlinks or hardlinks/); fs.unlinkSync(image);
  fs.writeFileSync(image, Buffer.from('not a PNG'), { mode: 0o600 }); assert.throws(() => prepareCharacterImport(w.source), /invalid PNG/);
  fs.writeFileSync(image, atlas(9)); fs.writeFileSync(join(w.source, 'run.js'), 'throw 1', { mode: 0o600 });
  assert.throws(() => prepareCharacterImport(w.source), /extra character file refused/);
});

test('pasted gallery, asset and custom-protocol URLs refuse without fetching or installing', async t => {
  const w = fixture(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; throw Error('network must not run'); });
  for (const source of ['https://petdex.dev/pets/example', 'https://assets.petdex.dev/example/spritesheet.webp', 'petdex://example', 'codex://pets/install?name=example', 'file:///' + ['private', 'tmp', 'pet'].join('/'), 'data:application/json,{}']) {
    let output = '';
    assert.equal(await cursorCommand(['import', source, '--yes'], { root: w.root, out: s => output += s }), 1);
    assert.match(output, /never fetches.*download.*local folder/i);
    assert.doesNotMatch(output, /ENOENT/);
  }
  assert.equal(calls, 0); assert.equal(fs.existsSync(w.root), false);
  t.diagnostic('6 pasted URLs refused; fetchCalls=0; installedFolders=0');
});

test('known schemes without slashes refuse before filesystem lookup', async t => {
  const w = fixture(t);
  for (const source of ['mailto:artist@example.invalid', 'https:petdex.dev/pets/example', 'javascript:void(0)', 'blob:example']) {
    assert.throws(() => prepareCharacterImport(source), /never fetches/);
    let output = '';
    assert.equal(await cursorCommand(['import', source, '--yes'], { root: w.root, out: s => output += s }), 1);
    assert.match(output, /never fetches/); assert.doesNotMatch(output, /ENOENT/);
  }
  assert.equal(fs.existsSync(w.root), false);
});

test('a relative local folder named a:b imports through the CLI', async t => {
  const w = fixture(t), before = process.cwd();
  fs.renameSync(w.source, join(w.base, 'a:b'));
  try {
    process.chdir(w.base);
    let output = '';
    assert.equal(await cursorCommand(['import', 'a:b', '--yes'], { root: w.root, path: join(w.base, 'hand.json'), out: s => output += s }), 0, output);
    assert.equal(checkCharacter('synthetic-pet', { root: w.root }).manifest.grid.rows, 9);
  } finally { process.chdir(before); }
});

test('generated pet atlases reach the existing sandboxed decoder with no windows', { skip: process.platform !== 'darwin' && 'requires macOS' }, async t => {
  const w = fixture(t);
  const source = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
  assert.match(fs.readFileSync(source, 'utf8'), /if arguments.first == "--check-character"/);
  const binary = join(w.base, 'host');
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), source, '-o', binary], { encoding: 'utf8', timeout: 300000 });
  assert.equal(build.status, 0, build.stderr);
  const encoder = spawnSync('cwebp', ['-version'], { encoding: 'utf8', timeout: 5000 });
  for (const version of [1, 2]) for (const ext of ['png', 'webp']) await t.test(`v${version} ${ext} decoding`, {
    skip: ext === 'webp' && encoder.status !== 0 && 'cwebp unavailable for synthetic WebP generation',
  }, t => {
    const f = fixture(t, version), rows = version === 1 ? 9 : 11;
    if (ext === 'webp') {
      const encoded = spawnSync('cwebp', ['-quiet', '-lossless', '-exact', join(f.source, 'spritesheet.png'), '-o', join(f.source, 'spritesheet.webp')], { encoding: 'utf8', timeout: 30000 });
      assert.equal(encoded.status, 0, encoded.stderr);
      fs.chmodSync(join(f.source, 'spritesheet.webp'), 0o600); fs.unlinkSync(join(f.source, 'spritesheet.png'));
      f.pet.spritesheetPath = 'spritesheet.webp'; f.save();
    }
    const bytes = fs.readFileSync(join(f.source, f.pet.spritesheetPath));
    installCharacter(prepareCharacterImport(f.source), { root: f.root });
    const result = checkCharacter('synthetic-pet', { root: f.root });
    assert.deepEqual(fs.readFileSync(join(result.folder, `sheet.${ext}`)), bytes);
    const frame = characterFrame(result, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates });
    for (const entry of [...Object.values(frame.table), ...Object.values(frame.perch.table)]) assert.ok(entry.row < rows);
    const run = input => spawnSync(binary, ['--check-character'], { input: JSON.stringify(input) + '\n', encoding: 'utf8', timeout: 15000,
      env: { PATH: '/usr/bin:/bin', SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: f.root } });
    const good = run(frame); assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(JSON.parse(good.stdout), { id: 'synthetic-pet', loaded: true, reason: null, warnings: [] });
    fs.writeFileSync(join(result.folder, `sheet.${ext}`), bytes.subarray(0, 16));
    const broken = run(frame); assert.equal(broken.status, 0, broken.stderr); assert.equal(JSON.parse(broken.stdout).loaded, false);
    t.diagnostic(`sheetBytes=${bytes.length} frameBytes=${Buffer.byteLength(JSON.stringify(frame))}`);
  });
  t.diagnostic(`hostBytes=${fs.statSync(binary).size} cwebp=${encoder.stdout.trim()}`);
});
