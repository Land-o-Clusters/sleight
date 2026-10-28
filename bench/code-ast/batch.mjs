// V8 retains compiled SourceTextModules in their context. Bound the process
// lifetime and heap instead of retaining millions of modules in the main context.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const jobs = mode === 'differential' ? [{ file: 'differential.mjs', seed: 3, count: 1000000, wrappers: 3 }]
  : mode === 'shaped' ? [{ file: 'corpus-shaped.mjs', count: 100000, wrappers: 1 }]
  : mode === 'reviewers' ? ['fuzz.mjs', 'fuzz2.mjs'].flatMap(file => [1, 2].map(seed => ({ file: `reviewer/${file}`, seed, count: 500000, html: seed === 2, wrappers: 1 })))
  : null;
if (!jobs) throw new Error('expected differential, shaped or reviewers');
const gate = join(homedir(), 'Projects/sleight-wt/ledger/vc/night/fuzz-may-run');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let held = false;
for (const job of jobs) {
  const total = { label: `${mode} ${job.file} seed=${job.seed ?? 151}`, tested: 0 };
  let completed = 0;
  const variants = Array(15).fill(0);
  for (let offset = 0; offset < job.count; offset += 25000) {
    while (!existsSync(gate) || existsSync('/tmp/sleight-hold')) await wait(60000);
    const count = Math.min(25000, job.count - offset);
    const args = job.file === 'corpus-shaped.mjs' ? [count, offset]
      : job.file === 'differential.mjs' ? [job.seed, count, offset]
      : [job.seed, count, job.html ? 'html' : 'plain', offset];
    const child = spawnSync(process.execPath, ['--max-old-space-size=512', '--experimental-vm-modules',
      fileURLToPath(new URL(job.file, import.meta.url)), ...args.map(String)], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 << 20 });
    let summary;
    for (const line of (child.stdout ?? '').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.generatedByVariant) entry.generatedByVariant.forEach((value, index) => { variants[index] += value; });
      else if (entry.tested !== undefined) summary = entry;
      else if (entry.case !== undefined) console.log(line);
    }
    if (![0, 1].includes(child.status) || !summary || summary.tested !== count * job.wrappers) {
      console.error(`incomplete batch ${job.file} offset=${offset}: exit=${child.status}, error=${child.error?.code ?? 'none'}`);
      process.exitCode = 2;
      throw new Error('fuzz batch stopped before its completion receipt');
    }
    for (const [key, value] of Object.entries(summary)) if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
    held ||= child.status === 1;
    completed += count;
    console.log(JSON.stringify({ job: job.file, seed: job.seed ?? 151, completed, total: job.count, failOpen: total.failOpen }));
  }
  if (job.file === 'differential.mjs') console.log(JSON.stringify({ generatedByVariant: variants }));
  console.log(JSON.stringify(total));
}
if (held) process.exitCode = 1;
