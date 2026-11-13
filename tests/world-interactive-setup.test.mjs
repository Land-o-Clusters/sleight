import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { setupPlan, installInteractive } from '../bench/world/arms/claude-cu/setup.mjs';
import { interactivePlan } from '../bench/world/arms/claude-cu/interactive.mjs';
import { recordTurnEnd } from '../bench/world/arms/claude-cu/turn-ended.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-cu-setup-')); t.after(() => removeTemp(dir));
  return join(dir, 'claude-cu');
}

test('interactive setup pins Claude and leaves the target absent in dry mode', t => {
  const target = fixture(t), plan = setupPlan(target);
  assert.equal(plan.supported, true);
  assert.ok(plan.install.args.includes('@anthropic-ai/claude-code@2.1.289'));
  assert.ok(plan.install.args.includes('--ignore-scripts'));
  assert.equal(plan.configDir, join(plan.target, 'claude'));
  installInteractive(plan, { dryRun: true, run: () => assert.fail('dry installation') });
  assert.equal(existsSync(target), false);
});

test('only the pinned Claude lifecycle and version check run in the isolated profile', t => {
  const target = fixture(t), plan = setupPlan(target), calls = [];
  installInteractive(plan, { run: (command, args, options) => {
    calls.push({ command, args, options }); return { status: 0, stdout: args[0] === '--version' ? '2.1.289 (Claude Code)\n' : '' };
  } });
  assert.equal(calls.length, 3);
  assert.match(calls[1].args[0], /@anthropic-ai\/claude-code\/install.cjs$/);
  assert.ok(calls.every(c => c.options.env.CLAUDE_CONFIG_DIR === plan.configDir));
  assert.ok(calls.every(c => c.options.env.ANTHROPIC_API_KEY === undefined));
  assert.throws(() => installInteractive(plan), /already exists/);
});

test('a version mismatch removes only the newly created target', t => {
  const target = fixture(t), plan = setupPlan(target);
  assert.throws(() => installInteractive(plan, { run: () => ({ status: 0, stdout: '2.1.288 (Claude Code)' }) }), /2\.1\.289/);
  assert.equal(existsSync(target), false);
});

test('setup CLI emits a dry plan without installing anything', t => {
  const target = fixture(t);
  const result = spawnSync(process.execPath, [new URL('../bench/world/arms/claude-cu/setup.mjs', import.meta.url).pathname,
    '@anthropic-ai/claude-code@2.1.289', '--dry-run', target], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).supported, true);
  assert.equal(existsSync(target), false);
});

test('Stop receipt binds the task session and nonce without altering approval state', t => {
  const target = fixture(t), p = interactivePlan({ armDir: target, prompt: 'RESULT ok' });
  installInteractive(setupPlan(target), { run: (_command, args) => ({ status: 0, stdout: args[0] === '--version' ? '2.1.289 (Claude Code)' : '' }) });
  assert.throws(() => recordTurnEnd({ session_id: 'foreign' }, p.env), /binding/);
  assert.equal(existsSync(p.turnFile), false);
  recordTurnEnd({ session_id: p.sessionId }, p.env);
  assert.deepEqual(JSON.parse(readFileSync(p.turnFile, 'utf8')), { sessionId: p.sessionId, nonce: p.nonce });
});

test('interactive CLI defaults to dry mode and never starts the absent Claude', t => {
  const target = fixture(t), prompt = join(target, '..', 'task.txt');
  writeFileSync(prompt, 'RESULT dry fixture');
  const result = spawnSync(process.execPath, [new URL('../bench/world/arms/claude-cu/interactive.mjs', import.meta.url).pathname,
    '--arm-dir', target, '--prompt-file', prompt], { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'fixture' } });
  assert.equal(result.status, 0, result.stderr);
  const dry = JSON.parse(result.stdout);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.plan.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(existsSync(target), false);
});
