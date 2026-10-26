// VC7, the agent cursor's live-check harness: every pure part, the dry runs, and the scripted frames through the real host's
// --ring-plan-dump (no window). Nothing here opens an app, shows a panel or captures the screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';
import { cursorColoured, colourRule, handColoured, compareFrames, classify } from '../bench/hand/pixels.mjs';
import { crc32, encodePng, syntheticSheet, cellInk, characterWire, installSyntheticCharacter, characterEnv, CELL, SYNTHETIC_ID } from '../bench/hand/synthetic-character.mjs';
import { cursorWire, autoSequence, playSequence, KINDS } from '../bench/hand/cursor-sequence.mjs';
import { ownerBack, createOwnerWatch, ownerWords } from '../bench/hand/owner-watch.mjs';
import { parseWatch, callSightings, timingStats, engineDecision, pickElements, sequenceCalls, COORDINATE } from '../bench/hand/engine-cursor.mjs';
import { phases, phaseFigures, costVerdict, rssBudget, parseArgs as costArgs, SETTLE_MS } from '../bench/hand/cursor-cost.mjs';
import { recordPlan, panelWindow, parseArgs as recordArgs } from '../bench/hand/cursor-record.mjs';
import { perTask, speedVerdict, noiseLimitMs, runSide, runCostPass, compareSides, parseArgs as passArgs, resumeKey, dryRunPlan as passPlan } from '../bench/hand/cost-pass.mjs';
import { hostStyle } from '../bench/hand/cost-sampler.mjs';
import { nightSteps, estimate, outcome, childEnv, strays, resultLine, summaryMarkdown, parseArgs as nightArgs, TARGET_MIN } from '../bench/hand/vc7-night.mjs';
import { hostArgs, commonArgs, liveRefusal, compileArgs, playRect } from '../bench/hand/vc7-live.mjs';
import { handWire, runCaptureTest } from '../bench/hand/h5-capture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const over = (rgb, alpha, page = [255, 255, 255]) => rgb.map((c, i) => Math.round(c * alpha + page[i] * (1 - alpha)));
const nonce = 'b'.repeat(64);

test('cursor paint: the ring\'s warm and cool seams count from 0.3 opacity; text, grey antialiasing and the ink do not', () => {
  for (const alpha of [0.3, 0.6, 1]) {
    assert.ok(cursorColoured(...over([255, 122, 61], alpha)), `warm at ${alpha}`);
    assert.ok(cursorColoured(...over([91, 141, 255], alpha)), `cool at ${alpha}`);
    assert.ok(cursorColoured(...over([214, 38, 196], alpha)), `sprite magenta at ${alpha}`);
  }
  for (const rgb of [[20, 20, 20], [128, 128, 130], [255, 255, 255], over([11, 13, 20], 0.55), [239, 233, 220]]) assert.equal(cursorColoured(...rgb), false, String(rgb));
  assert.equal(colourRule('glove'), handColoured);
  for (const style of ['ring', 'seam', 'sprite']) assert.equal(colourRule(style), cursorColoured);
  assert.throws(() => colourRule('pet'), /unknown cursor style/);
  const page = { width: 4, height: 1, data: new Uint8Array(16).fill(255) };
  const ring = { ...page, data: Uint8Array.from(page.data) };
  ring.data.set([...over([91, 141, 255], 0.5), 255], 4);
  const c = compareFrames(page, ring, { coloured: cursorColoured });
  assert.deepEqual([c.differing, c.handLike], [1, 1]);
  assert.equal(classify(c, { noise: 3, minHand: 1 }), 'shown');
});

test('synthetic character: a valid PNG the host\'s ink rules accept, a frame with the host\'s exact keys, files at 0700 and 0600', t => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const sheet = syntheticSheet();
  assert.deepEqual([sheet.width, sheet.height], [CELL.width * 8, CELL.height]);
  for (const cell of cellInk(sheet)) {
    assert.ok(cell.visible >= 50, 'at least 50 visible pixels');
    assert.ok(cell.opaque < cell.total * 0.95, 'under 95% opaque');
    assert.equal(cell.green, 0, 'no chroma fringe');
  }
  const png = encodePng(sheet.width, sheet.height, sheet.data);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]], [1024, 128, 8, 6]);
  assert.equal(png.readUInt32BE(29), crc32(png.subarray(12, 29)), 'IHDR CRC');
  const idatLength = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  assert.equal(raw.length, (1024 * 4 + 1) * 128);
  assert.deepEqual([...raw.subarray(1 + 64 * 4 * 0, 5)], [...sheet.data.subarray(0, 4)]);
  assert.throws(() => encodePng(2, 2, new Uint8Array(3)), /width \* height \* 4/);

  const frame = characterWire({ sheet: '/private/tmp/x/vc7-synthetic/sheet.png' }, { nonce, seq: 4 });
  assert.deepEqual(Object.keys(frame).sort(), ['cell', 'extra', 'hand', 'id', 'nonce', 'seq', 'sheet', 'table']);
  assert.deepEqual(Object.keys(frame.table.idle).sort(), ['flip', 'frames', 'hotspot', 'loop', 'ms', 'row', 'scale', 'sheet']);
  assert.equal(frame.id, SYNTHETIC_ID); assert.equal(frame.extra, null); assert.equal(frame.seq, 4);
  assert.throws(() => characterWire({ sheet: 'relative.png' }, { nonce, seq: 0 }), /absolute/);
  assert.throws(() => characterWire({ sheet: '/a.png' }, { nonce: 'x', seq: 0 }), /nonce/);
});

// /private/tmp is macOS's, as the host's test override requires.
test('the synthetic character installs at 0700 and 0600 under /private/tmp', { skip: process.platform !== 'darwin' && 'macOS only' }, t => {
  const installed = installSyntheticCharacter();
  t.after(() => rmSync(installed.root, { recursive: true, force: true }));
  assert.ok(installed.root.startsWith('/private/tmp/sleight-vc7-characters-'));
  assert.equal(statSync(installed.root).mode & 0o777, 0o700);
  assert.equal(statSync(installed.folder).mode & 0o777, 0o700);
  assert.equal(statSync(installed.sheet).mode & 0o777, 0o600);
  assert.equal(installed.sheet, join(installed.root, SYNTHETIC_ID, 'sheet.png'));
  assert.deepEqual(characterEnv(installed.root), { SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: installed.root });
});

const HOST_KEYS = {
  act: [['hand', 'nonce', 'seq', 'kind', 'pid', 'windowId', 'at', 'path', 'delayMs', 'beats'], ['label', 'rect', 'caretX']],
  aim: [['hand', 'nonce', 'seq', 'kind', 'pid', 'windowId', 'at'], ['rect', 'holdMs', 'label']],
  status: [['hand', 'nonce', 'seq', 'state', 'pid', 'windowId'], ['at', 'ok']],
  hide: [['hand', 'nonce'], []],
  character: [['hand', 'nonce', 'seq', 'id', 'sheet', 'extra', 'cell', 'table'], []],
};
function hostAccepts(frame) {
  const [required, optional] = HOST_KEYS[frame.hand];
  const keys = Object.keys(frame);
  return required.every(k => keys.includes(k)) && keys.every(k => required.includes(k) || optional.includes(k));
}

test('the scripted sequence: 30 actions in order with aims 250 ms ahead, statuses, and frames with only the host\'s keys', async () => {
  const rect = { x: 100, y: 100, width: 600, height: 400 };
  const { steps, lengthMs } = autoSequence({ pid: 42, windowId: 7, rect, count: 30, spacingMs: 1300 });
  assert.equal(steps.filter(s => s.type === 'act').length, 30);
  assert.equal(steps.filter(s => s.type === 'aim').length, 30);
  assert.deepEqual(steps.filter(s => s.type === 'status').map(s => s.args.state), [...Array(4).fill('thinking'), 'done']);
  assert.equal(lengthMs, 29 * 1300 + 900);
  assert.deepEqual([...new Set(steps.filter(s => s.type === 'act').map(s => s.args.kind))].sort(), [...KINDS].sort());
  for (const s of steps.filter(s => s.type !== 'status')) {
    assert.ok(s.args.at[0] >= rect.x && s.args.at[0] <= rect.x + rect.width && s.args.at[1] >= rect.y && s.args.at[1] <= rect.y + rect.height);
  }
  const wire = cursorWire(nonce), lines = [];
  let clock = 0;
  const written = await playSequence({ steps }, { wire, write: line => lines.push(line), sleep: async ms => { clock += ms; }, now: () => clock });
  assert.equal(written.length, steps.length);
  const frames = lines.map(l => JSON.parse(l));
  assert.ok(frames.every(hostAccepts), 'every frame has exactly the host\'s keys');
  assert.deepEqual(frames.map(f => f.seq), frames.map((_, i) => i), 'one increasing seq');
  assert.ok(frames.filter(f => f.caretX !== undefined).every(f => ['type', 'key'].includes(f.kind)));
  assert.ok(frames.filter(f => f.ok !== undefined).every(f => f.state === 'done'));
  assert.ok(Math.abs(clock - steps.at(-1).atMs) < 1, 'the clock reached the last step');
  assert.ok(hostAccepts(JSON.parse(wire.character({ sheet: '/private/tmp/a/b.png' }))));
  assert.ok(hostAccepts(JSON.parse(wire.hide())));
  let stop = false;
  const partial = await playSequence({ steps }, { wire: cursorWire(nonce), write: () => { stop = true; }, sleep: async () => {}, stopped: () => stop });
  assert.equal(partial.length, 1);
  assert.throws(() => autoSequence({ pid: 0, windowId: 1, rect }), /pid/);
  assert.throws(() => autoSequence({ pid: 1, windowId: 1, rect: { ...rect, width: 50 } }), /120 by 120/);
});

test('H5 with a style: the host starts in that style, the sprite gets its character frame first, sharing the acts\' seq', async () => {
  const wire = handWire(nonce);
  const first = JSON.parse(wire.character({ sheet: '/private/tmp/r/vc7-synthetic/sheet.png' }));
  const act = JSON.parse(wire.act({ pid: 1, windowId: 2, at: [3, 4] }));
  assert.deepEqual([first.hand, first.seq, act.seq], ['character', 0, 1]);
  // A run against a fake Mac that stops at the first host start: it records the style and the first line.
  const started = [];
  const fake = {
    windows: async () => ({ front: 1, windows: [{ id: 9, pid: 5, layer: 0, alpha: 1, bounds: { x: 0, y: 0, width: 800, height: 600 } }] }),
    capture: async () => ({ width: 1, height: 1, data: new Uint8Array(4).fill(255) }),
    hit: async () => undefined, sleep: async () => {},
    startHost: async (mode, style) => { const lines = []; started.push({ mode, style, lines }); return { pid: 77, write: l => lines.push(l), close: async () => {} }; },
  };
  const character = { sheet: '/private/tmp/r/vc7-synthetic/sheet.png' };
  const report = await runCaptureTest(fake, { target: { pid: 5, id: 9, bounds: { x: 0, y: 0, width: 800, height: 600 } }, samples: 3, style: 'sprite', character });
  assert.equal(report.style, 'sprite');
  assert.deepEqual(started.map(s => [s.mode, s.style]), [['hidden', 'sprite'], ['visible', 'sprite']]);
  assert.equal(JSON.parse(started[0].lines[0]).hand, 'character');
  await assert.rejects(runCaptureTest(fake, { target: { pid: 5, id: 9, bounds: { x: 0, y: 0, width: 800, height: 600 } }, style: 'sprite' }), /needs a character/);
});

test('the owner is back only when input came after the run went quiet', async () => {
  assert.equal(ownerBack({ idleS: 30, quietSinceMs: 0, nowMs: 20000 }).back, false, 'idle since before the run went quiet');
  assert.equal(ownerBack({ idleS: 2, quietSinceMs: 0, nowMs: 3000 }).back, false, 'too soon to tell');
  const back = ownerBack({ idleS: 3, quietSinceMs: 0, nowMs: 60000 });
  assert.equal(back.back, true);
  assert.match(ownerWords(back), /input 3 s ago, 57 s after/);
  assert.equal(ownerBack({ idleS: 56, quietSinceMs: 0, nowMs: 60000 }).back, false, 'within the slack');
  assert.deepEqual(ownerBack({ idleS: undefined, quietSinceMs: 0, nowMs: 60000 }).unknown, true);
  let now = 1000, idle = 0;
  const watch = createOwnerWatch({ idle: async () => idle, now: () => now });
  now = 61000; idle = 1;
  assert.equal((await watch.check()).back, true);
  watch.quiet(); now = 62000;
  assert.equal((await watch.check()).back, false, 'our own step just ended');
  const broken = createOwnerWatch({ idle: async () => { throw new Error('ioreg'); }, now: () => now });
  now += 100000;
  assert.equal((await broken.check()).back, false);
});

test('engine cursor: sightings ignore windows already up, report delay and duration, and the decision follows R4', () => {
  const w = (id, extra = {}) => ({ id, pid: 9, owner: 'Codex Computer Use', name: 'ComputerUseCursor', layer: 3, alpha: 1, onScreen: true, sharing: 0, bounds: { x: 1, y: 2, width: 30, height: 30 }, ...extra });
  const text = [
    JSON.stringify({ t: 900, windows: [w(1, { name: 'AXDialog' })] }),
    JSON.stringify({ t: 1050, windows: [w(1, { name: 'AXDialog' })] }),
    JSON.stringify({ t: 1100, windows: [w(1, { name: 'AXDialog' }), w(2)] }),
    JSON.stringify({ t: 1150, windows: [w(1, { name: 'AXDialog' }), w(2)] }),
    JSON.stringify({ t: 1200, windows: [w(1, { name: 'AXDialog' }), w(3, { alpha: 0 })] }),
    'garbage', JSON.stringify({ ok: true, done: true }),
  ].join('\n');
  const samples = parseWatch(text);
  assert.equal(samples.length, 5);
  const [hit, miss] = callSightings(samples, [{ label: 'coordinate-click', placement: 'front', start: 1000, end: 1120 },
    { label: 'type', placement: 'front', start: 5000, end: 5100 }]);
  assert.equal(hit.appeared, true);
  assert.deepEqual(hit.windows.map(x => [x.id, x.delayMs, x.visibleMs, x.name]), [[2, 100, 100, 'ComputerUseCursor']]);
  assert.equal(miss.appeared, false);
  assert.equal(engineDecision([hit, miss]).row, 'cursor-window');
  assert.match(engineDecision([hit, miss]).words, /1 of 2 calls \(Codex Computer Use\/ComputerUseCursor\)/);
  assert.equal(engineDecision([miss]).row, 'no-cursor');
  assert.equal(engineDecision([]).row, 'no-data');
  assert.deepEqual(timingStats([10, 30, 20], [5, 15]), { withSampler: { calls: 3, medianMs: 20, minMs: 10, maxMs: 30 },
    withoutSampler: { calls: 2, medianMs: 10, minMs: 5, maxMs: 15 }, deltaMs: 10 });
  assert.equal(timingStats([], [1]).deltaMs, null);
  const tree = ['Window: "a.txt", App: TextEdit.', '\t1 standard window a.txt', '\t\t2 button Close', '\t\t3 button Zoom',
    '\t\t4 button Minimize', '\t\t5 scroll area', '\t\t\t6 text area Value: ...', '\t\t7 checkbox Bold'].join('\n');
  assert.deepEqual(pickElements(tree), { button: 7, text: 6 });
  assert.deepEqual(pickElements('\t1 button Close\n\t2 text area'), { button: undefined, text: 2 });
  const calls = sequenceCalls({ button: 7, text: 6 });
  assert.deepEqual(calls.map(c => c.label), ['read', 'ax-click', 'coordinate-click', 'type', 'scroll']);
  assert.equal(calls[1].code, 'await app.click(7)');
  assert.equal(calls[2].code, `await app.click(${JSON.stringify(COORDINATE)})`);
  assert.equal(calls[4].code, 'await app.scroll(6, "down", 2)');
  assert.deepEqual(sequenceCalls({}).map(c => c.label), ['read', 'coordinate-click', 'type', 'scroll']);
});

test('cursor cost: phase figures, the idle minute after the settle, and each style against its budget', () => {
  const host = (cpu, rssKb, style = 'ring') => ({ 7: { cpu, rssKb, style } });
  const samples = [];
  for (let s = 0; s <= 40; s++) samples.push({ t: s * 1000, ws: s * 0.1, hosts: {} }); // baseline: 10% WindowServer
  for (let s = 41; s <= 150; s++) {
    const active = s <= 80;
    samples.push({ t: s * 1000, ws: 4 + (s - 40) * (active ? 0.11 : 0.1), hosts: host(active ? (s - 41) * 0.002 : 0.078 + (s < 80 + SETTLE_MS / 1000 ? 0.001 : 0), 30000) });
  }
  const base = phaseFigures(samples, { start: 0, activeEnd: 40000 });
  assert.deepEqual([base.wsAvgPct, base.hosts, base.idleHostCpuS], [10, 0, null]);
  const ring = phaseFigures(samples, { start: 41000, activeEnd: 80000, idleEnd: 150000 });
  assert.equal(ring.hostAvgPct, 0.2);
  assert.equal(ring.idleHostCpuS, 0);
  assert.equal(ring.peakRssMiB, 29.3);
  const verdict = costVerdict({ 'baseline-1': base, ring, seam: { ...ring, peakRssMiB: 51 }, sprite: { ...ring, peakRssMiB: 51 }, 'baseline-2': base });
  assert.equal(verdict.styles.ring.verdict, 'within');
  assert.equal(verdict.styles.seam.verdict, 'over', 'seam keeps the 50 MiB budget');
  assert.equal(verdict.styles.sprite.verdict, 'within', 'sprite has 64 MiB');
  assert.equal(verdict.verdict, 'over');
  assert.equal(verdict.styles.ring.checks.find(c => /average/.test(c.name)).value, 1);
  const idle = costVerdict({ 'baseline-1': base, ring: { ...ring, idleHostCpuS: 0.01 } });
  assert.equal(idle.styles.ring.verdict, 'over', 'any CPU after the park and fade fails');
  const skipped = costVerdict({ 'baseline-1': base, ring, sprite: { skipped: 'no sprite renderer' } });
  assert.equal(skipped.styles.sprite.verdict, 'not-measured');
  assert.equal(skipped.verdict, 'not-measured');
  assert.equal(costVerdict({ ring: { ...ring, hosts: 0 } }).styles.ring.verdict, 'not-measured');
  assert.deepEqual([rssBudget('ring'), rssBudget('seam'), rssBudget('sprite')], [50, 50, 64]);
  assert.deepEqual(phases(['ring']).map(p => p.id), ['baseline-1', 'ring', 'baseline-2']);
  assert.deepEqual(costArgs(['--styles', 'ring,sprite']).styles, ['ring', 'sprite']);
  assert.throws(() => costArgs(['--styles', 'glove']), /--styles/);
});

test('cursor recording: one composite of the fixture and the panel, cropped to the fixture; the panel is the host\'s one window', () => {
  const plan = recordPlan({ out: '/x/record-ring', seconds: 20, style: 'ring', targetId: 11, panelId: 12 });
  assert.deepEqual(plan, { version: 1, out: '/x/record-ring', fps: 30, duration: 20, codec: 'hevc',
    streams: [{ name: 'cursor-ring', windows: [11, 12], composite: true, crop: 'first' }] });
  assert.throws(() => recordPlan({ out: 'rel', seconds: 20, style: 'ring', targetId: 1, panelId: 2 }), /absolute/);
  assert.throws(() => recordPlan({ out: '/x', seconds: 20, style: 'ring', targetId: 1, panelId: 1 }), /two different/);
  assert.equal(panelWindow([{ id: 1, pid: 5, alpha: 1 }, { id: 2, pid: 6, alpha: 1 }], 6).id, 2);
  assert.equal(panelWindow([{ id: 1, pid: 6, alpha: 0 }], 6), undefined);
  assert.equal(panelWindow([{ id: 1, pid: 6, alpha: 1 }, { id: 3, pid: 6, alpha: 1 }], 6), undefined);
  assert.deepEqual(recordArgs([]).styles, ['ring', 'sprite']);
  assert.throws(() => recordArgs(['--seconds', '2']), /5 to 60/);
  const source = readFileSync(join(root, 'bench/capture/recorder.swift'), 'utf8');
  assert.match(source, /item\["crop"\] == nil \|\| \(composite && item\["crop"\] as\? String == "first"\)/);
  assert.match(source, /stream\.cropFirst \? windows\[0\]\.frame/);
});

const entry = (task, side, { tool = [100, 100], wall = 10, round = 1, ...rest } = {}) => ({ round, task, side, passed: true, elapsedS: wall,
  trace: { toolMs: tool, hand: { drift: [] } }, whole: { hand: { hosts: side === 'on' ? 1 : 0, styles: side === 'on' ? ['ring'] : [] } }, ...rest });

test('speed A/B: per-task figures, the noise rule, and "no slowdown" only when every task is within it', () => {
  assert.equal(noiseLimitMs(100), 20); assert.equal(noiseLimitMs(1000), 100); assert.equal(noiseLimitMs(null), null);
  const even = [entry('a', 'on', { wall: 10 }), entry('a', 'off', { wall: 10.5 }), entry('a', 'on', { wall: 11, round: 2 }), entry('a', 'off', { wall: 10.5, round: 2 }),
    entry('b', 'on', { tool: [210] }), entry('b', 'off', { tool: [200] })];
  const rows = perTask(even);
  assert.deepEqual(rows.map(r => r.task), ['a', 'b']);
  assert.deepEqual([rows[0].on.wallMeanS, rows[0].on.wallSeS, rows[0].off.wallSeS, rows[0].wallDeltaS, rows[0].wallLimitS], [10.5, 0.5, 0, 0, 1.05]);
  assert.equal(rows[1].toolDeltaMs, 10);
  const fine = speedVerdict(rows, { cursorStyle: 'ring' });
  assert.equal(fine.slowdown, false);
  assert.match(fine.line, /^Speed verdict: no slowdown with ring on \(2 tasks/);
  const slow = speedVerdict(perTask([...even, entry('c', 'on', { wall: 12 }), entry('c', 'off', { wall: 10 })]), { cursorStyle: 'ring' });
  assert.equal(slow.slowdown, true);
  assert.match(slow.line, /c \(tool \+0 ms per call, wall \+2 s\)/);
  assert.equal(speedVerdict(perTask([entry('a', 'on')]), {}).slowdown, null);
  assert.equal(speedVerdict([], {}).slowdown, null);
  const cmp = compareSides([entry('a', 'on', { whole: { hand: { hosts: 1, styles: ['glove'] } } }), entry('a', 'off')], undefined, { cursorStyle: 'ring' });
  assert.ok(cmp.invalid.some(r => /ran as glove, not ring/.test(r)));
  assert.equal(hostStyle('/x/consent-host --hand --capture=hidden --cursor-style=ring --menu'), 'ring');
  assert.equal(hostStyle('/x/consent-host --hand --capture=hidden --menu'), 'glove');
});

test('speed A/B pass: the on side gets the style, a resumed pass skips finished runs, and the owner\'s return stops it', async () => {
  const envs = [];
  const deps = {
    env: { SLEIGHT_CURSOR_STYLE: 'seam', KEEP: '1' },
    run: async (args, env) => { envs.push(env); return { pid: 1, done: Promise.resolve({ code: 0, stdout: 'results: /r.json\n' }) }; },
    sampler: () => ({ start: async () => {}, stop: async () => [] }),
    readJson: () => ({ ghostHand: envs.at(-1).SLEIGHT_BENCH_HAND === '1' ? 'on' : 'off', stamp: 's', results: [{ arm: 'sleight', task: 'calculator-click', passed: true, seconds: 5, finishedAt: new Date().toISOString() }] }),
    traceLines: () => [],
  };
  await runSide(deps, { round: 1, task: 'calculator-click', side: 'on', model: 'm', effort: 'e', cursorStyle: 'ring' });
  await runSide(deps, { round: 1, task: 'calculator-click', side: 'off', model: 'm', effort: 'e', cursorStyle: 'ring' });
  assert.deepEqual(envs.map(e => [e.SLEIGHT_BENCH_HAND, e.SLEIGHT_CURSOR_STYLE, e.KEEP]), [['1', 'ring', '1'], ['0', undefined, '1']]);
  envs.length = 0;
  const done = [{ round: 1, task: 'calculator-click', side: 'off' }, { round: 1, task: 'calculator-click', side: 'on', error: 'x' }];
  const all = await runCostPass(deps, { tasks: ['calculator-click'], rounds: 2, cursorStyle: 'ring', done });
  assert.equal(envs.length, 3, 'the failed step and round 2 run; the finished one is kept');
  assert.equal(all.length, 4);
  assert.equal(all.filter(e => e.error).length, 0);
  let asked = 0;
  const stopped = await runCostPass({ ...deps, ownerBack: async () => (++asked === 2 ? 'the owner is back' : undefined) }, { tasks: ['calculator-click'], rounds: 1 });
  assert.equal(stopped.stopped, 'the owner is back');
  assert.equal(stopped.length, 1);
  assert.deepEqual(passArgs(['--cursor-style', 'ring', '--stop-on-owner', '--dry-run']).cursorStyle, 'ring');
  assert.equal(passArgs(['--cursor-style', 'glove']).cursorStyle, 'glove');
  assert.throws(() => passArgs(['--cursor-style', 'Sprite']), /--cursor-style must be one of glove, ring, seam, sprite/);
  assert.equal(passArgs([]).cursorStyle, undefined);
  assert.notEqual(resumeKey({ tasks: ['a'], rounds: 5, model: 'm', effort: 'e', cursorStyle: 'ring' }), resumeKey({ tasks: ['a'], rounds: 5, model: 'm', effort: 'e' }));
  const plan = passPlan({ ...passArgs(['--cursor-style', 'ring', '--rounds', '5']), stopOnOwner: true }, { out: '/o', root: '/r', home: '/h' });
  assert.equal(plan.length, 2 + 30);
  assert.match(plan[3], /SLEIGHT_BENCH_HAND=1 SLEIGHT_CURSOR_STYLE=ring node bench\/run\.mjs --suite world --arm sleight --tasks calculator-click/);
});

test('night runner: steps in order under the 90 minute target, exit codes, the child environment, strays and the summary', () => {
  const steps = nightSteps({ out: '/o', bin: '/o/bin' });
  assert.deepEqual(steps.map(s => s.id), ['build', 'capture-ring', 'capture-seam', 'capture-sprite', 'engine-cursor', 'cursor-cost', 'speed-ab', 'record']);
  assert.deepEqual(steps.map(s => s.check), [0, 1, 1, 1, 2, 3, 4, 5]);
  assert.ok(estimate(steps) < TARGET_MIN);
  for (const step of steps.filter(s => !s.internal)) {
    assert.ok(step.args.includes('--owner-away'), step.id);
    assert.ok(existsSync(join(root, step.script)), step.script);
  }
  const ab = steps.find(s => s.id === 'speed-ab').args.join(' ');
  assert.match(ab, /--cursor-style ring --rounds 5 --tasks calculator-click,textedit-save,textedit-drag --model claude-haiku-5-5 --effort high --stop-on-owner/);
  assert.ok(steps.find(s => s.id === 'capture-sprite').args.includes('sprite'));
  assert.deepEqual(['passed', 'measured, not passed', 'refused', 'busy', 'stopped for the owner'].map((s, rc) => outcome(rc).status), ['passed', 'measured, not passed', 'refused', 'busy', 'stopped for the owner']);
  assert.equal(outcome(0).done, true); assert.equal(outcome(1).done, true); assert.equal(outcome(2).done, false);
  assert.equal(outcome(3).retry, true); assert.equal(outcome(4).stop, true); assert.equal(outcome(null, 'SIGINT').stop, true);
  assert.match(outcome(9).status, /crashed \(exit 9\)/);
  const env = childEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_CONFIG_DIR: '/mine' }, '/tmp/lane-claude-1');
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/tmp/lane-claude-1', DISABLE_AUTOUPDATER: '1', SLEIGHT_NO_HUB: '1', SLEIGHT_REMOTE_APPROVALS: '0' });
  const ps = ['  10 /o/bin/consent-host --hand --capture=hidden --cursor-style=ring', '11 /o/bin/capture-recorder record /x', '12 /other/bin/consent-host --hand',
    '13 /o/binary/consent-host', ' 14 /o/bin/capture-helper watch-engine 50 30'].join('\n');
  assert.deepEqual(strays(ps, '/o/bin'), [{ pid: 10, command: 'consent-host' }, { pid: 11, command: 'capture-recorder' }, { pid: 14, command: 'capture-helper' }]);
  assert.equal(resultLine('x\nVC7 RESULT: one\nVC7 RESULT: two\n'), 'two');
  assert.equal(resultLine('nothing'), undefined);
  const md = summaryMarkdown({ root: '/r', head: 'abcdef1234567890', out: '/o', startedAt: 'T' }, { build: { status: 'passed', rc: 0, minutes: 1.5 } }, steps, { stoppedFor: 'the owner is back' });
  assert.match(md, /\| - \| build \| passed \| 0 \| 1.5 \|/);
  assert.match(md, /\| 4 \| speed-ab \| not run \|/);
  assert.match(md, /Stopped: the owner is back/);
  assert.deepEqual(nightArgs(['--dry-run', '--night', '/n']), { dryRun: true, fresh: false, night: '/n' });
  assert.throws(() => nightArgs(['--go']), /unknown option/);
  assert.throws(() => nightArgs(['x']), /unexpected argument/);
});

test('shared live pieces: host flags as the relay passes them, the product\'s compiler flags, and the refusals', () => {
  assert.deepEqual(hostArgs({ capture: 'visible', style: 'ring' }), ['--hand', '--capture=visible', '--cursor-style=ring']);
  assert.deepEqual(hostArgs({}), ['--hand', '--capture=hidden']);
  assert.throws(() => hostArgs({ style: 'pet' }), /unknown cursor style/);
  assert.throws(() => hostArgs({ capture: 'shown' }), /hidden or visible/);
  assert.deepEqual(compileArgs('/s.swift', '/b', '/c'), ['swiftc', '-module-cache-path', '/c', '/s.swift', '-o', '/b']);
  const hostSource = readFileSync(join(root, 'plugins/sleight/lib/direct-browser/host.mjs'), 'utf8');
  assert.match(hostSource, /\['swiftc', '-module-cache-path', moduleCache, source, '-o', binary\]/, 'the product builds the host the same way');
  assert.throws(() => commonArgs(['--out']), /--out needs a path/);
  assert.equal(commonArgs(['--owner-away', '--host', '/h']).host, '/h');
  assert.equal(liveRefusal({ ownerAway: false, hold: false }, 'X').code, 2);
  assert.equal(liveRefusal({ ownerAway: true, hold: true, platform: 'darwin' }, 'X').code, 3);
  assert.equal(liveRefusal({ ownerAway: true, hold: false, platform: 'linux' }, 'X').code, 2);
  assert.equal(liveRefusal({ ownerAway: true, hold: false, platform: 'darwin' }, 'X'), undefined);
  assert.deepEqual(playRect({ x: 0, y: 0, width: 800, height: 600 }), { x: 24, y: 60, width: 752, height: 516 });
});

test('every VC7 script\'s --dry-run exits 0, prints its plan and opens nothing', () => {
  const night = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-vc7-night-'))));
  for (const [script, args, expect] of [
    ['bench/hand/h5-capture.mjs', ['--cursor-style', 'ring'], /cursor style ring/],
    ['bench/hand/engine-cursor.mjs', [], /engine cursor check/],
    ['bench/hand/cursor-cost.mjs', [], /cursor cost check/],
    ['bench/hand/cursor-record.mjs', [], /cursor recording/],
    ['bench/hand/cost-pass.mjs', ['--cursor-style', 'ring', '--rounds', '5'], /30 runs/],
    ['bench/hand/vc7-night.mjs', ['--night', night], /estimate \d+ min of steps \(target under 90\)/],
  ]) {
    const run = spawnSync(process.execPath, [join(root, script), ...args, '--dry-run'], { cwd: root, encoding: 'utf8', timeout: 120000 });
    assert.equal(run.status, 0, `${script}: ${run.stderr}`);
    assert.match(run.stdout, /dry run/, script);
    assert.match(run.stdout, expect, script);
  }
  assert.equal(existsSync(join(night, 'vc7-state.json')), false, 'the dry run writes no state');
});

// The scripted frames through the real host's planner on a simulated clock: no application, panel or layer is made.
let binary;
function buildHost(t) {
  if (binary) return binary;
  const dir = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-vc7-host-'))));
  const output = join(dir, 'consent-host');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), join(root, 'plugins/sleight/lib/direct-browser/native/consent-host.swift'), '-o', output], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  binary = output;
  return binary;
}

test('the host\'s planner accepts every scripted frame for ring and seam and draws each act', { skip: macCommandSkip('xcrun') }, t => {
  const { steps } = autoSequence({ pid: 2147483647, windowId: 4294967295, rect: { x: 100, y: 100, width: 600, height: 400 }, count: 30, spacingMs: 1300 });
  const wire = cursorWire(nonce);
  const input = steps.map(s => JSON.stringify({ dumpClock: s.atMs / 1000 }) + '\n' + wire[s.type](s.args)).join('') + JSON.stringify({ dumpClock: 120 }) + '\n';
  for (const style of ['ring', 'seam']) {
    const run = spawnSync(buildHost(t), ['--ring-plan-dump', `--cursor-style=${style}`, '--clip=0,0,1000,1000'], { input, encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 28,
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
    assert.equal(run.status, 0, `${style}: exit ${run.status} (65 is a refused frame) ${run.stderr}`);
    const effects = run.stdout.trim().split('\n').map(l => JSON.parse(l));
    const draws = effects.filter(e => e.effect === 'draw');
    assert.ok(draws.length >= 30, `${style}: ${draws.length} draws`);
    const end = effects.at(-1);
    assert.deepEqual([end.effect, end.pending, end.timers], ['end', 0, 0], `${style}: nothing left pending at the end`);
    t.diagnostic(`${style}: ${draws.length} draws, ${effects.filter(e => e.effect === 'drop').length} drops, ${effects.filter(e => e.effect === 'release').length} releases`);
  }
});

test('a host with the sprite renderer accepts the synthetic character (skips on a host without it)', { skip: macCommandSkip('xcrun') }, t => {
  const host = buildHost(t);
  const installed = installSyntheticCharacter();
  t.after(() => rmSync(installed.root, { recursive: true, force: true }));
  const run = spawnSync(host, ['--check-character'], { input: JSON.stringify(characterWire(installed, { nonce, seq: 0 })) + '\n', encoding: 'utf8', timeout: 30000,
    env: { PATH: '/usr/bin:/bin', ...characterEnv(installed.root) } });
  if (run.status === 64) { t.skip('this host has no --check-character (the sprite renderer, VC4, is not merged)'); return; }
  assert.equal(run.status, 0, run.stderr);
  const answer = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.deepEqual([answer.id, answer.loaded, answer.reason, answer.warnings], [SYNTHETIC_ID, true, null, []]);
});
