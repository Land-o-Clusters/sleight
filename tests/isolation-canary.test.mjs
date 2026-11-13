// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, symlinkSync, readFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { canaryPlan, runCanary } from '../bench/world/isolation-canary.mjs';
import { worldSettings } from '../bench/world/native-world.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'sleight-isolation-canary-')); t.after(() => removeTemp(home));
  const plan = canaryPlan({ home, armHome: join(home, 'arms'), arm: 'sleight', marker: 'SLEIGHT_CANARY_PRIVATE_MARKER' });
  mkdirSync(dirname(plan.canaryFile), { recursive: true });
  mkdirSync(dirname(plan.settings), { recursive: true });
  writeFileSync(plan.canaryFile, plan.fixtureText);
  const keyFile = join(home, '.config/sleight-bench/anthropic-api-key');
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, 'sk-ant-testfixture', { mode: 0o600 });
  writeFileSync(plan.settings, JSON.stringify(worldSettings({ hooks: {} })));
  return plan;
}
const reply = (plan, instructions) => ({ groupClean: true, exit: { code: 0 }, stdout: JSON.stringify({
  result: JSON.stringify({ receipt: plan.receipt, instructions }), num_turns: 1 }) });

test('canary dry plans name an owned dot-path fixture without writes or marker in the prompt', () => {
  const plan = canaryPlan({ home: '/fixture-home', armHome: '/fixture-home/arms', arm: 'sleight', marker: 'SLEIGHT_CANARY_PRIVATE_MARKER' });
  assert.match(plan.canaryFile, /sleight-isolation-canary-sleight\/work\/\.claude\/CLAUDE.md$/);
  assert.equal(plan.args.join(' ').includes(plan.marker), false);
  assert.equal(plan.command, '/fixture-home/arms/world-cli/node_modules/.bin/claude');
  assert.match(plan.env.CLAUDE_CONFIG_DIR, /sleight-arm\/claude$/);
});

test('canary builds world settings even when the arm has old hook-only settings', async t => {
  const plan = fixture(t);
  mkdirSync(dirname(plan.armSettings), { recursive: true });
  writeFileSync(plan.armSettings, JSON.stringify({ enabledPlugins: {}, hooks: {} }));
  const result = await runCanary({ ...plan, mode: 'control' }, {
    verify: () => '2.1.289', run: async (_command, _args, options) => {
      assert.match(options.env.CLAUDE_CONFIG_DIR, /sleight-arm\/claude$/);
      const settings = JSON.parse(readFileSync(plan.settings, 'utf8'));
      assert.equal(settings.autoMemoryEnabled, false);
      assert.equal(settings.pluginConfigs['cc-plugin-agents-md@builtin'].options.instructionFiles, 'managed-only');
      return reply(plan, plan.marker);
    },
  });
  assert.equal(result.passed, true);
});

test('canary uses the private benchmark key file and excludes inherited auth tokens', async t => {
  const plan = fixture(t);
  const result = await runCanary({ ...plan, mode: 'control' }, {
    verify: () => '2.1.289', env: { PATH: '/bin', ANTHROPIC_API_KEY: 'unrelated', ANTHROPIC_AUTH_TOKEN: 'owner' },
    run: async (_command, _args, options) => {
      assert.equal(options.env.ANTHROPIC_API_KEY, 'sk-ant-testfixture');
      assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, undefined);
      return reply(plan, plan.marker);
    },
  });
  assert.equal(result.passed, true);
  chmodSync(join(plan.home, '.config/sleight-bench/anthropic-api-key'), 0o644);
  await assert.rejects(runCanary({ ...plan, mode: 'control' }, {
    verify: () => '2.1.289', run: () => assert.fail('public key must refuse before model startup'),
  }), /readable by others/);
});

test('the canary CLI defaults to a dry plan and never starts the absent pinned executable', () => {
  const name = `mcp:canary-${randomBytes(8).toString('hex')}`;
  const output = execFileSync(process.execPath, [new URL('../bench/world/isolation-canary.mjs', import.meta.url).pathname,
    '--arm', name, '--marker', 'SLEIGHT_CANARY_PRIVATE_MARKER', '--arm-home', `${MAC_TMP}/absent-canary-cli`, '--dry-run'], { encoding: 'utf8' });
  const plan = JSON.parse(output);
  assert.equal(plan.dryRun, true);
  assert.equal(existsSync(plan.root), false);
  assert.throws(() => canaryPlan({ home: '/fixture-home', root: '/fixture-home', marker: plan.marker }), /own named folder/);
});

test('an isolated probe refuses without a positive control and never calls the CLI', async t => {
  const plan = fixture(t);
  const result = await runCanary(plan, { verify: () => '2.1.289', run: () => assert.fail('must not launch a model') });
  assert.equal(result.passed, false);
  assert.match(result.reason, /positive control/);
});

test('a profile symlink refuses before version discovery or a model call', async t => {
  const plan = fixture(t), owner = join(plan.home, 'owner-profile');
  mkdirSync(owner); mkdirSync(dirname(plan.env.CLAUDE_CONFIG_DIR), { recursive: true });
  symlinkSync(owner, plan.env.CLAUDE_CONFIG_DIR);
  await assert.rejects(runCanary({ ...plan, mode: 'control' }, {
    verify: () => { throw new Error('TEST_REACHED_VERSION'); }, run: () => assert.fail('no model call'),
  }), /symlink/);
});

test('positive control and isolation each make one call, and only valid replies qualify', async t => {
  const plan = fixture(t), calls = [];
  const invoke = instructions => async (command, args, options) => {
    calls.push({ command, args, options }); return reply(plan, instructions);
  };
  const control = await runCanary({ ...plan, mode: 'control' }, { verify: () => '2.1.289', run: invoke(plan.marker) });
  assert.equal(control.passed, true);
  assert.equal(calls.length, 1);
  const isolated = await runCanary(plan, { verify: () => '2.1.289', run: invoke(null) });
  assert.equal(isolated.passed, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.cwd, plan.cwd);
  assert.equal(calls[1].options.env.DO_NOT_TRACK, '1');
  assert.ok(calls[1].args.includes('--strict-mcp-config'));
  assert.ok(calls[1].args.includes('--max-turns'));
  assert.equal(calls[1].args.join(' ').includes(plan.marker), false);
  const leak = await runCanary(plan, { verify: () => '2.1.289', run: invoke(plan.marker) });
  assert.equal(leak.passed, false);
  const malformed = await runCanary(plan, { verify: () => '2.1.289', run: async () => ({ ...reply(plan, null), stdout: '{"result":"refused"}' }) });
  assert.equal(malformed.passed, false);
  assert.match(malformed.reason, /protocol/);
});

test('changed canary contents invalidate the positive control before a model call', async t => {
  const plan = fixture(t);
  await runCanary({ ...plan, mode: 'control' }, { verify: () => '2.1.289', run: async () => reply(plan, plan.marker) });
  writeFileSync(plan.canaryFile, plan.fixtureText + '\nChanged');
  const result = await runCanary(plan, { verify: () => '2.1.289', run: () => assert.fail('must not launch after fixture drift') });
  assert.equal(result.passed, false);
  assert.match(result.reason, /positive control/);
});

test('glob-only mode reports marker leakage and dry execution does not make a call', async t => {
  const plan = fixture(t);
  await runCanary({ ...plan, mode: 'control' }, { verify: () => '2.1.289', run: async () => reply(plan, plan.marker) });
  const result = await runCanary({ ...plan, mode: 'glob' }, { verify: () => '2.1.289', run: async () => reply(plan, plan.marker) });
  assert.equal(result.passed, false);
  assert.equal(result.markerSeen, true);
  const absent = canaryPlan({ home: plan.home, armHome: plan.armHome, arm: 'cua', marker: plan.marker });
  await runCanary(absent, { dryRun: true, run: () => assert.fail('dry run'), verify: () => assert.fail('dry version check') });
  assert.equal(existsSync(absent.root), false);
});
