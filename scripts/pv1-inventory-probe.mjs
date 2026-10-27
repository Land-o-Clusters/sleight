// Offline only: read the current package with the pinned baseline and current verifier.
// No installed configuration, helpers, servers or browser connections are used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { buildReceipt } from '../plugins/sleight/lib/direct-browser/turbo-setup.mjs';

const base = 'cab7138b5a716308fc228b09ea3bcc424cdd2b7e';
const folder = new URL('../plugins/sleight/lib/direct-browser/', import.meta.url);
const source = name => execFileSync('/usr/bin/git', ['show', `${base}:plugins/sleight/lib/direct-browser/${name}`], { encoding: 'utf8' });
const moduleURL = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const imports = code => code.replace(/from '(\.\/[^']+)'/g, (_match, path) => `from '${new URL(path, folder).href}'`);
const configSource = source('installed-config.mjs');
const currentSource = readFileSync(new URL('session-host.mjs', folder), 'utf8');
const load = async code => {
  const inventory = moduleURL(imports(code));
  const config = imports(configSource.replace("'./session-host.mjs'", `'${inventory}'`))
    .replaceAll('import.meta.url', JSON.stringify(new URL('installed-config.mjs', folder).href));
  return (await import(moduleURL(config))).acceptedInstalledPackage;
};
// Counters and candidate TTLs exist only in these in-memory probe modules.
const instrument = code => code.replace('let identity, verified, verifiedAt', 'let probeHashPasses = 0; let identity, verified, verifiedAt')
  .replace('verified = undefined;\n      for', 'verified = undefined; probeHashPasses++;\n      for')
  .replace('Object.freeze({ current })', 'Object.freeze({ current, get hashPasses() { return probeHashPasses; } })');
assert.match(currentSource, /PACKAGE_VERIFICATION_TTL_NS = 1_000_000_000n/);
const rows = [{ label: 'baseline', accept: await load(source('session-host.mjs')) }];
for (const ttlMs of [100, 250, 500, 1000]) rows.push({ label: `ttl-${ttlMs}ms`, ttlMs,
  accept: await load(instrument(currentSource).replace('1_000_000_000n', `${ttlMs * 1_000_000}n`)) });
const pluginRoot = fileURLToPath(new URL('../plugins/sleight', import.meta.url));
const config = buildReceipt({ pluginRoot });
const stats = samples => {
  const sorted = [...samples].sort((a, b) => a - b), n = sorted.length;
  return { n, medianMs: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2,
    minMs: sorted[0], maxMs: sorted[n - 1], samples };
};
const emit = (row, metric, samples, extra = {}) => console.log(JSON.stringify({ label: row.label, metric, ...stats(samples), ...extra }));
console.log(JSON.stringify({ files: config.receipt.files.length, bytes: config.receipt.files.reduce((sum, file) => sum + file.bytes, 0),
  checks: 109, workerChecks: 104, relayChecks: 5, entryChecksIncluded: true }));
for (const row of rows) {
  const start = performance.now(); row.accepted = row.accept(config, { pluginRoot });
  row.initialMs = performance.now() - start; row.samples = [];
}
for (let round = 0; round < 50; round++) for (const row of round % 2 ? [...rows].reverse() : rows) {
  const start = performance.now(); assert.equal(row.accepted.current(), true); row.samples.push(performance.now() - start);
}
for (const row of rows) emit(row, 'repeated-check', row.samples, { initialMs: row.initialMs });
// Use real elapsed time for expiry; no clock mocks affect these measurements.
for (const row of rows.slice(1)) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    await wait(row.ttlMs);
    const before = row.accepted.inventory.hashPasses, start = performance.now();
    assert.equal(row.accepted.current(), true); samples.push(performance.now() - start);
    assert.equal(row.accepted.inventory.hashPasses, before + 1);
  }
  emit(row, 'expired-check', samples);
}
// Replay the measured ten-field verification schedule without browser or UI work.
// Each process owns an inventory. Hashing at construction is outside the timed call.
for (const [metric, rounds, gapMs] of [['109-check-burst', 10, 0], ['109-check-spaced-10ms', 3, 10]]) {
  for (let round = 0; round < rounds; round++) for (const row of round % 2 ? [...rows].reverse() : rows) {
    const worker = row.accept(config, { pluginRoot }), relay = row.accept(config, { pluginRoot });
    const before = (worker.inventory.hashPasses ?? 0) + (relay.inventory.hashPasses ?? 0);
    const start = performance.now(); let verificationMs = 0;
    for (const [accepted, count] of [[relay, 3], [worker, 104], [relay, 2]]) for (let i = 0; i < count; i++) {
      const checkStart = performance.now(); assert.equal(accepted.current(), true); verificationMs += performance.now() - checkStart;
      if (gapMs) await wait(gapMs);
    }
    const fullHashes = row.ttlMs ? worker.inventory.hashPasses + relay.inventory.hashPasses - before : 109;
    (row[metric] ??= []).push({ wallMs: performance.now() - start, verificationMs, fullHashes });
  }
  for (const row of rows) {
    const samples = row[metric]; emit(row, metric, samples.map(s => s.verificationMs), {
      wall: stats(samples.map(s => s.wallMs)), fullHashes: samples.map(s => s.fullHashes), checks: 109 });
  }
}
