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
import { ownerBack, createOwnerWatch, ownerWords, createInputDetector, parseInputLine, QUIET_GAP_MS, MOVED_SAMPLES } from '../bench/hand/owner-watch.mjs';
import { parseWatch, callSightings, baselineWindows, timingStats, engineDecision, pickElements, sequenceCalls, COORDINATE } from '../bench/hand/engine-cursor.mjs';
import { phases, phaseFigures, costVerdict, rssBudget, parseArgs as costArgs, SETTLE_MS } from '../bench/hand/cursor-cost.mjs';
import { recordPlan, panelWindow, asideName, parseArgs as recordArgs } from '../bench/hand/cursor-record.mjs';
import { perTask, speedVerdict, speedRule, t975, perTaskMarkdown, runSide, runCostPass, compareSides, parseArgs as passArgs, resumeKey, dryRunPlan as passPlan } from '../bench/hand/cost-pass.mjs';
import { hostStyle } from '../bench/hand/cost-sampler.mjs';
import { prepareCaptureStep, nightSteps, estimate, overheadMin, timeoutMs, outcome, childEnv, strays, descendants, orphanedLock, launchedApps, resultLine, HOLD_WAIT_MS, LOCK_WAIT_MS, summaryMarkdown, parseArgs as nightArgs, TARGET_MIN } from '../bench/hand/vc7-night.mjs';
import { hostArgs, commonArgs, liveRefusal, compileArgs, playRect, quitFixture } from '../bench/hand/vc7-live.mjs';
import { handWire, runCaptureTest, underLiveLock } from '../bench/hand/h5-capture.mjs';
import { EventEmitter } from 'node:events';

// The native host's test override for characters only accepts a root under macOS's private tmp folder (os.tmpdir() is under
// /var/folders), so those paths are built from parts here (the test-path guard refuses the literal).
const privateTmp = (...parts) => join('/private', 'tmp', ...parts);

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

  const frame = characterWire({ sheet: privateTmp('x', 'vc7-synthetic', 'sheet.png') }, { nonce, seq: 4 });
  assert.deepEqual(Object.keys(frame).sort(), ['cell', 'extra', 'hand', 'id', 'nonce', 'seq', 'sheet', 'table']);
  assert.deepEqual(Object.keys(frame.table.idle).sort(), ['flip', 'frames', 'hotspot', 'loop', 'ms', 'row', 'scale', 'sheet']);
  assert.equal(frame.id, SYNTHETIC_ID); assert.equal(frame.extra, null); assert.equal(frame.seq, 4);
  assert.throws(() => characterWire({ sheet: 'relative.png' }, { nonce, seq: 0 }), /absolute/);
  assert.throws(() => characterWire({ sheet: '/a.png' }, { nonce: 'x', seq: 0 }), /nonce/);
});

// macOS's private tmp folder, as the host's test override requires.
test('the synthetic character installs at 0700 and 0600 under the private tmp folder', { skip: process.platform !== 'darwin' && 'macOS only' }, t => {
  const installed = installSyntheticCharacter();
  t.after(() => rmSync(installed.root, { recursive: true, force: true }));
  assert.ok(installed.root.startsWith(privateTmp('sleight-vc7-characters-')));
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
  assert.ok(hostAccepts(JSON.parse(wire.character({ sheet: privateTmp('a', 'b.png') }))));
  assert.ok(hostAccepts(JSON.parse(wire.hide())));
  let stop = false;
  const partial = await playSequence({ steps }, { wire: cursorWire(nonce), write: () => { stop = true; }, sleep: async () => {}, stopped: () => stop });
  assert.equal(partial.length, 1);
  assert.throws(() => autoSequence({ pid: 0, windowId: 1, rect }), /pid/);
  assert.throws(() => autoSequence({ pid: 1, windowId: 1, rect: { ...rect, width: 50 } }), /120 by 120/);
});

test('H5 with a style: the host starts in that style, the sprite gets its character frame first, sharing the acts\' seq', async () => {
  const wire = handWire(nonce);
  const first = JSON.parse(wire.character({ sheet: privateTmp('r', 'vc7-synthetic', 'sheet.png') }));
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
  const character = { sheet: privateTmp('r', 'vc7-synthetic', 'sheet.png') };
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
  const broken = createOwnerWatch({ idle: async () => { throw new Error('ioreg'); }, now: () => 100000, sleep: async () => {} });
  assert.equal((await broken.gapCheck()).back, false);
});

test('the gap check fires on owner input 1 to 6 s before it, as the runner calls it, and never on a quiet Mac', async () => {
  // The runner's real sequence: a step ends, the sweep takes a few seconds, then gapCheck() marks quiet, sleeps 15 s, reads.
  for (const sweepS of [1, 3, 6]) {
    for (const inputAgoS of [1, 2, 3, 4, 5, 6]) {
      let clock = 0, lastInput = -1000;
      const watch = createOwnerWatch({ now: () => clock, idle: async () => (clock - lastInput) / 1000, sleep: async ms => { clock += ms; } });
      clock = 50000; watch.quiet(); // the step ended
      clock += sweepS * 1000;       // the sweep
      lastInput = clock + 15000 - inputAgoS * 1000; // the owner touches the Mac inside the gap that starts now
      const result = await watch.gapCheck();
      assert.equal(result.back, true, `sweep ${sweepS} s, input ${inputAgoS} s before the read`);
    }
    let clock = 0;
    const quietMac = createOwnerWatch({ now: () => clock, idle: async () => clock / 1000, sleep: async ms => { clock += ms; } });
    clock = 50000; quietMac.quiet(); clock += sweepS * 1000;
    assert.equal((await quietMac.gapCheck()).back, false, `no input, sweep ${sweepS} s`);
  }
  // Input from before the gap (the step's own engine input, 2 s before the gap starts) never counts.
  let clock = 50000;
  const own = createOwnerWatch({ now: () => clock, idle: async () => (clock - 48000) / 1000, sleep: async ms => { clock += ms; } });
  assert.equal((await own.gapCheck()).back, false);
});

test('during a step: a pointer that moves and stays away is the owner; a short excursion and harness input are not', () => {
  const s = (t, x, y, idle) => ({ t, x, y, idle });
  let detect = createInputDetector({ harnessInput: true, quietSinceMs: 0 });
  assert.equal(detect(s(1000, 100, 100, 0.1)), undefined);
  assert.equal(detect(s(2000, 400, 300, 0.1)), undefined, 'one sample away');
  assert.equal(detect(s(3000, 100, 100, 0.1)), undefined, 'a drag fallback restores the pointer');
  for (const t of [4000, 5000, 6000]) assert.equal(detect(s(t, 400, 300, 0)), undefined, 'a drag fallback of up to 3 s');
  assert.equal(detect(s(7000, 100, 100, 0)), undefined, 'restored');
  for (const t of [8000, 9000, 10000, 11000]) assert.equal(detect(s(t, 410, 300, 0)), undefined);
  const hit = detect(s(12000, 410, 300, 0));
  assert.equal(hit.back, true);
  assert.match(hit.reason, /pointer moved from 100,100 to 410,300 and stayed 5 s/);
  assert.equal(detect(s(13000, 100, 100, 0)), hit, 'fires once');
  assert.equal(MOVED_SAMPLES, 5);
  detect = createInputDetector({ harnessInput: true, quietSinceMs: 0 });
  for (let t = 1000; t < 20000; t += 1000) assert.equal(detect(s(t, 50, 50, 0.2)), undefined, 'engine input in an input step is ignored');
  detect = createInputDetector({ harnessInput: false, quietSinceMs: 0 });
  assert.equal(detect(s(4000, 50, 50, 0.5)), undefined, 'inside the slack');
  assert.equal(detect(s(20000, 50, 50, 20)), undefined, 'no input since the quiet mark');
  assert.match(detect(s(21000, 50, 50, 1)).reason, /HID input 1 s ago during a check that makes no input/);
  assert.deepEqual(parseInputLine('{"t":5,"x":1.5,"y":2,"idle":0.25}'), { t: 5, x: 1.5, y: 2, idle: 0.25 });
  assert.equal(parseInputLine('{"ok":true,"done":true}'), undefined);
  assert.equal(parseInputLine('garbage'), undefined);
  assert.equal(QUIET_GAP_MS, 15000);
});

test('engine cursor: sightings ignore windows already up, "no cursor" needs 100 samples and coverage, a baseline window is evidence', () => {
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
  assert.equal(miss.coverage, 0);
  assert.equal(engineDecision([hit, miss]).row, 'cursor-window');
  assert.match(engineDecision([hit, miss]).words, /1 of 2 calls \(Codex Computer Use\/ComputerUseCursor\); whether the engine's own screenshots include it is still open/);
  assert.deepEqual(baselineWindows(samples, 1000).map(x => x.name), ['AXDialog']);
  // A cursor window the engine made before the first call and kept: in the baseline, so it is evidence, not absence.
  assert.match(engineDecision([miss], { baseline: baselineWindows(samples, 1000), samples: 500 }).words, /up before the first engine call \(Codex Computer Use\/AXDialog\)/);
  // A quiet sampler that ran: every 50 ms over two 2 s calls.
  const quiet = Array.from({ length: 200 }, (_, i) => ({ t: i * 50, windows: [] }));
  const calls = [{ label: 'read', placement: 'background', start: 1000, end: 3000 }, { label: 'type', placement: 'front', start: 5000, end: 7000 }];
  const full = callSightings(quiet, calls, { baselineMs: 500 });
  assert.ok(full.every(s => s.coverage >= 0.9));
  assert.equal(engineDecision(full, { samples: quiet.length }).row, 'no-cursor');
  assert.equal(engineDecision(full, { samples: 99 }).row, 'no-data', 'fewer than 100 samples');
  assert.equal(engineDecision(callSightings(quiet.filter(s => s.t < 4000), calls), { samples: 100 }).row, 'no-data', 'a call the sampler missed');
  assert.equal(engineDecision(callSightings([], calls)).row, 'no-data', 'a sampler that never ran');
  assert.equal(engineDecision([]).row, 'no-data');
  assert.deepEqual(timingStats([10, 30, 20], [5, 15]), { withSampler: { calls: 3, medianMs: 20, minMs: 10, maxMs: 30 },
    withoutSampler: { calls: 2, medianMs: 10, minMs: 5, maxMs: 15 }, deltaMs: 10 });
  assert.equal(timingStats([], [1]).deltaMs, null);
  const tree = ['Window: "a.txt", App: TextEdit.', '\t1 standard window a.txt', '\t\t2 button Close', '\t\t3 button Zoom',
    '\t\t4 button Minimize', '\t\t5 scroll area', '\t\t\t6 text area Value: ...', '\t\t7 checkbox Bold'].join('\n');
  assert.deepEqual(pickElements(tree), { button: 7, text: 6 });
  assert.deepEqual(pickElements('\t1 button Close\n\t2 text area'), { button: undefined, text: 2 });
  const sequence = sequenceCalls({ button: 7, text: 6 });
  assert.deepEqual(sequence.map(c => c.label), ['read', 'ax-click', 'coordinate-click', 'type', 'scroll']);
  assert.equal(sequence[1].code, 'await app.click(7)');
  assert.equal(sequence[2].code, `await app.click(${JSON.stringify(COORDINATE)})`);
  assert.equal(sequence[4].code, 'await app.scroll(6, "down", 2)');
  assert.deepEqual(sequenceCalls({}).map(c => c.label), ['read', 'coordinate-click', 'type', 'scroll']);
  const source = readFileSync(join(root, 'bench/hand/engine-cursor.mjs'), 'utf8');
  assert.ok(source.indexOf('const main = watch(600)') < source.indexOf('const first = await call('), 'the sampler starts before the first engine call');
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
  const idle = costVerdict({ 'baseline-1': base, ring: { ...ring, idleHostCpuS: 0.06 } });
  assert.equal(idle.styles.ring.verdict, 'over', 'more than 5 ps ticks (0.05 CPU s) after the park and fade fails');
  assert.equal(costVerdict({ 'baseline-1': base, ring: { ...ring, idleHostCpuS: 0.03 } }).styles.ring.verdict, 'within', 'a few scheduler ticks are idle');
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
const runsOf = (task, side, walls, extra = {}) => walls.map((wall, i) => entry(task, side, { wall, round: i + 1, ...extra }));

test('speed rule: passed runs only, 4 a side, within 5% or a 95% interval holding 0 inside 10%; else inconclusive or slower', () => {
  assert.deepEqual([1, 4, 30, 31, 61, 200].map(t975), [12.706, 2.776, 2.042, 2.0, 1.98, 1.96]);
  assert.equal(speedRule([10, 10, 10], [10, 10, 10, 10]).state, 'not-measured');
  // Within 5%: no slowdown whatever the spread.
  assert.equal(speedRule([10.4, 10.4, 10.4, 10.4], [10, 10, 10, 10]).state, 'no-slowdown');
  // 8% slower and tight: the interval lies above 0.
  const slower = speedRule([10.8, 10.9, 10.7, 10.8, 10.8], [10, 10.1, 9.9, 10, 10]);
  assert.equal(slower.state, 'slower');
  assert.ok(slower.ci[0] > 0);
  // 8% slower, noisy enough that the interval holds 0, but wider than 10%: inconclusive (H6's textedit-drag spread).
  const wide = speedRule([23, 37, 25, 36, 29], [24, 31, 26, 25, 30]);
  assert.equal(wide.state, 'inconclusive');
  assert.ok(wide.ci[0] < 0 && wide.ci[1] > 0 && wide.halfPct > 10);
  // 6% slower, interval holds 0 and is narrow: no slowdown.
  const narrow = speedRule([10.6, 10.9, 10.3, 10.6, 10.6], [9.5, 10.8, 9.2, 10.6, 9.9]);
  assert.equal(narrow.state, 'no-slowdown');
  assert.ok(narrow.diffPct > 5 && narrow.ci[0] < 0 && narrow.halfPct <= 10);
  // Within 5% but with the H6 textedit-drag spread: the interval reaches far past +15%, so inconclusive (VC7HR2).
  const offDrag = [23, 26, 28, 31, 37], noisy = speedRule(offDrag.map(v => v + 1.2), offDrag);
  assert.ok(noisy.diffPct < 5 && noisy.halfPct > 15);
  assert.equal(noisy.state, 'inconclusive');
  // Faster is never a slowdown.
  assert.equal(speedRule([8, 8, 8, 8], [10, 10, 10, 10]).state, 'no-slowdown');
});

test('speed A/B verdict: failed runs are dropped, a task needs 4 passed a side, and only a measured "no slowdown" passes', () => {
  const fine = [...runsOf('a', 'on', [10, 10.2, 9.9, 10.1, 10]), ...runsOf('a', 'off', [10, 10.1, 9.8, 10, 10.1]),
    ...runsOf('b', 'on', [5, 5, 5.1, 5, 4.9], { tool: [210] }), ...runsOf('b', 'off', [5, 5.1, 4.9, 5, 5], { tool: [200] })];
  const rows = perTask(fine);
  assert.deepEqual(rows.map(r => [r.task, r.state, r.on.passed, r.off.passed]), [['a', 'no-slowdown', 5, 5], ['b', 'no-slowdown', 5, 5]]);
  assert.equal(rows[1].tool.diff, 10);
  const ok = speedVerdict(rows, { cursorStyle: 'ring' });
  assert.deepEqual([ok.state, ok.slowdown], ['no-slowdown', false]);
  assert.match(ok.line, /^Speed verdict: no slowdown with ring on \(2 tasks/);
  assert.match(ok.line, /; widest 95% interval \+\/-\d+(\.\d)?% \([ab]\)$/);
  assert.ok(ok.widestHalfPct > 0);
  assert.match(perTaskMarkdown(rows, ok), /\| a \| 5\/5 \/ 5\/5 \| \+0\.04 s \(0\.4%\), 95% \[/);
  // A failed run (passed false) is not timed: two failures on a side leave 3 passed, so the task is not measured.
  const failing = [...fine.filter(e => !(e.task === 'a' && e.side === 'on')), ...runsOf('a', 'on', [10, 10, 30, 31, 10]).map((e, i) => i >= 2 && i <= 3 ? { ...e, passed: false } : e)];
  const failRows = perTask(failing);
  assert.deepEqual([failRows.find(r => r.task === 'a').state, failRows.find(r => r.task === 'a').on.passed], ['not-measured', 3]);
  const notMeasured = speedVerdict(failRows, { cursorStyle: 'ring' });
  assert.deepEqual([notMeasured.state, notMeasured.slowdown], ['inconclusive', null]);
  assert.match(notMeasured.line, /not measured: a/);
  // A task whose runs all errored is not measured either, and the verdict is not a pass.
  const errored = [...fine, ...runsOf('c', 'on', [9, 9, 9, 9], { error: 'login expired' }), ...runsOf('c', 'off', [9, 9, 9, 9])];
  assert.equal(speedVerdict(perTask(errored)).state, 'inconclusive');
  assert.equal(speedVerdict(perTask([...fine, ...runsOf('d', 'on', [12, 12.1, 11.9, 12]), ...runsOf('d', 'off', [10, 10.1, 9.9, 10])])).state, 'slower');
  assert.equal(speedVerdict([]).state, 'not-measured');
  const cmp = compareSides([entry('a', 'on', { whole: { hand: { hosts: 1, styles: ['glove'] } } }), entry('a', 'off')], undefined, { cursorStyle: 'ring' });
  assert.ok(cmp.invalid.some(r => /ran as glove, not ring/.test(r)));
  assert.equal(hostStyle('/x/consent-host --hand --capture=hidden --cursor-style=ring --menu'), 'ring');
  assert.equal(hostStyle('/x/consent-host --hand --capture=hidden --menu'), 'glove');
  // main exits 0 only for a measured "no slowdown" (and 5 when a run errored).
  const source = readFileSync(join(root, 'bench/hand/cost-pass.mjs'), 'utf8');
  assert.equal(source.match(/speed\.state === 'no-slowdown' \? 0 : 1/g)?.length, 2);
  assert.doesNotMatch(source, /slowdown !== true/);
  assert.match(source, /if \(errored\.length\) \{ console\.log\(`VC7 INCOMPLETE[^\n]*return 5; \}/);
});

test('speed A/B pass: the on side gets the style and the capture mode, a resume skips finished runs, owner checks at round starts', async () => {
  const envs = [];
  const deps = {
    env: { SLEIGHT_CURSOR_STYLE: 'seam', SLEIGHT_HAND_CAPTURE: 'visible', KEEP: '1' },
    run: async (args, env) => { envs.push(env); return { pid: 1, done: Promise.resolve({ code: 0, stdout: 'results: /r.json\n' }) }; },
    sampler: () => ({ start: async () => {}, stop: async () => [] }),
    readJson: () => ({ ghostHand: envs.at(-1).SLEIGHT_BENCH_HAND === '1' ? 'on' : 'off', stamp: 's', results: [{ arm: 'sleight', task: 'calculator-click', passed: true, seconds: 5, finishedAt: new Date().toISOString() }] }),
    traceLines: () => [],
  };
  await runSide(deps, { round: 1, task: 'calculator-click', side: 'on', model: 'm', effort: 'e', cursorStyle: 'ring', capture: 'hidden' });
  await runSide(deps, { round: 1, task: 'calculator-click', side: 'off', model: 'm', effort: 'e', cursorStyle: 'ring', capture: 'hidden' });
  assert.deepEqual(envs.map(e => [e.SLEIGHT_BENCH_HAND, e.SLEIGHT_CURSOR_STYLE, e.SLEIGHT_HAND_CAPTURE, e.KEEP]), [['1', 'ring', 'hidden', '1'], ['0', undefined, undefined, '1']]);
  envs.length = 0;
  const done = [{ round: 1, task: 'calculator-click', side: 'off' }, { round: 1, task: 'calculator-click', side: 'on', error: 'x' }];
  const all = await runCostPass(deps, { tasks: ['calculator-click'], rounds: 2, cursorStyle: 'ring', done });
  assert.equal(envs.length, 3, 'the failed step and round 2 run; the finished one is kept');
  assert.equal(all.length, 4);
  assert.equal(all.filter(e => e.error).length, 0);
  const asked = [];
  const stopped = await runCostPass({ ...deps, ownerBack: async ({ boundary }) => { asked.push(boundary); return asked.length === 3 ? 'the owner is back' : undefined; } },
    { tasks: ['calculator-click', 'textedit-save'], rounds: 2 });
  assert.deepEqual(asked, [true, false, false], 'a boundary at each round\'s first run');
  assert.equal(stopped.stopped, 'the owner is back');
  assert.equal(stopped.length, 2);
  const cancelled = { ...deps, readJson: () => ({ ghostHand: 'on', stamp: 's', results: [{ arm: 'sleight', task: 'calculator-click', cancelled: true }] }) };
  assert.match((await runSide(cancelled, { round: 1, task: 'calculator-click', side: 'on' })).error, /cancelled/);
  assert.equal(passArgs(['--cursor-style', 'ring', '--stop-on-owner', '--dry-run']).cursorStyle, 'ring');
  assert.equal(passArgs([]).capture, 'hidden');
  assert.throws(() => passArgs(['--capture', 'shown']), /--capture must be hidden or visible/);
  assert.equal(passArgs(['--cursor-style', 'glove']).cursorStyle, 'glove');
  assert.throws(() => passArgs(['--cursor-style', 'Sprite']), /--cursor-style must be one of glove, ring, seam, sprite/);
  assert.equal(passArgs([]).cursorStyle, undefined);
  assert.notEqual(resumeKey({ tasks: ['a'], rounds: 5, model: 'm', effort: 'e', cursorStyle: 'ring' }), resumeKey({ tasks: ['a'], rounds: 5, model: 'm', effort: 'e' }));
  assert.notEqual(resumeKey({ tasks: ['a'], capture: 'visible' }), resumeKey({ tasks: ['a'] }));
  const plan = passPlan({ ...passArgs(['--cursor-style', 'ring', '--rounds', '5']), stopOnOwner: true }, { out: '/o', root: '/r', home: '/h' });
  assert.equal(plan.length, 2 + 30);
  assert.match(plan[3], /SLEIGHT_BENCH_HAND=1 SLEIGHT_HAND_CAPTURE=hidden SLEIGHT_CURSOR_STYLE=ring node bench\/run\.mjs --suite world --arm sleight --tasks calculator-click/);
});

test('capture steps wake before preflight and propagate a locked or sleeping screen refusal', async () => {
  const commands = [];
  await prepareCaptureStep('/fixture/capture-helper', async (cmd, args) => {
    commands.push([cmd, args]); return { stdout: '{"ok":true,"screenRecording":true}' };
  });
  assert.deepEqual(commands, [['/usr/bin/caffeinate', ['-u', '-t', '5']], ['/fixture/capture-helper', ['--preflight']]]);
  for (const error of ['display-asleep', 'screen-locked', 'screen-lock-state-unknown']) {
    await assert.rejects(prepareCaptureStep('/fixture/capture-helper', async cmd => {
      if (cmd.endsWith('capture-helper')) throw Object.assign(Error('exit 2'), { stdout: JSON.stringify({ ok: false, error }) });
      return { stdout: '' };
    }), new RegExp(error));
  }
});

test('night runner: steps, timeouts, outcomes (measured only with a result line), the child environment, strays and temp sweep', () => {
  const steps = nightSteps({ out: '/o', bin: '/o/bin' });
  assert.deepEqual(steps.map(s => s.id), ['build', 'capture-ring', 'capture-seam', 'capture-sprite', 'engine-cursor', 'cursor-cost', 'speed-ab', 'record']);
  assert.deepEqual(steps.map(s => s.check), [0, 1, 1, 1, 2, 3, 4, 5]);
  assert.deepEqual(steps.filter(s => s.input).map(s => s.id), ['engine-cursor', 'speed-ab']);
  assert.ok(estimate(steps) + overheadMin(steps) < TARGET_MIN);
  assert.deepEqual(steps.map(timeoutMs), steps.map(s => s.est * 120000));
  for (const step of steps.filter(s => !s.internal)) {
    assert.ok(step.args.includes('--owner-away'), step.id);
    assert.ok(existsSync(join(root, step.script)), step.script);
  }
  const ab = steps.find(s => s.id === 'speed-ab').args.join(' ');
  assert.match(ab, /--cursor-style ring --capture hidden --rounds 5 --tasks calculator-click,textedit-save,textedit-drag --model claude-haiku-5-5 --effort high --stop-on-owner/);
  assert.ok(steps.find(s => s.id === 'capture-sprite').args.includes('sprite'));
  assert.deepEqual([outcome(0, { measured: true }).done, outcome(1, { measured: true }).done], [true, true]);
  for (const [rc, extra] of [[0, {}], [1, {}], [5, {}], [9, {}], [129, {}], [null, { signal: 'SIGKILL' }], [0, { reason: 'timeout', measured: true }], [5, { reason: 'build' }]]) {
    const o = outcome(rc, extra);
    assert.deepEqual([o.done, o.failed], [false, true], `rc ${rc} ${JSON.stringify(extra)}`);
  }
  assert.match(outcome(1).status, /failed \(exit 1 without a result\)/);
  assert.equal(outcome(5, { reason: 'build' }).status, 'failed (build)');
  assert.equal(outcome(0, { reason: 'timeout' }).status, 'failed (timeout)');
  assert.equal(outcome(2).status, 'refused'); assert.equal(outcome(2).done, false);
  assert.equal(outcome(3).retry, true); assert.equal(outcome(4).stop, true);
  assert.equal(outcome(130, { reason: 'interrupted' }).stop, true);
  assert.equal(outcome(130, { reason: 'owner' }).status, 'stopped for the owner');
  assert.equal(outcome(130, { reason: 'hold' }).hold, true);
  const env = childEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_CONFIG_DIR: '/mine' }, '/tmp/lane-claude-1');
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/tmp/lane-claude-1', DISABLE_AUTOUPDATER: '1', SLEIGHT_NO_HUB: '1', SLEIGHT_REMOTE_APPROVALS: '0' });
  const ps = ['  10 /o/bin/consent-host --hand --capture=hidden --cursor-style=ring', '11 /o/bin/capture-recorder record /x', '12 /other/bin/consent-host --hand',
    '13 /o/binary/consent-host', ' 14 /o/bin/capture-helper watch-engine 50 30'].join('\n');
  assert.deepEqual(strays(ps, '/o/bin'), [{ pid: 10, command: 'consent-host' }, { pid: 11, command: 'capture-recorder' }, { pid: 14, command: 'capture-helper' }]);
  assert.deepEqual(descendants(['  1 0', '100 1', '101 100', '102 101', '103 100', '200 1'].join('\n'), 100), [101, 103, 102]);
  assert.deepEqual(childEnv({ PATH: '/bin' }, '/c', { tmp: '/o/tmp/capture-ring-1', charactersBase: privateTmp('sleight-vc7-night-1') }),
    { PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', DISABLE_AUTOUPDATER: '1', SLEIGHT_NO_HUB: '1', SLEIGHT_REMOTE_APPROVALS: '0', TMPDIR: '/o/tmp/capture-ring-1', VC7_CHARACTERS_BASE: privateTmp('sleight-vc7-night-1') });
  assert.equal(orphanedLock({ lockMtimeMs: 2000, attemptStartMs: 1000, alive: [false, false] }), true);
  assert.equal(orphanedLock({ lockMtimeMs: 500, attemptStartMs: 1000, alive: [false] }), false, 'a lock older than the attempt is someone else\'s');
  assert.equal(orphanedLock({ lockMtimeMs: 2000, attemptStartMs: 1000, alive: [false, true] }), false, 'a live process may still hold it');
  assert.equal(orphanedLock({ lockMtimeMs: undefined, attemptStartMs: 1000, alive: [] }), false);
  assert.deepEqual(launchedApps({ 'com.apple.TextEdit': [5], 'com.apple.calculator': [] }, { 'com.apple.TextEdit': [5, 9], 'com.apple.calculator': [12] }),
    [{ bundle: 'com.apple.TextEdit', pid: 9 }, { bundle: 'com.apple.calculator', pid: 12 }]);
  assert.deepEqual([HOLD_WAIT_MS, LOCK_WAIT_MS], [30 * 60000, 20 * 60000]);
  const forced = summaryMarkdown({ root: '/r', head: 'abcdef1234567890', out: '/o', startedAt: 'T' },
    { 'capture-ring': { status: 'passed', rc: 0, minutes: 2, cleanup: ['fixture TextEdit of capture-ring 42: quit', 'fixture TextEdit of capture-ring 43: terminated (SIGTERM)'] } }, steps);
  assert.match(forced, /needed a signal[^\n]*\n- capture-ring: fixture TextEdit of capture-ring 43: terminated \(SIGTERM\)/);
  assert.doesNotMatch(forced, /capture-ring 42: quit/);
  assert.equal(resultLine('x\nVC7 RESULT: one\nVC7 RESULT: two\n'), 'two');
  assert.equal(resultLine('VC7 INCOMPLETE: nope'), undefined);
  const md = summaryMarkdown({ root: '/r', head: 'abcdef1234567890', out: '/o', startedAt: 'T' }, { build: { status: 'passed', rc: 0, minutes: 1.5 } }, steps, { stoppedFor: 'the owner is back' });
  assert.match(md, /\| - \| build \| passed \| 0 \| 1.5 \|/);
  assert.match(md, /\| 4 \| speed-ab \| not run \|/);
  assert.match(md, /Stopped: the owner is back/);
  assert.deepEqual(nightArgs(['--dry-run', '--night', '/n']), { dryRun: true, fresh: false, night: '/n' });
  assert.throws(() => nightArgs(['--go']), /unknown option/);
  assert.throws(() => nightArgs(['x']), /unexpected argument/);
  const source = readFileSync(join(root, 'bench/hand/vc7-night.mjs'), 'utf8');
  assert.match(source, /spawn\('\/usr\/bin\/caffeinate', \[mode, '-w', String\(process\.pid\)\]/);
  assert.doesNotMatch(source, /awake\('-ims'\)/); assert.match(source, /holdSince \?\?= Date\.now\(\); lockSince = undefined; awake\('-dims'\)/);
  assert.match(source, /awake\('-dims'\)/); assert.match(source, /rmdirSync\(LOCK\)/); assert.doesNotMatch(source, /rmSync\(LOCK/);
  assert.match(source, /\['SIGINT', 130\], \['SIGTERM', 143\], \['SIGHUP', 129\]/);
  assert.doesNotMatch(source, /detached: true|pkill/);
});

test('fixture quit escalates: quit, SIGTERM, SIGKILL, by the launched pid and launch time only, with no System Events', async () => {
  const calls = [];
  const make = ({ quits = [], dies = 'never', startedMs = 10000 } = {}) => {
    let quit = 0, alive = true;
    return {
      live: { appState: async () => ({ running: alive, pids: alive ? [42] : [] }),
        quitApp: async (bundle, { pid }) => { calls.push(`quit ${pid}`); if (quits[quit++]) { alive = false; return; } throw new Error('quit unconfirmed'); } },
      kill: (pid, signal) => { calls.push(`${signal} ${pid}`); if (signal === dies || dies === 'SIGTERM' && signal === 'SIGKILL') alive = false; },
      alive: () => alive, sleep: async () => {}, started: async () => startedMs,
    };
  };
  assert.equal(await quitFixture({ bundle: 'b', pid: 42 }, make({ quits: [true] })), 'quit');
  calls.length = 0;
  assert.equal(await quitFixture({ bundle: 'b', pid: 42, startedAfterMs: 9000 }, make({ dies: 'SIGTERM' })), 'terminated (SIGTERM)');
  assert.deepEqual(calls, ['quit 42', 'SIGTERM 42']);
  calls.length = 0;
  assert.equal(await quitFixture({ bundle: 'b', pid: 42 }, make({ dies: 'SIGKILL' })), 'killed (SIGKILL)');
  assert.deepEqual(calls, ['quit 42', 'SIGTERM 42', 'SIGKILL 42']);
  calls.length = 0;
  const other = make();
  other.live.appState = async () => ({ running: true, pids: [77] });
  assert.equal(await quitFixture({ bundle: 'b', pid: 42 }, other), 'gone', 'another process is never signalled');
  assert.equal(await quitFixture({ bundle: 'b', pid: 42, startedAfterMs: 60000 }, make({ startedMs: 10000 })), 'gone', 'a pid that started before the launch is a reused pid');
  assert.deepEqual(calls, []);
  const source = readFileSync(join(root, 'bench/hand/vc7-live.mjs'), 'utf8');
  assert.doesNotMatch(source, /application "System Events"|osascript', \['-e'/);
  assert.equal(asideName('/r/record-ring', p => p === '/r/record-ring.partial-1'), '/r/record-ring.partial-2');
});

for (const [signal, expected] of [['SIGHUP', 129], ['SIGINT', 130]]) test(`${signal} in a check collects children and releases the lock before a runner hold wait`, async () => {
  const signals = new EventEmitter(), order = [];
  let exited;
  const done = underLiveLock({ acquire: async () => async () => order.push('unlock'), signals, exit: code => { exited = code; }, log: () => {} },
    async ({ cleanups }) => { cleanups.push(() => order.push('cleanup')); signals.emit(signal); await new Promise(r => setTimeout(r, 20)); return 0; });
  await done;
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(order, ['cleanup', 'unlock']);
  assert.equal(exited, expected);
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
    ['bench/hand/vc7-night.mjs', ['--night', night], /estimate \d+ min of steps plus about \d+ min of quiet gaps \(target under 90\)/],
  ]) {
    const run = spawnSync(process.execPath, [join(root, script), ...args, '--dry-run'], { cwd: root, encoding: 'utf8', timeout: 120000 });
    assert.equal(run.status, 0, `${script}: ${run.stderr}`);
    assert.match(run.stdout, /dry run/, script);
    assert.match(run.stdout, expect, script);
  }
  assert.equal(existsSync(join(night, 'vc7-state.json')), false, 'the dry run writes no state');
});

// The scripted frames through the real host's planner on a simulated clock: no application, panel or layer is made.
test('capture helper display refusal selftest draws nothing and needs no display query', { skip: macCommandSkip('xcrun') }, () => {
  const dir = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'vc7-preflight-test-')))), helper = join(dir, 'capture-helper');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), join(root, 'bench/hand/capture.swift'), '-o', helper], { encoding: 'utf8', timeout: 300000 });
  assert.equal(built.status, 0, built.stderr);
  for (const [state, expected] of [[{ asleep: false, locked: false }, null], [{ asleep: true, locked: false }, 'display-asleep'],
    [{ asleep: false, locked: true }, 'screen-locked'], [{ asleep: false }, 'screen-lock-state-unknown']]) {
    const p = spawnSync(helper, ['--display-selftest'], { input: JSON.stringify(state), encoding: 'utf8', timeout: 5000 });
    assert.equal(p.status, 0, p.stderr); assert.deepEqual(JSON.parse(p.stdout), { reason: expected, windowsCreated: 0 });
  }
});

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
