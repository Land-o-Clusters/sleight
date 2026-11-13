import test from 'node:test';
import assert from 'node:assert/strict';
import { createCostSampler, summarize } from '../bench/hand/cost-sampler.mjs';
import { stagePhaseFigures, stageVerdict, reportMarkdown } from '../bench/hand/stage-cost.mjs';

// A child born and collected between polls must still consume the parked and animating CPU budgets.
test('stage sampling charges collected children and their wakeups to the one host, without counting unrelated hosts', async () => {
  let i = 0;
  const reads = [
    { cpuS: 1, selfCpuS: 1, childrenCpuS: 0, rssKb: 2048, packageWakeups: 10, interruptWakeups: 20,
      childrenPackageWakeups: 0, childrenInterruptWakeups: 0, querySpawns: 2 },
    { cpuS: 1.2, selfCpuS: 1.01, childrenCpuS: 0.19, rssKb: 3072, packageWakeups: 14, interruptWakeups: 28,
      childrenPackageWakeups: 3, childrenInterruptWakeups: 6, querySpawns: 4 },
    { cpuS: 1.4, selfCpuS: 1.02, childrenCpuS: 0.38, rssKb: 2048, packageWakeups: 18, interruptWakeups: 36,
      childrenPackageWakeups: 6, childrenInterruptWakeups: 12, querySpawns: 6 },
  ];
  const sampler = createCostSampler({ rootPid: 42, includeChildren: true, now: () => i * 1000,
    ps: async () => '42 1 0:01.00 2048 /fixture/consent-host --hand\n99 1 0:10.00 2048 /other/consent-host --hand\n1 0 0:20.00 1024 /System/WindowServer',
    observe: async () => ({ pid: 42, processTree: reads[Math.min(i++, 2)], callMonitor: { spawns: i * 2 } }) });
  await sampler.sample(); await sampler.sample(); await sampler.sample();
  const result = summarize(sampler.samples);
  assert.equal(result.hand.hosts, 1);
  assert.equal(result.hand.cpuS, 0.4);
  assert.equal(result.hand.avgPct, 20);
  assert.equal(sampler.samples[1].hosts[42].tree.childrenCpuS, 0.19);
  assert.equal(sampler.samples[1].hosts[42].tree.packageWakeups, 14);
  assert.deepEqual(result.hand.processTree, { selfCpuS: 0.02, childrenCpuS: 0.38, packageWakeups: 8, interruptWakeups: 16,
    childrenPackageWakeups: 6, childrenInterruptWakeups: 12, querySpawns: 4, querySpawnsPerS: 2 });
  const figures = stagePhaseFigures(sampler.samples, { start: 0, activeEnd: 1000, idleEnd: 2000 }, 42);
  assert.equal(figures.hostCpuS, 0.2);
  assert.equal(figures.processTree.animating.childrenCpuS, 0.19);
  assert.match(figures.attribution.scope, /descendant/);
  const report = reportMarkdown(stageVerdict({ runs: [{ round: 1, sizes: { stage: { phases: { quiet: figures } } } }] }));
  assert.match(report, /children CPU[^\n]*0\.19/);
  assert.match(report, /package wakeups[^\n]*4/);
  assert.match(report, /interrupt wakeups[^\n]*8/);
  assert.match(report, /query spawns[^\n]*2/);
});

test('stage sampling refuses missing, invalid and incomplete tree counters instead of using parent-only CPU', async () => {
  for (const processTree of [null, {}, { cpuS: -1 }, { cpuS: 1, rssKb: 2048, packageWakeups: null, interruptWakeups: 1 }]) {
    const sampler = createCostSampler({ rootPid: 42, includeChildren: true,
      ps: async () => '42 1 0:01.00 2048 /fixture/consent-host --hand', observe: async () => ({ pid: 42, processTree }) });
    await sampler.sample();
    assert.deepEqual(sampler.samples[0].hosts, {});
    assert.equal(sampler.samples[0].processTreeMeasured, false);
  }
});

test('stage tree counters are bound to the measured host PID', async () => {
  const processTree = { cpuS: 1, selfCpuS: 1, childrenCpuS: 0, rssKb: 2048, packageWakeups: 1, interruptWakeups: 1,
    childrenPackageWakeups: 0, childrenInterruptWakeups: 0, querySpawns: 1 };
  const sampler = createCostSampler({ rootPid: 42, includeChildren: true,
    ps: async () => '42 1 0:01.00 2048 /fixture/consent-host --hand', observe: async () => ({ pid: 99, processTree }) });
  await sampler.sample();
  assert.deepEqual(sampler.samples[0].hosts, {});
  assert.equal(sampler.samples[0].processTreeMeasured, false);
});
