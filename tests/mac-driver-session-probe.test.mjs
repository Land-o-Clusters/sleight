import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lockedProbePlan, lockedProbePreflight, main } from '../bench/locked-probe.mjs';
import * as probe from '../bench/locked-probe.mjs';

// Independent names copied from remote-approvals.js readPresence, not Swift.
const sessionKeys = ['kCGSSessionOnConsoleKey', 'kCGSessionLoginDoneKey', 'CGSSessionScreenIsLocked'];
const lockedSession = Object.fromEntries(sessionKeys.map(key => [key, true]));

test('locked probe contains 15 planned trials and no live results', () => {
  const plan = lockedProbePlan();
  assert.equal(plan.mode, 'plan-only'); assert.equal(plan.liveExecution, false); assert.equal(plan.totalTrials, 15);
  for (const cell of ['posted-click', 'typed-text', 'window-capture']) {
    assert.deepEqual(plan.trials.filter(t => t.cell === cell).map(t => t.trial), [1, 2, 3, 4, 5]);
  }
  for (const trial of plan.trials) {
    assert.deepEqual(trial.before, { method: 'health', params: {} }); assert.deepEqual(trial.after, trial.before);
    assert.equal(trial.request.params.allowLocked, true);
    assert.match(trial.request.params.windowId, /^</); assert.match(trial.request.params.processStart, /^</);
    assert.equal(trial.verdict, undefined);
  }
});

test('all 15 matching unlocked baseline trials precede locking and must pass', () => {
  const plan = lockedProbePlan();
  assert.equal(plan.baselineTrialCount, 15);
  assert.equal(plan.totalTrialRequests, 33); assert.equal(plan.totalHealthRequests, 66); assert.equal(plan.totalRequests, 99);
  const lockIndex = plan.steps.findIndex(step => step.id === 'owner-lock');
  for (const [index, trial] of plan.baselineTrials.entries()) {
    assert.ok(plan.steps.indexOf(trial) < lockIndex);
    assert.equal(trial.cell, plan.trials[index].cell);
    assert.equal(trial.trial, plan.trials[index].trial);
    assert.equal(trial.request.method, plan.trials[index].request.method);
    assert.equal(Object.hasOwn(trial.request.params, 'allowLocked'), false);
    assert.equal(trial.expected.sessionLocked, false);
  }
  const verify = plan.steps.find(step => step.id === 'verify-baseline');
  assert.equal(verify.requireVerifiedTrials, 15); assert.equal(verify.abortOnFailure, true);
  assert.ok(plan.steps.indexOf(verify) < lockIndex);
  assert.ok(plan.steps.indexOf(verify) > Math.max(...plan.baselineTrials.map(trial => plan.steps.indexOf(trial))));
});

test('unique contributions attribute each input in one comparison per phase', () => {
  const plan = lockedProbePlan();
  const digitNames = { One: '1', Two: '2', Three: '3', Four: '4', Five: '5', Six: '6', Seven: '7', Eight: '8', Nine: '9', Zero: '0' };
  const allDigits = [];
  for (const [phase, trials, seed, mode] of [
    ['unlocked', plan.baselineTrials, '', 'one-comparison-before-lock'],
    ['locked', plan.trials, '246', 'one-comparison-after-unlock'],
  ]) {
    const clicks = trials.filter(trial => trial.cell === 'posted-click');
    const digits = clicks.map(trial => digitNames[trial.request.params.args[0].id]);
    allDigits.push(...digits);
    for (const [index, trial] of clicks.entries()) {
      assert.equal(trial.verification.mode, mode);
      assert.equal(trial.verification.contribution, digits[index]);
      assert.equal(trial.verification.expectedFinal, seed + digits.join(''));
    }
    const typing = trials.filter(trial => trial.cell === 'typed-text');
    const markers = typing.map(trial => trial.request.params.args[0]);
    assert.equal(new Set(markers).size, 5);
    for (const [index, trial] of typing.entries()) {
      assert.equal(trial.verification.mode, mode);
      assert.equal(trial.verification.contribution, markers[index]);
      assert.equal(trial.verification.expectedFinal, (phase === 'locked' ? 'LOCKED ' : '') + markers.join(''));
    }
  }
  assert.equal(allDigits.length, 10); assert.equal(new Set(allDigits).size, 10);
  const seed = plan.steps.find(step => step.id === 'prepare-locked');
  assert.equal(seed.calculatorDisplay, '246'); assert.equal(seed.texteditText, 'LOCKED ');
});

test('three planned default controls omit allowLocked and require no delivery', () => {
  const plan = lockedProbePlan();
  assert.equal(plan.controlCount, 3); assert.equal(plan.controls.length, 3);
  assert.deepEqual(plan.controls.map(control => control.request.method), ['click', 'typeText', 'getScreenshot']);
  assert.deepEqual(plan.controls[0].request.params.args, [{ id: 'AC' }]);
  assert.deepEqual(plan.controls[1].request.params.args, ['CTRL-1 ']);
  for (const control of plan.controls) {
    assert.equal(Object.hasOwn(control.request.params, 'allowLocked'), false);
    assert.equal(control.expected.code, 'SCREEN_LOCKED'); assert.equal(control.expected.delivery, 'not-sent');
    assert.equal(control.expected.retry, 'safe'); assert.equal(control.expected.captureBytes, 0);
    assert.equal(control.expected.effect, 'unchanged');
    assert.ok(plan.steps.indexOf(control) < plan.steps.indexOf(plan.trials[0]));
  }
});

test('each locked block persists the complete raw dictionary before preflight and after requests', () => {
  const plan = lockedProbePlan();
  const firstLocked = plan.steps[plan.steps.findIndex(step => step.id === 'owner-lock') + 1];
  assert.equal(firstLocked.kind, 'session-evidence'); assert.equal(firstLocked.boundary, 'before');
  const samples = plan.steps.filter(step => step.kind === 'session-evidence');
  assert.equal(samples.length, 8);
  for (const block of new Set(samples.map(sample => sample.block))) {
    const [before, after] = samples.filter(sample => sample.block === block);
    assert.equal(before.boundary, 'before'); assert.equal(after.boundary, 'after');
    const requests = plan.steps.slice(plan.steps.indexOf(before) + 1, plan.steps.indexOf(after));
    assert.equal(requests.length, block === 'locked-controls' ? 3 : 5);
    assert.ok(requests.every(step => step.request && step.phase === 'locked'));
  }
  for (const sample of samples) {
    assert.ok(sample.localRecord.includes('rawSessionDictionary'));
    assert.ok(sample.localRecord.includes('rawSessionValueTypes'));
    assert.equal(sample.record.includes('rawSessionDictionary'), false);
    assert.equal(sample.rawSessionDestination, plan.sessionEvidence.local.path);
    assert.match(sample.rawSessionDictionary, /Every key and value.*without filtering or truncation/);
    assert.equal(sample.persistBeforeGate, true); assert.equal(sample.gate, 'lockedProbePreflight');
    assert.equal(sample.requiredPostingPath, 'pid-targeted'); assert.equal(sample.ownerSaysLocked, true);
    assert.ok(sample.abortIf.includes('lock-key-absent'));
  }
});

test('raw session evidence stays in a private cache file and published health has only four keys', () => {
  const plan = lockedProbePlan();
  assert.equal(plan.sessionEvidence.local.path,
    '~/Library/Caches/sleight-bench/rt24/<sitting-id>/session-dictionaries.jsonl');
  assert.equal(plan.sessionEvidence.local.mode, '0600');
  assert.equal(plan.sessionEvidence.local.directoryMode, '0700');
  assert.equal(plan.sessionEvidence.local.publish, false);
  assert.match(plan.sessionEvidence.local.valueTypes, /CFBoolean.*CFNumber/);
  assert.deepEqual(plan.sessionEvidence.published.keys, ['onConsole', 'loginDone', 'sessionLocked', 'hidIdleSeconds']);
  assert.equal(plan.sessionEvidence.published.additionalKeys, false);
  assert.match(plan.procedure.join(' '), /Never publish raw dictionaries, their key lists or value types/);
});

test('display sleep collector reads the fixture display without waking it', () => {
  const collector = lockedProbePlan().displaySleepCollector;
  assert.equal(collector.api, 'CGDisplayIsAsleep(displayID)');
  assert.equal(collector.displayID, 'Fixture display ID recorded while unlocked.');
  assert.equal(collector.readOnly, true);
  assert.equal(collector.wakesDisplay, false);
  assert.equal(collector.onFailure, 'unknown');
  assert.match(collector.note, /before and after every trial and control/);
});

test('Calculator comparison strips grouping separators while preserving wrong or missing digits', () => {
  assert.equal(typeof probe.calculatorDisplayMatches, 'function');
  for (const [display, expected, matches] of [
    ['24,678,945', '24678945', true], ['12,360', '12360', true], ['24678945', '24678945', true],
    ['24 678 945', '24678945', true], ['24\u00a0678\u00a0945', '24678945', true],
    ['24\u202f678\u202f945', '24678945', true], ['24\u2009678\u2009945', '24678945', true],
    ["24'678'945", '24678945', true], ['24\u2019678\u2019945', '24678945', true],
    ['2,467,895', '24678945', false], ['246,778,945', '24678945', false],
    ['123.60', '12360', false], ['-12,360', '12360', false], ['Display: 12,360', '12360', false],
    ['', '12360', false], [null, '12360', false], [12360, '12360', false], ['', '', false],
  ]) assert.equal(probe.calculatorDisplayMatches(display, expected), matches, JSON.stringify(display));
  const plan = lockedProbePlan();
  for (const trial of [...plan.baselineTrials, ...plan.trials].filter(trial => trial.cell === 'posted-click')) {
    assert.equal(trial.verification.compare, 'calculatorDisplayMatches');
  }
  assert.match(plan.calculatorComparison, /Strip thousands separators.*preserve decimal points and signs/);
});

test('locked sitting aborts on an absent lock key even though the driver assumes unlocked', () => {
  const rawSessionDictionary = { [sessionKeys[0]]: true, [sessionKeys[1]]: true, ExtraKey: { nested: [42, 'raw'] } };
  const original = structuredClone(rawSessionDictionary);
  assert.deepEqual(lockedProbePreflight({ postingPath: 'pid-targeted', ownerSaysLocked: true, rawSessionDictionary }),
    { abort: true, reason: 'LOCK_KEY_ABSENT_WHILE_OWNER_REPORTS_LOCKED' });
  assert.deepEqual(rawSessionDictionary, original);
});

test('locked preflight admits only a verified console lock on the PID posting path', () => {
  const evidence = { postingPath: 'pid-targeted', ownerSaysLocked: true, rawSessionDictionary: lockedSession };
  assert.deepEqual(lockedProbePreflight(evidence), { abort: false });
  assert.equal(lockedProbePreflight({ ...evidence, rawSessionDictionary: Object.fromEntries(sessionKeys.map(key => [key, 1])) }).abort, false);
  for (const postingPath of [undefined, null, 'session-tap', 'global', 'pid-with-fallback']) {
    assert.deepEqual(lockedProbePreflight({ ...evidence, postingPath }), { abort: true, reason: 'POSTING_PATH_NOT_PID_TARGETED' });
  }
  for (const postingPath of [null, 'session-tap', 'global', 'pid-with-fallback']) {
    assert.throws(() => lockedProbePlan({ postingPath }), /POSTING_PATH_NOT_PID_TARGETED/);
  }
  assert.deepEqual(lockedProbePlan().transport, { postingPath: 'pid-targeted', allowFallback: false,
    requiredBinding: 'fixture-pid-and-processStart', abortOnMismatch: true });
  for (const key of sessionKeys) for (const value of [false, 0, 'true', '1', 2, null]) {
    assert.equal(lockedProbePreflight({ ...evidence, rawSessionDictionary: { ...lockedSession, [key]: value } }).abort, true);
  }
  assert.equal(lockedProbePreflight({ ...evidence, ownerSaysLocked: false }).abort, true);
  assert.equal(lockedProbePreflight({ ...evidence, rawSessionDictionary: null }).abort, true);
  assert.equal(lockedProbePreflight().abort, true);
});

test('every request records display sleep and capture status independently of reply success', () => {
  const plan = lockedProbePlan();
  for (const field of ['displaySleepBefore', 'displaySleepAfter', 'displaySleepEvidenceSource',
    'displaySleepTimestampBefore', 'displaySleepTimestampAfter', 'capture.status', 'capture.note']) {
    assert.ok(plan.resultFields.includes(field));
  }
  assert.match(plan.acceptance, /Capture status unavailable or missing bytes cannot pass/);
  const requests = plan.steps.filter(step => step.request);
  assert.equal(requests.length, 33); assert.equal(new Set(requests.map(step => step.id)).size, 33);
  assert.ok(requests.every(step => step.before.method === 'health' && step.after.method === 'health'));
  assert.match(plan.prerequisites.join(' '), /Refuse to plan a trial on any other posting path/);
});

test('probe requires owner locking, default refusals, verified effects and cleanup', () => {
  const text = JSON.stringify(lockedProbePlan());
  for (const pattern of [/locks the screen manually/, /Never programmatically lock or unlock/,
    /All three must refuse SCREEN_LOCKED/, /Stop on unlock/, /Never repeat input/,
    /After the owner unlocks/, /including failures/, /verifies cleanup/]) assert.match(text, pattern);
});

test('probe refuses every invocation except the exact dry run', () => {
  for (const args of [[], ['--live'], ['--run'], ['--dry-run', '--live'], ['--dry-run', '--dry-run']]) {
    let out = '', err = '';
    assert.equal(main(args, { stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } } }), 64);
    assert.equal(out, ''); assert.match(err, /Live execution is unavailable/);
  }
});

test('probe dry-run CLI emits parseable plan JSON without a runtime import', () => {
  const stdout = execFileSync(process.execPath, ['bench/locked-probe.mjs', '--dry-run'], { killSignal: 'SIGKILL', timeout: 10000, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(stdout), lockedProbePlan());
  const source = readFileSync(new URL('../bench/locked-probe.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from ['"](.+)['"]/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['node:url', 'node:path']);
});
