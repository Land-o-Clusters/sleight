// Offline parse measurement over existing replay fixtures. Never executes a cell.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { isFilteredRead } from '../../plugins/sleight/lib/input-lease.mjs';
const root = new URL('./', import.meta.url);
const files = readdirSync(root).filter(n => /replay.*\.json$/.test(n)).map(n => new URL(n, root));
for (const name of readdirSync(new URL('replay/', root)).filter(n => n.endsWith('.jsonl'))) files.push(new URL('replay/' + name, root));
const codes = [];
function collect(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'code' && typeof item === 'string') codes.push(item);
    else if (item && typeof item === 'object') collect(item);
  }
}
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const value of file.pathname.endsWith('.jsonl') ? text.trim().split('\n').map(JSON.parse) : [JSON.parse(text)]) collect(value);
}
const unique = [...new Set(codes)], bounded = unique.filter(code => code.length <= 4000);
const repeats = 200;
for (const code of bounded) isFilteredRead(code); // Warm parser/JIT, no result cache.
const rows = [];
for (const code of bounded) {
  const start = performance.now();
  for (let i = 0; i < repeats; i++) isFilteredRead(code);
  rows.push({ chars: code.length, msPerCall: (performance.now() - start) / repeats });
}
const sorted = rows.map(row => row.msPerCall).sort((a, b) => a - b);
const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
const result = { files: files.length, recordedCodes: codes.length, uniqueCodes: unique.length, parsedCodes: bounded.length,
  over4000: unique.length - bounded.length, repeats, calls: repeats * rows.length,
  meanMs: mean, p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)], maxCodeMeanMs: sorted.at(-1) };
console.log(JSON.stringify(result, null, 2));
assert.ok(rows.length > 0);
assert.ok(sorted.at(-1) < 2, 'each replay cell averages under 2 ms per uncached classification');
