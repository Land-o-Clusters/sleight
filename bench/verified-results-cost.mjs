// Offline CPU measurement with paired arms and observed host load. No apps or load workers.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (!['idle', 'loaded'].includes(mode) || process.argv.length !== 3) throw new Error('Use idle or loaded');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = '/private/tmp/sleight-verified-results-cost-resumed.json';
const preFeatureCommit = '33c4ddd71d001faa1244a4d6bc9dc3e7f182dfb4';
const report = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {
  method: 'process.cpuUsage user + system; only process() timed; alternating paired arms',
  preFeatureCommit, node: process.version, platform: process.platform, arch: process.arch,
  idle: 'one-minute host load below 10', loaded: 'one-minute host load at least 10',
  samplesPerCase: 5, warmupCallsPerSample: 20, addedLoadWorkers: 0, attempts: [],
};
const attempt = { mode, pid: process.pid, started: new Date().toISOString(), loadStart: loadavg(), sources: {}, cases: [] };
report.attempts.push(attempt);
const publish = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const condition = () => {
  if (existsSync('/tmp/sleight-hold')) throw new Error('sleight-hold exists; CPU work stopped');
  const load = loadavg();
  if ((mode === 'idle') !== (load[0] < 10)) throw new Error(`${mode} condition unavailable at load ${load[0]}`);
  return load;
};
const text = text => ({ type: 'text', text });
const tree = (lines, value, rename = false) => ['Window: "cpu.txt", App: TextEdit.',
  '0 standard window cpu.txt, URL: file:///tmp/cpu.txt',
  ...Array.from({ length: lines - 2 }, (_, i) => `\t${i + 1} text field (settable) ${rename ? 'Changed' : 'Field'} ${i}, Value: ${i === lines - 3 ? value : 'a'}`)].join('\n');
try {
  condition();
  const sources = {
    before: execFileSync('/usr/bin/git', ['show', preFeatureCommit + ':plugins/sleight/lib/compact-reads.mjs'], { cwd: root, encoding: 'utf8' }),
    after: readFileSync(new URL('../plugins/sleight/lib/compact-reads.mjs', import.meta.url), 'utf8'),
  };
  const modules = {};
  for (const [arm, source] of Object.entries(sources)) {
    attempt.sources[arm] = createHash('sha256').update(source).digest('hex');
    const loaded = source.replace("'./document-scope.mjs'", JSON.stringify(new URL('../plugins/sleight/lib/document-scope.mjs', import.meta.url).href));
    modules[arm] = await import('data:text/javascript;base64,' + Buffer.from(loaded).toString('base64'));
  }
  for (const lines of [300, 3000]) {
    const first = tree(lines, 'a');
    for (const [name, second] of [['unchanged', first], ['one-value', tree(lines, 'b')], ['all-element-labels', tree(lines, 'a', true)]]) {
      const iterations = name === 'all-element-labels' ? (lines === 3000 ? 10 : 100) : (lines === 3000 ? 100 : 500);
      const row = { lines, name, iterations, samples: { before: [], after: [] } };
      attempt.cases.push(row);
      for (let sample = 0; sample < 5; sample++) {
        for (const arm of sample % 2 ? ['after', 'before'] : ['before', 'after']) {
          const loadStart = condition();
          const { createReadCompactor, GUARD_MARK, GUARD_END } = modules[arm];
          const inputs = [first, second].map(tree => [text(GUARD_MARK + tree + GUARD_END)]);
          const c = createReadCompactor(); c.process([text(first)]);
          for (let i = 0; i < 20; i++) c.process(inputs[i % 2], { action: c.beginAction?.('await app.typeText("b")') });
          let user = 0, system = 0;
          const wallStart = performance.now();
          for (let i = 0; i < iterations; i++) {
            if (i % 16 === 0) condition();
            const action = c.beginAction?.('await app.typeText("b")');
            const start = process.cpuUsage();
            const result = c.process(inputs[i % 2], { action });
            const used = process.cpuUsage(start);
            user += used.user; system += used.system;
            if (!result[0]?.text) throw new Error('Missing compactor output');
          }
          const measurement = { sample, userMs: user / 1000, systemMs: system / 1000,
            cpuMsPerCall: (user + system) / 1000 / iterations, wallMs: performance.now() - wallStart,
            loadStart, loadEnd: loadavg() };
          row.samples[arm].push(measurement);
          publish();
          condition();
        }
      }
      row.medians = Object.fromEntries(Object.entries(row.samples).map(([arm, values]) => [arm, median(values.map(s => s.cpuMsPerCall))]));
      row.addedCpuMsPerCall = row.medians.after - row.medians.before;
      publish();
      console.log(JSON.stringify({ mode, lines, name, ...row.medians, added: row.addedCpuMsPerCall }));
    }
  }
  attempt.exitCode = 0;
} catch (error) {
  attempt.error = error.message; attempt.exitCode = 1; process.exitCode = 1;
} finally {
  attempt.finished = new Date().toISOString(); attempt.loadEnd = loadavg(); publish();
}
console.log(JSON.stringify({ mode, exitCode: attempt.exitCode, error: attempt.error, output }));
