import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { lstatSync } from 'node:fs';

const moduleURL = new URL('../bench/rt31-probe.mjs', import.meta.url);
const request = (row, extra = {}) => ({ version: 1, pid: 321, window: 654, row, mode: 'background',
  ...(['move', 'click'].includes(row) ? { toolbarHeight: 48, titleBarHeight: 32,
    coordinateMapping: 'window-bottom-left-to-cg-top-left' } : {}), ...extra });
test('RT31 helper exists', async () => {
  assert.equal(typeof (await import(moduleURL)).planRow, 'function');
});

test('kernel identity and signal storage are independent of AppKit caching', async () => {
  const source = await readFile(new URL('../bench/rt31-probe.swift', import.meta.url), 'utf8');
  assert.match(source, /proc_pidinfo\(/);
  assert.match(source, /pbi_start_tvsec/);
  assert.match(source, /pbi_start_tvusec/);
  assert.doesNotMatch(source, /NSRunningApplication|\.launchDate/);
  const install = source.slice(source.indexOf('func probeInstallSignals()'));
  assert.ok(install.indexOf('probeInterrupted = 0') >= 0);
  assert.ok(install.indexOf('probeInterrupted = 0') < install.indexOf('signal(SIGPIPE'));
});

test('hold refuses at startup and again before each helper row without spawning', async () => {
  const { assertNoHold, startTool } = await import(moduleURL);
  const paths = [];
  assert.throws(() => assertNoHold(path => { paths.push(path); return {}; }), /TIMED_WINDOW_HOLD/);
  assert.deepEqual(paths, ['/tmp/sleight-hold']);
  let held = false, spawns = 0;
  const spawn = () => {
    spawns++;
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end('{"record":"summary","ok":true,"reason":"SENT_UNVERIFIED","attempted":6,"releases":3,"pending":0,"beliefCleared":true,"maxCriticalSectionMs":10}\n');
      child.emit('close', 0, null);
    });
    return child;
  };
  const options = { spawn, holdLstat: () => { if (!held) throw Object.assign(new Error(), { code: 'ENOENT' }); return {}; } };
  assert.equal((await startTool('/fake', request('mapped-keys'), options).done).code, 0);
  held = true;
  assert.throws(() => startTool('/fake', request('mapped-keys'), options), /TIMED_WINDOW_HOLD/);
  assert.equal(spawns, 1);
});

test('hold lstat refuses dangling links and every error except ENOENT', async t => {
  const { assertNoHold } = await import(moduleURL);
  assert.doesNotThrow(() => assertNoHold(() => { throw Object.assign(new Error(), { code: 'ENOENT' }); }));
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'ELOOP', undefined]) {
    assert.throws(() => assertNoHold(() => { throw Object.assign(new Error(), { code }); }), /TIMED_WINDOW_HOLD/);
  }
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-rt31-hold-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const link = join(root, 'hold');
  await symlink(join(root, 'absent'), link);
  assert.throws(() => assertNoHold(() => lstatSync(link)), /TIMED_WINDOW_HOLD/);
});

test('supervisor stops the sitting above 100 ms and requires a per-row measurement', async () => {
  const { startTool } = await import(moduleURL);
  for (const [maxCriticalSectionMs, expected] of [[100, 0], [100.001, 1], [undefined, 74]]) {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const run = startTool('/fake', request('mapped-keys'), { spawn: () => child });
    child.stdout.end(JSON.stringify({ record: 'summary', ok: true, reason: 'SENT_UNVERIFIED', attempted: 6,
      releases: 3, pending: 0, beliefCleared: true, maxCriticalSectionMs }) + '\n');
    child.emit('close', 0, null);
    const result = await run.done;
    assert.equal(result.code, expected);
    if (expected === 1) assert.equal(result.reason, 'CRITICAL_SECTION_EXCEEDED');
  }
});

test('supervisor reports cleanup and critical section failures together', async () => {
  const { startTool } = await import(moduleURL);
  for (const [pending, beliefCleared] of [[1, true], [0, false]]) {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const run = startTool('/fake', request('mapped-keys'), { spawn: () => child });
    child.stdout.end(JSON.stringify({ record: 'summary', ok: false, reason: 'CLEANUP_UNCONFIRMED', attempted: 2,
      releases: 0, pending, beliefCleared, maxCriticalSectionMs: 101, criticalSectionExceeded: true }) + '\n');
    child.emit('close', 1, null);
    const result = await run.done;
    assert.equal(result.code, 1);
    assert.equal(result.reason, 'CLEANUP_UNCONFIRMED');
    assert.equal(result.records[0].criticalSectionExceeded, true);
    assert.equal(result.records[0].maxCriticalSectionMs, 101);
  }
});

test('supervisor preserves the distinct measured height refusal', async () => {
  const { startTool } = await import(moduleURL);
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const run = startTool('/fake', request('click', { point: [12, 25], titleBarHeight: 1, toolbarHeight: 1 }), { spawn: () => child });
  child.stdout.end(JSON.stringify({ record: 'summary', ok: false, reason: 'HEIGHT_MISMATCH', attempted: 0,
    releases: 0, pending: 0, maxCriticalSectionMs: 0 }) + '\n');
  child.emit('close', 65, null);
  const result = await run.done;
  assert.equal(result.code, 65);
  assert.equal(result.reason, 'HEIGHT_MISMATCH');
});

test('pointer mapping and title allowance require explicit validated parameters', async () => {
  const { planRow, parseArgs } = await import(moduleURL);
  for (const titleBarHeight of [undefined, 0, -1, 513, Infinity, '32', true]) {
    assert.throws(() => planRow(request('click', { point: [12, 25], titleBarHeight })));
  }
  for (const coordinateMapping of [undefined, 'global', {}, true]) {
    assert.throws(() => planRow(request('click', { point: [12, 25], coordinateMapping })));
  }
  const plan = planRow(request('click', { point: [12, 25] }));
  assert.equal(plan.titleBarHeight, 32);
  assert.equal(plan.toolbarHeight, 48);
  assert.equal(plan.coordinateMapping, 'window-bottom-left-to-cg-top-left');
  const args = ['--inspect', '--tool', '/tmp/prebuilt-tool', '--pid', '321', '--window', '654', '--row', 'move',
    '--x', '12', '--y', '25', '--title-bar-height', '32', '--toolbar-height', '48',
    '--coordinate-mapping', 'window-bottom-left-to-cg-top-left'];
  assert.equal(parseArgs(args).inspect, true);
  assert.deepEqual(parseArgs(args).request, request('move', { point: [12, 25] }));
});

test('usage explains uncatchable stops and a no-post first-row inspection', () => {
  const r = spawnSync(process.execPath, [moduleURL.pathname, '--help'], { killSignal: 'SIGKILL', timeout: 10000, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SIGSTOP/);
  assert.match(r.stdout, /never pause/i);
  assert.match(r.stdout, /--inspect/);
  assert.match(r.stdout, /title-bar-height/);
});

test('inspection accepts bounded numeric geometry and rejects expanded metadata', async () => {
  const { startTool } = await import(moduleURL);
  for (const bad of [false, 'title', 'posts', 'point', 'missing-frame']) {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const run = startTool('/fake', request('move', { point: [12, 25] }), { inspect: true, spawn: (_tool, args) => {
      assert.deepEqual(args, ['--inspect']); return child;
    } });
    const record = { record: 'inspection', reason: 'INSPECTED_NO_POST', ok: true, attempted: 0, releases: 0, pending: 0, beliefCleared: true,
      windowFrame: [10, 20, 600, 400], windowPoint: [12, 25], cgPoint: [22, 395], appKitCGPoint: [12, 25],
      coordinateMapping: 'window-bottom-left-to-cg-top-left', titleBarHeight: 32, toolbarHeight: 48,
      axWindowFrame: [10, 20, 600, 400], axToolbarFrame: [10, 52, 600, 48], axContentFrame: [10, 100, 600, 320],
      maxCriticalSectionMs: 0, axWindowCount: 1, sheetCount: 0, childCount: 2, blockingChildCount: 0, modalCount: 0 };
    if (bad === 'title') record.title = 'private window title';
    if (bad === 'posts') record.attempted = 1;
    if (bad === 'point') record.cgPoint = [Infinity, 25];
    if (bad === 'missing-frame') delete record.axContentFrame;
    child.stdout.end(JSON.stringify(record) + '\n'); child.emit('close', 0, null);
    const result = await run.done;
    assert.equal(result.code, bad ? 74 : 0, bad || 'accepted numeric-only inspection');
    if (!bad) assert.deepEqual(result.records[0].cgPoint, [22, 395]);
  }
});

test('idle threshold can only be raised and pointer rows require an excluded toolbar band', async () => {
  const { planRow, parseArgs } = await import(moduleURL);
  const args = ['--dry-run', '--pid', '321', '--window', '654', '--row', 'mapped-keys'];
  assert.equal(parseArgs([...args, '--idle-seconds', '5']).request.idleSeconds, 5);
  for (const value of [0, 1.99, 3601, true, '3', Infinity]) {
    assert.throws(() => planRow(request('mapped-keys', { idleSeconds: value })));
  }
  assert.throws(() => planRow(request('click', { point: [12, 25], toolbarHeight: undefined })));
  for (const toolbarHeight of [-1, 0, 0.5, 513, true, '48', Infinity]) {
    assert.throws(() => planRow(request('click', { point: [12, 25], toolbarHeight })));
  }
  assert.equal(planRow(request('click', { point: [12, 25], toolbarHeight: 48 })).events.length, 3);
});

test('five fixed rows expose all intended public event fields', async () => {
  const { planRow } = await import(moduleURL);
  const click = planRow(request('click', { point: [14, 25] }));
  assert.deepEqual(click.events.map(e => e.type), ['mouseMoved', 'leftMouseDown', 'leftMouseUp']);
  assert.deepEqual(click.events.map(e => e.delayBeforeMs), [0, 0, 50]);
  assert.deepEqual(click.events.map(e => e.pressure), [0, 1, 0]);
  assert.equal(click.coordinateSpace, 'window-bottom-left-points');
  for (const event of click.events) {
    assert.equal(event.pid, 321); assert.equal(event.window, 654);
    assert.deepEqual(event.point, [14, 25]); assert.equal(event.source, 'private');
  }
  assert.deepEqual(planRow(request('mapped-keys')).events.map(e => e.keyCode), [12, 12, 123, 123, 36, 36]);
  assert.deepEqual(planRow(request('mapped-keys')).events.map(e => e.delayBeforeMs), [0, 10, 0, 10, 0, 10]);
  const belief = planRow(request('belief-keys')).events;
  assert.equal(belief.length, 8);
  assert.equal(belief[0].type, 'applicationActivated');
  assert.equal(belief.at(-1).type, 'applicationDeactivated');
  const unicode = planRow(request('unicode', { mode: 'foreground', mappedQConfirmed: true })).events;
  assert.deepEqual(unicode.map(e => [e.keyCode, e.unicode]), [[0, 'q'], [0, 'q']]);
  assert.deepEqual(unicode.map(e => e.delayBeforeMs), [0, 10]);
  assert.equal(planRow(request('move', { point: [0, 0] })).events.length, 1);
});

test('invalid, ambiguous or expanded input refuses before spawn', async () => {
  const { planRow, parseArgs } = await import(moduleURL);
  for (const value of [0, -1, 2 ** 32, 1.5, true, '321', NaN, Infinity]) {
    assert.throws(() => planRow(request('mapped-keys', { pid: value })));
    assert.throws(() => planRow(request('mapped-keys', { window: value })));
  }
  for (const r of [request('other'), request('move'), request('click', { point: [-1, 0] }),
    request('click', { point: [1, Infinity] }), request('mapped-keys', { point: [1, 2] }),
    request('mapped-keys', { arbitrary: true }), request('unicode'), request('belief-keys', { mode: 'foreground' }),
    request('unicode', { mode: 'foreground' }), request('move', { point: [1, 2, 3] })]) assert.throws(() => planRow(r));
  for (const args of [[], ['--pid', '321', '--pid', '322'], ['--all'], ['--live', '--dry-run'],
    ['--pid', '3e2'], ['--window', '1.5'], ['--tool', '/tmp/x', '--live']]) assert.throws(() => parseArgs(args));
  const args = ['--dry-run', '--pid', '321', '--window', '654', '--row', 'mapped-keys'];
  for (const extra of [['--all'], ['--row', 'click'], ['--foreground', '--foreground'], ['--x', '1'], ['--tool', 'relative']]) assert.throws(() => parseArgs([...args, ...extra]));
  assert.deepEqual(parseArgs(args).request, request('mapped-keys'));
  assert.equal(parseArgs(['--build-only', '--tool', '/tmp/absent-tool']).buildOnly, true);
  assert.equal(parseArgs(['--live', '--tool', '/tmp/prebuilt-tool', '--pid', '321', '--window', '654', '--row', 'mapped-keys', '--capture-off-confirmed']).dryRun, false);
});

test('the base sitting has nine separately requested rows and 33 planned posts', async () => {
  const { planRow } = await import(moduleURL);
  const rows = [request('move', { point: [1, 2] }), request('move', { point: [3, 4] }),
    request('click', { point: [1, 2] }), request('click', { point: [3, 4] }), request('mapped-keys'),
    request('belief-keys'), request('click', { point: [1, 2], mode: 'foreground' }),
    request('mapped-keys', { mode: 'foreground' }), request('unicode', { mode: 'foreground', mappedQConfirmed: true })];
  const events = rows.flatMap(r => planRow(r).events);
  assert.equal(events.length, 33);
  assert.equal(events.filter(e => e.type === 'keyUp' || e.type === 'leftMouseUp').length, 13);
  assert.equal(events.filter(e => e.type === 'applicationDeactivated').length, 1);
});

test('dry-run CLI never starts a helper and emits the fixed row plan', async () => {
  const r = spawnSync(process.execPath, [moduleURL.pathname, '--dry-run', '--pid', '321', '--window', '654', '--row', 'click', '--x', '14', '--y', '25', '--toolbar-height', '48', '--title-bar-height', '32', '--coordinate-mapping', 'window-bottom-left-to-cg-top-left'], { killSignal: 'SIGKILL', timeout: 10000, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.events.length, 3); assert.equal(plan.events[2].delayBeforeMs, 50);
});

test('supervisor sends cooperative cancel once and waits for child close', async () => {
  const { startTool } = await import(moduleURL);
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const writes = []; child.stdin.on('data', b => writes.push(b.toString()));
  let settled = false;
  const run = startTool('/fake', request('mapped-keys'), { spawn: () => child });
  run.done.then(() => { settled = true; });
  run.interrupt(); run.interrupt();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(writes.filter(s => s === 'cancel\n').length, 1);
  child.stdout.end('{"record":"summary","maxCriticalSectionMs":0,"ok":false,"reason":"CANCELLED","attempted":1,"releases":1,"pending":0}\n');
  child.emit('close', 130, null);
  const r = await run.done;
  assert.equal(r.code, 130); assert.equal(r.records[0].pending, 0);
});

test('all termination, stop and continue signals cancel cooperatively without resuming a row', async () => {
  const { startTool, superviseSignals } = await import(moduleURL);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP', 'SIGCONT']) {
    const emitter = new EventEmitter(), child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const writes = []; child.stdin.on('data', b => writes.push(b.toString()));
    const run = startTool('/fake', request('mapped-keys'), { spawn: () => child });
    const removeSignals = superviseSignals(run.interrupt, emitter);
    emitter.emit(signal); emitter.emit('SIGCONT');
    assert.deepEqual(writes.slice(1), ['cancel\n'], signal);
    child.stdout.end('{"record":"summary","maxCriticalSectionMs":0,"ok":false,"reason":"CANCELLED","attempted":2,"releases":1,"pending":0}\n');
    child.emit('close', 130, null);
    assert.equal((await run.done).code, 130);
    removeSignals(); assert.equal(emitter.listenerCount(signal), 0);
  }
});

test('supervisor preserves measured idle in a person-active refusal', async () => {
  const { startTool } = await import(moduleURL);
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const run = startTool('/fake', request('mapped-keys'), { spawn: () => child });
  child.stdout.end('{"record":"summary","maxCriticalSectionMs":0,"ok":false,"reason":"PERSON_ACTIVE","attempted":0,"releases":0,"pending":0,"hidIdleMs":75,"idleThresholdMs":2000}\n');
  child.emit('close', 65, null);
  const result = await run.done;
  assert.equal(result.reason, 'PERSON_ACTIVE'); assert.equal(result.records[0].hidIdleMs, 75);
  assert.equal(result.records[0].idleThresholdMs, 2000);
});

test('supervisor discards child stderr and rejects untrusted output', async () => {
  const { startTool } = await import(moduleURL);
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const run = startTool('/fake', request('mapped-keys'), { spawn: () => child });
  child.stderr.end('private document content'); child.stdout.end('{"secret":"private document content"}\n'); child.emit('close', 1, null);
  const r = await run.done;
  assert.equal(r.code, 74); assert.deepEqual(r.records, []); assert.equal(r.reason, 'TOOL_OUTPUT_INVALID');
});

test('supervisor fails a zero exit with pending cleanup and refuses unknown reason text', async () => {
  const { startTool } = await import(moduleURL);
  for (const [reason, pending, expected] of [['CLEANUP_UNCONFIRMED', 1, 1], ['PRIVATE_DOCUMENT_CONTENT', 0, 74]]) {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const run = startTool('/fake', request('mapped-keys'), { spawn: () => child });
    child.stdout.end(JSON.stringify({ record: 'summary', maxCriticalSectionMs: 0, ok: false, reason, attempted: 1, releases: 0, pending, beliefCleared: true }) + '\n');
    child.emit('close', 0, null);
    assert.equal((await run.done).code, expected);
  }
});

test('native public construction, strict validation and fake cleanup', { skip: process.platform !== 'darwin', timeout: 240000 }, async t => {
  const { planRow } = await import(moduleURL);
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-rt31-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new URL('../bench/rt31-probe.swift', import.meta.url).pathname;
  const binary = join(root, 'probe');
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-module-cache-path', join(root, 'modules'), source, '-o', binary], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 180000 });
  assert.equal(compile.status, 0, compile.stderr);
  const run = async (r, args = ['--dump']) => {
    return spawnSync(binary, args, { input: JSON.stringify(r) + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 3000 });
  };
  for (const r of [request('move', { point: [12, 25] }), request('click', { point: [12, 25] }), request('mapped-keys'), request('belief-keys'), request('unicode', { mode: 'foreground', mappedQConfirmed: true })]) {
    const out = await run(r); assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), planRow(r));
  }
  for (const r of [request('unicode'), request('mapped-keys', { arbitrary: true }), request('move', { point: [true, 0] }),
    request('mapped-keys', { pid: true }), request('mapped-keys', { window: 0 }), request('belief-keys', { mode: 'foreground' }),
    request('move', { point: [-1, 0] }), request('move', { point: [1, 2, 3] }), request('unicode', { mode: 'foreground', mappedQConfirmed: 1 }),
    request('mapped-keys', { idleSeconds: 1.99 }), request('mapped-keys', { idleSeconds: true }),
    request('click', { point: [1, 2], toolbarHeight: 0.5 }), request('click', { point: [1, 2], toolbarHeight: undefined })]) {
    const refusal = await run(r);
    assert.equal(refusal.status, 65);
    assert.equal(JSON.parse(refusal.stdout).maxCriticalSectionMs, 0, 'refused rows also report their critical section');
  }
  assert.equal((await run(request('mapped-keys'), ['--dump', '--live'])).status, 65);
  assert.equal(spawnSync(binary, ['--dump'], { input: 'a'.repeat(4098) + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 3000 }).status, 65);
  const clock = JSON.parse((await run(request('mapped-keys'), ['--dump-clock'])).stdout);
  t.diagnostic(`Clock dump: ${JSON.stringify(clock)}`);
  assert.equal(clock.record, 'clock'); assert.ok(clock.eventTimestampNs > 0);
  assert.ok(clock.differenceNs < 1e9, `CGEvent timestamp and uptime differ by ${clock.differenceNs} ns`);
  const fake = join(root, 'fake');
  const buildFake = spawnSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-D', 'RT31_TEST', '-module-cache-path', join(root, 'modules'), source, new URL('./fixtures/rt31-probe-fake.swift', import.meta.url).pathname, '-o', fake], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 180000 });
  assert.equal(buildFake.status, 0, buildFake.stderr);
  const r = spawnSync(fake, [], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr); const result = JSON.parse(r.stdout);
  assert.equal(result.failed, 0); assert.ok(result.passed >= 20);
  t.diagnostic(`Swift fake assertions: ${result.passed} passed, ${result.failed} failed; max critical section ${result.maxCriticalSectionMs} ms across ${result.measuredRows} normal rows`);
  const sourceText = await readFile(source, 'utf8');
  for (const forbidden of ['CGEventTapCreate', '.cghidEventTap', '.cgSessionEventTap', 'CGEventSetWindowLocation', 'CGEventField(rawValue:', 'NSAppleScript', 'NSApplication.shared', '.activate(', '.frontmostApplication', '.post(tap:', 'CGEventTapPostEvent', 'postToPSN', 'tapPostEvent', 'CGPostKeyboardEvent', 'CGPostMouseEvent', 'AXUIElementPerformAction', 'AXUIElementSetAttributeValue', 'AXUIElementPostKeyboardEvent', 'NSWorkspace', 'NSAppleEventDescriptor']) assert.equal(sourceText.includes(forbidden), false, forbidden);
  assert.doesNotMatch(sourceText, /\b(?:Process|CGEventPost\w*|CGEventTapPostEvent\w*)\s*\(/);
  assert.equal([...sourceText.matchAll(/\.postToPid\s*\(/g)].length, 1);
});

test('standalone build command publishes a dump-only tested tool and refuses replacement', { skip: process.platform !== 'darwin', timeout: 240000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-rt31-build-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tool = join(root, 'tool');
  const built = spawnSync(process.execPath, [moduleURL.pathname, '--build-only', '--tool', tool], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 180000 });
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(JSON.parse(built.stdout), { record: 'build', ok: true });
  assert.equal((await stat(tool)).mode & 0o777, 0o700);
  const dump = spawnSync(tool, ['--dump'], { input: JSON.stringify(request('mapped-keys')) + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 3000 });
  assert.equal(dump.status, 0, dump.stderr);
  assert.equal(JSON.parse(dump.stdout).events.length, 6);
  const before = await readFile(tool);
  const replacement = spawnSync(process.execPath, [moduleURL.pathname, '--build-only', '--tool', tool], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 3000 });
  assert.equal(replacement.status, 65);
  assert.deepEqual(await readFile(tool), before);
});
