import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { resumeCleanup } from '../bench/resume-hygiene.mjs';
import { beginPassHygiene } from '../bench/pass-hygiene.mjs';

function fixture(t) {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'hb1-resume-')));
  const lockPath = join(dir, 'lock'), receipt = join(dir, 'cleanup.json');
  mkdirSync(lockPath);
  const { dev, ino } = statSync(lockPath);
  const app = { pid: 33, start: 123, bundle: 'org.fixture' };
  const window = { ...app, id: 51, title: 'fixture', onScreen: true };
  const data = { version: 1, lock: { dev, ino }, hygiene: { before: { apps: [], windows: [] }, launched: [app] }, leftWindows: [window] };
  writeFileSync(receipt, JSON.stringify(data), { mode: 0o600 });
  return { lockPath, receipt, data, app, window };
}

test('resume waits before preparing host control, quits the retained fixture, and releases its exact lock', async t => {
  const f = fixture(t), calls = [];
  let held = true, running = true;
  const result = await resumeCleanup(f.receipt, { ownerAway: true }, {
    lockPath: f.lockPath, held: () => held, wait: async () => { calls.push('wait'); held = false; },
    control: async () => { assert.equal(held, false); calls.push('control'); return {
      snapshot: async () => ({ apps: running ? [f.app] : [], windows: running ? [f.window] : [] }),
      act: async item => { assert.equal(held, false); assert.equal(item.action, 'quit'); calls.push('quit'); running = false; },
    }; }, permission: async () => false, log() {},
  });
  assert.deepEqual(calls, ['wait', 'control', 'quit']);
  assert.equal(result.complete, true);
  assert.equal(existsSync(f.lockPath), false);
  assert.equal(JSON.parse(readFileSync(f.receipt)).complete, true);
});

test('resume keeps the receipt and lock if a hold reappears before Quit', async t => {
  const f = fixture(t);
  let held = false;
  const result = await resumeCleanup(f.receipt, { ownerAway: true }, {
    lockPath: f.lockPath, held: () => held, wait: async () => {},
    control: async () => ({ snapshot: async () => { held = true; return { apps: [f.app], windows: [f.window] }; },
      act: () => assert.fail('quit during hold') }), permission: async () => false, log() {},
  });
  assert.equal(result.complete, false);
  assert.equal(existsSync(f.lockPath), true);
  assert.equal(JSON.parse(readFileSync(f.receipt)).leftWindows.length, 1);
});

test('resume refuses a replaced lock and missing owner-away before preparing host control', async t => {
  const f = fixture(t), runtime = { lockPath: f.lockPath, wait: async () => {}, control: () => assert.fail('host control') };
  await assert.rejects(resumeCleanup(f.receipt, {}, runtime), /owner-away/);
  writeFileSync(f.receipt, JSON.stringify({ ...f.data, lock: { dev: -1, ino: -1 } }));
  await assert.rejects(resumeCleanup(f.receipt, { ownerAway: true }, runtime), /lock ownership/);
});

test('the real hygiene handle preserves fixture attribution through a JSON receipt and closes only its new window', async t => {
  const f = fixture(t), ownerWindow = { ...f.window, id: 50, title: 'owner window' };
  let running = true, held = true, baselineRead = false;
  const before = { apps: [f.app], windows: [ownerWindow] };
  const after = () => ({ apps: [f.app], windows: running ? [ownerWindow, f.window] : [ownerWindow] });
  const cacheDir = join(join(f.receipt, '..'), 'cache');
  const run = async (command, args) => {
    let stdout = '';
    if (command === '/usr/bin/xcrun') {
      if (args[1] === '--version') stdout = 'fake Swift version';
      else writeFileSync(args.at(-1), 'fake binary');
    } else {
      assert.equal(JSON.parse(args[0]).action, 'snapshot', 'held cleanup invoked a visible helper action');
      stdout = JSON.stringify(baselineRead ? after() : before); baselineRead = true;
    }
    return { stdout, groupClean: true, exit: { code: 0 } };
  };
  const handle = await beginPassHygiene({ cacheDir, run });
  const deferred = await handle.finish({ deferVisible: () => held, touchedApps: [f.app.bundle], fixtureNames: ['fixture'], log() {} });
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.leftWindows[0].id, 51);
  writeFileSync(f.receipt, JSON.stringify({ ...f.data, hygiene: deferred.resume, leftWindows: deferred.leftWindows }));
  const result = await resumeCleanup(f.receipt, { ownerAway: true }, {
    lockPath: f.lockPath, held: () => held, wait: async () => { held = false; }, permission: async () => false, log() {},
    control: async () => ({ snapshot: async () => after(), act: async item => {
      assert.equal(item.action, 'close'); assert.equal(item.id, 51); assert.equal(item.start, 123); running = false;
    } }),
  });
  assert.equal(result.complete, true);
  assert.deepEqual(after().windows, [ownerWindow]);
});

test('receipts-only cleanup defers a windowless cold launch and leaves an honest resume record', async t => {
  const f = fixture(t);
  const { quitLaunched } = await import('../bench/pass-hygiene.mjs');
  const result = await quitLaunched({ launched: [f.app], deferVisible: () => true,
    snapshot: async () => ({ apps: [f.app], windows: [] }), act: () => assert.fail('Quit during hold'), log() {} });
  assert.equal(result.deferred, true);
  assert.equal(result.leftWindows[0].reason, 'cleanup deferred during benchmark hold');
});

test('a permission stop or previously unconfirmed fixture cleanup retains the original lock', async t => {
  for (const permissionStop of [true, false]) {
    const f = fixture(t);
    writeFileSync(f.receipt, JSON.stringify({ ...f.data, fixtureCleanupUnconfirmed: !permissionStop }));
    const result = await resumeCleanup(f.receipt, { ownerAway: true }, {
      lockPath: f.lockPath, held: () => false, wait: async () => {}, permission: async () => permissionStop, log() {},
      control: async () => ({ snapshot: async () => ({ apps: permissionStop ? [f.app] : [], windows: permissionStop ? [f.window] : [] }),
        act: () => assert.fail('permission stop must not act') }),
    });
    assert.equal(result.complete, false);
    assert.equal(existsSync(f.lockPath), true);
  }
});
