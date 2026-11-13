import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { prepareMabel } from '../bench/hand/check4-build.mjs';
import { installStageCharacter } from '../bench/hand/stage-live.mjs';
import { checkBuiltinCharacter, loadCharacter, resolveCharacterStates } from '../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../plugins/sleight/lib/hand/character-frame.mjs';

test('private Mabel materializes cached strips and sends 21 real stage states instead of silent medium fallback', async t => {
  const source = readFileSync(new URL('../bench/hand/check4-build.mjs', import.meta.url), 'utf8');
  assert.match(source, /cached.stagePins/, 'the baseline copies only the base pack files');
  const root = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-check4-assets-'))));
  const stage = loadCharacter(installStageCharacter(root).folder), original = checkBuiltinCharacter('mabel');
  const pins = Object.fromEntries([...stage.files].filter(([name]) => name.startsWith('stage/'))
    .map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
  const cached = { ...original, manifest: { ...original.manifest, stage: stage.manifest.stage },
    stageFolder: stage.folder, stagePins: pins };
  const cache = { ensure: async () => cached };
  const work = join(root, 'private'); mkdirSync(work);
  const answer = await prepareMabel(work, { original, cache });
  const pack = loadCharacter(answer.folder);
  const frame = characterFrame(pack, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates, size: 'stage' });
  assert.equal(Object.values(pack.stage.states).filter(s => s.own).length, 21);
  assert.equal(Object.values(frame.stage.table).filter(s => s.file).length, 21);
  assert.ok(Object.values(frame.stage.table).every(s => s.file.startsWith(answer.folder + '/stage/')));
  assert.equal(frame.size, 'stage');
  const changed = join(root, 'changed'); mkdirSync(changed);
  await assert.rejects(prepareMabel(changed, { original, cache: { ensure: async () => ({ ...cached,
    stagePins: { ...pins, [Object.keys(pins)[0]]: '0'.repeat(64) } }) } }), /strip changed/);
  const missing = join(root, 'missing'); mkdirSync(missing);
  await assert.rejects(prepareMabel(missing, { original, cache: { ensure: async () => ({ ...cached, stagePins: {} }) } }), /missing stage art/);
});
