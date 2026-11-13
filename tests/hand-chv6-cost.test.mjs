import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stageVerdict, reportMarkdown, STAGE_BUDGET } from '../bench/hand/stage-cost.mjs';
import { stageScriptFixture, stageSurfaceChecksFixture } from './fixtures/stage-surface.mjs';

function evidence(phaseCPU = 3.4, beforeCPU = 2, afterCPU = 2.4) {
  const phases = Object.fromEntries(['quiet', 'changing'].map(surface => {
    const script = stageScriptFixture(surface, 'stage');
    const control = (start, cpu) => ({ ...script, start, end: start + 61000, pid: 42,
      surfaceChecks: stageSurfaceChecksFixture(surface, false),
      samples: Array.from({ length: 62 }, (_, i) => ({ t: start + i * 1000, ws: i * 0.1,
        hosts: { 42: { cpu: i * cpu / 100, rssKb: 1024 } },
        status: { pid: 42, shown: false, characterHiddenControl: true } })) });
    return [surface, { ...script, activeS: 61, idleS: 61, hosts: 1, hostAliveThroughout: true,
      surfaceChecks: stageSurfaceChecksFixture(surface), hostAvgPct: phaseCPU,
      control: { layout: 'bracketed/1', before: control(0, beforeCPU), after: control(200000, afterCPU),
        phaseStart: 62000, phaseEnd: 190000 } }];
  }));
  return { runs: [{ round: 1, sizes: { stage: { phases } } }] };
}
const cpu = bank => stageVerdict(bank).runs[0].sizes.stage.checks.find(c => c.name === 'host CPU, animating');

test('CHV6 animating CPU judges the addition over both hidden controls and prints the whole host', () => {
  const bank = evidence(), check = cpu(bank);
  assert.equal(check.verdict, 'pass'); assert.ok(Math.abs(check.value - 1.2) < 1e-9);
  assert.equal(check.wholeHostPct, 3.4); assert.equal(check.limit, 2.5);
  const report = reportMarkdown(stageVerdict(bank));
  assert.match(report, /character addition over the hidden control/);
  assert.match(report, /whole host 3.4%/);
  assert.equal(cpu(evidence(4.7)).verdict, 'pass');
  assert.equal(cpu(evidence(4.7001)).verdict, 'fail');
  assert.equal(cpu(evidence(1)).verdict, 'pass', 'negative additions stay measured');
  assert.ok(cpu(evidence(1)).value < 0);
  assert.deepEqual(STAGE_BUDGET, { hostAvgPct: 2.5, idleHostCpuS: 0.05, wsAvgPct: 3, wsPeakPct: 8,
    rssMiB: 160, cacheBytes: 24 * 1024 ** 2, installMs: 4, startupMs: 400, decodeMs: 40, panelPaddingPt: 48,
    uniqueFraction: 0.95, activeS: 60, idleS: 60, runs: 3, loadAverage: 10 });
});
test('CHV6 CPU addition requires valid matching host controls and retains visibility prerequisites', () => {
  for (const mutate of [p => { delete p.control.after; }, p => { p.control.after.size = 'small'; },
    p => { p.control.before.samples[10].hosts = {}; }, p => { p.control.after.samples[10].status.shown = true; },
    p => { p.visibilityValid = false; }, p => { p.actions[0].frame.at[0]++; }]) {
    const bank = evidence(); mutate(bank.runs[0].sizes.stage.phases.quiet);
    assert.equal(cpu(bank).verdict, 'not-measured');
  }
});
test('CHV6 recorded bank changes only the four valid size CPU bars', { skip: !process.env.CHV6_RECORDED_BANK }, () => {
  const bank = JSON.parse(readFileSync(process.env.CHV6_RECORDED_BANK, 'utf8'));
  const result = stageVerdict(bank);
  const bars = result.runs.flatMap(r => Object.values(r.sizes).flatMap(s => s.checks));
  const counts = Object.fromEntries(['pass', 'fail', 'not-measured'].map(v => [v, bars.filter(c => c.verdict === v).length]));
  assert.deepEqual(counts, { pass: 32, fail: 18, 'not-measured': 58 });
  const valid = bars.filter(c => c.name === 'host CPU, animating' && c.verdict !== 'not-measured');
  assert.equal(valid.length, 4); assert.ok(valid.every(c => c.verdict === 'pass'));
  assert.deepEqual(valid.map(c => Math.round(c.value * 10000) / 10000), [0.69, 0.842, 0.8415, 0.8995]);
  assert.equal(result.verdict, 'fail');
});
