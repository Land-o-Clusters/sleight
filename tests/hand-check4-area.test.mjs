import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtureArea, withFixtureArea, areaRefusalCollected } from '../bench/hand/check4-area.mjs';
import { areaRecoveryPlan, finishAreaRecovery, recordedRefusalApps } from '../bench/hand/check4-area-recover.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

test('native guard excludes fixture apps and restores partial hiding on failure', { skip: process.platform !== 'darwin' }, t => {
  const root = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-area-test-'))));
  let source = readFileSync(new URL('../bench/hand/check4-area.swift', import.meta.url), 'utf8');
  if (process.env.CHV2B_AREA_BROKEN === 'fixture-hidden') source = source.replace('!fixtureBundles.contains(app.bundle) && ', '');
  if (process.env.CHV2B_AREA_BROKEN === 'left-hidden') source = source.replace('if app.hidden() { _ = app.unhide() }', 'if false { _ = app.unhide() }');
  if (process.env.CHV2B_AREA_BROKEN === 'stale-state') source = source.replace('let hidden = settle { !app.alive() || app.hidden() }', 'let hidden = app.hidden()');
  const file = join(root, 'area.swift'), binary = join(root, 'area'); writeFileSync(file, source);
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), file, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(compile, 0, compile.stderr);
  const result = spawnSync(binary, ['--selftest'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr); const row = JSON.parse(result.stdout);
  assert.equal(row.failed, true); assert.equal(row.restored, true);
  assert.deepEqual(row.hidden, [2, 4]); assert.deepEqual(row.unhidden, [2]); assert.equal(row.asyncRestored, true);
  assert.deepEqual(row.owned, [2, 4]); assert.equal(row.fixtureHidden, false); assert.equal(row.previouslyHidden, true);
  assert.equal(row.windowsCreated, 0);
  assert.equal(row.mainQueueRestored, true);
});

for (const failure of [false, true]) test(`fixture scope restores after task failure=${failure}`, async () => {
  let closed = 0;
  const task = withFixtureArea(async () => ({ ready: { apps: [42] }, close: async () => { closed++; } }), async ready => {
    assert.deepEqual(ready.apps, [42]); if (failure) throw Error('task failed'); return 9;
  });
  if (failure) await assert.rejects(task, /task failed/); else assert.equal(await task, 9);
  assert.equal(closed, 1);
});

function fakeGuard({ clear = true, restored = true, code = 0, waiting = 0 } = {}) {
  return () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.once('finish', () => {
      child.stdout.write(JSON.stringify({ phase: 'restored', restored }) + '\n'); child.emit('close', code, null);
    });
    const banner = [{ owner: 'Notification Center', layer: 21 }];
    for (let i = 0; i < waiting; i++) setTimeout(() => child.stdout.write(JSON.stringify({ phase: 'waiting', waitedS: i * 60, windows: banner }) + '\n'), i * 10);
    setTimeout(() => child.stdout.write(JSON.stringify({ phase: clear ? 'ready' : 'refused', clear, reason: 'still covered', apps: [] }) + '\n'), waiting * 10 + 10);
    return child;
  };
}
test('coverage refusal restores before propagating and restoration failure refuses cleanup', async () => {
  const records = [];
  await assert.rejects(fixtureArea('fake', { spawnChild: fakeGuard({ clear: false, code: 1 }), record: r => records.push(r) }), /Fixture area refused/);
  assert.equal(records.at(-1).restored, true);
  const area = await fixtureArea('fake', { spawnChild: fakeGuard({ restored: false }) });
  await assert.rejects(area.close(), /restoration unproved/);
});
test('a system banner is waited out before the task without recording an attempt', async () => {
  const records = [], lines = [];
  const area = await fixtureArea('fake', { spawnChild: fakeGuard({ waiting: 3 }), record: r => records.push(r), log: l => lines.push(l) });
  assert.equal(area.ready.phase, 'ready');
  assert.deepEqual(records.map(r => r.phase), ['ready']);
  assert.equal(lines.length, 3); assert.match(lines[2], /120 s for a system window: Notification Center/);
  await area.close();
});

test('native guard waits out a launchd system banner and keeps the layer-0 identity refusal', { skip: process.platform !== 'darwin' }, t => {
  const root = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-area-system-'))));
  const file = join(root, 'area.swift'), binary = join(root, 'area');
  writeFileSync(file, readFileSync(new URL('../bench/hand/check4-area.swift', import.meta.url), 'utf8'));
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), file, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(compile, 0, compile.stderr);
  const result = spawnSync(binary, ['--selftest-system'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr); const row = JSON.parse(result.stdout);
  assert.deepEqual(row.classes, { banner: 'system', bannerLayer0: 'system', launchdAgent: 'system', unidentified: 'unidentified',
    noApp: 'unidentified', pointer: 'none', app: 'app', fixture: 'none' });
  // A banner on for 330 polls at 2 s clears at 660 s, with one row per minute from 0 to 600 s.
  assert.equal(row.clearedWaitS, 660); assert.equal(row.clearedRows, 11); assert.equal(row.clearedPolls, 331);
  assert.equal(row.timeout, 'fixture-area-system-window-timeout'); assert.equal(row.timeoutRows, 20); assert.equal(row.firstRow, 'waiting');
});

test('a pre-task refusal releases cleanup only with restoration and child collection proved', () => {
  const receipt = { phase: 'restored', restored: true, exit: { code: 1, signal: null } };
  assert.equal(areaRefusalCollected(false, [receipt]), true);
  assert.equal(areaRefusalCollected(true, [receipt]), false);
  for (const change of [{ restored: false }, { exit: { code: null, signal: 'SIGKILL' } }, { exit: {} }])
    assert.equal(areaRefusalCollected(false, [{ ...receipt, ...change }]), false);
});

test('area recovery accepts only a collected refusal before any task and refuses a replaced lock', t => {
  const root = realpathSync(registerTemp(t, mkdtempSync(join(realpathSync('/tmp'), 'sleight-area-recovery-'))));
  const bank = join(root, 'bank'), lock = join(root, 'lock'); mkdirSync(bank, { mode: 0o700 }); mkdirSync(lock);
  mkdirSync(join(bank, 'work-test'));
  const state = { cleanupConfirmed: false, failure: 'Fixture area restoration unproved', tasks: { 'preview-read': { complete: false, attempts: [] } } };
  const save = row => writeFileSync(join(bank, 'check4.json'), JSON.stringify(row)); save(state);
  writeFileSync(join(bank, 'area-preview-read-1.json'), JSON.stringify([{ phase: 'refused', reason: 'fixture-area-hide' },
    { phase: 'restored', restored: true, apps: [], exit: { code: 1, signal: null } }]));
  const plan = areaRecoveryPlan(bank, lock);
  assert.deepEqual(plan.apps, []);
  assert.throws(() => finishAreaRecovery({ ...plan, ownedLock: { ...plan.ownedLock, ino: -1 } }, { restored: true }), /lock changed/);
  assert.equal(existsSync(lock), true);
  assert.throws(() => finishAreaRecovery(plan, { restored: false }), /restoration unproved/);
  save({ ...state, tasks: { 'preview-read': { complete: false, attempts: [{}] } } });
  assert.throws(() => areaRecoveryPlan(bank, lock), /before task checkpointing/); save(state);
  finishAreaRecovery(plan, { restored: true });
  assert.equal(existsSync(lock), false); assert.equal(JSON.parse(readFileSync(join(bank, 'check4.json'))).cleanupConfirmed, true);
  assert.throws(() => recordedRefusalApps(bank), /collected pre-task refusal/);
  save({ ...state, cleanupConfirmed: true, failure: 'Fixture area refused: fixture-area-hide' });
  assert.deepEqual(recordedRefusalApps(bank), []);
});

test('a post-task area failure needs Preview fixture, group and host collection receipts', t => {
  const root = realpathSync(registerTemp(t, mkdtempSync(join(realpathSync('/tmp'), 'sleight-area-task-recovery-'))));
  const bank = join(root, 'bank'), lock = join(root, 'lock'); mkdirSync(bank, { mode: 0o700 }); mkdirSync(lock); mkdirSync(join(bank, 'work-test'));
  writeFileSync(join(bank, 'check4.json'), JSON.stringify({ cleanupConfirmed: false, failure: 'Fixture area restoration unproved',
    tasks: { 'preview-read': { complete: false, attempts: [] } } }));
  writeFileSync(join(bank, 'area-preview-read-1.json'), JSON.stringify([{ phase: 'ready', clear: true },
    { phase: 'restored', restored: false, apps: [], exit: { code: 1, signal: null } }]));
  const dir = join(bank, 'preview-read-1-test'); mkdirSync(dir); mkdirSync(join(dir, 'collections'));
  const result = { actualTask: 'preview-read', cleanupConfirmed: true, benchExit: { code: 0, signal: null } };
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result));
  writeFileSync(join(dir, 'bench-result.json'), JSON.stringify({ cleanupConfirmed: true, row: { groupClean: true,
    fixtureDiagnostics: [{ windowCleanupConfirmed: true, helperCollectionConfirmed: true, appQuit: true }] } }));
  writeFileSync(join(dir, 'collections', '1.json'), JSON.stringify({ collected: true, hosts: [{ collected: true }] }));
  assert.equal(areaRecoveryPlan(bank, lock).collectedTasks.length, 1);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ ...result, cleanupConfirmed: false }));
  assert.throws(() => areaRecoveryPlan(bank, lock), /collection unproved/);
});
