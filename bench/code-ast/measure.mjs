import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readCorpus } from './corpus.mjs';
import { parseCell } from '../../plugins/sleight/lib/code-ast.mjs';

const moduleUrl = new URL('../../plugins/sleight/lib/code-ast.mjs', import.meta.url).href;
const vendorUrl = new URL('../../plugins/sleight/vendor/meriyah/dist/meriyah.min.mjs', import.meta.url).href;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
function child(source) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 30000 });
  if (run.status !== 0) throw new Error(`measurement child failed (${run.status ?? run.error?.code})`);
  return JSON.parse(run.stdout);
}
const cold = [];
for (let i = 0; i < 10; i++) cold.push(child(`
  import { performance } from 'node:perf_hooks';
  import { parseCell } from ${JSON.stringify(moduleUrl)};
  const rss=process.memoryUsage().rss, start=performance.now();
  parseCell('');
  console.log(JSON.stringify({ms:performance.now()-start,rss:process.memoryUsage().rss-rss}));
`));
const warm = child(`
  import { createRequire } from 'node:module';
  import { fileURLToPath } from 'node:url';
  import { performance } from 'node:perf_hooks';
  const require=createRequire(import.meta.url), path=fileURLToPath(${JSON.stringify(vendorUrl)});
  const values=[];
  require(path);
  for(let i=0;i<10;i++) { delete require.cache[path]; const start=performance.now(); require(path); values.push(performance.now()-start); }
  console.log(JSON.stringify(values));
`);
const beforeLoad = loadavg();
const corpus = await readCorpus();
if (!corpus.records.length) throw new Error('empty corpus');
const timings = [], rss = process.memoryUsage().rss;
parseCell('');
const parserRss = process.memoryUsage().rss - rss;
let refused = 0;
for (const { code } of corpus.records) {
  const start = performance.now();
  const result = parseCell(code);
  timings.push(performance.now() - start);
  if (result.error) refused++;
}
function sizes(path) {
  const info = statSync(path);
  if (info.isFile()) return { bytes: info.size, allocated: info.blocks * 512 };
  return readdirSync(path).map(name => sizes(join(path, name))).reduce((a, b) => ({ bytes: a.bytes + b.bytes, allocated: a.allocated + b.allocated }), { bytes: 0, allocated: 0 });
}
const vendor = sizes(fileURLToPath(new URL('../../plugins/sleight/vendor/meriyah', import.meta.url)));
const facade = sizes(fileURLToPath(new URL(moduleUrl)));
const report = { counts: corpus.counts, manifest: corpus.manifest, corpusRefused: refused, samples: timings.length,
  coldLoadMedianMs: median(cold.map(item => item.ms)), warmLoadMedianMs: median(warm),
  coldLoadSamplesMs: cold.map(item => item.ms), warmLoadSamplesMs: warm,
  coldRssDeltaMedian: median(cold.map(item => item.rss)), parserRssDelta: parserRss,
  parseP50Ms: quantile(timings, 0.5), parseP99Ms: quantile(timings, 0.99), vendor, facade,
  totalBytes: vendor.bytes + facade.bytes, loadBefore: beforeLoad, loadAfter: loadavg(),
  conditions: 'Shared Mac, under load; no quiet-window guarantee. Cold means fresh process/module, with OS file cache retained. Warm means cached ESM namespace loading in one warmed process.' };
report.bars = { coldLoad: report.coldLoadMedianMs <= 10, warmLoad: report.warmLoadMedianMs <= 10,
  parseP99: report.parseP99Ms <= 2, disk: report.totalBytes <= 150000 };
console.log(JSON.stringify(report));
if (Object.values(report.bars).some(pass => !pass)) process.exitCode = 1;
