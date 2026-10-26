import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';

import * as api from '../plugins/sleight/lib/hand/character.mjs';
import * as cli from '../plugins/sleight/lib/hand/cursor-command.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
const png = (w = 1536, h = 2288) => {
  const b = Buffer.alloc(57); Buffer.from('89504e470d0a1a0a', 'hex').copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
  b.write('IDAT', 37); b.write('IEND', 49); return b;
};
const webp = (w = 1536, h = 2288, kind = 'VP8X') => {
  const b = Buffer.alloc(kind === 'VP8 ' ? 30 : 30); b.write('RIFF'); b.writeUInt32LE(22, 4); b.write('WEBP', 8); b.write(kind, 12); b.writeUInt32LE(10, 16);
  if (kind === 'VP8X') { b[20] = 16; b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); }
  else if (kind === 'VP8L') { b[20] = 0x2f; b.writeUInt32LE(((w - 1) | ((h - 1) << 14) | (1 << 28)) >>> 0, 21); }
  else { b[23] = 0x9d; b[24] = 1; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); }
  return kind === 'VP8X' ? riff(b.subarray(12), webp(w, h, 'VP8L').subarray(12)) : b;
};
const riff = (...chunks) => {
  const body = Buffer.concat(chunks), b = Buffer.alloc(12); b.write('RIFF'); b.writeUInt32LE(body.length + 4, 4); b.write('WEBP', 8);
  return Buffer.concat([b, body]);
};
const manifest = () => ({ format: 'sleight-character', version: 1, id: 'test-cat', name: 'Test Cat', description: '', author: 'Test artist', license: 'CC0-1.0', sheet: 'sheet.png', frame: { w: 192, h: 208 }, grid: { cols: 8, rows: 11 }, scale: 1, anchor: { x: 96, y: 196 }, hotspot: { x: 96, y: 104 }, states: { idle: { row: 0, frames: 6, ms: 100, loop: true } } });
function world(t) {
  const base = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-character-'))));
  const folder = join(base, 'test-cat'), root = join(base, 'characters'); fs.mkdirSync(folder, { mode: 0o700 });
  const put = (name, value) => fs.writeFileSync(join(folder, name), Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  const data = manifest(); put('character.json', data); put('sheet.png', png());
  return { base, folder, root, put, data, save: () => put('character.json', data), load: options => api.loadCharacter(folder, options) };
}
function pet(w, kind = 'png') {
  fs.unlinkSync(join(w.folder, 'character.json')); fs.unlinkSync(join(w.folder, 'sheet.png'));
  const sheet = kind === 'png' ? png() : webp();
  w.put(`spritesheet.${kind}`, sheet); w.put('pet.json', { id: 'test-cat', displayName: 'Test Cat', description: 'A test cat.', spriteVersionNumber: 2, spritesheetPath: `spritesheet.${kind}` }); return sheet;
}

test('character API exists', () => { assert.equal(typeof api.loadCharacter, 'function'); });
test('cursor style saves only valid installed sprites and status is read-only', async t => {
  const w = world(t); api.installCharacter(api.prepareCharacterImport(w.folder), { root: w.root });
  const path = join(w.base, 'hand.json'); let output = '';
  const opts = { path, root: w.root, platform: 'darwin', env: {}, built: () => false, out: s => output += s };
  fs.writeFileSync(path, JSON.stringify({ version: 1, enabled: true, stream: true, labels: 'role' }), { mode: 0o600 });
  assert.equal(await cli.cursorCommand(['style', 'sprite', 'missing'], opts), 1);
  assert.equal(await cli.cursorCommand(['style', 'sprite', '../x'], opts), 1);
  assert.equal(await cli.cursorCommand(['style', 'sprite', 'test-cat'], opts), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path)), { version: 1, enabled: true, stream: true, labels: 'role', style: 'sprite', character: 'test-cat' });
  for (const style of ['glove', 'ring', 'seam']) assert.equal(await cli.cursorCommand(['style', style], opts), 0);
  const before = fs.readFileSync(path, 'utf8');
  output = ''; assert.equal(await cli.cursorCommand(['status'], opts), 0);
  for (const line of ['style     seam', 'character test-cat', 'stream    on', 'labels    role', 'host      not compiled']) assert.ok(output.includes(line), output);
  assert.equal(fs.readFileSync(path, 'utf8'), before);
  fs.chmodSync(join(w.root, 'test-cat/character.json'), 0o644);
  assert.equal(await cli.cursorCommand(['style', 'sprite', 'test-cat'], opts), 1);
  output = ''; assert.equal(await cli.cursorCommand(['check', 'test-cat'], opts), 1);
});
test('cursor check runs the host\'s own checks on the character frame when the host is compiled', async t => {
  const w = world(t); api.installCharacter(api.prepareCharacterImport(w.folder), { root: w.root });
  let output = '', frames = [];
  const opts = { builtins: false, root: w.root, path: join(w.base, 'hand.json'), out: s => output += s };
  const host = result => async frame => { frames.push(frame); return result; };
  assert.equal(await cli.cursorCommand(['check', 'test-cat'], { ...opts, built: () => false, hostCheck: host() }), 0);
  assert.match(output, /Host check skipped: the hand host is not compiled yet/); assert.equal(frames.length, 0);
  output = ''; assert.equal(await cli.cursorCommand(['check', 'test-cat'], { ...opts, built: () => true, hostCheck: host({ id: 'test-cat', loaded: true, reason: null, warnings: [] }) }), 0);
  assert.match(output, /Host check: draws\.\n$/);
  assert.equal(frames[0].hand, 'character'); assert.equal(frames[0].id, 'test-cat'); assert.match(frames[0].nonce, /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(frames[0].table).filter(k => !k.includes('@')).length, 19);
  output = ''; assert.equal(await cli.cursorCommand(['check', 'test-cat'], { ...opts, built: () => true, hostCheck: host({ id: 'test-cat', loaded: false, reason: 'pixels', warnings: [] }) }), 1);
  assert.match(output, /Host check: refused \(pixels\)\. sleight shows the ring instead of this character\./);
  output = ''; assert.equal(await cli.cursorCommand(['check', 'test-cat'], { ...opts, built: () => true, hostCheck: async () => { throw Error('the hand host is unavailable (APPLE_TOOLS_MISSING)'); } }), 1);
  assert.match(output, /cursor check failed: the hand host is unavailable/);
});

test('cursor status and style say when the hand is off or the file is unsafe, and sprite no longer says it draws as the ring', async t => {
  const w = world(t); api.installCharacter(api.prepareCharacterImport(w.folder), { root: w.root });
  const path = join(w.base, 'hand.json'); let output = '';
  const opts = { path, root: w.root, platform: 'darwin', env: {}, built: () => false, out: s => output += s };
  fs.writeFileSync(path, JSON.stringify({ version: 1, enabled: false }), { mode: 0o600 });
  assert.equal(await cli.cursorCommand(['style', 'ring'], opts), 0);
  assert.match(output, /Cursor style: ring\. The hand is off, so it draws nothing yet\. Turn it on with sleight-mcp hand on/);
  output = ''; assert.equal(await cli.cursorCommand(['status'], opts), 0);
  assert.match(output, /^hand {6}off\n/); assert.match(output, /The hand is off, so no style draws/);
  fs.writeFileSync(path, JSON.stringify({ version: 1, enabled: true }), { mode: 0o600 });
  output = ''; assert.equal(await cli.cursorCommand(['style', 'sprite', 'test-cat'], opts), 0);
  assert.match(output, /Start a new sleight session to use it\.\n$/); assert.doesNotMatch(output, /draws as the ring/);
  output = ''; assert.equal(await cli.cursorCommand(['status'], opts), 0);
  assert.match(output, /^hand {6}on\n/); assert.doesNotMatch(output, /draws as the ring|hand is off/);
  fs.chmodSync(path, 0o644);
  output = ''; assert.equal(await cli.cursorCommand(['status'], opts), 0);
  assert.match(output, /^hand {6}off \(hand\.json is unsafe to read; run sleight-mcp hand on or off to replace it\)\n/);
  output = ''; assert.equal(await cli.cursorCommand(['status'], { ...opts, env: { SLEIGHT_HAND: '0' } }), 0);
  assert.match(output, /^hand {6}off \(SLEIGHT_HAND=0\)\n/);
});
test('installed checks omit source-copy text, symlinks offer removal, and malformed folder names can be removed', async t => {
  const w = world(t); api.installCharacter(api.prepareCharacterImport(w.folder), { root: w.root });
  let output = ''; const opts = { builtins: false, root: w.root, out: s => output += s, built: () => false };
  assert.equal(await cli.cursorCommand(['check', 'test-cat'], opts), 0); assert.doesNotMatch(output, /Your source files/);
  fs.symlinkSync(w.folder, join(w.root, 'linked')); output = '';
  assert.equal(await cli.cursorCommand(['list'], opts), 1); assert.match(output, /remove the link by hand/);
  assert.throws(() => api.removeCharacter('linked', opts), /remove the link by hand/); assert.ok(fs.existsSync(w.folder));
  for (const name of ['Capital', 'with spaces']) {
    fs.mkdirSync(join(w.root, name)); assert.equal(api.removeCharacter(name, opts), true);
  }
  output = ''; assert.equal(await cli.cursorCommand(['remove', '../x'], opts), 1);
  assert.ok(output.includes('../x')); assert.ok(!output.includes('character.json'));
});
test('Codex ids with capitals, underscores or spaces import as slugs and retain the original display name', t => {
  const w = world(t); pet(w);
  for (const id of ['Test_Cat', 'Space Cat', 'CAPITAL']) {
    const data = JSON.parse(fs.readFileSync(join(w.folder, 'pet.json'))); data.id = id; w.put('pet.json', data);
    const result = api.prepareCharacterImport(w.folder);
    assert.equal(result.manifest.id, id.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
    assert.equal(result.manifest.name, id); assert.equal(result.manifest.codex.importedFrom, id);
  }
});
test('idle-only resolves all 19 events and the callout is generated from that table', t => {
  const w = world(t), loaded = w.load(); assert.equal(loaded.resolved.length, 19);
  assert.equal(loaded.resolved.filter(s => s.own).length, 1);
  for (const state of loaded.resolved) { assert.equal(state.row, 0); assert.equal(state.sheet, 'sheet.png'); assert.equal(state.flip, false); }
  const text = api.characterCallout(loaded); assert.match(text, /1 of sleight's 19 moves/);
  for (const state of loaded.resolved.filter(s => !s.own)) assert.ok(text.includes(`${state.label}: uses its resting animation`));
  assert.match(text, /extra.webp/); assert.match(text, /docs\/design\/character-format.md/);
});
for (const kind of ['png', 'webp']) test(`Codex v2 ${kind} copies bytes unchanged, with 9 own states and private atomic installation`, t => {
  const w = world(t), bytes = pet(w, kind), source = api.prepareCharacterImport(w.folder);
  assert.equal(source.resolved.filter(s => s.own).length, 9); assert.equal(source.manifest.license, 'unknown');
  assert.equal(source.manifest.scale, 0.5, 'a Codex cell draws as 96x104 pt');
  assert.match(api.characterCallout(source), /License: not stated/);
  const installed = api.installCharacter(source, { root: w.root });
  assert.deepEqual(fs.readFileSync(join(installed, `sheet.${kind}`)), bytes);
  assert.deepEqual(fs.readFileSync(join(w.folder, `spritesheet.${kind}`)), bytes);
  assert.equal(fs.statSync(installed).mode & 0o777, 0o700); assert.equal(fs.statSync(w.root).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(installed)) assert.equal(fs.statSync(join(installed, file)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(w.root), ['test-cat']); assert.equal(api.loadCharacter(installed).resolved.length, 19);
  assert.throws(() => api.installCharacter(source, { root: w.root }), /exists/i);
});
for (const kind of ['VP8X', 'VP8L', 'VP8 ']) test(`reads ${kind} dimensions without decoding`, () => assert.deepEqual(api.imageDimensions(webp(1536, 2288, kind), '.webp'), { width: 1536, height: 2288 }));
for (const [name, chunks, error] of [
  ['later canvas hiding large image', [webp(16384, 16384, 'VP8L').subarray(12), webp().subarray(12, 30)], /VP8X must be first/],
  ['canvas smaller than image', [webp().subarray(12, 30), webp(16384, 16384, 'VP8L').subarray(12)], /canvas.*image/],
  ['canvas without image', [webp().subarray(12, 30)], /exactly one image/],
  ['duplicate canvas', [webp().subarray(12, 30), webp().subarray(12, 30), webp(1536, 2288, 'VP8L').subarray(12)], /VP8X must be first/],
  ['duplicate image', [webp(1536, 2288, 'VP8L').subarray(12), webp(1536, 2288, 'VP8 ').subarray(12)], /exactly one image/],
  ['unknown first chunk', [Buffer.from('JUNK\x00\x00\x00\x00', 'binary'), webp(1536, 2288, 'VP8L').subarray(12)], /first chunk/],
]) test(`refuses WebP ${name}`, () => assert.throws(() => api.imageDimensions(riff(...chunks), '.webp'), error));
for (const [name, bytes, error] of [
  ['IHDR only', png().subarray(0, 33), /IDAT.*IEND/],
  ['no IDAT', Buffer.concat([png().subarray(0, 33), png().subarray(45)]), /IDAT/],
  ['no IEND', png().subarray(0, 45), /IEND/],
  ['truncated chunk', (() => { const b = png(); b.writeUInt32BE(100, 33); return b; })(), /truncated PNG/],
  ['IHDR not first', (() => { const b = png(); b.write('IDAT', 12); return b; })(), /PNG sheet header/],
  ['trailing bytes after IEND', Buffer.concat([png(), Buffer.from('tail')]), /trailing data after PNG IEND/],
  ['duplicate IHDR', Buffer.concat([png().subarray(0, 33), png().subarray(8)]), /duplicate PNG IHDR/],
]) test(`refuses PNG ${name}`, () => assert.throws(() => api.imageDimensions(bytes, '.png'), error));
for (const selector of [['extra'], {}, 1, null, 'constructor', '__proto__']) test(`refuses non-string or unknown state sheet ${JSON.stringify(selector)}`, t => {
  const w = world(t); w.data.extra = 'extra.webp'; w.put('extra.webp', webp(1536, 2288));
  w.data.states.click = { sheet: selector, row: 10, frames: 1, ms: 100, loop: false }; w.save();
  assert.throws(() => w.load(), /states\.click\.sheet.*sheet or extra/);
});
test('CLI refuses unknown license in a source character.json pack', async t => {
  const w = world(t); w.data.license = 'unknown'; w.save(); let output = '';
  assert.equal(await cli.cursorCommand(['import', w.folder, '--yes'], { root: w.root, out: s => output += s }), 1);
  assert.match(output, /character\.json.*license.*shared character license must be stated/);
  assert.equal(fs.existsSync(w.root), false);
});
test('list reports stray entries and broken packs while listing healthy packs; remove repairs broken installs', async t => {
  const w = world(t); api.installCharacter(api.prepareCharacterImport(w.folder), { root: w.root });
  fs.cpSync(join(w.root, 'test-cat'), join(w.root, 'bad-cat'), { recursive: true });
  fs.writeFileSync(join(w.root, 'bad-cat/character.json'), '{');
  fs.writeFileSync(join(w.root, '.DS_Store'), 'Finder data'); fs.writeFileSync(join(w.root, 'notes'), 'stray');
  let output = ''; const opts = { builtins: false, root: w.root, out: s => output += s };
  assert.equal(await cli.cursorCommand(['list'], opts), 1);
  assert.match(output, /test-cat: Test Cat/); assert.match(output, /bad-cat: needs repair: .*character\.json.*JSON/);
  assert.match(output, /Skipped "\.DS_Store"/); assert.match(output, /Skipped "notes"/);
  assert.equal(await cli.cursorCommand(['remove', 'bad-cat'], opts), 0); assert.equal(fs.existsSync(join(w.root, 'bad-cat')), false);
  assert.equal(await cli.cursorCommand(['remove', '.DS_Store'], opts), 0); assert.match(output, /Skipped "\.DS_Store"/);
  assert.equal(fs.readFileSync(join(w.root, '.DS_Store'), 'utf8'), 'Finder data');
  fs.chmodSync(join(w.root, 'test-cat/sheet.png'), 0o644);
  assert.equal(await cli.cursorCommand(['remove', 'test-cat'], opts), 0);
});
test('source folder aliases and download names work; Finder metadata is never copied', t => {
  const w = world(t); w.put('.DS_Store', 'Finder data');
  const renamed = join(w.base, 'download (1)'); fs.renameSync(w.folder, renamed);
  const alias = join(w.base, 'alias'); fs.symlinkSync(renamed, alias);
  const prepared = api.prepareCharacterImport(alias); assert.equal(prepared.manifest.id, 'test-cat');
  assert.deepEqual([...prepared.files.keys()].sort(), ['character.json', 'sheet.png']);
  api.installCharacter(prepared, { root: w.root }); assert.equal(fs.existsSync(join(w.root, 'test-cat/.DS_Store')), false);
  const tmpAlias = w.base.replace(/^\/private\/tmp\//, '/tmp/');
  assert.equal(api.prepareCharacterImport(join(tmpAlias, 'download (1)')).manifest.id, 'test-cat');
});
test('source aliases do not allow symlinks inside a pack, including ignored Finder metadata', t => {
  const w = world(t); fs.symlinkSync(join(w.folder, 'sheet.png'), join(w.folder, '.DS_Store'));
  assert.throws(() => api.prepareCharacterImport(w.folder), /\.DS_Store.*entry:.*symlink/);
  fs.unlinkSync(join(w.folder, '.DS_Store')); fs.renameSync(join(w.folder, 'sheet.png'), join(w.base, 'outside.png'));
  fs.symlinkSync(join(w.base, 'outside.png'), join(w.folder, 'sheet.png'));
  assert.throws(() => api.prepareCharacterImport(w.folder), /sheet\.png.*file:.*symlinks/);
});
test('renderer storage lookup ignores environment overrides, even the CLI test flag', t => {
  const w = world(t), expected = api.charactersDirectory({});
  assert.equal(api.charactersDirectory({ SLEIGHT_CHARACTERS_DIR: w.root }), expected);
  assert.equal(api.charactersDirectory({ SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CHARACTERS_DIR: w.root }), expected);
});
test('ordinary punctuation is display text, while controls and invisible direction marks name their field', t => {
  const w = world(t); w.data.name = 'Cat / dog <3'; w.data.description = 'dev/ops, "hello" & goodbye \\ work'; w.save();
  assert.equal(w.load().manifest.description, w.data.description);
  for (const mark of ['\u001b', '\u0085', '\u200b', '\u200e', '\u200f', '\u061c', '\u202e']) {
    w.data.description = `bad${mark}text`; w.save(); assert.throws(() => w.load(), /character\.json.*description.*invalid description text/);
  }
});
test('refusals identify the actual file, field and storage mode repair', t => {
  const w = world(t); w.put('__MACOSX', 'metadata');
  assert.throws(() => w.load(), /"__MACOSX".*entry.*extra character file refused/); fs.unlinkSync(join(w.folder, '__MACOSX'));
  fs.mkdirSync(w.root, { mode: 0o755 });
  assert.throws(() => api.installCharacter(api.prepareCharacterImport(w.folder), { root: w.root }), error => {
    assert.ok(error.message.includes(`chmod 700 '${w.root}'`)); return true;
  });
});
test('missing source and installed folders identify the path and operation', async t => {
  const w = world(t); let output = '';
  assert.equal(await cli.cursorCommand(['import', join(w.base, 'absent'), '--yes'], { root: w.root, out: s => output += s }), 1);
  assert.match(output, /absent.*source: ENOENT/);
  fs.mkdirSync(w.root, { mode: 0o700 }); output = '';
  assert.equal(await cli.cursorCommand(['remove', 'absent'], { root: w.root, out: s => output += s }), 1);
  assert.match(output, /absent.*directory: ENOENT/);
});
test('Codex author and license refusals name pet.json and the original field', t => {
  const w = world(t); pet(w); const p = JSON.parse(fs.readFileSync(join(w.folder, 'pet.json')));
  for (const [field, value, error] of [['author', '', /pet\.json.*author: invalid author text/], ['license', 'Custom-terms', /pet\.json.*license: custom license requires LICENSE.txt/]]) {
    w.put('pet.json', { ...p, [field]: value }); assert.throws(() => api.prepareCharacterImport(w.folder), error);
  }
});
test('Codex-only callout names all 10 missing moves, their fallback art and added effects', t => {
  const w = world(t); pet(w); const result = api.prepareCharacterImport(w.folder);
  assert.equal(api.characterCallout(result), [
    "This pet has its own animation for 9 of sleight's 19 moves. To animate all of them it needs 10 more:",
    'Double-click: uses its jumping animation, played twice',
    'Right-click: uses its waving animation',
    'Key press: uses its running animation, first 3 frames',
    'Scroll up: uses its running animation, looking up',
    'Scroll down: uses its running animation, looking down',
    'Drag grab: uses its jumping animation, first 2 frames, holding the last frame',
    'Drag carry: uses its looking animation',
    'Drag drop: uses its jumping animation, landing frames',
    'Hand back: uses its waving animation, then rests',
    'Working: uses its running animation',
    'Character: Test Cat', `Size: ${result.total} bytes`, 'License: not stated',
    'Your source files are not changed. sleight copies them.',
    'To add animations, draw an extra.webp sheet; see docs/design/character-format.md.', '',
  ].join('\n'));
});
test('complete pack callout says all 19 moves are drawn and has no fallback lines', t => {
  const w = world(t); for (const { state } of api.CHARACTER_STATES) w.data.states[state] = { row: 0, frames: 1, ms: 100, loop: false };
  w.save(); const result = w.load();
  assert.equal(api.characterCallout(result), [
    "This character has its own animation for all 19 of sleight's moves.",
    'Character: Test Cat', `Size: ${result.total} bytes`, 'License: CC0-1.0',
    'Your source files are not changed. sleight copies them.',
    'To add animations, draw an extra.webp sheet; see docs/design/character-format.md.', '',
  ].join('\n'));
});
test('idle fallback callout includes pulse and red pulse effects with human names', t => {
  const w = world(t), text = api.characterCallout(w.load());
  assert.match(text, /Click: uses its resting animation, plus a pulse/);
  assert.match(text, /Waiting for your OK: uses its resting animation, plus a pulse/);
  assert.match(text, /Error: uses its resting animation, plus a red pulse/);
});
test('stale private import staging is swept, but fresh staging and symlinks are retained', t => {
  const w = world(t); fs.mkdirSync(w.root, { mode: 0o700 });
  const old = join(w.root, '.import-old'), fresh = join(w.root, '.import-fresh'), link = join(w.root, '.import-link');
  fs.mkdirSync(old, { mode: 0o700 }); fs.writeFileSync(join(old, 'partial'), 'x'); fs.utimesSync(old, 0, Date.now() / 1000 - 120);
  fs.mkdirSync(fresh, { mode: 0o700 }); fs.symlinkSync(w.folder, link);
  api.installCharacter(api.prepareCharacterImport(w.folder), { root: w.root });
  assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(fresh), true); assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});
test('descriptor identity rejects a same-path replacement after lstat', t => {
  const w = world(t); let swapped = false;
  const io = { ...fs, openSync(path, flags) {
    if (!swapped && path.endsWith('sheet.png')) {
      swapped = true; fs.renameSync(path, join(w.base, 'old.png')); fs.writeFileSync(path, png(), { mode: 0o600 });
    }
    return fs.openSync(path, flags);
  } };
  assert.throws(() => w.load({ io }), /sheet\.png.*file.*changed while opening/); assert.ok(swapped);
});
test('descriptor recheck rejects mutation during reading', t => {
  const w = world(t); let changed = false;
  const io = { ...fs, readSync(fd, ...args) {
    const count = fs.readSync(fd, ...args);
    if (!changed) { changed = true; fs.appendFileSync(join(w.folder, 'character.json'), ' '); }
    return count;
  } };
  assert.throws(() => w.load({ io }), /character\.json.*file.*changed while reading/); assert.ok(changed);
});
test('no-follow open refuses a symlink swapped in after the path check', t => {
  const w = world(t); let swapped = false;
  const io = { ...fs, openSync(path, flags) {
    if (!swapped && path.endsWith('sheet.png')) {
      swapped = true; fs.renameSync(path, join(w.base, 'old.png')); fs.symlinkSync(join(w.base, 'old.png'), path);
    }
    return fs.openSync(path, flags);
  } };
  assert.throws(() => w.load({ io }), /sheet\.png.*file: ELOOP/); assert.ok(swapped);
});
test('descriptor recheck rejects changed timestamps even when byte count stays the same', t => {
  const w = world(t); let changed = false;
  const io = { ...fs, readSync(fd, ...args) {
    const count = fs.readSync(fd, ...args);
    if (!changed) {
      changed = true; const path = join(w.folder, 'character.json'), before = fs.statSync(path);
      fs.utimesSync(path, before.atime, new Date(before.mtimeMs + 10_000));
    }
    return count;
  } };
  assert.throws(() => w.load({ io }), /character\.json.*file: character file changed while reading/); assert.ok(changed);
});
test('removing a broken character unlinks child symlinks without touching their targets', t => {
  const w = world(t); fs.mkdirSync(w.root, { mode: 0o700 }); fs.mkdirSync(join(w.root, 'broken'), { mode: 0o700 });
  fs.symlinkSync(w.folder, join(w.root, 'broken/linked'));
  assert.equal(api.removeCharacter('broken', { root: w.root }), true);
  assert.ok(fs.existsSync(join(w.folder, 'character.json'))); assert.equal(fs.existsSync(join(w.root, 'broken')), false);
});
test('extra sheet, directional selection, explicit flip and fallback-only states resolve', t => {
  const w = world(t); w.data.extra = 'extra.webp'; w.put('extra.webp', webp(1536, 416));
  w.data.states.click = { sheet: 'extra', row: 1, frames: 2, ms: [100, 200], loop: false, flip: 'h' };
  w.data.states.move = { dir16: { rowA: 9, rowB: 10 } }; w.data.states['drag-drop'] = { fallback: 'click' }; w.save();
  const s = Object.fromEntries(w.load().resolved.map(s => [s.state, s]));
  assert.equal(s.click.sheet, 'extra.webp'); assert.equal(s.click.row, 1); assert.equal(s.click.flip, 'h');
  assert.equal(s['drag-drop'].own, false); assert.equal(s['drag-drop'].row, 1);
  const states = api.resolveCharacterStates(w.load().manifest, { heading: 180 });
  assert.equal(states.find(s => s.state === 'move').row, 10); assert.equal(states.find(s => s.state === 'move').start, 0);
});
test('Codex movement uses running rows for long horizontal travel and dir16 otherwise', t => {
  const w = world(t); pet(w); const m = api.prepareCharacterImport(w.folder).manifest;
  const move = (heading, distance) => api.resolveCharacterStates(m, { heading, distance }).find(s => s.state === 'move');
  assert.equal(move(90, 100).row, 1); assert.equal(move(270, 100).row, 2); assert.equal(move(0, 100).row, 9);
});

const badManifest = [
  ['format', m => m.format = 'other'], ['version', m => m.version = 2], ['id syntax', m => m.id = '../cat'],
  ['id length', m => m.id = 'a'.repeat(49)], ['folder identity', m => m.id = 'another-cat'], ['name empty', m => m.name = ''],
  ['name cap', m => m.name = 'n'.repeat(61)], ['description cap', m => m.description = 'x'.repeat(201)],
  ['author empty', m => m.author = ''], ['author cap', m => m.author = 'a'.repeat(81)],
  ['control text', m => m.name = '\u001bcat'],
  ['license missing', m => delete m.license], ['shared unknown license', m => m.license = 'unknown'],
  ['license cap', m => m.license = 'a'.repeat(121)], ['sheet traversal', m => m.sheet = '../sheet.png'], ['sheet URL', m => m.sheet = 'https:cat.png'],
  ['sheet missing', m => m.sheet = 'sheet.webp'], ['sheet basename', m => m.sheet = 'absent.png'], ['extra filename', m => m.extra = 'other.webp'],
  ['small cell', m => m.frame.w = 63], ['large cell', m => m.frame.h = 513], ['fractional cell', m => m.frame.w = 192.5],
  ['grid columns', m => m.grid.cols = 9], ['grid rows', m => m.grid.rows = 0], ['dimensions', m => m.grid.rows = 10],
  ['small scale', m => m.scale = 0.2], ['large scale', m => m.scale = 2.1], ['anchor', m => m.anchor.x = -193],
  ['hotspot', m => m.hotspot.y = 417], ['state hotspot', m => m.states.idle.hotspot = { x: 0, y: 900 }],
  ['missing idle', m => delete m.states.idle], ['idle alias', m => m.states.idle = { fallback: 'click' }],
  ['state row', m => m.states.idle.row = 11], ['state row negative', m => m.states.idle.row = -1],
  ['frames zero', m => m.states.idle.frames = 0], ['frames large', m => m.states.idle.frames = 9],
  ['duration low', m => m.states.idle.ms = 19], ['duration high', m => m.states.idle.ms = 2001], ['duration total', m => m.states.idle.ms = 1000],
  ['duration array', m => m.states.idle.ms = [100]], ['loop', m => m.states.idle.loop = 1],
  ['looping flash', m => m.states.idle.ms = 30], ['flip', m => m.states.idle.flip = 'v'],
  ['missing extra', m => m.states.idle.sheet = 'extra'], ['bad sheet selector', m => m.states.idle.sheet = 'other'],
  ['fallback unknown', m => m.states.click = { fallback: 'surprise' }],
  ['fallback cycle', m => { m.states.click = { fallback: 'type' }; m.states.type = { fallback: 'click' }; }],
  ['cycle with art', m => { m.states.idle.fallback = 'click'; m.states.click = { fallback: 'idle' }; }],
  ['invalid dir16 state', m => m.states.click = { dir16: { rowA: 9, rowB: 10 } }],
  ['bad dir16 row', m => m.states.move = { dir16: { rowA: 9, rowB: 11 } }],
  ['mixed state', m => m.states.move = { dir16: { rowA: 9, rowB: 10 }, row: 1, frames: 2, ms: 100, loop: true }],
  ['Codex size', m => m.codex = { spriteVersionNumber: 2, importedFrom: 'test-cat' }],
];
const manifestErrors = {
  "format": "format/version: unsupported character format or version",
  "version": "format/version: unsupported character format or version",
  "id syntax": "id: invalid character id",
  "id length": "id: invalid character id",
  "folder identity": "id: character id must equal folder name",
  "name empty": "name: invalid name text",
  "name cap": "name: invalid name text",
  "description cap": "description: invalid description text",
  "author empty": "author: invalid author text",
  "author cap": "author: invalid author text",
  "control text": "name: invalid name text",
  "license missing": "license: invalid license text",
  "shared unknown license": "license: shared character license must be stated",
  "license cap": "license: invalid license text",
  "sheet traversal": "sheet: invalid sheet filename",
  "sheet URL": "sheet: invalid sheet filename",
  "sheet missing": "sheet.webp\" sheet: sheet file missing",
  "sheet basename": "sheet: sheet filename must be sheet.png or sheet.webp",
  "extra filename": "extra: extra sheet filename must be extra.webp",
  "small cell": "frame: invalid frame dimensions",
  "large cell": "frame: invalid frame dimensions",
  "fractional cell": "frame: invalid frame dimensions",
  "grid columns": "grid: invalid grid dimensions",
  "grid rows": "grid: invalid grid dimensions",
  "dimensions": "frame/grid: sheet dimensions do not match frame and grid",
  "small scale": "scale: invalid scale",
  "large scale": "scale: invalid scale",
  "anchor": "anchor: invalid anchor",
  "hotspot": "hotspot: invalid hotspot",
  "state hotspot": "states.idle.hotspot: invalid states.idle.hotspot",
  "missing idle": "states.idle: idle animation is required",
  "idle alias": "states.idle: idle animation is required",
  "state row": "states.idle.row/frames/start: invalid state row or frames",
  "state row negative": "states.idle.row/frames/start: invalid state row or frames",
  "frames zero": "states.idle.row/frames/start: invalid state row or frames",
  "frames large": "states.idle.row/frames/start: invalid state row or frames",
  "duration low": "states.idle.ms: invalid state duration",
  "duration high": "states.idle.ms: invalid state duration",
  "duration total": "states.idle.ms: invalid state duration",
  "duration array": "states.idle.ms: invalid state duration",
  "loop": "states.idle.loop: invalid state loop",
  "looping flash": "states.idle.ms: looping state duration must be at least 40 ms",
  "flip": "states.idle.flip: state flip must be h",
  "missing extra": "states.idle.sheet: state sheet missing",
  "bad sheet selector": "states.idle.sheet: must be sheet or extra",
  "fallback unknown": "states.click.fallback: unknown fallback state",
  "fallback cycle": "states.click.fallback: fallback cycle",
  "cycle with art": "states.idle.fallback: fallback cycle",
  "invalid dir16 state": "states.click.dir16: invalid dir16 state",
  "bad dir16 row": "states.move.dir16: invalid dir16 rows",
  "mixed state": "states.move.dir16: invalid dir16 state",
  "Codex size": "codex/frame/grid: Codex v2 sheet dimensions must be 1536x2288"
};
for (const [name, mutate] of badManifest) test(`refuses ${name}`, t => {
  const w = world(t); mutate(w.data);
  if (name === 'Codex size') { w.data.grid.rows = 10; w.put('sheet.png', png(1536, 2080)); }
  w.save(); assert.throws(() => w.load({ shared: true }), error => { assert.ok(error.message.includes(manifestErrors[name]), error.message); return true; });
});
for (const [name, bytes, error] of [['bad JSON', '{', /JSON: invalid JSON value/], ['duplicate keys', '{"format":1,"format":2}', /JSON: duplicate JSON key/], ['escaped duplicate', '{"a":1,"\\u0061":2}', /JSON: duplicate JSON key/], ['bad UTF8', Buffer.from([0xff]), /JSON: JSON is not UTF-8/], ['JSON cap', ' '.repeat(16384), /character\.json.*file: character file size cap exceeded/], ['JSON depth', '['.repeat(1000) + '0' + ']'.repeat(1000), /JSON: JSON nesting too deep/]]) test(`refuses ${name}`, t => {
  const w = world(t); w.put('character.json', bytes); assert.throws(() => w.load(), error);
});
const fileErrors = {
  "symlink sheet": "sheet.png\" file: sheet files must be regular, without symlinks or hardlinks",
  "symlink folder": "directory: symlink character directory refused",
  "symlink ancestor": "directory: symlink character directory refused",
  "extra file": "\"code.js\" entry: extra character file refused",
  "nested directory": "\"nested\" entry: extra character file refused",
  "executable": "sheet.png\" file: unsafe character file mode or executable bits",
  "shared writable": "sheet.png\" file: unsafe character file mode or executable bits",
  "shared folder": "directory: unsafe character directory mode",
  "hardlink": "sheet.png\" file: sheet files must be regular, without symlinks or hardlinks",
  "oversize sheet": "sheet.png\" file: character file size cap exceeded",
  "oversize license": "LICENSE.txt\" file: character file size cap exceeded",
  "bad magic": "sheet.png\" image: invalid PNG sheet header",
  "truncated PNG": "sheet.png\" image: invalid PNG sheet header",
  "APNG": "sheet.png\" image: animated PNG sheet is refused",
  "pixel budget": "sheet.png\" image: sheet pixel budget exceeded",
  "preview dimensions": "\"preview.png\" dimensions: preview dimensions exceed 256",
  "unsupported file": "\"sheet.gif\" entry: extra character file refused",
  "custom license text missing": "license: custom license requires LICENSE.txt",
  "extra sheet cap": "extra.webp\" file: character file size cap exceeded",
  "preview byte cap": "preview.png\" file: character file size cap exceeded",
  "extra cell grid": "extra.webp\" frame/grid: sheet dimensions do not match frame and grid",
  "too many entries": "entries: too many character files",
  "installed file modes": "sheet.png\" file: unsafe character file mode or executable bits"
};
for (const [name, action] of [
  ['symlink sheet', w => { fs.renameSync(join(w.folder, 'sheet.png'), join(w.base, 'outside.png')); fs.symlinkSync(join(w.base, 'outside.png'), join(w.folder, 'sheet.png')); }],
  ['symlink folder', w => { const link = join(w.base, 'link'); fs.symlinkSync(w.folder, link); w.folder = link; }],
  ['symlink ancestor', w => { const link = join(w.base, 'link'); fs.symlinkSync(w.base, link); w.folder = join(link, 'test-cat'); }],
  ['extra file', w => w.put('code.js', 'anything')], ['nested directory', w => fs.mkdirSync(join(w.folder, 'nested'))],
  ['executable', w => fs.chmodSync(join(w.folder, 'sheet.png'), 0o700)], ['shared writable', w => fs.chmodSync(join(w.folder, 'sheet.png'), 0o620)],
  ['shared folder', w => fs.chmodSync(w.folder, 0o770)], ['hardlink', w => fs.linkSync(join(w.folder, 'sheet.png'), join(w.base, 'hard.png'))],
  ['oversize sheet', w => fs.truncateSync(join(w.folder, 'sheet.png'), 8 * 1024 ** 2 + 1)],
  ['oversize license', w => w.put('LICENSE.txt', Buffer.alloc(64 * 1024 + 1))],
  ['bad magic', w => w.put('sheet.png', webp())], ['truncated PNG', w => w.put('sheet.png', png().subarray(0, 20))],
  ['APNG', w => { const b = png(); b.write('acTL', 37); w.put('sheet.png', b); }],
  ['pixel budget', w => w.put('sheet.png', png(5000, 5000))],
  ['preview dimensions', w => w.put('preview.png', png(257, 256))], ['unsupported file', w => w.put('sheet.gif', 'GIF89a')],
  ['custom license text missing', w => { w.data.license = 'My-own-license'; w.save(); }],
]) test(`refuses ${name}`, t => { const w = world(t); action(w); assert.throws(() => api.loadCharacter(w.folder), error => { assert.ok(error.message.includes(fileErrors[name]), error.message); return true; }); });
test('owner mismatch is rejected', t => { const w = world(t); assert.throws(() => w.load({ uid: process.getuid() + 1 }), /owner/i); });
test('local unknown license allowed; custom license requires text; warnings do not reject', t => {
  const w = world(t); w.data.license = 'unknown'; w.data.future = 1; w.data.states.future = {}; w.data.anchor.x = -10;
  w.data.states.click = { row: 1, frames: 1, ms: 30, loop: false }; w.save();
  const result = w.load(); assert.ok(result.warnings.length >= 4);
  w.data.license = 'My-own-license'; w.put('LICENSE.txt', 'Personal use only.'); w.save(); assert.equal(w.load().manifest.license, 'My-own-license');
});
test('imports refuse old Codex, unsafe manifests and unexpected files', t => {
  const w = world(t); pet(w); const p = JSON.parse(fs.readFileSync(join(w.folder, 'pet.json')));
  for (const [bad, error] of [[{ ...p, spriteVersionNumber: 1 }, /pet\.json.*spriteVersionNumber: Codex pet must/], [{ ...p, spritesheetPath: '../sheet.png' }, /pet\.json.*spritesheetPath: invalid sheet filename/], [{ ...p, displayName: '\u001bcat' }, /pet\.json.*displayName: invalid displayName text/]]) {
    w.put('pet.json', bad); assert.throws(() => api.prepareCharacterImport(w.folder), error);
  }
  w.put('pet.json', p); w.put('other.txt', 'x'); assert.throws(() => api.prepareCharacterImport(w.folder), /"other\.txt" entry: extra character file refused/);
});
test('staging remains invisible until rename; failure cleans staging and preserves existing installs', t => {
  const w = world(t), source = api.prepareCharacterImport(w.folder);
  const io = { ...fs, renameSync(from, to) {
    assert.equal(fs.existsSync(to), false); assert.equal(api.listCharacters({ root: w.root, builtins: false }).length, 0);
    assert.equal(api.loadCharacter(from, { expectedId: 'test-cat' }).resolved.length, 19); throw Error('rename failed');
  } };
  assert.throws(() => api.installCharacter(source, { root: w.root, io }), /rename failed/); assert.deepEqual(fs.readdirSync(w.root), []);
});
test('installation refuses linked/shared storage roots and invalid id removal', t => {
  const w = world(t), source = api.prepareCharacterImport(w.folder); fs.symlinkSync(w.folder, w.root);
  assert.throws(() => api.installCharacter(source, { root: w.root }), /directory: symlink character directory refused/); fs.unlinkSync(w.root); fs.mkdirSync(w.root, { mode: 0o755 });
  assert.throws(() => api.installCharacter(source, { root: w.root }), /directory: unsafe character directory mode/); assert.throws(() => api.removeCharacter('../test-cat', { root: w.root }), /id: invalid character id/);
});
test('total byte and pixel caps cover both sheets and preview', t => {
  const w = world(t); w.data.extra = 'extra.webp'; w.put('extra.webp', webp()); w.save();
  fs.truncateSync(join(w.folder, 'sheet.png'), 8 * 1024 ** 2); fs.truncateSync(join(w.folder, 'extra.webp'), 8 * 1024 ** 2);
  assert.throws(() => w.load(), /entries: total character size exceeds 16 MiB/);
  // The hand host's caps (cells at most 192x208, sheets at most 1536x2288) keep two sheets and a preview under the 16 MP
  // budget, so a larger cell or sheet fails first, with the reason the host would give.
  w.put('sheet.png', png(4096, 2080)); w.put('extra.webp', webp(4096, 2080)); w.data.frame.w = 512; w.data.grid.rows = 10; w.save();
  assert.throws(() => w.load(), /frame: invalid frame dimensions \(cells are at most 192x208\)/);
  w.put('sheet.png', png(1536, 2288)); w.put('extra.webp', webp(1536, 2496)); w.data.frame = { w: 192, h: 208 }; w.data.grid.rows = 11; w.save();
  assert.throws(() => w.load(), /"extra\.webp" frame\/grid: sheet too large to draw \(at most 1536x2288\)/);
});

test('CLI refuses non-TTY without --yes after printing details, accepts --yes, checks, lists and removes', async t => {
  const w = world(t); let output = ''; const opts = { builtins: false, root: w.root, path: join(w.base, 'hand.json'), out: text => output += text, input: { isTTY: false }, built: () => false };
  assert.equal(await cli.cursorCommand(['import', w.folder], opts), 1); assert.match(output, /1 of sleight's 19 moves/); assert.match(output, /--yes/); assert.equal(fs.existsSync(w.root), false);
  assert.equal(await cli.cursorCommand(['import', w.folder, '--yes'], opts), 0); assert.match(output, /Turn it on with sleight-mcp cursor style sprite/);
  assert.equal(await cli.cursorCommand(['check', 'test-cat'], opts), 0); assert.equal(await cli.cursorCommand(['list'], opts), 0);
  assert.equal(await cli.cursorCommand(['style', 'sprite', 'test-cat'], opts), 0); assert.match(output, /Cursor style: sprite/);
  assert.equal(await cli.cursorCommand(['remove', 'test-cat'], opts), 0); assert.deepEqual(fs.readdirSync(w.root), []);
  for (const args of [[], ['import'], ['import', w.folder, '--no'], ['list', 'extra'], ['check', '../a'], ['remove'], ['unknown']]) assert.notEqual(await cli.cursorCommand(args, opts), 0);
});
test('TTY confirmation defaults No and only explicit yes installs', async t => {
  for (const answer of ['', 'n', 'no', 'y', 'yes']) {
    const w = world(t); let output = ''; let asked = false;
    const code = await cli.cursorCommand(['import', w.folder], { root: w.root, out: text => output += text, input: { isTTY: true }, confirm: async prompt => {
      asked = true; assert.match(prompt, /\[y\/N\]/); assert.match(output, /License:/); assert.match(output, /extra.webp/); return answer;
    } });
    assert.ok(asked); assert.equal(code, 0); assert.equal(fs.existsSync(join(w.root, 'test-cat')), ['y', 'yes'].includes(answer));
  }
});
test('real readline confirmation handles a TTY-shaped stream and EOF defaults No', async t => {
  const w = world(t); const input = new Readable({ read() { this.push(null); } }); input.isTTY = true;
  assert.equal(await cli.cursorCommand(['import', w.folder], { root: w.root, input, out: () => {} }), 0);
  assert.equal(fs.existsSync(w.root), false);
});
test('real CLI routes cursor without starting an engine or touching settings', t => {
  const w = world(t); const result = spawnSync(process.execPath, ['plugins/sleight/lib/launch.mjs', 'cursor', 'list'], { encoding: 'utf8', env: { ...process.env, SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CHARACTERS_DIR: w.root } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /tsugi: Tsugi \[built-in\]/); assert.equal(fs.existsSync(w.root), false);
});

test('Codex optional events use the specified row slices, with source names in the callout', t => {
  const w = world(t); pet(w); const result = api.prepareCharacterImport(w.folder), s = Object.fromEntries(result.resolved.map(s => [s.state, s]));
  assert.deepEqual([s['right-click'].row, s['right-click'].frames], [3, 3]);
  assert.deepEqual([s['drag-grab'].row, s['drag-grab'].start, s['drag-grab'].frames], [4, 0, 2]);
  assert.deepEqual([s['drag-drop'].row, s['drag-drop'].start, s['drag-drop'].ms], [4, 3, [140, 280]]);
  for (const name of ['key', 'scroll-up', 'scroll-down', 'working']) assert.equal(s[name].row, 7);
  assert.equal(s['double-click'].repeat, 2); assert.equal(s.handoff.then, 'idle');
  const up = api.resolveCharacterStates(result.manifest, { heading: 0 }).find(s => s.state === 'aim');
  const down = api.resolveCharacterStates(result.manifest, { heading: 180 }).find(s => s.state === 'aim');
  assert.equal(up.row, 9); assert.equal(down.row, 10);
});
test('dir16 aim is refused; authors use look and aim fallback or a timed aim cell', t => {
  const w = world(t); w.data.states.aim = { dir16: { rowA: 9, rowB: 10 } }; w.save(); assert.throws(() => w.load(), /dir16/);
});
for (const [name, value] of [['unknown text cap', 'x'.repeat(201)], ['unknown control', '\u200f'], ['unknown nested control', { nested: '\u061c' }]]) test(`refuses ${name} even in ignored fields`, t => {
  const w = world(t); w.data.future = value; w.save(); assert.throws(() => w.load(), /character\.json.*future.*invalid future.*text/);
});
test('PNG and WebP magic, truncated chunks and animation markers are refused', () => {
  for (const [bytes, error] of [[Buffer.alloc(30), /invalid WebP sheet header/], [webp().subarray(0, 25), /invalid WebP sheet header/], [(() => { const b = webp(); b[20] |= 2; return b; })(), /animated WebP sheet is refused/], [(() => { const b = webp(); b.write('ANIM', 30); return b; })(), /animated WebP sheet is refused/]]) assert.throws(() => api.imageDimensions(bytes, '.webp'), error);
  assert.throws(() => api.imageDimensions(png(), '.svg'), /image: sheet must be PNG or WebP/);
});
test('unknown supported keys warn at every nesting level', t => {
  const w = world(t); w.data.frame.future = true; w.data.grid.future = true; w.data.states.idle.future = true; w.save();
  assert.equal(w.load().warnings.filter(s => s.startsWith('Unknown')).length, 3);
});
test('shared packs accept stated custom terms and reject missing or unknown license', t => {
  const w = world(t); w.data.license = 'My-terms'; w.put('LICENSE.txt', 'Use with permission.'); w.save(); assert.equal(w.load({ shared: true }).manifest.license, 'My-terms');
});
test('remove refuses linked installed data and leaves the target unchanged', t => {
  const w = world(t); fs.mkdirSync(w.root, { mode: 0o700 }); fs.symlinkSync(w.folder, join(w.root, 'test-cat'));
  assert.throws(() => api.removeCharacter('test-cat', { root: w.root }), /directory: symlink character directory refused/); assert.ok(fs.existsSync(join(w.folder, 'sheet.png')));
});
test('full set resolves 19 own animations and the callout has no missing lines', t => {
  const w = world(t); for (const { state } of api.CHARACTER_STATES) w.data.states[state] = { row: 0, frames: 1, ms: 100, loop: false };
  w.save(); const result = w.load(); assert.equal(result.resolved.filter(s => s.own).length, 19);
  assert.match(api.characterCallout(result), /all 19 of sleight's moves/); assert.doesNotMatch(api.characterCallout(result), /no animation of its own/);
});

test('fallback aliases retain explicit mirroring and hotspot overrides', t => {
  const w = world(t); w.data.states['running-right'] = { row: 1, frames: 8, ms: 120, loop: true };
  w.data.states['running-left'] = { fallback: 'running-right', flip: 'h', hotspot: { x: 1, y: 2 } };
  w.data.states.move = { fallback: 'running-left' }; w.save();
  const move = w.load().resolved.find(s => s.state === 'move'); assert.equal(move.flip, 'h'); assert.deepEqual(move.hotspot, { x: 1, y: 2 });
});
test('an explicit move fallback is honored for leftward movement', t => {
  const w = world(t); w.data.states.move = { fallback: 'click' }; w.data.states.click = { row: 4, frames: 3, ms: 100, loop: false }; w.save();
  const move = api.resolveCharacterStates(w.load().manifest, { heading: 270 }).find(s => s.state === 'move'); assert.equal(move.row, 4);
});
test('successful publish uses one rename after complete private validation', t => {
  const w = world(t); let renames = 0;
  api.installCharacter(api.prepareCharacterImport(w.folder), { root: w.root, io: { ...fs, renameSync(from, to) {
    renames++; assert.equal(fs.existsSync(to), false); assert.equal(fs.readdirSync(from).length, 2);
    assert.equal(api.listCharacters({ root: w.root, builtins: false }).length, 0); fs.renameSync(from, to);
  } } });
  assert.equal(renames, 1); assert.equal(api.listCharacters({ root: w.root, builtins: false }).length, 1);
});
for (const [name, action] of [
  ['extra sheet cap', w => { w.data.extra = 'extra.webp'; w.put('extra.webp', webp()); fs.truncateSync(join(w.folder, 'extra.webp'), 8 * 1024 ** 2 + 1); w.save(); }],
  ['preview byte cap', w => { w.put('preview.png', png(256, 256)); fs.truncateSync(join(w.folder, 'preview.png'), 1024 ** 2 + 1); }],
  ['extra cell grid', w => { w.data.extra = 'extra.webp'; w.put('extra.webp', webp(1536, 209)); w.save(); }],
  ['too many entries', w => { for (let i = 0; i < 7; i++) w.put(`extra${i}.png`, png()); }],
  ['installed file modes', w => fs.chmodSync(join(w.folder, 'sheet.png'), 0o644)],
]) test(`refuses ${name}`, t => { const w = world(t); action(w); assert.throws(() => w.load({ installed: name === 'installed file modes' }), error => { assert.ok(error.message.includes(fileErrors[name]), error.message); return true; }); });

test('source changes during confirmation do not change the reviewed snapshot', async t => {
  const w = world(t), reviewed = fs.readFileSync(join(w.folder, 'sheet.png')); let output = '';
  assert.equal(await cli.cursorCommand(['import', w.folder], { root: w.root, input: { isTTY: true }, out: s => output += s,
    confirm: async () => { w.put('sheet.png', 'replaced after review'); return 'yes'; } }), 0);
  assert.deepEqual(fs.readFileSync(join(w.root, 'test-cat/sheet.png')), reviewed); assert.match(output, /1 of sleight's 19 moves/);
});
test('special permission bits are refused on data files and installed directories', t => {
  const w = world(t); fs.chmodSync(join(w.folder, 'sheet.png'), 0o4600); assert.throws(() => w.load(), /sheet\.png.*file: unsafe character file mode or executable bits/);
  fs.chmodSync(join(w.folder, 'sheet.png'), 0o600); fs.chmodSync(w.folder, 0o1700); assert.throws(() => w.load({ installed: true }), /directory: unsafe character directory mode/);
});
