import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macCommandSkip } from './requirements.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

// Only the refusals that come before ScreenCaptureKit is touched, and the encoder check. Nothing here records the screen
// or lists windows.
test('capture recorder compiles and refuses bad plans before any capture call', { skip: macCommandSkip('xcrun') }, t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-capture-recorder-')));
  const binary = join(dir, 'capture-recorder');
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(),
    'bench/capture/recorder.swift', '-o', binary], { encoding: 'utf8', timeout: 240000 });
  assert.equal(build.status, 0, build.stderr);
  // The source never builds a whole-display filter (display minus some windows or apps).
  assert.doesNotMatch(readFileSync('bench/capture/recorder.swift', 'utf8'), /excludingWindows|excludingApplications/);

  const usage = spawnSync(binary, [], { encoding: 'utf8', timeout: 5000 });
  assert.equal(usage.status, 2);
  assert.equal(JSON.parse(usage.stdout).error, 'usage');

  const out = join(dir, 'out');
  const base = { version: 1, out: dir, fps: 60, codec: 'prores422hq', streams: [{ name: 'a', windows: [11], composite: false }] };
  const cases = [
    [{ streams: [] }, 'no-window'],
    [{ streams: [{ name: 'a', windows: [], composite: false }] }, 'no-window'],
    [{ streams: [{ name: 'a', windows: [11, 12], composite: false }] }, 'bad-stream'],
    [{ streams: [{ name: 'a', windows: [11], composite: true }] }, 'bad-stream'],
    [{ streams: [{ name: '../a', windows: [11], composite: false }] }, 'bad-stream'],
    [{ streams: [{ name: 'a', windows: [0], composite: false }] }, 'bad-stream'],
    [{ out: 'relative' }, 'bad-out'],
    [{ out }, 'bad-out'],
    [{ fps: 0 }, 'bad-fps'],
    [{ fps: 121 }, 'bad-fps'],
    [{ duration: 0 }, 'bad-duration'],
    [{ codec: 'h264' }, 'bad-codec'],
    [{ version: 2 }, 'bad-version'],
    [{ scale: 3 }, 'bad-scale'],
    [{ streams: [{ name: 'a', windows: [11], composite: false, followOwners: true }] }, 'bad-stream'],
    [{ streams: [{ name: 'a', windows: [11, 12], composite: true, followOwners: true }] }, 'bad-stream'],
  ];
  for (const [extra, code] of cases) {
    const path = join(dir, 'plan.json');
    writeFileSync(path, JSON.stringify({ ...base, ...extra }));
    const run = spawnSync(binary, ['record', path], { encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 2, `${JSON.stringify(extra)}: ${run.stdout}${run.stderr}`);
    assert.equal(JSON.parse(run.stdout).error, code, JSON.stringify(extra));
    assert.equal(existsSync(join(dir, 'sync.json')), false);
  }

  const valid = join(dir, 'valid.json');
  writeFileSync(valid, JSON.stringify({ ...base, scale: 2, duration: 16,
    streams: [{ name: 'take', windows: [11, 12, 13], composite: true, crop: 'first', followOwners: true }] }));
  const checked = spawnSync(binary, ['validate', valid], { encoding: 'utf8', timeout: 5000 });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout), { ok: true, streams: 1, scale: 2, captureStarted: false });

  const codecs = spawnSync(binary, ['codecs'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(codecs.status, 0, codecs.stderr);
  const reply = JSON.parse(codecs.stdout);
  assert.equal(reply.ok, true);
  assert.equal(typeof reply.prores422hq, 'boolean');
  assert.equal(typeof reply.hevc, 'boolean');
});
