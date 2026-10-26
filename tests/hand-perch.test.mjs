import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { loadCharacter, prepareCharacterImport, resolvePerchStates, characterLines, characterLineValid, resolveCharacterStates, LINE_MOMENTS } from '../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../plugins/sleight/lib/hand/character-frame.mjs';
import { readHandConfig } from '../plugins/sleight/lib/hand/settings.mjs';
import { cursorCommand } from '../plugins/sleight/lib/hand/cursor-command.mjs';
import { cursorMenuModel, createCursorPicker } from '../plugins/sleight/lib/hand/cursor-picker.mjs';
import { settingsCommand } from '../plugins/sleight/lib/person-gate.mjs';

// Perch mode and personality lines (art direction A2): the loader and frame in Node, then the host's PerchRuntime through
// --perch-dump with injected window lists. The dump builds no application, panel or window and decodes nothing.
const mac = process.platform === 'darwin' && spawnSync('/usr/bin/xcode-select', ['-p']).status === 0;
const onMac = { skip: mac ? false : 'needs macOS with the developer tools (xcode-select -p)' };
const nonce = 'a'.repeat(64);
const temp = () => trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-perch-'))));

// Header-only images: the loader reads container headers and never decodes.
function png(w, h) {
  const chunk = (type, data = Buffer.alloc(0)) => { const size = Buffer.alloc(4); size.writeUInt32BE(data.length); return Buffer.concat([size, Buffer.from(type), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT'), chunk('IEND')]);
}
function webp(w, h) {
  const body = Buffer.alloc(6); body[0] = 0x2f; body.writeUInt32LE((w - 1) | (h - 1) << 14, 1);
  const head = Buffer.alloc(8); head.write('VP8L'); head.writeUInt32LE(body.length, 4);
  const riff = Buffer.alloc(12); riff.write('RIFF'); riff.writeUInt32LE(4 + 8 + body.length, 4); riff.write('WEBP', 8);
  return Buffer.concat([riff, head, body]);
}
const timed = (row, frames, ms, loop = true, more = {}) => ({ row, frames, ms, loop, ...more });
// A2's perch block for the cast (A2-cells/perch-states.json), with a measured palm.
const PERCH = {
  perch: timed(0, 6, [320, 120, 120, 260, 260, 400], true, { sheet: 'perch' }), 'perch-peek': timed(0, 2, [1400, 400], true, { sheet: 'perch', start: 6 }),
  'perch-hop': timed(1, 4, [70, 120, 70, 160], false, { sheet: 'perch' }), 'perch-point-left': timed(1, 1, 320, false, { sheet: 'perch', start: 4 }),
  'perch-point-right': timed(1, 1, 320, false, { sheet: 'perch', start: 5 }), sleep: timed(1, 2, [1500, 1500], true, { sheet: 'perch', start: 6 }),
  'high-five': timed(2, 3, [90, 120, 420], false, { sheet: 'perch', hotspot: { x: 139, y: 89 } }), 'perch-wait': timed(2, 2, [900, 500], true, { sheet: 'perch', start: 3 }),
  startle: timed(2, 2, [70, 110], false, { sheet: 'perch', start: 5 }),
};
const LINES = { lang: 'en', start: ['Okay! Let us go.', 'On it.', 'Here we go.'], 'first-click': ['Click!'], typing: ['Tap tap.', 'Typing.'],
  'long-wait': ['Still here.', 'No rush.'], approval: ['Your call.', 'Waiting on you.'], error: ['Oof.', 'Missed.'], done: ['Done!', 'Ta-da!'],
  handback: ['All yours.', 'Your turn.'], wake: ['Oh! Hi!', 'Awake!'] };
function pack({ perch = true, lines = LINES, states = {}, seat = 150, more = {} } = {}) {
  const folder = join(temp(), 'cast'); mkdirSync(folder, { mode: 0o700 });
  writeFileSync(join(folder, 'sheet.png'), png(1536, 2288), { mode: 0o600 });
  if (perch) writeFileSync(join(folder, 'perch.webp'), webp(1536, 624), { mode: 0o600 });
  const m = { format: 'sleight-character', version: 1, id: 'cast', name: 'Cast', description: '', author: 'test', license: 'MIT', sheet: 'sheet.png',
    frame: { w: 192, h: 208 }, grid: { cols: 8, rows: 11 }, scale: 0.5, anchor: { x: 96, y: 196 }, hotspot: { x: 96, y: 104 },
    states: { idle: timed(0, 6, [280, 110, 110, 140, 140, 320]), 'running-right': timed(1, 8, 120), 'running-left': timed(2, 8, 120), wave: timed(3, 4, 140, false),
      jumping: timed(4, 5, [140, 140, 140, 140, 280], false), error: timed(5, 8, 95, false), 'waiting-approval': timed(6, 6, 150), working: timed(7, 6, 120),
      look: { dir16: { rowA: 9, rowB: 10 } }, ...perch ? PERCH : {}, ...states },
    ...perch ? { perch: { anchor: { x: 96, y: seat }, sheet: 'perch.webp' } } : {}, ...lines ? { lines } : {}, ...more };
  writeFileSync(join(folder, 'character.json'), JSON.stringify(m), { mode: 0o600 });
  return loadCharacter(folder, { shared: true });
}
const full = c => c.warnings.filter(w => !w.startsWith('Partial character')); // the fixture draws only some event states
const frameOf = (character, seq = 1) => characterFrame(character, { nonce, seq, resolve: resolveCharacterStates });

test('a pack with a perch sheet, perch states and lines loads clean and sends them in the character frame', () => {
  const c = pack();
  assert.deepEqual(full(c), []);
  assert.deepEqual(c.sheets.perch, { name: 'perch.webp', rows: 3, width: 1536, height: 624 });
  const f = frameOf(c);
  assert.deepEqual(Object.keys(f).sort(), ['cell', 'extra', 'hand', 'id', 'lines', 'nonce', 'perch', 'perchSheet', 'seq', 'sheet', 'table']);
  assert.match(f.perchSheet, /\/cast\/perch\.webp$/);
  assert.deepEqual(f.perch.anchor, [96, 150]);
  assert.deepEqual(Object.keys(f.perch.table).sort(), ['error', 'handoff', 'high-five', 'jumping', 'paused', 'perch', 'perch-hop', 'perch-peek', 'perch-point-left',
    'perch-point-right', 'perch-wait', 'running-left', 'running-right', 'sleep', 'startle']);
  assert.deepEqual(f.perch.table['perch-peek'], { sheet: 'perch', row: 0, frames: [6, 7], ms: [1400, 400], loop: true, flip: false, hotspot: [96, 104], size: [1536, 624], scale: 0.5 });
  assert.deepEqual(f.perch.table['high-five'].hotspot, [139, 89]);
  assert.deepEqual(f.perch.table.jumping, { sheet: 'sheet', row: 4, frames: [0, 1, 2, 3, 4], ms: [140, 140, 140, 140, 280], loop: false, flip: false, hotspot: [96, 104], size: [1536, 2288], scale: 0.5 });
  assert.deepEqual(f.lines, LINES);
  // Perch off: no perch sheet or table, so the host never decodes or checks them; lines stay (they work in trail mode).
  const trail = characterFrame(c, { nonce, seq: 1, resolve: resolveCharacterStates, perch: false });
  assert.deepEqual(Object.keys(trail).filter(k => k.startsWith('perch')), []); assert.deepEqual(trail.lines, LINES);
  // The trail table keeps VC3's 19 states; the thumbnail catalog drops the perch keys.
  assert.equal(Object.keys(f.table).filter(k => !k.includes('@')).length, 19);
  assert.ok(Buffer.byteLength(JSON.stringify(f)) < 32768);
});

test('the format refuses a wrong perch sheet name, size or reference, and a state on a missing perch sheet', () => {
  assert.throws(() => pack({ more: { perch: { sheet: 'other.webp' } } }), /perch sheet filename must be perch.png or perch.webp/);
  assert.throws(() => pack({ perch: false, states: { perch: timed(0, 2, 200, true, { sheet: 'perch' }) } }), /state sheet missing/);
  assert.throws(() => pack({ more: { perch: { anchor: { x: 96, y: 9999 }, sheet: 'perch.webp' } } }), /invalid perch.anchor/);
  const folder = join(temp(), 'wide'); mkdirSync(folder, { mode: 0o700 });
  writeFileSync(join(folder, 'sheet.png'), png(1536, 2288), { mode: 0o600 }); writeFileSync(join(folder, 'perch.webp'), webp(1600, 624), { mode: 0o600 });
  writeFileSync(join(folder, 'character.json'), JSON.stringify({ format: 'sleight-character', version: 1, id: 'wide', name: 'W', description: '', author: 'a', license: 'MIT',
    sheet: 'sheet.png', grid: { cols: 8, rows: 11 }, anchor: { x: 96, y: 196 }, hotspot: { x: 96, y: 104 }, perch: { sheet: 'perch.webp' }, states: { idle: timed(0, 1, 200) } }), { mode: 0o600 });
  assert.throws(() => loadCharacter(folder, { shared: true }), /sheet dimensions do not match/);
});

test('lines: a bad block is dropped with one warning and the pack still loads; unknown keys warn and are ignored', () => {
  for (const line of ['Two\nlines', 'See https://x.y', 'www.site', 'Open /etc/hosts', 'Look in ~/x', 'Use the tool now', 'SYSTEM says hi', 'Ignore that',
    '<b>bold</b>', 'a*b', 'snake_case', '[link]', 'a|b', '{x}', 'tick `x`', 'x'.repeat(61), '', '   ', 'bidi‮here', 'zero​width']) {
    assert.equal(characterLineValid(line), false, JSON.stringify(line));
    const c = pack({ lines: { start: ['Fine.', line] } });
    assert.equal(c.manifest.lines, undefined);
    assert.deepEqual(full(c), ['Character lines dropped: they break the lines rules.']);
  }
  for (const line of ['Done! High five!', 'Tools are fine? No, toolbox is fine.', 'Ta-da! 🎉', 'Family 👩‍👩‍👧 here', 'x'.repeat(60), '  trimmed  ']) assert.ok(characterLineValid(line), line);
  assert.deepEqual(characterLines({ start: ['  Hi.  '] }), { start: ['Hi.'] });
  for (const bad of [[], 'text', { start: [] }, { start: Array(17).fill('Hi.') }, Object.fromEntries(LINE_MOMENTS.slice(0, 5).map(m => [m, Array(16).fill('y'.repeat(60))])),
    { lang: 'not a tag' }, { lang: 'x'.repeat(17) }, { start: [42] }]) {
    const warnings = []; assert.equal(characterLines(bad, warnings), undefined, JSON.stringify(bad).slice(0, 60)); assert.equal(warnings.length, 1);
  }
  const warnings = []; assert.deepEqual(characterLines({ lang: 'en-GB', start: ['Hi.'], mood: ['x'] }, warnings), { lang: 'en-GB', start: ['Hi.'] });
  assert.deepEqual(warnings, ['Unknown lines key ignored.']);
  assert.deepEqual(LINE_MOMENTS, ['start', 'first-click', 'typing', 'long-wait', 'approval', 'error', 'done', 'handback', 'wake']);
  // A pack without lines has none in its frame.
  assert.equal(frameOf(pack({ lines: null })).lines, undefined);
});

test('a Codex pet works in perch mode on day one: every perch state falls back to its own rows', () => {
  const folder = join(temp(), 'pet'); mkdirSync(folder, { mode: 0o700 });
  writeFileSync(join(folder, 'atlas.png'), png(1536, 2288), { mode: 0o600 });
  writeFileSync(join(folder, 'pet.json'), JSON.stringify({ id: 'pip', displayName: 'Pip', spriteVersionNumber: 2, spritesheetPath: 'atlas.png' }), { mode: 0o600 });
  const pet = prepareCharacterImport(folder), p = pet.perch, cells = s => [p.states[s].sheet, p.states[s].row, p.states[s].columns];
  assert.deepEqual(p.anchor, { x: 96, y: 196 }, 'feet on the edge');
  assert.deepEqual(cells('perch'), ['sheet.png', 0, [0, 1, 2, 3, 4, 5]]);
  assert.deepEqual(cells('perch-peek'), ['sheet.png', 10, [0]], 'look at heading 180');
  assert.deepEqual(cells('perch-point-left'), ['sheet.png', 10, [2]], 'look at heading 225');
  assert.deepEqual(cells('perch-point-right'), ['sheet.png', 9, [6]], 'look at heading 135');
  assert.deepEqual(cells('perch-hop'), ['sheet.png', 4, [0, 1, 3, 4]], 'jumping cols 0, 1, 3, 4');
  assert.deepEqual(cells('jumping'), ['sheet.png', 4, [0, 1, 2, 3, 4]]);
  assert.deepEqual(cells('sleep'), ['sheet.png', 0, [0]], 'idle first cell; the host draws the Zs');
  assert.deepEqual(cells('high-five'), ['sheet.png', 3, [0, 1, 2, 3]], 'wave');
  assert.deepEqual(cells('perch-wait'), ['sheet.png', 6, [0, 1, 2, 3, 4, 5]], 'waiting');
  assert.deepEqual([...cells('startle'), p.states.startle.ms], ['sheet.png', 5, [0, 1], [70, 110]], 'failed cols 0 to 1');
  assert.deepEqual(cells('running-left'), ['sheet.png', 2, [0, 1, 2, 3, 4, 5, 6, 7]]);
  assert.equal(Object.entries(p.states).filter(([k, s]) => s.own && !k.startsWith('running')).length, 0, 'no perch art of its own');
  // A pack with an aim and no look points with its aim; with both, look wins.
  const aimOnly = resolvePerchStates({ ...pet.manifest, codex: undefined, states: { idle: timed(0, 6, 100), aim: timed(3, 1, 200, false) } });
  assert.deepEqual([aimOnly.states['perch-point-left'].row, aimOnly.states['perch-point-left'].source], [3, 'aim']);
  const none = resolvePerchStates({ ...pet.manifest, codex: undefined, states: { idle: timed(0, 6, 100) } });
  assert.deepEqual([none.states['perch-hop'].columns, none.states['perch-peek'].columns, none.states.startle.ms], [[0], [0], [180]]);
});

test('settings: perch and lines in hand.json, the CLI forms, the menu row and the person gate', async () => {
  const dir = temp(), path = join(dir, 'hand.json'), root = join(dir, 'characters');
  mkdirSync(join(root, 'cast'), { recursive: true, mode: 0o700 });
  const c = pack(); for (const [name, bytes] of c.files) writeFileSync(join(root, 'cast', name), bytes, { mode: 0o600 });
  writeFileSync(path, JSON.stringify({ version: 1, enabled: true }), { mode: 0o600 });
  let text = ''; const run = args => cursorCommand(args, { out: t => { text += t; }, path, root, platform: 'darwin', env: {}, built: () => false });
  assert.equal(await run(['style', 'sprite', 'cast', '--perch']), 0);
  assert.deepEqual(readHandConfig(path), { state: 'on', style: 'sprite', character: 'cast', perch: true });
  assert.match(text, /perched on the window/);
  assert.equal(await run(['style', 'sprite', 'cast']), 0);
  assert.equal(readHandConfig(path).perch, false);
  assert.equal(await run(['lines', 'off']), 0);
  assert.equal(readHandConfig(path).lines, 'off');
  text = ''; assert.equal(await run(['status']), 0);
  assert.match(text, /perch     off\nlines     off/);
  for (const bad of [['style', 'ring', '--perch'], ['lines', 'maybe'], ['lines'], ['style', 'sprite', '--perch', 'cast']]) assert.equal(await run(bad), 2, bad.join(' '));
  for (const bad of [{ perch: 'yes' }, { lines: true }, { lines: 'quiet' }]) {
    writeFileSync(path, JSON.stringify({ version: 1, enabled: true, ...bad }), { mode: 0o600 });
    assert.equal(readHandConfig(path).state, 'unsafe', JSON.stringify(bad));
  }
  // Writers of settings: the guard's person gate refuses them unless a person typed them in a terminal.
  assert.equal(settingsCommand(['cursor', 'lines', 'off']), 'cursor lines');
  assert.equal(settingsCommand(['cursor', 'style', 'sprite', 'cast', '--perch']), 'cursor style');
  // The menu: a "Character lines" toggle with a sprite selected, and its click writes lines through the same writer.
  const rows = cursorMenuModel({ installed: [{ id: 'cast', name: 'Cast' }], style: 'sprite', character: 'cast', lines: 'off' });
  assert.deepEqual(rows.find(r => r.op === 'lines'), { title: 'Character lines', op: 'lines', selected: false });
  const written = [], picker = createCursorPicker({ root, writeSetting: async s => written.push(s) });
  assert.deepEqual(await picker.apply({ op: 'lines', lines: 'on' }), { ok: true, lines: 'on' });
  assert.equal((await picker.apply({ op: 'lines', lines: 'loud' })).ok, false);
  assert.deepEqual(written, [{ lines: 'on' }]);
});

// The host's dump.
let built;
function host() {
  if (built) return built;
  const binary = join(temp(), 'consent-host');
  const r = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname, '-o', binary], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return (built = binary);
}
const W = (id, frame, more = {}) => ({ id, pid: 42, frame, ...more });
const world = (windows, displays) => ({ dumpWorld: { windows, ...displays ? { displays } : {} } });
let seq = 10;
const aim = (x, y, window = 7) => ({ hand: 'aim', nonce, seq: ++seq, kind: 'click', pid: 42, windowId: window, at: [x, y] });
const act = (kind, x, y, window = 7, more = {}) => ({ hand: 'act', nonce, seq: ++seq, kind, pid: 42, windowId: window, at: [x, y], path: [[x, y]], delayMs: 0, beats: 1, ...more });
// The client sends statuses with the last act's point.
const status = (state, more = {}, window = 7) => ({ hand: 'status', nonce, seq: ++seq, state, pid: 42, windowId: window, at: [500, 400], ...more });
const clock = s => ({ dumpClock: s });
const options = (perch = true, lines = true) => ({ hand: 'picker', nonce, op: 'options', perch, lines });
// Tsugi's measured leg spread, 15 pt left and 14.5 pt right of the seat (the review's measurement of its perch sheet).
const TSUGI_LEGS = [15, 14.5];
function dump(lines, { character = pack(), reduced = false, seed = 1, legs = TSUGI_LEGS } = {}) {
  const input = [frameOf(character), options(), ...legs ? [{ dumpLegs: legs }] : [], ...lines].map(l => JSON.stringify(l)).join('\n') + '\n';
  const r = spawnSync(host(), ['--perch-dump', ...reduced ? ['--reduce-motion'] : [], `--seed=${seed}`], { input, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').map(l => JSON.parse(l));
}
const perches = out => out.filter(e => e.effect === 'perch');
const wide = W(7, [200, 200, 800, 500]);
const seatOf = (windows, at, displays) => {
  const out = dump([world(windows, displays), aim(...at)]);
  return perches(out)[0]?.seat ?? out.find(e => e.effect === 'perch-hide')?.reason ?? 'none';
};

test('seat: nearest the target on the edge, the legs clear of the 80 pt cluster, peeking when the legs cannot fit', onMac, () => {
  assert.deepEqual(seatOf([wide], [600, 400]), { x: 600, edge: 200, peek: false, rise: 75, window: 7 });
  assert.equal(seatOf([wide], [205, 400]).x, 303);
  assert.equal(seatOf([wide], [995, 400]).x, 920);
  assert.equal(seatOf([W(7, [100, 200, 220, 300])], [101, 400]).x, 203, 'legs 15 pt left of the seat stay 8 pt clear of an 80 pt cluster');
  assert.deepEqual(seatOf([W(7, [100, 200, 150, 300])], [101, 400]), { x: 148, edge: 200, peek: true, rise: 48, window: 7 }, 'legs cannot clear the cluster: peek');
  assert.deepEqual(seatOf([W(7, [100, 200, 90, 300])], [101, 400]), { x: 145, edge: 200, peek: true, rise: 48, window: 7 }, 'under 96 pt: the peek');
  assert.equal(seatOf([W(7, [100, 200, 47, 300])], [110, 400]), 'narrow');
});

test('seat: moves 72 pt off a target just under the edge, toward the center, and the box always ends 29 pt under the edge', onMac, () => {
  assert.equal(seatOf([wide], [400, 220]).x, 472, 'toward the center');
  assert.equal(seatOf([wide], [800, 250]).x, 728);
  assert.equal(seatOf([wide], [400, 260]).x, 400, 'more than 56 pt under the edge');
  const p = perches(dump([world([wide]), aim(600, 400)]))[0];
  const [x, y] = p.positions.at(-1).slice(1);
  assert.deepEqual([x, y + 104 - 200], [552, 29]);
});

test('seat: headroom under the menu bar peeks or hides; full screen and a missing window hide', onMac, () => {
  assert.deepEqual(seatOf([W(7, [200, 85, 800, 500])], [600, 400]), { x: 600, edge: 85, peek: true, rise: 48, window: 7 }, '60 pt under the top');
  assert.deepEqual(seatOf([W(7, [200, 70, 800, 500])], [600, 400]).rise, 45, 'the peek fits the headroom');
  assert.equal(seatOf([W(7, [200, 60, 800, 500])], [600, 400]), 'headroom');
  assert.equal(seatOf([W(7, [0, 0, 1440, 900], { fullScreen: true })], [600, 400]), 'full-screen');
  // On another display, its own top counts.
  assert.equal(seatOf([W(7, [1600, 120, 800, 500])], [1800, 400], [{ frame: [0, 0, 1440, 900], top: 25 }, { frame: [1440, 0, 1920, 1080], top: 100 }]), 'headroom');
});

test('seat: windows in front cut the edge; the longest uncovered span of 96 pt nearest the target wins, else it hides', onMac, () => {
  // Window 8 covers 500 to 900 of the edge: the target at 700 sits on the nearest span, 200 to 500.
  assert.equal(seatOf([W(8, [500, 150, 400, 500]), wide], [700, 400]).x, 452);
  assert.equal(seatOf([W(8, [500, 150, 400, 500]), wide], [950, 400]).x, 950, 'the right span, 900 to 1000, box inside it');
  assert.equal(seatOf([W(8, [500, 150, 450, 500]), wide], [960, 400]).x, 452, 'the right span is only 50 pt');
  assert.equal(seatOf([W(8, [190, 150, 900, 500]), wide], [600, 400]), 'covered');
  assert.equal(seatOf([W(8, [500, 100, 400, 50]), wide], [700, 400]).x, 700, 'a window above the edge cuts nothing');
});

test('moves: drop in, hop per 120 pt, run past 360, leap between windows, far moves fade, reduced motion crossfades', onMac, () => {
  const two = [W(9, [300, 300, 600, 300]), wide];
  const out = dump([world(two), aim(600, 400), clock(1), aim(800, 400), clock(2), aim(300, 400), clock(3), aim(500, 450, 9), clock(4), aim(1100, 900, 9)]);
  const [arrive, hop, run, leap, far] = perches(out);
  assert.equal(arrive.kind, 'arrive');
  assert.deepEqual(arrive.positions[0].slice(1), [552, 45], '80 pt above the seat');
  assert.deepEqual(arrive.opacity, [[0, 0], [0.08, 1]]);
  assert.ok(arrive.positions.at(-1)[0] - 0.28 < 1e-9);
  assert.deepEqual(arrive.states, ['perch-hop', 'perch-point-right']);
  assert.equal(hop.kind, 'hop'); assert.ok(Math.abs(hop.positions.at(-1)[0] - 0.48) < 1e-9, '200 pt: 2 hops of 240 ms');
  assert.ok(Math.min(...hop.positions.map(p => p[2])) < 125 - 13, 'a 14 pt peak');
  assert.equal(hop.cells.filter(c => c[1] === 'perch-hop').length, 8);
  assert.equal(run.kind, 'run'); assert.ok(run.states.includes('running-left')); assert.ok(Math.abs(run.positions.at(-1)[0] - 0.6) < 1e-9, '500 pt: capped at 600 ms');
  assert.equal(leap.kind, 'leap');
  const d = Math.hypot(452 - 255, 225 - 125), apex = Math.min(...leap.positions.map(p => p[2]));
  assert.ok(Math.abs(leap.positions.at(-1)[0] - Math.min(0.52, 0.32 + 0.0005 * d)) < 1e-9);
  assert.ok(Math.abs(apex - (125 - 60)) < 1, `apex ${apex}`);
  assert.deepEqual(leap.cells.filter(c => c[1] === 'jumping').map(c => c[4]), [0, 1, 2, 3, 4]);
  assert.ok(leap.keyPaths.length <= 3, leap.keyPaths.join());
  assert.equal(far.kind, 'hop', 'the same window again');
  const fars = perches(dump([world([wide, W(9, [1200, 600, 200, 200])]), aim(600, 400), clock(1), aim(1300, 700, 9)]));
  assert.equal(fars[1].kind, 'far'); assert.deepEqual(fars[1].opacity, [[0, 1], [0.12, 0], [0.1201, 1]]);
  const display = perches(dump([world([wide, W(9, [1500, 300, 400, 300])], [{ frame: [0, 0, 1440, 900], top: 25 }, { frame: [1440, 0, 1920, 1080], top: 25 }]), aim(600, 400), clock(1), aim(1600, 400, 9)]));
  assert.equal(display[1].kind, 'pop', 'another display: only the new seat draws');
  assert.deepEqual(display[1].opacity, [[0, 0], [0.06, 1]]);
  assert.ok(display[1].positions.every(q => q[1] > 1440), 'no position on the old display');
  const calm = perches(dump([world(two), aim(600, 400), clock(1), aim(800, 400), clock(2), aim(500, 450, 9)], { reduced: true }));
  assert.deepEqual(calm[0].opacity, [[0, 0], [0.15, 1]]);
  assert.deepEqual(calm.slice(1).map(p => [p.kind, p.opacity]), [['fade', [[0, 1], [0.075, 0], [0.15, 1]]], ['fade', [[0, 1], [0.075, 0], [0.15, 1]]]]);
  assert.deepEqual(calm.map(p => p.cells.length), [1, 2, 2], 'first cells only: the old pose, then the new one');
});

test('seat: a new aim on the same window moves only past 60 pt', onMac, () => {
  const [first, near, farther] = perches(dump([world([wide]), aim(600, 400), clock(1), aim(650, 400), clock(2), aim(720, 400)]));
  assert.deepEqual([first.seat.x, near.seat.x, near.kind, farther.seat.x, farther.kind], [600, 600, 'stay', 720, 'hop']);
});

test('reactions: point, bump, peek, wait, wince, a nod per call, hand back, and drag drop', onMac, () => {
  const out = dump([world([wide]), aim(500, 400), clock(1), act('click', 500, 400), clock(2), act('type', 500, 400), clock(3), status('waiting'),
    clock(4), status('error'), clock(5), status('done', { ok: true }), clock(6), status('done'), clock(7), status('handback'), clock(8), status('thinking'),
    clock(9), act('drag', 500, 400, 7, { path: [[500, 400], [600, 450]] }), clock(16)]);
  const p = perches(out), at = t => p.find(e => e.time === t);
  assert.deepEqual(at(0).states.at(-1), 'perch-point-right', 'the target is not left of the seat');
  assert.equal(perches(dump([world([wide]), aim(600, 400), clock(1), aim(560, 400)]))[1].states.at(-1), 'perch-point-left');
  const click = at(1);
  assert.deepEqual(click.states, ['perch']); assert.ok(click.positions.some(q => Math.abs(q[2] - (125 - 3)) < 1e-9), '3 pt bump');
  assert.ok(Math.abs(click.duration - 4.8) < 1e-9, 'the loop parks at 4.8 s');
  assert.deepEqual([at(2).states, at(2).masked.at(-1)], [['perch-peek'], [0, true]]);
  assert.deepEqual(at(3).states, ['perch-wait']);
  assert.deepEqual(at(4).states, ['error', 'perch']);
  // A call's done with ok nods (a 3 pt bump and the hop's settle) and its ring burst stays at the point.
  assert.deepEqual(at(5).states, ['perch-hop', 'perch']);
  assert.ok(at(5).positions.some(q => Math.abs(q[2] - (125 - 3)) < 1e-9));
  assert.deepEqual(out.find(e => e.effect === 'ring' && e.time === 5).at, [500, 400]);
  // The turn's end after that success high-fives, and the ring's burst plays at the palm (139, 89) at scale 0.5.
  const dissolve = out.find(e => e.effect === 'dissolve');
  assert.deepEqual([dissolve.time, dissolve.at], [6, [600 - 48 - 100 + 69.5, 125 + 44.5]]);
  assert.deepEqual(out.find(e => e.effect === 'ring' && e.time === 6).at, dissolve.at);
  assert.deepEqual(at(6).states, ['high-five', 'perch']);
  assert.equal(out.filter(e => e.effect === 'dissolve').length, 1, 'once a turn');
  assert.deepEqual([at(7).states, at(8).states], [['handoff', 'perch'], ['perch']]);
  const drag = p.filter(e => e.time >= 9);
  assert.deepEqual(drag[0].states, ['perch-hop', 'perch-peek'], 'a drag seats again, nearest its drop');
  assert.deepEqual(drag[1].states, ['perch'], 'perch at the drop');
  assert.ok(drag[1].time > 9 && drag[1].time < 10.2, `drop at ${drag[1].time}`);
  // Every plan parks: its animations come off at its end.
  const parks = out.filter(e => e.effect === 'perch-park').map(e => e.time);
  assert.ok(parks.some(t => Math.abs(t - (drag[1].time + drag[1].duration)) < 1e-6));
});

test('the high-five plays once a turn, at its end, only when its last call succeeded', onMac, () => {
  const out = dump([world([wide]), aim(500, 400), status('done', { ok: true }), clock(1), status('done', { ok: true }), clock(2), status('done'), clock(10),
    aim(500, 400), status('done', { ok: true }), clock(11), status('error'), clock(12), status('done'), clock(20), aim(500, 400), clock(21), status('done')]);
  const p = perches(out);
  assert.deepEqual(p.filter(e => e.states.includes('high-five')).map(e => e.time), [2]);
  assert.deepEqual(out.filter(e => e.effect === 'dissolve').map(e => e.time), [2]);
  assert.deepEqual(p.filter(e => e.time === 12 || e.time === 21).map(e => e.states), [['handoff', 'perch'], ['handoff', 'perch']], 'after an error, or with no call');
  assert.equal(p.filter(e => e.states[0] === 'perch-hop' && e.kind === 'stay').length, 3, 'a nod per successful call');
});

test('waiting stays up to 120 s, then the perch, then sleep after 20 s', onMac, () => {
  const out = dump([world([wide]), aim(500, 400), status('waiting'), clock(200)]);
  const p = perches(out);
  assert.deepEqual(p.map(e => [e.time, e.states.at(-1)]), [[0, 'perch-point-right'], [0, 'perch-wait'], [120, 'perch'], [140, 'sleep']]);
});

test('sleep: after 20 s 3 cycles and the Zs, then still with no animation; the next frame startles first, and paused never sleeps', onMac, () => {
  const out = dump([world([wide]), aim(500, 400), clock(40), act('click', 500, 400), clock(41)]);
  const sleep = perches(out).find(e => e.states.includes('sleep'));
  assert.deepEqual([sleep.time, sleep.duration, sleep.zs, sleep.zsStill], [20, 9, true, false]);
  assert.equal(sleep.cells.length, 7);
  assert.deepEqual(sleep.keyPaths, ['contentsRect', 'zs'], 'two animations during the loop');
  assert.deepEqual(out.filter(e => ['perch-park', 'perch-still'].includes(e.effect) && e.time >= 20).map(e => [e.effect, e.time]).slice(0, 2), [['perch-park', 29], ['perch-still', 29]]);
  const woke = perches(out).find(e => e.time === 40);
  assert.deepEqual(woke.states, ['startle', 'perch']);
  assert.ok(woke.positions.some(q => Math.abs(q[2] - (125 - 6)) < 1e-9), '6 pt bump');
  assert.deepEqual(out.filter(e => e.effect === 'line').map(e => e.moment), ['start', 'wake']);
  // C1's pause: the ring's paused frame shows the paused pose, and no sleep follows while it holds.
  const paused = dump([world([wide]), aim(500, 400), clock(1), status('paused'), clock(60)]);
  assert.deepEqual(perches(paused).at(-1).states, ['paused']);
  assert.ok(!perches(paused).some(e => e.states.includes('sleep')));
  const still = perches(dump([world([wide]), aim(500, 400), clock(30)], { reduced: true })).find(e => e.states.includes('sleep'));
  assert.deepEqual([still.cells.length, still.zsStill, still.keyPaths], [1, true, []]);
});

test('hide rules: the person moving the window hides it until the frame holds still 500 ms; a closed window hides it', onMac, () => {
  const moved = W(7, [260, 200, 800, 500]), later = W(7, [300, 220, 800, 500]);
  const out = dump([world([wide]), aim(600, 400), clock(1), world([moved]), clock(1.3), world([later]), clock(1.7), world([later]), clock(2.5), world([])]);
  assert.deepEqual(out.filter(e => e.effect.startsWith('perch-hide')).map(e => [e.time, e.reason, e.duration]), [[1, 'moved', 0.12], [2.5, 'gone', 0.12]]);
  const back = perches(out).find(e => e.kind === 'return');
  assert.equal(back.time, 1.8, '500 ms after the last change');
  assert.deepEqual([back.seat.x, back.seat.edge], [700, 220], 'the same spot on the window');
  const end = out.at(-1);
  assert.deepEqual([end.shown, end.poll], [false, null], 'nothing perched, nothing polled');
});

test('lines: 8 s for ordinary moments and 3 s for important ones, never on consecutive acts, narration first, a no-repeat ring and a click to dismiss', onMac, () => {
  const lines = out => out.filter(e => e.effect === 'line').map(e => [e.time, e.moment]);
  // Typing at 3 s is dropped, but the error at 3.5 s clears the important-moment floor.
  const a = dump([world([wide]), aim(500, 400), clock(3), act('type', 500, 400), clock(3.5), status('error'), clock(20),
    status('done', { ok: true }), clock(21), status('done'), clock(29), aim(500, 400), status('done', { ok: true }), clock(30), status('done'), clock(40)]);
  assert.deepEqual(lines(a), [[0, 'start'], [3.5, 'error'], [20, 'first-click'], [29, 'start']]);
  // An error burst, one a second for 6 s, says at most one line per 3 s.
  const burst = dump([world([wide]), aim(500, 400), clock(10), ...[10, 11, 12, 13, 14, 15].flatMap(t => [clock(t), status('error', { at: [500 + t, 400] })]), clock(30)]);
  assert.deepEqual(lines(burst), [[0, 'start'], [10, 'error'], [13, 'error']]);
  const start = a.find(e => e.effect === 'line');
  assert.equal(start.until, Math.min(4, 1.8 + 0.04 * start.text.length));
  assert.equal(start.bubble.side, 'above');
  assert.equal(start.bubble.frame[1] + start.bubble.frame[3], 125 - 6, '6 pt above the head');
  // Never two lines for two consecutive acts: the typing line's act, then the next act's wake.
  const b = dump([world([wide]), act('type', 500, 400), clock(30), act('click', 500, 400), clock(60), act('click', 500, 400), clock(61)]);
  assert.deepEqual(lines(b), [[0, 'typing'], [60, 'wake']]);
  // Narration first (C2's bubble on the ring's plan): a line waits for it to fade, and a line up when narration arrives
  // fades in 60 ms. A line held over 5 s is dropped.
  const menu = { hand: 'menu', nonce, enabled: true, capture: 'hidden', version: '1.6.0', narration: 'bubbles' };
  const c = dump([world([wide]), menu, { ...aim(500, 400), say: 'Opening the dialog.' }, clock(10), status('waiting'), clock(11),
    status('thinking', { say: 'Checking the page.' }), clock(20)]);
  assert.equal(c.find(e => e.effect === 'ring').narration, true);
  const [held, approval] = lines(c);
  assert.equal(held[1], 'start'); assert.ok(held[0] > 0.5 && held[0] < 5, `shown at the bubble's end, ${held[0]}`);
  assert.deepEqual(approval, [10, 'approval']);
  assert.deepEqual(c.filter(e => e.effect === 'line-out').map(e => [e.time, e.duration]).filter(e => e[0] === 11), [[11, 0.06]]);
  const stale = dump([world([wide]), menu, { ...aim(500, 400), say: 'Opening the dialog.' }, clock(0.5), status('waiting', { say: 'Waiting for your OK.' }), clock(200)]);
  assert.deepEqual(lines(stale), [], 'the waiting bubble stays 120 s, and the held line is too old by then');
  assert.deepEqual(lines(dump([world([wide]), { dumpNarration: 2 }, aim(500, 400), clock(10)])), [[0, 'start']], 'a ring draw without a bubble ends narration');
  // The ring: with 3 start lines (ring of 2), a pick never repeats one of the last 2.
  const picks = [];
  for (let seed = 1; seed <= 6; seed++) {
    const out = dump([world([wide]), aim(500, 400), clock(10), status('handback'), clock(25), aim(500, 400), clock(35), status('handback'), clock(50), aim(500, 400)], { seed });
    picks.push(out.filter(e => e.effect === 'line' && e.moment === 'start').map(e => e.index));
  }
  for (const p of picks) { assert.equal(p.length, 3); assert.equal(new Set(p).size, 3, p.join()); }
  assert.ok(new Set(picks.map(p => p.join())).size > 1, 'the seed changes the order');
  // A single line shows once a turn.
  const d = dump([world([wide]), status('done', { ok: true }), clock(9), status('done', { ok: true }), clock(30)]);
  assert.deepEqual(lines(d).map(l => l[1]), ['first-click']);
  // Only a person's fresh mouse click dismisses the bubble.
  const e = dump([world([wide]), aim(500, 400), { dumpClick: 'synthetic' }, { dumpClick: 'keyboard' }, { dumpClick: 'old' }, { dumpClick: 'hardware' }, clock(1)]);
  assert.deepEqual(e.filter(x => x.effect === 'click').map(x => [x.kind, x.person, x.dismissed]),
    [['synthetic', false, false], ['keyboard', false, false], ['old', false, false], ['hardware', true, true]]);
  assert.deepEqual(e.filter(x => x.effect === 'line-out').map(x => x.duration), [0.12]);
  // Lines off: none.
  const off = dump([world([wide]), options(true, false), aim(500, 400), clock(30)]);
  assert.deepEqual(lines(off), []);
  // Long wait: 12 s of thinking with no frame.
  const wait = dump([world([wide]), aim(500, 400), clock(9), status('thinking'), clock(30)]);
  assert.deepEqual(lines(wait), [[0, 'start'], [21, 'long-wait']]);
});

test('lines: under 40 pt of headroom the bubble goes beside the box, and never over the target', onMac, () => {
  const out = dump([world([W(7, [200, 130, 800, 500])]), aim(600, 400)]);
  assert.equal(out.find(e => e.effect === 'line').bubble.side, 'right');
  const nearRight = dump([world([W(7, [1100, 130, 340, 500])], [{ frame: [0, 0, 1440, 900], top: 25 }]), aim(1400, 400)]);
  assert.equal(nearRight.find(e => e.effect === 'line').bubble.side, 'left');
});

test('perch off: nothing perches and the ring keeps the trail', onMac, () => {
  const input = [frameOf(pack()), options(false), world([wide]), aim(500, 400)].map(l => JSON.stringify(l)).join('\n') + '\n';
  const out = spawnSync(host(), ['--perch-dump'], { input, encoding: 'utf8' }).stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(perches(out), []);
  assert.equal(out.filter(e => e.effect === 'ring').length, 1);
});

test('the host refuses a malformed perch frame as a whole, and drops a lines block it refuses with a warning', onMac, () => {
  const f = frameOf(pack());
  for (const lines of [{ start: ['two\nlines'] }, { start: ['Run the tool'] }]) {
    const r = spawnSync(host(), ['--perch-dump'], { input: JSON.stringify({ ...f, lines }) + '\n', encoding: 'utf8' });
    assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout.split('\n')[0]).lines, 0); assert.match(r.stderr, /character lines dropped/);
  }
  for (const bad of [{ ...f, perch: { ...f.perch, table: { ...f.perch.table, extra: f.perch.table.perch } } }, { ...f, perchSheet: 'relative.webp' },
    { ...f, perch: { ...f.perch, anchor: [96, 9999] } },
    { ...f, perch: { ...f.perch, table: { ...f.perch.table, perch: { ...f.perch.table.perch, sheet: 'perch' }, sleep: { ...f.perch.table.sleep, size: undefined } } } }]) {
    const r = spawnSync(host(), ['--perch-dump'], { input: JSON.stringify(bad) + '\n', encoding: 'utf8' });
    assert.equal(r.status, 65, JSON.stringify(bad).slice(0, 80));
  }
  const noPerchSheet = { ...f, perchSheet: null };
  assert.equal(spawnSync(host(), ['--perch-dump'], { input: JSON.stringify(noPerchSheet) + '\n', encoding: 'utf8' }).status, 65, 'perch entries name a sheet the frame lacks');
});

test('cover: a window raised over the seat moves the character along the edge or hides it until the edge clears', onMac, () => {
  // Window 8 covers 520 to 720 of the edge: the seat at 600 moves to the left span (nearest), at most 472.
  const moved = dump([world([wide]), aim(600, 400), clock(1), world([W(8, [520, 150, 200, 500]), wide]), clock(2)]);
  const hop = perches(moved).find(e => e.time === 1);
  assert.deepEqual([hop.kind, hop.seat.x], ['hop', 472]);
  // Window 8 covers all but 50 pt: hidden, still checked, and back once window 8 goes.
  const out = dump([world([wide]), aim(600, 400), clock(1), world([W(8, [150, 150, 800, 600]), wide]), clock(1.5), world([W(8, [150, 150, 800, 600]), wide]),
    clock(3), world([wide]), clock(4)]);
  assert.deepEqual(out.filter(e => e.effect === 'perch-hide').map(e => [e.time, e.reason]), [[1, 'covered']]);
  const back = perches(out).find(e => e.kind === 'return');
  assert.deepEqual([back.time, back.seat.x], [3, 600]);
  assert.equal(out.at(-1).shown, true);
  // A frame while covered keeps checking too.
  const frame = dump([world([W(8, [150, 150, 800, 600]), wide]), aim(600, 400), clock(1), world([wide]), clock(2)]);
  assert.deepEqual(frame.filter(e => e.effect === 'perch-hide').map(e => e.reason), ['covered']);
});

test('cover: a scale 1 box settles on a 150 pt sliver, then sleeps without another hop', onMac, () => {
  const sliver = [W(8, [350, 150, 800, 600]), wide];
  const out = dump([world([wide]), aim(600, 400), clock(1), world(sliver),
    ...[2, 2.5, 3, 4, 8, 20, 22, 40].flatMap(t => [clock(t), world(sliver)]), clock(700)],
  { character: pack({ more: { scale: 1 } }) });
  const hops = perches(out).filter(p => ['hop', 'run'].includes(p.kind));
  assert.deepEqual(hops.map(p => [p.time, p.seat.x, p.seat.peek]), [[1, 275, true]]);
  assert.deepEqual(perches(out).filter(p => p.zs).map(p => p.time), [21], 'cover checks never restart sleep');
  assert.deepEqual(out.filter(e => e.effect === 'perch-hide').map(e => [e.time, e.reason]), [[621, 'asleep']]);
  assert.equal(out.at(-1).poll, null);
});

test('cover: returning covered after a window move preserves the seat relative to the window', onMac, () => {
  const moved = W(7, [400, 250, 800, 500]), cover = W(8, [350, 200, 1000, 600]);
  const out = dump([world([wide]), aim(600, 400), clock(1), world([cover, moved]), clock(1.5), world([cover, moved]),
    clock(2), world([moved]), clock(3)]);
  const back = perches(out).find(p => p.kind === 'return');
  assert.deepEqual([back.time, back.seat.x, back.seat.edge], [2, 800, 250]);
  assert.equal(back.seat.x - moved.frame[0], 600 - wide.frame[0], '400 pt from the window left before and after');
});

test('C1 clear: no line and no click panel from the clear until the action is done, approval waiting included', onMac, () => {
  const lines = out => out.filter(e => e.effect === 'line').map(e => [e.time, e.moment]);
  const clear = { hand: 'clear', nonce, token: 'c'.repeat(32) };
  const out = dump([world([wide]), clock(10), clear, status('waiting'), clock(20), status('done', { ok: true }), clock(30), status('waiting'), clock(31)]);
  assert.ok(out.some(e => e.effect === 'perch-hide' && e.reason === 'hide'), 'the clear hides the character as the host does');
  assert.deepEqual(lines(out), [[20, 'first-click'], [30, 'approval']], 'approval after the clear says nothing; after the done they may');
  assert.equal(perches(out).find(e => e.time === 10).states.at(-1), 'perch-wait', 'the character still shows the wait');
});

test('C1 clear: a turn starting with drag, hover or menu_bar says start when its first call finishes', onMac, () => {
  for (const kind of ['drag', 'hover', 'menu_bar']) {
    const clear = { hand: 'clear', nonce, token: 'c'.repeat(32) };
    const out = dump([world([wide]), clear, aim(500, 400),
      ...kind === 'drag' ? [act('drag', 600, 400, 7, { path: [[500, 400], [600, 400]] })] : [],
      clock(1), status('done', { ok: true }), clock(10), aim(500, 400), clock(11)]);
    assert.deepEqual(out.filter(e => e.effect === 'line').map(e => [e.time, e.moment]), [[1, 'start']], kind);
  }
  const partial = dump([world([wide]), aim(500, 400), clock(1), status('done', { ok: true })],
    { character: pack({ lines: { 'first-click': ['Click!'] } }) });
  assert.deepEqual(partial.filter(e => e.effect === 'line').map(e => [e.time, e.moment]), [[1, 'first-click']], 'a pack without start keeps first-click');
});

test('C1 clear: a failed call releases error and approval lines without idle or done', onMac, () => {
  const clear = { hand: 'clear', nonce, token: 'c'.repeat(32) };
  const out = dump([world([wide]), clear, aim(500, 400), act('drag', 600, 400, 7, { path: [[500, 400], [600, 400]] }),
    clock(1), status('error'), clock(4), status('waiting'), clock(5)]);
  assert.deepEqual(out.filter(e => e.effect === 'line').map(e => [e.time, e.moment]), [[1, 'error'], [4, 'approval']]);
});

test('lines: a start dropped by the cap never arrives mid-turn, including a clear retry dropped at the first done', onMac, () => {
  for (const cleared of [false, true]) {
    const out = dump([world([wide]), options(true, false), status('done', { ok: true }),
      clock(2), options(), status('done'), clock(5),
      ...cleared ? [{ hand: 'clear', nonce, token: 'c'.repeat(32) }] : [], aim(500, 400),
      clock(6), status('done', { ok: true }), clock(12), status('done', { ok: true }),
      clock(21), aim(500, 400), clock(22)]);
    assert.deepEqual(out.filter(e => e.effect === 'line').map(e => [e.time, e.moment]),
      [[2, 'done'], [12, 'first-click']], `clear: ${cleared}`);
  }
});

test('lines: a short successful turn says done at 3 s after start with a click at 1.5 s', onMac, () => {
  const out = dump([world([wide]), aim(500, 400), clock(1.5), act('click', 500, 400), status('done', { ok: true }),
    clock(3), status('done'), clock(4)]);
  assert.deepEqual(out.filter(e => e.effect === 'line').map(e => [e.time, e.moment]), [[0, 'start'], [3, 'done']]);
});

test('lines: important moments wait 3 s, ordinary moments wait 8 s, and error bursts keep the 3 s floor', onMac, () => {
  for (const state of ['error', 'waiting', 'handback']) {
    const out = dump([world([wide]), aim(500, 400), clock(2.99), status(state), clock(3), status(state, { at: [501, 400] }), clock(4)]);
    assert.deepEqual(out.filter(e => e.effect === 'line').map(e => [e.time, e.moment]),
      [[0, 'start'], [3, state === 'waiting' ? 'approval' : state]], state);
  }
  const ordinary = dump([world([wide]), aim(500, 400), clock(3), act('type', 500, 400), clock(8), act('click', 500, 400),
    status('done', { ok: true }), clock(9)]);
  assert.deepEqual(ordinary.filter(e => e.effect === 'line').map(e => [e.time, e.moment]), [[0, 'start'], [8, 'first-click']]);
  const burst = dump([world([wide]), ...Array.from({ length: 13 }, (_, t) => [clock(t), status('error', { at: [500 + t, 400] })]).flat(), clock(13)]);
  assert.deepEqual(burst.filter(e => e.effect === 'line').map(e => [e.time, e.moment]), [0, 3, 6, 9, 12].map(t => [t, 'error']));
});

test('lines in trail mode: the same book, the bubble by the sprite', onMac, () => {
  const input = [frameOf(pack()), options(false, true), world([wide]), aim(500, 400), clock(9), act('type', 500, 400), clock(10)].map(l => JSON.stringify(l)).join('\n') + '\n';
  const out = spawnSync(host(), ['--perch-dump'], { input, encoding: 'utf8' }).stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(perches(out), []);
  const said = out.filter(e => e.effect === 'line');
  assert.deepEqual(said.map(e => [e.time, e.moment]), [[0, 'start'], [9, 'typing']]);
  // The trail box sits 18 pt below and right of the point: 518, 418, 96 by 104. The bubble ends 6 pt above it.
  const [x, y, w, h] = said[0].bubble.frame;
  assert.equal(said[0].bubble.side, 'above'); assert.equal(y + h, 418 - 6); assert.ok(Math.abs(x + w / 2 - 566) < 1);
});

test('narrow windows: with Tsugi\'s 15 pt legs nothing overlaps an 80 pt traffic-light cluster at any width', onMac, () => {
  const lines = [];
  // One window per width (a new window each time), the target at its left edge.
  for (let width = 40; width <= 420; width += 4) lines.push(world([W(1000 + width, [100, 200, width, 300])]), { ...aim(101, 400, 1000 + width) }, clock(width));
  const out = dump(lines), seats = perches(out).filter(e => e.seat);
  let peeks = 0, seated = 0;
  for (const p of seats) {
    if (p.seat.peek) { peeks++; continue; }
    seated++;
    assert.ok(p.seat.x - 15 >= 100 + 80 + 8 - 1e-9, `legs at ${p.seat.x - 15} on a window from 100`);
  }
  assert.ok(peeks > 0 && seated > 0, `${peeks} peeks, ${seated} seated`);
  assert.ok(out.filter(e => e.effect === 'perch-hide').some(e => e.reason === 'narrow'));
  // Unmeasured art keeps the whole box clear (half the box, 48 pt, as the legs).
  assert.equal(seatOf([W(7, [100, 200, 300, 300])], [101, 400]).x, 203, 'the legs keep clear of the cluster on a wide window');
  assert.equal(perches(dump([world([W(7, [100, 200, 300, 300])]), aim(101, 400)], { legs: null }))[0].seat.x, 100 + 80 + 8 + 48);
});

test('sleep: after 10 minutes asleep the character goes and the checks stop; the next frame brings it back; a new turn starts with start', onMac, () => {
  const out = dump([world([wide]), aim(500, 400), clock(700)]);
  assert.deepEqual(out.filter(e => e.effect === 'perch-hide').map(e => [e.time, e.reason]), [[620, 'asleep']]);
  assert.equal(out.at(-1).poll, null);
  const again = dump([world([wide]), aim(500, 400), clock(700), aim(500, 400), clock(701)]);
  assert.equal(perches(again).at(-1).kind, 'arrive');
  const turn = dump([world([wide]), aim(500, 400), clock(40), aim(500, 400), clock(41)]);
  assert.deepEqual(turn.filter(e => e.effect === 'line').map(e => e.moment), ['start', 'start'], 'sleep ends the turn; the new one starts with start, not wake');
});

test('covered and paused seats stop checks after 10 minutes, then a frame brings them back', onMac, () => {
  const cover = [W(8, [150, 150, 1000, 600]), wide];
  const covered = dump([world([wide]), aim(600, 400), clock(1), world(cover),
    ...[2, 300, 600].flatMap(t => [clock(t), world(cover)]), clock(700)]);
  assert.deepEqual(covered.filter(e => e.effect === 'perch-hide').map(e => [e.time, e.reason]), [[1, 'covered'], [601, 'covered']]);
  assert.deepEqual([covered.at(-1).shown, covered.at(-1).poll, covered.at(-1).timers], [false, null, []]);
  const frame = dump([world([wide]), aim(600, 400), clock(1), world(cover), clock(700), world([wide]), aim(600, 400)]);
  assert.deepEqual([perches(frame).at(-1).time, perches(frame).at(-1).kind], [700, 'arrive']);
  const paused = dump([world([wide]), aim(500, 400), clock(1), status('paused'), clock(700)]);
  assert.deepEqual(paused.filter(e => e.effect === 'perch-hide').map(e => [e.time, e.reason]), [[601, 'paused']]);
  assert.deepEqual([paused.at(-1).shown, paused.at(-1).poll, paused.at(-1).timers], [false, null, []]);
  for (const resume of [2, 700]) {
    const unpaused = dump([world([wide]), aim(500, 400), clock(1), status('paused'), clock(resume), aim(500, 400), clock(resume + 21)]);
    const active = perches(unpaused).find(p => p.time === resume);
    assert.deepEqual(active.states.at(-1), 'perch-point-right', `an aim at ${resume} replaces the paused pose in the dump`);
    assert.deepEqual(perches(unpaused).filter(p => p.states.includes('sleep')).map(p => p.time), [resume + 20]);
  }
});

test('budget: the dump\'s key paths are what install animates; a leap animates 3, the sleep loop 2, a parked plan none', onMac, () => {
  const two = [W(9, [300, 300, 600, 300]), wide];
  const out = dump([world(two), aim(600, 400), clock(1), aim(500, 450, 9), clock(40)]);
  const [arrive, leap] = perches(out), sleep = perches(out).find(e => e.states.includes('sleep'));
  assert.deepEqual(arrive.keyPaths, ['position', 'contentsRect', 'opacity']);
  assert.deepEqual(leap.keyPaths, ['position', 'contents', 'contentsRect']);
  assert.deepEqual(sleep.keyPaths, ['contentsRect', 'zs']);
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  assert.match(source, /let animated = Set\(plan\.keyPaths\(cell\)\)[\s\S]*?guard values\.count > 1, animated\.contains\(path \?\? key\)/);
});
