import { assertChildStatus } from './fixtures/child-status.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { benchEvidencePath, benchGateOpen, benchOutputPath, requireLiveBenchGate, waitForBenchGate, writeBenchJson } from '../bench/runtime-options.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('unset and empty benchmark gates perform no filesystem probe or wait', async () => {
  const unexpected = () => assert.fail('unconfigured gate touched the filesystem or waited');
  for (const env of [{}, { SLEIGHT_BENCH_GATE_FILE: '' }]) {
    assert.equal(benchGateOpen(env, unexpected), true);
    await waitForBenchGate({ env, exists: unexpected, wait: unexpected });
  }
});

test('configured benchmark gate polls its exact path every 60 seconds until present', async () => {
  const env = { SLEIGHT_BENCH_GATE_FILE: 'operator-window' }, probes = [], waits = [];
  await waitForBenchGate({ env, exists: path => { probes.push(path); return probes.length === 3; },
    wait: async ms => { waits.push(ms); } });
  assert.deepEqual(probes, Array(3).fill('operator-window'));
  assert.deepEqual(waits, [60000, 60000]);
  assert.equal(benchGateOpen(env, () => false), false);
  assert.equal(benchGateOpen(env, () => true), true);
});

test('live benchmark admission requires an explicit nonempty gate', () => {
  for (const value of [undefined, '', '   '])
    assert.throws(() => requireLiveBenchGate({ SLEIGHT_BENCH_GATE_FILE: value }), /Live run refused: set SLEIGHT_BENCH_GATE_FILE.*--owner-away/);
  const env = { SLEIGHT_BENCH_GATE_FILE: 'operator-window' };
  assert.doesNotThrow(() => requireLiveBenchGate(env));
  assert.equal(benchGateOpen(env, () => false), false);
  assert.equal(benchGateOpen(env, () => true), true);
});

test('live entry points refuse an unset gate before inspecting the host or reading a recording', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const env = { ...process.env }; delete env.SLEIGHT_BENCH_GATE_FILE;
  // An existing output path (SF6) and missing recording (Safari) also stop a
  // regressed guard before either entry point can reach an app driver.
  for (const [script, flags] of [
    ['bench/sf6-focus-probe.mjs', ['--owner-away', '--out', root]],
    ['bench/replay/safari-address-repro.mjs', ['--run-live', '--owner-away', '--quiet-window']],
  ]) {
    const result = spawnSync(process.execPath, [script, ...flags], { cwd: root, env, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assert.equal(result.error, undefined, script);
    assertChildStatus(result, 1, script);
    assert.match(result.stderr, /Live run refused: set SLEIGHT_BENCH_GATE_FILE.*--owner-away/, script);
    assert.equal(result.stdout, '', script);
  }
});

test('benchmark gate cancellation stops an outstanding wait', async () => {
  const controller = new AbortController(), reason = Error('test cancellation');
  const waiting = waitForBenchGate({ env: { SLEIGHT_BENCH_GATE_FILE: 'operator-window' },
    exists: () => false, signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(waiting, { name: 'AbortError' });
  await assert.rejects(waitForBenchGate({ env: {}, signal: controller.signal }), error => error === reason);
});

test('benchmark outputs default to the checkout ignored bank', () => {
  const expected = fileURLToPath(new URL('../bench/results/code-ast/results.json', import.meta.url));
  assert.equal(benchOutputPath('code-ast/results.json', {}), expected);
  assert.equal(benchOutputPath('code-ast/results.json', { SLEIGHT_BENCH_OUTPUT_DIR: '' }), expected);
});

test('evidence paths accept a neutral default and explicit bank overrides', () => {
  assert.equal(benchEvidencePath('race-1017', {}), benchOutputPath('evidence/race-1017', {}));
  assert.equal(benchEvidencePath('race/events.jsonl', { SLEIGHT_BENCH_EVIDENCE_DIR: '/fixture/evidence' }), '/fixture/evidence/race/events.jsonl');
  assert.equal(benchEvidencePath('race', { SLEIGHT_BENCH_OUTPUT_DIR: '/fixture/output' }), '/fixture/output/evidence/race');
});

test('configured benchmark output creates nested evidence without changing published results', t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-bench-options-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const published = new URL('../bench/code-ast/results.json', import.meta.url), before = readFileSync(published);
  const path = writeBenchJson('code-ast/results.json', { calls: 7 }, { SLEIGHT_BENCH_OUTPUT_DIR: directory });
  assert.equal(path, join(directory, 'code-ast/results.json'));
  assert.equal(existsSync(path), true);
  assert.deepEqual(JSON.parse(readFileSync(path)), { calls: 7 });
  assert.deepEqual(readFileSync(published), before);
});
