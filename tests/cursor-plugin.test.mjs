// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
// sleight as a Cursor plugin (ROADMAP 4d): the Cursor manifest, MCP config and marketplace beside Claude's and Codex's,
// the one skill folder all three read, Cursor's clientInfo in the host label and approval wording, and the doctor's
// Cursor lines. Installs go only into throwaway homes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostLabel, hostName } from '../plugins/sleight/lib/host-label.mjs';
import { hostWording, wordForHost } from '../plugins/sleight/lib/launch.mjs';
import { CURSOR_IMPORT_SETTING, CURSOR_INSTALL, CURSOR_REPO, cursorDoctorLines, cursorStatus } from '../plugins/sleight/lib/cursor-host.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const plugin = join(repo, 'plugins/sleight');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const shape = json(fileURLToPath(new URL('fixtures/cursor/plugin-shape.json', import.meta.url)));
const cursor = json(join(plugin, '.cursor-plugin/plugin.json'));
const claude = json(join(plugin, '.claude-plugin/plugin.json'));
const codex = json(join(plugin, '.codex-plugin/plugin.json'));
const relative = path => {
  assert.equal(typeof path, 'string');
  assert.ok(!isAbsolute(path) && !normalize(path).split('/').includes('..'), `${path} must be relative, without ..`);
  return join(plugin, path);
};
const ROOT = shape.pluginRootVariable;

test('the Cursor manifest uses only keys Cursor\'s parser knows and matches the other manifests', () => {
  for (const key of Object.keys(cursor)) assert.ok(shape.manifestKeys.includes(key), `unknown manifest key ${key}`);
  for (const key of Object.keys(cursor.author)) assert.ok(shape.authorKeys.includes(key), `unknown author key ${key}`);
  assert.match(cursor.name, new RegExp(shape.name));
  for (const key of ['name', 'version', 'license', 'homepage', 'repository']) assert.deepEqual(cursor[key], claude[key], key);
  assert.equal(cursor.version, codex.version);
  assert.equal(cursor.author.name, claude.author.name);
  assert.ok(statSync(relative(cursor.logo)).isFile());
  assert.doesNotMatch(JSON.stringify(cursor), /Claude|Codex/, 'the Cursor manifest speaks to Cursor users');
});

test('one launcher serves every host: Cursor names the server plugin-sleight-computer, as when it imports the Claude plugin', () => {
  const mcp = json(relative(cursor.mcpServers));
  // Cursor names a plugin's server plugin-<plugin>-<server>; its logs named the imported Claude plugin's server
  // plugin-sleight-computer (2026-10-08 to 2026-10-14), so both routes give the model the same server.
  assert.deepEqual(Object.keys(mcp.mcpServers), Object.keys(claude.mcpServers));
  assert.equal(`plugin-${cursor.name}-${Object.keys(mcp.mcpServers)[0]}`, 'plugin-sleight-computer');
  const server = mcp.mcpServers.computer;
  for (const key of Object.keys(server)) assert.ok(shape.stdioServerKeys.includes(key), `unknown server key ${key}`);
  assert.equal(server.command, `${ROOT}/bin/sleight-mcp`);
  assert.equal(server.command.replace(ROOT, '${CLAUDE_PLUGIN_ROOT}'), claude.mcpServers.computer.command, 'the same launcher');
  accessSync(join(plugin, server.command.slice(ROOT.length + 1)), constants.X_OK);
  // Cursor would read a root mcp.json, and Claude Code a root .mcp.json, as a second server.
  assert.equal(existsSync(join(plugin, 'mcp.json')), false);
  assert.equal(existsSync(join(plugin, '.mcp.json')), false);
});

test('Cursor never reads the Claude mod\'s hooks or picks up a component nobody wrote for it', () => {
  // Without a manifest path Cursor reads hooks/hooks.json, which is the mod's module list.
  assert.deepEqual(cursor.hooks, {});
  assert.deepEqual(json(join(plugin, 'hooks/hooks.json')), { modules: ['./register.tsx'] });
  for (const dir of ['rules', 'agents', 'commands']) assert.equal(existsSync(join(plugin, dir)), false, `${dir}/ would load into Cursor`);
});

test('Cursor reads the same skill folder as Claude Code and Codex, and the skill fits Cursor\'s rules', () => {
  const skills = relative(cursor.skills);
  assert.equal(skills.replace(/\/$/, ''), relative(codex.skills).replace(/\/$/, ''));
  for (const name of readdirSync(skills)) {
    const text = readFileSync(join(skills, name, 'SKILL.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---/.exec(text)[1];
    const keys = [...front.matchAll(/^([a-z-]+):/gm)].map(m => m[1]);
    for (const key of keys) assert.ok(shape.skillFrontmatterKeys.includes(key), `${name}: Cursor doesn't know ${key}`);
    assert.equal(/^name: (.*)$/m.exec(front)[1], name, 'Cursor needs the name to match the folder');
    assert.match(/^description: (.*)$/m.exec(front)[1], /\S/);
    // Both skills load on explicit invocation. The relay adds drive-mac-apps to the first engine docs reply.
    assert.match(front, /^disable-model-invocation: true$/m);
  }
  // One copy: nothing generated that could drift from the skill.
  const copies = [];
  const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['vendor', 'node_modules'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else if (entry.name === 'SKILL.md' || entry.name.endsWith('.mdc')) copies.push(full.slice(plugin.length + 1));
  } };
  walk(plugin);
  assert.deepEqual(copies, ['skills/drive-mac-apps/SKILL.md', 'skills/make-character/SKILL.md']);
});

test('the repo is a Cursor marketplace named like the Claude one, so cursor-agent\'s loader keeps its plugin over the Claude import', () => {
  const market = json(join(repo, '.cursor-plugin/marketplace.json'));
  const claudeMarket = json(join(repo, '.claude-plugin/marketplace.json'));
  for (const key of Object.keys(market)) assert.ok(shape.marketplaceKeys.includes(key), key);
  // cursor-agent's loader keeps one plugin per <marketplace>/<name>, listing Cursor's marketplaces before the Claude import.
  // The editor's own rule is unread (live check).
  assert.equal(market.name, claudeMarket.name);
  assert.equal(market.owner.name, claudeMarket.owner.name);
  assert.equal(market.plugins.length, 1);
  const [entry] = market.plugins;
  for (const key of Object.keys(entry)) assert.ok(shape.marketplaceEntryKeys.includes(key), key);
  assert.equal(entry.name, cursor.name);
  assert.ok(!isAbsolute(entry.source) && !entry.source.split('/').includes('..'));
  assert.equal(join(repo, entry.source), plugin);
  assert.doesNotMatch(JSON.stringify(market), /Claude|Codex/);
  assert.equal(CURSOR_INSTALL, `cursor-agent plugin marketplace add ${CURSOR_REPO}`);
  assert.equal(CURSOR_REPO, claude.repository);
  assert.equal(entry.source, claudeMarket.plugins[0].source, 'the same ./ form as the Claude marketplace');
});

test('Cursor\'s own clientInfo reads "Cursor", without the fixed 1.0.0 it sends', () => {
  for (const info of Object.values(shape.clientInfo)) {
    assert.equal(hostLabel(info), 'Cursor');
    assert.equal(hostName(info), 'Cursor');
    const wording = hostWording(info, {});
    assert.deepEqual(wording, { claudeCode: false, host: 'Cursor', panel: 'Cursor' });
    assert.equal(wordForHost('Allow Claude to hover in TextEdit? It moves your pointer briefly.', wording),
      'Allow Cursor to hover in TextEdit? It moves your pointer briefly.');
  }
  // A real version from a later Cursor is kept, and a title always wins.
  assert.equal(hostLabel({ name: 'cursor-vscode', version: '3.30.0' }), 'Cursor 3.30.0');
  assert.equal(hostLabel({ name: 'cursor-vscode', title: 'Cursor IDE', version: '1.0.0' }), 'Cursor IDE 1.0.0');
  // An odd name is left out, never shown on the approval card.
  assert.deepEqual(hostWording({ name: 'x\nmodel: gpt' }, {}), { claudeCode: false, host: undefined, panel: 'generic' });
  // hostWording checks a title as the menu bar does: an odd or overlong title falls back to the name. Before 1.4.0 the
  // card showed the raw title.
  assert.deepEqual(hostWording({ name: 'acme-agent', title: 'Acme\nmodel: gpt' }, {}), { claudeCode: false, host: 'Acme Agent', panel: 'Acme Agent' });
  assert.equal(hostWording({ name: 'acme-agent', title: 'A'.repeat(41) }, {}).host, 'Acme Agent');
});

// A fake filesystem for the doctor, keyed by path under /home.
// links maps a symlink's path to its target; a path under a link reads through it.
function fakeFs(files, links = {}) {
  const has = path => Object.keys(files).some(key => key === path || key.startsWith(path + '/'));
  return {
    home: '/home',
    lstat: path => ({ isSymbolicLink: () => Object.hasOwn(links, path) }),
    realpath: path => links[path] ?? path,
    exists: has,
    read: path => { if (typeof files[path] !== 'string') throw Object.assign(Error(`ENOENT ${path}`), { code: 'ENOENT' }); return files[path]; },
    list: path => { if (!has(path) || typeof files[path] === 'string') throw Error(`ENOTDIR ${path}`);
      return [...new Set(Object.keys(files).filter(key => key.startsWith(path + '/')).map(key => key.slice(path.length + 1).split('/')[0]))]; },
  };
}
const APP = '/Applications/Cursor.app/Contents/Resources/app/product.json';
const manifest = name => JSON.stringify({ name });
const CLAUDE_INSTALLED = JSON.stringify({ version: 2, plugins: { 'sleight@sleight': [{ scope: 'user', version: '1.3.0' }] } });

test('doctor: Cursor missing, Cursor without sleight, and each way sleight can be in Cursor', () => {
  const lines = files => cursorDoctorLines(cursorStatus(fakeFs(files)));
  assert.deepEqual(lines({}), ['Cursor', 'note      Cursor isn\'t installed']);
  assert.deepEqual(lines({ [APP]: '{"version":"3.25.6"}' }), ['Cursor',
    `note      sleight isn't set up in Cursor 3.25.6. To add it: ${CURSOR_INSTALL}, then install sleight from Cursor's plugin list`]);
  assert.deepEqual(lines({ [APP]: '{"version":"3.25.6"}', '/home/.cursor/plugins/cache/sleight/sleight/0123abc/.cursor-plugin/plugin.json': manifest('sleight'),
    '/home/.claude/plugins/installed_plugins.json': CLAUDE_INSTALLED }), ['Cursor',
    'ok        sleight is installed as a Cursor plugin (sleight from marketplace sleight). cursor-agent\'s loader keeps it in place of the Claude Code copy (sleight@sleight).']);
  assert.deepEqual(lines({ '/home/.cursor/argv.json': '{}', '/home/.claude/plugins/installed_plugins.json': CLAUDE_INSTALLED }), ['Cursor',
    `note      sleight is installed in Claude Code (sleight@sleight). Cursor runs it from there while "${CURSOR_IMPORT_SETTING}" is on in Cursor's settings.`,
    `          To install it in Cursor itself: ${CURSOR_INSTALL}, then install sleight from Cursor's plugin list`]);
  assert.deepEqual(lines({ [APP]: '{"version":"3.25.6"}', '/home/.cursor/plugins/local/my-sleight/.cursor-plugin/plugin.json': manifest('sleight'),
    '/home/.cursor/plugins/local/other/.cursor-plugin/plugin.json': manifest('other'),
    '/home/.cursor/mcp.json': JSON.stringify({ mcpServers: { mac: { command: `${MAC_USERS}me/sleight/plugins/sleight/bin/sleight-mcp` }, other: { command: 'npx' } } }) }), ['Cursor',
    'ok        sleight is a local Cursor plugin (~/.cursor/plugins/local/my-sleight). Copy it again after each sleight update.',
    'ok        sleight is in ~/.cursor/mcp.json as "mac"',
    'note      Cursor starts sleight 2 times (~/.cursor/plugins/local/my-sleight, ~/.cursor/mcp.json "mac"). Keep one.']);
});

test('doctor: a local plugin linked from outside plugins/local is a problem, since Cursor skips it', () => {
  const fs = fakeFs({ [APP]: '{"version":"3.25.6"}', '/home/.cursor/plugins/local/sleight/.cursor-plugin/plugin.json': manifest('sleight'),
    '/home/.cursor/plugins/local/inside/.cursor-plugin/plugin.json': manifest('sleight') },
  { '/home/.cursor/plugins/local/sleight': '/home/src/sleight/plugins/sleight', '/home/.cursor/plugins/local/inside': '/home/.cursor/plugins/local/copies/sleight' });
  const status = cursorStatus(fs);
  assert.deepEqual(status.local, ['inside']);
  assert.deepEqual(cursorDoctorLines(status), ['Cursor',
    'PROBLEM   ~/.cursor/plugins/local/sleight links to ~/src/sleight/plugins/sleight, outside ~/.cursor/plugins/local, so Cursor skips it. Put a copy there in its place: rm ~/.cursor/plugins/local/sleight && cp -R ~/src/sleight/plugins/sleight ~/.cursor/plugins/local/sleight',
    'ok        sleight is a local Cursor plugin (~/.cursor/plugins/local/inside). Copy it again after each sleight update.']);
  // Only the link: nothing else set up, so the install command still shows.
  const alone = cursorStatus(fakeFs({ [APP]: '{"version":"3.25.6"}', '/home/.cursor/plugins/local/sleight/.cursor-plugin/plugin.json': manifest('sleight') },
    { '/home/.cursor/plugins/local/sleight': '/elsewhere/sleight' }));
  assert.deepEqual(cursorDoctorLines(alone).slice(2), [`note      sleight isn't set up in Cursor 3.25.6. To add it: ${CURSOR_INSTALL}, then install sleight from Cursor's plugin list`]);
});

test('doctor: a Cursor marketplace by another name doesn\'t replace the Claude Code copy, so both count', () => {
  const lines = cursorDoctorLines(cursorStatus(fakeFs({ [APP]: '{"version":"3.25.6"}',
    '/home/.cursor/plugins/cache/mine/sleight/0123abc/.cursor-plugin/plugin.json': manifest('sleight'),
    '/home/.claude/plugins/installed_plugins.json': CLAUDE_INSTALLED })));
  assert.deepEqual(lines, ['Cursor',
    'ok        sleight is installed as a Cursor plugin (sleight from marketplace mine)',
    `note      sleight is installed in Claude Code (sleight@sleight). Cursor runs it from there while "${CURSOR_IMPORT_SETTING}" is on in Cursor's settings.`,
    'note      Cursor starts sleight 2 times (marketplace mine, the Claude Code copy, if that setting is on). Keep one.']);
});

test('doctor: an unreadable mcp.json is a problem line, not a crash', () => {
  const fs = fakeFs({ [APP]: '{"version":"3.25.6"}', '/home/.cursor/mcp.json': '{ not json' });
  assert.deepEqual(cursorDoctorLines(cursorStatus(fs)), ['Cursor',
    'PROBLEM   could not read ~/.cursor/mcp.json (not JSON)',
    `note      sleight isn't set up in Cursor 3.25.6. To add it: ${CURSOR_INSTALL}, then install sleight from Cursor's plugin list`]);
});

test('a copy of the plugin in a throwaway Cursor home is found, and its server command resolves to the launcher', t => {
  const home = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-cursor-home-')));
  t.after(() => removeTemp(home));
  const installed = join(home, '.cursor/plugins/local/sleight');
  mkdirSync(installed, { recursive: true });
  for (const part of ['.cursor-plugin', 'skills', 'bin', 'assets']) cpSync(join(plugin, part), join(installed, part), { recursive: true });
  writeFileSync(join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: {} }));
  const status = cursorStatus({ home, app: [] });
  assert.deepEqual(status.local, ['sleight']);
  assert.deepEqual(cursorDoctorLines(status), ['Cursor',
    'ok        sleight is a local Cursor plugin (~/.cursor/plugins/local/sleight). Copy it again after each sleight update.']);
  const copied = json(join(installed, '.cursor-plugin/plugin.json'));
  const command = json(join(installed, copied.mcpServers)).mcpServers.computer.command.replace(ROOT, installed);
  accessSync(command, constants.X_OK);
  assert.ok(existsSync(join(installed, copied.skills, 'drive-mac-apps/SKILL.md')));
});
