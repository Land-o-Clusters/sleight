// Short recipe-selection checks. Native timing lives in bench/consent-compile-latency.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, mkdtempSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { prepareNativeHelpers } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { handInventory } from '../plugins/sleight/lib/direct-browser/host-cache.mjs';

test('CP1A3 the ordinary npm test selection excludes the consent compile measurement', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const command = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).scripts.test;
  const files = command.split(/\s+/).filter(arg => arg.endsWith('.mjs')).flatMap(pattern => {
    const slash = pattern.lastIndexOf('/'), folder = pattern.slice(0, slash);
    assert.equal(pattern.slice(slash + 1), '*.test.mjs', 'ordinary tests use directory globs');
    return readdirSync(join(root, folder)).filter(name => name.endsWith('.test.mjs')).map(name => `${folder}/${name}`);
  });
  assert.ok(files.includes('tests/consent-compile-latency.test.mjs'));
  assert.ok(existsSync(new URL('../bench/consent-compile-latency.mjs', import.meta.url)));
  assert.equal(files.includes('bench/consent-compile-latency.mjs'), false, 'compile measurements require an explicit bench invocation');
});

test('CP1A3 ordinary consent checks select the default sealed recipe before an optional optimized bank', { skip: process.platform !== 'darwin' }, async t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-consent-order-'))));
  const sourceRoot = join(root, 'lib/direct-browser/native'), cacheRoot = join(root, 'cache'), tasks = [], calls = [];
  mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'lib/mac-driver/native'), { recursive: true, mode: 0o700 });
  for (const name of ['peer-host.c', 'consent-host.swift']) writeFileSync(join(sourceRoot, name), name, { mode: 0o600 });
  writeFileSync(join(root, 'lib/mac-driver/native/SealedSettings.swift'), 'sealed fixture', { mode: 0o600 });
  const options = { inventory: handInventory(sourceRoot), sourceRoot, cacheRoot, upgradeSignal: new AbortController().signal,
    scheduleUpgrade: task => tasks.push(task), compile: async ({ name, recipe, binary }) => {
      calls.push([name, recipe]); writeFileSync(binary, name + recipe, { mode: 0o700 });
    } };
  const first = await prepareNativeHelpers(options);
  assert.equal(first.recipe, 'default');
  assert.deepEqual(calls, [['peer-host', 'default'], ['consent-host', 'default']]);
  const record = JSON.parse(readFileSync(first.record));
  assert.ok(record.recipes['consent-host'].args.includes('SLEIGHT_SEALED_SETTINGS'));
  assert.equal(record.recipes['consent-host'].args.includes('-O'), false);
  await tasks.shift()();
  const next = await prepareNativeHelpers(options);
  assert.equal(next.recipe, 'optimized');
  assert.deepEqual(calls.slice(2), [['peer-host', 'optimized'], ['consent-host', 'optimized']]);
  assert.ok(JSON.parse(readFileSync(next.record)).recipes['consent-host'].args.includes('-O'));
});
