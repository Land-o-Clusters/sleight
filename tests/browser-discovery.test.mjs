import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectSurfaces } from '../plugins/sleight/lib/launch.mjs';
function server(t, browsers, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-browser-discovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { command: process.execPath, args: [fileURLToPath(new URL('fixtures/browser-discovery-engine.mjs', import.meta.url))],
    env: { SLEIGHT_TEST_BROWSERS: JSON.stringify(browsers), SLEIGHT_TEST_REQUESTS: join(directory, 'requests.jsonl'), ...extra } };
}
const requests = s => readFileSync(s.env.SLEIGHT_TEST_REQUESTS, 'utf8').trim().split('\n').map(JSON.parse);
test('automatic surfaces require a responding extension and query only browser inventory', async t => {
  const s = server(t, [{ type: 'extension', metadata: { extensionInstanceId: 'helium-instance' } }]);
  await selectSurfaces(s, {});
  assert.equal(s.env.CUA_REPL_ENABLED_SURFACES, 'browser,computer');
  assert.equal(s.env.BROWSER_USE_AVAILABLE_BACKENDS, 'chrome');
  const calls = requests(s).filter(r => r.method === 'tools/call');
  assert.equal(calls.length, 1); assert.match(calls[0].params.arguments.code, /cua.listBrowsers\(\{emit: false\}\)/);
  assert.ok(calls[0].params._meta['x-codex-turn-metadata']);
});
test('absent, non-extension and malformed inventories stay quietly computer-only', async t => {
  for (const browsers of [[], [{ type: 'iab' }], [{ type: 'extension' }], {}]) {
    const s = server(t, browsers); await selectSurfaces(s, {});
    assert.equal(s.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  }
});
test('explicit override skips detection and preserves backend configuration', async t => {
  const s = server(t, []); s.env.BROWSER_USE_AVAILABLE_BACKENDS = 'iab';
  await selectSurfaces(s, { SLEIGHT_SURFACES: 'browser' });
  assert.equal(s.env.CUA_REPL_ENABLED_SURFACES, 'browser');
  assert.equal(s.env.BROWSER_USE_AVAILABLE_BACKENDS, 'iab');
  assert.throws(() => requests(s), { code: 'ENOENT' });
});
test('hung discovery is bounded and collected', async t => {
  const s = server(t, [], { SLEIGHT_TEST_HUNG: '1' }); const start = Date.now();
  await selectSurfaces(s, {}, { timeoutMs: 100 });
  assert.equal(s.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  assert.ok(Date.now() - start < 3500);
});
test('discovery never approves a prompt after slow engine startup', async t => {
  // Startup deliberately exceeds the hung-case deadline. The fixture completes
  // only after receiving the reply; this larger timeout is a failure bound.
  const s = server(t, [], { SLEIGHT_TEST_ASK: '1', SLEIGHT_TEST_STARTUP_DELAY_MS: '250' });
  await selectSurfaces(s, {}, { timeoutMs: 10000 });
  assert.equal(s.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  assert.equal(requests(s).find(r => r.id === 'ask')?.result.action, 'decline');
});

test('a failed discovery call cannot enable browser control even if it emitted an inventory', async t => {
  const s = server(t, [{ type: 'extension', metadata: { extensionInstanceId: 'instance-1' } }], { SLEIGHT_TEST_ERROR: '1' });
  await selectSurfaces(s, {});
  assert.equal(s.env.CUA_REPL_ENABLED_SURFACES, 'computer');
});
