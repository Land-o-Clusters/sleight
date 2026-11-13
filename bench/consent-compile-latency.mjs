// Compile only: neither the default nor optimized host is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from '../tests/fixtures/child-status.mjs';
import { prepareNativeHelpers, appleToolsPresent } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { handInventory, helperBuildRecipes, helperCompileArgs, helperSettingsFlags } from '../plugins/sleight/lib/direct-browser/host-cache.mjs';

test('CP1A2 sealed cold-cache readiness before and after the default-first path, with warm compile costs', {
  skip: process.platform !== 'darwin' || process.env.SLEIGHT_MEASURE_CONSENT_COMPILE !== '1', timeout: 900000,
}, async t => {
  assert.equal(await appleToolsPresent(), true);
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-consent-latency-'))));
  const sourceRoot = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/', import.meta.url));
  const inventory = handInventory(sourceRoot), measurements = [], tasks = [];
  const cold = async (name, options) => {
    const started = performance.now(), events = [];
    const result = await prepareNativeHelpers({ inventory, sourceRoot, cacheRoot: join(root, name),
      onProgress: event => events.push({ atMs: performance.now() - started, ...event }), ...options });
    const readyMs = performance.now() - started;
    assert.equal(result.status, 'ready', JSON.stringify(result));
    const record = JSON.parse(readFileSync(result.record));
    assert.deepEqual(record.recipes, helperBuildRecipes(record.sources, result.recipe));
    assert.ok(record.recipes['consent-host'].args.includes('SLEIGHT_SEALED_SETTINGS'));
    const compile = events.filter(e => e.stage === 'compile');
    const row = { name, recipe: result.recipe, readyMs,
      consentCompileMs: events.find(e => e.stage === 'publish').atMs - compile.find(e => e.helper === 'consent-host').atMs,
      binaryBytes: statSync(join(result.directory, 'consent-host')).size, events };
    measurements.push(row); t.diagnostic(JSON.stringify(row));
    return result;
  };
  const before = await cold('before', { recipe: 'optimized' });
  const after = await cold('after', { upgradeSignal: new AbortController().signal, scheduleUpgrade: task => tasks.push(task), onUpgradeProgress: event => {
    t.diagnostic('background ' + JSON.stringify(event));
  } });
  assert.equal(before.recipe, 'optimized'); assert.equal(after.recipe, 'default');
  assert.equal(tasks.length, 1);
  const backgroundStart = performance.now(); await tasks.shift()();
  const backgroundMs = performance.now() - backgroundStart;
  // Keep one module cache for these two warm trials, with the same combined source and settings flags as product.
  const moduleCache = join(root, 'warm-modules'); mkdirSync(moduleCache, { mode: 0o700 });
  const source = join(after.directory, 'settings-consent.swift');
  for (const recipe of ['default', 'default', 'optimized']) {
    const binary = join(root, 'warm-' + recipe), started = performance.now();
    const args = helperCompileArgs('consent-host', { sources: [source], binary, moduleCache, recipe, settingsFlags: helperSettingsFlags(true) });
    const built = spawnSync('/usr/bin/xcrun', args, { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
    assertChildStatus(built, 0, built.stderr);
    const row = { name: measurements.some(r => r.name === 'module-warmup') ? 'warm' : 'module-warmup', recipe,
      compileMs: performance.now() - started, binaryBytes: statSync(binary).size };
    measurements.push(row); t.diagnostic(JSON.stringify(row));
  }
  const result = { measurements, backgroundMs, windowsShown: 0, hostLaunches: 0, firstCardDisplayMs: null };
  if (process.env.CP1A2_TIMING_OUTPUT) writeFileSync(process.env.CP1A2_TIMING_OUTPUT, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  t.diagnostic(JSON.stringify({ beforeReadyMs: measurements[0].readyMs, afterReadyMs: measurements[1].readyMs, backgroundMs,
    firstCardDisplayMs: null, windowsShown: 0 }));
});
