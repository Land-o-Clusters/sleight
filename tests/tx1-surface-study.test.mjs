import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { catalogAt, surfaceAt } from '../scripts/pf3-surface-study.mjs';

const have = revision => {
  try {
    execFileSync('/usr/bin/git', ['cat-file', '-e', revision + '^{commit}'], {
      cwd: new URL('..', import.meta.url), stdio: 'ignore',
     timeout: 30000, killSignal: 'SIGKILL' });
    return true;
  } catch { return false; }
};
const history = { skip: !(have('df27db01') && have('998d0dfb')) && 'older revisions absent (shallow clone)' };
const baseline = Object.freeze({ firstRequest: 11736, catalog: 4308, rules: 7427, handoff: 315 });

test('the working first request fits the fixed 1.4.2 budget without Git history', () => {
  const current = surfaceAt('working');
  assert.equal(baseline.catalog + 1 + baseline.rules, baseline.firstRequest);
  assert.ok(current.firstContentWithAddedTool.bytes <= baseline.firstRequest);
  assert.ok(current.addedNativeTool.bytes <= baseline.handoff);
});

test('surface inventory reads each revision native handoff rather than using the working description', history, () => {
  const original = surfaceAt('998d0dfb'), current = surfaceAt('working');
  assert.equal(original.addedNativeTool.bytes, baseline.handoff);
  assert.ok(current.addedNativeTool.bytes < original.addedNativeTool.bytes);
  assert.ok(current.firstContentWithAddedTool.bytes <= 11736);
  assert.ok(current.firstContentWithAddedTool.bytes < original.firstContentWithAddedTool.bytes);
});

test('the immutable 1.4.2 first browser request is 11736 source bytes', history, () => {
  const row = surfaceAt('df27db01');
  assert.equal(row.catalog.bytes, baseline.catalog);
  assert.equal(row.firstRules.bytes, baseline.rules);
  assert.equal(row.addedNativeTool.bytes, 0);
  assert.equal(row.firstContentWithAddedTool.bytes, baseline.firstRequest);
});

test('the compact catalog preserves every p170 tool name and executable schema', history, () => {
  const schemas = tools => tools.map(({ name, inputSchema }) => ({ name, inputSchema }));
  const original = catalogAt('998d0dfb'), current = catalogAt('working');
  assert.deepEqual(schemas(current), schemas(original));
  for (const tool of current) assert.ok(Buffer.byteLength(tool.description) <= Buffer.byteLength(original.find(old => old.name === tool.name).description), tool.name);
});
