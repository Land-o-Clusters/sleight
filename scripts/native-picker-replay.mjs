// Offline replay and instrumentation measurement. Never imports the live benchmark runner.
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { stripPickerTrace, documentationCounts } from '../plugins/sleight/lib/native-picker-trace.mjs';
import { replay, replayCounts } from '../tests/fixtures/native-picker-replay.mjs';
import { trackTemp, removeTemp } from './temp-leftovers.mjs';

const args = process.argv.slice(2);
let plugins = fileURLToPath(new URL('../plugins', import.meta.url)), name = 'NF2', overhead = false;
while (args.length) {
  const option = args.shift();
  if (option === '--plugins' && args.length) plugins = resolve(args.shift());
  else if (option === '--name' && args.length) name = args.shift();
  else if (option === '--overhead') overhead = true;
  else throw new Error('Use --plugins PATH --name NAME [--overhead].');
}
const modulePath = join(plugins, 'sleight/lib/native-list-pick.mjs');
const { listPicker } = await import(pathToFileURL(modulePath));
const cases = [];
for (const family of ['numeric', 'words', 'accented']) {
  for (const targetIndex of [7, 67, 127, 207, 235]) {
    for (const delayedFrame of [false, true]) {
      cases.push({ family, targetIndex, delayedFrame, changingBand: true });
    }
  }
}
cases.push({ focusRecovery: true }, { permanentFrame: true, changingBand: true }, { missing: true });
for (const mutate of ['duplicate', 'reorder', 'missing', 'focus', 'list']) cases.push({ delayedFrame: true, mutate });
for (const afterClick of ['duplicate', 'list', 'role']) cases.push({ afterClick });
for (const geometry of [
  { visible: 6, overscan: 2, keyRows: 1, wheelRows: 3 },
  { visible: 18, overscan: 5, keyRows: 4, wheelRows: 13 },
  { visible: 11, overscan: 3, keyRows: 9, wheelRows: 2 },
]) for (const family of ['numeric', 'words', 'accented']) cases.push({ ...geometry, family,
  count: 257, targetIndex: 148, start: 15, changingBand: true, delayedFrame: true });
cases.push({ delayedFrame: true, frameDelay: 400, changingBand: true });

const rows = [];
for (const options of cases) {
  const events = [];
  const run = await replay(listPicker, options, { trace: event => events.push(event) });
  rows.push({ case: options, ...replayCounts(run), events: events.length });
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { name, sourceSha256: hash(readFileSync(modulePath)),
  fixtureSha256: hash(readFileSync(new URL('../tests/fixtures/native-picker-replay.mjs', import.meta.url))),
  casesSha256: hash(JSON.stringify(cases)), rows };

if (overhead) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-nf2-overhead-')));
  try {
    const path = join(dir, 'trace.jsonl');
    const reference = [{ type: 'text', text: readFileSync(new URL('../tests/fixtures/native-api-docs.txt', import.meta.url), 'utf8') }];
    const samples = [], count = 60;
    // Include the existing JSONL writer cost. Only fixed phase codes and counts enter this file.
    const run = async enabled => {
      const output = [];
      const started = performance.now();
      const result = await replay(listPicker, { delayedFrame: true, changingBand: true, focusRecovery: true }, enabled
        ? { trace: event => output.push('[sleight:picker-phase]' + JSON.stringify({ search: 1, ...event }) + '\n') } : {});
      if (enabled) stripPickerTrace([{ type: 'text', text: output.join('') }], event =>
        appendFileSync(path, JSON.stringify({ direction: 'native-picker', msg: { id: 1, ...event } }) + '\n'));
      if (enabled) appendFileSync(path, JSON.stringify({ direction: 'native-doc-delivery', msg: { id: 1,
        ...documentationCounts(reference), outcome: result.result?.clicked ? 'written' : 'refused', ms: 0, projected: 0, retained: 0, queued: 0 } }) + '\n');
      return { ms: performance.now() - started, ...replayCounts(result), events: output.length, bytes: Buffer.byteLength(output.join('')) };
    };
    for (let i = 0; i < 10; i++) { await run(false); await run(true); }
    for (let i = 0; i < count; i++) {
      let off, on;
      if (i % 2) { on = await run(true); off = await run(false); }
      else { off = await run(false); on = await run(true); }
      samples.push({ off, on });
    }
    const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
    report.overhead = { pairs: count, warmupPairs: 10, offMedianMs: percentile(samples.map(pair => pair.off.ms), 0.5),
      onMedianMs: percentile(samples.map(pair => pair.on.ms), 0.5),
      pairedMedianMs: percentile(samples.map(pair => pair.on.ms - pair.off.ms), 0.5),
      pairedP90Ms: percentile(samples.map(pair => pair.on.ms - pair.off.ms), 0.9), samples };
  } finally { removeTemp(dir); }
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
