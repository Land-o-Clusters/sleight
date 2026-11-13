import { assertChildStatus } from './fixtures/child-status.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { loadCharacter, resolveCharacterStates, checkBuiltinCharacter, builtinCharactersDirectory, prepareCharacterImport, installCharacter, BUILTIN_CHARACTER_IDS, STAGE_STATES } from '../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../plugins/sleight/lib/hand/character-frame.mjs';
import { createCharacterStageCache } from '../plugins/sleight/lib/hand/character-stage.mjs';
import { fixtureRender } from './fixtures/character-stage-render.mjs';

const source = process.env.CHVIS_BASELINE_SOURCE ?? new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
const mac = process.platform === 'darwin';
let root;
const binaries = new Map();
const placementMutations = {
  'redecode-strip': ['if ready != nil { ready!.use = use; cache[file] = ready; cacheHits += 1 }',
    `if ready != nil { ready!.use = use; cache[file] = ready; cacheHits += 1 }
            if let cached = ready, cacheHits == 1 { bytes -= cached.bytes; cache.removeValue(forKey: file); ready = nil }`],
  'fifth-seat-art': ['let typing = ["type", "scroll", "drag"].contains(reaction)',
    'if reaction == "key" { return "stage-wait" }; let typing = ["type", "scroll", "drag"].contains(reaction)'],
};
const bank = () => root ??= trackTemp(fs.realpathSync(fs.mkdtempSync(join('/private', 'tmp', 'sleight-stage-native-'))));
function build(variant = 'product') {
  if (binaries.has(variant)) return binaries.get(variant);
  let input = source;
  if (variant !== 'product') {
    const [before, after] = placementMutations[variant], text = fs.readFileSync(source, 'utf8');
    assert.equal(text.split(before).length - 1, 1, variant + ' one production mutation site');
    input = join(bank(), variant + '.swift'); fs.writeFileSync(input, text.replace(before, after));
  }
  if (process.env.CHV2C_BROKEN === 'no-priority' && variant === 'product') {
    const text = fs.readFileSync(source, 'utf8');
    const site = 'for name in ["stage-think", "stage-wait", "stage-hang", "stage-stand", "stage-sit"] {';
    assert.ok(text.includes(site), 'priority warm mutation site');
    input = join(bank(), 'no-priority.swift');
    fs.writeFileSync(input, text.replace(site, 'for name in [String]() {'));
  }
  const output = join(bank(), variant);
  const r = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank(), 'modules'), input, '-o', output], { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(r, 0, r.stderr); binaries.set(variant, output); return output;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const b of body) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(data.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, sum]);
}
function png(cw, ch, frames, columns = frames) {
  const w = cw * columns, bytes = Buffer.alloc((w * 4 + 1) * ch);
  for (let col = 0; col < frames; col++) for (let x = 0; x < 60; x++) {
    const offset = 1 + (col * cw + x) * 4; bytes.set([180, 90, 10, 255], offset);
  }
  const h = Buffer.alloc(13); h.writeUInt32BE(w); h.writeUInt32BE(ch, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', h), chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))]);
}
let id = 0;
function fixture({ baseCell = [64, 64] } = {}) {
  const name = `stage-${++id}`, folder = join(bank(), name); fs.mkdirSync(folder, { mode: 0o700 }); fs.mkdirSync(join(folder, 'stage'), { mode: 0o700 });
  const m = { format: 'sleight-character', version: 1, id: name, name: 'Fixture', description: '', author: 'Test', license: 'MIT', sheet: 'sheet.png',
    frame: { w: baseCell[0], h: baseCell[1] }, grid: { cols: 8, rows: 1 }, anchor: { x: 32, y: 60 }, hotspot: { x: 32, y: 32 },
    states: { idle: { row: 0, frames: 1, ms: 100, loop: true } }, stage: { cell: { w: 384, h: 416 }, anchor: { x: 192, y: 392 }, states: {} } };
  const states = ['lie', 'lie-reach', 'lie-peek', 'sleep', 'sit', 'sit-notes', 'wait', 'cheer', 'hang', 'hang-peek', 'climb', 'stand', 'point', 'carry', 'wince', 'handoff', 'paused', 'leap'];
  const strip = png(384, 416, 6);
  for (const state of states) {
    const file = `stage/${state}.png`; fs.writeFileSync(join(folder, file), strip, { mode: 0o600 });
    m.stage.states[`stage-${state}`] = { file, frames: 6, ms: 100, loop: true, next: [] };
  }
  fs.writeFileSync(join(folder, 'sheet.png'), png(...baseCell, 1, 8), { mode: 0o600 });
  fs.writeFileSync(join(folder, 'character.json'), JSON.stringify(m), { mode: 0o600 });
  const pack = loadCharacter(folder), frame = characterFrame(pack, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates });
  return { frame, folder, states: states.map(s => `stage-${s}`) };
}
function run(frames, env = {}) {
  const r = spawnSync(build(), ['--stage-cache-dump'], { encoding: 'utf8', timeout: 90000, maxBuffer: 1 << 24,
    input: frames.map(f => JSON.stringify(f) + '\n').join(''),
    env: { PATH: '/usr/bin:/bin', SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: bank(), CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ...env }, killSignal: 'SIGKILL' });
  assertChildStatus(r, 0, r.stderr); return r.stdout.trim().split('\n').map(JSON.parse);
}

test('native cache lazily decodes 18 strips with LRU eviction below 24 MiB over 100 states', { skip: !mac }, t => {
  const f = fixture(), sequence = Array.from({ length: 100 }, (_, i) => f.states[i % 18]);
  const rows = run([f.frame, ...sequence.flatMap(stageState => [{ stageState }, { stageAwait: true }, { stageState }])]);
  assert.equal(rows[0].loaded, true); assert.equal(rows[0].cacheBytes, 0);
  const draws = rows.filter(r => r.effect === 'stage'); assert.equal(draws.length, 200);
  assert.ok(draws.filter(r => !r.medium).length >= 100);
  assert.ok(rows.every(r => r.cacheBytes <= 24 * 1024 * 1024));
  assert.ok(rows.at(-1).evictions > 0); assert.ok(rows.at(-1).peakBytes > 20 * 1024 * 1024);
  assert.deepEqual(draws.find(r => !r.medium).cell, [384, 416]);
  t.diagnostic(JSON.stringify({ sequenceStates: 100, ...rows.at(-1), maxSelectMs: Math.max(...draws.map(r => r.selectMs)) }));
});

test('missing and slow strips immediately play medium fallback without waiting for decode', { skip: !mac }, () => {
  const f = fixture(); fs.unlinkSync(join(f.folder, 'stage/lie.png'));
  const rows = run([f.frame, { stageState: 'stage-lie' }, { stageAwait: true }, { stageState: 'stage-lie' },
    { stageState: 'stage-point' }, { stageState: 'stage-point' }, { stageAwait: true }, { stageState: 'stage-point' }], { SLEIGHT_CURSOR_STAGE_DECODE_FAULT: 'slow' });
  const draws = rows.filter(r => r.effect === 'stage');
  assert.equal(draws[0].medium, true); assert.equal(draws[0].source, 'perch'); assert.equal(draws[1].medium, true);
  assert.equal(draws[2].medium, true); assert.equal(draws[3].medium, true); assert.equal(draws[4].medium, false);
  assert.ok(draws.every(r => r.selectMs < 40));
});

test('native wire refuses stage traversal and oversized strips before decoding', { skip: !mac }, () => {
  for (const mutate of [frame => { frame.stage.table['stage-lie'].file += '/../lie.png'; }, frame => { frame.stage.table['stage-lie'].cell = [1024, 416]; }]) {
    const f = fixture(); mutate(f.frame);
    const r = spawnSync(build(), ['--stage-cache-dump'], { input: JSON.stringify(f.frame) + '\n', encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assertChildStatus(r, 65);
  }
});

test('successor prefetch decodes the next strip before its first draw', { skip: !mac }, () => {
  const f = fixture(); f.frame.stage.table['stage-lie'].next = ['stage-point'];
  const rows = run([f.frame, { stageState: 'stage-lie' }, { stageAwait: true }, { stageState: 'stage-point' }]);
  const draws = rows.filter(r => r.effect === 'stage');
  assert.equal(draws[0].medium, true); assert.equal(draws[1].medium, false);
  assert.equal(rows.at(-1).decodes, 2);
});

test('replacement cancels an old strip decode before the next character loads', { skip: !mac }, () => {
  const f = fixture(), replacement = { ...f.frame, seq: 1 }; delete replacement.stage;
  const rows = run([f.frame, { stageState: 'stage-lie' }, replacement, { stageState: 'stage-lie' }], { SLEIGHT_CURSOR_STAGE_DECODE_FAULT: 'slow' });
  const characters = rows.filter(r => r.effect === 'character');
  assert.equal(characters.length, 2); assert.equal(characters[1].loaded, true); assert.ok(characters[1].loadMs < 600);
  assert.equal(rows.at(-1).cacheBytes, 0);
});


test('thirteen built-ins and both synthetic Codex versions keep all stage fallbacks at medium', { skip: !mac }, t => {
  const keys = ['lie', 'lie-reach', 'lie-peek', 'sleep', 'sit', 'sit-notes', 'wait', 'cheer', 'hang', 'hang-peek', 'climb', 'stand', 'point', 'carry', 'wince', 'handoff', 'paused', 'leap', 'run', 'startle'];
  for (const id of BUILTIN_CHARACTER_IDS) {
    const pack = checkBuiltinCharacter(id), frame = characterFrame(pack, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates });
    const rows = run([frame, ...keys.map(s => ({ stageState: `stage-${s}` }))], { SLEIGHT_BUILTIN_CHARACTERS: builtinCharactersDirectory() });
    assert.equal(rows[0].loaded, true, id); assert.equal(rows.at(-1).cacheBytes, 0);
    assert.ok(rows.filter(r => r.effect === 'stage').every(r => r.medium), id);
  }
  for (const version of [1, 2]) {
    const source = join(bank(), `pet-source-${version}`); fs.mkdirSync(source, { mode: 0o700 });
    const rows = version === 1 ? 9 : 11, w = 1536, h = rows * 208, raw = Buffer.alloc((w * 4 + 1) * h);
    const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
    for (let row = 0; row < rows; row++) for (let col = 0; col < counts[row]; col++) for (let x = 0; x < 60; x++) {
      raw.set([180, 90, 10, 255], row * 208 * (w * 4 + 1) + 1 + (col * 192 + x) * 4);
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 6;
    const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    fs.writeFileSync(join(source, 'pet.json'), JSON.stringify({ id: `pet-${version}`, displayName: 'Synthetic pet', spriteVersionNumber: version, spritesheetPath: 'spritesheet.png' }), { mode: 0o600 });
    fs.writeFileSync(join(source, 'spritesheet.png'), image, { mode: 0o600 });
    const target = installCharacter(prepareCharacterImport(source), { root: bank() }), pack = loadCharacter(target);
    assert.deepEqual(fs.readFileSync(join(target, 'sheet.png')), image);
    const frame = characterFrame(pack, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates });
    const result = run([frame, ...keys.map(s => ({ stageState: `stage-${s}` }))]);
    assert.equal(result[0].loaded, true, `pet v${version}`); assert.equal(result.at(-1).cacheBytes, 0);
    assert.ok(result.filter(r => r.effect === 'stage').every(r => r.medium));
  }
  t.diagnostic('unchangedPacks=15 mediumFallbackSelections=300 stageDecodes=0');
});

test('native built-in stage paths accept only the private cache and verify each strip hash before decode', { skip: !mac }, async () => {
  const cacheRoot = join(bank(), 'stage-cache'), pack = checkBuiltinCharacter('tsugi');
  const ready = await createCharacterStageCache({ root: cacheRoot, render: fixtureRender }).ensure(pack);
  assert.ok(ready);
  const frame = characterFrame(ready, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates });
  const env = { SLEIGHT_BUILTIN_CHARACTERS: builtinCharactersDirectory(), SLEIGHT_CURSOR_STAGE_ROOT: cacheRoot };
  const sequence = [frame, { stageState: 'stage-lie' }, { stageAwait: true }, { stageState: 'stage-lie' }];
  const good = run(sequence, env);
  assert.equal(good[0].loaded, true); assert.equal(good.findLast(r => r.effect === 'stage').medium, false);
  assert.equal(good.at(-1).decodes, 1);
  const strip = frame.stage.table['stage-lie'].file;
  fs.appendFileSync(strip, 'tampered');
  const bad = run(sequence, env);
  assert.equal(bad[0].loaded, true); assert.equal(bad.at(-1).decodes, 0);
  assert.ok(bad.filter(r => r.effect === 'stage').every(r => r.medium));
  const escaped = structuredClone(frame); escaped.stage.table['stage-lie'].file = join(bank(), 'elsewhere.png');
  const r = spawnSync(build(), ['--stage-cache-dump'], { input: JSON.stringify(escaped) + '\n', encoding: 'utf8', timeout: 10000,
    env: { PATH: '/usr/bin:/bin', SLEIGHT_CURSOR_TEST: '1', ...env }, killSignal: 'SIGKILL' });
  assertChildStatus(r, 65);
});

test('locally rendered anime and toon WebP strips decode every stage state in the native host without a window', { skip: !mac }, async t => {
  const cacheRoot = join(bank(), 'real-stage-cache');
  const cache = createCharacterStageCache({ root: cacheRoot });
  for (const id of ['tsugi', 'dennis']) {
    const ready = await cache.ensure(checkBuiltinCharacter(id)); assert.ok(ready, id);
    const frame = characterFrame(ready, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates });
    const states = Object.keys(ready.stage.states);
    const records = run([frame, ...states.flatMap(stageState => [{ stageState }, { stageAwait: true }, { stageState }])],
      { SLEIGHT_BUILTIN_CHARACTERS: builtinCharactersDirectory(), SLEIGHT_CURSOR_STAGE_ROOT: cacheRoot });
    assert.equal(records[0].loaded, true, id);
    const draws = records.filter(r => r.effect === 'stage');
    assert.equal(draws.length, 42); assert.ok(draws.filter((_, i) => i % 2).every(r => !r.medium), id);
    assert.equal(records.at(-1).failed, 0); assert.ok(records.at(-1).decodes >= 21);
    t.diagnostic(`${id}: 21/21 generated WebP stage states decoded`);
  }
});

function capacityFixture(cw, ch, frames, successors) {
  const f = fixture(), table = f.frame.stage.table, names = ['stage-lie', ...successors];
  for (const name of Object.keys(table)) {
    if (!names.includes(name)) { table[name] = { fallback: table[name].fallback, art: table[name].art }; continue; }
    Object.assign(table[name], { cell: [cw, ch], anchor: [cw / 2, ch / 2], hotspot: [cw / 2, ch / 2], frames,
      ms: Array(frames).fill(100), next: name === 'stage-lie' ? successors : [] });
    fs.writeFileSync(table[name].file, png(cw, ch, frames), { mode: 0o600 });
  }
  return f;
}

for (const [label, cw, ch, frames, successors, expected] of [
  ['two 16 MiB strips', 512, 1024, 8, ['stage-sit'], 1],
  ['honest 3x pack with three successors', 576, 624, 6, ['stage-sit', 'stage-point', 'stage-hang'], 2],
]) test(`prefetch never thrashes with ${label} over 21 selections`, { skip: !mac }, t => {
  const f = capacityFixture(cw, ch, frames, successors);
  const rows = run([f.frame, ...Array.from({ length: 21 }, () => [{ stageState: 'stage-lie' }, { stageAwait: true }]).flat()]);
  const last = rows.at(-1); assert.equal(last.decodes, expected); assert.equal(last.attempts, expected); assert.equal(last.evictions, 0);
  assert.equal(last.skipped, successors.length - expected + 1);
  assert.ok(rows.every(r => r.cacheBytes <= 24 * 1024 ** 2));
  assert.ok(rows.filter(r => r.effect === 'stage').slice(1).every(r => !r.medium));
  t.diagnostic(JSON.stringify({ fixture: label, selections: 21, ...last }));
  // A skipped successor becomes the foreground request, evicting only when the state changes.
  const switched = run([f.frame, { stageState: 'stage-lie' }, { stageAwait: true },
    { stageState: successors.at(-1) }, { stageAwait: true }, { stageState: successors.at(-1) }]);
  assert.equal(switched.findLast(r => r.effect === 'stage').medium, false); assert.ok(switched.at(-1).evictions >= 1);
});

test('ST3R dump selections distinguish rapid requests from real foreground alternation', { skip: !mac }, t => {
  const cases = [
    { label: 'rapid two-strip alternation', f: capacityFixture(512, 1024, 8, ['stage-sit']), count: 200, awaitEach: false,
      states: ['stage-lie', 'stage-sit'], expected: 1, evictions: 0 },
    { label: 'awaited two-strip alternation', f: capacityFixture(512, 1024, 8, ['stage-sit']), count: 20, awaitEach: true,
      states: ['stage-lie', 'stage-sit'], expected: 20, evictions: 19 },
    { label: 'awaited three-strip cycle', f: capacityFixture(576, 624, 6, ['stage-sit', 'stage-point']), count: 21, awaitEach: true,
      states: ['stage-lie', 'stage-sit', 'stage-point'], expected: 21, evictions: 19 },
  ];
  for (const c of cases) {
    const rows = run([c.f.frame, ...Array.from({ length: c.count }, (_, i) => [
      { stageState: c.states[i % c.states.length] }, ...c.awaitEach ? [{ stageAwait: true }] : [],
    ]).flat(), { stageAwait: true }]);
    const last = rows.at(-1);
    assert.equal(last.decodes, c.expected); assert.equal(last.evictions, c.evictions);
    assert.ok(last.peakBytes <= 24 * 1024 ** 2);
    t.diagnostic(JSON.stringify({ fixture: c.label, selections: c.count, decodesPerSelection: last.decodes / c.count, ...last }));
  }
});

for (const fault of ['timeout-once', 'child-once']) test(`transient ${fault} backs off then retries without reloading`, { skip: !mac }, t => {
  const f = fixture();
  const rows = run([f.frame, { stageState: 'stage-lie' }, { stageAwait: true },
    ...Array.from({ length: 20 }, () => [{ stageState: 'stage-lie' }, { stageAwait: true }]).flat(),
    { stageRetryAdvance: 1.01 }, { stageState: 'stage-lie' }, { stageAwait: true }, { stageState: 'stage-lie' }],
  { SLEIGHT_CURSOR_STAGE_DECODE_FAULT: fault });
  const waiting = rows.filter(r => r.effect === 'ready');
  assert.ok(waiting.slice(0, 21).every(r => r.attempts === 1 && r.failed === 0 && r.retrying === 1));
  assert.equal(rows.at(-1).attempts, 2); assert.equal(rows.at(-1).decodes, 1);
  assert.equal(rows.findLast(r => r.effect === 'stage').medium, false); assert.equal(rows.at(-1).retrying, 0);
  t.diagnostic(JSON.stringify({ fault, selections: 23, beforeRetry: waiting[20], afterRetry: rows.at(-1) }));
});

for (const kind of ['trailing', 'animated', 'duplicate-header', 'corrupt', 'symlink', 'symlink-directory']) test(`native stage decode refuses ${kind} strip and remembers the failure`, { skip: !mac }, () => {
  const f = fixture(), path = f.frame.stage.table['stage-lie'].file, original = fs.readFileSync(path);
  if (kind === 'trailing') fs.writeFileSync(path, Buffer.concat([original, Buffer.from('extra')]));
  if (kind === 'animated') fs.writeFileSync(path, Buffer.concat([original.subarray(0, 33), chunk('acTL', Buffer.alloc(8)), original.subarray(33)]));
  if (kind === 'duplicate-header') fs.writeFileSync(path, Buffer.concat([original.subarray(0, 33), original.subarray(8, 33), original.subarray(33)]));
  if (kind === 'corrupt') {
    const ihdr = original.subarray(8, 33);
    fs.writeFileSync(path, Buffer.concat([original.subarray(0, 8), ihdr, chunk('IDAT', Buffer.from('corrupt zlib')), chunk('IEND', Buffer.alloc(0))]));
  }
  if (kind === 'symlink') { fs.unlinkSync(path); fs.symlinkSync(join(f.folder, 'stage/sit.png'), path); }
  if (kind === 'symlink-directory') {
    fs.renameSync(join(f.folder, 'stage'), join(f.folder, 'elsewhere'));
    fs.symlinkSync(join(f.folder, 'elsewhere'), join(f.folder, 'stage'));
  }
  const rows = run([f.frame, ...Array.from({ length: 5 }, () => [{ stageState: 'stage-lie' }, { stageAwait: true }]).flat()]);
  assert.equal(rows[0].loaded, true); assert.equal(rows.at(-1).failed, 1);
  assert.equal(rows.at(-1).attempts, 1); assert.equal(rows.at(-1).decodes, 0);
  assert.ok(rows.filter(r => r.effect === 'stage').every(r => r.medium));
});

test('actual sandboxed import check decodes all stage strips, including shared files, and catches corrupt pixels', { skip: !mac }, async () => {
  const { withSharedCharacter } = await import('../plugins/sleight/lib/hand/character-sharing.mjs');
  const { checkCharacterInHost } = await import('../plugins/sleight/lib/direct-browser/host.mjs');
  const f = fixture(), pack = loadCharacter(f.folder);
  const manifest = JSON.parse(pack.files.get('character.json'));
  manifest.stage.states['stage-think'] = manifest.stage.states['stage-lie'];
  pack.files.set('character.json', Buffer.from(JSON.stringify(manifest)));
  let calls = 0;
  const options = { hostCheck: async (frame, root) => {
    calls++; return checkCharacterInHost(build(), frame, { root, timeoutMs: 75000 });
  } };
  const checked = await withSharedCharacter(pack.files, options);
  assert.equal(checked.stage.states['stage-think'].own, true); assert.equal(calls, 1);
  // Corrupt a strip late in the sorted state table, after a valid header and container.
  await assert.rejects(withSharedCharacter(pack.files, { hostCheck: (frame, root) => {
    const path = frame.stage.table['stage-wince'].file, original = fs.readFileSync(path);
    fs.writeFileSync(path, Buffer.concat([original.subarray(0, 33), chunk('IDAT', Buffer.from('corrupt zlib')), chunk('IEND', Buffer.alloc(0))]));
    return checkCharacterInHost(build(), frame, { root, timeoutMs: 75000 });
  } }), /decode|child/);
});


test('placement uses the lazy stage cache, matching strip cells and the art seat line', { skip: !mac }, t => {
  const f = fixture({ baseCell: [192, 208] });
  const frame = { ...f.frame, size: 'stage', perch: { anchor: [96, 150], table: Object.fromEntries(
    ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait', 'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused']
      .map(k => [k, f.frame.table.idle])) } };
  const nonce = frame.nonce;
  const world = { dumpWorld: { windows: [{ id: 7, pid: 42, frame: [200, 500, 1000, 350] }],
    displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
    person: [1500, 800, 100, 100], pointer: [1750, 1150], inputAge: 20, pointerAway: 10, cards: [] } };
  const lines = [frame, { dumpLoadArt: true }, world,
    { hand: 'aim', nonce, seq: 2, kind: 'click', pid: 42, windowId: 7, at: [700, 750] },
    { dumpAwaitArt: true }, { dumpClock: 1 }];
  const r = spawnSync(build(), ['--stage-dump'], { input: lines.map(x => JSON.stringify(x)).join('\n') + '\n',
    encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', SLEIGHT_CURSOR_TEST: '1',
      SLEIGHT_CURSOR_CHARACTERS_ROOT: bank(), CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }, killSignal: 'SIGKILL' });
  assertChildStatus(r, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').map(JSON.parse), draws = rows.filter(r => r.effect === 'stage');
  assert.equal(draws[0].fallback, true); assert.ok(draws[0].height <= 184);
  const full = draws.at(-1);
  assert.equal(full.fallback, false); assert.equal(full.rung, 'stage'); assert.equal(full.artSource, 'stage-lie');
  assert.deepEqual(full.artCell, [384, 416]); assert.ok(Math.abs(full.seatLine - 500) < 1e-6);
  assert.ok(Math.abs(full.rects[0][2] - 383 / (384 * 6)) < 1e-9);
  assert.ok(rows.find(r => r.effect === 'stage-ready').cacheBytes <= 24 * 1024 ** 2);
  t.diagnostic(JSON.stringify({ coldHeight: draws[0].height, readyHeight: full.height, seatLine: full.seatLine, artSource: full.artSource }));
});

function placementSequence(blockTop, variant = 'product') {
  const f = fixture({ baseCell: [192, 208] });
  const frame = { ...f.frame, size: 'stage', perch: { anchor: [96, 150], table: Object.fromEntries(
    ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait', 'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused']
      .map(k => [k, f.frame.table.idle])) } };
  const world = cards => ({ dumpWorld: { windows: [{ id: 7, pid: 42, frame: [200, 500, 1000, 350] }],
    displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
    person: [1500, 800, 100, 100], pointer: [1750, 1150], inputAge: 20, pointerAway: 10, cards } });
  const lines = [frame, { dumpLoadArt: true }];
  const kinds = ['click', 'type', 'key', 'scroll', 'drag', 'double', 'right'];
  for (let i = 0; i < 60; i++) {
    lines.push(world(blockTop && i % 3 === 0 ? [[200, 30, 1000, 500]] : []),
      { hand: 'act', nonce: frame.nonce, seq: i + 2, kind: kinds[i % kinds.length], pid: 42, windowId: 7,
        at: [700, 750], path: [[700, 750]], delayMs: 0, beats: 1 });
    for (let tick = 0; tick < 4; tick++) lines.push({ dumpAwaitArt: true }, { dumpClock: i + (tick + 1) * 0.2 });
  }
  lines.push({ dumpAwaitArt: true });
  const r = spawnSync(build(variant), ['--stage-dump'], { input: lines.map(x => JSON.stringify(x)).join('\n') + '\n',
    encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 ** 2, env: { PATH: '/usr/bin:/bin', SLEIGHT_CURSOR_TEST: '1',
      SLEIGHT_CURSOR_CHARACTERS_ROOT: bank(), CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }, killSignal: 'SIGKILL' });
  assertChildStatus(r, 0, r.stderr);
  return r.stdout.trim().split('\n').map(JSON.parse);
}
function assertPlacementDecodes(rows, blockTop) {
  const last = rows.findLast(r => 'decodes' in r);
  assert.ok(last, 'placement must report cache counters');
  const draws = rows.filter(r => r.effect === 'stage');
  const used = [...new Set(draws.filter(r => !r.fallback).map(r => r.artSource))];
  assert.ok(used.length >= 2, JSON.stringify(used));
  if (blockTop) assert.ok(last.decodes <= 6, JSON.stringify({ used, ...last }));
  else {
    const allowed = ['stage-lie-reach', 'stage-lie-peek', 'stage-lie', 'stage-hang'];
    assert.ok(used.every(state => allowed.includes(state)), 'unexpected seat art: ' + JSON.stringify(used));
    assert.equal(last.decodes, used.length, 'each used strip must decode exactly once');
    assert.equal(last.failed, 0, 'placement strip decodes must succeed');
    assert.equal(last.attempts, last.decodes, 'placement must not retry strip decodes');
  }
  assert.equal(last.evictions, 0);
  assert.ok(draws.every(r => ['edge-lie', 'corner-hang', 'edge-hang', 'floor-stand'].includes(r.seat.kind)));
  return { used, last };
}
for (const blockTop of [false, true]) test(`placement requests only the chosen seat over 60 actions, blocked top=${blockTop}`, { skip: !mac }, t => {
  const { used, last } = assertPlacementDecodes(placementSequence(blockTop), blockTop);
  t.diagnostic(JSON.stringify({ actions: 60, ticks: 240, blockTop, used, decodesPerAction: last.decodes / 60, ...last }));
});

for (const variant of Object.keys(placementMutations)) test('in-suite placement mutant rejects ' + variant, { skip: !mac }, t => {
  const rows = placementSequence(false, variant), last = rows.findLast(r => 'decodes' in r);
  const used = [...new Set(rows.filter(r => r.effect === 'stage' && !r.fallback).map(r => r.artSource))];
  assert.equal(last.failed, 0); assert.equal(last.evictions, 0); assert.equal(last.attempts, last.decodes);
  if (variant === 'redecode-strip') assert.ok(last.decodes > used.length, 'mutant must actually re-decode a strip');
  else { assert.equal(used.length, 5); assert.ok(used.includes('stage-wait')); assert.equal(last.decodes, used.length); }
  assert.throws(() => assertPlacementDecodes(rows, false), variant === 'redecode-strip'
    ? /each used strip must decode exactly once/ : /unexpected seat art/);
  t.diagnostic(JSON.stringify({ variant, used, ...last }));
});

test('decoder-backed seated anchor uses corner-hang beside the person target', { skip: !mac }, () => {
  const f = fixture({ baseCell: [192, 208] });
  for (const entry of Object.values(f.frame.stage.table)) if (entry.file) entry.anchor = [192, 300];
  const frame = { ...f.frame, size: 'stage', perch: { anchor: [96, 150], table: Object.fromEntries(
    ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait', 'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused']
      .map(k => [k, f.frame.table.idle])) } };
  const target = [200, 500, 1000, 350];
  const lines = [frame, { dumpLoadArt: true }, { dumpWorld: { windows: [{ id: 7, pid: 42, frame: target }],
    displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
    person: target, pointer: [1750, 1150], inputAge: 20, pointerAway: 10, cards: [] } },
    { hand: 'aim', nonce: frame.nonce, seq: 2, kind: 'click', pid: 42, windowId: 7, at: [700, 750] },
    { dumpAwaitArt: true }, { dumpClock: 1 }];
  const r = spawnSync(build(), ['--stage-dump'], { input: lines.map(x => JSON.stringify(x)).join('\n') + '\n',
    encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin', SLEIGHT_CURSOR_TEST: '1',
      SLEIGHT_CURSOR_CHARACTERS_ROOT: bank(), CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }, killSignal: 'SIGKILL' });
  assertChildStatus(r, 0, r.stderr);
  const rows = r.stdout.trim().split('\n').map(JSON.parse), draws = rows.filter(r => r.effect === 'stage');
  assert.equal(draws.at(-1).fallback, false);
  assert.equal(draws.at(-1).artSource, 'stage-hang');
  assert.ok(draws.every(r => r.seat.kind === 'corner-hang' && r.box[0] >= target[0] + target[2]));
  assert.equal(rows.find(r => r.effect === 'stage-ready').decodes, 1);
});

test('CR2A real cache completion preserves cold and delayed authored one-shots', { skip: !mac }, t => {
  for (const fault of ['', 'slow']) {
    const f = fixture(), manifest = JSON.parse(fs.readFileSync(join(f.folder, 'character.json')));
    manifest.stage.states['stage-wince'].loop = false;
    manifest.stage.states['stage-wince'].ms = [100, 100, 100, 100, 80, 80];
    fs.writeFileSync(join(f.folder, 'character.json'), JSON.stringify(manifest));
    const frame = { ...characterFrame(loadCharacter(f.folder), { nonce: 'a'.repeat(64), seq: 1, resolve: resolveCharacterStates }), size: 'stage', stageAttention: false };
    const input = [frame, { dumpWorld: { windows: [{ id: 7, pid: 42, frame: [200, 500, 900, 350] }],
      displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }], person: [1450, 700, 300, 300],
      pointer: [1750, 1150], inputAge: 20, pointerAway: 10, cards: [] } }, { dumpLoadArt: true },
      { hand: 'status', nonce: frame.nonce, seq: 2, state: 'error', pid: 42, windowId: 7, at: [650, 700] },
      { dumpAwaitArt: true }, { dumpClock: 0.2 }, { dumpClock: 0.4 }, { dumpClock: 0.759 }, { dumpClock: 0.76 }];
    const result = spawnSync(build(), ['--stage-dump'], { encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL',
      input: input.map(row => JSON.stringify(row)).join('\n') + '\n',
      env: { PATH: '/usr/bin:/bin', SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: bank(),
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, SLEIGHT_CURSOR_STAGE_DECODE_FAULT: fault } });
    assertChildStatus(result, 0, result.stderr);
    const draws = result.stdout.trim().split('\n').map(JSON.parse).filter(r => r.effect === 'stage');
    const wince = draws.filter(r => r.artSource === 'stage-wince');
    assert.equal(wince.length, 1, fault); assert.equal(wince[0].time, 0.2);
    assert.ok(wince[0].cells.some(c => c[4] === 5)); assert.ok(Math.abs(wince[0].duration - 0.56) < 1e-9);
    assert.notEqual(draws.at(-1).artSource, 'stage-wince'); assert.equal(draws.at(-1).time, 0.76);
    t.diagnostic(`decodeFault=${fault || 'none'} authoredMs=560 readyAt=200 lastHoldEndsAt=760 windows=0`);
  }
});

test('CR2A a failed real strip decode completes the fallback response', { skip: !mac }, () => {
  const f = fixture(), frame = { ...f.frame, size: 'stage', stageAttention: false };
  fs.unlinkSync(join(f.folder, 'stage/wince.png'));
  const input = [frame, { dumpWorld: { windows: [{ id: 7, pid: 42, frame: [200, 500, 900, 350] }],
    displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }], person: [1450, 700, 300, 300],
    pointer: [1750, 1150], inputAge: 20, pointerAway: 10, cards: [] } }, { dumpLoadArt: true },
    { hand: 'status', nonce: frame.nonce, seq: 1, state: 'error', pid: 42, windowId: 7, at: [650, 700] },
    { dumpAwaitArt: true }, { dumpClock: 0.2 }, { dumpClock: 0.4 }, { dumpClock: 6 }];
  const result = spawnSync(build(), ['--stage-dump'], { encoding: 'utf8', timeout: 90000, killSignal: 'SIGKILL',
    input: input.map(row => JSON.stringify(row)).join('\n') + '\n',
    env: { PATH: '/usr/bin:/bin', SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: bank(), CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } });
  assertChildStatus(result, 0, result.stderr);
  const draws = result.stdout.trim().split('\n').map(JSON.parse).filter(r => r.effect === 'stage');
  assert.ok(draws.some(r => r.artSource === 'error'));
  assert.notEqual(draws.at(-1).artSource, 'error');
});

function warmFixture() {
  const f = fixture(), manifest = JSON.parse(fs.readFileSync(join(f.folder, 'character.json')));
  manifest.stage.cell = { w: 192, h: 208 }; manifest.stage.anchor = { x: 96, y: 196 };
  const strip = png(192, 208, 6);
  for (const name of Object.keys(STAGE_STATES)) {
    const file = `stage/${name.slice(6)}.png`;
    fs.writeFileSync(join(f.folder, file), strip, { mode: 0o600 });
    manifest.stage.states[name] = { file, frames: 6, ms: 100, loop: true, next: [] };
  }
  fs.writeFileSync(join(f.folder, 'character.json'), JSON.stringify(manifest), { mode: 0o600 });
  return { ...f, frame: { ...characterFrame(loadCharacter(f.folder), { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates }), size: 'stage' } };
}
test('CH-9 character load warms all 21 strips when they fit the unchanged cache', { skip: !mac }, t => {
  const f = warmFixture();
  const rows = run([f.frame, { stageAwait: true }, ...Object.keys(STAGE_STATES).map(stageState => ({ stageState }))]);
  assert.equal(rows.at(-1).decodes, 21); assert.equal(rows.at(-1).residentStrips, 21);
  assert.ok(rows.filter(r => r.effect === 'stage').every(r => !r.medium));
  assert.ok(rows.every(r => r.cacheBytes <= 24 * 1024 ** 2));
  t.diagnostic(JSON.stringify(rows.at(-1)));
});
test('CH-9 warm loading preserves missing-strip fallback and never exceeds 24 MiB', { skip: !mac }, () => {
  const f = warmFixture(); fs.unlinkSync(join(f.folder, 'stage/lie.png'));
  const rows = run([f.frame, { stageAwait: true }, { stageState: 'stage-lie' }, { stageState: 'stage-hang' }]);
  assert.equal(rows.at(-1).decodes, 20); assert.equal(rows.at(-1).failed, 1);
  const draws = rows.filter(r => r.effect === 'stage');
  assert.equal(draws[0].medium, true); assert.equal(draws[1].medium, false);
  assert.ok(rows.every(r => r.cacheBytes <= 24 * 1024 ** 2));
});

const warmPriority = ['stage-think', 'stage-wait', 'stage-hang', 'stage-stand', 'stage-sit'];
function priorityFixture() {
  const f = warmFixture(), manifest = JSON.parse(fs.readFileSync(join(f.folder, 'character.json')));
  manifest.stage.cell = { w: 384, h: 416 }; manifest.stage.anchor = { x: 192, y: 392 };
  for (const entry of Object.values(manifest.stage.states)) fs.writeFileSync(join(f.folder, entry.file), png(384, 416, 6), { mode: 0o600 });
  fs.writeFileSync(join(f.folder, 'character.json'), JSON.stringify(manifest), { mode: 0o600 });
  return { ...f, frame: { ...characterFrame(loadCharacter(f.folder), { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates }), size: 'stage' } };
}
test('CHV2-C oversized packs warm the five priority strips before their first selection', { skip: !mac }, t => {
  const f = priorityFixture();
  const rows = run([f.frame, { stageAwait: true }, ...warmPriority.map(stageState => ({ stageState }))]);
  const ready = rows.find(row => row.effect === 'ready'), draws = rows.filter(row => row.effect === 'stage');
  assert.equal(ready.decodes, 5); assert.equal(ready.residentStrips, 5); assert.equal(ready.evictions, 0);
  assert.equal(ready.cacheBytes, 384 * 416 * 6 * 4 * 5);
  assert.equal(draws[0].source, 'stage-think');
  assert.ok(draws.every(row => !row.medium && row.source.startsWith('stage-')));
  assert.ok(rows.every(row => row.cacheBytes <= 24 * 1024 ** 2));
  t.diagnostic(JSON.stringify({ ready, firstSource: draws[0].source, fallbackDraws: draws.filter(row => row.medium).length }));
});
test('CHV2-C a missing priority strip falls back while the remaining four stay warmed', { skip: !mac }, () => {
  const f = priorityFixture(); fs.unlinkSync(join(f.folder, 'stage/think.png'));
  const rows = run([f.frame, { stageAwait: true }, { stageState: 'stage-think' }, { stageState: 'stage-wait' }]);
  const ready = rows.find(row => row.effect === 'ready'), draws = rows.filter(row => row.effect === 'stage');
  assert.equal(ready.decodes, 4); assert.equal(ready.failed, 1); assert.equal(ready.evictions, 0);
  assert.equal(draws[0].medium, true); assert.equal(draws[1].medium, false);
  assert.ok(rows.every(row => row.cacheBytes <= 24 * 1024 ** 2));
});
test('CHV2-C shared priority files decode once and leave room for the other priority strips', { skip: !mac }, () => {
  const f = priorityFixture(); f.frame.stage.table['stage-wait'].file = f.frame.stage.table['stage-think'].file;
  const rows = run([f.frame, { stageAwait: true }, ...warmPriority.map(stageState => ({ stageState }))]);
  const ready = rows.find(row => row.effect === 'ready');
  assert.equal(ready.decodes, 4); assert.equal(ready.residentStrips, 4); assert.equal(ready.evictions, 0);
  assert.ok(rows.filter(row => row.effect === 'stage').every(row => !row.medium));
});
test('CHV2-C priority admission skips strips that do not fit and still warms a smaller later strip', { skip: !mac }, () => {
  const f = priorityFixture(), table = f.frame.stage.table;
  for (const name of Object.keys(table)) {
    if (!warmPriority.includes(name)) { table[name] = { fallback: table[name].fallback, art: table[name].art }; continue; }
    Object.assign(table[name], { cell: [512,1024], anchor: [256,512], hotspot: [256,512], frames: 8, ms: Array(8).fill(100) });
    fs.writeFileSync(table[name].file, png(512, 1024, 8), { mode: 0o600 });
  }
  const sit = table['stage-sit'];
  Object.assign(sit, { cell: [192,208], anchor: [96,196], hotspot: [96,104], frames: 6, ms: Array(6).fill(100) });
  fs.writeFileSync(sit.file, png(192, 208, 6), { mode: 0o600 });
  const rows = run([f.frame, { stageAwait: true }, { stageState: 'stage-think' }, { stageState: 'stage-sit' }]);
  const ready = rows.find(row => row.effect === 'ready');
  assert.equal(ready.decodes, 2); assert.equal(ready.residentStrips, 2); assert.equal(ready.evictions, 0);
  assert.equal(ready.cacheBytes, 512 * 1024 * 8 * 4 + 192 * 208 * 6 * 4);
  assert.ok(rows.filter(row => row.effect === 'stage').every(row => !row.medium));
  assert.ok(rows.every(row => row.cacheBytes <= 24 * 1024 ** 2));
});
