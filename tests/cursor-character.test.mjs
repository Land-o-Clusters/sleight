import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';

import * as api from '../plugins/sleight/lib/hand/character.mjs';
import * as cli from '../plugins/sleight/lib/hand/cursor-command.mjs';
const png = (w = 1536, h = 2288) => {
  const b = Buffer.alloc(45); Buffer.from('89504e470d0a1a0a', 'hex').copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
  b.write('IEND', 37); return b;
};
const webp = (w = 1536, h = 2288, kind = 'VP8X') => {
  const b = Buffer.alloc(kind === 'VP8 ' ? 30 : 30); b.write('RIFF'); b.writeUInt32LE(22, 4); b.write('WEBP', 8); b.write(kind, 12); b.writeUInt32LE(10, 16);
  if (kind === 'VP8X') { b[20] = 16; b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); }
  else if (kind === 'VP8L') { b[20] = 0x2f; b.writeUInt32LE(((w - 1) | ((h - 1) << 14) | (1 << 28)) >>> 0, 21); }
  else { b[23] = 0x9d; b[24] = 1; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); }
  return b;
};
const manifest = () => ({ format: 'sleight-character', version: 1, id: 'test-cat', name: 'Test Cat', description: '', author: 'Test artist', license: 'CC0-1.0', sheet: 'sheet.png', frame: { w: 192, h: 208 }, grid: { cols: 8, rows: 11 }, scale: 1, anchor: { x: 96, y: 196 }, hotspot: { x: 96, y: 104 }, states: { idle: { row: 0, frames: 6, ms: 100, loop: true } } });
function world(t) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-character-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
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
test('idle-only resolves all 19 events and the callout is generated from that table', t => {
  const w = world(t), loaded = w.load(); assert.equal(loaded.resolved.length, 19);
  assert.equal(loaded.resolved.filter(s => s.own).length, 1);
  for (const state of loaded.resolved) { assert.equal(state.row, 0); assert.equal(state.sheet, 'sheet.png'); assert.equal(state.flip, false); }
  const text = api.characterCallout(loaded); assert.match(text, /1 of 19/);
  for (const state of loaded.resolved.filter(s => !s.own)) assert.ok(text.includes(`${state.label}: no animation of its own, shows ${state.shows}`));
  assert.match(text, /extra.webp/); assert.match(text, /docs\/design\/character-format.md/);
});
for (const kind of ['png', 'webp']) test(`Codex v2 ${kind} copies bytes unchanged, with 9 own states and private atomic installation`, t => {
  const w = world(t), bytes = pet(w, kind), source = api.prepareCharacterImport(w.folder);
  assert.equal(source.resolved.filter(s => s.own).length, 9); assert.equal(source.manifest.license, 'unknown');
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
  ['author empty', m => m.author = ''], ['author cap', m => m.author = 'a'.repeat(81)], ['markup', m => m.name = '<b>cat</b>'],
  ['control text', m => m.name = '\u001bcat'], ['path in text', m => m.description = 'a/b'],
  ['license missing', m => delete m.license], ['shared unknown license', m => m.license = 'unknown'],
  ['license cap', m => m.license = 'a'.repeat(121)], ['sheet traversal', m => m.sheet = '../sheet.png'], ['sheet URL', m => m.sheet = 'https:cat.png'],
  ['sheet missing', m => m.sheet = 'absent.png'], ['extra filename', m => m.extra = 'other.webp'],
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
for (const [name, mutate] of badManifest) test(`refuses ${name}`, t => {
  const w = world(t); mutate(w.data);
  if (name === 'Codex size') { w.data.grid.rows = 10; w.put('sheet.png', png(1536, 2080)); }
  w.save(); assert.throws(() => w.load({ shared: true }), /character|sheet|state|license|frame|grid|duration|Codex|fallback|idle|format|version|scale|anchor|hotspot|dir16/i);
});
for (const [name, bytes] of [['bad JSON', '{'], ['duplicate keys', '{"format":1,"format":2}'], ['escaped duplicate', '{"a":1,"\\u0061":2}'], ['bad UTF8', Buffer.from([0xff])], ['JSON cap', ' '.repeat(16384)], ['JSON depth', '['.repeat(1000) + '0' + ']'.repeat(1000)]]) test(`refuses ${name}`, t => {
  const w = world(t); w.put('character.json', bytes); assert.throws(() => w.load());
});
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
]) test(`refuses ${name}`, t => { const w = world(t); action(w); assert.throws(() => api.loadCharacter(w.folder)); });
test('owner mismatch is rejected', t => { const w = world(t); assert.throws(() => w.load({ uid: process.getuid() + 1 }), /owner/i); });
test('local unknown license allowed; custom license requires text; warnings do not reject', t => {
  const w = world(t); w.data.license = 'unknown'; w.data.future = 1; w.data.states.future = {}; w.data.anchor.x = -10;
  w.data.states.click = { row: 1, frames: 1, ms: 30, loop: false }; w.save();
  const result = w.load(); assert.ok(result.warnings.length >= 4);
  w.data.license = 'My-own-license'; w.put('LICENSE.txt', 'Personal use only.'); w.save(); assert.equal(w.load().manifest.license, 'My-own-license');
});
test('imports refuse old Codex, unsafe manifests and unexpected files', t => {
  const w = world(t); pet(w); const p = JSON.parse(fs.readFileSync(join(w.folder, 'pet.json')));
  for (const bad of [{ ...p, spriteVersionNumber: 1 }, { ...p, spritesheetPath: '../sheet.png' }, { ...p, displayName: '<cat>' }]) {
    w.put('pet.json', bad); assert.throws(() => api.prepareCharacterImport(w.folder));
  }
  w.put('pet.json', p); w.put('other.txt', 'x'); assert.throws(() => api.prepareCharacterImport(w.folder));
});
test('staging remains invisible until rename; failure cleans staging and preserves existing installs', t => {
  const w = world(t), source = api.prepareCharacterImport(w.folder);
  const io = { ...fs, renameSync(from, to) {
    assert.equal(fs.existsSync(to), false); assert.equal(api.listCharacters({ root: w.root }).length, 0);
    assert.equal(api.loadCharacter(from, { expectedId: 'test-cat' }).resolved.length, 19); throw Error('rename failed');
  } };
  assert.throws(() => api.installCharacter(source, { root: w.root, io }), /rename failed/); assert.deepEqual(fs.readdirSync(w.root), []);
});
test('installation refuses linked/shared storage roots and invalid id removal', t => {
  const w = world(t), source = api.prepareCharacterImport(w.folder); fs.symlinkSync(w.folder, w.root);
  assert.throws(() => api.installCharacter(source, { root: w.root })); fs.unlinkSync(w.root); fs.mkdirSync(w.root, { mode: 0o755 });
  assert.throws(() => api.installCharacter(source, { root: w.root })); assert.throws(() => api.removeCharacter('../test-cat', { root: w.root }));
});
test('total byte and pixel caps cover both sheets and preview', t => {
  const w = world(t); w.data.extra = 'extra.webp'; w.put('extra.webp', webp()); w.save();
  fs.truncateSync(join(w.folder, 'sheet.png'), 8 * 1024 ** 2); fs.truncateSync(join(w.folder, 'extra.webp'), 8 * 1024 ** 2);
  assert.throws(() => w.load(), /total|16 MiB/i);
  w.put('sheet.png', png(4096, 2080)); w.put('extra.webp', webp(4096, 2080)); w.data.frame.w = 512; w.data.grid.rows = 10; w.save();
  assert.throws(() => w.load(), /pixel/i);
});

test('CLI refuses non-TTY without --yes after printing details, accepts --yes, checks, lists and removes', async t => {
  const w = world(t); let output = ''; const opts = { root: w.root, out: text => output += text, input: { isTTY: false } };
  assert.equal(await cli.cursorCommand(['import', w.folder], opts), 1); assert.match(output, /1 of 19/); assert.match(output, /--yes/); assert.equal(fs.existsSync(w.root), false);
  assert.equal(await cli.cursorCommand(['import', w.folder, '--yes'], opts), 0); assert.match(output, /Turn it on with sleight-mcp cursor style sprite/);
  assert.equal(await cli.cursorCommand(['check', 'test-cat'], opts), 0); assert.equal(await cli.cursorCommand(['list'], opts), 0);
  assert.equal(await cli.cursorCommand(['style', 'sprite'], opts), 0); assert.match(output, /coming in 1.5.1/);
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
  const w = world(t); const result = spawnSync(process.execPath, ['plugins/sleight/lib/launch.mjs', 'cursor', 'list'], { encoding: 'utf8', env: { ...process.env, SLEIGHT_CHARACTERS_DIR: w.root } });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /No characters installed/); assert.equal(fs.existsSync(w.root), false);
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
for (const [name, value] of [['unknown path', '../anything'], ['unknown text cap', 'x'.repeat(201)], ['unknown markup', '<script>'], ['unknown nested path', { nested: 'a/b' }]]) test(`refuses ${name} even in ignored fields`, t => {
  const w = world(t); w.data.future = value; w.save(); assert.throws(() => w.load(), /text/);
});
test('PNG and WebP magic, truncated chunks and animation markers are refused', () => {
  for (const bytes of [Buffer.alloc(30), webp().subarray(0, 25), (() => { const b = webp(); b[20] |= 2; return b; })(), (() => { const b = webp(); b.write('ANIM', 12); return b; })()]) assert.throws(() => api.imageDimensions(bytes, '.webp'));
  assert.throws(() => api.imageDimensions(png(), '.svg'));
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
  assert.throws(() => api.removeCharacter('test-cat', { root: w.root })); assert.ok(fs.existsSync(join(w.folder, 'sheet.png')));
});
test('full set resolves 19 own animations and the callout has no missing lines', t => {
  const w = world(t); for (const { state } of api.CHARACTER_STATES) w.data.states[state] = { row: 0, frames: 1, ms: 100, loop: false };
  w.save(); const result = w.load(); assert.equal(result.resolved.filter(s => s.own).length, 19);
  assert.match(api.characterCallout(result), /19 of 19/); assert.doesNotMatch(api.characterCallout(result), /no animation of its own/);
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
    assert.equal(api.listCharacters({ root: w.root }).length, 0); fs.renameSync(from, to);
  } } });
  assert.equal(renames, 1); assert.equal(api.listCharacters({ root: w.root }).length, 1);
});
for (const [name, action] of [
  ['extra sheet cap', w => { w.data.extra = 'extra.webp'; w.put('extra.webp', webp()); fs.truncateSync(join(w.folder, 'extra.webp'), 8 * 1024 ** 2 + 1); w.save(); }],
  ['preview byte cap', w => { w.put('preview.png', png(256, 256)); fs.truncateSync(join(w.folder, 'preview.png'), 1024 ** 2 + 1); }],
  ['extra cell grid', w => { w.data.extra = 'extra.webp'; w.put('extra.webp', webp(1536, 209)); w.save(); }],
  ['too many entries', w => { for (let i = 0; i < 7; i++) w.put(`extra${i}.png`, png()); }],
  ['installed file modes', w => fs.chmodSync(join(w.folder, 'sheet.png'), 0o644)],
]) test(`refuses ${name}`, t => { const w = world(t); action(w); assert.throws(() => w.load({ installed: name === 'installed file modes' })); });

test('source changes during confirmation do not change the reviewed snapshot', async t => {
  const w = world(t), reviewed = fs.readFileSync(join(w.folder, 'sheet.png')); let output = '';
  assert.equal(await cli.cursorCommand(['import', w.folder], { root: w.root, input: { isTTY: true }, out: s => output += s,
    confirm: async () => { w.put('sheet.png', 'replaced after review'); return 'yes'; } }), 0);
  assert.deepEqual(fs.readFileSync(join(w.root, 'test-cat/sheet.png')), reviewed); assert.match(output, /1 of 19/);
});
test('special permission bits are refused on data files and installed directories', t => {
  const w = world(t); fs.chmodSync(join(w.folder, 'sheet.png'), 0o4600); assert.throws(() => w.load(), /mode|executable/);
  fs.chmodSync(join(w.folder, 'sheet.png'), 0o600); fs.chmodSync(w.folder, 0o1700); assert.throws(() => w.load({ installed: true }), /mode/);
});
