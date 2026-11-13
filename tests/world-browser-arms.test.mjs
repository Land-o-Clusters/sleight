// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const surfaces = ['playwright-mcp', 'chrome-devtools-mcp', 'claude-in-chrome', 'claude-cu'];
const options = { task: { name: 'local-form', browser: 'chrome', prompt: 'Complete the form in {browser} at http://127.0.0.1:4811/t/local-form/', result: 'submitted' },
  dir: `${MAC_TMP}/world-run/local-form`, armRoot: `${MAC_TMP}/world-arms`, hostEnv: { PATH: '/usr/bin', HOME: '/fixture/home' } };

test('browser arms use only their pinned local tool and isolated agent configuration', async (t) => {
  const { browserArmSetup } = await import('../bench/world/arms/browser.mjs');
  const parent = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-world-chrome-config-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const chromeFiles = { deviceFile: join(parent, 'device'), localState: join(parent, 'Local State') };
  writeFileSync(chromeFiles.deviceFile, '83e6d921-8a11-4c87-a945-cbd5b5b883d6\n', { mode: 0o600 });
  writeFileSync(chromeFiles.localState, JSON.stringify({ profile: { info_cache: { 'Profile 7': { name: 'sleight benchmark' } } } }));
  for (const surface of surfaces.slice(0, 3)) {
    const setup = browserArmSetup({ ...options, surface, chromeFiles });
    assert.equal(setup.command, join(options.armRoot, surface, 'node_modules/.bin/claude'));
    assert.equal(setup.env.CLAUDE_CONFIG_DIR, join(options.armRoot, surface, 'claude-config'));
    assert.ok(setup.args.includes('--setting-sources'));
    assert.ok(setup.args.includes('--tools'));
    assert.ok(!setup.args.includes('--plugin-dir'));
    if (surface === 'claude-in-chrome') {
      assert.deepEqual(setup.mcpServers, {});
      assert.ok(setup.args.includes('--chrome'));
      assert.match(setup.allowed, /mcp__claude-in-chrome/);
    } else {
      assert.ok(setup.args.includes('--no-chrome'));
      assert.equal(Object.keys(setup.mcpServers).length, 1);
      const server = Object.values(setup.mcpServers)[0];
      assert.ok(server.command.startsWith(join(options.armRoot, surface, 'node_modules/.bin/')));
      assert.equal(server.args[server.args.indexOf('--user-data-dir') + 1], join(options.dir, 'browser-profile'));
      assert.ok(!server.args.includes('--headless'));
    }
  }
});

test('DevTools usage statistics and CrUX URL uploads are disabled', async () => {
  const { browserArmSetup } = await import('../bench/world/arms/browser.mjs');
  const server = Object.values(browserArmSetup({ ...options, surface: 'chrome-devtools-mcp' }).mcpServers)[0];
  assert.ok(server.args.includes('--no-usage-statistics'));
  assert.ok(server.args.includes('--no-performance-crux'));
  assert.equal(server.env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS, '1');
});

test('no inherited CLAUDE variable reaches an arm and Chrome never falls back from incompatible auth', async () => {
  const { browserArmSetup } = await import('../bench/world/arms/browser.mjs');
  const hostEnv = { ...options.hostEnv, CLAUDE_CODE_SESSION_ID: 'host', CLAUDE_CODE_OAUTH_TOKEN: 'host-token', CLAUDE_CONFIG_DIR: '/owner/config', CLAUDE_OTHER: 'host' };
  const setup = browserArmSetup({ ...options, surface: 'playwright-mcp', hostEnv });
  assert.equal(setup.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(setup.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(setup.env.CLAUDE_OTHER, undefined);
  assert.equal(setup.env.PATH, hostEnv.PATH);
  assert.throws(() => browserArmSetup({ ...options, surface: 'claude-in-chrome', hostEnv: { ANTHROPIC_API_KEY: 'fixture' } }), /API.key.*not supported/i);
  assert.throws(() => browserArmSetup({ ...options, surface: 'claude-in-chrome', task: { ...options.task, browser: 'helium' } }), /Chrome.*select/i);
  assert.throws(() => browserArmSetup({ ...options, surface: 'claude-cu' }), /interactive.*-p/i);
  assert.throws(() => browserArmSetup({ ...options, surface: 'playwright-mcp', remote: {} }), /remote/i);
});

test('each setup script pins its packages and dry-run writes nothing', (t) => {
  const parent = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-world-setup-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  for (const surface of surfaces) {
    const target = join(parent, surface);
    const script = join(root, 'bench/world/arms', surface, 'setup.sh');
    assert.ok(existsSync(script), surface);
    const run = spawnSync('/bin/sh', [script, '--dry-run', target], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(target), false);
    const plan = JSON.parse(run.stdout);
    if (surface === 'claude-cu') assert.equal(plan.supported, true);
    const cmd = plan.install;
    assert.equal(cmd.command, 'npm');
    assert.equal(cmd.args[cmd.args.indexOf('--prefix') + 1], surface === 'claude-cu' ? plan.target : target);
    assert.equal(cmd.args[cmd.args.indexOf('--cache') + 1], join(surface === 'claude-cu' ? plan.target : target, 'npm-cache'));
    assert.ok(cmd.args.includes('@anthropic-ai/claude-code@2.1.289'));
    assert.ok(cmd.args.includes('--ignore-scripts'));
    if (surface === 'playwright-mcp') assert.ok(cmd.args.includes('@playwright/mcp@0.0.83'));
    if (surface === 'chrome-devtools-mcp') assert.ok(cmd.args.includes('chrome-devtools-mcp@1.10.1'));
    if (surface === 'claude-in-chrome') assert.equal(plan.extension.version, '1.0.100');
  }
});

test('the patched runner dry-runs every new surface without spawning an agent or changing the grader', async (t) => {
  const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
  if (!existsSync(join(cache, '.git'))) return t.skip('pinned FowlBrowser cache is absent');
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-world-runner-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = spawnSync('/usr/bin/git', ['-C', cache, 'show', '6a12d60:tools/rounds.mjs'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(original.status, 0, original.stderr);
  mkdirSync(join(dir, 'tools'));
  writeFileSync(join(dir, 'tools/rounds.mjs'), original.stdout);
  const apply = spawnSync('/usr/bin/git', ['apply', join(root, 'bench/fowl/sleight-surface.patch')], { cwd: dir, encoding: 'utf8' });
  assert.equal(apply.status, 0, apply.stderr);
  const patched = readFileSync(join(dir, 'tools/rounds.mjs'), 'utf8');
  const grader = source => source.slice(source.indexOf('export function gradeSite('), source.indexOf('export function gradeSite(') + 1500);
  assert.equal(grader(patched), grader(original.stdout));
  const tasks = join(dir, 'tasks.json');
  writeFileSync(tasks, JSON.stringify([options.task]));
  const deviceFile = join(dir, 'device'), localState = join(dir, 'Local State');
  writeFileSync(deviceFile, '83e6d921-8a11-4c87-a945-cbd5b5b883d6\n', { mode: 0o600 });
  writeFileSync(localState, JSON.stringify({ profile: { info_cache: { 'Profile 7': { name: 'sleight benchmark' } } } }));
  for (const surface of surfaces) {
    const output = join(dir, 'never-written', surface);
    const run = spawnSync(process.execPath, [join(dir, 'tools/rounds.mjs'), '--surface', surface, '--tasks', tasks, '--out', output, '--model', 'haiku', '--effort', 'high', '--dry-run', '--chrome-device-file', deviceFile, '--chrome-local-state', localState],
      { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, SLEIGHT_REPO: root } });
    assert.equal(run.status, 0, run.stderr);
    const plan = JSON.parse(run.stdout)[0];
    assert.equal(existsSync(output), false);
    if (surface === 'claude-cu') {
      assert.equal(plan.supported, true, plan.reason);
      assert.equal(plan.command, process.execPath);
      assert.ok(plan.args.includes('--prompt'));
      assert.equal(plan.args.includes('-p'), false);
      continue;
    }
    assert.ok(plan.args.includes('claude-haiku-5-5'));
    assert.ok(plan.args.includes('high'));
    assert.ok(plan.prompt.endsWith('End your answer with one line starting with RESULT: that states submitted.'));
    assert.ok(plan.prompt.includes('Complete the form in Chrome at http://127.0.0.1:4811/t/local-form/'));
    assert.equal(plan.args[plan.args.indexOf('--model') + 1], 'claude-haiku-5-5');
    assert.ok(plan.args[plan.args.indexOf('--disallowedTools') + 1].includes('Bash'));
  }
});

test('arm setup refuses git folders and symlinks into them before writing', async (t) => {
  const { outsideGit } = await import('../bench/world/arms/browser.mjs');
  const { symlinkSync } = await import('node:fs');
  const parent = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-world-git-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const repo = join(parent, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  symlinkSync(repo, join(parent, 'alias'));
  assert.throws(() => outsideGit(join(repo, 'missing', 'playwright-mcp')), /outside any git/);
  assert.throws(() => outsideGit(join(parent, 'alias', 'missing', 'playwright-mcp')), /outside any git/);
});
