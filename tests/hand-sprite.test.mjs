import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, mkdirSync, chmodSync, symlinkSync, linkSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { macCommandSkip } from './requirements.mjs';

// Only synthetic pixels and --ring-plan-dump. This suite never creates NSApplication or a panel.
const root = realpathSync(mkdtempSync('/private/tmp/sleight-sprite-'));
after(() => rmSync(root, { recursive: true, force: true }));
const source = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
const nonce = 'a'.repeat(64), target = { nonce, seq: 1, pid: 2147483647, windowId: 4294967295 };
const act = (kind = 'click', more = {}) => ({ hand: 'act', ...target, kind, at: [100, 100], path: [[100, 100]], delayMs: 0, beats: 1, ...more });
const status = (state, more = {}) => ({ hand: 'status', ...target, state, ...more });
const crcTable = Array.from({ length: 256 }, (_, c) => { for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const b of body) crc = crcTable[(crc ^ b) & 255] ^ crc >>> 8;
  const size = Buffer.alloc(4), end = Buffer.alloc(4); size.writeUInt32BE(data.length); end.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, end]);
}
function png({ w = 512, h = 192, cw = 64, ch = 64, cells = [[0, 0]], count = 60, alpha = true, green = false } = {}) {
  const channels = alpha ? 4 : 3, bytes = Buffer.alloc((w * channels + 1) * h);
  for (const [row, col] of cells) for (let n = 0; n < count; n++) {
    const x = col * cw + n % cw, y = row * ch + Math.floor(n / cw);
    const i = y * (w * channels + 1) + 1 + x * channels;
    bytes[i] = green ? 0 : 180; bytes[i + 1] = green ? 255 : 90; bytes[i + 2] = 10;
    if (alpha) bytes[i + 3] = 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))]);
}
const entry = (row = 0, columns = [0], more = {}) => ({ sheet: 'sheet', row, frames: columns, ms: columns.map(() => 100), loop: false, flip: false, hotspot: [32, 32], size: [512, 192], scale: 1, ...more });
let counter = 0;
function character({ image = {}, table = { idle: entry() }, cell = [64, 64] } = {}) {
  const id = `fixture-${++counter}`, folder = join(root, id); mkdirSync(folder, { mode: 0o700 });
  const sheet = join(folder, 'sheet.png'); writeFileSync(sheet, png(image), { mode: 0o600 });
  return { hand: 'character', nonce, seq: 0, id, sheet, extra: null, cell, table };
}
let binary;
function build(t) {
  if (binary) return binary;
  const output = join(root, 'consent-host'), started = performance.now();
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'module-cache'), source, '-o', output], { encoding: 'utf8', timeout: 180000 });
  assert.equal(compile.status, 0, compile.stderr);
  binary = output; t.diagnostic(`compileMs=${Math.round(performance.now() - started)} binaryBytes=${statSync(binary).size}`);
  return binary;
}
function run(t, frames, flags = [], env = {}) {
  const result = spawnSync(build(t), ['--ring-plan-dump', '--cursor-style=sprite', ...flags], {
    input: frames.map(f => JSON.stringify(f) + '\n').join(''), encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 26,
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: root, ...env },
  });
  return { ...result, lines: result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse) };
}
function good(t, frames, flags, env) {
  const r = run(t, frames, flags, env); assert.equal(r.status, 0, r.stderr); return r;
}
const draws = r => r.lines.filter(l => l.effect === 'draw');
const options = { skip: macCommandSkip('xcrun') };

test('sprite decodes an installed PNG and falls back to idle art while the ring draws', options, t => {
  const r = good(t, [character(), act()]);
  assert.equal(r.stderr, ''); assert.equal(r.lines[0].loaded, true);
  const [p] = draws(r); assert.equal(p.state, 'click'); assert.equal(p.sprite.layers, 1);
  assert.equal(p.sprite.poses[0].state, 'click'); assert.equal(p.sprite.poses[0].row, 0);
  assert.deepEqual(p.sprite.poses[0].rect, [0, 0, .125, 1 / 3]);
  assert.deepEqual(p.sprite.times, [0, 1]);
  assert.deepEqual(p.sprite.values, [[0, 0, .125, 1 / 3], [0, 0, .125, 1 / 3]]);
  assert.ok(p.layers.some(l => l.name === 'spark'));
  assert.deepEqual(r.lines.at(-1), { effect: 'end', idle: true, pending: 0, timers: 0 });
});

test('timed cells, flip, repeats and extra sheet selection are discrete keyframes', options, t => {
  const frame = character({ image: { cells: [[0, 0], [1, 2], [1, 3]] }, table: {
    idle: entry(), click: entry(1, [2, 3, 2, 3], { ms: [40, 60, 40, 60], flip: true }),
  } });
  const p = draws(good(t, [frame, act()]))[0];
  assert.equal(p.sprite.calculationMode, 'discrete'); assert.equal(p.sprite.keyPath, 'contentsRect');
  assert.deepEqual(p.sprite.poses.map(p => p.column), [2, 3, 2, 3]);
  assert.deepEqual(p.sprite.poses.map(p => p.time), [0, .04, .1, .14]);
  assert.ok(p.sprite.poses.every(p => p.row === 1 && p.flip));
  assert.equal(p.sprite.times.at(-1), 1); assert.equal(p.sprite.values.length, 5);
  const extra = join(root, frame.id, 'extra.png'); writeFileSync(extra, png({ cells: [[2, 1]] }), { mode: 0o600 });
  frame.extra = extra; frame.table.click = entry(2, [1], { sheet: 'extra' });
  assert.equal(draws(good(t, [frame, act()]))[0].sprite.poses[0].sheet, 'extra');
});

test('eight glide headings choose the nearest of 16 direction cells', options, t => {
  const table = { idle: entry(), click: entry() }, cells = [[0, 0]];
  for (let d = 0; d < 16; d++) { const row = d < 8 ? 1 : 2, col = d % 8; table[`move@${d}`] = entry(row, [col]); cells.push([row, col]); }
  const f = character({ image: { cells }, table });
  for (let d = 0; d < 16; d += 2) {
    const a = d * Math.PI / 8, at = [500 + Math.sin(a) * 100, 500 - Math.cos(a) * 100];
    const [first, p] = draws(good(t, [f, act('click', { at: [500, 500], path: [[500, 500]] }), act('click', { seq: 2, at, path: [at] })]));
    // No movement has no direction and keeps the base entry.
    assert.ok(first.sprite.poses.every(p => p.direction === -1 && p.state === 'click' && p.row === 0));
    const move = p.sprite.poses.find(p => p.state === 'move');
    assert.equal(move.direction, d); assert.equal(move.row, d < 8 ? 1 : 2); assert.equal(move.column, d % 8);
  }
});

test('status mappings, drag phases, 4.8 second loops, parking and reduced motion', options, t => {
  const f = character({ image: { cells: [[0, 0], [1, 0], [1, 1]] }, table: {
    idle: entry(), thinking: entry(1, [0, 1], { loop: true }), 'waiting-approval': entry(1, [0, 1], { loop: true }),
  } });
  for (const [state, expected] of [['thinking', 'thinking'], ['waiting', 'waiting-approval'], ['error', 'error'], ['done', 'success'], ['handback', 'handoff']]) {
    const r = good(t, [f, act(), status(state, { seq: 2 })]); const p = draws(r)[1];
    assert.ok(p.sprite.poses.every(p => p.state === expected));
    if (['thinking', 'waiting'].includes(state)) {
      assert.equal(p.sprite.poses.length, 48); assert.ok(p.sprite.poses.at(-1).time < 4.8);
      assert.ok(r.lines.some(l => l.effect === 'park')); assert.ok(r.lines.some(l => l.effect === 'fade'));
    }
  }
  const p = draws(good(t, [f, act('drag', { path: [[200, 200]] })]))[0];
  for (const state of ['drag-grab', 'drag-carry', 'drag-drop']) assert.ok(p.sprite.poses.some(p => p.state === state));
  const reduced = draws(good(t, [f, act(), status('thinking', { seq: 2 })], ['--reduce-motion']))[1];
  assert.equal(reduced.sprite.poses.length, 1); assert.equal(reduced.sprite.poses[0].column, 0);
  const secure = draws(good(t, [f, act('type')], ['--secure-input']))[0];
  assert.equal(secure.sprite.poses[0].state, 'idle');
});

test('bad character loads leave the ring, with one bounded stderr line', options, async t => {
  const cases = {
    outside: f => { f.sheet = source; },
    symlink: f => { const p = join(root, f.id, 'link.png'); symlinkSync(f.sheet, p); f.sheet = p; },
    directorySymlink: f => { const p = join(root, `${f.id}-link`); symlinkSync(join(root, f.id), p); f.sheet = join(p, 'sheet.png'); f.id += '-link'; },
    hardlink: f => linkSync(f.sheet, join(root, f.id, 'hard.png')),
    directoryMode: f => chmodSync(join(root, f.id), 0o777),
    unnormalized: f => { f.sheet = join(root, f.id) + '/../' + f.id + '/sheet.png'; },
    mode: f => chmodSync(f.sheet, 0o644),
    size: f => writeFileSync(f.sheet, png({ h: 128 })),
    alpha: f => writeFileSync(f.sheet, png({ alpha: false })),
    uti: f => writeFileSync(f.sheet, 'not an image'),
    decode: f => {
      const header = png().subarray(8, 33); writeFileSync(f.sheet, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), header, chunk('IDAT', Buffer.from('broken deflate')), chunk('IEND', Buffer.alloc(0))]));
    },
    extension: f => { const p = join(root, f.id, 'sheet.webp'); writeFileSync(p, png(), { mode: 0o600 }); f.sheet = p; },
    sparse: f => writeFileSync(f.sheet, png({ count: 49 })),
    opaque: f => writeFileSync(f.sheet, png({ count: 4000 })),
    cap: f => writeFileSync(f.sheet, png({ w: 1544 })),
    fileCap: f => writeFileSync(f.sheet, Buffer.alloc(8 * 1024 * 1024 + 1)),
    missing: f => { f.sheet = join(root, f.id, 'missing.png'); },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
    const f = character(); mutate(f); const r = good(t, [f, act()]);
    assert.equal(r.lines[0].loaded, false); assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
    const [p] = draws(r); assert.equal(p.sprite, null); assert.ok(p.layers.length > 0);
  });
});

test('sprite stays lower right and reverses its offset at edges without mirroring the art', options, t => {
  const f = character();
  for (const [at, origin] of [[[100, 100], [118, 118]], [[970, 100], [888, 118]], [[100, 970], [118, 888]], [[970, 970], [888, 888]]]) {
    const p = draws(good(t, [f, act('click', { at, path: [at] })]))[0];
    assert.deepEqual(p.at, at); assert.deepEqual(p.sprite.placements[0], [...origin, 64, 64]);
    assert.equal(p.sprite.poses[0].flip, false);
    assert.ok(p.frame[0] <= origin[0] && p.frame[1] <= origin[1]);
    assert.ok(p.frame[0] + p.frame[2] >= origin[0] + 64 && p.frame[1] + p.frame[3] >= origin[1] + 64);
  }
});

test('sprite code has no input posting, windows, timers, display links or per-frame callbacks', () => {
  const swift = readFileSync(source, 'utf8').split('// BEGIN SPRITE\n')[1].split('// END SPRITE')[0];
  assert.doesNotMatch(swift, /CGEvent|CGWarp|NSCursor|activate\(|makeKey|orderFront|NSPanel|Timer\.|asyncAfter|CVDisplayLink|standardOutput/);
  assert.match(swift, /CGImageSourceCreateWithURL/); assert.match(swift, /kCGImageSourceShouldCache: false/);
  assert.equal(swift.match(/CGImageSourceCreateImageAtIndex/g).length, 1);
  assert.match(swift, /\.discrete/);
});

test('chroma fringe and ink in unused cells warn and render; test-root override needs its guard', options, t => {
  const f = character({ image: { green: true } }); const r = good(t, [f, act()]);
  assert.equal(r.lines[0].loaded, true); assert.match(r.stderr, /chroma/); assert.ok(draws(r)[0].sprite);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  const unused = character({ image: { cells: [[0, 0], [0, 1], [0, 6]] } }), u = good(t, [unused, act()]);
  assert.equal(u.lines[0].loaded, true); assert.match(u.stderr, /^sleight sprite: ink in an unused cell \(warning\)\n$/);
  // Row 0, column 6 alone is Codex's neutral pose and stays quiet.
  assert.equal(good(t, [character({ image: { cells: [[0, 0], [0, 6]] } }), act()]).stderr, '');
  assert.equal(good(t, [f, act()], [], { SLEIGHT_CURSOR_TEST: '0' }).lines[0].loaded, false);
});

test('exact keys, value types, nonce and shared seq reject malformed frames with exit 65', options, t => {
  const f = character();
  for (const bad of [{ ...f, unknown: 1 }, { ...f, cell: [true, 64] }, { ...f, seq: true }, { ...f, id: '../x' },
    { ...f, table: { idle: { ...entry(), unknown: 1 } } }, { ...f, table: { idle: entry(0, [8]) } },
    { ...f, table: { idle: entry(0, [0], { loop: 1 }) } }, { ...f, table: { idle: entry(0, [0], { ms: [NaN] }) } },
    { ...f, table: { idle: entry(0, [0], { flip: 'v' }) } }, { ...f, table: {} }]) assert.equal(run(t, [bad]).status, 65);
  assert.equal(run(t, [f, act('click', { nonce: 'b'.repeat(64) })]).status, 65);
  assert.equal(run(t, [f, act('click', { seq: 0 })]).status, 65);
  // Only a character frame may pass 8 KiB, and never 32 KiB. Padding is JSON whitespace, so the frame stays valid.
  const sized = n => JSON.stringify(f).replace('"table"', ' '.repeat(n - JSON.stringify(f).length) + '"table"');
  const raw = lines => spawnSync(build(t), ['--ring-plan-dump', '--cursor-style=sprite'], { input: lines.join('\n') + '\n', encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: root } });
  assert.equal(raw([sized(32768), JSON.stringify(act())]).status, 0);
  assert.equal(raw([sized(32769)]).status, 65);
  assert.equal(raw([JSON.stringify(act()).replace('"click"', '"click"' + ' '.repeat(9000))]).status, 65);
});

test('a second character replaces the first; non-sprite styles never decode', options, t => {
  const f = character(), second = character(); second.seq = 1; second.sheet = source;
  const r = good(t, [f, act(), { ...second, seq: 2 }, act('click', { seq: 3 })]);
  assert.deepEqual(r.lines.filter(l => l.effect === 'character').map(l => l.loaded), [true, false]);
  assert.ok(draws(r)[0].sprite); assert.equal(draws(r)[1].sprite, null);
  const result = spawnSync(build(t), ['--ring-plan-dump', '--cursor-style=ring'], { input: JSON.stringify(f) + '\n' + JSON.stringify(act()) + '\n', encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stderr, ''); assert.equal(JSON.parse(result.stdout.split('\n')[0]).loaded, false);
});

test('full-size real decode reports memory and leaves no scheduled work', options, t => {
  const f = character({ image: { w: 1536, h: 2288, cw: 192, ch: 208 }, cell: [192, 208], table: { idle: entry(0, [0], { hotspot: [96, 104], size: [1536, 2288] }) } });
  const result = spawnSync('/usr/bin/time', ['-l', build(t), '--ring-plan-dump', '--cursor-style=sprite'], {
    input: JSON.stringify(f) + '\n' + JSON.stringify(act()) + '\n', encoding: 'utf8', timeout: 20000,
    env: { PATH: '/usr/bin:/bin', SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: root },
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout.split('\n')[0]).loaded, true);
  const rss = result.stderr.match(/(\d+)\s+maximum resident set size/); assert.ok(rss, result.stderr);
  t.diagnostic(`fullSheet=1536x2288 rgbaBytes=${1536 * 2288 * 4} maximumRssBytes=${rss[1]}`);
});

// VC3's character.mjs (reviewed at codex/vc3 9751c49f) until integration brings it into this tree. Both modules load from a
// private fixture folder so character-frame.mjs resolves its './character.mjs' import there.
let modules;
async function vc3() {
  if (modules) return modules;
  const local = new URL('../plugins/sleight/lib/hand/character.mjs', import.meta.url);
  let code;
  if (existsSync(local)) code = readFileSync(local);
  else {
    const r = spawnSync('/usr/bin/git', ['show', '9751c49f:plugins/sleight/lib/hand/character.mjs'], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
    assert.equal(r.status, 0, r.stderr); code = r.stdout;
  }
  const fixture = join(root, 'modules'); mkdirSync(fixture);
  writeFileSync(join(fixture, 'character.mjs'), code);
  writeFileSync(join(fixture, 'character-frame.mjs'), readFileSync(new URL('../plugins/sleight/lib/hand/character-frame.mjs', import.meta.url)));
  modules = { ...await import(pathToFileURL(join(fixture, 'character.mjs'))), ...await import(pathToFileURL(join(fixture, 'character-frame.mjs'))) };
  return modules;
}

test('character-frame preserves VC3 installed resolver output without adding its source to VC4', async t => {
  const { loadCharacter, characterFrame } = await vc3();
  const f = character({ image: { cells: [[0, 0], [1, 1], [1, 2], ...Array.from({ length: 8 }, (_, i) => [2, i])] } });
  const manifest = { format: 'sleight-character', version: 1, id: f.id, name: 'Fixture', description: '', author: 'Test', license: 'CC0-1.0',
    sheet: 'sheet.png', frame: { w: 64, h: 64 }, grid: { cols: 8, rows: 3 }, scale: .75, anchor: { x: 32, y: 60 }, hotspot: { x: 32, y: 32 },
    states: { idle: { row: 0, frames: 1, ms: 100, loop: true }, click: { row: 1, start: 1, frames: 2, ms: [80, 120], loop: false, flip: 'h' },
      move: { dir16: { rowA: 1, rowB: 2 } } } };
  // All cells referenced by the directional state must have ink.
  writeFileSync(f.sheet, png({ cells: [[0, 0], ...Array.from({ length: 8 }, (_, i) => [1, i]), ...Array.from({ length: 8 }, (_, i) => [2, i])] }));
  writeFileSync(join(root, f.id, 'character.json'), JSON.stringify(manifest), { mode: 0o600 });
  const resolved = loadCharacter(join(root, f.id), { installed: true });
  const wire = characterFrame(resolved, { nonce, seq: 0 });
  assert.equal(Object.keys(wire.table).filter(k => !k.includes('@')).length, 19);
  assert.deepEqual(wire.table.click.frames, [1, 2]); assert.equal(wire.table.click.flip, true);
  assert.deepEqual(wire.table['double-click'].frames, [1, 2, 1, 2]);
  assert.equal(wire.table['move@0'].row, 1); assert.equal(wire.table['move@8'].row, 2);
  assert.deepEqual(wire.table.click.size, [512, 192]); assert.equal(wire.table.click.scale, .75);
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) <= 32768);
  const r = good(t, [wire, act()]); assert.equal(r.lines[0].loaded, true, r.stderr);
  assert.throws(() => characterFrame(resolved, { nonce: 'wrong', seq: 0 }));
  t.diagnostic(`wireBytes=${Buffer.byteLength(JSON.stringify(wire))} entries=${Object.keys(wire.table).length}`);
});

test('a Codex v2 pet imports as it is and renders through character-frame', options, async t => {
  const { prepareCharacterImport, installCharacter, loadCharacter, characterFrame } = await vc3();
  // Codex v2 used frames per row (R3 section 0): ink only there, plus the optional neutral pose at row 0, column 6.
  const used = [7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8], cells = used.flatMap((n, row) => Array.from({ length: n }, (_, col) => [row, col]));
  const pet = mkdtempSync(join(root, 'pet-')), id = `codex-${++counter}`;
  writeFileSync(join(pet, 'pet.json'), JSON.stringify({ id, displayName: 'Fixture pet', spriteVersionNumber: 2, spritesheetPath: 'spritesheet.png' }), { mode: 0o600 });
  writeFileSync(join(pet, 'spritesheet.png'), png({ w: 1536, h: 2288, cw: 192, ch: 208, cells }), { mode: 0o600 });
  const folder = installCharacter(prepareCharacterImport(pet), { root });
  const wire = characterFrame(loadCharacter(folder, { installed: true }), { nonce, seq: 0 });
  const r = good(t, [wire, act('click', { at: [300, 300], path: [[300, 300]] }), act('click', { seq: 2, at: [600, 300], path: [[600, 300]] }),
    status('waiting', { seq: 3 })]);
  assert.equal(r.lines[0].loaded, true); assert.equal(r.stderr, '');
  const [first, second, waiting] = draws(r);
  assert.deepEqual(first.sprite.poses.map(p => [p.row, p.column]), [[4, 1], [4, 2], [4, 3]]);
  const move = second.sprite.poses.find(p => p.state === 'move');
  assert.deepEqual([move.direction, move.row, move.column], [4, 9, 4]);
  assert.ok(waiting.sprite.poses.every(p => p.row === 6)); assert.ok(waiting.sprite.poses.at(-1).time < 4.8);
  assert.equal(first.sprite.placements[0][2], 192); assert.equal(first.sprite.placements[0][3], 208);
  t.diagnostic(`codexWireBytes=${Buffer.byteLength(JSON.stringify(wire))} entries=${Object.keys(wire.table).length}`);
});
