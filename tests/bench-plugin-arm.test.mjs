import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const api = await import('../bench/plugin-arm.mjs').catch(() => ({}));

for (const kind of ['plugin', 'mcp']) test(`${kind} dry preparation reads provenance without creating its arm folder`, t => {
  const f = fixture(t);
  const arm = api.prepareGenericArm(`${kind}:rival`, { ...f, dryRun: true,
    env: { PLUGIN_ARM_RIVAL_DIR: f.plugin, MCP_ARM_RIVAL_CONFIG: f.config } });
  assert.equal(existsSync(arm.cwd), false);
  assert.ok(arm.identity.packageHash);
});

function preparedServer(arm) {
  return Object.values(JSON.parse(readFileSync(arm.args[arm.args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers)[0];
}

test('generic children receive only runtime basics and declared variables, before any loader executes', t => {
  const f = fixture(t), marker = join(f.bank, 'ambient-loader-ran');
  writeFileSync(join(f.bank, 'loader.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unsafe');`);
  writeFileSync(join(f.bank, 'server.mjs'), 'console.log(JSON.stringify(process.env));');
  const inherited = { PATH: '/usr/bin:/bin', HOME: f.bank, TMPDIR: f.bank, LANG: 'C', __CF_USER_TEXT_ENCODING: 'ambient-sentinel',
    ANTHROPIC_API_KEY: 'synthetic-api', ANTHROPIC_AUTH_TOKEN: 'synthetic-auth', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth',
    SLEIGHT_TRACE: '/ambient-trace', SLEIGHT_SURFACES: 'browser', NODE_OPTIONS: `--import=${join(f.bank, 'loader.mjs')}` };
  for (const kind of ['plugin', 'mcp']) {
    const server = { command: process.execPath, args: [join(f.bank, 'server.mjs')], env: { OWN_SETTING: 'declared' } };
    writeFileSync(f.config, JSON.stringify({ mcpServers: { rival: server } }));
    writeFileSync(join(f.plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'rival', version: '1', mcpServers: { computer: server } }));
    const arm = api.prepareGenericArm(`${kind}:rival`, { ...f, env: { ...inherited, PLUGIN_ARM_RIVAL_DIR: f.plugin, MCP_ARM_RIVAL_CONFIG: f.config } });
    const prepared = preparedServer(arm);
    const observed = JSON.parse(execFileSync(prepared.command, prepared.args, { encoding: 'utf8', cwd: arm.cwd, env: { ...inherited, ...prepared.env } }));
    assert.notEqual(observed.__CF_USER_TEXT_ENCODING, 'ambient-sentinel');
    delete observed.__CF_USER_TEXT_ENCODING; // macOS may recreate this value during process startup.
    assert.deepEqual(observed, { PATH: inherited.PATH, HOME: f.bank, TMPDIR: f.bank, LANG: 'C', OWN_SETTING: 'declared' });
    assert.equal(existsSync(marker), false, 'ambient Node loader must never execute');
  }
});

test('generic config refuses ambient interpolation and keeps quoted plugin roots as literal data', t => {
  const f = fixture(t);
  for (const value of [{ env: { OWN: '${ANTHROPIC_API_KEY}' } }, { command: '${MCP_EXECUTABLE}' }, { args: ['${HOME}/entry'] }]) {
    writeFileSync(f.config, JSON.stringify({ mcpServers: { rival: { command: process.execPath, ...value } } }));
    assert.throws(() => api.prepareGenericArm('mcp:rival', { ...f, env: { MCP_ARM_RIVAL_CONFIG: f.config } }), /interpolation|absolute paths/);
  }
  const plugin = join(f.bank, 'plugin-"quoted\\root');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(join(f.bank, 'server.mjs'), 'console.log(process.env.OWN_ROOT);');
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'rival', version: '1', mcpServers: {
    computer: { command: process.execPath, args: [join(f.bank, 'server.mjs')], env: { OWN_ROOT: '${CLAUDE_PLUGIN_ROOT}' } },
  } }));
  const arm = api.prepareGenericArm('plugin:rival', { ...f, env: { PLUGIN_ARM_RIVAL_DIR: plugin } });
  const server = preparedServer(arm);
  assert.equal(execFileSync(server.command, server.args, { encoding: 'utf8' }).trim(), plugin);
});

test('plugins declaring hooks or automatic module hooks refuse before launch', t => {
  const f = fixture(t), file = join(f.plugin, '.claude-plugin/plugin.json');
  const original = JSON.parse(readFileSync(file, 'utf8'));
  for (const hooks of [{}, './custom-hooks.json', ['./custom-hooks.json'], null]) {
    writeFileSync(file, JSON.stringify({ ...original, hooks }));
    assert.throws(() => api.prepareGenericArm('plugin:rival', { ...f, env: { PLUGIN_ARM_RIVAL_DIR: f.plugin } }), /plugin hooks.*unsupported/);
  }
  writeFileSync(file, JSON.stringify(original));
  mkdirSync(join(f.plugin, 'hooks'));
  writeFileSync(join(f.plugin, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.tsx'] }));
  assert.throws(() => api.prepareGenericArm('plugin:rival', { ...f, env: { PLUGIN_ARM_RIVAL_DIR: f.plugin } }), /plugin hooks.*unsupported/);
});

test('plugins declaring LSP servers or agents refuse before launch in every load form', t => {
  const f = fixture(t), file = join(f.plugin, '.claude-plugin/plugin.json');
  const original = JSON.parse(readFileSync(file, 'utf8'));
  for (const field of ['lspServers', 'agents']) for (const value of [{}, './custom.json', ['./custom.json'], null]) {
    writeFileSync(file, JSON.stringify({ ...original, [field]: value }));
    assert.throws(() => api.prepareGenericArm('plugin:rival', { ...f, env: { PLUGIN_ARM_RIVAL_DIR: f.plugin } }), /plugin (?:LSP servers|agents).*unsupported/);
  }
  writeFileSync(file, JSON.stringify(original));
  writeFileSync(join(f.plugin, '.lsp.json'), '{}');
  assert.throws(() => api.prepareGenericArm('plugin:rival', { ...f, env: { PLUGIN_ARM_RIVAL_DIR: f.plugin } }), /plugin LSP servers.*unsupported/);
  rmSync(join(f.plugin, '.lsp.json'));
  mkdirSync(join(f.plugin, 'agents/nested'), { recursive: true });
  writeFileSync(join(f.plugin, 'agents/nested/worker.md'), '---\nname: worker\ntools: Bash\n---\nRun commands.');
  assert.throws(() => api.prepareGenericArm('plugin:rival', { ...f, env: { PLUGIN_ARM_RIVAL_DIR: f.plugin } }), /plugin agents.*unsupported/);
});

test('plugin settings cannot select an agent or install an agent status command', t => {
  const f = fixture(t), file = join(f.plugin, '.claude-plugin/plugin.json');
  const original = JSON.parse(readFileSync(file, 'utf8'));
  for (const settings of [{ agent: 'remote-worker' }, { subagentStatusLine: { type: 'command', command: 'unsafe' } }]) {
    writeFileSync(file, JSON.stringify({ ...original, settings }));
    assert.throws(() => api.prepareGenericArm('plugin:rival', { ...f, env: { PLUGIN_ARM_RIVAL_DIR: f.plugin } }), /plugin agent settings.*unsupported/);
    writeFileSync(file, JSON.stringify(original));
    writeFileSync(join(f.plugin, 'settings.json'), JSON.stringify(settings));
    assert.throws(() => api.prepareGenericArm('plugin:rival', { ...f, env: { PLUGIN_ARM_RIVAL_DIR: f.plugin } }), /plugin agent settings.*unsupported/);
    rmSync(join(f.plugin, 'settings.json'));
  }
});

test('provenance reads a commit without executing a source repository fsmonitor', t => {
  const f = fixture(t), marker = join(f.bank, 'fsmonitor-ran'), hook = join(f.bank, 'fsmonitor');
  execFileSync('/usr/bin/git', ['init', '-q', f.plugin]);
  execFileSync('/usr/bin/git', ['-C', f.plugin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  execFileSync('/usr/bin/git', ['-C', f.plugin, 'config', 'core.fsmonitor', hook]);
  const arm = api.prepareGenericArm('plugin:rival', { ...f, env: { PLUGIN_ARM_RIVAL_DIR: f.plugin } });
  assert.match(arm.identity.commit, /^[a-f0-9]{40}$/);
  assert.equal(existsSync(marker), false);
  assert.equal('dirty' in arm.identity, false);
});

test('plugin MCP file and automatic config forms keep declared server variables', t => {
  const f = fixture(t), file = join(f.plugin, '.claude-plugin/plugin.json');
  writeFileSync(join(f.bank, 'server.mjs'), 'console.log(process.env.OWN_SETTING);');
  const config = { mcpServers: { computer: { command: process.execPath, args: [join(f.bank, 'server.mjs')], env: { OWN_SETTING: 'declared' } } } };
  for (const mcpServers of ['./external.json', undefined]) {
    writeFileSync(join(f.plugin, mcpServers ? 'external.json' : '.mcp.json'), JSON.stringify(config));
    writeFileSync(file, JSON.stringify({ name: 'rival', version: '1', mcpServers }));
    const server = preparedServer(api.prepareGenericArm('plugin:rival', { ...f, env: { PLUGIN_ARM_RIVAL_DIR: f.plugin } }));
    assert.equal(execFileSync(server.command, server.args, { encoding: 'utf8', env: server.env }).trim(), 'declared');
  }
});

function fixture(t) {
  const bank = realpathSync(mkdtempSync(join(tmpdir(), 'bench-plugin-arm-test-')));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const plugin = join(bank, 'plugin');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'rival', version: '2.3.4',
    mcpServers: { computer: { command: process.execPath, args: [join(bank, 'server.mjs')] } } }));
  writeFileSync(join(bank, 'server.mjs'), '// installed server\n');
  const config = join(bank, 'mcp.json');
  writeFileSync(config, JSON.stringify({ mcpServers: { rival: { command: process.execPath, args: [join(bank, 'server.mjs')] } } }));
  return { bank, plugin, config, root: bank, armHome: join(bank, 'arms') };
}

test('plugin and MCP commands load only the selected source and discovered tools', t => {
  assert.equal(typeof api.prepareGenericArm, 'function');
  const f = fixture(t);
  for (const [name, env, server, sourceFlag, source] of [
    ['plugin:rival', { PLUGIN_ARM_RIVAL_DIR: f.plugin }, 'plugin:rival:computer', '--plugin-dir', f.plugin],
    ['mcp:sleight-plain', { MCP_ARM_SLEIGHT_PLAIN_CONFIG: f.config }, 'rival', '--mcp-config', f.config],
  ]) {
    const arm = api.prepareGenericArm(name, { ...f, env });
    const tool = server.startsWith('plugin:') ? 'mcp__plugin_rival_computer__click' : 'mcp__rival__click';
    api.acceptGenericCatalog(arm, { servers: [{ name: server, status: 'connected' }], tools: [tool] });
    if (name.startsWith('plugin:')) assert.equal(arm.args[arm.args.indexOf(sourceFlag) + 1], source);
    else assert.equal(arm.identity.source, source);
    assert.ok(arm.args.includes('--strict-mcp-config'));
    assert.equal(arm.args[arm.args.indexOf('--setting-sources') + 1], '');
    assert.equal(arm.args[arm.args.indexOf('--allowedTools') + 1], tool);
    assert.equal(arm.args[arm.args.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(arm.args[arm.args.indexOf('--tools') + 1], '');
    assert.ok(arm.cwd.startsWith(join(f.bank, 'arms')));
    assert.equal(arm.identity.packageHash.length, 64);
    if (name.startsWith('plugin:')) {
      const config = JSON.parse(readFileSync(arm.args[arm.args.indexOf('--mcp-config') + 1], 'utf8'));
      assert.ok(config.mcpServers['plugin:rival:computer']);
    }
  }
});

test('catalog rejects foreign servers, foreign tools, missing tools and disconnected servers', t => {
  const f = fixture(t);
  for (const catalog of [
    { servers: [{ name: 'rival', status: 'connected' }, { name: 'leak', status: 'connected' }], tools: ['mcp__rival__click'] },
    { servers: [{ name: 'rival', status: 'connected' }], tools: ['mcp__rival__click', 'mcp__leak__js'] },
    { servers: [{ name: 'rival', status: 'connected' }], tools: [] },
    { servers: [{ name: 'rival', status: 'failed' }], tools: ['mcp__rival__click'] },
  ]) {
    const arm = api.prepareGenericArm('mcp:rival', { ...f, env: { MCP_ARM_RIVAL_CONFIG: f.config } });
    assert.throws(() => api.acceptGenericCatalog(arm, catalog), /tool|server|connected/);
  }
});

test('catalog preserves hyphens in Claude Code MCP tool names', t => {
  const f = fixture(t);
  writeFileSync(f.config, JSON.stringify({ mcpServers: { 'sleight-plain': { command: process.execPath } } }));
  const arm = api.prepareGenericArm('mcp:sleight-plain', { ...f, env: { MCP_ARM_SLEIGHT_PLAIN_CONFIG: f.config } });
  assert.doesNotThrow(() => api.acceptGenericCatalog(arm, { servers: [{ name: 'sleight-plain', status: 'connected' }], tools: ['mcp__sleight-plain__js'] }));
  assert.equal(arm.args.at(-1), 'mcp__sleight-plain__js');
});

test('provenance changes when local plugin or server bytes change and omits config secrets', t => {
  const f = fixture(t);
  const options = { ...f, env: { PLUGIN_ARM_RIVAL_DIR: f.plugin, MCP_ARM_RIVAL_CONFIG: f.config } };
  const before = api.prepareGenericArm('plugin:rival', options).identity;
  assert.equal(before.name, 'rival'); assert.equal(before.version, '2.3.4');
  writeFileSync(join(f.plugin, 'code.mjs'), '// new code\n');
  assert.notEqual(api.prepareGenericArm('plugin:rival', options).identity.packageHash, before.packageHash);
  const mcp = api.prepareGenericArm('mcp:rival', options).identity;
  writeFileSync(join(f.bank, 'server.mjs'), '// changed server\n');
  assert.notEqual(api.prepareGenericArm('mcp:rival', options).identity.packageHash, mcp.packageHash);
  writeFileSync(f.config, JSON.stringify({ mcpServers: { rival: { command: process.execPath, env: { SECRET: 'private-value' } } } }));
  assert.equal(JSON.stringify(api.prepareGenericArm('mcp:rival', options).identity).includes('private-value'), false);
});

test('generic settings bind elicitation to this arm and stop other approval mechanisms', t => {
  const f = fixture(t);
  const arm = api.prepareGenericArm('mcp:rival', { ...f, env: { MCP_ARM_RIVAL_CONFIG: f.config } });
  const settings = api.genericSettings(arm, f.root);
  assert.equal(settings.hooks.Elicitation[0].matcher, '^rival$');
  assert.ok(settings.hooks.PermissionRequest);
});

test('provenance covers dependencies, build output and external plugin servers', t => {
  const f = fixture(t);
  const options = { ...f, env: { PLUGIN_ARM_RIVAL_DIR: f.plugin } };
  for (const file of [join(f.plugin, 'node_modules/dependency/index.js'), join(f.plugin, '.build/helper'), join(f.bank, 'server.mjs')]) {
    const before = api.prepareGenericArm('plugin:rival', options).identity.packageHash;
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '// changed runtime bytes');
    assert.notEqual(api.prepareGenericArm('plugin:rival', options).identity.packageHash, before);
  }
});

test('unidentified remote servers and installer commands stop before discovery', t => {
  const f = fixture(t);
  for (const server of [{ url: 'https://example.test/mcp' }, { command: 'npx', args: ['rival'] }]) {
    writeFileSync(f.config, JSON.stringify({ mcpServers: { rival: server } }));
    assert.throws(() => api.prepareGenericArm('mcp:rival', { ...f, env: { MCP_ARM_RIVAL_CONFIG: f.config } }), /local|installed|installer/);
  }
});

test('an arm home inside a git repository is rejected before writing configuration', t => {
  const f = fixture(t);
  execFileSync('/usr/bin/git', ['init', '-q', f.bank]);
  assert.throws(() => api.prepareGenericArm('plugin:rival', { ...f, env: { PLUGIN_ARM_RIVAL_DIR: f.plugin } }), /outside.*git/);
});

test('Python package siblings and virtualenv dependencies are part of provenance', t => {
  const f = fixture(t), pythonPackage = join(f.bank, 'python-server');
  mkdirSync(join(pythonPackage, 'venv/bin'), { recursive: true });
  mkdirSync(join(pythonPackage, 'venv/lib/site-packages'), { recursive: true });
  writeFileSync(join(pythonPackage, 'pyproject.toml'), '[project]\nname="rival"\nversion="1.0"\n');
  writeFileSync(join(pythonPackage, 'venv/pyvenv.cfg'), 'home = /python\n');
  writeFileSync(join(pythonPackage, 'venv/bin/rival'), '#!/python\nimport rival\n');
  writeFileSync(f.config, JSON.stringify({ mcpServers: { rival: { command: join(pythonPackage, 'venv/bin/rival') } } }));
  const options = { ...f, env: { MCP_ARM_RIVAL_CONFIG: f.config } };
  const before = api.prepareGenericArm('mcp:rival', options).identity.packageHash;
  writeFileSync(join(pythonPackage, 'venv/lib/site-packages/rival.py'), '# dependency changed\n');
  assert.notEqual(api.prepareGenericArm('mcp:rival', options).identity.packageHash, before);
});

test('a virtualenv interpreter keeps its invocation path while its real target is hashed', t => {
  const f = fixture(t), venv = join(f.bank, 'venv');
  mkdirSync(join(venv, 'bin'), { recursive: true });
  writeFileSync(join(venv, 'pyvenv.cfg'), 'home = /python\n');
  const interpreter = join(venv, 'bin/python');
  symlinkSync(process.execPath, interpreter);
  writeFileSync(f.config, JSON.stringify({ mcpServers: { rival: { command: interpreter, args: [join(f.bank, 'server.mjs')] } } }));
  const arm = api.prepareGenericArm('mcp:rival', { ...f, env: { MCP_ARM_RIVAL_CONFIG: f.config } });
  const prepared = JSON.parse(readFileSync(arm.args[arm.args.indexOf('--mcp-config') + 1], 'utf8'));
  const descriptor = JSON.parse(readFileSync(prepared.mcpServers.rival.args.at(-1), 'utf8'));
  assert.equal(descriptor.command, interpreter);
  assert.ok(arm.identity.servers.rival.artifacts.some(artifact => artifact.source === realpathSync(process.execPath)));
});

test('arm names and missing configuration fail before launching a driver', t => {
  const f = fixture(t);
  assert.throws(() => api.prepareGenericArm('mcp:../rival', { ...f, env: {} }), /arm/);
  assert.throws(() => api.prepareGenericArm('plugin:rival', { ...f, env: {} }), /PLUGIN_ARM_RIVAL_DIR/);
  assert.throws(() => api.prepareGenericArm('mcp:rival', { ...f, env: {} }), /MCP_ARM_RIVAL_CONFIG/);
});

test('elicitation approves only supported forms for the selected server and benchmark apps', t => {
  const f = fixture(t);
  const stop = join(f.bank, 'stop');
  const call = extra => JSON.parse(execFileSync(process.execPath, ['bench/approve.mjs'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, BENCH_ARM_SERVERS: '["rival"]', BENCH_APPROVAL_STOP: stop, BENCH_SUITE: 'default' },
    input: JSON.stringify({ mcp_server_name: 'rival', message: 'Allow Computer Use to use "Calculator"?', ...extra }),
  })).hookSpecificOutput;
  assert.equal(call({}).action, 'accept');
  assert.deepEqual(call({ requested_schema: { properties: { choice: { enum: ['always', 'session', 'decline'] } } } }).content, { choice: 'session' });
  for (const extra of [
    { mcp_server_name: 'foreign' }, { message: 'Allow Computer Use to use "ChatGPT"?' },
    { mode: 'url' }, { requested_schema: { properties: { choice: { enum: ['always', 'decline'] } } } },
    { requested_schema: { required: ['grant'], properties: { grant: { type: 'boolean' } } } },
  ]) {
    assert.equal(call(extra).action, 'decline');
    assert.match(readFileSync(stop, 'utf8'), /unsupported approval/);
  }
});
