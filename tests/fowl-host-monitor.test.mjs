import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';

async function moduleUnderTest() {
  const module = await import('../bench/fowl/host-monitor.mjs').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  });
  assert.ok(module, 'host observations must be collected and graded independently of extension tab ownership');
  return module;
}
const recorded = [
  { t: 90, kind: 'host-ready', app: true, space: true, window: true },
  { t: 95, kind: 'host-front', pid: 10, initial: true },
  { t: 110, kind: 'host-front', pid: 11 },
  { t: 120, kind: 'host-space' },
  { t: 130, kind: 'host-window', pid: 11, windowId: 42 },
  { t: 200, kind: 'host-front', pid: 12 },
  { t: 250, kind: 'host-stopped', exitCode: 0 },
];

test('a partial initial window subscription cannot pass through a front-only ready record', async () => {
  const { gradeHostMonitor } = await moduleUnderTest();
  const log = [recorded[0], { t: 95, kind: 'host-window-watch', pid: 20, covered: false, pending: false }, recorded.at(-1)];
  const grade = gradeHostMonitor(log, { name: 'partial', started: 100, finished: 150 });
  assert.equal(grade.ok, false);
  assert.equal(grade.cell, 'unqualified');
});

test('a background launch with pending window registration leaves the interval unqualified', async () => {
  const { gradeHostMonitor } = await moduleUnderTest();
  const log = [recorded[0], { t: 110, kind: 'host-window-watch', pid: 30, covered: false, pending: true },
    { t: 160, kind: 'host-window-watch', pid: 30, covered: true, pending: false }, recorded.at(-1)];
  assert.equal(gradeHostMonitor(log, { name: 'launch', started: 100, finished: 150 }).cell, 'unqualified');
  assert.equal(gradeHostMonitor(log, { name: 'later', started: 170, finished: 190 }).cell, 'ok');
});

test('a registered background app window change is attributed without a front-app activation', async () => {
  const { gradeHostMonitor } = await moduleUnderTest();
  const log = [{ t: 70, kind: 'host-window-watch', pid: 30, covered: false, pending: true },
    { t: 80, kind: 'host-window-watch', pid: 30, covered: true, pending: false }, recorded[0],
    { t: 120, kind: 'host-window', pid: 30, windowId: 31 }, recorded.at(-1)];
  const grade = gradeHostMonitor(log, { name: 'background', started: 100, finished: 150 });
  assert.equal(grade.cell, 'FAIL: 1');
  assert.deepEqual(grade.events[0].runs, ['background']);
});

test('recorded host changes fail turbo focus and Space gates within each run, including headed runs', async () => {
  const { gradeHostMonitor } = await moduleUnderTest();
  for (const headless of [true, false]) {
    const grade = gradeHostMonitor(recorded, { name: 'forms', started: 100, finished: 150, headless });
    assert.equal(grade.ok, false);
    assert.equal(grade.cell, 'FAIL: 3');
    assert.deepEqual(grade.events.map(event => [event.kind, event.runs]), [
      ['host-front', ['forms']], ['host-space', ['forms']], ['host-window', ['forms']],
    ]);
    assert.equal(grade.problems.length, 3);
  }
});

test('quiet run passes only with complete observer coverage; initial state and later events are excluded', async () => {
  const { gradeHostMonitor } = await moduleUnderTest();
  const run = { name: 'quiet', started: 135, finished: 190 };
  assert.equal(gradeHostMonitor(recorded, run).ok, true);
  for (const log of [[], recorded.filter(event => event.kind !== 'host-ready'),
    [{ ...recorded[0], window: false }, ...recorded.slice(1)],
    [...recorded.slice(0, -1), { t: 160, kind: 'host-error', message: 'observer lost' }],
    recorded.map(event => event.kind === 'host-stopped' ? { ...event, t: 140 } : event)]) {
    const grade = gradeHostMonitor(log, run);
    assert.equal(grade.ok, false);
    assert.match(grade.problems.join('\n'), /coverage|observer/);
  }
});

test('overlapping runs retain every interval attribution without claiming which arm caused a host change', async () => {
  const { gradeHostMonitor } = await moduleUnderTest();
  const runs = [{ name: 'a', started: 100, finished: 125 }, { name: 'b', started: 115, finished: 145 }];
  const grade = gradeHostMonitor(recorded, runs[0], runs);
  assert.deepEqual(grade.events.map(event => event.runs), [['a'], ['a', 'b']]);
  assert.match(grade.problems.join('\n'), /during a, b/);
});

test('collector persists recorded observer lines, rejects malformed data and collects its owned child on EOF', async t => {
  const { startHostMonitor } = await moduleUnderTest();
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-host-monitor-')));
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new PassThrough(); child.stdin.on('finish', () => child.emit('close', 0));
  const file = join(dir, 'monitor.jsonl');
  const monitor = await startHostMonitor(file, { launch: async () => child, now: () => 500 });
  const lines = [...recorded.slice(0, 5), { t: 96, kind: 'host-window-watch', pid: 20, covered: false, pending: false }]
    .map(event => JSON.stringify(event)).join('\n') + '\n';
  child.stdout.write(lines.slice(0, 29)); child.stdout.write(lines.slice(29));
  child.stdout.write('not json\n');
  await monitor.stop();
  const log = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(log.filter(event => event.kind === 'host-space').length, 1);
  assert.ok(log.some(event => event.kind === 'host-window-watch' && event.covered === false));
  assert.ok(log.some(event => event.kind === 'host-error'));
  assert.deepEqual(log.at(-1), { t: 500, kind: 'host-stopped', exitCode: 0 });
  assert.equal(monitor.log.length, log.length);
});

test('observer launch failure leaves unqualified evidence instead of passing a quiet run', async t => {
  const { startHostMonitor, gradeHostMonitor } = await moduleUnderTest();
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-host-monitor-')));
  const monitor = await startHostMonitor(join(dir, 'monitor.jsonl'), { launch: async () => { throw Error('compiler unavailable'); }, now: () => 1 });
  await monitor.stop();
  assert.equal(gradeHostMonitor(monitor.log, { name: 'run', started: 2, finished: 3 }).ok, false);
});

test('read-only host observer compiles on macOS without starting observation', { skip: macCommandSkip('swiftc') }, t => {
  const compiler = '/usr/bin/swiftc';
  if (!existsSync(compiler)) return t.skip('Swift compiler unavailable');
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-host-monitor-')));
  const source = new URL('../bench/fowl/host-monitor.swift', import.meta.url).pathname;
  // The shared module cache: a fresh one rebuilds AppKit's modules and passed 120 s at load 33 (2026-10-14).
  const result = spawnSync(compiler, ['-module-cache-path', swiftModuleCache(), source, '-o', join(dir, 'observer')], { encoding: 'utf8', timeout: 180000 });
  assert.equal(result.status, 0, result.stderr);
  // This mode exits before NSWorkspace, AX or window metadata access.
  const checked = spawnSync(join(dir, 'observer'), ['--self-test'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(checked.status, 0, checked.stderr);
  const report = JSON.parse(checked.stdout);
  assert.equal(report.kind, 'subscription-self-test');
  for (const key of ['partial', 'recovered', 'backgroundLaunch', 'failedLaunch', 'terminated', 'pendingBeforeSubscribe', 'gone', 'handIgnored', 'handReused', 'handGone'])
    assert.equal(report[key], true, key);
});

test('the starter names the ghost hand host on the observer\'s stdin only when one spawns, and only valid pids', async t => {
  const { startHostMonitor, gradeHostMonitor } = await moduleUnderTest();
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-host-monitor-')));
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new PassThrough(); let sent = '';
  child.stdin.on('data', chunk => { sent += chunk; }); child.stdin.on('finish', () => child.emit('close', 0));
  // A pid known at launch may already belong to another app, so there is no launch option for one.
  const monitor = await startHostMonitor(join(dir, 'monitor.jsonl'), { launch: async () => child, now: () => 500, ignorePids: [4141] });
  for (const pid of [4242, 0, -1, 1.5, '4444', 4343]) monitor.ignore(pid);
  // The observer's own record of an ignored pid is coverage, not a gap.
  child.stdout.write([recorded[0], { t: 120, kind: 'host-window-watch', pid: 4242, covered: true, pending: false, ignored: true }]
    .map(event => JSON.stringify(event)).join('\n') + '\n');
  await monitor.stop();
  monitor.ignore(4545);
  assert.equal(sent, 'ignore-pid 4242\nignore-pid 4343\n');
  assert.ok(!sent.includes('4141'));
  assert.equal(gradeHostMonitor(monitor.log, { name: 'hand', started: 100, finished: 150 }).cell, 'ok');
  assert.ok(monitor.log.some(event => event.kind === 'host-window-watch' && event.ignored === true));
});

test('patched rounds grade turbo host events even though extension tab checks remain unobserved', async t => {
  const { homedir } = await import('node:os');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
  if (!existsSync(join(cache, '.git'))) return t.skip('pinned FowlBrowser cache unavailable');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-host-monitor-')));
  mkdirSync(join(dir, 'tools'));
  const source = spawnSync('/usr/bin/git', ['-C', cache, 'show', '6a12d60:tools/rounds.mjs'], { encoding: 'utf8' });
  assert.equal(source.status, 0, source.stderr);
  writeFileSync(join(dir, 'tools/rounds.mjs'), source.stdout);
  const applied = spawnSync('/usr/bin/git', ['apply', join(root, 'bench/fowl/sleight-surface.patch')], { cwd: dir, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  const previous = process.env.SLEIGHT_REPO; process.env.SLEIGHT_REPO = root;
  t.after(() => { if (previous === undefined) delete process.env.SLEIGHT_REPO; else process.env.SLEIGHT_REPO = previous; });
  const runner = await import(pathToFileURL(join(dir, 'tools/rounds.mjs')));
  assert.equal(runner.surfaceObserved('sleight-turbo'), false);
  assert.equal(typeof runner.gradeFocus, 'function', 'focus must have its own host-backed grade');
  const grade = runner.gradeFocus({ surface: 'sleight-turbo', monitor: recorded, run: { name: 'a', started: 100, finished: 150 } });
  assert.equal(grade.cell, 'FAIL: 3');
  assert.equal(grade.events.length, 3);
  assert.equal(grade.ok, false);
  const unobserved = runner.gradeFocus({ surface: 'browser-use', monitor: [], run: {}, focus: [] });
  assert.equal(unobserved.cell, 'not measured');
  const { startHostMonitor } = await moduleUnderTest();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new PassThrough(); child.stdin.on('finish', () => child.emit('close', 0));
  const file = join(dir, 'monitor.jsonl');
  const pending = runner.startMonitor({}, file, { readFront: async () => null, hostObservations: true,
    startHost: target => startHostMonitor(target, { launch: async () => child, now: () => 250 }) });
  await new Promise(resolve => setImmediate(resolve));
  child.stdout.write(recorded.slice(0, -1).map(event => JSON.stringify(event)).join('\n') + '\n');
  const monitor = await pending;
  const stop = monitor.stop();
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(1000); await stop;
  const measured = runner.gradeFocus({ surface: 'sleight-turbo', monitor: monitor.log,
    run: { name: 'a', started: 100, finished: 150 } });
  assert.equal(measured.cell, 'FAIL: 3');
  assert.equal(JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1)).kind, 'host-stopped');
});
