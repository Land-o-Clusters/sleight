import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import * as demo from '../bench/demo/capture.mjs';

const world = t => registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-dm1-test-'))));
test('plan covers all requested scenes with bounded 2x takes and step deadlines', () => {
  const plan = demo.shotPlan();
  assert.deepEqual(plan.map(s => s.id), ['01-ring', '02-states', '03-tsugi', '03-kit', '04-narration', '05-picker', '06-import']);
  for (const s of plan) {
    assert.equal(s.speed, 2); assert.ok(s.seconds >= 6 && s.seconds <= 12);
    assert.equal(s.sourceSeconds, s.seconds * 2); assert.ok(s.deadlineMs > s.sourceSeconds * 1000);
    assert.equal(s.deadlineMs, 240000);
  }
  assert.match(plan.find(s => s.id === '05-picker').caption, /settings.*hardware/i);
  assert.match(plan[0].caption, /fixture.*AppKit/i);
});
test('capture plan crops to the first owned fixture at 2x and follows only pinned window owners', () => {
  const p = demo.recordPlan({ out: '/tmp/take', fixture: 41, target: 42, panel: 43, seconds: 16 });
  assert.equal(p.scale, 2); assert.equal(p.duration, 16); assert.equal(p.fps, 60);
  assert.deepEqual(p.streams, [{ name: 'take', windows: [41, 42, 43], composite: true, crop: 'first', followOwners: true }]);
  for (const ids of [[0, 2, 3], [1, 1, 2], [1, 2, undefined]]) assert.throws(() => demo.recordPlan({ out: '/tmp/take', fixture: ids[0], target: ids[1], panel: ids[2], seconds: 16 }));
});
test('recipe timings show click, drag, statuses, perch reactions and narration before the take ends', () => {
  const plans = demo.shotPlan();
  for (const s of plans) {
    const recipe = demo.recipe(s.id);
    assert.ok(recipe.length > 0);
    for (const event of recipe) assert.ok(event.atMs >= 0 && event.atMs < s.sourceSeconds * 1000);
    assert.deepEqual(recipe.map(r => r.atMs), recipe.map(r => r.atMs).sort((a,b) => a-b));
  }
  assert.ok(demo.recipe('01-ring').some(e => e.op === 'drag'));
  assert.ok(demo.recipe('02-states').some(e => e.state === 'waiting'));
  assert.ok(demo.recipe('03-tsugi').some(e => e.state === 'handback'));
  assert.ok(demo.recipe('04-narration').some(e => e.say));
});
test('encoding is silent, 2x, bounded GIF retries and standard MP4', () => {
  const commands = demo.encodingPlan('/tmp/take/take.mov', '/tmp/take');
  assert.match(commands.mp4.join(' '), /setpts=PTS\/2/);
  assert.ok(commands.mp4.includes('yuv420p')); assert.ok(commands.mp4.includes('+faststart'));
  assert.ok(commands.gifs.length > 1);
  for (const args of [commands.mp4, ...commands.gifs]) { assert.ok(args.includes('-an')); assert.ok(args.includes('-threads')); }
  assert.equal(demo.gifFits(2_000_000), true); assert.equal(demo.gifFits(2_000_001), false);
  assert.equal(demo.gifFits(0), false);
});
test('resume needs successful exits, complete metadata, intact digests and cleanup', t => {
  const dir = world(t), files = ['demo.gif', 'demo.mp4', 'poster.png', 'sync.json', 'events.json', 'probes.json'];
  for (const name of files) writeFileSync(join(dir, name), name);
  const marker = demo.completedMarker(dir, { id: '01-ring', seconds: 8, fps: 30, gifFps: 20, gifBytes: 8, mp4Bytes: 8, encoder: 'ffmpeg', cleanup: true, probes: { passed: true } });
  assert.equal(demo.reusable(marker), true);
  assert.equal(demo.reusable({ ...marker, cleanup: false }), false);
  assert.equal(demo.reusable({ ...marker, status: 'failed' }), false);
  writeFileSync(join(dir, 'demo.mp4'), 'changed'); assert.equal(demo.reusable(marker), false);
  assert.throws(() => demo.assertIdentity({ root: '/one', head: 'a' }, { root: '/one', head: 'b' }));
});
test('synthetic Codex v2 import uses the production wizard and leaves source bytes unchanged', t => {
  const base = world(t), result = demo.makePet(base);
  const source = readFileSync(result.sourceSheet);
  assert.equal(result.pack.manifest.codex.spriteVersionNumber, 2);
  assert.match(result.callout, /needs \d+ more/); assert.match(result.callout, /uses its/);
  assert.deepEqual(readFileSync(result.sourceSheet), source);
  assert.deepEqual(readFileSync(join(result.pack.folder, result.pack.manifest.sheet)), source);
  assert.ok(result.pack.folder.startsWith(base + '/'));
});
test('private bank rejects symlink escapes', t => {
  const dir = world(t); mkdirSync(join(dir, 'bank'), { mode: 0o700 });
  demo.assertBank(join(dir, 'bank'), dir);
  symlinkSync(join(dir, 'bank'), join(dir, 'linked'));
  assert.throws(() => demo.assertBank(join(dir, 'linked'), dir));
});
test('dry run has no children, files, hold access or capture on import/CLI', t => {
  const dir = world(t), night = join(dir, 'never-created');
  // PATH traps any accidental compiler, app launch, recorder, input or caffeinate subprocess.
  const trap = join(dir, 'bin'); mkdirSync(trap);
  for (const cmd of ['node', 'xcrun', 'swiftc', 'open', 'osascript', 'ffmpeg', 'caffeinate']) writeFileSync(join(trap, cmd), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const result = spawnSync(process.execPath, ['bench/demo/capture.mjs', '--dry-run', '--night', night], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: trap },
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(night), false);
  for (const line of ['ScreenCaptureKit', '2 MB', 'caffeinate', 'resume', 'settings', 'synthetic', 'owner-away', 'ffmpeg']) assert.ok(result.stdout.includes(line), line);
  assert.equal(result.stdout.includes('undefined'), false);
});
test('live launch requires explicit away assertion before platform, paths or children', t => {
  const dir = world(t), night = join(dir, 'not-created');
  const result = spawnSync(process.execPath, ['bench/demo/capture.mjs', '--night', night], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 2); assert.match(result.stderr, /owner-away/); assert.equal(existsSync(night), false);
});
test('live resume control cannot write in the ledger or an arbitrary folder', t => {
  const dir = world(t), night = join(dir, 'not-created');
  const result = spawnSync(process.execPath, ['bench/demo/capture.mjs', '--owner-away', '--night', night], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 2); assert.equal(existsSync(night), false);
});
test('unknown, repeated and incomplete options fail closed', () => {
  for (const args of [['--wat'], ['--night'], ['--owner-away', '--owner-away'], ['--night', '--dry-run']]) assert.throws(() => demo.parseArgs(args));
});
test('owner detection observes a real quiet gap, physical pointer changes and unknown telemetry', () => {
  const detect = demo.inputWatch(1000);
  assert.equal(detect({ t: 2000, x: 10, y: 20, idle: 2 }), undefined);
  assert.equal(detect({ t: 16000, x: 10, y: 20, idle: 16 }), undefined);
  assert.equal(detect({ t: 17000, x: 10, y: 20, idle: 0.1 }), 'OWNER');
  assert.equal(demo.inputWatch(0)({ t: 1000, x: 1, y: 2 }), 'TELEMETRY');
  const pointer = demo.inputWatch(0); pointer({ t: 1000, x: 10, y: 20, idle: 20 });
  assert.equal(pointer({ t: 2000, x: 13, y: 20, idle: 21 }), 'OWNER');
});
test('hold/lock waits cap without mutating either path', async () => {
  let clock = 0, reads = 0;
  await assert.rejects(demo.waitClear({ exists: () => { reads++; return true; }, now: () => clock, wait: async ms => { clock += ms; }, log: () => {} }), /BUSY/);
  assert.equal(clock, 1200000); assert.ok(reads > 2);
});
test('child deadlines collect only an owned process and report its exit', async () => {
  const c = new demo.Children(process.env);
  await assert.rejects(c.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 20 }), /DEADLINE/);
  await c.close(); assert.equal(c.live.size, 0);
});
test('a native scene failure prevents completion while both owned children are collected', async t => {
  const children = new demo.Children(process.env);
  t.after(() => children.close());
  const bad = children.start(process.execPath, ['-e', 'process.exit(65)']);
  const good = children.start(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))']);
  await bad.closed;
  await assert.rejects(demo.closeScene([bad, good]), /65/);
  assert.equal(children.live.size, 0);
});
