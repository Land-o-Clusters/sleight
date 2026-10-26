import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { encodePng } from '../bench/hand/synthetic-character.mjs';
import * as archive from '../plugins/sleight/lib/hand/character-archive.mjs';
import * as sharing from '../plugins/sleight/lib/hand/character-sharing.mjs';
import { discoverCharacterPlugins, characterPackDigest } from '../plugins/sleight/lib/hand/character-plugins.mjs';
import { loadCharacter, installCharacter } from '../plugins/sleight/lib/hand/character.mjs';
import { cursorCommand } from '../plugins/sleight/lib/hand/cursor-command.mjs';
import { createCursorPicker } from '../plugins/sleight/lib/hand/cursor-picker.mjs';
import { settingsCommand, settingsRefusal } from '../plugins/sleight/lib/person-gate.mjs';

function world(t) {
  const home = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join('/tmp', 'sleight-sharing-'))));
  const root = join(home, 'characters');
  const putPack = (folder, id = 'mouse') => {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const pixels = new Uint8Array(512 * 64 * 4);
    for (let y = 10; y < 24; y++) for (let x = 10; x < 24; x++) pixels.set([200, 100, 50, 255], (y * 512 + x) * 4);
    fs.writeFileSync(join(folder, 'sheet.png'), encodePng(512, 64, pixels), { mode: 0o600 });
    fs.writeFileSync(join(folder, 'character.json'), JSON.stringify({ format: 'sleight-character', version: 1, id, name: 'Mouse',
      author: 'Example', license: 'MIT', description: '', sheet: 'sheet.png', frame: { w: 64, h: 64 }, grid: { cols: 8, rows: 1 },
      scale: 1, anchor: { x: 32, y: 32 }, hotspot: { x: 32, y: 32 }, states: { idle: { row: 0, frames: 1, ms: 100, loop: true } } }), { mode: 0o600 });
    return loadCharacter(folder);
  };
  const plugin = (name = 'critters', id = 'mouse', host = 'claude') => {
    const folder = host === 'claude' ? join(home, '.claude/plugins/cache/demo', name, '1.0.0') : join(home, host, name), meta = join(folder, host === 'claude' ? '.claude-plugin' : '.codex-plugin');
    fs.mkdirSync(meta, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(meta, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }), { mode: 0o600 });
    putPack(join(folder, 'sleight-characters', id), id); return folder;
  };
  const record = entries => {
    const path = join(home, '.claude/plugins'); fs.mkdirSync(path, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(path, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: entries }), { mode: 0o600 });
  };
  const options = { home, root, uid: process.getuid(), env: {}, cwd: home, codexList: () => ({ installed: [] }) };
  return { home, root, putPack, plugin, record, options };
}
const loaded = async () => ({ loaded: true, warnings: [], reason: null });

test('single-file pack preserves exact bytes and installs only after decode', async t => {
  const w = world(t), pack = w.putPack(join(w.home, 'mouse')), bytes = archive.encodeCharacterArchive(pack.files);
  assert.deepEqual(archive.decodeCharacterArchive(bytes), pack.files);
  const file = join(w.home, 'mouse.sleightchar'); fs.writeFileSync(file, bytes);
  let decoded = 0;
  const options = { ...w.options, hostCheck: async (frame, bank) => {
    decoded++; if (decoded === 1) assert.equal(fs.existsSync(join(w.root, 'mouse')), false);
    assert.equal(frame.sheet, join(bank, 'mouse/sheet.png')); assert.deepEqual(fs.readFileSync(frame.sheet), pack.files.get('sheet.png'));
    return loaded();
  } };
  assert.equal((await sharing.importCharacterArchive(file, options)).manifest.id, 'mouse');
  assert.equal(decoded, 1); assert.equal(loadCharacter(join(w.root, 'mouse'), { installed: true }).total, pack.total);
  await assert.rejects(sharing.importCharacterArchive(file, options), /already exists/);
});

test('export validates and decodes the captured snapshot, refuses overwrite and round trips', async t => {
  const w = world(t), pack = w.putPack(join(w.home, 'mouse')); installCharacter(pack, { root: w.root });
  const file = join(w.home, 'out.sleightchar');
  const result = await sharing.exportCharacterArchive('mouse', file, { ...w.options, hostCheck: loaded });
  assert.equal(result.bytes, fs.statSync(file).size); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(archive.decodeCharacterArchive(fs.readFileSync(file)), pack.files);
  await assert.rejects(sharing.exportCharacterArchive('mouse', file, { ...w.options, hostCheck: loaded }), /exist/i);
});

test('decode refusal, unknown license and malformed manifests publish nothing', async t => {
  const w = world(t), pack = w.putPack(join(w.home, 'mouse')), file = join(w.home, 'bad.sleightchar');
  fs.writeFileSync(file, archive.encodeCharacterArchive(pack.files));
  await assert.rejects(sharing.importCharacterArchive(file, { ...w.options, hostCheck: async () => ({ loaded: false, reason: 'pixels', warnings: [] }) }), /pixels/);
  assert.equal(fs.existsSync(w.root), false);
  for (const manifest of ['{}', JSON.stringify({ ...pack.manifest, license: 'unknown' })]) {
    fs.writeFileSync(file, archive.encodeCharacterArchive(new Map([...pack.files, ['character.json', Buffer.from(manifest)]])));
    await assert.rejects(sharing.importCharacterArchive(file, { ...w.options, hostCheck: loaded }), /format|license/);
  }
});

function checksum(bytes, at = 0) {
  bytes.fill(32, at + 148, at + 156);
  const sum = bytes.subarray(at, at + 512).reduce((a, b) => a + b, 0);
  bytes.write(sum.toString(8).padStart(6, '0') + '\0 ', at + 148, 8, 'ascii'); return bytes;
}
test('hostile tar names, links, extensions, sizes, checksums, padding and trailing data are refused', t => {
  const w = world(t), good = archive.encodeCharacterArchive(w.putPack(join(w.home, 'mouse')).files);
  const mutate = fn => { const b = Buffer.from(good); fn(b); return checksum(b); };
  for (const name of ['../sheet.png', '/sheet.png', 'x/sheet.png', 'x\\sheet.png', '.', '..', 'a'.repeat(81), 'hook.js']) {
    assert.throws(() => archive.decodeCharacterArchive(mutate(b => { b.fill(0, 0, 100); b.write(name); })), /archive/i, name);
  }
  for (const kind of ['1', '2', '5', 'x', 'g', 'L', 'S']) assert.throws(() => archive.decodeCharacterArchive(mutate(b => b.write(kind, 156))), /archive/i);
  for (const [start, end] of [[157, 257], [345, 500]]) assert.throws(() => archive.decodeCharacterArchive(mutate(b => b.fill(65, start, end))), /archive/i);
  for (const value of ['77777777777', '-0000000001', 'zzzzzzzzzzz']) assert.throws(() => archive.decodeCharacterArchive(mutate(b => b.write(value, 124))), /archive/i);
  const badSum = Buffer.from(good); badSum[10] ^= 1; assert.throws(() => archive.decodeCharacterArchive(badSum), /checksum/);
  for (const n of [0, 1, 511, 512, good.length - 1, good.length - 512]) assert.throws(() => archive.decodeCharacterArchive(good.subarray(0, n)), /archive/i);
  assert.throws(() => archive.decodeCharacterArchive(Buffer.concat([good, Buffer.from('payload') ])), /archive/i);
  const duplicate = Buffer.concat([good.subarray(0, -1024), good]); assert.throws(() => archive.decodeCharacterArchive(duplicate), /duplicate/);
  assert.throws(() => archive.decodeCharacterArchive(Buffer.alloc(archive.ARCHIVE_LIMITS.bytes + 1)), /archive/i);
});

test('bounded mutation corpus never escapes, creates files or returns unchecked names', t => {
  const w = world(t), original = archive.encodeCharacterArchive(w.putPack(join(w.home, 'mouse')).files);
  let refused = 0;
  for (let i = 0; i < 512; i++) {
    const bytes = Buffer.from(original), index = (i * 7919) % bytes.length; bytes[index] ^= (i % 255) + 1;
    try { for (const name of archive.decodeCharacterArchive(bytes).keys()) assert.match(name, /^(character\.json|sheet\.png)$/); }
    catch (error) { assert.match(error.message, /archive/i); refused++; }
  }
  assert.ok(refused > 200); t.diagnostic(`mutations=512 refused=${refused}`);
});

test('Claude discovery reads only matching installed records, validates packs and warns about other payloads', t => {
  const w = world(t), folder = w.plugin(); w.plugin('unrecorded');
  fs.mkdirSync(join(folder, 'hooks')); fs.writeFileSync(join(folder, '.mcp.json'), '{}');
  w.record({ 'critters@demo': [{ scope: 'user', installPath: folder, version: '1.0.0' }],
    'elsewhere@demo': [{ scope: 'project', projectPath: join(w.home, 'other'), installPath: w.plugin('elsewhere') }] });
  const result = discoverCharacterPlugins(w.options);
  assert.equal(result.length, 1); assert.equal(result[0].name, 'critters'); assert.equal(result[0].packs.length, 1);
  assert.match(result[0].warning, /hooks.*MCP|MCP.*hooks/); assert.match(result[0].warning, /host loads/);
  fs.writeFileSync(join(folder, 'sleight-characters/mouse/character.json'), '{}');
  assert.equal(discoverCharacterPlugins(w.options)[0].packs.length, 0);
});

test('unsafe records, roots, pack links and ambiguous installs are skipped', t => {
  const w = world(t), folder = w.plugin();
  w.record({ 'critters@demo': [{ scope: 'user', installPath: folder }, { scope: 'user', installPath: w.plugin('other') }] });
  assert.deepEqual(discoverCharacterPlugins(w.options), []);
  w.record({ 'critters@demo': [{ scope: 'user', installPath: folder }] });
  fs.symlinkSync(join(folder, 'sleight-characters/mouse'), join(folder, 'sleight-characters/link'));
  assert.equal(discoverCharacterPlugins(w.options)[0].packs.length, 1);
  fs.chmodSync(join(w.home, '.claude/plugins/installed_plugins.json'), 0o666);
  assert.deepEqual(discoverCharacterPlugins(w.options), []);
});

test('Codex discovery uses installed versions from the host, ignores available and source folders', t => {
  const w = world(t), source = w.plugin('critters', 'mouse', 'codex');
  const cache = join(w.home, '.codex/plugins/cache/demo/critters/1.0.0'); fs.mkdirSync(join(cache, '..'), { recursive: true }); fs.renameSync(source, cache);
  w.plugin('unrecorded', 'ghost', 'codex');
  const result = discoverCharacterPlugins({ ...w.options, codexList: () => ({ installed: [{ name: 'critters', pluginId: 'critters@demo', marketplaceName: 'demo', version: '1.0.0', installed: true }],
    available: [{ name: 'unrecorded', installed: false }] }) });
  assert.equal(result.length, 1); assert.equal(result[0].host, 'codex'); assert.equal(result[0].packs[0].id, 'mouse');
});

test('picker groups plugin packs by name, keeps warnings, rechecks record and decode before selecting', async t => {
  const w = world(t), folder = w.plugin(), writes = [];
  fs.mkdirSync(join(folder, 'agents')); w.record({ 'critters@demo': [{ scope: 'user', installPath: folder }] });
  const controller = createCursorPicker({ ...w.options, pluginCatalog: () => discoverCharacterPlugins(w.options), hostCheck: loaded, writeSetting: s => writes.push(s) });
  const catalog = await controller.catalog(), group = catalog.rows.find(r => r.title.includes('critters'));
  assert.ok(group); assert.match(group.title, /warning/i); assert.equal(group.children.length, 1);
  assert.equal((await controller.apply({ op: 'import', key: group.children[0].key })).ok, true);
  assert.deepEqual(writes, [{ style: 'sprite', character: 'mouse' }]);
  const next = createCursorPicker({ ...w.options, pluginCatalog: () => discoverCharacterPlugins(w.options), hostCheck: loaded, writeSetting: s => writes.push(s) });
  fs.rmSync(join(w.root, 'mouse'), { recursive: true });
  const offered = (await next.catalog()).plugins[0].packs[0]; w.record({});
  assert.equal((await next.apply({ op: 'import', key: offered.key })).ok, false);
});

test('CLI accepts archive import and export and preserves the fallback callout', async t => {
  const w = world(t), pack = w.putPack(join(w.home, 'mouse')), input = join(w.home, 'input.sleightchar');
  fs.writeFileSync(input, archive.encodeCharacterArchive(pack.files)); let output = '';
  const opts = { ...w.options, sharedHostCheck: loaded, out: s => output += s };
  assert.equal(await cursorCommand(['import', input, '--yes'], opts), 0, output); assert.match(output, /18 more/);
  const file = join(w.home, 'out.sleightchar');
  assert.equal(await cursorCommand(['export', 'mouse', file], opts), 0, output); assert.ok(fs.existsSync(file));
  assert.equal(await cursorCommand(['export', 'mouse'], opts), 2);
  assert.equal(settingsCommand(['cursor', 'export', 'mouse', file]), 'cursor export');
  assert.equal(settingsCommand(['cursor', 'import', input]), 'cursor import');
});

test('archive caps, compressed inputs, links and writable source files refuse before decode', async t => {
  const w = world(t), pack = w.putPack(join(w.home, 'mouse')), bytes = archive.encodeCharacterArchive(pack.files);
  assert.throws(() => archive.decodeCharacterArchive(gzipSync(bytes)), /archive/);
  assert.throws(() => archive.encodeCharacterArchive(new Map([...pack.files, ['LICENSE.txt', Buffer.alloc(65537)]])), /size/);
  assert.throws(() => archive.encodeCharacterArchive(new Map([...pack.files, ['sheet.png', Buffer.alloc(8 * 1024 ** 2 + 1)]])), /size/);
  assert.throws(() => archive.encodeCharacterArchive(new Map([...pack.files, ['sheet.png', Buffer.alloc(8 * 1024 ** 2)], ['extra.webp', Buffer.alloc(8 * 1024 ** 2)]])), /total/);
  const file = join(w.home, 'input.sleightchar'); fs.writeFileSync(file, bytes);
  const linked = join(w.home, 'linked'); fs.symlinkSync(file, linked);
  assert.throws(() => archive.readCharacterArchive(linked), /unsafe/);
  fs.unlinkSync(linked); fs.linkSync(file, linked); assert.throws(() => archive.readCharacterArchive(file), /unsafe/);
  fs.unlinkSync(linked); fs.chmodSync(file, 0o666); assert.throws(() => archive.readCharacterArchive(file), /unsafe/);
  assert.throws(() => archive.readCharacterArchive(w.home), /unsafe/);
});

test('private snapshots clean up on decoder errors and imports never replace existing characters', async t => {
  const w = world(t), pack = w.putPack(join(w.home, 'mouse')); let bank;
  await assert.rejects(sharing.withSharedCharacter(pack.files, { hostCheck: (frame, root) => { bank = root; throw Error('decoder unavailable'); } }), /decoder unavailable/);
  assert.equal(fs.existsSync(bank), false);
  installCharacter(pack, { root: w.root }); const before = fs.readFileSync(join(w.root, 'mouse/character.json'));
  const files = new Map(pack.files); files.set('character.json', Buffer.from(JSON.stringify({ ...pack.manifest, name: 'Replacement' })));
  const file = join(w.home, 'input.sleightchar'); fs.writeFileSync(file, archive.encodeCharacterArchive(files));
  await assert.rejects(sharing.importCharacterArchive(file, { ...w.options, hostCheck: loaded }), /already exists/);
  assert.deepEqual(fs.readFileSync(join(w.root, 'mouse/character.json')), before);
});

test('Claude scoped install precedence and config roots are explicit, unsupported records refuse', t => {
  const w = world(t), user = w.plugin('user-art'), project = w.plugin('project-art');
  w.record({ 'critters@demo': [{ scope: 'user', installPath: user }, { scope: 'project', projectPath: w.home, installPath: project }] });
  assert.equal(discoverCharacterPlugins(w.options)[0].name, 'project-art');
  assert.equal(discoverCharacterPlugins({ ...w.options, cwd: join(w.home, 'nested') })[0].name, 'project-art');
  assert.equal(discoverCharacterPlugins({ ...w.options, cwd: tmpdir() })[0].name, 'user-art');
  const cfg = join(w.home, 'isolated-config'); fs.mkdirSync(cfg);
  fs.renameSync(join(w.home, '.claude/plugins'), join(cfg, 'plugins'));
  assert.equal(discoverCharacterPlugins(w.options).length, 0);
  const pathRecord = join(cfg, 'plugins/installed_plugins.json');
  fs.writeFileSync(pathRecord, fs.readFileSync(pathRecord, 'utf8').replaceAll(join(w.home, '.claude/plugins'), join(cfg, 'plugins')));
  const custom = { ...w.options, env: { CLAUDE_CONFIG_DIR: cfg } };
  assert.equal(discoverCharacterPlugins(custom)[0].name, 'project-art');
  const path = join(cfg, 'plugins/installed_plugins.json'); fs.writeFileSync(path, JSON.stringify({ version: 1, plugins: {} }));
  assert.deepEqual(discoverCharacterPlugins(custom), []);
  fs.writeFileSync(path, Buffer.alloc(1024 ** 2 + 1)); assert.deepEqual(discoverCharacterPlugins(custom), []);
});

test('all code-bearing manifest components warn, unsafe pack roots refuse and folder caps are enforced', t => {
  const w = world(t), folder = w.plugin(), path = join(folder, '.claude-plugin/plugin.json');
  fs.writeFileSync(path, JSON.stringify({ name: 'critters', hooks: {}, mcpServers: {}, commands: {}, agents: [], skills: [] }));
  w.record({ 'critters@demo': [{ scope: 'user', installPath: folder }] });
  const group = discoverCharacterPlugins(w.options)[0];
  for (const word of ['hooks', 'MCP servers', 'commands', 'agents', 'skills']) assert.ok(group.warning.includes(word));
  fs.chmodSync(join(folder, 'sleight-characters/mouse'), 0o777); assert.equal(discoverCharacterPlugins(w.options)[0].packs.length, 0);
  fs.chmodSync(join(folder, 'sleight-characters/mouse'), 0o700);
  for (let i = 0; i < 32; i++) fs.mkdirSync(join(folder, 'sleight-characters', `pack-${i}`));
  assert.deepEqual(discoverCharacterPlugins(w.options), []);
});

test('Codex local version path, disabled installs and custom home work without reading a source checkout', t => {
  const w = world(t), source = w.plugin('critters', 'mouse', 'codex'), codexHome = join(w.home, 'custom-codex');
  const cache = join(codexHome, 'plugins/cache/demo/critters/local'); fs.mkdirSync(join(cache, '..'), { recursive: true }); fs.renameSync(source, cache);
  const records = { installed: [{ name: 'critters', pluginId: 'critters@demo', marketplaceName: 'demo', version: '2.0.0', installed: true, enabled: false,
    source: { source: 'local', path: source } }, { name: 'nope', installed: false }] };
  const opts = { ...w.options, env: { CODEX_HOME: codexHome }, codexList: () => records };
  assert.equal(discoverCharacterPlugins(opts)[0].packs.length, 1);
  records.installed[0].version = '../escape'; assert.deepEqual(discoverCharacterPlugins(opts), []);
  assert.deepEqual(discoverCharacterPlugins({ ...opts, codexList: () => { throw Error('unavailable'); } }), []);
});

test('picker refuses content swapped after its record recheck and never writes the selection', async t => {
  const w = world(t), folder = w.plugin(); w.record({ 'critters@demo': [{ scope: 'user', installPath: folder }] });
  let calls = 0, writes = 0;
  const controller = createCursorPicker({ ...w.options, hostCheck: loaded, writeSetting: () => writes++, pluginCatalog: () => {
    const groups = discoverCharacterPlugins(w.options);
    if (++calls === 2) {
      const path = join(folder, 'sleight-characters/mouse/character.json'), data = JSON.parse(fs.readFileSync(path));
      fs.writeFileSync(path, JSON.stringify({ ...data, name: 'Changed' }));
    }
    return groups;
  } });
  const catalog = await controller.catalog(), result = await controller.apply({ op: 'import', key: catalog.plugins[0].packs[0].key });
  assert.equal(result.ok, false); assert.match(result.text, /changed while opening/); assert.equal(writes, 0);
});

test('Claude marketplace inline components warn using the host known-marketplace record', t => {
  const w = world(t), folder = w.plugin(); w.record({ 'critters@demo': [{ scope: 'user', installPath: folder }] });
  const market = join(w.home, 'marketplace'), dir = join(market, '.claude-plugin'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(w.home, '.claude/plugins/known_marketplaces.json'), JSON.stringify({ demo: { installLocation: market } }));
  const path = join(dir, 'marketplace.json');
  fs.writeFileSync(path, JSON.stringify({ name: 'demo', plugins: [{ name: 'critters', hooks: { hooks: {} }, mcpServers: { tool: {} } }] }));
  assert.match(discoverCharacterPlugins(w.options)[0].warning, /hooks.*MCP servers/);
  fs.writeFileSync(path, JSON.stringify({ name: 'demo', plugins: [{ name: 'critters', source: './plugins/critters' }] }));
  assert.equal(discoverCharacterPlugins(w.options)[0].warning, undefined);
  fs.unlinkSync(path); assert.match(discoverCharacterPlugins(w.options)[0].warning, /metadata is unavailable/);
});

// C9R: every undeclared host component warns, including future component names.
for (const component of ['bin', 'monitors', 'output-styles', 'themes', 'settings.json', 'SKILL.md', 'payload.mcpb', 'hooks',
  'commands', 'agents', 'skills', 'future-component', 'toString', '__proto__']) {
  test(`data-only allowlist warns for root ${component}`, t => {
    const w = world(t), folder = w.plugin();
    if (component.includes('.')) fs.writeFileSync(join(folder, component), '{}'); else fs.mkdirSync(join(folder, component));
    w.record({ 'critters@demo': [{ scope: 'user', installPath: folder }] });
    assert.ok(discoverCharacterPlugins(w.options)[0].warning.includes(component));
  });
}
for (const key of ['hooks', 'outputStyles', 'experimental', 'monitors', 'themes', 'settings', 'channels', 'userConfig', 'types',
  'commands', 'agents', 'skills', 'futureKey', 'extensions']) {
  test(`data-only allowlist warns for manifest ${key}`, t => {
    const w = world(t), folder = w.plugin();
    fs.writeFileSync(join(folder, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'critters', [key]: {} }));
    w.record({ 'critters@demo': [{ scope: 'user', installPath: folder }] });
    assert.ok(discoverCharacterPlugins(w.options)[0].warning.includes(key));
  });
}
test('metadata-only manifests, plain docs and catalogs pass the allowlist; hidden metadata payloads warn', t => {
  const w = world(t), folder = w.plugin('critters', 'mouse', 'codex');
  const cache = join(w.home, '.codex/plugins/cache/demo/critters/1.0.0');
  fs.mkdirSync(join(cache, '..'), { recursive: true }); fs.renameSync(folder, cache);
  for (const name of ['README.md', 'LICENSE', 'CHANGELOG.txt', '.gitignore']) fs.writeFileSync(join(cache, name), 'metadata');
  fs.mkdirSync(join(cache, '.agents/plugins'), { recursive: true }); fs.writeFileSync(join(cache, '.agents/plugins/marketplace.json'), '{}');
  const options = { ...w.options, codexList: () => ({ installed: [{ installed: true, name: 'critters', pluginId: 'critters@demo', marketplaceName: 'demo', version: '1.0.0' }] }) };
  assert.equal(discoverCharacterPlugins(options)[0].warning, undefined);
  fs.writeFileSync(join(cache, '.agents/plugins/unknown.js'), '');
  assert.match(discoverCharacterPlugins(options)[0].warning, /unknown.js/);
});

test('trusted symlinked plugins and config roots resolve under home; escapes and wrong owners have reasons', async t => {
  const w = world(t), folder = w.plugin(); w.record({ 'critters@demo': [{ scope: 'user', installPath: folder }] });
  const original = join(w.home, '.claude/plugins'), target = join(w.home, 'dotfiles/plugins');
  fs.mkdirSync(join(w.home, 'dotfiles')); fs.renameSync(original, target); fs.symlinkSync(target, original);
  assert.equal(discoverCharacterPlugins(w.options)[0].packs.length, 1);
  const claude = join(w.home, '.claude'), config = join(w.home, 'claude-config');
  fs.renameSync(claude, config); fs.symlinkSync(config, claude);
  assert.equal(discoverCharacterPlugins(w.options)[0].packs.length, 1);
  const bad = discoverCharacterPlugins({ ...w.options, uid: process.getuid() + 1 });
  assert.match(bad[0].reason, /unsafe plugin directory/);
  fs.unlinkSync(original); fs.symlinkSync(fs.realpathSync(tmpdir()), original);
  const refused = discoverCharacterPlugins(w.options); assert.match(refused[0].reason, /outside/);
  let output = '';
  assert.equal(await cursorCommand(['list'], { ...w.options, out: s => output += s, pluginCatalog: () => refused }), 0);
  assert.match(output, /Skipped plugin Claude plugins:.*outside/);
});

test('forged install paths refuse and recorded local marketplace paths remain eligible', t => {
  const w = world(t), folder = w.plugin(); w.record({ 'critters@demo': [{ scope: 'user', installPath: folder }] });
  const outside = join(w.home, 'forged'); fs.renameSync(folder, outside);
  w.record({ 'critters@demo': [{ scope: 'user', installPath: outside }] });
  assert.match(discoverCharacterPlugins(w.options)[0].reason, /outside/);
  const market = join(w.home, 'market'); fs.mkdirSync(join(market, '.claude-plugin'), { recursive: true });
  const local = join(market, 'critters'); fs.renameSync(outside, local);
  fs.writeFileSync(join(market, '.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [{ name: 'critters', source: './critters' }] }));
  fs.writeFileSync(join(w.home, '.claude/plugins/known_marketplaces.json'), JSON.stringify({ demo: { installLocation: market } }));
  w.record({ 'critters@demo': [{ scope: 'user', installPath: local }] });
  assert.equal(discoverCharacterPlugins(w.options)[0].packs.length, 1);
  assert.equal(discoverCharacterPlugins(w.options)[0].warning, undefined);
});

test('export accepts a resolved /tmp parent but never follows or replaces a leaf symlink', async t => {
  const w = world(t), pack = w.putPack(join(w.home, 'mouse')); installCharacter(pack, { root: w.root });
  const alias = '/tmp/' + w.home.split('/').at(-1), file = join(alias, 'export.sleightchar');
  const result = await sharing.exportCharacterArchive('mouse', file, { ...w.options, hostCheck: loaded });
  assert.equal(result.path, join(w.home, 'export.sleightchar')); assert.equal(fs.statSync(result.path).size, result.bytes);
  for (const name of ['missing', 'export.sleightchar']) {
    const leaf = join(alias, 'leaf'); fs.symlinkSync(join(w.home, name), leaf);
    await assert.rejects(sharing.exportCharacterArchive('mouse', leaf, { ...w.options, hostCheck: loaded }), /exist/);
    fs.unlinkSync(leaf);
  }
  assert.equal(fs.existsSync(join(w.home, 'missing')), false);
});

test('Codex list is measured once per open, reused during refresh and revalidation, refreshed next open', async t => {
  const w = world(t), folder = w.plugin(); w.record({ 'critters@demo': [{ scope: 'user', installPath: folder }] });
  let lists = 0; const traces = [];
  const controller = createCursorPicker({ ...w.options, hostCheck: loaded, writeSetting() {}, trace: (...args) => traces.push(args),
    codexSnapshot: async () => { lists++; return { installed: [] }; }, pluginCatalog: options => discoverCharacterPlugins(options) });
  const first = await controller.catalog(), row = first.rows.find(r => r.title.includes('critters@demo'));
  assert.ok(row); await controller.catalog({ open: false }); assert.equal(lists, 1);
  assert.equal((await controller.apply({ op: 'import', key: row.children[0].key })).ok, true); assert.equal(lists, 1);
  const refreshed = await controller.catalog({ open: false });
  const installed = refreshed.rows.find(r => r.title.includes('critters@demo')).children[0];
  assert.match(installed.title, /already installed/); assert.equal(installed.op, 'installed');
  assert.equal(lists, 1); await controller.catalog(); assert.equal(lists, 2);
  assert.equal(traces.filter(([name]) => name === 'hand-picker-codex-list').length, 2);
  assert.ok(traces.every(([, value]) => value.ms >= 0));
});

test('archive ordering and framed pack digests are deterministic across map insertion order', t => {
  const w = world(t), files = w.putPack(join(w.home, 'mouse')).files, reversed = new Map([...files].reverse());
  assert.deepEqual(archive.encodeCharacterArchive(files), archive.encodeCharacterArchive(reversed));
  assert.equal(characterPackDigest(files), characterPackDigest(reversed));
  assert.notEqual(characterPackDigest(new Map([['a', Buffer.from('bc')]])), characterPackDigest(new Map([['ab', Buffer.from('c')]])));
});

test('sharing writers retain the full person gate under a fake agent environment', () => {
  for (const args of [['cursor', 'import', '/fixture/input.sleightchar'], ['cursor', 'export', 'mouse', '/fixture/out.sleightchar']]) {
    assert.match(settingsRefusal(args, { stdin: { isTTY: true }, stdout: { isTTY: true }, env: { CLAUDECODE: '1' }, ancestors: () => { throw Error('must not walk'); } }), /started under an agent/);
  }
});
test('dangling symlinked plugins and config roots list a reason', t => {
  const w = world(t); fs.mkdirSync(join(w.home, '.claude'));
  const root = join(w.home, '.claude/plugins'); fs.symlinkSync(join(w.home, 'missing'), root);
  assert.match(discoverCharacterPlugins(w.options)[0].reason, /unresolved symlink/);
  fs.unlinkSync(root); fs.rmdirSync(join(w.home, '.claude')); fs.symlinkSync(join(w.home, 'missing'), join(w.home, '.claude'));
  assert.match(discoverCharacterPlugins(w.options)[0].reason, /unresolved symlink/);
});
