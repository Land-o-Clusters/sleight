import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCast, CAST, swiftPins } from '../tools/characters/build.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { builtinCharactersDirectory } from '../plugins/sleight/lib/hand/character.mjs';
test('the six packs rebuild byte for byte with the pinned raster and lossless encoder', { skip: process.platform !== 'darwin', timeout: 1200000 }, async t => {
  const base = registerTemp(t, fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-character-rebuild-'))));
  const output = join(base, 'characters'), manifest = await buildCast(output), committed = builtinCharactersDirectory();
  assert.deepEqual(manifest, JSON.parse(fs.readFileSync(join(committed, 'manifest.json'))));
  for (const id of CAST) for (const name of Object.keys(manifest.packs[id])) {
    assert.deepEqual(fs.readFileSync(join(output, id, name)), fs.readFileSync(join(committed, id, name)), `${id}/${name}`);
  }
});
test('native built-in pins match the package hash manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(join(builtinCharactersDirectory(), 'manifest.json')));
  const source = fs.readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  assert.ok(source.includes(swiftPins(manifest)));
});
