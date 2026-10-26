// Only the hosts' installed records nominate roots. Never search marketplace or cache directories for plugins.
import * as fs from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { loadCharacter, parseCharacterJSON } from './character.mjs';

const LIMITS = Object.freeze({ recordBytes: 1024 * 1024, plugins: 256, packs: 128, perPlugin: 32 });
const component = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value) && !value.includes('..');
const idValid = value => typeof value === 'string' && /^[a-z0-9-]{1,48}$/.test(value);
const plain = value => typeof value === 'string' && value.length > 0 && value.length <= 96 && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
function directory(path, uid) {
  if (!isAbsolute(path) || resolve(path) !== path || fs.realpathSync(path) !== path) throw Error('unsafe plugin path');
  const st = fs.lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || st.mode & 0o7022) throw Error('unsafe plugin directory');
}
function json(path, uid, cap = 16383) {
  if (fs.realpathSync(path) !== path) throw Error('linked plugin record');
  const before = fs.lstatSync(path), safe = st => st.isFile() && st.nlink === 1 && st.uid === uid && !(st.mode & 0o7022) && st.size <= cap;
  if (!safe(before)) throw Error('unsafe plugin record');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (!safe(opened) || before.dev !== opened.dev || before.ino !== opened.ino) throw Error('changed plugin record');
    const bytes = Buffer.alloc(opened.size + 1); let n = 0, count;
    do { count = fs.readSync(fd, bytes, n, bytes.length - n, n); n += count; } while (count && n < bytes.length);
    const after = fs.fstatSync(fd);
    if (n !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw Error('changed plugin record');
    return cap < 16384 ? parseCharacterJSON(bytes.subarray(0, n), path) : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n)));
  } finally { fs.closeSync(fd); }
}
function claudeInstalls({ home, env, uid, cwd }) {
  const config = isAbsolute(env.CLAUDE_CONFIG_DIR ?? '') ? env.CLAUDE_CONFIG_DIR : join(home, '.claude');
  const root = isAbsolute(env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? '') ? env.CLAUDE_CODE_PLUGIN_CACHE_DIR : join(config, 'plugins');
  let record;
  try { directory(root, uid); record = json(join(root, 'installed_plugins.json'), uid, LIMITS.recordBytes); } catch { return []; }
  let marketplaces;
  try { marketplaces = json(join(root, 'known_marketplaces.json'), uid, LIMITS.recordBytes); } catch {}
  const metadata = new Map();
  if (record?.version !== 2 || !record.plugins || Array.isArray(record.plugins) || typeof record.plugins !== 'object') return [];
  const entries = Object.entries(record.plugins); if (entries.length > LIMITS.plugins) return [];
  const result = [];
  for (const [pluginId, installs] of entries) {
    if (!plain(pluginId) || !Array.isArray(installs) || installs.length > LIMITS.plugins) continue;
    const eligible = installs.filter(i => i && typeof i.installPath === 'string' && (i.scope === 'user' ||
      ['project', 'local'].includes(i.scope) && isAbsolute(i.projectPath ?? '') && resolve(i.projectPath) === i.projectPath &&
      (cwd === i.projectPath || cwd.startsWith(i.projectPath + '/'))));
    const rank = i => i.scope === 'local' ? 2 : i.scope === 'project' ? 1 : 0;
    const best = Math.max(...eligible.map(rank));
    const paths = [...new Set(eligible.filter(i => rank(i) === best).map(i => i.installPath))];
    if (paths.length === 1) {
      const at = pluginId.lastIndexOf('@'), origin = pluginId.slice(at + 1), name = pluginId.slice(0, at);
      if (!metadata.has(origin)) {
        try {
          const folder = marketplaces?.[origin]?.installLocation; directory(folder, uid);
          const market = json(join(folder, '.claude-plugin/marketplace.json'), uid, LIMITS.recordBytes);
          metadata.set(origin, Array.isArray(market?.plugins) && market.plugins.length <= LIMITS.plugins ? market.plugins : []);
        } catch { metadata.set(origin, []); }
      }
      const entries = metadata.get(origin).filter(p => p?.name === name);
      result.push({ host: 'claude', pluginId, folder: paths[0], componentMetadata: entries.length === 1 ? entries[0] : null });
    }
  }
  return result;
}
// The CLI resolves layered config and the active install version. No availability scan or cache walk is used.
function listCodex({ home, env }) {
  return JSON.parse(execFileSync('codex', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 3000,
    maxBuffer: LIMITS.recordBytes, killSignal: 'SIGKILL', windowsHide: true,
    env: { ...process.env, ...env, CODEX_HOME: isAbsolute(env.CODEX_HOME ?? '') ? env.CODEX_HOME : join(home, '.codex') }, stdio: ['ignore', 'pipe', 'ignore'] }));
}
function codexInstalls(options) {
  let record;
  try { record = (options.codexList ?? listCodex)(options); } catch { return []; }
  if (!Array.isArray(record?.installed) || record.installed.length > LIMITS.plugins) return [];
  const root = isAbsolute(options.env.CODEX_HOME ?? '') ? options.env.CODEX_HOME : join(options.home, '.codex');
  return record.installed.flatMap(p => {
    if (p?.installed !== true || !component(p.name) || !component(p.marketplaceName) || !component(p.version) || p.pluginId !== `${p.name}@${p.marketplaceName}`) return [];
    const base = join(root, 'plugins/cache', p.marketplaceName, p.name);
    // Local installs use "local" on hosts that don't store the declared version as the cache key.
    const exact = join(base, p.version), folder = fs.existsSync(exact) ? exact : p.source?.source === 'local' ? join(base, 'local') : exact;
    return [{ host: 'codex', pluginId: p.pluginId, folder }];
  });
}
function pluginManifest(folder, host, uid) {
  const primary = host === 'claude' ? '.claude-plugin/plugin.json' : 'plugin.json';
  try { return json(join(folder, primary), uid); }
  catch (error) {
    if (host !== 'codex' || error.code !== 'ENOENT') throw error;
    return json(join(folder, '.codex-plugin/plugin.json'), uid);
  }
}
function extras(folder, manifest, uid, componentMetadata) {
  const kinds = new Set(), sources = [manifest, manifest?.extensions?.['com.openai'], componentMetadata];
  for (const path of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    try { sources.push(json(join(folder, path), uid)); } catch (error) { if (error.code !== 'ENOENT') kinds.add('unreadable metadata'); }
  }
  for (const source of sources) for (const [key, label] of [['hooks', 'hooks'], ['mcpServers', 'MCP servers'], ['commands', 'commands'],
    ['agents', 'agents'], ['skills', 'skills'], ['lspServers', 'LSP servers'], ['dependencies', 'dependencies'], ['workflows', 'workflows']]) {
    if (source && Object.hasOwn(source, key)) kinds.add(label);
  }
  for (const [name, label] of [['hooks', 'hooks'], ['.mcp.json', 'MCP servers'], ['mcp.json', 'MCP servers'], ['commands', 'commands'],
    ['agents', 'agents'], ['skills', 'skills'], ['.lsp.json', 'LSP servers'], ['workflows', 'workflows'], ['package.json', 'package scripts']]) {
    try { fs.lstatSync(join(folder, name)); kinds.add(label); } catch (error) { if (error.code !== 'ENOENT') kinds.add('unreadable files'); }
  }
  if (kinds.size) return `Warning: this plugin includes ${[...kinds].join(', ')}. sleight cannot control what the host loads from it.`;
  if (componentMetadata === null) return 'Warning: marketplace component metadata is unavailable. sleight cannot control what the host loads from this plugin.';
}
export function characterPackDigest(files) {
  const digest = createHash('sha256');
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) digest.update(name).update(bytes);
  return digest.digest('hex');
}
export function discoverCharacterPlugins({ home = userInfo().homedir, env = process.env, uid = process.getuid(), cwd = process.cwd(), codexList } = {}) {
  const options = { home, env, uid, cwd, codexList }, groups = [], seen = new Set(); let count = 0;
  for (const install of [...claudeInstalls(options), ...codexInstalls(options)]) {
    try {
      directory(install.folder, uid);
      const manifest = pluginManifest(install.folder, install.host, uid);
      if (!plain(manifest?.name)) continue;
      const packRoot = join(install.folder, 'sleight-characters'); directory(packRoot, uid);
      const ids = fs.readdirSync(packRoot).sort(); if (ids.length > LIMITS.perPlugin) continue;
      const { componentMetadata, ...identity } = install;
      const group = { ...identity, name: manifest.name, warning: extras(install.folder, manifest, uid, componentMetadata), packs: [] };
      for (const id of ids) {
        if (!idValid(id) || count >= LIMITS.packs) continue;
        try {
          const folder = join(packRoot, id), pack = loadCharacter(folder, { uid, shared: true });
          const key = createHash('sha256').update(JSON.stringify([install.host, install.pluginId, folder])).digest('hex');
          if (seen.has(key)) continue;
          // Bind offers to the actual snapshot as well as its installed identity.
          group.packs.push({ id, name: pack.manifest.name, key, folder, digest: characterPackDigest(pack.files) }); seen.add(key); count++;
        } catch {} // Bad packs never become selectable offers.
      }
      groups.push(group);
    } catch {} // A stale record, missing payload, or unsafe path grants no discovery root.
  }
  return groups;
}

if (!isMainThread) parentPort.once('message', options => {
  try { parentPort.postMessage({ groups: discoverCharacterPlugins(options) }); }
  catch { parentPort.postMessage({ groups: [] }); }
});
export function installedCharacterPlugins(options) {
  return new Promise(resolve => {
    const worker = new Worker(new URL(import.meta.url)); let settled = false;
    const done = groups => { if (settled) return; settled = true; clearTimeout(timer); resolve(groups); worker.terminate(); };
    const timer = setTimeout(() => done([]), 10000);
    worker.once('message', value => done(value.groups)); worker.once('error', () => done([])); worker.once('exit', () => done([]));
    worker.postMessage(options);
  });
}
