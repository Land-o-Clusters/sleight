import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { trackTemp, registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { loadCharacter } from '../plugins/sleight/lib/hand/character.mjs';
import { withSharedCharacter } from '../plugins/sleight/lib/hand/character-sharing.mjs';
import { checkCharacterInHost } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { cursorMenuModel } from '../plugins/sleight/lib/hand/cursor-picker.mjs';

let binary;
function build(t) {
  if (binary) return binary;
  const bank = trackTemp(fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-sharing-native-')))); binary = join(bank, 'host');
  const source = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
  assert.match(fs.readFileSync(source, 'utf8'), /if arguments.first == "--check-character"/);
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), source.pathname, '-o', binary], { encoding: 'utf8', timeout: 300000 });
  assert.equal(result.status, 0, result.stderr); t.diagnostic(`binaryBytes=${fs.statSync(binary).size}`); return binary;
}
const mac = { skip: process.platform !== 'darwin' && 'requires macOS sandboxed image decoder' };
const example = new URL('../examples/character-marketplace/plugins/example-bit/sleight-characters/example-bit/', import.meta.url);

test('plugin group rows with warnings pass the actual native menu parser in dump mode', mac, t => {
  for (const name of ['Critters'.repeat(10), 'x' + '🐭'.repeat(40)]) {
    const rows = cursorMenuModel({ plugins: [{ name, pluginId: 'critters@demo', warning: 'Includes hooks',
      packs: [{ id: 'mouse', name: 'Mouse', key: 'b'.repeat(64) }, { id: 'done', name: 'Installed Mouse', key: 'c'.repeat(64) }] }], installed: [{ id: 'done', name: 'Installed Mouse' }] });
    const result = spawnSync(build(t), ['--cursor-menu-dump'], { input: JSON.stringify({ hand: 'picker', nonce: 'a'.repeat(64), op: 'catalog', rows }) + '\n',
      encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).rows, rows);
  }
});

test('sharing snapshot uses the real sandboxed decoder, including extra and perch sheets, without UI', mac, async t => {
  const pack = loadCharacter(example.pathname.slice(0, -1), { shared: true }); let bank;
  const checked = await withSharedCharacter(pack.files, { hostCheck: (frame, root) => {
    bank = root; assert.ok(frame.extra); assert.ok(frame.perchSheet);
    return checkCharacterInHost(build(t), frame, { root });
  } });
  assert.equal(checked.manifest.id, 'example-bit'); assert.equal(checked.resolved.filter(s => s.own).length, 19);
  assert.equal(fs.existsSync(bank), false); t.diagnostic(`packBytes=${pack.total} ownStates=19`);
});

test('real check refuses a non-sharing root, an unsafe sharing bank and corrupt image bytes', mac, async t => {
  const pack = loadCharacter(example.pathname.slice(0, -1), { shared: true });
  for (const badRoot of ['/', '/tmp', example.pathname.slice(0, -1)]) {
    await assert.rejects(withSharedCharacter(pack.files, { hostCheck: (frame) => checkCharacterInHost(build(t), frame, { root: badRoot }) }), /path/);
  }
  let bank;
  await assert.rejects(withSharedCharacter(pack.files, { hostCheck: (frame, root) => {
    bank = root; fs.chmodSync(root, 0o755); return checkCharacterInHost(build(t), frame, { root });
  } }), /path/);
  assert.equal(fs.existsSync(bank), false);
  await assert.rejects(withSharedCharacter(pack.files, { hostCheck: (frame, root) => {
    const bytes = fs.readFileSync(frame.sheet); bytes.fill(0, 41, bytes.length - 12); fs.writeFileSync(frame.sheet, bytes);
    return checkCharacterInHost(build(t), frame, { root });
  } }), /decode|child/);
});

test('make-character uses the shared generator and shine renderer for a custom v1 pack with 19 states', mac, t => {
  const bank = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join('/tmp', 'sleight-template-')))), output = join(bank, 'output');
  const generator = new URL('../tools/characters/', import.meta.url);
  const design = join(bank, 'my-character.mjs');
  fs.writeFileSync(design, `import original from ${JSON.stringify(pathToFileURL(join(generator.pathname, 'cast/tsugi.mjs')).href)};\nexport default {...original, id:'my-character', name:'My Character'};\n`);
  const result = spawnSync(process.execPath, [join(generator.pathname, 'build.mjs'), '--design', design, '--out', output],
    { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /19\/19 states/);
  const pack = loadCharacter(join(output, 'my-character'), { shared: true });
  assert.equal(pack.manifest.id, 'my-character'); assert.equal(pack.resolved.filter(s => s.own).length, 19);
  assert.equal(fs.existsSync(new URL('../plugins/sleight/skills/make-character/template/', import.meta.url)), false);
  t.diagnostic(`customPackBytes=${pack.total}`);
});
