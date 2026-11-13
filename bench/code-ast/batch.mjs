// V8 retains compiled SourceTextModules in their context. Bound the process
// lifetime and heap instead of retaining millions of modules in the main context.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const consumerMode = process.argv.includes('--statement-consumers');
const jobs = mode === 'differential' ? [{ file: 'differential.mjs', seed: 3, count: 1000000, wrappers: 3 }]
  : mode === 'shaped' ? [{ file: 'corpus-shaped.mjs', count: 100000, wrappers: 1 }]
  : mode === 'reviewers' ? ['fuzz.mjs', 'fuzz2.mjs'].flatMap(file => [1, 2].map(seed => ({ file: `reviewer/${file}`, seed, count: 500000, html: seed === 2, wrappers: 1 })))
  : null;
if (!jobs) throw new Error('expected differential, shaped or reviewers');
const gate = join(homedir(), 'Projects/sleight-wt/ledger/vc/night/fuzz-may-run');
const testGate = join(homedir(), 'Projects/sleight-wt/ledger/vc/night/lanes-may-test');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let held = false;
const completedJobs = [];
for (const job of jobs) {
  const total = { label: `${mode} ${job.file} seed=${job.seed ?? 151}`, tested: 0 };
  let completed = 0;
  const variants = Array(15).fill(0);
  for (let offset = 0; offset < job.count; offset += 25000) {
    while (!existsSync(gate) || !existsSync(testGate) || existsSync('/tmp/sleight-hold')) await wait(60000);
    const count = Math.min(25000, job.count - offset);
    const args = job.file === 'corpus-shaped.mjs' ? [count, offset]
      : job.file === 'differential.mjs' ? [job.seed, count, offset]
      : [job.seed, count, job.html ? 'html' : 'plain', offset];
    const child = spawnSync(process.execPath, ['--max-old-space-size=512', '--experimental-vm-modules',
      fileURLToPath(new URL(job.file, import.meta.url)), ...args.map(String), ...(consumerMode ? ['--statement-consumers'] : [])],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 64 << 20 });
    let summary;
    for (const line of (child.stdout ?? '').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.generatedByVariant) entry.generatedByVariant.forEach((value, index) => { variants[index] += value; });
      else if (entry.tested !== undefined) summary = entry;
      else if (entry.case !== undefined && (entry.failOpen || entry.falsePositive || entry.problems)) console.log(line);
    }
    if (![0, 1].includes(child.status) || !summary || summary.tested !== count * job.wrappers) {
      console.error(`incomplete batch ${job.file} offset=${offset}: exit=${child.status}, error=${child.error?.code ?? 'none'}`);
      process.exitCode = 2;
      throw new Error('fuzz batch stopped before its completion receipt');
    }
    for (const [key, value] of Object.entries(summary)) if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
    if (consumerMode) for (const [consumer, counts] of Object.entries(summary.consumers)) {
      const combined = (total.consumers ??= {})[consumer] ??= {};
      for (const [key, value] of Object.entries(counts)) combined[key] = (combined[key] ?? 0) + value;
    }
    if (consumerMode) for (const [key, value] of Object.entries(summary.ranges)) {
      (total.ranges ??= {})[key] = (total.ranges[key] ?? 0) + value;
    }
    held ||= child.status === 1;
    completed += count;
    console.log(JSON.stringify({ job: job.file, seed: job.seed ?? 151, completed, total: job.count, failOpen: total.failOpen }));
  }
  if (job.file === 'differential.mjs') console.log(JSON.stringify({ generatedByVariant: variants }));
  console.log(JSON.stringify(total));
  completedJobs.push(total);
}
if (consumerMode) {
  const resultsUrl = new URL('results.json', import.meta.url);
  const results = JSON.parse(readFileSync(resultsUrl));
  const sourceHashes = {};
  for (const path of ['batch.mjs', 'oracle.mjs', 'statement-oracle.mjs', ...jobs.map(job => job.file)])
    sourceHashes[path] = createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex');
  for (const path of ['code-ast.mjs', 'text-save.mjs', 'menu-continuation.mjs', 'tab-probe.mjs'])
    sourceHashes['plugins/sleight/lib/' + path] = createHash('sha256').update(readFileSync(new URL('../../plugins/sleight/lib/' + path, import.meta.url))).digest('hex');
  for (const path of ['index.mjs', 'text-save.mjs', 'menu-continuation.mjs', 'tab-probe.mjs', 'flow-rules.mjs', 'code-line-terminators.mjs'])
    sourceHashes['tests/fixtures/statement-legacy/' + path] = createHash('sha256').update(readFileSync(new URL('../../tests/fixtures/statement-legacy/' + path, import.meta.url))).digest('hex');
  ((results.ps3r ??= {}).fuzz ??= {})[mode] = { jobs: completedJobs, exit: held ? 1 : 0, sourceHashes };
  writeFileSync(resultsUrl, JSON.stringify(results, null, 2) + '\n');
}
if (held) process.exitCode = 1;
