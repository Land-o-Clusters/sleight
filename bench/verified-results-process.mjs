// Offline process() CPU comparison. No engine, app, screenshots or native helpers.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const arm = process.argv[2];
if (!['pre-feature', 'baseline', 'revised'].includes(arm) || process.argv.length !== 3) throw new Error('Use pre-feature, baseline or revised');
const root = fileURLToPath(new URL('../', import.meta.url));
// Stage data in the writable temporary bank; publish it to the report with the reviewed edits.
const output = '/private/tmp/sleight-verified-results-review-cpu.json';
const moduleFile = new URL('../plugins/sleight/lib/compact-reads.mjs', import.meta.url);
const beforeCommit = '3a5fa3edcdd08a3e06757d1512f93b2ea529f19c';
const preFeatureCommit = 'f7392bee7d9a07c103c761a41117866026b70398';
const source = arm !== 'revised'
  ? execFileSync('/usr/bin/git', ['show', (arm === 'baseline' ? beforeCommit : preFeatureCommit) + ':plugins/sleight/lib/compact-reads.mjs'], { cwd: root, encoding: 'utf8' })
  : readFileSync(moduleFile, 'utf8');
const loaded = source.replace("'./document-scope.mjs'", JSON.stringify(new URL('../plugins/sleight/lib/document-scope.mjs', import.meta.url).href));
const { createReadCompactor, GUARD_MARK, GUARD_END } = await import('data:text/javascript;base64,' + Buffer.from(loaded).toString('base64'));
const report = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : { method: 'process.cpuUsage user + system; only process() timed',
  lines: 3000, baselineCommit: beforeCommit, node: process.version, platform: process.platform, arch: process.arch, attempts: [] };
const attempt = { arm, sourceSha256: createHash('sha256').update(source).digest('hex'), started: new Date().toISOString(), cases: [] };
report.attempts.push(attempt);
report.preFeatureCommit = preFeatureCommit;
const publish = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const hold = () => { if (existsSync('/tmp/sleight-hold')) throw new Error('sleight-hold exists; CPU work stopped'); };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const tree = (value, rename = false) => ['Window: "cpu.txt", App: TextEdit.', '0 standard window cpu.txt, URL: file:///tmp/cpu.txt',
  ...Array.from({ length: 2998 }, (_, i) => `\t${i + 1} text field (settable) ${rename ? 'Changed' : 'Field'} ${i}, Value: ${i === 2997 ? value : 'a'}`)].join('\n');
const first = tree('a');
const text = text => ({ type: 'text', text });
try {
  hold();
  for (const [name, second, iterations] of [['unchanged', first, 100], ['one-value', tree('b'), 100], ['all-element-labels', tree('a', true), 10]]) {
    const inputs = [[text(GUARD_MARK + first + GUARD_END)], [text(GUARD_MARK + second + GUARD_END)]];
    if (first.split('\n').length !== 3000 || second.split('\n').length !== 3000) throw new Error('Wrong tree size');
    const samples = [];
    for (let sample = 0; sample < 5; sample++) {
      hold();
      const c = createReadCompactor(); c.process([text(first)]);
      for (let i = 0; i < 20; i++) c.process(inputs[i % 2], { action: c.beginAction?.('await app.typeText("b")') });
      let user = 0, system = 0;
      for (let i = 0; i < iterations; i++) {
        const action = c.beginAction?.('await app.typeText("b")');
        const start = process.cpuUsage();
        const result = c.process(inputs[i % 2], { action });
        const used = process.cpuUsage(start);
        user += used.user; system += used.system;
        if (!result[0]?.text) throw new Error('Missing result');
      }
      samples.push({ iterations, userMs: user / 1000, systemMs: system / 1000, cpuMsPerCall: (user + system) / 1000 / iterations });
    }
    attempt.cases.push({ name, samples, medianCpuMsPerCall: median(samples.map(s => s.cpuMsPerCall)) });
    publish();
  }
  attempt.exitCode = 0;
} catch (error) { attempt.exitCode = 1; attempt.error = error.message; process.exitCode = 1; }
finally { attempt.finished = new Date().toISOString(); publish(); }
console.log(JSON.stringify(attempt));
