// Collect every attempt, keeping timings while omitting vendor docs and unrelated UI text.
// node bench/engine-time-report.mjs OUTPUT label=/private/tmp/BANK/results.json ...
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const [output, ...inputs] = process.argv.slice(2);
assert.ok(output && inputs.length, 'supply output and every labeled attempt');
const username = basename(homedir());
function scrub(value) {
  if (typeof value === 'string') return value.replace(/\/Users\/[^/\s"']+/g, '~')
    .replaceAll(username, '[user]')
    .replace(/Window: "(?:[^"\\]|\\.)*", App: Chess\.?/g, 'Window: "[game]", App: Chess.');
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  if (result.app === 'Chess' && 'title' in result) {
    result.title = '[game]';
    result.url = result.url ? '[game URL]' : null;
  }
  return result;
}
const attempts = [];
for (const input of inputs) {
  const separator = input.indexOf('=');
  assert.ok(separator > 0, 'each input must have a label');
  const label = input.slice(0, separator), path = input.slice(separator + 1);
  const report = JSON.parse(await readFile(path, 'utf8'));
  for (const trial of report.trials) {
    if (typeof trial.text === 'string' && !trial.failed) {
      const match = trial.text.match(/^engine-probe:(.*)$/m);
      if (match && !trial.measurements) trial.measurements = JSON.parse(match[1]);
      trial.text = { chars: trial.text.length, header: windowFromText(trial.text),
        omitted: 'successful UI text and engine documentation; measurements retained' };
    }
  }
  for (const probe of report.probes ?? []) for (const call of probe.cleanupCalls ?? []) {
    if (typeof call.text !== 'string' || call.isError) continue;
    const header = windowFromText(call.text);
    if (!header) continue;
    call.text = { chars: call.text.length, header: header.url?.includes('/sleight-guard-reads-')
      ? header : { app: header.app, title: '[other window]', url: header.url ? '[other URL]' : null },
      omitted: 'cleanup UI text outside the owned fixture' };
  }
  attempts.push(scrub({ label, bank: basename(dirname(path)), ...report }));
}
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
function medians(rows, fields) {
  return { n: rows.length, ...Object.fromEntries(fields.map(field => [field, median(rows.map(row => row[field]))])) };
}
const summary = {};
for (const attempt of attempts) {
  const groups = new Map();
  for (const row of attempt.trials) {
    const measurement = row.measurements;
    const name = row.task ?? measurement?.method ?? measurement?.arm
      ?? (measurement?.waitMs !== undefined ? 'wait-' + measurement.waitMs : null);
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ ...row, ...measurement, readCount: row.reads?.length });
  }
  summary[attempt.label] = Object.fromEntries([...groups].map(([name, rows]) => [name, {
    ...medians(rows, ['totalMs', 'engineMs', 'guardMs', 'readCount', 'idleMs', 'actionMs',
      'afterActionMs', 'repeatMs', 'elapsedWaitMs', 'readMs', 'ms']),
    failed: rows.filter(row => row.failed || row.error).length,
  }]));
}
const report = { schema: 1, date: '2026-10-08', engine: [...new Set(attempts.map(a => a.engine))],
  notes: [
    'No model calls. Each live attempt holds the shared live lock and owns one client.',
    'Before is commit 968398c4c6eccbecf6615441c75f3ee6bf799973, after adds screenshot observation reuse.',
    'Before/after app blocks ran in sequence. Owner activity and system load were not measured.',
    'uncached-latency invokes the benchmark approval hook on every operation; cached-latency uses exact session approval keys like the relay.',
    'calculator-floor used a broad full-text match of one repeated value, which could accept history or stale results. verified-calculator-floor checks zero reset and the exact current input field against a distinct value per trial. The weaker arm is only a probe; product checks remain strict.',
    'word-typing stopped after its first bulk replacement failed. digit-typing repeats an identical token, so an ignored replacement could pass. distinct-digit-typing uses a different token per trial; all attempts are retained.',
    'after-all and cleanup-first could not confirm fixture close; cleanup-recovery later closed that exact fixture. Original close responses were not recorded, so their cause is unknown.',
    'Successful UI text, vendor documentation, home paths and personal window labels are omitted or redacted. Every repetition, code, timing, recorded error and trace is retained.',
    'Summary values are medians; failed attempts remain in their own groups and are excluded from claims of successful performance.',
  ], summary, attempts };
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, attempts: attempts.length,
  trials: attempts.reduce((count, attempt) => count + attempt.trials.length, 0), summary }, null, 2));
