import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
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

for (const [mode, entries, auditFails, expected] of [
  ['app-preapproved', [{ app: 'com.apple.calculator', riskLevel: 'low' }], false, 'ok'],
  ['app-preapproved-name', [{ app: 'Calculator', riskLevel: 'medium' }], false, 'ok'],
  ['app-preapproved', [], false, 'skipped'],
  ['app-preapproved-high', [{ app: 'com.apple.calculator', riskLevel: 'low' }], false, 'skipped'],
  ['app-preapproved-unknown', [{ app: 'com.apple.calculator', riskLevel: 'high' }], false, 'skipped'],
  ['app-preapproved-other', [{ app: 'com.apple.calculator', riskLevel: 'low' }], false, 'skipped'],
  ['app-preapproved-mismatch', [{ app: 'Mail', riskLevel: 'low' }], false, 'skipped'],
  ['app-preapproved', [{ app: 'com.apple.calculator', riskLevel: 'low' }], true, 'skipped'],
]) {
  test(`doctor applies the user list before app approval: ${mode}, ${entries.length} entries, audit failure ${auditFails}`, async t => {
    const bank = await mkdtemp(join(tmpdir(), 'sleight-doctor-list-'));
    t.after(() => rm(bank, { recursive: true, force: true }));
    const listFile = join(bank, 'user-list.json');
    await writeFile(listFile, JSON.stringify({ version: 1, apps: entries }), { mode: 0o600 });
    const preapprovedIO = { ...fs, lstatSync: () => fs.lstatSync(listFile), realpathSync: path => path,
      openSync: (_path, flags) => fs.openSync(listFile, flags) };
    const auditDirectory = join(bank, 'audit');
    if (auditFails) await writeFile(auditDirectory, 'not a directory');
    const auditFile = join(auditDirectory, `preapproved-${process.pid}.jsonl`);
    const config = join(bank, 'plugins/cache/openai-bundled/unified-computer-use/1.0');
    await mkdir(config, { recursive: true });
    const script = fileURLToPath(new URL('fixtures/helper-probe-server.mjs', import.meta.url));
    await writeFile(join(config, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
      command: process.execPath, args: [script, mode, auditFile], env: { CUA_REPL_NODE_REPL_PATH: script, SKY_CUA_SERVICE_PATH: script },
    } } }));
    const lines = [];
    assert.equal(await doctor({ app: 'Calculator', preapprovedIO, auditDirectory,
      env: { CODEX_HOME: bank, SLEIGHT_SURFACES: 'computer' }, log: line => lines.push(line),
      timeoutMs: 2000, forbiddenTargets: () => '0' }), 0);
    assert.match(lines.join('\n'), new RegExp(`app read ${expected}`));
    assert.doesNotMatch(lines.join('\n'), /PRIVATE WINDOW TITLE|PRIVATE CONTENT/);
    if (expected === 'ok') {
      assert.match(lines.join('\n'), /\d+ ms, window header: yes/);
      const records = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(records.length, 1);
      assert.deepEqual(records[0].grant, { app: mode.endsWith('-name') ? 'Calculator' : 'com.apple.calculator',
        riskLevel: 'low', tool: 'engine', source: '~/Library/Application Support/sleight/preapproved.json' });
      assert.equal(fs.statSync(auditFile).mode & 0o777, 0o600);
    } else {
      assert.match(lines.join('\n'), /declined without a prompt/);
      assert.equal(fs.existsSync(auditFile), false);
    }
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

for (const [mode, app, code, message] of [
  ['app-ok', 'Calculator', 0, /app read ok.*\d+ ms.*window header: yes/],
  ['app-ok', 'com.apple.calculator', 0, /app read ok.*window header: yes/],
  ['app-ok', 'TextEdit', 0, /app read skipped.*not running/],
  ['app-not-running', 'com.apple.calculator', 0, /app read skipped.*not running/],
  ['app-running-unknown', 'com.apple.calculator', 0, /app read skipped.*running status unknown/],
  ['app-ambiguous', 'Calculator', 0, /app read skipped.*ambiguous/],
  ['app-approval', 'Calculator', 0, /app read skipped.*approval required/],
  ['app-no-header', 'Calculator', 1, /app read FAILED.*\d+ ms.*window header: no/],
  ['app-timeout', 'Calculator', 1, /app read FAILED.*timeoutReached/],
  ['app-partial-error', 'Calculator', 1, /app read FAILED.*window header: yes.*engine error/],
  ['app-rpc-private', 'Calculator', 1, /app read FAILED.*window header: no.*engine error/],
]) {
  test(`doctor reports an optional running app read: ${mode}, ${app}`, async t => {
    const bank = await mkdtemp(join(tmpdir(), 'sleight-doctor-app-'));
    t.after(() => rm(bank, { recursive: true, force: true }));
    const config = join(bank, 'plugins/cache/openai-bundled/unified-computer-use/1.0');
    await mkdir(config, { recursive: true });
    const script = fileURLToPath(new URL('fixtures/helper-probe-server.mjs', import.meta.url));
    await writeFile(join(config, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
      command: process.execPath, args: [script, mode], env: { CUA_REPL_NODE_REPL_PATH: script, SKY_CUA_SERVICE_PATH: script },
    } } }));
    const lines = [];
    assert.equal(await doctor({ app, env: { CODEX_HOME: bank, SLEIGHT_SURFACES: 'computer' },
      log: line => lines.push(line), timeoutMs: 2000, forbiddenTargets: () => '0' }), code);
    assert.match(lines.join('\n'), /live read ok \(helper inventory\)/);
    assert.match(lines.join('\n'), message);
    assert.doesNotMatch(lines.join('\n'), /restart ChatGPT|PRIVATE WINDOW TITLE|PRIVATE CONTENT/);
  });
}
