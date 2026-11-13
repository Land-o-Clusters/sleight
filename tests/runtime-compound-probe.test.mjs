import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compoundProbePlan, main } from '../bench/runtime-compound-probe.mjs';

test('deferred menu probes require 10 Calculator, 10 TextEdit and 5 Word trials', () => {
  const plan = compoundProbePlan(); assert.equal(plan.totalTrials, 25); assert.equal(plan.executable, false);
  assert.equal(plan.qualification.liveTrialsRun, 0); assert.equal(plan.qualification.passed, false);
  assert.equal(plan.qualification.calculatorMaxTurns, 7);
  assert.deepEqual(plan.cells.map(c => [c.app, c.path, c.trials, c.requiredPasses]), [
    ['calculator', ['View', 'Scientific'], 10, 10], ['textedit', ['File', 'New'], 10, 10],
    ['word', ['Format', 'Font'], 5, 5],
  ]);
  for (const c of plan.cells) {
    assert.equal(c.enabled, false); assert.equal(c.witness.intervalMs, 50);
    assert.equal(c.witness.maxMenuWindows, 0); assert.equal(c.witness.countAppWindows, true);
    assert.equal(c.witness.completeSamplesRequired, true); assert.equal(c.witness.baselineBeforeInput, true);
    assert.equal(c.witness.sampleThroughNextRead, true); assert.equal(c.requiredResult.parentPresses, 0);
    assert.equal(c.requiredResult.leafPresses, 1);
  }
  assert.match(plan.cells[2].fallback, /written fallback/i);
  const canonical = JSON.parse(readFileSync(new URL('../bench/runtime-probe-plan.json', import.meta.url)));
  assert.equal(canonical.cells.length, 29, 'unregistered compounds cannot enter the active qualification plan');
});
test('compound probe CLI --dry-run prints its plan without importing host adapters', () => {
  const result = spawnSync(process.execPath, ['bench/runtime-compound-probe.mjs', '--dry-run'],
    { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).totalTrials, 25);
  const source = readFileSync(new URL('../bench/runtime-compound-probe.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /import.*(?:runtime-probe-live|run\.mjs|live-lock|driver-client)/);
});
test('non-dry compound probe refuses before host access', () => {
  for (const args of [[], ['--owner-away'], ['--dry-run', '--owner-away']])
    assert.throws(() => main(args), /COMPOUND_TRANSPORT_UNREGISTERED/);
});
