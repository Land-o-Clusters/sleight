import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { nativePlan, parseOptions } from '../bench/world/arms/cursor-cu/suite.mjs';
import { realAgentSetup } from '../bench/fowl/real-gate-setup.mjs';
import { taskSupport } from '../bench/fowl/support.mjs';
import { runGateAgent } from '../bench/fowl/real-gate.mjs';
import { armPaths } from '../bench/world/arms/cursor-cu/contract.mjs';
import { worldLoginReadiness } from '../bench/world/login-readiness.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('native world route selects the shared fixture and defaults to high effort Grok', () => {
  const p = nativePlan(parseOptions(['--suite', 'world', '--arm', 'cursor-cu', '--tasks', 'textedit-edit', '--runs', '3', '--dry-run']));
  assert.equal(p.runs.length, 3); assert.ok(p.runs.every(r => r.task === 'textedit-edit'));
  assert.equal(p.composer.modelLabel, 'Grok 4.7 High'); assert.equal(p.route, 'desktop');
  assert.ok(!nativePlan({}).runs.some(r => ['word-memo', 'word-brief', 'textedit-notes-table', 'cc-list-native'].includes(r.task)));
  assert.throws(() => nativePlan(parseOptions(['--arm', 'cursor-cu,sleight'])), /one arm/);
  assert.throws(() => parseOptions(['--model', 'auto']), /Grok/);
  assert.throws(() => parseOptions(['--effort', 'medium']), /high/);
  assert.throws(() => parseOptions(['--fast']), /option/);
});

test('world runner cursor dry plan succeeds when Node forbids writes, network and child processes', () => {
  const r = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', 'bench/run.mjs', '--suite', 'world', '--arm', 'cursor-cu',
    '--tasks', 'textedit-edit', '--runs', '1', '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); const p = JSON.parse(r.stdout);
  assert.equal(p.runs[0].task, 'textedit-edit');
});

test('rounds.sh sends the Cursor surface to its desktop route before Fowl setup or funding', () => {
  const r = spawnSync('/bin/sh', ['bench/fowl/rounds.sh', '--surface', 'cursor-cu', '--real-browser', 'chrome', '--only', 'mdn', '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); const p = JSON.parse(r.stdout);
  assert.equal(p.surface, 'cursor-cu'); assert.equal(p.arms[0].cursorPlan.route, 'desktop');
  assert.equal(p.arms[0].cursorPlan.modelLabel, 'Grok 4.7 High');
});

test('Chrome dry plan starts no metadata subprocess and cannot write or use the network', () => {
  const r = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', 'bench/world/arms/cursor-cu/suite.mjs', '--chrome',
    '--surface', 'cursor-cu', '--real-browser', 'chrome', '--only', 'mdn', '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout); assert.equal(p.engine.used, false); assert.equal(p.browser.version, null);
});

test('Chrome arm uses the same prompt and grader without a Claude CLI or MCP server', () => {
  const task = { name: 'mdn', browser: 'chrome', prompt: 'Use {browser} for MDN.', result: 'the answer' };
  assert.equal(taskSupport(task, 'cursor-cu', { realBrowser: 'chrome' }), null);
  assert.match(taskSupport(task, 'cursor-cu', { realBrowser: 'safari' }), /Chrome/);
  const p = realAgentSetup({ task, surface: 'cursor-cu', dir: '/tmp/cursor-test-run', realBrowser: { browser: 'chrome' }, dryRun: true });
  assert.equal(p.command, null); assert.equal(p.mcpConfig, null); assert.equal(p.metadata.route, 'desktop');
  assert.match(p.cursorPlan.prompt, /RESULT:/); assert.deepEqual(p.cursorPlan.paths, armPaths());
});

test('world readiness never invokes Claude for the Cursor desktop arm', () => {
  const rows = worldLoginReadiness(['cursor-cu'], { cursorReadiness: () => ({ arm: 'cursor-cu', loggedIn: 'unverified', ready: false }), login: () => assert.fail('Claude login call') });
  assert.equal(rows[0].arm, 'cursor-cu'); assert.equal(rows[0].ready, false);
});

test('Chrome run records Cursor fields and uses submit-to-end time while retaining outer time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca2-gate-'));
  const taskDir = join(dir, 'mdn');
  try {
    const p = realAgentSetup({ task: { name: 'mdn', browser: 'chrome', prompt: 'Look up MDN.', result: 'the answer' }, surface: 'cursor-cu', dir: taskDir,
      realBrowser: { browser: 'chrome' }, dryRun: true });
    const r = await runGateAgent({ ...p, dir: taskDir, surface: 'cursor-cu', task: { name: 'mdn' } }, { runCursor: async () => ({
      type: 'result', is_error: false, result: 'RESULT: answer', duration_ms: 700, submittedAt: 1000, recordedEndAt: 1700,
      groupClean: true, cursorVersion: '3.27.12', route: 'desktop', model: 'grok-4.7', effort: 'high', calls: 0, tools: [] }) });
    assert.equal(r.result.cursorVersion, '3.27.12'); assert.equal(r.finished - r.started, 700); assert.ok(r.outerStarted > 0);
    assert.equal(r.agentSeconds, 0.7);
    assert.equal(r.evidence.successfulCalls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
