// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
// H6, the ghost hand cost pass: the ps sampler, the trace reader, the side-by-side comparison and the pass against fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { parsePs, isHandHost, isWindowServer, createCostSampler, summarize } from '../bench/hand/cost-sampler.mjs';
import { schedule, runArgs, resultsPath, traceStats, traceDirs, compareSides, reportMarkdown, runSide, runCostPass, parseArgs, BUDGET, budgetFor, CLAIM_TASKS } from '../bench/hand/cost-pass.mjs';
import * as costPass from '../bench/hand/cost-pass.mjs';

const WS = '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon';
const HOST = `${MAC_USERS}x/Library/Caches/sleight/turbo-host/abc/consent-host --hand --capture=hidden --menu`;
const psLine = (pid, ppid, time, rss, command) => `${pid} ${ppid} ${time} ${rss} ${command}`;

test('ps rows: WindowServer and hand hosts by command, CPU time in seconds', () => {
  assert.deepEqual(parsePs([psLine(405, 1, '2006:32.36', 207536, WS), '  12 1 0:01.50 900 /bin/zsh -l', 'junk'].join('\n')), [
    { pid: 405, ppid: 1, cpu: 120392.36, rssKb: 207536, command: WS }, { pid: 12, ppid: 1, cpu: 1.5, rssKb: 900, command: '/bin/zsh -l' }]);
  assert.ok(isHandHost(HOST)); assert.ok(isHandHost('/x/consent-host --hand'));
  assert.equal(isHandHost('/x/consent-host'), false, 'turbo\'s own consent host is not the hand');
  assert.equal(isHandHost('/x/consent-host --hand-demo 1,2,3,4'), false);
  assert.ok(isWindowServer(WS)); assert.equal(isWindowServer('/usr/sbin/distnoted'), false);
});

// A pass's process tree (100 → 101 → 102 relay → 103 hand), the owner's own session's hand (200 → 203), and WindowServer.
function fakePs(script) {
  let i = 0;
  return async () => script[Math.min(i++, script.length - 1)].join('\n');
}

test('the sampler counts only hand hosts below the pass, keeps one after its parent goes, and samples WindowServer', async () => {
  const tree = [psLine(101, 100, '0:01.00', 1000, 'claude'), psLine(102, 101, '0:02.00', 1000, 'node launch.mjs'), psLine(203, 200, '0:09.00', 40000, HOST)];
  const script = [
    [psLine(405, 1, '10:00.00', 1, WS), ...tree],
    [psLine(405, 1, '10:00.50', 1, WS), ...tree, psLine(103, 102, '0:00.10', 30000, HOST)],
    [psLine(405, 1, '10:01.70', 1, WS), psLine(203, 200, '0:12.00', 40000, HOST), psLine(103, 1, '0:00.30', 34000, HOST)],
    [psLine(405, 1, '10:01.80', 1, WS), psLine(203, 200, '0:15.00', 40000, HOST), psLine(103, 1, '0:00.30', 34000, HOST)],
  ];
  let t = 0;
  const sampler = createCostSampler({ rootPid: 100, ps: fakePs(script), now: () => (t += 1000), intervalMs: 1e9 });
  await sampler.start(); await sampler.sample(); await sampler.sample();
  const samples = await sampler.stop();
  assert.deepEqual(samples.map(s => Object.keys(s.hosts)), [[], ['103'], ['103'], ['103']]);
  const s = summarize(samples);
  assert.equal(s.wallS, 3);
  assert.deepEqual(s.windowServer, { cpuS: 1.8, avgPct: 60, peakPct: 120, p95Pct: 120 });
  // 103 started inside the window: it counts from 0. 0.3 s of CPU over 3 s.
  assert.deepEqual(s.hand, { hosts: 1, cpuS: 0.3, avgPct: 10, peakRssMB: 33.2, liveIntervals: 2, idleIntervals: 1 });
  // A window that starts once the host is running counts from its first value there.
  assert.equal(summarize(samples, { from: 3000 }).hand.cpuS, 0);
  assert.equal(summarize(samples, { from: 9000 }).windowServer, null);
});

test('traceStats: per-call tool times and the hand\'s events from relay trace lines', () => {
  const at = ms => new Date(Date.UTC(2026, 9, 19, 12, 0, 0) + ms).toISOString();
  const lines = [
    { t: at(0), direction: 'call-received', msg: { id: 1, params: { name: 'js' } } },
    { t: at(5), direction: 'hand-started', msg: { pid: 9 } },
    { t: at(10), direction: 'hand-beat', msg: { id: 1, action: 0, driftMs: -12 } },
    { t: at(20), direction: 'hand-beat', msg: { id: 1, action: 1, driftMs: 30 } },
    { t: at(30), direction: 'hand-skipped', msg: { id: 1, reason: 'covered' } },
    { t: at(400), direction: 'to-client', msg: { id: 1, result: {} } },
    { t: at(500), direction: 'call-received', msg: { id: 2, params: { name: 'js' } } },
    { t: at(520), direction: 'to-client', msg: { method: 'notifications/progress', id: 2 } },
    { t: at(800), direction: 'to-client', msg: { id: 2, result: {} } },
    { t: at(900), direction: 'hand-off', msg: { reason: 'exit' } },
  ].map(JSON.stringify).concat(['not json']);
  const s = traceStats(lines);
  assert.deepEqual(s.toolMs, [400, 300]);
  assert.deepEqual(s.hand, { started: 1, off: { exit: 1 }, skipped: { covered: 1 }, dropped: 0, restarts: 0, beats: 2, drift: [-12, 30] });
});

test('the schedule alternates which side runs first by round and task, each side once per task per round', () => {
  const steps = schedule(['a', 'b'], 2);
  assert.deepEqual(steps.map(s => `${s.round}${s.task}${s.side}`), ['1aoff', '1aon', '1bon', '1boff', '2aon', '2aoff', '2boff', '2bon']);
  assert.equal(schedule(CLAIM_TASKS, 3).length, 18);
  assert.deepEqual(runArgs({ task: 'textedit-save', model: 'claude-haiku-5-5', effort: 'high' }),
    ['bench/run.mjs', '--suite', 'world', '--arm', 'sleight', '--tasks', 'textedit-save', '--runs', '1', '--model', 'claude-haiku-5-5', '--effort', 'high', '--owner-away']);
  assert.equal(resultsPath('x\n\nresults: /r/bench/results/2026-10-19T12-00-00-000Z.json\n'), '/r/bench/results/2026-10-19T12-00-00-000Z.json');
  const base = join(tmpdir(), 'trace-paths'), armHome = join(base, 'arms');
  assert.deepEqual(traceDirs('S', 'calculator-click', 1, [base], armHome), [join(armHome, 'evidence/S/sleight-calculator-click-1'),
    join(base, 'sleight-real-evidence/S/sleight-calculator-click-1'), join(base, 'sleight-bench/S/sleight-calculator-click-1')]);
  assert.throws(() => parseArgs(['--rounds', '0']), /from 1 to 10/);
  assert.deepEqual(parseArgs([]).tasks, CLAIM_TASKS);
  assert.equal(parseArgs([]).cursorStyle, undefined); assert.equal(parseArgs(['--cursor-style', 'sprite']).cursorStyle, 'sprite');
  assert.throws(() => parseArgs(['--cursor-style', 'Sprite']), /--cursor-style/);
});

test('trace lookup reads durable evidence first and retains both temp spellings for old traces', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'hand-trace-'))), armHome = join(root, 'arms');
  const temp = join(root, 'temp'), alias = join(root, 'alias'); mkdirSync(temp); symlinkSync(temp, alias);
  const previous = process.env.TMPDIR; process.env.TMPDIR = alias;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  const dirs = traceDirs('S', 'calculator-click', 1, undefined, armHome);
  assert.deepEqual(dirs, [join(armHome, 'evidence/S/sleight-calculator-click-1'),
    join(alias, 'sleight-real-evidence/S/sleight-calculator-click-1'), join(realpathSync(temp), 'sleight-real-evidence/S/sleight-calculator-click-1'),
    join(alias, 'sleight-bench/S/sleight-calculator-click-1'), join(realpathSync(temp), 'sleight-bench/S/sleight-calculator-click-1')]);
  for (const [index, dir] of [dirs[0], dirs[1]].entries()) {
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'trace-1.jsonl'), String(index));
  }
  assert.equal(readFileSync(join(dirs[0], 'trace-1.jsonl'), 'utf8'), '0');
  assert.equal(readFileSync(join(dirs[2], 'trace-1.jsonl'), 'utf8'), '1');
  assert.equal(typeof costPass.readTraceLines, 'function');
  assert.deepEqual(costPass.readTraceLines(dirs), ['0']);
  rmSync(join(dirs[0], 'trace-1.jsonl'));
  assert.deepEqual(costPass.readTraceLines(dirs), ['1'], 'temp aliases must not double-count the same trace');
});

const entry = (side, { hostCpuS = 0.05, elapsedS = 10, ws = 3, peak = 9, rss = 42, hosts = side === 'on' ? 1 : 0, tool = [500, 600], drift = [], passed = true } = {}) => ({
  side, passed, elapsedS, whole: { hand: { hosts, peakRssMB: side === 'on' ? rss : 0 } },
  window: { windowServer: { avgPct: ws, peakPct: peak }, hand: side === 'on' ? { cpuS: hostCpuS, idleIntervals: 6, liveIntervals: 8 } : { cpuS: 0, idleIntervals: 0, liveIntervals: 0 } },
  trace: { toolMs: tool, hand: { drift, skipped: side === 'on' ? { covered: 1 } : {} } } });

test('compareSides: inside the budget, over it, and invalid when a side measured the wrong thing', () => {
  const within = compareSides([entry('on', { ws: 3.5, peak: 12, drift: [10, -40, 5] }), entry('off', { ws: 3, peak: 9 }), entry('on', { ws: 3.4 }), entry('off', { ws: 2.9 })]);
  assert.equal(within.verdict, 'within', JSON.stringify(within.checks));
  assert.deepEqual(within.checks.map(c => c.value), [0.5, 0.5, 1.5, 42, 0]);
  assert.deepEqual(within.drift, { beats: 3, medianAbsMs: 10, p90AbsMs: 40 });
  assert.deepEqual(within.passes, { on: '2/2', off: '2/2' });
  const md = reportMarkdown(within, { tasks: ['calculator-click'], rounds: 1, model: 'm', effort: 'high', started: 's', finished: 'f' });
  assert.match(md, /Verdict: \*\*within\*\*/); assert.match(md, /\| Hand host CPU per task, % \| 0\.5, 0\.5 \| 0, 0 \|/);
  const over = compareSides([entry('on', { hostCpuS: 0.2, rss: 61, tool: [800, 900] }), entry('off')]);
  assert.equal(over.verdict, 'over');
  assert.deepEqual(over.checks.filter(c => !c.ok).map(c => c.name), ['hand host CPU, highest task average', 'hand host RSS, peak', 'tool time per call, median on minus off']);
  assert.match(compareSides([entry('on', { hosts: 0 }), entry('off')]).invalid[0], /no hand host ran in 1 on-side run/);
  assert.match(compareSides([entry('on'), entry('off', { hosts: 1 })]).invalid[0], /SLEIGHT_HAND=0 did not reach the arm/);
  assert.equal(compareSides([entry('on')]).verdict, 'invalid');
  // No data on a side is no figure: null, never null - null = 0, and the pass is invalid rather than within.
  const blank = e => ({ ...e, window: { windowServer: null, hand: e.window.hand }, trace: { toolMs: [], hand: e.trace.hand } });
  const empty = compareSides([blank(entry('on')), blank(entry('off'))]);
  assert.equal(empty.verdict, 'invalid');
  assert.deepEqual(empty.checks.slice(1, 3).map(c => [c.value, c.ok]), [[null, false], [null, false]]);
  assert.equal(empty.checks[4].value, null);
  assert.deepEqual(empty.invalid, ['no WindowServer average figure on the on side', 'no WindowServer average figure on the off side',
    'no WindowServer busiest second figure on the on side', 'no WindowServer busiest second figure on the off side',
    'no tool time figure on the on side', 'no tool time figure on the off side']);
  const oneSided = compareSides([entry('on'), blank(entry('off'))]);
  assert.equal(oneSided.verdict, 'invalid');
  assert.equal(oneSided.checks[1].value, null);
  assert.equal(BUDGET.hostAvgPct, 1);
  assert.deepEqual(['glove', 'ring', 'seam', 'sprite', undefined].map(style => budgetFor(style).rssMB), [50, 50, 50, 64, 50]);
  assert.equal(budgetFor('sprite').hostAvgPct, BUDGET.hostAvgPct);
  // main() scores with budgetFor(meta.cursorStyle): a 60 MiB peak is over for the ring and within for the sprite.
  const rssCheck = style => compareSides([entry('on', { rss: 60 }), entry('off')], budgetFor(style)).checks.find(c => c.name === 'hand host RSS, peak');
  assert.deepEqual([rssCheck('ring').ok, rssCheck('ring').limit, rssCheck('sprite').ok, rssCheck('sprite').limit], [false, 50, true, 64]);
  const source = readFileSync(new URL('../bench/hand/cost-pass.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/compareSides\([^)]*budgetFor\(/g)?.length, 2); assert.doesNotMatch(source, /compareSides\((saved\.)?entries\)/);
});

test('runSide runs one task with the switch, samples the run\'s own tree and reads its row and trace', async () => {
  const runs = [];
  const deps = {
    env: { PATH: '/bin', SLEIGHT_BENCH_HAND: '1' },
    run: async (args, env) => { runs.push({ args, env }); return { pid: 4242, done: Promise.resolve({ code: 0, stdout: 'results: /r/one.json\n' }) }; },
    sampler: rootPid => { assert.equal(rootPid, 4242); let t = Date.parse('2026-10-19T12:00:00Z');
      const samples = []; const take = cpu => samples.push({ t: (t += 1000), ws: 100 + cpu, hosts: { 7: { cpu, rssKb: 40960 } } });
      return { start: async () => take(0), stop: async () => { for (const c of [0.01, 0.02, 0.02]) take(c); return samples; } }; },
    readJson: path => (assert.equal(path, '/r/one.json'), { stamp: 'S', ghostHand: runs.at(-1).env.SLEIGHT_BENCH_HAND === '1' ? 'on' : 'off',
      results: [{ arm: 'sleight', task: 'calculator-click', passed: true, finishedAt: '2026-10-19T12:00:04Z', timing: { elapsedMs: 3000 } }] }),
    traceLines: dirs => (assert.ok(dirs.every(d => d.includes('/S/sleight-calculator-click-1'))), [JSON.stringify({ t: '2026-10-19T12:00:01Z', direction: 'hand-started', msg: {} })]),
  };
  const on = await runSide(deps, { round: 1, task: 'calculator-click', side: 'on', model: 'm', effort: 'high' });
  assert.equal(runs[0].env.SLEIGHT_BENCH_HAND, '1'); assert.equal(runs[0].env.PATH, '/bin');
  assert.deepEqual([on.passed, on.elapsedS, on.window.hand.cpuS, on.whole.hand.peakRssMB, on.trace.hand.started], [true, 3, 0.02, 40, 1]);
  const off = await runSide(deps, { round: 1, task: 'calculator-click', side: 'off', model: 'm', effort: 'high' });
  assert.equal(runs[1].env.SLEIGHT_BENCH_HAND, '0'); assert.equal(off.error, undefined);
  // A results file that says the other side, a missing file or a missing row is an error entry, never a measurement.
  const wrong = await runSide({ ...deps, readJson: () => ({ stamp: 'S', ghostHand: 'off', results: [] }) }, { round: 1, task: 'calculator-click', side: 'on', model: 'm', effort: 'high' });
  assert.match(wrong.error, /the hand was off, not on/);
  const none = await runSide({ ...deps, run: async () => ({ pid: 4242, done: Promise.resolve({ code: 1, stdout: 'boom' }) }) }, { round: 1, task: 'x', side: 'on', model: 'm', effort: 'high' });
  assert.match(none.error, /exited 1 without a results file/);
  // The whole pass saves after every side and waits out the hold before each.
  const saves = [], waits = [];
  const entries = await runCostPass({ ...deps, waitForHold: async () => waits.push(1) }, { tasks: ['calculator-click'], rounds: 2, save: e => saves.push(e.length) });
  assert.deepEqual([entries.map(e => e.side), saves, waits.length], [['off', 'on', 'on', 'off'], [1, 2, 3, 4], 4]);
});
