import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { Children, encode, gifFits } from '../bench/demo/capture.mjs';
import { verifyDrawing } from '../bench/demo/probes.mjs';
import * as demo from '../bench/demo/capture.mjs';

const ffmpeg = spawnSync('ffmpeg', ['-version'], { timeout: 3000, stdio: 'ignore' });
test('encoder cuts synthetic color frames to eight seconds at 2x without a screen or window', { skip: ffmpeg.status !== 0 }, async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-dm1-encode-'))), children = new Children(process.env);
  try {
    await children.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-f', 'lavfi', '-i', 'color=c=0x3050a0:s=96x64:r=2:d=18', '-an', '-c:v', 'libx264', '-threads', '1', join(dir, 'take.mov')]);
    const result = await encode(children, dir);
    assert.equal(result.frames, 240); assert.equal(result.seconds, 8); assert.equal(result.fps, 30);
    assert.equal(result.gifFps, 20); assert.ok(gifFits(result.gifBytes));
    assert.equal(result.gifBytes, statSync(join(dir, 'demo.gif')).size);
    assert.equal(result.mp4Bytes, statSync(join(dir, 'demo.mp4')).size);
    assert.ok(statSync(join(dir, 'poster.png')).size > 0);
    t.diagnostic(`syntheticOnly=true gifBytes=${result.gifBytes} mp4Bytes=${result.mp4Bytes} frames=${result.frames}`);
  } finally { await children.close(); }
});

test('ffmpeg drawing probes read authored colour frames and reject a blank baseline as a sprite', { skip: ffmpeg.status !== 0 }, async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-dm1-probe-encode-'))), children = new Children(process.env);
  try {
    await children.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_threads', '1',
      '-f', 'lavfi', '-i', 'color=c=white:s=80x60:r=4:d=3', '-vf',
      "drawbox=x=10:y=10:w=8:h=10:color=0x5b8dff:t=fill:enable='gte(t,1)',drawbox=x=40:y=10:w=10:h=10:color=0x505fe6:t=fill:enable='gte(t,1)',drawbox=x=60:y=10:w=15:h=10:color=black:t=fill:enable='gte(t,1)'",
      '-an', '-c:v', 'libx264', '-threads', '1', '-crf', '0', join(dir, 'take.mov')]);
    const first = Date.parse('2026-10-26T12:00:00Z'), capture = { seconds: 3, wallClockStart: new Date(first).toISOString(),
      probePlan: { width: 80, height: 60, baselineAt: first + 500, samples: [
        { kind: 'ring', at: first + 2000, region: [10, 10, 8, 10] },
        { kind: 'sprite', at: first + 2000, region: [40, 10, 10, 10] },
        { kind: 'bubble', at: first + 2000, region: [60, 10, 15, 10] },
      ] } };
    for (const id of ['03-tsugi', '04-narration']) assert.equal((await verifyDrawing(children, dir, { id }, capture)).passed, true);
    capture.probePlan.samples.find(s => s.kind === 'sprite').at = first + 500;
    await assert.rejects(verifyDrawing(children, dir, { id: '03-tsugi' }, capture), /Drawing absent: sprite=0/);
  } finally { await children.close(); }
});

test('a missing imported pet preserves every probe result and encoded clip before failing the shot', { skip: ffmpeg.status !== 0 }, async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-dm1-failed-probe-'))), children = new Children(process.env);
  try {
    // Ring ink crosses the old pet region; no character pixels ever draw.
    await children.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_threads', '1',
      '-f', 'lavfi', '-i', 'color=c=white:s=80x60:r=2:d=18', '-vf',
      "drawbox=x=10:y=10:w=40:h=30:color=0x5b8dff:t=3:enable='gte(t,1)'",
      '-an', '-c:v', 'libx264', '-threads', '1', '-crf', '0', join(dir, 'take.mov')]);
    const first = Date.parse('2026-10-26T12:00:00Z');
    const capture = { seconds: 18, wallClockStart: new Date(first).toISOString(),
      probePlan: { width: 80, height: 60, baselineAt: first + 500, samples: [
        { kind: 'ring', at: first + 2000, region: [10, 10, 40, 30] },
        { kind: 'sprite', at: first + 2000, region: [30, 30, 30, 25], exclude: [0, 0, 55, 45] },
      ] } };
    await assert.rejects(demo.processTake(children, dir, { id: '06-import' }, capture), /Drawing absent: sprite=0/);
    const probes = JSON.parse(readFileSync(join(dir, 'probes.json')));
    assert.equal(probes.passed, false); assert.deepEqual(probes.results.map(r => [r.kind, r.passed]), [['ring', true], ['sprite', false]]);
    assert.equal(probes.results[1].painted, 0);
    for (const name of ['demo.mp4', 'demo.gif', 'poster.png']) assert.ok(statSync(join(dir, name)).size > 0, name);
    assert.equal(probes.results[1].exclude.length, 4);
    t.diagnostic(`missingPet=true probes=2 gifBytes=${statSync(join(dir, 'demo.gif')).size} mp4Bytes=${statSync(join(dir, 'demo.mp4')).size}`);
  } finally { await children.close(); }
});
