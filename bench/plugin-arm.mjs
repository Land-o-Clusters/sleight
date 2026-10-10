import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
const ignored = new Set(['.git']);

function packageHash(path) {
  const hash = createHash('sha256');
  const walk = (file, label, ancestors = new Set()) => {
    const real = realpathSync(file);
    if (ancestors.has(real)) throw new Error('cyclic package symlink');
    const info = statSync(real);
    hash.update(JSON.stringify([label, info.isDirectory() ? 'directory' : 'file', info.mode]));
    if (info.isDirectory()) {
      for (const name of readdirSync(real).sort()) if (!ignored.has(name)) walk(join(real, name), `${label}/${name}`, new Set([...ancestors, real]));
    } else if (info.isFile()) hash.update(digest(readFileSync(real)));
    else throw new Error('package contains a non-file entry');
  };
  walk(path, '.');
  return hash.digest('hex');
}

function sourceIdentity(path) {
  let commit;
  try {
    const cwd = statSync(path).isDirectory() ? path : dirname(path);
    commit = execFileSync('/usr/bin/git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {}
  return { source: path, commit, packageHash: packageHash(path) };
}

function serverConfig(value, pluginRoot) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP server requires a stdio configuration');
  if (Object.keys(value).some(key => !['command', 'args', 'env', 'type'].includes(key)) || (value.type && value.type !== 'stdio')) {
    throw new Error('only installed local stdio command, args and env are supported');
  }
  const literal = text => {
    if (typeof text !== 'string') throw new Error('MCP command, arguments and environment must be strings');
    const expanded = pluginRoot ? text.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot) : text;
    if (expanded.includes('${')) throw new Error('ambient environment interpolation is unsupported');
    return expanded;
  };
  if (value.args !== undefined && !Array.isArray(value.args)) throw new Error('MCP args must be an array');
  if (value.env !== undefined && (!value.env || typeof value.env !== 'object' || Array.isArray(value.env))) throw new Error('MCP env must be an object');
  const env = Object.fromEntries(Object.entries(value.env ?? {}).map(([key, text]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('invalid MCP environment variable name');
    return [key, literal(text)];
  }));
  return { command: literal(value.command), args: (value.args ?? []).map(literal), env };
}

function isolatedServer(config, executable, cwd, index, inherited) {
  const env = { ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(key => typeof inherited[key] === 'string').map(key => [key, inherited[key]])), ...config.env };
  const descriptor = join(cwd, `server-${index}.json`);
  writeFileSync(descriptor, JSON.stringify({ command: executable, args: config.args, env }), { mode: 0o600 });
  // env -i runs before Node starts, so ambient NODE_OPTIONS cannot execute in the launcher.
  return { command: '/usr/bin/env', args: ['-i', process.execPath, fileURLToPath(new URL('./generic-server.mjs', import.meta.url)), descriptor], env: {} };
}

// Resolve the installed artifact, without running an installer or exposing its environment.
function serverIdentity(config, configDir, env) {
  if (config.url) throw new Error('remote MCP identity cannot be verified; use an installed local stdio server');
  if (typeof config.command !== 'string') throw new Error('MCP server requires an installed local command');
  if (/^(npx|npm|pnpm|yarn|bunx|uvx|uv|pip|pip3)$/.test(basename(config.command))) throw new Error('installer commands are unsupported; configure the installed server executable');
  if ((config.args ?? []).some(arg => typeof arg !== 'string' || /\$\{|^(-e|-c|-p|-m|-|--eval|--print|--command)(=|$)/.test(arg))) throw new Error('configure installed local files with absolute paths, without inline code or module launchers');
  const command = config.command.includes('/') ? resolve(configDir, config.command) :
    (config.env?.PATH ?? env.PATH ?? process.env.PATH ?? '').split(delimiter).map(dir => join(dir, config.command)).find(path => existsSync(path));
  if (!command || !existsSync(command)) throw new Error(`MCP executable is not installed: ${config.command}`);
  if (/^(node|python[\d.]*|ruby|perl|bash|sh|zsh)$/.test(basename(config.command))) {
    const entry = config.args?.find(arg => !arg.startsWith('-'));
    if (entry && (!isAbsolute(entry) || !existsSync(entry))) throw new Error('interpreter entry scripts must be installed local files with absolute paths');
  }
  const files = [realpathSync(command), ...(config.args ?? []).filter(arg => typeof arg === 'string' && isAbsolute(arg) && existsSync(arg))];
  const venv = dirname(dirname(command));
  if (existsSync(join(venv, 'pyvenv.cfg'))) files.push(venv);
  const artifacts = files.map(file => {
    let path = file, metadata;
    for (let dir = statSync(file).isDirectory() ? file : dirname(file); dirname(dir) !== dir; dir = dirname(dir)) {
      const manifest = [join(dir, '.claude-plugin/plugin.json'), join(dir, 'package.json')].find(existsSync);
      if (manifest) { metadata = readJSON(manifest); path = dir; break; }
      if (['pyproject.toml', 'setup.py', 'setup.cfg', 'pyvenv.cfg'].some(name => existsSync(join(dir, name)))) { path = dir; break; }
    }
    return { name: metadata?.name, version: metadata?.version, extent: statSync(path).isDirectory() ? 'package-directory' : 'entry-file', ...sourceIdentity(path) };
  });
  // Python selects its virtualenv from the invocation path, even when the
  // interpreter is a symlink. Hash the real bytes but retain that launch path.
  return { transport: 'stdio', artifacts, executable: resolve(command) };
}

function outsideGit(path) {
  let existing = resolve(path);
  while (!existsSync(existing)) existing = dirname(existing);
  let repo;
  try { repo = execFileSync('/usr/bin/git', ['-C', realpathSync(existing), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  if (repo) throw new Error('generic arm folders must be outside any git repository');
}

export function prepareGenericArm(name, { root, armHome, env = process.env }) {
  const match = /^(plugin|mcp):([a-z0-9][a-z0-9_-]*)$/.exec(name);
  if (!match) throw new Error(`invalid generic arm ${name}`);
  const [, kind, label] = match;
  const variable = `${kind.toUpperCase()}_ARM_${label.toUpperCase().replaceAll('-', '_')}_${kind === 'plugin' ? 'DIR' : 'CONFIG'}`;
  if (!env[variable]) throw new Error(`${name} requires ${variable}`);
  const source = realpathSync(resolve(env[variable]));
  const cwd = join(armHome, `${kind}-${label}-arm`);
  outsideGit(cwd);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  let servers, identity, sourceArgs;
  if (kind === 'plugin') {
    const manifest = readJSON(join(source, '.claude-plugin/plugin.json'));
    if (!/^[a-zA-Z0-9_-]+$/.test(manifest.name) || typeof manifest.version !== 'string') throw new Error('plugin manifest requires name and version');
    if (Object.hasOwn(manifest, 'hooks') || existsSync(join(source, 'hooks/hooks.json'))) throw new Error('plugin hooks are unsupported in benchmark arms');
    if (Object.hasOwn(manifest, 'lspServers') || existsSync(join(source, '.lsp.json'))) throw new Error('plugin LSP servers are unsupported in benchmark arms');
    if (Object.hasOwn(manifest, 'agents') || existsSync(join(source, 'agents'))) throw new Error('plugin agents are unsupported in benchmark arms');
    const settings = existsSync(join(source, 'settings.json')) ? readJSON(join(source, 'settings.json')) : {};
    if ([manifest.settings, settings].some(value => value && ['agent', 'subagentStatusLine'].some(key => Object.hasOwn(value, key)))) {
      throw new Error('plugin agent settings are unsupported in benchmark arms');
    }
    let config = manifest.mcpServers ?? (existsSync(join(source, '.mcp.json')) ? '.mcp.json' : undefined);
    if (typeof config === 'string') config = readJSON(resolve(source, config));
    config = config?.mcpServers ?? config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('plugin has no MCP servers');
    servers = Object.keys(config).map(server => `plugin:${manifest.name}:${server}`);
    // --strict-mcp-config also suppresses plugin MCP registrations in Claude Code.
    // Explicitly register this plugin's same qualified servers to retain isolation.
    const mcp = join(cwd, 'plugin-mcp.json');
    const expanded = Object.fromEntries(Object.entries(config).map(([server, value]) => [server, serverConfig(value, source)]));
    const artifacts = Object.fromEntries(Object.entries(expanded).map(([server, value]) => [server, serverIdentity(value, source, env)]));
    const plugin = sourceIdentity(source);
    identity = { kind, name: manifest.name, version: manifest.version, ...plugin,
      pluginHash: plugin.packageHash, packageHash: digest(JSON.stringify([plugin, artifacts])), servers: artifacts };
    writeFileSync(mcp, JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(expanded).map(([server, value], index) =>
      [`plugin:${manifest.name}:${server}`, isolatedServer(value, artifacts[server].executable, cwd, index, env)])) }), { mode: 0o600 });
    sourceArgs = ['--plugin-dir', source, '--mcp-config', mcp];
  } else {
    const config = readJSON(source);
    if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) throw new Error('config requires mcpServers');
    servers = Object.keys(config.mcpServers);
    const normalized = Object.fromEntries(servers.map(server => [server, serverConfig(config.mcpServers[server])]));
    const artifacts = Object.fromEntries(servers.map(server => [server, serverIdentity(normalized[server], dirname(source), env)]));
    identity = { kind, name: label, source, configHash: digest(readFileSync(source)), packageHash: digest(JSON.stringify(artifacts)), servers: artifacts };
    const mcp = join(cwd, 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: Object.fromEntries(servers.map((server, index) =>
      [server, isolatedServer(normalized[server], artifacts[server].executable, cwd, index, env)])) }), { mode: 0o600 });
    sourceArgs = ['--mcp-config', mcp];
  }
  if (!servers.length || servers.some(server => !/^[a-zA-Z0-9_:-]+$/.test(server))) throw new Error('arm has invalid or empty server names');
  return { generic: true, cwd, servers, identity, env: { BENCH_ARM_SERVERS: JSON.stringify(servers) },
    args: [...sourceArgs, '--strict-mcp-config', '--setting-sources', '', '--tools', '', '--disable-slash-commands',
      '--permission-prompts', 'none', '--no-session-persistence'] };
}

// Claude Code has already issued tools/list to each connected server before its init event.
// Use that returned catalog, including plugin-qualified names, rather than guessing tool names.
export function acceptGenericCatalog(arm, { servers = [], tools = [] }) {
  arm.identity.discovery = { servers: servers.map(({ name, status }) => ({ name, status })), tools };
  for (const name of arm.servers) if (servers.find(server => server.name === name)?.status !== 'connected') throw new Error(`${name} server is not connected`);
  if (servers.some(server => !arm.servers.includes(server.name))) throw new Error('generic arm loaded a foreign server');
  const prefixes = arm.servers.map(server => `mcp__${server.replaceAll(':', '_')}__`);
  const own = tools.filter(tool => prefixes.some(prefix => tool.startsWith(prefix)));
  if (tools.some(tool => tool.startsWith('mcp__') && !own.includes(tool))) throw new Error('generic arm loaded foreign tools');
  for (const prefix of prefixes) if (!own.some(tool => tool.startsWith(prefix))) throw new Error(`no tools/list catalog for ${prefix}`);
  arm.identity.tools = [...new Set(own)].sort();
  arm.args.push('--allowedTools', arm.identity.tools.join(','));
}

export function genericSettings(arm, root) {
  const command = script => `node "${join(root, 'bench', script)}"`;
  const matcher = `^(${arm.servers.map(server => server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
  return { enabledPlugins: { 'sleight@sleight': false }, hooks: {
    Elicitation: [{ matcher: arm.servers.length === 1 ? `^${arm.servers[0]}$` : matcher, hooks: [{ type: 'command', command: command('approve.mjs') }] }],
    PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: command('deny-approval.mjs') }] }],
  } };
}
