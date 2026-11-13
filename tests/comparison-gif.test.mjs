import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePlan, clockAt, makeHeader, buildComparison } from '../scripts/build-comparison-gif.mjs';

const metadata = { width: 160, height: 120, duration: 4, startTime: 0 };
function plan() {
  return {
    version: 1, task: 'calculator-click', taskSource: 'docs/results/native-claim.md',
    approval: { reference: 'owner-approved-pair', arms: ['sleight', 'claude-cu'] },
    endHoldSeconds: 1,
    recordings: ['sleight', 'claude-cu'].map((arm, i) => ({
      arm, label: i ? 'Claude computer use' : 'sleight', file: `${arm}.mkv`, task: 'calculator-click',
      singleWindow: true, recordingReference: `new-take-${i}`, model: 'claude-haiku-5-5',
      timing: { startSeconds: 0.2, finishSeconds: i ? 2.2 : 1.4, evidence: `timing-receipt-${i}` },
      redaction: { verified: true, reviewReference: `review-${i}`, crop: { x: 0, y: 10, width: 160, height: 110 },
        masks: [{ x: 0, y: 0, width: 8, height: 8 }] },
    })),
  };
}
const validated = value => validatePlan(value, [metadata, metadata]);
const temp = t => {
  const dir = mkdtempSync(join(tmpdir(), 'comparison gif test '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
function files(t) {
  const dir = temp(t), value = plan();
  value.recordings.forEach(r => writeFileSync(join(dir, r.file), 'synthetic-placeholder'));
  const path = join(dir, 'plan.json');
  writeFileSync(path, JSON.stringify(value));
  return { dir, value, path, output: join(dir, 'comparison.gif') };
}

test('aligns each explicit task start and holds each finished clock', () => {
  const p = validated(plan());
  assert.equal(p.duration, 3);
  assert.equal(p.recordings[0].elapsed, 1.2);
  assert.deepEqual(clockAt(p.recordings[0], 0.7), { seconds: 0.7, done: false, text: '0.7 S' });
  assert.deepEqual(clockAt(p.recordings[0], 1.8), { seconds: 1.2, done: true, text: 'DONE 1.2 S - HELD' });
  assert.deepEqual(clockAt(p.recordings[1], 1.8), { seconds: 1.8, done: false, text: '1.8 S' });
  assert.deepEqual(clockAt(p.recordings[1], 2.4), { seconds: 2, done: true, text: 'DONE 2.0 S - HELD' });
});

test('requires the approved pair, same task, single windows and recorded evidence', () => {
  for (const change of [
    p => { p.approval.arms.reverse(); },
    p => { p.recordings[1].task = 'other'; },
    p => { p.recordings[0].singleWindow = false; },
    p => { p.recordings[0].timing.evidence = ''; },
    p => { p.recordings[0].recordingReference = ''; },
    p => { p.recordings[1].arm = 'sleight'; },
    p => { p.recordings.push(p.recordings[0]); },
  ]) {
    const p = plan(); change(p); assert.throws(() => validated(p));
  }
});

test('rejects malformed, reversed, out-of-recording and excessive timings', () => {
  for (const [startSeconds, finishSeconds] of [[-1, 1], [1, 1], [2, 1], ['0', 1], [0, NaN], [0, 4.1], [0, 181]]) {
    const p = plan(); Object.assign(p.recordings[0].timing, { startSeconds, finishSeconds });
    assert.throws(() => validated(p));
  }
  const p = plan(); p.endHoldSeconds = 0; assert.throws(() => validated(p));
  assert.throws(() => validatePlan(plan(), [{ ...metadata, startTime: 3 }, metadata]));
});

test('requires reviewed redaction and rejects masks outside the crop', () => {
  for (const change of [
    r => { r.verified = false; }, r => { r.reviewReference = ''; }, r => { delete r.masks; },
    r => { r.crop.width = 161; }, r => { r.crop.x = -1; },
    r => { r.masks[0].width = 0; }, r => { r.masks[0].x = 155; },
    r => { r.masks[0].y = 109; }, r => { r.masks[0].x = 0.1; },
  ]) {
    const p = plan(); change(p.recordings[0].redaction); assert.throws(() => validated(p));
  }
});

test('refuses unsupported labels and cannot pass filter syntax through labels', () => {
  const p = plan(); p.recordings[0].label = 'hello:drawtext=evil'; assert.throws(() => validated(p));
});

test('bitmap headers show a different actual elapsed clock and freeze after completion', () => {
  const p = validated(plan());
  assert.notDeepEqual(makeHeader(p, 320, 0), makeHeader(p, 320, 0.8));
  assert.deepEqual(makeHeader(p, 320, 2.1), makeHeader(p, 320, 2.9));
  assert.equal(makeHeader(p, 320, 0).subarray(0, 10).toString(), 'P4\n640 64\n');
});

test('missing input and overwrite refuse before probing and preserve existing data', async t => {
  const f = files(t);
  rmSync(join(f.dir, 'sleight.mkv'));
  await assert.rejects(buildComparison(f.path, f.output), /regular file|missing/i);
  writeFileSync(f.output, 'keep');
  await assert.rejects(buildComparison(f.path, f.output), /exists/i);
  assert.equal(readFileSync(f.output, 'utf8'), 'keep');
});

test('rejects symlink inputs and duplicate footage', async t => {
  const f = files(t);
  rmSync(join(f.dir, 'claude-cu.mkv'));
  symlinkSync(join(f.dir, 'sleight.mkv'), join(f.dir, 'claude-cu.mkv'));
  await assert.rejects(buildComparison(f.path, f.output), /regular file/i);
  f.value.recordings[1].file = 'sleight.mkv'; writeFileSync(f.path, JSON.stringify(f.value));
  await assert.rejects(buildComparison(f.path, f.output), /distinct/i);
});

test('strict decimal byte limit refuses all bounded attempts and cleans staging', async t => {
  const f = files(t);
  const run = async (command, args) => {
    if (command === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 160, height: 120,
      duration: '4', start_time: '0' }] }) };
    writeFileSync(args.at(-1), Buffer.alloc(5_000_000));
    return { stdout: '' };
  };
  await assert.rejects(buildComparison(f.path, f.output, { run }), /3 attempts.*5,000,000/);
  assert.equal(existsSync(f.output), false);
  assert.deepEqual(readdirSync(f.dir).sort(), ['claude-cu.mkv', 'plan.json', 'sleight.mkv']);
});

test('oversize first profile retries without shortening elapsed time', async t => {
  const f = files(t);
  let renders = 0;
  const run = async (command, args) => {
    if (command === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 160, height: 120,
      duration: '4', start_time: '0' }] }) };
    assert.equal(args[args.indexOf('-t') + 1], '3');
    writeFileSync(args.at(-1), Buffer.alloc(++renders === 1 ? 5_000_000 : 4_999_999));
    return { stdout: '' };
  };
  const result = await buildComparison(f.path, f.output, { run });
  assert.equal(result.attempts, 2);
  assert.equal(result.panelWidth, 480);
  assert.equal(result.duration, 3);
  assert.equal(readFileSync(f.output).length, 4_999_999);
});

test('malformed or rotated probe metadata refuses before encoding', async t => {
  const f = files(t);
  for (const response of ['not json', JSON.stringify({ streams: [] }),
    JSON.stringify({ streams: [{ codec_type: 'video', width: 160, height: 120, duration: '4',
      start_time: '0', side_data_list: [{ rotation: 90 }] }] })]) {
    await assert.rejects(buildComparison(f.path, f.output, { run: async command => {
      assert.equal(command, 'ffprobe'); return { stdout: response };
    } }));
    assert.equal(existsSync(f.output), false);
  }
});

test('encoder failure removes private headers and leaves no output', async t => {
  const f = files(t);
  await assert.rejects(buildComparison(f.path, f.output, { run: async command => {
    if (command === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 160, height: 120,
      duration: '4', start_time: '0' }] }) };
    throw Error('synthetic encoder failure');
  } }), /synthetic encoder failure/);
  assert.equal(existsSync(f.output), false);
  assert.deepEqual(readdirSync(f.dir).sort(), ['claude-cu.mkv', 'plan.json', 'sleight.mkv']);
});

test('concurrent output creation cannot be overwritten', async t => {
  const f = files(t);
  const run = async (command, args) => {
    if (command === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 160, height: 120,
      duration: '4', start_time: '0' }] }) };
    writeFileSync(args.at(-1), 'GIF89a'); writeFileSync(f.output, 'concurrent owner');
    return { stdout: '' };
  };
  await assert.rejects(buildComparison(f.path, f.output, { run }), /EEXIST/);
  assert.equal(readFileSync(f.output, 'utf8'), 'concurrent owner');
});

let installed = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); }
catch { installed = false; }

test('synthetic clips render with spaces, pixel masks, honest GIF duration and no input metadata', { skip: !installed }, async t => {
  const f = files(t);
  for (const [i, r] of f.value.recordings.entries()) {
    r.file = `synthetic ${i} $(touch NEVER).mkv`;
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i',
      `color=c=${i ? 'blue' : 'red'}:s=160x120:r=10:d=3`,
      ...(i ? [] : ['-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=yellow:t=fill:enable='gte(t,1.4)'"]),
      '-metadata', 'title=PRIVATE SYNTHETIC NAME',
      '-c:v', 'ffv1', join(f.dir, r.file)]);
  }
  writeFileSync(f.path, JSON.stringify(f.value));
  const result = await buildComparison(f.path, f.output);
  assert.ok(result.bytes < 5_000_000);
  assert.equal(result.duration, 3);
  assert.equal(result.requiresHumanPreview, true);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', f.output]));
  assert.ok(Math.abs(Number(probe.format.duration) - 3) <= 0.011);
  assert.equal(probe.streams[0].width, 1280);
  assert.equal(JSON.stringify(probe).includes('PRIVATE SYNTHETIC NAME'), false);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', f.output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 8_000_000 });
  const pixel = (x, y) => [...raw.subarray((y * 1280 + x) * 3, (y * 1280 + x) * 3 + 3)];
  assert.deepEqual(pixel(8, 72), [0, 0, 0]);
  assert.ok(pixel(150, 150)[0] > 200);
  const held = execFileSync('ffmpeg', ['-v', 'error', '-ss', '2.5', '-i', f.output, '-frames:v', '1', '-f', 'rawvideo',
    '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 8_000_000 });
  const offset = (150 * 1280 + 150) * 3;
  assert.ok(held[offset] > 200 && held[offset + 1] > 200,
    `completion frame must be yellow throughout its hold, got ${[...held.subarray(offset, offset + 3)]}`);
  assert.equal(existsSync(join(f.dir, 'NEVER')), false);
});

test('non-grid completion holds the true source frame without showing later frames or advancing early', { skip: !installed }, async t => {
  const f = files(t);
  f.value.recordings[0].timing.finishSeconds = 1.45;
  for (const [i, r] of f.value.recordings.entries()) {
    // Red before completion, yellow exactly at 1.45, green afterwards. Only yellow may be held.
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
      `color=c=${i ? 'blue' : 'red'}:s=160x120:r=20:d=3`,
      ...(i ? [] : ['-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=yellow:t=fill:enable='eq(n,29)',drawbox=x=0:y=0:w=iw:h=ih:color=green:t=fill:enable='gt(n,29)'"]),
      '-c:v', 'ffv1', join(f.dir, r.file)]);
  }
  writeFileSync(f.path, JSON.stringify(f.value));
  await buildComparison(f.path, f.output);
  const sample = time => {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', f.output, '-frames:v', '1', '-f', 'rawvideo',
      '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 8_000_000 });
    return [...raw.subarray((150 * 1280 + 150) * 3, (150 * 1280 + 150) * 3 + 3)];
  };
  const before = sample(1.2);
  assert.ok(before[0] > 200 && before[1] < 30, `completion must not show before its timestamp: ${before}`);
  for (const time of [1.3, 2.5]) {
    const held = sample(time);
    assert.ok(held[0] > 200 && held[1] > 200, `hold at ${time} must preserve yellow, never precompletion red or future green: ${held}`);
  }
});

test('non-grid start uses the frame covering measured zero without revealing the next source frame early', { skip: !installed }, async t => {
  const f = files(t);
  f.value.recordings[0].timing.startSeconds = 0.23;
  f.value.recordings[0].timing.finishSeconds = 1.45;
  for (const [i, r] of f.value.recordings.entries()) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
      `color=c=${i ? 'blue' : 'red'}:s=160x120:r=20:d=3`,
      ...(i ? [] : ['-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=yellow:t=fill:enable='gte(n,5)'"]),
      '-c:v', 'ffv1', join(f.dir, r.file)]);
  }
  writeFileSync(f.path, JSON.stringify(f.value));
  await buildComparison(f.path, f.output);
  for (const [time, isYellow] of [[0, false], [0.1, true]]) {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', f.output, '-frames:v', '1', '-f', 'rawvideo',
      '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 8_000_000 });
    const offset = (150 * 1280 + 150) * 3;
    assert.ok(raw[offset] > 200);
    assert.equal(raw[offset + 1] > 200, isYellow, `frame at ${time} must respect the measured 0.23 start`);
  }
});
