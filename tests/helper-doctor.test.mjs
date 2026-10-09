import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { doctor } from '../plugins/sleight/lib/launch.mjs';
import { probeHelper, staleHelperJobs } from '../plugins/sleight/lib/helper-health.mjs';

const STALE_LISTING = 'PID\tStatus\tLabel\n-\t0\tapplication.com.openai.sky.CUAService.1.2\n83422\t0\tapplication.com.openai.codex.3.4\n';

for (const [mode, code, message] of [
  ['ok', 0, /live read.*ok/i],
  ['timeout', 1, /stuck.*restart ChatGPT/s],
  ['js-timeout', 1, /stuck.*restart ChatGPT/s],
  ['read-hang', 1, /stuck.*restart ChatGPT/s],
  ['startup-hang', 1, /server.*startup.*timed out/i],
  ['rpc-error', 1, /helper unavailable/],
  ['approval', 1, /approval declined/],
  ['launch-failed', 1, /live read FAILED: Native apps: Error: Sky Computer Use service startup request failed\n.*\n  launchctl remove application\.com\.openai\.sky\.CUAService\.1\.2$/],
]) {
  test(`doctor performs a bounded live read: ${mode}`, async t => {
    const bank = await mkdtemp(join(tmpdir(), 'sleight-doctor-test-'));
    t.after(() => rm(bank, { recursive: true, force: true }));
    const config = join(bank, 'plugins/cache/openai-bundled/unified-computer-use/1.0');
    await mkdir(config, { recursive: true });
    const script = fileURLToPath(new URL('fixtures/helper-probe-server.mjs', import.meta.url));
    await writeFile(join(config, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
      command: process.execPath, args: [script, mode], env: { CUA_REPL_NODE_REPL_PATH: script, SKY_CUA_SERVICE_PATH: script },
    } } }));
    const lines = [];
    // Tight limits only where the mode tests that limit: a node fixture can take longer than 200 ms
    // to start, or 100 ms to answer, under load, and then fails with the wrong message (3 times on
    // 2026-10-09, while benchmark runs went on).
    const timeoutMs = ['timeout', 'js-timeout', 'read-hang'].includes(mode) ? 100 : 2000;
    const startupTimeoutMs = mode === 'startup-hang' ? 200 : 5000;
    assert.equal(await doctor({ env: { CODEX_HOME: bank, SLEIGHT_SURFACES: 'computer' }, log: line => lines.push(line), timeoutMs, startupTimeoutMs,
      launchctlList: async () => STALE_LISTING }), code);
    assert.match(lines.join('\n'), message);
  });
}

test('doctor does not start a live read when required files are missing', async () => {
  const lines = [];
  assert.equal(await doctor({ env: { CODEX_HOME: '/no-such-sleight-home' }, log: line => lines.push(line) }), 1);
  assert.match(lines.join('\n'), /no Codex computer-use plugin/);
});

test('doctor collects a descendant that retains pipes after its parent exits', async () => {
  const script = fileURLToPath(new URL('fixtures/helper-probe-server.mjs', import.meta.url));
  const started = Date.now();
  const result = await probeHelper({ command: process.execPath, args: [script, 'orphan'] },
    { timeoutMs: 100, startupTimeoutMs: 200, cleanupGraceMs: 50, cleanupForceMs: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.stuck, true);
  assert.ok(Date.now() - started < 1500, 'descendant survived the cleanup deadline');
});

test('only helper jobs without a process count as stale', () => {
  assert.deepEqual(staleHelperJobs(STALE_LISTING), ['application.com.openai.sky.CUAService.1.2']);
  assert.deepEqual(staleHelperJobs('15463\t0\tapplication.com.openai.sky.CUAService.1.2\n-\t0\tapplication.com.example.CUAService.1\n'), []);
  assert.deepEqual(staleHelperJobs('-\t0\tapplication.com.openai.sky.CUAService.1;rm -rf ~\n'), []);
});
