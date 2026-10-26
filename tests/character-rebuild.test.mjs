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
