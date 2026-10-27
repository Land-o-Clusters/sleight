import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { realAgentSetup } from '../bench/fowl/real-gate-setup.mjs';
import { sleightPluginLaunch } from '../bench/sleight-plugin-launch.mjs';
import * as battery from '../bench/battery/runtime.mjs';
import { startupProbePlan } from '../bench/fowl/startup-probe.mjs';
import { sleightInitProblems } from '../bench/mcp-catalog.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const task = { name: 'fixture', browser: 'chrome', prompt: 'Read http://127.0.0.1:5431/form in {browser}.', result: 'the value' };
const own = 'plugin:sleight:computer';
test('startup probes use the same sources, chrome setting and MCP mode in every arm', () => {
  for (const arm of ['bare', 'mcp', 'plugin', 'both']) {
    const plan = startupProbePlan({ arm, repo, mcp: '/fixture/mcp.json', empty: '/fixture/empty.json', settings: '/fixture/settings.json', env: {} });
    if (arm === 'plugin' || arm === 'both') checkLaunch(plan, [own]);
    assert.equal(plan.args.includes('--strict-mcp-config'), false);
    assert.equal(plan.args[plan.args.indexOf('--setting-sources') + 1], '');
    assert.ok(plan.args.includes('--no-chrome'));
    assert.equal(plan.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.equal(plan.args[plan.args.indexOf('--mcp-config') + 1], arm === 'mcp' || arm === 'both' ? '/fixture/mcp.json' : '/fixture/empty.json');
  }
});
test('clean battery launch allows the mod with the same isolated server and hooks', () => {
  assert.equal(typeof battery.batteryClaudePlan, 'function');
  const plan = battery.batteryClaudePlan({ cleanArms: true, mcp: '/fixture/mcp.json', settings: '/fixture/settings.json',
    baseSettings: { hooks: { Stop: [] } }, env: { CLAUDE_CONFIG_DIR: '/fixture/config' }, option: (_name, value) => value });
  checkLaunch(plan, [own]);
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, '/fixture/config');
  assert.deepEqual(plan.settingsOverrides.hooks, { Stop: [] });
});
test('launch refuses unexpected companion servers and keeps existing hooks', () => {
  const plan = { args: ['--plugin-dir', '/fixture/plugin', '--strict-mcp-config'],
    mcpConfig: { mcpServers: { [own]: { command: '/fixture/server' } } },
    settingsOverrides: { allowedMcpServers: [{ serverName: 'foreign' }], hooks: { Stop: [{ fixture: true }] } },
    env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'true' } };
  const clean = sleightPluginLaunch(plan);
  assert.deepEqual(clean.settingsOverrides.allowedMcpServers, [{ serverName: own }]);
  assert.deepEqual(clean.settingsOverrides.hooks, { Stop: [{ fixture: true }] });
  assert.equal(clean.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.ok(clean.args.includes('--no-chrome'));
  assert.throws(() => sleightPluginLaunch({ ...plan, mcpConfig: { mcpServers: { ...plan.mcpConfig.mcpServers, foreign: {} } } }), /Unexpected/);
  assert.throws(() => sleightPluginLaunch({ ...plan, mcpConfig: { mcpServers: {} } }), /Unexpected/);
  assert.throws(() => sleightPluginLaunch({ ...plan, args: [] }), /requires its plugin/);
  assert.throws(() => sleightPluginLaunch({ ...plan, args: [...plan.args, '--setting-sources', 'user'] }), /empty setting sources/);
});
function checkLaunch(plan, servers) {
  assert.equal(plan.args.includes('--strict-mcp-config'), false, 'strict mode refuses the mod connection');
  assert.equal(plan.args[plan.args.indexOf('--setting-sources') + 1], '');
  assert.equal(plan.args[plan.args.indexOf('--plugin-dir') + 1], join(repo, 'plugins/sleight'));
  assert.deepEqual(plan.settingsOverrides.allowedMcpServers, servers.map(serverName => ({ serverName })));
  assert.equal(plan.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.deepEqual(Object.keys(plan.mcpConfig.mcpServers).sort(), [...servers].sort());
  assert.equal(plan.mcpConfig.mcpServers[own].command, join(repo, 'plugins/sleight/bin/sleight-mcp'));
}

for (const browser of ['firefox', 'safari', 'chrome', 'helium']) test(`${browser} launch permits the mod and only its arm servers`, () => {
  const surface = ['chrome', 'helium'].includes(browser) ? 'sleight-turbo' : 'sleight';
  const plan = realAgentSetup({ task, surface, repo, dir: join(tmpdir(), 'bm1-plan'),
    realBrowser: { browser, marker: 'Sleight Gate fixture', pid: 123, profileRoot: '/fixture/profile' } });
  checkLaunch(plan, surface === 'sleight' ? [own] : [own, 'sleight-turbo']);
});

test('the rounds.sh patch isolates plugin launches for plain, combined and turbo surfaces', async t => {
  const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
  if (!existsSync(join(cache, '.git'))) { t.skip('pinned FowlBrowser cache is absent'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'bm1-fowl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'tools'));
  const original = spawnSync('/usr/bin/git', ['-C', cache, 'show', '6a12d60:tools/rounds.mjs'], { encoding: 'utf8' });
  assert.equal(original.status, 0, original.stderr);
  const file = join(dir, 'tools/rounds.mjs');
  writeFileSync(file, original.stdout);
  const applied = spawnSync('/usr/bin/git', ['apply', join(repo, 'bench/fowl/sleight-surface.patch')], { cwd: dir, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  const before = process.env.SLEIGHT_REPO;
  process.env.SLEIGHT_REPO = repo;
  t.after(() => { if (before === undefined) delete process.env.SLEIGHT_REPO; else process.env.SLEIGHT_REPO = before; });
  const { agentSetup, roundSettings } = await import(pathToFileURL(file));
  for (const world of [false, true]) for (const surface of ['sleight', 'fowl+sleight', 'sleight-turbo']) {
    const plan = agentSetup({ task, surface, dir: join(dir, surface), mcpRoot: '/fixture/fowl', settings: join(dir, 'settings.json'), model: 'haiku', effort: 'high', world });
    checkLaunch(plan, surface === 'sleight' ? [own] : surface === 'fowl+sleight' ? ['fowlbrowser', own] : [own, 'sleight-turbo']);
  }
  const other = agentSetup({ task, surface: 'fowlbrowser', dir, mcpRoot: '/fixture/fowl', settings: join(dir, 'settings.json'), model: 'haiku', effort: 'high' });
  assert.ok(other.args.includes('--strict-mcp-config'));
  // Exercise the production writer up to its first run bookkeeping, before any spawn or timer.
  const source = readFileSync(file, 'utf8'), start = source.indexOf('function runAgentBody(');
  const writer = source.slice(start, source.indexOf('  const run =', start)) + '}';
  let generated;
  const prepare = runInNewContext(`(${writer})`, { fs, path, remote: null, BROWSER_ARMS: [], roundSettings,
    verifyWorldAgents() {}, agentSetup: options => (generated = agentSetup(options)) });
  for (const world of [false, true]) for (const surface of ['sleight', 'fowl+sleight', 'sleight-turbo']) {
    const out = join(dir, `written-${surface}-${world}`);
    prepare(task, out, { surface, world, model: 'haiku', effort: 'high', mcpRoot: '/fixture/fowl', versionVerified: true });
    const settings = JSON.parse(readFileSync(generated.args[generated.args.indexOf('--settings') + 1], 'utf8'));
    assert.deepEqual(settings.allowedMcpServers, generated.settingsOverrides.allowedMcpServers);
    assert.ok(settings.hooks.Stop.length > 0, 'the round Stop hook survives settings overrides');
    const config = JSON.parse(readFileSync(join(out, task.name, 'mcp.json'), 'utf8'));
    assert.deepEqual(config, generated.mcpConfig);
  }
  const manifest = JSON.parse(readFileSync(join(repo, 'plugins/sleight/.claude-plugin/plugin.json')));
  assert.equal(manifest.mcpServers.computer.command, '${CLAUDE_PLUGIN_ROOT}/bin/sleight-mcp');

  // Execute the patched round body with a fake child, including split stream chunks and collection.
  const body = source.slice(start, source.indexOf('\n// --- Reports ---', start));
  for (const catalog of [null, [own], [own, 'foreign']]) {
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter(); fake.stderr = new EventEmitter();
    const messages = [...(catalog ? [{ type: 'system', subtype: 'init', mcp_servers: catalog.map(name => ({ name, status: 'connected' })) }] : []),
      { type: 'result', result: 'RESULT: fixture' }];
    fake.stdin = { end() {}, write() { queueMicrotask(() => {
      const wire = messages.map(event => JSON.stringify(event) + '\n').join('');
      fake.stdout.emit('data', wire.slice(0, 17)); fake.stdout.emit('data', wire.slice(17)); fake.emit('close', 0);
    }); } };
    const runBody = runInNewContext(`(${body})`, { fs: { ...fs, createWriteStream: () => ({ write() {}, end() {} }) }, path,
      remote: null, BROWSER_ARMS: [], roundSettings, agentSetup: options => agentSetup(options),
      verifyWorldAgents() {}, startAgent: () => ({ child: fake, kill: () => assert.fail('fake child must not be signaled') }),
      finishAgent: async run => { run.inventoryErrors = ['existing inventory failure']; },
      require: file => { assert.equal(file, join(repo, 'bench/mcp-catalog.mjs')); return { sleightInitProblems }; },
      SLEIGHT_REPO: repo, process: { env: {} }, setTimeout: () => 1, clearTimeout() {}, Date });
    const out = join(dir, `catalog-${catalog?.join('-') ?? 'missing'}`);
    const run = await runBody(task, out, { surface: 'sleight', model: 'haiku', effort: 'high', mcpRoot: '/fixture/fowl' });
    assert.equal(run.inventoryErrors[0], 'existing inventory failure');
    assert.equal(run.inventoryErrors.length, catalog?.length === 1 ? 1 : 2);
    if (!catalog) assert.match(run.inventoryErrors[1], /received 0/);
    if (catalog?.length === 2) assert.match(run.inventoryErrors[1], /also loads foreign/);
    const saved = JSON.parse(readFileSync(join(out, task.name, 'run.json')));
    assert.deepEqual(saved.inventoryErrors, Array.from(run.inventoryErrors));
  }
});
