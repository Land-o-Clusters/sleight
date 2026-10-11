import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CONTROL, SHIFT_VARIANT, GATE_RUNS, VARIANT_IF_HANGS, DELIVERY_TIMEOUT_MS,
  ownedTrialPath, probeClientOptions, trialSteps, dryRunPlan, scheduleTrials,
  countHangs, runTrials, runDeliveryCheck, mayCapture, scrubEvidence,
} from '../bench/textedit-save-lock.mjs';

const runner = fileURLToPath(new URL('../bench/textedit-save-lock.mjs', import.meta.url));
const fixtureSource = readFileSync(new URL('../bench/textedit-save-lock.js', import.meta.url), 'utf8');
const runnerSource = readFileSync(new URL('../bench/textedit-save-lock.mjs', import.meta.url), 'utf8');
const path = '/private/tmp/sleight-save-lock-Zk4nfu/trial.txt';

test('cleanup accepts only an owned temporary trial document', () => {
  assert.equal(ownedTrialPath(path), path);
  for (const wrong of ['/private/tmp/other/trial.txt', path + '/../other.txt',
    '/private/tmp/sleight-save-lock-Zk4nfu/other.txt', '~/Documents/notes.txt',
    '/tmp/sleight-save-lock-Zk4nfu/trial.txt']) {
    assert.throws(() => ownedTrialPath(wrong), /owned temporary/);
  }
});

test('hang trials open through the engine Open panel, write through Accessibility, and save with pressKey super+s', () => {
  const steps = trialSteps({ path, variant: CONTROL });
  assert.deepEqual(steps.open.map(s => s.code), [
    'await app.pressKey("super+o")',
    'await app.pressKey("super+shift+g")',
    `await app.typeText(${JSON.stringify(path)})`,
    'await app.pressKey("Return")',
  ]);
  assert.equal(steps.open.every(s => s.source === 'engine'), true);
  assert.deepEqual(steps.edit, [{ source: 'fixture', op: 'write', text: 'ax-lock' }]);
  assert.deepEqual(steps.settle, []);
  assert.deepEqual(steps.save, { source: 'engine', code: 'await app.pressKey("super+s")' });
  assert.equal(steps.capture, false);
  assert.equal(JSON.stringify(steps).includes('open -g'), false);
  assert.equal(JSON.stringify(steps).includes('post-cmd-s'), false);
  assert.equal(JSON.stringify(steps).includes('CGEventPostToPid'), false);
});

test('the shift variant still saves through the engine and only posts Shift after the Accessibility write', () => {
  const steps = trialSteps({ path, variant: SHIFT_VARIANT, marker: 'ax-lock-1' });
  assert.deepEqual(steps.edit, [{ source: 'fixture', op: 'write', text: 'ax-lock-1' }]);
  assert.deepEqual(steps.settle, [{ source: 'fixture', op: 'settle-shift' }]);
  assert.deepEqual(steps.save, { source: 'engine', code: 'await app.pressKey("super+s")' });
});

test('delivery-check types through the engine and requires Cmd+S to save within 2 s', () => {
  const steps = trialSteps({ path, deliveryCheck: true, marker: 'typed' });
  assert.equal(steps.edit.every(s => s.source === 'engine' && s.code.startsWith('await app.pressKey(')), true);
  assert.deepEqual(steps.edit.map(s => s.code), [...'typed'].map(ch => `await app.pressKey(${JSON.stringify(ch)})`));
  assert.deepEqual(steps.save, { source: 'engine', code: 'await app.pressKey("super+s")' });
  assert.equal(steps.saveWithinMs, DELIVERY_TIMEOUT_MS);
  assert.equal(steps.saveWithinMs, 2000);
  assert.equal(steps.edit.some(s => s.op === 'write'), false);
});

test('the probe talks to TextEdit through the relay with change review off and a space probe', () => {
  const probe = async () => ({ status: 'responding' });
  assert.deepEqual(probeClientOptions(probe), {
    relay: true,
    relayOptions: { changeReview: false, spaceProbe: probe },
  });
  assert.match(runnerSource, /probeClient/);
  assert.match(runnerSource, /changeReview:\s*false/);
  assert.match(runnerSource, /spaceProbe/);
});

test('the gate is five control runs and interleaved variants run only after three hangs', async () => {
  assert.equal(GATE_RUNS, 5);
  assert.equal(VARIANT_IF_HANGS, 3);
  const pending = scheduleTrials();
  assert.deepEqual(pending.gate.map(s => s.variant), Array(5).fill(CONTROL));
  assert.equal(pending.variants, null);
  const quiet = scheduleTrials({ controlHangs: 2 });
  assert.deepEqual(quiet.variants, []);
  const noisy = scheduleTrials({ controlHangs: 3 });
  assert.equal(noisy.variants.length > 0, true);
  assert.deepEqual(noisy.variants.filter((_, i) => i % 2 === 0).map(s => s.variant),
    noisy.variants.filter((_, i) => i % 2 === 0).map(() => CONTROL));
  assert.deepEqual(noisy.variants.filter((_, i) => i % 2 === 1).map(s => s.variant),
    noisy.variants.filter((_, i) => i % 2 === 1).map(() => SHIFT_VARIANT));
  const seen = [];
  const quietRun = await runTrials({ trial: async variant => { seen.push(variant); return { hung: false, saved: true }; } });
  assert.deepEqual(seen, Array(5).fill(CONTROL));
  assert.equal(quietRun.variantsRan, false);
  assert.deepEqual(countHangs(quietRun.trials), { total: 0, [CONTROL]: 0 });
  seen.length = 0;
  let n = 0;
  const noisyRun = await runTrials({ trial: async variant => { seen.push(variant); n++; return { hung: n <= 3 && variant === CONTROL, saved: false }; } });
  assert.equal(seen.slice(0, 5).every(v => v === CONTROL), true);
  assert.equal(noisyRun.variantsRan, true);
  assert.equal(seen[5], CONTROL);
  assert.equal(seen[6], SHIFT_VARIANT);
  assert.equal(countHangs(noisyRun.trials).total, 3);
});

test('delivery-check counts a save within 2 s and a late save as a miss', async () => {
  let clock = 0;
  const ok = await runDeliveryCheck({
    now: () => clock, savedAt: () => 1500, timeoutMs: 2000,
    edit: async () => {}, save: async () => { clock = 1500; },
  });
  assert.deepEqual(ok, { saved: true, delayMs: 1500, timeoutMs: 2000 });
  clock = 0;
  const late = await runDeliveryCheck({
    now: () => clock, savedAt: () => 2001, timeoutMs: 2000,
    edit: async () => {}, save: async () => { clock = 2001; },
  });
  assert.equal(late.saved, false);
  assert.equal(late.delayMs, 2001);
});

test('Open panel stages are never captured and evidence drops panel frames', () => {
  assert.equal(mayCapture('open'), false);
  assert.equal(mayCapture('go-to-folder'), false);
  assert.equal(mayCapture('open-panel'), false);
  assert.equal(mayCapture('document'), true);
  const raw = {
    path: '/Users/exampleuser/Projects/sleight',
    frames: [
      { stage: 'open-panel', title: 'Open', image: { type: 'image', data: 'pixels' } },
      { stage: 'document', title: 'trial.txt', text: 'ax-lock' },
    ],
    content: [{ type: 'image', data: 'panel' }, { type: 'text', text: 'ok' }],
  };
  const clean = scrubEvidence(raw, { home: '/Users/exampleuser', username: 'exampleuser' });
  assert.equal(clean.path, '~/Projects/sleight');
  assert.equal(JSON.stringify(clean).includes('pixels'), false);
  assert.equal(JSON.stringify(clean).includes('panel'), false);
  assert.equal(JSON.stringify(clean).includes('/Users/exampleuser'), false);
  assert.equal(clean.frames.length, 1);
  assert.equal(clean.frames[0].title, 'trial.txt');
  assert.deepEqual(clean.content, [{ type: 'text', text: 'ok' }]);
});

test('dry-run prints the rebuilt plan and does not take the live lock', () => {
  const lock = '/tmp/sleight-live.lock';
  const before = existsSync(lock);
  const result = spawnSync(process.execPath, [runner, '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.lock, false);
  assert.equal(plan.captureOpenPanel, false);
  assert.equal(plan.cleanup, 'pid-lookup');
  assert.deepEqual(plan.probeClient, { relay: true, relayOptions: { changeReview: false, spaceProbe: true } });
  assert.equal(plan.gate.runs, 5);
  assert.equal(plan.gate.variantsIfHangs, 3);
  assert.equal(plan.gate.interleaved, true);
  assert.equal(plan.steps.save.code, 'await app.pressKey("super+s")');
  assert.equal(plan.steps.save.source, 'engine');
  assert.deepEqual(plan.steps.open.map(s => s.code), [
    'await app.pressKey("super+o")',
    'await app.pressKey("super+shift+g")',
    `await app.typeText(${JSON.stringify('/private/tmp/sleight-save-lock-dry/trial.txt')})`,
    'await app.pressKey("Return")',
  ]);
  assert.equal(JSON.stringify(plan).includes('open -g'), false);
  assert.equal(JSON.stringify(plan).includes('CGEventPostToPid'), false);
  assert.equal(existsSync(lock), before);
  assert.deepEqual(plan, dryRunPlan());
});

test('delivery-check dry-run names typed keys, engine Cmd+S, and a 2 s save bound', () => {
  const result = spawnSync(process.execPath, [runner, '--dry-run', '--delivery-check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.deliveryCheck, true);
  assert.equal(plan.steps.saveWithinMs, 2000);
  assert.equal(plan.steps.edit[0].source, 'engine');
  assert.match(plan.steps.save.code, /pressKey\("super\+s"\)/);
});

test('the fixture writes through Accessibility, looks up the TextEdit PID at cleanup, and does not post Cmd+S', () => {
  assert.match(fixtureSource, /AXUIElementSetAttributeValue/);
  assert.match(fixtureSource, /AXValue/);
  assert.match(fixtureSource, /settle-shift/);
  assert.match(fixtureSource, /kVK_Shift|56/);
  assert.match(fixtureSource, /runningApplicationsWithBundleIdentifier/);
  assert.match(fixtureSource, /lookup-pid|textEditPid/);
  assert.equal(/kVK_ANSI_S|keycode 1|keyCode:\s*1/.test(fixtureSource), false);
  assert.equal(fixtureSource.includes('screencapture'), false);
  assert.equal(fixtureSource.includes('open -g'), false);
  assert.doesNotMatch(fixtureSource, /CGEventCreateKeyboardEvent\([^)]*1\s*,/);
});
