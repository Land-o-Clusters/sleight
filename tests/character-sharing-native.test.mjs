import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { trackTemp, registerTemp } from '../scripts/temp-leftovers.mjs';
import { loadCharacter } from '../plugins/sleight/lib/hand/character.mjs';
import { withSharedCharacter, importCharacterArchive } from '../plugins/sleight/lib/hand/character-sharing.mjs';
import { encodeCharacterArchive } from '../plugins/sleight/lib/hand/character-archive.mjs';
import { checkCharacterInHost } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { cursorMenuModel } from '../plugins/sleight/lib/hand/cursor-picker.mjs';
import { decodePNG } from '../plugins/sleight/skills/make-character/tool/lib/png.mjs';

let binary;
function build(t) {
  if (binary) return binary;
  const bank = trackTemp(fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-sharing-native-')))); binary = join(bank, 'host');
  const source = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
  assert.match(fs.readFileSync(source, 'utf8'), /if arguments.first == "--check-character"/);
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'module-cache'), source.pathname, '-o', binary], { encoding: 'utf8', timeout: 300000 });
  assert.equal(result.status, 0, result.stderr); t.diagnostic(`binaryBytes=${fs.statSync(binary).size}`); return binary;
}
const mac = { skip: process.platform !== 'darwin' && 'requires macOS sandboxed image decoder' };
const example = new URL('../examples/character-marketplace/plugins/example-bit/sleight-characters/example-bit/', import.meta.url);

test('plugin group rows with warnings pass the actual native menu parser in dump mode', mac, t => {
  for (const name of ['Critters'.repeat(10), 'x' + '🐭'.repeat(40)]) {
    const rows = cursorMenuModel({ plugins: [{ name, pluginId: 'critters@demo', warning: 'Includes hooks',
      packs: [{ id: 'mouse', name: 'Mouse', key: 'b'.repeat(64) }, { id: 'done', name: 'Installed Mouse', key: 'c'.repeat(64) }],
      skipped: [{ id: 'bit', reason: 'built-in character id is reserved' }] },
      { pluginId: 'Claude plugins', reason: 'plugins folder resolves outside the user home', packs: [] }], installed: [{ id: 'done', name: 'x'.repeat(48) + '🐭', builtin: true }] });
    const result = spawnSync(build(t), ['--cursor-menu-dump'], { input: JSON.stringify({ hand: 'picker', nonce: 'a'.repeat(64), op: 'catalog', rows }) + '\n',
      encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).rows, rows);
  }
});

test('native menu parser refuses malformed skipped rows without drawing UI', mac, t => {
  const row = { title: 'Broken (skipped)', op: 'skipped', reason: 'Invalid character' };
  for (const malformed of [{ ...row, key: 'b'.repeat(64) }, { ...row, reason: 'bad\u202ereason' },
    { ...row, reason: 'x'.repeat(1001) }, { ...row, title: 'x'.repeat(61) }]) {
    const result = spawnSync(build(t), ['--cursor-menu-dump'], { input: JSON.stringify({ hand: 'picker', nonce: 'a'.repeat(64),
      op: 'catalog', rows: [{ title: 'Plugin', children: [malformed] }] }) + '\n', encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 65, JSON.stringify({ malformed, stdout: result.stdout, stderr: result.stderr }));
  }
  t.diagnostic('malformedSkippedRows=4 refused=4');
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

test('the minimal installed generator builds WebP and PNG, including encode failure, with contact sheets', mac, async t => {
  const bank = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join('/tmp', 'sleight-template-'))));
  const installed = join(bank, 'installed-plugin');
  fs.mkdirSync(join(installed, 'skills/make-character'), { recursive: true });
  fs.mkdirSync(join(installed, 'lib/hand'), { recursive: true });
  fs.cpSync(new URL('../plugins/sleight/skills/make-character/tool/', import.meta.url), join(installed, 'skills/make-character/tool'), { recursive: true });
  fs.copyFileSync(new URL('../plugins/sleight/lib/hand/character.mjs', import.meta.url), join(installed, 'lib/hand/character.mjs'));
  assert.equal(fs.existsSync(join(bank, 'tools')), false);
  const generator = join(installed, 'skills/make-character/tool'), design = join(bank, 'my-character.mjs');
  fs.writeFileSync(design, fs.readFileSync(join(generator, 'cast/tsugi.mjs'), 'utf8').replace("id: 'tsugi'", "id: 'my-character'"));
  const emptyPath = join(bank, 'empty-bin'); fs.mkdirSync(emptyPath);
  const failedPath = join(bank, 'failed-bin'); fs.mkdirSync(failedPath);
  fs.writeFileSync(join(failedPath, 'cwebp'), '#!/bin/sh\nif [ "$1" = "-version" ]; then echo 1.6.0; exit 0; fi\nexit 1\n', { mode: 0o700 });
  for (const [mode, encoding, path] of [['webp', 'webp'], ['png', 'png', emptyPath], ['encode-failed', 'png', failedPath]]) {
    const output = join(bank, mode), result = spawnSync(process.execPath, [join(generator, 'build.mjs'), '--design', design, '--out', output],
      { cwd: bank, env: { ...process.env, ...path ? { PATH: path } : {} }, encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /19\/19 states/);
    const pack = loadCharacter(join(output, 'my-character'), { shared: true });
    assert.equal(pack.manifest.id, 'my-character'); assert.equal(pack.resolved.filter(s => s.own).length, 19);
    assert.equal(pack.manifest.sheet, `sheet.${encoding}`);
    assert.equal(pack.manifest.extra, `extra.${encoding}`); assert.equal(pack.manifest.perch.sheet, `perch.${encoding}`);
    assert.ok([...pack.files.keys()].every(name => !name.includes('-light') && !name.includes('-dark')));
    const review = join(output, 'review/my-character'); assert.equal(fs.readdirSync(review).length, 6);
    for (const sheet of ['sheet', 'extra', 'perch']) for (const theme of ['light', 'dark']) {
      const img = decodePNG(fs.readFileSync(join(review, `${sheet}-${theme}.png`)));
      assert.equal(img.width, 768); assert.equal(img.height, sheet === 'perch' ? 312 : 1144);
      assert.deepEqual([...img.data.subarray(0, 4)], theme === 'light' ? [245, 245, 245, 255] : [28, 28, 32, 255]);
    }
    const checked = await withSharedCharacter(pack.files, { hostCheck: (frame, root) => checkCharacterInHost(build(t), frame, { root }) });
    assert.equal(checked.resolved.filter(s => s.own).length, 19);
    const archive = join(bank, mode + '.sleightchar'); fs.writeFileSync(archive, encodeCharacterArchive(pack.files));
    const root = join(bank, mode + '-installed');
    await importCharacterArchive(archive, { root, hostCheck: (frame, bank) => checkCharacterInHost(build(t), frame, { root: bank }) });
    const imported = loadCharacter(join(root, 'my-character'), { installed: true });
    assert.deepEqual(imported.files, pack.files);
    t.diagnostic(`${mode} customPackBytes=${pack.total} ownStates=19 contactSheets=6`);
  }
});

test('temporary bank checks ignore every built-in lookup even when a frame uses a built-in id', mac, async t => {
  const original = loadCharacter(example.pathname.slice(0, -1), { shared: true });
  for (const id of ['bit', 'kit', 'shizu', 'tab', 'tsugi', 'yori']) {
    const files = new Map(original.files), manifest = { ...original.manifest, id };
    files.set('character.json', Buffer.from(JSON.stringify(manifest)));
    const checked = await withSharedCharacter(files, { hostCheck: (frame, root) => checkCharacterInHost(build(t), frame, { root }) });
    assert.equal(checked.manifest.id, id);
  }
});
