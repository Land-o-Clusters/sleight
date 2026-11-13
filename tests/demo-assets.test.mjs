// The README's static assets (H5): the architecture diagram pair and the demo cut from a cap1 take.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { SPEC, composeFilter, makeDemo, planDemo } from '../bench/capture/demo-gif.mjs';

const run = promisify(execFile);
const root = new URL('..', import.meta.url).pathname;
const svgPath = theme => join(root, 'docs/assets', `architecture-${theme}.svg`);

for (const theme of ['light', 'dark']) {
  test(`architecture-${theme}.svg is a self-contained, labelled image under 40 KB`, () => {
    const text = readFileSync(svgPath(theme), 'utf8');
    assert.ok(statSync(svgPath(theme)).size < 40 * 1024);
    assert.match(text, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
    assert.match(text, /<title id="title">[^<]+<\/title>/);
    assert.match(text, /<desc id="desc">[^<]+<\/desc>/);
    assert.match(text, /role="img" aria-labelledby="title desc"/);
    // The SVG namespace is the only URL; nothing loads, runs or embeds a raster.
    assert.equal(text.replace('xmlns="http://www.w3.org/2000/svg"', '').match(/https?:/g), null);
    for (const banned of ['<script', '<image', '<foreignObject', 'data:', '@import', '<style', 'xlink:href="http']) {
      assert.equal(text.includes(banned), false, `${theme} contains ${banned}`);
    }
    for (const label of ['Claude Code', 'Codex', 'Cursor', 'sleight', 'computer-use engine', 'Chrome, Helium', 'turbo',
      'clicks, keys,', 'Chrome DevTools Protocol on 127.0.0.1']) {
      assert.ok(text.includes(label), `${theme} lacks ${label}`);
    }
    assert.ok(text.includes('id="mark"') && text.includes('href="#mark"'), 'the two-hands mark is on the sleight box');
    // Balanced elements: every opening tag that isn't self-closed has its close.
    const opens = [...text.matchAll(/<([a-zA-Z]+)\b[^>]*?(\/?)>/g)].filter(m => !m[2]).map(m => m[1]);
    const closes = [...text.matchAll(/<\/([a-zA-Z]+)>/g)].map(m => m[1]);
    assert.deepEqual(opens.sort(), closes.sort());
    assert.equal([...text.matchAll(/<text\b[^>]*><\/text>/g)].length, 0, 'no empty <text>');
  });
}

test('the light and dark diagrams differ only in colour tokens, on the plan palette', () => {
  const [light, dark] = ['light', 'dark'].map(theme => readFileSync(svgPath(theme), 'utf8'));
  const tokenless = text => text.replace(/#[0-9A-Fa-f]{6}\b/g, '#');
  assert.equal(tokenless(light), tokenless(dark));
  assert.match(light, /<rect width="\d+" height="\d+" fill="#FBF8F1"\/>/);
  assert.match(dark, /<rect width="\d+" height="\d+" fill="#141A26"\/>/);
  for (const text of [light, dark]) assert.ok(text.includes('#E8622C') && text.includes('#EFE9DC'), 'ember and ivory');
});

// sync.json the way bench/capture/recorder.swift writes it.
const stream = (name, extra = {}) => ({
  name, file: `${name}.mov`, composite: false, frames: 300, droppedFrames: 0, idleFrames: 0, blankFrames: 0, suspendedFrames: 0,
  firstFrameHostTime: 1000, scale: 2, sizePt: { width: 320, height: 200 }, sizePx: { width: 640, height: 400 },
  wallClockStart: '2026-10-19T15:15:53.444Z', writer: 'completed',
  windows: [{ app: 'Chess', id: 1, pid: 2, title: 'Game 1 | Pat Example - Auto-Match Player' }], ...extra,
});
const take = (streams, stop = 1010) => ({ version: 1, codec: 'prores422hq', fps: 60, hostClock: 'CMClockGetHostTimeClock',
  stopHostTime: stop, stoppedBy: 'duration', streams });

test('planDemo lays every stream out in two columns, 900 px wide, aligned on the host clock', () => {
  const plan = planDemo(take([stream('front'), stream('back', { firstFrameHostTime: 1000.4 })]), undefined, { start: 0.3, duration: 9 });
  assert.equal(plan.width, 900);
  assert.equal(plan.zero, 1000.4);
  assert.deepEqual(plan.tiles.map(t => Number(t.seek.toFixed(3))), [0.7, 0.3]);
  // Title bar cropped (33 pt at scale 2), cell width (900 - 3 × 6) / 2 rounded down to even.
  assert.deepEqual(plan.tiles[0].crop, { x: 0, y: 66, width: 640, height: 334 });
  assert.deepEqual(plan.tiles[0].cell, { x: 6, y: 6, width: 440, height: 228 });
  assert.deepEqual(plan.tiles[1].cell, { x: 452, y: 6, width: 440, height: 228 });
  assert.equal(plan.height, 240);
  assert.ok(plan.tiles.every(t => t.titleCropped));
});

test('planDemo refuses a cut that would show a window title, the hand panel alone, or a composite without a crop', () => {
  const sync = take([stream('chess'), stream('hand', { sizePt: { width: 1, height: 1 }, sizePx: { width: 2, height: 2 }, windows: [] }),
    stream('hand-over-chess', { composite: true })]);
  assert.throws(() => planDemo(sync, { tiles: [{ stream: 'chess', crop: { top: 0 } }] }), /title bar/);
  assert.throws(() => planDemo(sync, { tiles: [{ stream: 'chess', crop: { top: 27 } }] }), /title bar/);
  assert.equal(planDemo(sync, { tiles: [{ stream: 'chess', crop: { top: 0 }, keepTitle: true }] }).tiles[0].titleCropped, false);
  assert.throws(() => planDemo(sync, { tiles: [{ stream: 'hand' }] }), /too small for a tile/);
  assert.throws(() => planDemo(sync, { tiles: [{ stream: 'hand-over-chess' }] }), /composite/);
  assert.equal(planDemo(sync, { tiles: [{ stream: 'hand-over-chess', crop: { top: 40, left: 10 } }] }).tiles[0].crop.x, 20);
});

test('planDemo holds the cut to 8 to 12 s inside the take, and refuses a broken stream', () => {
  const sync = take([stream('a'), stream('b', { firstFrameHostTime: 1001 })]);
  assert.throws(() => planDemo(sync, undefined, { duration: 7 }), /8 to 12 s/);
  assert.throws(() => planDemo(sync, undefined, { duration: 13 }), /8 to 12 s/);
  assert.throws(() => planDemo(sync, undefined, { start: 0.5, duration: 9 }), /the take has 9\.00 s/);
  assert.throws(() => planDemo(take([stream('a', { writer: 'status-3' })])), /writer status/);
  assert.throws(() => planDemo(sync, { tiles: [{ stream: 'nope' }] }), /no stream named "nope"/);
  assert.throws(() => planDemo(sync, { tiles: [{ stream: 'a', scrub: [{ x: 1, y: 1, width: 0, height: 4 }] }] }), /scrub box 1/);
});

test('composeFilter repeats frames before trimming, then scrubs before cropping', () => {
  const plan = planDemo(take([stream('a')]), { tiles: [{ stream: 'a', scrub: [{ x: 250, y: 40, width: 20, height: 20, color: '#808080' }] }] },
    { start: 1, duration: 8 });
  const graph = composeFilter(plan, 30);
  const chain = graph.split(';').find(part => part.startsWith('[0:v]'));
  const order = ['fps=30', 'trim=start=1.0000:duration=8', 'setpts=PTS-STARTPTS', 'drawbox=x=500:y=80:w=40:h=40:color=0x808080@1:t=fill', 'crop=640:334:0:66'];
  let at = -1;
  for (const step of order) { const next = chain.indexOf(step); assert.ok(next > at, `${step} out of order in ${chain}`); at = next; }
  assert.match(graph, /color=c=0x141A26:s=900x\d+:r=30:d=8\[base\]/);
});

let ffmpegOk = true;
try { execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }); } catch { ffmpegOk = false; }

// A synthetic take: two 640 by 400 px windows at scale 2 with a red title bar (28 pt), and a green square to scrub in
// "front". "back"
// starts 0.4 s later and writes only 2 frames a second, the way a still window does, so the cut's first frame must reuse
// a frame recorded before it.
async function syntheticTake(dir) {
  const clip = (name, base, rate, seconds, square) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${base}:s=640x400:r=${rate}:d=${seconds}`,
    '-f', 'lavfi', '-i', `color=c=0xFF0000:s=640x56:r=${rate}:d=${seconds}`,
    '-f', 'lavfi', '-i', `testsrc2=s=640x160:r=${rate}:d=${seconds}`,
    '-f', 'lavfi', '-i', `color=c=${square ? '0x00FF00' : base}:s=40x40:r=${rate}:d=${seconds}`,
    '-filter_complex', '[2]hue=s=0[g];[0][1]overlay=0:0[a];[a][g]overlay=0:200[b];[b][3]overlay=500:80',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', join(dir, `${name}.mov`)]);
  await clip('front', '0x808080', 30, 10, true);
  await clip('back', '0x3050C0', 2, 9.6, false);
  writeFileSync(join(dir, 'sync.json'), JSON.stringify(take([stream('front'), stream('back', { firstFrameHostTime: 1000.4, frames: 20 })])));
}

async function firstFrame(file) {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo',
    '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(stdout);
}
const count = (rgb, match) => { let n = 0; for (let i = 0; i < rgb.length; i += 3) if (match(rgb[i], rgb[i + 1], rgb[i + 2])) n++; return n; };
const red = (r, g, b) => r > 180 && g < 80 && b < 80;
const green = (r, g, b) => g > 180 && r < 80 && b < 80;
const pixel = (rgb, width, x, y) => [...rgb.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];

test('makeDemo turns a synthetic take into a 900 px, 12 fps GIF under 5 MB and a silent mp4, titles and scrub boxes gone',
  { skip: !ffmpegOk && 'ffmpeg is not installed', timeout: 180_000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'sleight-demo-test-'));
    registerTemp(t, dir);
    await syntheticTake(dir);
    const layout = { tiles: [{ stream: 'front', scrub: [{ x: 250, y: 40, width: 20, height: 20 }] }, { stream: 'back' }] };
    const report = await makeDemo(dir, { layout, start: 0.3, duration: 9, out: join(dir, 'demo') });

    const gif = await probe(report.gif.path);
    assert.equal(gif.streams[0].codec_name, 'gif');
    assert.equal(gif.streams[0].width, SPEC.width);
    assert.equal(gif.streams[0].height, 240);
    assert.equal(gif.streams[0].r_frame_rate, '12/1');
    assert.ok(Math.abs(Number(gif.format.duration) - 9) < 0.2, `GIF runs ${gif.format.duration} s`);
    assert.ok(report.gif.bytes < SPEC.maxBytes);

    const mp4 = await probe(report.mp4.path);
    assert.deepEqual(mp4.streams.map(s => s.codec_type), ['video']);
    assert.equal(mp4.streams[0].codec_name, 'h264');
    assert.equal(mp4.streams[0].width, SPEC.width);
    assert.ok(Math.abs(Number(mp4.format.duration) - 9) < 0.2, `mp4 runs ${mp4.format.duration} s`);

    for (const file of [report.mp4.path, report.gif.path]) {
      const rgb = await firstFrame(file);
      assert.equal(count(rgb, red), 0, `${file} shows the title bar`);
      assert.equal(count(rgb, green), 0, `${file} shows the scrubbed square`);
      // The sparse stream's tile holds its picture from the first frame: blue, not the navy background.
      const [r, g, b] = pixel(rgb, SPEC.width, 452 + 220, 6 + 60);
      assert.ok(b > 150 && r < 100, `back tile at the first frame is ${[r, g, b]}`);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'demo', 'demo.json'), 'utf8')).tiles.map(tile => tile.scrubBoxes), [1, 0]);

    // Control: the same take with the title kept and no scrub shows both, so the checks above can fail.
    const control = await makeDemo(dir, { layout: { tiles: [{ stream: 'front', crop: { top: 0 }, keepTitle: true }, { stream: 'back' }] },
      start: 0.3, duration: 9, out: join(dir, 'control') });
    const rgb = await firstFrame(control.mp4.path);
    assert.ok(count(rgb, red) > 1000, 'control shows the red title bar');
    assert.ok(count(rgb, green) > 50, 'control shows the green square');
  });
