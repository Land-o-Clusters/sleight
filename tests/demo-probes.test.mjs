import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { pixelDelta, requiredProbes, verifyDrawing } from '../bench/demo/probes.mjs';
import * as probes from '../bench/demo/probes.mjs';

const width = 80, height = 60;
function paint(data, box, rgb) {
  const out = Buffer.from(data);
  for (let y = box[1]; y < box[1] + box[3]; y++) for (let x = box[0]; x < box[0] + box[2]; x++) out.set(rgb, (y * width + x) * 3);
  return out;
}
test('drawing probes reject a blank frame, fixture movement elsewhere, and button text inside the ring', () => {
  const base = Buffer.alloc(width * height * 3, 245), ring = [10, 10, 40, 30], inside = [15, 15, 30, 20];
  for (const sample of [base, paint(base, [60, 40, 10, 10], [30, 100, 240]), paint(base, [20, 20, 10, 10], [50, 140, 250])]) {
    const result = pixelDelta(base, sample, width, height, ring, 'ring', inside);
    assert.equal(result.passed, false, JSON.stringify(result));
  }
  const sample = paint(base, [10, 10, 4, 20], [91, 141, 255]);
  assert.equal(pixelDelta(base, sample, width, height, ring, 'ring', inside).passed, true);
});
test('sprite and bubble probes need their own regions and colour rules', () => {
  const base = Buffer.alloc(width * height * 3, 245), sprite = [10, 10, 20, 20], bubble = [40, 10, 20, 20];
  const character = paint(base, sprite, [80, 95, 230]);
  assert.equal(pixelDelta(base, character, width, height, sprite, 'sprite').passed, true);
  assert.equal(pixelDelta(base, character, width, height, bubble, 'bubble').passed, false);
  const both = paint(character, [40, 10, 10, 10], [30, 30, 30]);
  assert.equal(pixelDelta(base, both, width, height, bubble, 'bubble').passed, true);
  assert.equal(pixelDelta(base, both, width, height, bubble, 'sprite').passed, false);
  assert.throws(() => pixelDelta(base, base.subarray(1), width, height, sprite, 'sprite'));
});
test('every shot requires ring ink; characters and narration have independent requirements', () => {
  assert.deepEqual(requiredProbes('01-ring'), ['ring']);
  assert.deepEqual(requiredProbes('02-states'), ['ring']);
  for (const id of ['03-tsugi', '03-kit', '05-picker', '06-import']) assert.deepEqual(requiredProbes(id), ['ring', 'sprite']);
  assert.deepEqual(requiredProbes('04-narration'), ['ring', 'bubble']);
});
test('import sprite probe excludes button wrap ink when the pet never draws', () => {
  const p = probes.importSpriteProbe([260, 438], [200, 420, 120, 36], [80, 408, 640, 322], { frame: { w: 192, h: 208 }, scale: 0.5 });
  assert.deepEqual(p.region, [278, 456, 96, 104]);
  assert.deepEqual(p.exclude, [170, 390, 180, 96]);
  const w = 800, h = 740, base = Buffer.alloc(w * h * 3, 245), ringOnly = Buffer.from(base);
  for (let y = 460; y < 466; y++) for (let x = 278; x < 330; x++) ringOnly.set([91, 141, 255], (y * w + x) * 3);
  assert.equal(pixelDelta(base, ringOnly, w, h, p.region, 'sprite').passed, true);
  assert.equal(pixelDelta(base, ringOnly, w, h, p.region, 'sprite', p.exclude).passed, false);
  const petDraws = Buffer.from(ringOnly);
  for (let y = 492; y < 512; y++) for (let x = 310; x < 330; x++) petDraws.set([80, 95, 230], (y * w + x) * 3);
  assert.equal(pixelDelta(base, petDraws, w, h, p.region, 'sprite', p.exclude).passed, true);
  assert.deepEqual(probes.importSpriteProbe([700, 700], [640, 682, 120, 36], [80, 408, 640, 322], { frame: { w: 192, h: 208 }, scale: 0.5 }).region, [586, 578, 96, 104]);
});
test('probe extraction uses recorder clock and owned source, and a missing sprite fails despite ring pixels', async t => {
  const directory = registerTemp(t, mkdtempSync(join(tmpdir(), 'dm1-probes-'))), first = Date.parse('2026-10-26T12:00:00Z');
  const base = Buffer.alloc(width * height * 3, 245), ring = paint(base, [10, 10, 10, 10], [91, 141, 255]);
  const frames = { 'probe-baseline.rgb': base, 'probe-ring.rgb': ring, 'probe-sprite.rgb': base }, commands = [];
  const children = { run: async (cmd, args) => { commands.push(args); writeFileSync(args.at(-1), frames[basename(args.at(-1))]); } };
  const capture = { wallClockStart: new Date(first).toISOString(), seconds: 18,
    probePlan: { width, height, baselineAt: first + 500, samples: [
      { kind: 'ring', at: first + 2000, region: [10, 10, 20, 20] },
      { kind: 'sprite', at: first + 2000, region: [40, 10, 20, 20] },
    ] } };
  await assert.rejects(verifyDrawing(children, directory, { id: '03-tsugi' }, capture), /Drawing absent: sprite=0/);
  frames['probe-sprite.rgb'] = paint(base, [40, 10, 10, 10], [80, 95, 230]);
  const result = await verifyDrawing(children, directory, { id: '03-tsugi' }, capture);
  assert.equal(result.passed, true); assert.equal(result.results.length, 2);
  assert.ok(commands.every(c => c[c.indexOf('-i') + 1] === join(directory, 'take.mov')));
  assert.ok(commands.some(c => c[c.indexOf('-ss') + 1] === '0.500'));
  assert.deepEqual(readFileSync(join(directory, 'probe-baseline.rgb')), base);
});
