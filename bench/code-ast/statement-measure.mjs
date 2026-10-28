// Per recorded call, time one parse and the real three-consumer inspection path.
// This is offline CPU cost, without relay, IPC, app or engine execution.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { readCorpus } from './corpus.mjs';
import { parseCell } from '../../plugins/sleight/lib/code-ast.mjs';
import { splitTextSave } from '../../plugins/sleight/lib/text-save.mjs';
import { splitMenuActions } from '../../plugins/sleight/lib/menu-continuation.mjs';
import { nativeTabPlan } from '../../plugins/sleight/lib/tab-probe.mjs';

const corpus = await readCorpus();
if (!corpus.records.length || corpus.counts.malformed) throw Error('empty or malformed corpus');
parseCell('');
const quantile = (samples, p) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * p) - 1];
const series = Object.fromEntries(['parse', 'textSave', 'menu', 'tab', 'consumers'].map(key => [key, []]));
const loadBefore = loadavg();
let refused = 0;
for (const { code } of corpus.records) {
  let start = performance.now();
  if (parseCell(code).error) refused++;
  series.parse.push(performance.now() - start);
  const began = performance.now();
  start = performance.now(); splitTextSave(code); series.textSave.push(performance.now() - start);
  start = performance.now(); const plan = splitMenuActions(code); series.menu.push(performance.now() - start);
  start = performance.now(); nativeTabPlan(plan); series.tab.push(performance.now() - start);
  series.consumers.push(performance.now() - began);
}
const timings = {};
for (const [key, values] of Object.entries(series)) timings[key] = { samples: values.length, p50Ms: quantile(values, 0.5), p99Ms: quantile(values, 0.99) };
const sourceHashes = {};
for (const path of ['plugins/sleight/lib/code-ast.mjs', 'plugins/sleight/lib/text-save.mjs',
  'plugins/sleight/lib/menu-continuation.mjs', 'plugins/sleight/lib/tab-probe.mjs', 'bench/code-ast/statement-measure.mjs'])
  sourceHashes[path] = createHash('sha256').update(readFileSync(new URL('../../' + path, import.meta.url))).digest('hex');
const result = { corpus: corpus.counts, manifest: corpus.manifest, refused, timings, loadBefore, loadAfter: loadavg(), sourceHashes,
  conditions: 'One sequential pass over all recorded calls after loading the parser. Shared Mac at nice 20. Consumer timings include their own parsing; tab reuses the menu plan. Offline CPU cost only.' };
const url = new URL('results.json', import.meta.url), results = JSON.parse(readFileSync(url));
(results.ps3r ??= {}).measurements = result;
writeFileSync(url, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(result));
if (refused) process.exitCode = 1;
