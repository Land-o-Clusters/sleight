import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { worldCLI, worldArm, worldSettings, assertWorldCLI, worldSetupPlan, installWorldCLI } from '../bench/world/native-world.mjs';

test('world arms share the pinned CLI and exclude user instructions and auto memory explicitly', () => {
  assert.equal(worldCLI('/bank'), '/bank/world-cli/node_modules/.bin/claude');
  for (const name of ['sleight', 'cua', 'peekaboo']) {
    const arm = worldArm({ cwd: `/bank/${name}`, args: [], env: {} }, name);
    assert.equal(arm.identity.claudeVersion, '2.1.289');
    assert.equal(arm.env.CLAUDE_CONFIG_DIR, `/bank/${name}/claude`);
    assert.equal(arm.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.ok(arm.args.includes('--no-chrome'));
    const settings = worldSettings({ hooks: { benchmark: [] } });
    assert.equal(settings.autoMemoryEnabled, false);
    assert.deepEqual(settings.claudeMdExcludes, ['**', '**/.claude/**', '**/.claude/**/.*']);
    assert.equal(settings.pluginConfigs['cc-plugin-agents-md@builtin'].options.instructionFiles, 'managed-only');
    assert.deepEqual(settings.hooks, { benchmark: [] });
  }
});

test('an unpinned Claude binary refuses before any model or MCP call', () => {
  assert.throws(() => assertWorldCLI('/fixture/claude', () => '2.1.288 (Claude Code)'), /2\.1\.289/);
  assert.equal(assertWorldCLI('/fixture/claude', () => '2.1.289 (Claude Code)'), '2.1.289');
});

test('version and installer children exclude host Claude identity and credentials', async t => {
  const prior = process.env; t.after(() => { process.env = prior; });
  process.env = { PATH: '/bin', HOME: '/fixture', LANG: 'C',
    CLAUDE_CONFIG_DIR: '/owner', CLAUDE_CUSTOM: 'host', ANTHROPIC_API_KEY: 'host-key', NODE_OPTIONS: 'host-loader' };
  const seen = [];
  const run = (_command, args, options) => { seen.push(options.env); return args[0] === '--version' ? '2.1.289 (Claude Code)' : ''; };
  assertWorldCLI('/fake', run);
  const temp = mkdtempSync(join(tmpdir(), 'sleight-world-env-')); t.after(() => removeTemp(temp));
  await installWorldCLI(worldSetupPlan(join(temp, 'cli')), { run });
  assert.equal(seen.length, 4);
  for (const env of seen) {
    assert.equal(env.CLAUDE_CUSTOM, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.notEqual(env.CLAUDE_CONFIG_DIR, '/owner');
    assert.equal(env.PATH, '/bin');
  }
});

test('the pinned CLI installer plan leaves the target absent and runs only the explicit Claude lifecycle', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'sleight-world-cli-'));
  try {
    const dir = join(temp, 'uncreated'), plan = worldSetupPlan(dir), calls = [];
    await installWorldCLI(plan, { dryRun: true, run: () => assert.fail('dry run must not execute') });
    assert.equal(existsSync(dir), false);
    await installWorldCLI(plan, { run: (command, args) => {
      calls.push([command, ...args]);
      return args[0] === '--version' ? '2.1.289 (Claude Code)' : '';
    } });
    assert.ok(calls[0].includes('--ignore-scripts'));
    assert.ok(calls[0].includes('@anthropic-ai/claude-code@2.1.289'));
    assert.match(calls[1][1], /@anthropic-ai\/claude-code\/install\.cjs$/);
    assert.equal(calls[2][1], '--version');
  } finally { removeTemp(temp); }
});

test('the setup CLI dry run creates nothing and refuses an incomplete directory option', () => {
  const temp = mkdtempSync(join(tmpdir(), 'sleight-world-cli-plan-'));
  try {
    const dir = join(temp, 'absent'), file = new URL('../bench/world/native-world.mjs', import.meta.url).pathname;
    const output = execFileSync(process.execPath, [file, '--setup', '--dry-run', '--dir', dir], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).version, '2.1.289');
    assert.equal(existsSync(dir), false);
    assert.throws(() => execFileSync(process.execPath, [file, '--setup', '--dry-run', '--dir'], { stdio: 'pipe' }), /incomplete/);
  } finally { removeTemp(temp); }
});
