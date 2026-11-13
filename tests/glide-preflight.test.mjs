import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGlide } from '../bench/glide-preflight.mjs';
import { prepareMacDriver } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { prepareNativeHelpers } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('compile-only preflight measures compilation separately and never launches the prepared helper', async () => {
  let clock = 0, calls = 0;
  const receipt = await prepareGlide({ now: () => clock, prepare: async ({ onProgress, signal }) => {
    calls++; assert.equal(signal, undefined);
    clock = 5; onProgress({ stage: 'cache' });
    clock = 10; onProgress({ stage: 'compile', helper: 'peer-host' });
    clock = 12; onProgress({ stage: 'compile', helper: 'glide-engine' });
    clock = 52; onProgress({ stage: 'publish' });
    clock = 55;
    return { status: 'ready', origin: 'source', build: 'a'.repeat(64), binary: '/private-binary',
      spawn: () => assert.fail('compile preflight never starts the driver') };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(receipt, { status: 'ready', origin: 'source', build: 'a'.repeat(64), elapsedMs: 55, compileMs: 42, compileCount: 2 });
  assert.ok(!JSON.stringify(receipt).includes('private-binary'));
});
test('a warm cache records zero compilation and an unavailable helper retains its fixed code', async () => {
  const warm = await prepareGlide({ now: () => 0, prepare: async () => ({ status: 'ready', origin: 'prebuilt', build: 'b'.repeat(64) }) });
  assert.equal(warm.compileMs, 0); assert.equal(warm.compileCount, 0);
  const cold = await prepareGlide({ now: () => 0, prepare: async () => ({ status: 'unavailable', code: 'APPLE_TOOLS_MISSING' }) });
  assert.equal(cold.status, 'unavailable'); assert.equal(cold.code, 'APPLE_TOOLS_MISSING');
});
test('abort is passed to the compiler and a failed compile retains elapsed evidence', async () => {
  const controller = new AbortController(); let clock = 0;
  await assert.rejects(prepareGlide({ signal: controller.signal, now: () => clock, prepare: async options => {
    assert.equal(options.signal, controller.signal); options.onProgress({ stage: 'compile' });
    clock = 25; throw Error('compiler failed');
  } }), error => { assert.equal(error.preparation.compileMs, 25); assert.equal(error.preparation.status, 'unavailable'); return true; });
});

test('the product cache preparer compiles once and the next preparation reuses its artifacts', { skip: process.platform !== 'darwin' }, async t => {
  const cacheRoot = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-bench-preflight-')));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  let compiles = 0;
  const prepare = options => prepareMacDriver({ ...options, cacheRoot, prebuilt: () => null,
    tools: async () => true, prepare: (options, selected) => prepareNativeHelpers({ ...options,
      compile: async ({ binary }) => { compiles++; await writeFile(binary, 'offline artifact', { mode: 0o700 }); },
    }, selected) });
  const first = await prepareGlide({ prepare }), second = await prepareGlide({ prepare });
  assert.equal(first.status, 'ready'); assert.equal(second.status, 'ready');
  assert.equal(first.compileCount, 2); assert.equal(second.compileCount, 0);
  assert.equal(compiles, 2); assert.equal(second.compileMs, 0);
  assert.equal(first.build, second.build);
});
