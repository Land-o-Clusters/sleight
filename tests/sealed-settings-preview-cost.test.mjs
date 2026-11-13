import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import * as after from '../plugins/sleight/lib/sealed-settings.mjs';

test('in-process preview read cost, interleaved before, after and int22 legacy path', async t => {
  const root = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-seal-cost-'))));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = new URL('../plugins/sleight/lib/sealed-settings.mjs', import.meta.url);
  const guard = 'if (!(options.enforce ?? SETTINGS_BUILD_POLICY.enforce)) return undefined;';
  const source = fs.readFileSync(original, 'utf8');
  assert.equal(source.split(guard).length - 1, 1);
  // Removing only the early exit restores SG2B's stat-polling and verification path.
  const path = join(root, 'before.mjs');
  fs.writeFileSync(path, source.replace(guard, '').replace(/from '(\.[^']+)'/g,
    (_, specifier) => `from '${new URL(specifier, original).href}'`));
  const before = await import(pathToFileURL(path).href);
  const file = join(root, 'permissions.json');
  fs.writeFileSync(file, '{"version":1,"apps":[],"sites":[]}', { mode: 0o600 });
  const helpers = { before: 0, after: 0 }, rows = [];
  const options = name => ({ root, verify: () => {
    helpers[name]++;
    return { enforcing: false, get: file => ({ file, state: 'unsealed' }) };
  } });
  const oldOptions = options('before'), newOptions = options('after');
  const legacy = () => fs.readFileSync(file, 'utf8');
  const reads = { before: () => before.readSettingsBytes(file, legacy, oldOptions),
    after: () => after.readSettingsBytes(file, legacy, newOptions), int22: legacy };
  const samples = 41, perSample = 500;
  for (let i = 0; i < 10; i++) for (const read of Object.values(reads)) for (let j = 0; j < perSample; j++) read();
  const times = Object.fromEntries(Object.keys(reads).map(key => [key, []]));
  for (let i = 0; i < samples; i++) {
    const order = i % 2 ? ['int22', 'after', 'before'] : ['before', 'after', 'int22'];
    for (const key of order) {
      const start = performance.now();
      for (let j = 0; j < perSample; j++) assert.equal(JSON.parse(reads[key]()).version, 1);
      times[key].push((performance.now() - start) * 1000 / perSample);
    }
  }
  const summarize = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianUs: sorted[Math.floor(sorted.length / 2)], p90Us: sorted[Math.ceil(sorted.length * 0.9) - 1] };
  };
  for (const [variant, values] of Object.entries(times)) rows.push({ variant, ...summarize(values) });
  assert.equal(helpers.after, 0); assert.ok(helpers.before > 0);
  t.diagnostic(JSON.stringify({ samples, perSample, warmupBatches: 10, rows, fakeHelpers: helpers, realHelpers: 0 }));
});
