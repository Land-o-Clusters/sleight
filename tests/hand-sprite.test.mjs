import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, mkdirSync, chmodSync, symlinkSync, linkSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { characterFrame, SPRITE_LIMITS } from '../plugins/sleight/lib/hand/character-frame.mjs';

// The sprite style through --ring-plan-dump, --decode-sheet and --check-character: synthetic sheets, real decoding, no
// NSApplication, panel or window. The host's test bank override needs a path below /private/tmp/, so the bank is made
// there, on first use, and only on a Mac with the developer tools.
const mac = process.platform === 'darwin' && spawnSync('/usr/bin/xcode-select', ['-p']).status === 0;
const options = { skip: mac ? false : 'needs macOS with the developer tools (xcode-select -p)' };
const source = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
const nonce = 'a'.repeat(64), target = { nonce, seq: 1, pid: 2147483647, windowId: 4294967295 };
const act = (kind = 'click', more = {}) => ({ hand: 'act', ...target, kind, at: [100, 100], path: [[100, 100]], delayMs: 0, beats: 1, ...more });
const status = (state, more = {}) => ({ hand: 'status', ...target, state, ...more });
let bank;
const root = () => bank ??= trackTemp(realpathSync(mkdtempSync('/private/tmp/sleight-sprite-')));

const crcTable = Array.from({ length: 256 }, (_, c) => { for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const b of body) crc = crcTable[(crc ^ b) & 255] ^ crc >>> 8;
  const size = Buffer.alloc(4), end = Buffer.alloc(4); size.writeUInt32BE(data.length); end.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, end]);
}
// Ink: `count` pixels at the top left of each listed [row, col] cell.
function ink({ w, cw, ch, cells, count }) {
  const on = new Uint8Array(w * Math.max(...cells.map(([r]) => r + 1), 1) * ch);
  for (const [row, col] of cells) for (let n = 0; n < count; n++) on[(row * ch + Math.floor(n / cw)) * w + col * cw + n % cw] = 1;
  return on;
}
function png({ w = 512, h = 192, cw = 64, ch = 64, cells = [[0, 0]], count = 60, alpha = true, green = false, frames = 1 } = {}) {
  const channels = alpha ? 4 : 3, bytes = Buffer.alloc((w * channels + 1) * h), on = ink({ w, cw, ch, cells, count });
  for (let i = 0; i < on.length && i < w * h; i++) if (on[i]) {
    const at = Math.floor(i / w) * (w * channels + 1) + 1 + i % w * channels;
    bytes[at] = green ? 0 : 180; bytes[at + 1] = green ? 255 : 90; bytes[at + 2] = 10; if (alpha) bytes[at + 3] = 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = alpha ? 6 : 2;
  const data = deflateSync(bytes), parts = [Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header)];
  if (frames > 1) {
    // APNG: an acTL, then a frame control before the IDAT and one more frame in fdAT.
    const control = seq => { const c = Buffer.alloc(26); c.writeUInt32BE(seq); c.writeUInt32BE(w, 4); c.writeUInt32BE(h, 8); c.writeUInt16BE(1, 20); c.writeUInt16BE(10, 22); return chunk('fcTL', c); };
    const actl = Buffer.alloc(8); actl.writeUInt32BE(2);
    const seq = Buffer.alloc(4); seq.writeUInt32BE(2);
    parts.push(chunk('acTL', actl), control(0), chunk('IDAT', data), control(1), chunk('fdAT', Buffer.concat([seq, data])));
  } else parts.push(chunk('IDAT', data));
  return Buffer.concat([...parts, chunk('IEND', Buffer.alloc(0))]);
}
// A lossless WebP (VP8L) written bit by bit: no transforms, and two-symbol prefix codes for green, red, blue and alpha, so
// each pixel is 4 bits: transparent black or opaque (180, 90, 10).
function webp({ w = 512, h = 192, cw = 64, ch = 64, cells = [[0, 0]], count = 60 } = {}) {
  const bits = [], put = (value, n) => { for (let i = 0; i < n; i++) bits.push(value >>> i & 1); };
  put(0x2f, 8); put(w - 1, 14); put(h - 1, 14); put(1, 1); put(0, 3);
  put(0, 1); put(0, 1); put(0, 1);
  for (const symbol of [90, 180, 10, 255]) { put(1, 1); put(1, 1); put(1, 1); put(0, 8); put(symbol, 8); }
  put(1, 1); put(0, 1); put(0, 1); put(0, 1);
  const on = ink({ w, cw, ch, cells, count });
  for (let i = 0; i < w * h; i++) { const v = on[i] ?? 0; put(v, 1); put(v, 1); put(v, 1); put(v, 1); }
  const body = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { body[i >> 3] |= b << (i & 7); });
  const padded = body.length % 2 ? Buffer.concat([body, Buffer.alloc(1)]) : body;
  const head = Buffer.alloc(8); head.write('VP8L'); head.writeUInt32LE(body.length, 4);
  const riff = Buffer.alloc(12); riff.write('RIFF'); riff.writeUInt32LE(4 + 8 + padded.length, 4); riff.write('WEBP', 8);
  return Buffer.concat([riff, head, padded]);
}
const entry = (row = 0, columns = [0], more = {}) => ({ sheet: 'sheet', row, frames: columns, ms: columns.map(() => 100), loop: false, flip: false, hotspot: [32, 32], size: [512, 192], scale: 1, ...more });
// The host insets each cell by half a texel.
const cellRect = (row, col, { w = 512, h = 192, cw = 64, ch = 64 } = {}) => [(col * cw + .5) / w, (row * ch + .5) / h, (cw - 1) / w, (ch - 1) / h];
let counter = 0;
function character({ image = {}, table = { idle: entry() }, cell = [64, 64], file = 'sheet.png', bytes } = {}) {
  const id = `fixture-${++counter}`, folder = join(root(), id); mkdirSync(folder, { mode: 0o700 });
  const sheet = join(folder, file); writeFileSync(sheet, bytes ?? png(image), { mode: 0o600 });
  return { hand: 'character', nonce, seq: 0, id, sheet, extra: null, cell, table };
}
let binary;
function build(t) {
  if (binary) return binary;
  const output = join(root(), 'consent-host'), started = performance.now();
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), source, '-o', output], { encoding: 'utf8', timeout: 300000 });
  assert.equal(compile.status, 0, compile.stderr);
  binary = output; t.diagnostic(`compileMs=${Math.round(performance.now() - started)} binaryBytes=${statSync(binary).size}`);
  return binary;
}
const testEnv = more => ({ PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: root(), ...more });
function run(t, frames, flags = [], env = {}) {
  const result = spawnSync(build(t), ['--ring-plan-dump', '--cursor-style=sprite', ...flags], {
    input: frames.map(f => JSON.stringify(f) + '\n').join(''), encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 26, env: testEnv(env),
  });
  return { ...result, lines: result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse) };
}
function good(t, frames, flags, env) {
  const r = run(t, frames, flags, env); assert.equal(r.status, 0, r.stderr); return r;
}
// Every sprite track Core Animation gets: key times from 0 to 1, never decreasing, one per value.
function checkTracks(p) {
  if (!p.sprite) return;
  for (const track of p.sprite.tracks) {
    const times = track.keyTimes;
    assert.equal(times[0], 0, `${p.state} ${track.keyPath} starts at 0`); assert.equal(times.at(-1), 1, `${p.state} ${track.keyPath} ends at 1`);
    assert.ok(times.every((v, i) => i === 0 || v >= times[i - 1]), `${p.state} ${track.keyPath} never decreases`);
    assert.equal(track.values, times.length);
  }
}
const draws = r => { const out = r.lines.filter(l => l.effect === 'draw'); out.forEach(checkTracks); return out; };
const loaded = r => r.lines.find(l => l.effect === 'character');

test('sprite decodes an installed PNG and falls back to idle art while the ring draws', options, t => {
  const r = good(t, [character(), act()]);
  assert.equal(r.stderr, ''); const { selfMaxRss, ...result } = loaded(r); assert.ok(selfMaxRss > 1 << 20);
  assert.deepEqual(result, { effect: 'character', loaded: true, reason: null, warnings: [], time: 0 });
  const [p] = draws(r); assert.equal(p.state, 'click'); assert.equal(p.sprite.layers, 1);
  assert.equal(p.sprite.poses[0].state, 'click'); assert.equal(p.sprite.poses[0].row, 0);
  assert.deepEqual(p.sprite.poses[0].rect, cellRect(0, 0));
  assert.deepEqual(p.sprite.times, [0, 1]);
  assert.deepEqual(p.sprite.values, [cellRect(0, 0), cellRect(0, 0)]);
  assert.deepEqual(p.sprite.tracks.map(k => k.keyPath), ['contents', 'contentsRect', 'transform', 'position']);
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
  const extra = join(root(), frame.id, 'extra.png'); writeFileSync(extra, png({ cells: [[2, 1]] }), { mode: 0o600 });
  frame.extra = extra; frame.table.click = entry(2, [1], { sheet: 'extra' });
  assert.equal(draws(good(t, [frame, act()]))[0].sprite.poses[0].sheet, 'extra');
  // An extra sheet no entry uses isn't read, so a bad one there is harmless; a bad one in use refuses the character.
  writeFileSync(extra, 'not an image'); delete frame.table.click;
  assert.equal(loaded(good(t, [frame, act()])).loaded, true);
  frame.table.click = entry(2, [1], { sheet: 'extra' });
  assert.deepEqual([loaded(good(t, [frame, act()])).loaded, loaded(good(t, [frame, act()])).reason], [false, 'type']);
});

test('eight glide headings choose the nearest of 16 direction cells, and long horizontal glides the far rows', options, t => {
  const table = { idle: entry(), click: entry() }, cells = [[0, 0], [0, 1]];
  for (let d = 0; d < 16; d++) { const row = d < 8 ? 1 : 2, col = d % 8; table[`move@${d}`] = entry(row, [col]); cells.push([row, col]); }
  table['move-far@4'] = entry(0, [1], { loop: true });
  const f = character({ image: { cells }, table });
  for (let d = 0; d < 16; d += 2) {
    const a = d * Math.PI / 8, at = [500 + Math.sin(a) * 50, 500 - Math.cos(a) * 50];
    const [first, p] = draws(good(t, [f, act('click', { at: [500, 500], path: [[500, 500]] }), act('click', { seq: 2, at, path: [at] })]));
    // No movement has no direction and keeps the base entry.
    assert.ok(first.sprite.poses.every(p => p.direction === -1 && p.state === 'click' && p.row === 0));
    const move = p.sprite.poses.find(p => p.state === 'move');
    assert.equal(move.direction, d); assert.equal(move.row, d < 8 ? 1 : 2); assert.equal(move.column, d % 8);
  }
  const far = draws(good(t, [f, act('click', { at: [300, 500], path: [[300, 500]] }), act('click', { seq: 2, at: [500, 500], path: [[500, 500]] })]))[1];
  assert.deepEqual(far.sprite.poses.filter(p => p.state === 'move').map(p => [p.direction, p.row, p.column])[0], [4, 0, 1]);
});

test('status mappings, drag phases, loops parking on their first cell, handoff then idle, reduced motion', options, t => {
  const f = character({ image: { cells: [[0, 0], [1, 0], [1, 1], [1, 2]] }, table: {
    idle: entry(), thinking: entry(1, [0, 1], { loop: true }), 'waiting-approval': entry(1, [0, 1], { loop: true }),
    handoff: entry(1, [2], { then: 'idle' }), 'drag-grab': entry(1, [0]), 'drag-carry': entry(1, [1]), 'drag-drop': entry(1, [2]),
  } });
  for (const [state, expected] of [['thinking', 'thinking'], ['waiting', 'waiting-approval'], ['error', 'error'], ['done', 'success']]) {
    const r = good(t, [f, act(), status(state, { seq: 2 })]); const p = draws(r)[1];
    assert.ok(p.sprite.poses.every(p => p.state === expected));
    if (['thinking', 'waiting'].includes(state)) {
      // 48 cells of 100 ms, then the first cell at 4.8 s.
      assert.equal(p.sprite.poses.length, 49); assert.deepEqual([p.sprite.poses.at(-1).time, p.sprite.poses.at(-1).column], [4.8, 0]);
      assert.equal(p.sprite.poses.at(-2).column, 1);
      assert.ok(r.lines.some(l => l.effect === 'park')); assert.ok(r.lines.some(l => l.effect === 'fade'));
    }
  }
  const handoff = draws(good(t, [f, act(), status('handback', { seq: 2 })]))[1];
  assert.deepEqual(handoff.sprite.poses.map(p => [p.state, p.row, p.column]).slice(0, 2), [['handoff', 1, 2], ['idle', 0, 0]]);
  for (const path of [[[200, 200]], [[100, 100], [160, 100], [220, 100], [300, 100]]]) {
    const p = draws(good(t, [f, act('drag', { at: [300, 100], path })]))[0];
    for (const state of ['drag-grab', 'drag-carry', 'drag-drop']) assert.ok(p.sprite.poses.some(p => p.state === state));
    assert.equal(p.sprite.poses[0].time, 0);
  }
  const reduced = draws(good(t, [f, act(), status('thinking', { seq: 2 })], ['--reduce-motion']))[1];
  assert.equal(reduced.sprite.poses.length, 1); assert.equal(reduced.sprite.poses[0].column, 0);
  const secure = draws(good(t, [f, act('type')], ['--secure-input']))[0];
  assert.equal(secure.sprite.poses[0].state, 'idle');
});

test('a flip change jumps the layer instead of sliding it across the cell', options, t => {
  const f = character({ image: { cells: [[0, 0], [1, 0]] }, table: { idle: entry(), move: entry(1, [0]), click: entry(0, [0], { flip: true }) } });
  const p = draws(good(t, [f, act('click', { at: [300, 300], path: [[300, 300]] }), act('click', { seq: 2, at: [500, 300], path: [[500, 300]] })]))[1];
  const flipAt = p.sprite.poses.find(x => x.flip).time, position = p.sprite.tracks[3], unit = p.sprite.duration;
  const i = position.keyTimes.findIndex(k => Math.abs(k - flipAt / unit) < 1e-9);
  assert.ok(i > 0); assert.ok(Math.abs(position.keyTimes[i - 1] - (flipAt - 1e-4) / unit) < 1e-9);
  // Just before the flip the layer sits at the box's left edge, just after it at the right edge (mirrored around x 0).
  assert.ok(Math.abs(p.sprite.positions[i][0] - p.sprite.positions[i - 1][0] - 64) < 2);
});

test('bad character loads leave the ring, with one bounded stderr line and the reason', options, async t => {
  const cases = {
    outside: [f => { f.sheet = source; }, 'path'],
    symlink: [f => { const p = join(root(), f.id, 'link.png'); symlinkSync(f.sheet, p); f.sheet = p; }, 'path'],
    directorySymlink: [f => { const p = join(root(), `${f.id}-link`); symlinkSync(join(root(), f.id), p); f.sheet = join(p, 'sheet.png'); f.id += '-link'; }, 'path'],
    hardlink: [f => linkSync(f.sheet, join(root(), f.id, 'hard.png')), 'permissions'],
    directoryMode: [f => chmodSync(join(root(), f.id), 0o777), 'permissions'],
    unnormalized: [f => { f.sheet = join(root(), f.id) + '/../' + f.id + '/sheet.png'; }, 'path'],
    mode: [f => chmodSync(f.sheet, 0o644), 'permissions'],
    size: [f => writeFileSync(f.sheet, png({ h: 128 })), 'size'],
    alpha: [f => writeFileSync(f.sheet, png({ alpha: false })), 'alpha'],
    uti: [f => writeFileSync(f.sheet, 'not an image'), 'type'],
    // ImageIO decodes a broken IDAT as a transparent image, so the ink check refuses it.
    decode: [f => {
      const header = png().subarray(8, 33); writeFileSync(f.sheet, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), header, chunk('IDAT', Buffer.from('broken deflate')), chunk('IEND', Buffer.alloc(0))]));
    }, 'pixels'],
    extension: [f => { const p = join(root(), f.id, 'sheet.webp'); writeFileSync(p, png(), { mode: 0o600 }); f.sheet = p; }, 'type'],
    animated: [f => writeFileSync(f.sheet, png({ frames: 2 })), 'type'],
    sparse: [f => writeFileSync(f.sheet, png({ count: 49 })), 'pixels'],
    opaque: [f => writeFileSync(f.sheet, png({ count: 4000 })), 'pixels'],
    cap: [f => writeFileSync(f.sheet, png({ w: 1544 })), 'size'],
    fileCap: [f => writeFileSync(f.sheet, Buffer.alloc(8 * 1024 * 1024 + 1)), 'size'],
    missing: [f => { f.sheet = join(root(), f.id, 'missing.png'); }, 'path'],
  };
  for (const [name, [mutate, reason]] of Object.entries(cases)) await t.test(name, () => {
    const f = character(); mutate(f); const r = good(t, [f, act()]);
    assert.deepEqual([loaded(r).loaded, loaded(r).reason], [false, reason]);
    assert.equal(r.stderr, `sleight sprite: character refused (${reason}); using ring\n`);
    const [p] = draws(r); assert.equal(p.sprite, null); assert.ok(p.layers.length > 0);
  });
});

test('a real lossless WebP loads, and the decode child refuses bad files on its own', options, t => {
  const f = character({ file: 'sheet.webp', bytes: webp() }), r = good(t, [f, act()]);
  assert.equal(r.stderr, ''); assert.equal(loaded(r).loaded, true); assert.deepEqual(draws(r)[0].sprite.poses[0].rect, cellRect(0, 0));
  const child = (bytes, args = ['512', '192', 'webp']) => spawnSync(build(t), ['--decode-sheet', ...args], { input: bytes, env: testEnv() });
  const ok = child(webp());
  assert.equal(ok.status, 0); assert.equal(ok.stdout.length, 512 * 192 * 4);
  assert.deepEqual([...ok.stdout.subarray(0, 4)], [180, 90, 10, 255]);
  for (const [bytes, args, code] of [[Buffer.from('not an image'), undefined, 65], [png(), undefined, 65], [webp(), ['512', '128', 'webp'], 66],
    [png({ alpha: false }), ['512', '192', 'png'], 67], [webp(), ['0', '192', 'webp'], 64], [webp(), ['512', '192', 'gif'], 64]]) {
    const r = child(bytes, args); assert.equal(r.status, code); assert.equal(r.stdout.length, 0);
  }
});

test('a child killed mid-write or hung gives the ring alone', options, t => {
  for (const [fault, reason, minMs, maxMs] of [['die', 'child', 0, 1500], ['hang', 'timeout', 1900, 6000], ['closehang', 'child', 400, 2500],
    ['closehang0', 'child', 0, 2500]]) {
    build(t);
    const started = performance.now(), r = good(t, [character(), act()], [], { SLEIGHT_CURSOR_DECODE_FAULT: fault });
    const ms = performance.now() - started;
    assert.deepEqual([fault, loaded(r).loaded, loaded(r).reason], [fault, false, reason]); assert.equal(draws(r)[0].sprite, null);
    assert.ok(ms >= minMs && ms < maxMs, `${fault}: ${ms} ms`);
  }
  // A sandbox (or limit) refusal is its own reason, apart from a crash.
  assert.equal(loaded(good(t, [character(), act()], [], { SLEIGHT_CURSOR_DECODE_FAULT: 'nosandbox' })).reason, 'sandbox');
  const limits = spawnSync(build(t), ['--decode-sheet', '512', '192', 'png'], { input: '', encoding: 'utf8', env: testEnv({ SLEIGHT_CURSOR_DECODE_FAULT: 'limits' }) });
  assert.equal(limits.stdout, 'cpu=2/2 nofile=8/8\n');
  // No decode child outlives its parent.
  const stray = spawnSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' }).stdout.split('\n').filter(l => l.startsWith(build(t) + ' --decode-sheet'));
  assert.deepEqual(stray, []);
  // The fault switch needs the test switch too.
  assert.equal(loaded(good(t, [character(), act()], [], { SLEIGHT_CURSOR_TEST: '0', SLEIGHT_CURSOR_DECODE_FAULT: 'die' })).reason, 'path');
});

test('--check-character runs the same checks and reports the reason', options, t => {
  const check = frame => spawnSync(build(t), ['--check-character'], { input: JSON.stringify(frame) + '\n', encoding: 'utf8', env: testEnv() });
  const f = character(), ok = check(f);
  assert.equal(ok.status, 0); assert.deepEqual(JSON.parse(ok.stdout), { id: f.id, loaded: true, reason: null, warnings: [] });
  writeFileSync(f.sheet, png({ count: 10 }));
  assert.deepEqual(JSON.parse(check(f).stdout), { id: f.id, loaded: false, reason: 'pixels', warnings: [] });
  assert.equal(check({ ...f, unknown: 1 }).status, 65);
  assert.equal(spawnSync(build(t), ['--check-character', 'extra'], { input: '' }).status, 64);
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

test('the consent host never decodes character art: ImageIO runs only in the decode child', () => {
  const swift = readFileSync(source, 'utf8');
  const sprite = swift.split('// BEGIN SPRITE\n')[1].split('// END SPRITE\n')[0];
  const child = swift.split('// BEGIN SPRITE DECODE CHILD\n')[1].split('// END SPRITE DECODE CHILD')[0];
  assert.doesNotMatch(sprite, /CGEvent|CGWarp|NSCursor|activate\(|makeKey|orderFront|NSPanel|Timer\.|asyncAfter|CVDisplayLink|standardOutput/);
  assert.doesNotMatch(sprite, /CGImageSource|NSImage|CGImageDestination|kCGImageSourceShouldCache/);
  assert.match(sprite, /\.discrete/); assert.match(sprite, /POSIX_SPAWN_CLOEXEC_DEFAULT/);
  // Outside the child block, ImageIO's sources appear only for trusted art (the glove, icons), never beside sprite names.
  const outside = swift.replace(child, '');
  for (const line of outside.split('\n').filter(l => /CGImageSourceCreate/.test(l))) assert.doesNotMatch(line, /sprite|character|sheet/i, line);
  assert.match(child, /spriteSandboxInit\("\(version 1\)\(deny default\)"/); assert.match(child, /kCGImageSourceShouldCache: false/);
  // The sandbox comes before the first read of the untrusted bytes.
  assert.ok(child.indexOf('spriteSandboxInit("') < child.indexOf('read(0,'));
  assert.equal(swift.match(/spriteDecodeChild\(/g).length, 2, 'defined once, called once from the --decode-sheet switch');
  assert.match(swift, /if arguments\.first == "--decode-sheet" \{ spriteDecodeChild\(/);
});

test('chroma fringe and ink in unused cells warn and render; test-root override needs its guard', options, t => {
  const f = character({ image: { green: true } }); const r = good(t, [f, act()]);
  assert.equal(loaded(r).loaded, true); assert.deepEqual(loaded(r).warnings, ['chroma fringe']); assert.ok(draws(r)[0].sprite);
  assert.equal(r.stderr, 'sleight sprite: chroma fringe (warning)\n');
  const unused = character({ image: { cells: [[0, 0], [0, 1], [0, 6]] } }), u = good(t, [unused, act()]);
  assert.equal(loaded(u).loaded, true); assert.equal(u.stderr, 'sleight sprite: ink in an unused cell (warning)\n');
  // Row 0, column 6 alone is Codex's neutral pose and stays quiet.
  assert.equal(good(t, [character({ image: { cells: [[0, 0], [0, 6]] } }), act()]).stderr, '');
  assert.equal(loaded(good(t, [f, act()], [], { SLEIGHT_CURSOR_TEST: '0' })).loaded, false);
});

test('exact keys, value types, caps, nonce and shared seq reject malformed frames with exit 65', options, t => {
  const f = character();
  for (const bad of [{ ...f, unknown: 1 }, { ...f, cell: [true, 64] }, { ...f, seq: true }, { ...f, id: '../x' }, { ...f, cell: [200, 64] }, { ...f, cell: [64, 212] },
    { ...f, table: { idle: { ...entry(), unknown: 1 } } }, { ...f, table: { idle: entry(0, [8]) } }, { ...f, table: { idle: entry(0, [0], { then: 'nap' }) } },
    { ...f, table: { idle: entry(), 'click-far@4': entry() } }, { ...f, table: { idle: entry(), 'move-far@16': entry() } },
    { ...f, table: { idle: entry(0, [0], { loop: 1 }) } }, { ...f, table: { idle: entry(0, [0], { ms: [NaN] }) } },
    { ...f, table: { idle: entry(0, [0], { flip: 'v' }) } }, { ...f, table: {} }]) assert.equal(run(t, [bad]).status, 65);
  assert.equal(run(t, [f, act('click', { nonce: 'b'.repeat(64) })]).status, 65);
  assert.equal(run(t, [f, act('click', { seq: 0 })]).status, 65);
  // Only a character frame may pass 8 KiB, and never 32 KiB. Padding is JSON whitespace, so the frame stays valid.
  const sized = n => JSON.stringify(f).replace('"table"', ' '.repeat(n - JSON.stringify(f).length) + '"table"');
  const raw = lines => spawnSync(build(t), ['--ring-plan-dump', '--cursor-style=sprite'], { input: lines.join('\n') + '\n', encoding: 'utf8', env: testEnv() });
  assert.equal(raw([sized(32768), JSON.stringify(act())]).status, 0);
  assert.equal(raw([sized(32769)]).status, 65);
  assert.equal(raw([JSON.stringify(act()).replace('"click"', '"click"' + ' '.repeat(9000))]).status, 65);
});

test('a second character replaces the first; non-sprite styles never decode', options, t => {
  const f = character(), second = character(); second.seq = 1; second.sheet = source;
  const r = good(t, [f, act(), { ...second, seq: 2 }, act('click', { seq: 3 })]);
  assert.deepEqual(r.lines.filter(l => l.effect === 'character').map(l => l.loaded), [true, false]);
  assert.ok(draws(r)[0].sprite); assert.equal(draws(r)[1].sprite, null);
  const result = spawnSync(build(t), ['--ring-plan-dump', '--cursor-style=ring'], { input: JSON.stringify(f) + '\n' + JSON.stringify(act()) + '\n', encoding: 'utf8', env: testEnv() });
  assert.equal(result.status, 0); assert.equal(result.stderr, ''); assert.equal(JSON.parse(result.stdout.split('\n')[0]).loaded, false);
});

test('full-size real decode reports memory in MiB and leaves no scheduled work', options, t => {
  const f = character({ image: { w: 1536, h: 2288, cw: 192, ch: 208 }, cell: [192, 208], table: { idle: entry(0, [0], { hotspot: [96, 104], size: [1536, 2288] }) } });
  const result = spawnSync('/usr/bin/time', ['-l', build(t), '--ring-plan-dump', '--cursor-style=sprite'], {
    input: JSON.stringify(f) + '\n' + JSON.stringify(act()) + '\n', encoding: 'utf8', timeout: 30000, env: testEnv(),
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout.split('\n')[0]).loaded, true);
  const rss = result.stderr.match(/(\d+)\s+maximum resident set size/); assert.ok(rss, result.stderr);
  // time -l's figure is the larger of the host and its decode child; selfMaxRss is the host alone.
  const self = JSON.parse(result.stdout.split('\n')[0]).selfMaxRss;
  t.diagnostic(`fullSheet=1536x2288 decodedMiB=${(1536 * 2288 * 4 / 1048576).toFixed(1)} hostOrChildMaxRssMiB=${(rss[1] / 1048576).toFixed(1)} hostMaxRssMiB=${(self / 1048576).toFixed(1)}`);
});

// The adapter on a hand-built VC3-shaped snapshot, with no VC3 code: what a resolver returns, the adapter sends.
function snapshot(t, { folder, scale = .75, cells }) {
  const at = (state, row, start, frames, more = {}) => ({ state, sheet: 'sheet.png', row, start, frames, ms: Array(frames).fill(100), loop: false, flip: false,
    hotspot: { x: 32, y: 32 }, repeat: 1, ...more });
  const base = () => ['idle', 'move', 'aim', 'click', 'double-click', 'right-click', 'type', 'key', 'scroll-up', 'scroll-down', 'drag-grab', 'drag-carry',
    'drag-drop', 'waiting-approval', 'error', 'success', 'thinking', 'handoff', 'working'].map(state => at(state, 0, 0, 1));
  const resolve = (m, { heading = 90, distance = 0 } = {}) => base().map(s => {
    const d = Math.round(heading / 22.5) % 16;
    if (s.state === 'move') return distance > 60 && d >= 3 && d <= 5 ? at('move', 2, 0, 2, { loop: true }) : at('move', 1, d % 8, 1);
    if (s.state === 'click') return at('click', 1, 1, 2, { flip: 'h' });
    if (s.state === 'double-click') return at('double-click', 1, 1, 2, { repeat: 2 });
    if (s.state === 'handoff') return { ...s, then: 'idle' };
    if (s.state === 'scroll-up') return { ...s, look: { row: 1, start: 0 } };
    return s;
  });
  const manifest = { id: 'snapshot', sheet: 'sheet.png', frame: { w: 64, h: 64 }, scale, states: {} };
  if (cells) { mkdirSync(folder, { mode: 0o700 }); writeFileSync(join(folder, 'sheet.png'), png({ cells }), { mode: 0o600 }); }
  return { character: { manifest, folder, sheets: { sheet: { width: 512, height: 192 } }, resolved: resolve(manifest) }, resolve };
}

test('character-frame turns a resolved snapshot into the host table (no VC3 code needed)', t => {
  const { character: c, resolve } = snapshot(t, { folder: '/private/tmp/never-read/snapshot' });
  const wire = characterFrame(c, { nonce, seq: 0, resolve });
  assert.deepEqual(Object.keys(wire).sort(), ['cell', 'extra', 'hand', 'id', 'nonce', 'seq', 'sheet', 'table']);
  assert.equal(Object.keys(wire.table).filter(k => !k.includes('@')).length, 19);
  assert.deepEqual([wire.table.click.frames, wire.table.click.flip], [[1, 2], true]);
  assert.deepEqual(wire.table['double-click'].frames, [1, 2, 1, 2]);
  assert.equal(wire.table.handoff.then, 'idle'); assert.equal(wire.table.idle.then, undefined);
  assert.deepEqual([wire.table['scroll-up'].row, wire.table['scroll-up'].frames, wire.table['scroll-down'].row], [1, [0], 0]);
  assert.deepEqual(Object.keys(wire.table).filter(k => k.includes('-far@')).sort(), ['move-far@3', 'move-far@4', 'move-far@5']);
  assert.equal(wire.table['move@0'].row, 1); assert.equal(wire.table['move@4'], undefined, 'the base entry already is heading 90');
  assert.deepEqual([wire.table.click.size, wire.table.click.scale], [[512, 192], .75]);
  assert.throws(() => characterFrame(c, { nonce: 'wrong', seq: 0, resolve }), /identity/);
  assert.throws(() => characterFrame(c, { nonce, seq: 0 }), /resolve/);
  for (const [sheets, frame] of [[{ sheet: { width: 1536, height: 2496 } }, { w: 192, h: 208 }], [{ sheet: { width: 2048, height: 192 } }, { w: 256, h: 64 }]]) {
    assert.throws(() => characterFrame({ ...c, sheets, manifest: { ...c.manifest, frame } }, { nonce, seq: 0, resolve }), /too large to draw/);
  }
  assert.deepEqual(SPRITE_LIMITS, { sheet: { width: 1536, height: 2288 }, cell: { width: 192, height: 208 } });
});

test('the host accepts the adapter\'s snapshot frame and plays the far row on a long glide', options, t => {
  const folder = join(root(), 'snapshot');
  const { character: c, resolve } = snapshot(t, { folder, cells: [[0, 0], ...Array.from({ length: 8 }, (_, i) => [1, i]), [2, 0], [2, 1]] });
  const wire = characterFrame(c, { nonce, seq: 0, resolve });
  const r = good(t, [wire, act('click', { at: [300, 300], path: [[300, 300]] }), act('click', { seq: 2, at: [500, 300], path: [[500, 300]] })]);
  assert.equal(loaded(r).loaded, true, r.stderr);
  assert.deepEqual(draws(r)[1].sprite.poses.filter(p => p.state === 'move').map(p => [p.row, p.column]).slice(0, 2), [[2, 0], [2, 1]]);
});

// VC3's real character.mjs: in the tree after integration, before it from git when the history has it (not a shallow clone).
let modules;
async function vc3(t) {
  if (modules !== undefined) return modules;
  const local = new URL('../plugins/sleight/lib/hand/character.mjs', import.meta.url);
  let code;
  if (existsSync(local)) code = readFileSync(local);
  else {
    const r = spawnSync('/usr/bin/git', ['show', '9751c49f:plugins/sleight/lib/hand/character.mjs'], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
    if (r.status !== 0) return modules = null;
    code = r.stdout;
  }
  const fixture = join(root(), 'modules'); mkdirSync(fixture);
  writeFileSync(join(fixture, 'character.mjs'), code);
  return modules = await import(pathToFileURL(join(fixture, 'character.mjs')));
}

test('character-frame against VC3\'s loadCharacter output', options, async t => {
  const m3 = await vc3(t); if (!m3) return t.skip('VC3 character.mjs is not in this tree or its history');
  const f = character({ image: { cells: [[0, 0], ...Array.from({ length: 8 }, (_, i) => [1, i]), ...Array.from({ length: 8 }, (_, i) => [2, i])] } });
  const manifest = { format: 'sleight-character', version: 1, id: f.id, name: 'Fixture', description: '', author: 'Test', license: 'CC0-1.0',
    sheet: 'sheet.png', frame: { w: 64, h: 64 }, grid: { cols: 8, rows: 3 }, scale: .75, anchor: { x: 32, y: 60 }, hotspot: { x: 32, y: 32 },
    states: { idle: { row: 0, frames: 1, ms: 100, loop: true }, click: { row: 1, start: 1, frames: 2, ms: [80, 120], loop: false, flip: 'h' },
      move: { dir16: { rowA: 1, rowB: 2 } } } };
  writeFileSync(join(root(), f.id, 'character.json'), JSON.stringify(manifest), { mode: 0o600 });
  const wire = characterFrame(m3.loadCharacter(join(root(), f.id), { installed: true }), { nonce, seq: 0, resolve: m3.resolveCharacterStates });
  assert.equal(Object.keys(wire.table).filter(k => !k.includes('@')).length, 19);
  assert.deepEqual([wire.table.click.frames, wire.table.click.flip, wire.table['double-click'].frames], [[1, 2], true, [1, 2, 1, 2]]);
  assert.equal(wire.table['move@0'].row, 1); assert.equal(wire.table['move@8'].row, 2);
  assert.deepEqual([wire.table.click.size, wire.table.click.scale], [[512, 192], .75]);
  const r = good(t, [wire, act()]); assert.equal(loaded(r).loaded, true, r.stderr);
  t.diagnostic(`wireBytes=${Buffer.byteLength(JSON.stringify(wire))} entries=${Object.keys(wire.table).length}`);
});

test('a Codex v2 pet imports as it is, as WebP, and renders through character-frame', options, async t => {
  const m3 = await vc3(t); if (!m3) return t.skip('VC3 character.mjs is not in this tree or its history');
  // Codex v2 used frames per row (R3 section 0): ink only there, plus the optional neutral pose at row 0, column 6.
  const used = [7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8], cells = used.flatMap((n, row) => Array.from({ length: n }, (_, col) => [row, col]));
  const pet = mkdtempSync(join(root(), 'pet-')), id = `codex-${++counter}`;
  writeFileSync(join(pet, 'pet.json'), JSON.stringify({ id, displayName: 'Fixture pet', spriteVersionNumber: 2, spritesheetPath: 'spritesheet.webp' }), { mode: 0o600 });
  writeFileSync(join(pet, 'spritesheet.webp'), webp({ w: 1536, h: 2288, cw: 192, ch: 208, cells }), { mode: 0o600 });
  const folder = m3.installCharacter(m3.prepareCharacterImport(pet), { root: root() });
  const wire = characterFrame(m3.loadCharacter(folder, { installed: true }), { nonce, seq: 0, resolve: m3.resolveCharacterStates });
  const r = good(t, [wire, act('click', { at: [300, 300], path: [[300, 300]] }), act('click', { seq: 2, at: [600, 300], path: [[600, 300]] }),
    status('waiting', { seq: 3 })]);
  assert.equal(loaded(r).loaded, true); assert.equal(r.stderr, '');
  const [first, second, waiting] = draws(r);
  assert.deepEqual(first.sprite.poses.map(p => [p.row, p.column]), [[4, 1], [4, 2], [4, 3]]);
  // A 300 pt rightward glide plays running-right (row 1), R3 1.4.
  assert.deepEqual(second.sprite.poses.filter(p => p.state === 'move').map(p => p.row)[0], 1);
  assert.ok(waiting.sprite.poses.every(p => p.row === 6)); assert.ok(waiting.sprite.poses.at(-1).time <= 4.8);
  const scale = wire.table.idle.scale;
  assert.deepEqual(first.sprite.placements[0].slice(2), [192 * scale, 208 * scale]);
  t.diagnostic(`codexWireBytes=${Buffer.byteLength(JSON.stringify(wire))} entries=${Object.keys(wire.table).length} scale=${scale}`);
});
