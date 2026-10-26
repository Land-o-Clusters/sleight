import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCast, CAST, swiftPins } from '../tools/characters/build.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { rebuildSkipReason } from '../tools/characters/toolchain.mjs';
import { loadCharacter } from '../plugins/sleight/lib/hand/character.mjs';
import { builtinCharactersDirectory } from '../plugins/sleight/lib/hand/character.mjs';
import { sheetEncoding, buildCast as installedBuild } from '../plugins/sleight/skills/make-character/tool/build.mjs';
import { contactSheet } from '../plugins/sleight/skills/make-character/tool/lib/contact.mjs';

test('repository and installed entry points share one builder, with optional unpinned custom WebP', () => {
  assert.equal(buildCast, installedBuild);
  for (const version of ['0.6.1', '1.6.0', '1.7.0', 'future']) {
    assert.equal(sheetEncoding(true, () => version), 'webp');
    if (version !== '1.6.0') assert.throws(() => sheetEncoding(false, () => version), /requires cwebp 1.6.0/);
  }
  assert.equal(sheetEncoding(true, () => { throw Error('ENOENT'); }), 'png');
  assert.throws(() => sheetEncoding(false, () => { throw Error('ENOENT'); }), /ENOENT/);
});

test('contact sheets composite all four source pixels before reducing the cell size', () => {
  const image = { width: 2, height: 2, data: Buffer.from([200, 100, 50, 255, 1, 2, 3, 0, 200, 100, 50, 255, 4, 5, 6, 0]) };
  assert.deepEqual(contactSheet(image, 'light'), { width: 1, height: 1, data: Buffer.from([223, 173, 148, 255]) });
  assert.deepEqual(contactSheet(image, 'dark'), { width: 1, height: 1, data: Buffer.from([114, 64, 41, 255]) });
});
test('the six packs rebuild with the approved manifests, states, dimensions and alpha structure', { skip: rebuildSkipReason(), timeout: 1200000 }, async t => {
  const base = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-character-rebuild-'))));
  const output = join(base, 'characters'), manifest = await buildCast(output), committed = builtinCharactersDirectory();
  for (const id of CAST) {
    const rebuilt = loadCharacter(join(output, id), { shared: true });
    const approved = loadCharacter(join(committed, id), { shared: true });
    assert.deepEqual(rebuilt.manifest, approved.manifest, id);
    assert.deepEqual(rebuilt.resolved, approved.resolved, id);
    assert.deepEqual(rebuilt.sheets, approved.sheets, id);
    assert.deepEqual(rebuilt.warnings, [], id);
    assert.deepEqual(Object.keys(manifest.packs[id]), [...approved.files.keys()].sort(), id);
  }
});
test('native built-in pins match the package hash manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(join(builtinCharactersDirectory(), 'manifest.json')));
  const source = fs.readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  assert.ok(source.includes(swiftPins(manifest)));
});

test('raster qualification skips unsupported or missing toolchains with a reason', () => {
  assert.match(rebuildSkipReason({ platform: 'linux' }), /macOS/);
  assert.match(rebuildSkipReason({ platform: 'darwin', run: () => { throw Error('ENOENT'); } }), /unavailable/);
  const run = (encoder, os) => command => command === 'cwebp' ? encoder : os;
  assert.match(rebuildSkipReason({ platform: 'darwin', run: run('1.7.0', '27.0.1') }), /untested cwebp/);
  assert.match(rebuildSkipReason({ platform: 'darwin', run: run('1.6.0', '27.1') }), /untested macOS/);
  assert.equal(rebuildSkipReason({ platform: 'darwin', run: run('1.6.0', '27.0.1') }), false);
});

test('custom designs reject reserved ids, traversal, unknown styles and existing outputs before rendering', async t => {
  const base = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join('/tmp', 'sleight-custom-design-'))));
  const output = join(base, 'output');
  for (const [id, style, reason] of [['bit', 'anime', /non-built-in/], ['../escape', 'anime', /non-built-in/],
    ['my-character', 'constructor', /Unknown custom design style/]]) {
    const design = join(base, 'design-' + Math.random().toString(16).slice(2) + '.mjs');
    fs.writeFileSync(design, `export default ${JSON.stringify({ id, style })};`);
    await assert.rejects(buildCast(output, { design }), reason);
    assert.equal(fs.existsSync(output), false);
  }
  fs.mkdirSync(output);
  const design = join(base, 'existing.mjs'); fs.writeFileSync(design, "export default {id:'my-character',style:'anime'};");
  await assert.rejects(buildCast(output, { design }), /must be new/);
  assert.deepEqual(fs.readdirSync(output), []);
});
