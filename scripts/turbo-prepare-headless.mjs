// Compile the installed turbo helpers in an empty private cache. Never open a helper window or browser.
import { mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeHelpers } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { handInventory } from '../plugins/sleight/lib/direct-browser/host-cache.mjs';

const bank = realpathSync(mkdtempSync(join(tmpdir(), 'tur160-helpers-')));
const sourceRoot = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/', import.meta.url));
const controller = new AbortController();
const abort = () => controller.abort();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, abort);
const started = performance.now();
try {
  const result = await prepareNativeHelpers({ inventory: handInventory(sourceRoot), cacheRoot: join(bank, 'cache'),
    signal: controller.signal, onProgress: ({ stage, helper, elapsedMs, status, cached }) =>
      console.log(JSON.stringify({ stage, helper, elapsedMs, status, cached })) });
  console.log(JSON.stringify({ status: result.status, code: result.code, elapsedMs: Math.round(performance.now() - started),
    bank, recipe: result.recipe, sizes: result.status === 'ready' ? Object.fromEntries(['peer-host', 'consent-host'].map(name =>
      [name, statSync(join(result.directory, name)).size])) : undefined }));
  if (result.status !== 'ready') process.exitCode = 1;
} finally {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, abort);
}
