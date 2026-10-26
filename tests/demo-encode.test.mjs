import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { Children, encode, gifFits } from '../bench/demo/capture.mjs';

const ffmpeg = spawnSync('ffmpeg', ['-version'], { timeout: 3000, stdio: 'ignore' });
test('encoder cuts synthetic color frames to eight seconds at 2x without a screen or window', { skip: ffmpeg.status !== 0 }, async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-dm1-encode-'))), children = new Children(process.env);
  try {
    await children.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-f', 'lavfi', '-i', 'color=c=0x3050a0:s=96x64:r=2:d=18', '-an', '-c:v', 'libx264', '-threads', '1', join(dir, 'take.mov')]);
    const result = await encode(children, dir);
    assert.equal(result.frames, 240); assert.equal(result.seconds, 8); assert.equal(result.fps, 30);
    assert.equal(result.gifFps, 12); assert.ok(gifFits(result.gifBytes));
    assert.equal(result.gifBytes, statSync(join(dir, 'demo.gif')).size);
    assert.equal(result.mp4Bytes, statSync(join(dir, 'demo.mp4')).size);
    assert.ok(statSync(join(dir, 'poster.png')).size > 0);
    t.diagnostic(`syntheticOnly=true gifBytes=${result.gifBytes} mp4Bytes=${result.mp4Bytes} frames=${result.frames}`);
  } finally { await children.close(); }
});
