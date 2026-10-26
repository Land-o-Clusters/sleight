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
import { sheetEncoding, encodeSheet, buildCast as installedBuild } from '../plugins/sleight/skills/make-character/tool/build.mjs';
import { contactSheet } from '../plugins/sleight/skills/make-character/tool/lib/contact.mjs';

test('repository and installed entry points share one builder, with tested custom WebP only', () => {
  assert.equal(buildCast, installedBuild);
  for (const version of ['0.6.1', '1.6.0', '1.7.0', 'future']) {
    assert.equal(sheetEncoding(true, () => version), version === '1.6.0' ? 'webp' : 'png');
    if (version !== '1.6.0') assert.throws(() => sheetEncoding(false, () => version), /requires cwebp 1.6.0/);
  }
  assert.equal(sheetEncoding(true, () => { throw Error('ENOENT'); }), 'png');
  assert.throws(() => sheetEncoding(false, () => { throw Error('ENOENT'); }), /ENOENT/);
});

test('custom sheets fall back to PNG when a present encoder fails; built-in encoding still fails', t => {
  const base = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join('/tmp', 'sleight-encode-fallback-'))));
  const png = join(base, 'atlas.png'), webp = join(base, 'atlas.webp'), bytes = Buffer.from('PNG fixture');
  fs.writeFileSync(png, bytes); fs.writeFileSync(webp, 'partial WebP');
  const run = () => { throw Error('encoder failed'); };
  assert.deepEqual(encodeSheet(png, webp, { extension: 'webp', custom: true, run }), { extension: 'png', bytes });
  assert.throws(() => encodeSheet(png, webp, { extension: 'webp', custom: false, run }), /encoder failed/);
});

test('both build entry points execute through symlink paths', async t => {
  const base = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join('/tmp', 'sleight-build-entry-'))));
  const { spawnSync } = await import('node:child_process');
  for (const entry of ['../tools/characters/build.mjs', '../plugins/sleight/skills/make-character/tool/build.mjs']) {
    const linked = join(base, 'build.mjs'); fs.symlinkSync(new URL(entry, import.meta.url).pathname, linked);
    const result = spawnSync(process.execPath, [linked, '--bad-argument'], { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Usage:/); fs.unlinkSync(linked);
  }
});

test('output with a symlink ancestor refuses before rendering or creating a directory', async t => {
  const base = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join('/tmp', 'sleight-build-output-'))));
  const linked = join(base, 'linked'), output = join(linked, 'new-parent/output'); fs.symlinkSync(base, linked);
  const design = join(base, 'design.mjs'); fs.writeFileSync(design, "export default {id:'my-character',style:'anime'};");
  await assert.rejects(buildCast(output, { design }), /output.*symlink/i);
  assert.equal(fs.existsSync(join(base, 'new-parent')), false);
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
