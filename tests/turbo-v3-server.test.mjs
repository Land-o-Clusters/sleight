import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

test('v3 stdio server lists five tools and refuses before allocation when the pinned headless browser is missing', { timeout: 20000 }, t => {
  const root = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-v3-refusal-'))));
  const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG'].flatMap(key =>
    typeof process.env[key] === 'string' ? [[key, process.env[key]]] : []));
  env.SLEIGHT_TURBO_ORIGINS = JSON.stringify(['http://127.0.0.1:5431']);
  env.HOME = root; // no pinned browser here, so the worker refuses before launching
  env.SLEIGHT_TURBO_TASK = 'Read the owned fixture.';
  env.SLEIGHT_TURBO_METRICS = join(root, 'turbo-metrics.jsonl');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } },
  ];
  const child = spawnSync(process.execPath, ['bench/turbo/v3-server.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8', timeout: 15000,
    maxBuffer: 131072, input: requests.map(value => JSON.stringify(value)).join('\n') + '\n',
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
  const replies = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3]);
  assert.equal(replies[0].result.serverInfo.name, 'sleight-turbo-v3-bench');
  assert.deepEqual(replies[1].result.tools.map(tool => tool.name),
    ['browser_open', 'browser_read', 'browser_act', 'browser_fill', 'browser_tabs']);
  assert.equal(replies[2].result.isError, true);
  const text = replies[2].result.content.map(part => part.text).join('\n');
  assert.match(text, /Turbo bench unavailable/);
  assert.match(text, /Read before any retry/);
  assert.match(text, /startup stage bench-browser/);
  // The task folder keeps why the start failed, once per attempt, and never a cleanup receipt it has no evidence for.
  assert.deepEqual(readdirSync(root), ['turbo-metrics.jsonl'], 'refused startup must not manufacture allocation or cleanup receipts');
  const metrics = readFileSync(env.SLEIGHT_TURBO_METRICS, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(metrics.map(({ ms, ...rest }) => rest), [1, 2].map(attempt => ({ version: 3, phase: 'startup-failed', attempt,
    stage: 'bench-browser', code: 'V3_RUNTIME_UNAVAILABLE', reason: 'BENCH_BROWSER_MISSING', retrying: attempt === 1 })));
  assert.ok(metrics.every(({ ms }) => Number.isFinite(ms) && ms >= 0));
  assert.doesNotMatch(readFileSync(env.SLEIGHT_TURBO_METRICS, 'utf8'), new RegExp(root.replaceAll('/', '\\/')));
});
