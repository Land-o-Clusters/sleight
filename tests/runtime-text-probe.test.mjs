import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { metadata, receipt, processEvidence } from './runtime-gate-fixtures.mjs';
import { textProbePlan, scoreTextProbe, runTextProbe } from '../bench/runtime-text-probe.mjs';
import { measureTextDelivery, restartTextProbeFixture } from '../bench/runtime-probe-live.mjs';

const evidence = cell => ({ observed: true, background: true, posted: true, caretConfirmed: true,
  textMatches: true, exactText: true, characters: [...cell.text].length, elapsedMs: 4000,
  delivery: 'sent-verified', textBeliefFallback: false });
const report = () => ({ textBelief: 'fallback', cleanupConfirmed: true, cells: textProbePlan().map(cell => ({ ...cell,
  attempted: 10, passes: 10, trialsData: Array.from({ length: 10 }, () => ({ passed: true, evidence: evidence(cell) })) })) });
test('UC2F cells contain 2000 ASCII characters and exact café 日本 🙂, ten trials each', () => {
  const plan = textProbePlan(); assert.equal(plan.length, 2);
  assert.equal(plan[0].text, 'x'.repeat(2000)); assert.equal(plan[0].p50LimitMs, 4400);
  assert.equal(plan[1].text, 'café 日本 🙂');
  for (const cell of plan) { assert.equal(cell.trials, 10); assert.equal(cell.requiredPasses, 10); assert.equal(cell.app, 'textedit'); }
});
test('the fallback-switch score requires verified delivery from the new route in every trial', () => {
  for (const patch of [{ delivery: 'sent-unverified' }, { delivery: 'unknown' }, { delivery: 'not-sent' },
    { delivery: undefined }, { textBeliefFallback: true }, { textBeliefFallback: undefined }]) {
    const value = report(); Object.assign(value.cells[0].trialsData[0].evidence, patch);
    const score = scoreTextProbe(value);
    assert.equal(score.passed, false, JSON.stringify(patch)); assert.equal(score.cells[0].passes, 9);
  }
  const baseline = report(); baseline.textBelief = 'always';
  for (const cell of baseline.cells) for (const trial of cell.trialsData) {
    trial.evidence.delivery = 'sent-unverified'; trial.evidence.textBeliefFallback = null;
  }
  assert.equal(scoreTextProbe(baseline).passed, true);
  delete baseline.textBelief; assert.equal(scoreTextProbe(baseline).passed, false);
});
test('the text score requires exact output, all ten trials, the p50 limit and confirmed cleanup', () => {
  assert.equal(scoreTextProbe(report()).passed, true);
  for (const mutate of [r => { r.cleanupConfirmed = false; }, r => { r.stop = 'INTERRUPTED'; },
    r => { r.cells[0].trialsData.pop(); }, r => { r.cells[0].trialsData[0].evidence.exactText = false; },
    r => { r.cells[1].trialsData[0].evidence.characters--; }, r => { r.cells[0].trialsData.forEach(t => { t.evidence.elapsedMs = 4401; }); },
    r => { r.cells[0].trialsData[0].evidence.background = false; }, r => { r.cells[0].trialsData[0].evidence.elapsedMs = NaN; }]) {
    const value = report(); mutate(value); assert.equal(scoreTextProbe(value).passed, false);
  }
});
test('text dry run never consults a backend and cannot qualify the full runtime gate', async () => {
  const result = await runTextProbe({ dryRun: true }, { backend: new Proxy({}, { get() { assert.fail('backend accessed'); } }) });
  assert.equal(result.dryRun, true); assert.equal(result.totalTrials, 20); assert.equal(result.plan.length, 2);
  assert.equal(result.runtime, 'own'); assert.equal(result.qualifiesRuntime, false);
});
test('publication records the selected switch before scoring synthetic delivery receipts', async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-text-score-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.SLEIGHT_DRIVER_TEXT_BELIEF;
  t.after(() => {
    if (previous === undefined) delete process.env.SLEIGHT_DRIVER_TEXT_BELIEF;
    else process.env.SLEIGHT_DRIVER_TEXT_BELIEF = previous;
  });
  for (const mode of ['always', 'fallback']) for (const fallback of [false, true]) {
    process.env.SLEIGHT_DRIVER_TEXT_BELIEF = mode;
    let publications = 0;
    const result = await runTextProbe({ ownerAway: true, out: join(root, `${mode}-${fallback}`) }, {
      platform: 'darwin', held: () => false, load: () => [0, 0, 0], log: () => {},
      takeLock: async () => async () => {},
      backend: { metadata: async () => metadata(), inventory: async () => [], prepare: async () => ({}),
        trial: async (cell, _, __, run) => ({ ...evidence(cell), textBeliefFallback: fallback,
          delivery: fallback ? 'sent-unverified' : 'sent-verified',
          runtimeReceipt: receipt(run.runNonce), processEvidence: processEvidence() }),
        closeFixture: async () => ({ confirmed: true }), close: async () => ({ confirmed: true }) },
      publish: (_, value) => { publications++; assert.equal(value.textBelief, mode);
        assert.equal(value.textProbe.passed, mode === 'always' || !fallback); },
    });
    assert.equal(publications, 1); assert.equal(result.cells.length, 2);
    assert.ok(result.cells.every(cell => cell.passes === 10));
    assert.equal(result.textProbe.qualifiesRuntime, false);
  }
});
test('text probe CLI dry run emits its cells without a live helper', () => {
  const result = spawnSync(process.execPath, ['bench/runtime-text-probe.mjs', '--dry-run'], {
    encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL',
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).totalTrials, 20);
});

test('text measurement times only the action and compares the whole saved fixture exactly', async () => {
  for (const actual of ['café 日本 🙂', 'cafe\u0301 日本 🙂', 'café 日本 🙂\n', 'prefix café 日本 🙂']) {
    const calls = []; let clock = 0;
    const result = await measureTextDelivery({ text: 'café 日本 🙂', now: () => clock,
      prepare: async () => { calls.push('prepare'); clock += 10; },
      action: async text => { calls.push(text); clock += 42; return { charactersDelivered: [...text].length,
        charactersPosted: [...text].length, delivery: 'sent-verified', textBeliefFallback: false, compositionBypassed: true }; },
      readback: async () => { calls.push('save'); clock += 100; return actual; } });
    assert.equal(result.elapsedMs, 42); assert.equal(result.exactText, actual === 'café 日本 🙂');
    assert.equal(result.characters, [...actual].length); assert.deepEqual(calls, ['prepare', 'café 日本 🙂', 'save']);
    assert.equal(result.delivery, 'sent-verified'); assert.equal(result.charactersPosted, 9);
    assert.equal(result.textBeliefFallback, false); assert.equal(result.compositionBypassed, true);
  }
});

test('each repeated text trial resets the closed owned file before reopening it', async () => {
  let value = 'previous successful text'; const calls = [];
  await restartTextProbeFixture({ close: async () => { calls.push('close'); return { confirmed: true }; },
    reset: async () => { calls.push('reset'); value = 'fixture marker'; },
    launch: async () => { calls.push('launch'); assert.equal(value, 'fixture marker'); } });
  assert.deepEqual(calls, ['close', 'reset', 'launch']);
  await assert.rejects(restartTextProbeFixture({ close: async () => ({ confirmed: false }),
    reset: () => assert.fail('reset after uncertain close'), launch: () => assert.fail('launch after uncertain close') }), /CLEANUP_UNCONFIRMED/);
});
