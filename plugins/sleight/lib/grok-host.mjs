// Read only host configuration and plugin metadata. Never inspect credentials or start a model session.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const GROK_INSTALL = 'grok plugin marketplace add Land-o-Clusters/sleight && grok plugin install sleight --trust';

export function grokStatus({ home = homedir(), env = process.env, read = path => readFileSync(path, 'utf8'), list = readdirSync,
  version = () => execFileSync('grok', ['--version'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }) } = {}) {
  const dir = env.GROK_HOME || join(home, '.grok');
  const tilde = path => path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
  const json = path => { try { return JSON.parse(read(path)); } catch { return undefined; } };
  let release, config = '', configError;
  try { release = /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(version())?.[1]; } catch {}
  try { config = read(join(dir, 'config.toml')); } catch (err) { if (err.code && err.code !== 'ENOENT') configError = err.message; }
  let table, server, importing = true;
  const servers = new Map();
  for (const line of config.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1].trim();
      server = /^mcp_servers\.(?:"([^"]+)"|([\w-]+))$/.exec(table)?.slice(1).find(Boolean);
      continue;
    }
    if (table === 'compat.claude' && /^\s*enabled\s*=\s*false\s*(?:#.*)?$/.test(line)) importing = false;
    const command = /^\s*command\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/.exec(line)?.[1];
    if (server && command && basename(command) === 'sleight-mcp') servers.set(server, tilde(command));
  }
  const local = [];
  try {
    for (const name of list(join(dir, 'plugins'))) {
      const path = join(dir, 'plugins', name);
      if (json(join(path, '.claude-plugin/plugin.json'))?.name === 'sleight') local.push(tilde(path));
    }
  } catch {}
  const installed = Object.values(json(join(dir, 'installed-plugins/registry.json'))?.repos ?? {})
    .filter(entry => entry?.plugins?.sleight).map(entry => ({ path: tilde(entry.path ?? dir), version: entry.plugins.sleight.version }));
  const cached = Object.entries(json(join(home, '.claude/plugins/installed_plugins.json'))?.plugins ?? {})
    .filter(([id]) => id.split('@')[0] === 'sleight').flatMap(([, entries]) => Array.isArray(entries) ? entries : []);
  const imports = [];
  for (const [market, entry] of Object.entries(json(join(home, '.claude/plugins/known_marketplaces.json')) ?? {})) {
    if (typeof entry?.installLocation !== 'string') continue;
    const root = entry.installLocation;
    const plugins = json(join(root, '.claude-plugin/marketplace.json'))?.plugins;
    for (const plugin of Array.isArray(plugins) ? plugins : []) {
      if (plugin.name !== 'sleight' || typeof plugin.source !== 'string' || !plugin.source.startsWith('./')) continue;
      const path = resolve(root, plugin.source);
      if (!path.startsWith(resolve(root) + '/')) continue;
      const manifest = json(join(path, '.claude-plugin/plugin.json'));
      imports.push({ market, path: tilde(path), version: manifest?.version });
    }
  }
  return { version: release, installed: !!release || !!config, configError, configPath: tilde(join(dir, 'config.toml')),
    importing, mcp: [...servers].map(([name, command]) => ({ name, command })), local, native: installed,
    imports, cachedVersions: [...new Set(cached.map(entry => entry.version).filter(v => typeof v === 'string'))] };
}

export function grokDoctorLines(status) {
  const lines = [`Grok CLI${status.version ? ` ${status.version}` : ''}`];
  if (!status.installed) return [...lines, `note      Grok CLI isn't installed. To add sleight after installing Grok: ${GROK_INSTALL}`];
  if (status.configError) lines.push(`PROBLEM   could not read ${status.configPath} (${status.configError})`);
  for (const { name, command } of status.mcp) lines.push(`ok        MCP entry "${name}" in ${status.configPath}: ${command}`);
  for (const path of status.local) lines.push(`note      local Grok plugin at ${path}`);
  for (const entry of status.native) lines.push(`note      Grok installed sleight ${entry.version ?? '(version unknown)'} at ${entry.path}. Check grok inspect --json for the copy actually loaded.`);
  if (!status.importing) lines.push('note      Claude import is off ([compat.claude] enabled = false).');
  else for (const entry of status.imports) {
    lines.push(`note      Claude marketplace import (${entry.market}): sleight ${entry.version ?? '(version unknown)'} at ${entry.path}, while [compat.claude] is on (the default).`);
    if (entry.version && status.cachedVersions.some(v => v !== entry.version)) lines.push(
      `PROBLEM   Grok's import and Claude Code run different copies: Grok ${entry.version}, Claude Code cache ${status.cachedVersions.join(', ')}. Update both and reconnect.`);
  }
  if (!status.mcp.length && !status.local.length && !status.native.length && !(status.importing && status.imports.length)) lines.push(`note      No sleight route found. To install: ${GROK_INSTALL}`);
  lines.push('note      Grok turbo is off in 1.4.0: no trusted user-turn binding. Grok Bot.app uses sleight-mcp js through its local shell.');
  return lines;
}
