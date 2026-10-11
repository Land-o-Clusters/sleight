import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { checkIosVersion } from '../bench/tasks-iphone.mjs';
import { selectSuiteTasks } from '../bench/shop.mjs';
import * as benchmark from '../bench/tasks.mjs';

const getTask = () => {
  const task = benchmark.getTasks('real').find(item => item.id === 'iphone-mirroring-settings');
  assert.ok(task, 'real suite must provide iphone-mirroring-settings');
  return task;
};

test('iOS version check accepts only dotted version text', () => {
  for (const answer of ['18.6.2', '26.0', '27', '27.0.1']) {
    assert.equal(checkIosVersion({ answer }), true, answer);
  }
  // A note after a blank line passes: on 2026-10-11 Claude answered the version and then warned about
  // a mis-tap into Personal Hotspot, which the owner needed to know.
  assert.equal(checkIosVersion({ answer: '27.0.1\n\nMy first tap landed on Personal Hotspot.' }), true);
  for (const answer of ['', 'iOS 18.6.2', '18.6.2 extra', '18.6.2\n', 'v18.6.2', '18.6.2.', '.1', '18.6.2\nextra', 'note\n\n18.6.2']) {
    assert.notEqual(checkIosVersion({ answer }), true, JSON.stringify(answer));
  }
});

test('default real selection excludes iPhone Mirroring, and --tasks can select it', () => {
  const all = benchmark.getTasks('real');
  const selected = selectSuiteTasks(all);
  assert.ok(all.some(task => task.id === 'iphone-mirroring-settings'));
  assert.ok(selected.every(task => task.id !== 'iphone-mirroring-settings'));
  assert.ok(selected.every(task => !task.ownerPresent));
  assert.deepEqual(selectSuiteTasks(all, ['iphone-mirroring-settings']).map(task => task.id),
    ['iphone-mirroring-settings']);
});

test('setup refuses without --owner-present and does not open the app', async () => {
  const task = getTask();
  const ctx = { dir: '/tmp', nonce: 'unit' };
  await assert.rejects(() => task.setup(ctx), error =>
    error.noMutation === true && /owner-present/.test(error.message));
  await assert.rejects(() => task.setup({ ...ctx, ownerAway: true }), error =>
    error.noMutation === true && /owner-present/.test(error.message));
});

test('task is read-only Settings > General > About, with the system bundle ID, and is not allowlisted', () => {
  const task = getTask();
  const bundle = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw',
    '/System/Applications/iPhone Mirroring.app/Contents/Info.plist'], { encoding: 'utf8' }).trim();
  assert.equal(task.app, 'iPhone Mirroring');
  assert.equal(task.bundle, bundle);
  assert.equal(task.bundle, 'com.apple.ScreenContinuity');
  assert.equal(task.ownerPresent, true);
  assert.equal(task.noScreenshot, true);
  const prompt = task.prompt({});
  assert.match(prompt, /Settings/);
  assert.match(prompt, /General/);
  assert.match(prompt, /About/);
  assert.match(prompt, /iOS version/);
  assert.match(prompt, /Read only/);
  assert.doesNotMatch(prompt, /sleight|mcp__|getApp/);
  assert.equal(task.check, checkIosVersion);
  assert.ok(!benchmark.REAL_APPS.includes('iPhone Mirroring'));
  assert.ok(!benchmark.REAL_APPS.includes('com.apple.ScreenContinuity'));
  assert.ok(!benchmark.BENCH_APPS.includes('iPhone Mirroring'));
  assert.ok(!benchmark.BENCH_APPS.includes('com.apple.ScreenContinuity'));
});
