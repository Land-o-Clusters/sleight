import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check4Options, check4CostOptions, main } from '../bench/hand/check4.mjs';

const away = join(tmpdir(), 'away'), envAway = join(tmpdir(), 'env-away'), gone = join(tmpdir(), 'gone');
const bank = join(tmpdir(), 'b');

// 2026-11-10 00:32Z: check 4's cost phase started the stage fixture without the owner-away marker,
// so the fixture refused to raise the changing backdrop and every changing unit failed.
test('check 4 reads the owner-away marker from its flag or SLEIGHT_OWNER_AWAY_FILE', () => {
  assert.equal(check4Options(['--owner-away-file', away], {}).ownerAwayFile, away);
  assert.equal(check4Options([], { SLEIGHT_OWNER_AWAY_FILE: envAway }).ownerAwayFile, envAway);
  assert.equal(check4Options([], {}).ownerAwayFile, undefined);
  assert.throws(() => check4Options(['--owner-away-file'], {}), /Unexpected/);
});
test('the cost phase hands the marker to the stage adapter', () => {
  assert.deepEqual(check4CostOptions({ ownerAwayFile: away }, { character: '/c', out: bank }),
    { ownerAway: true, size: 'all', character: '/c', out: join(bank, 'costs'), ownerAwayFile: away });
  const source = readFileSync(new URL('../bench/hand/check4-live.mjs', import.meta.url), 'utf8');
  assert.match(source, /runLiveStage\(check4CostOptions\(opts, \{ character: mabel\.folder, out \}\)/);
});
test('a live run with costs refuses before any task when the marker is absent', async () => {
  const live = async () => 'ran';
  await assert.rejects(main(['--owner-away'], { live, env: {}, exists: () => true }), /owner-away-file/);
  await assert.rejects(main(['--owner-away', '--owner-away-file', gone], { live, env: {}, exists: () => false }), /owner-away-file/);
  assert.equal(await main(['--owner-away', '--owner-away-file', away], { live, env: {}, exists: () => true }), 'ran');
  assert.equal(await main(['--owner-away', '--skip-costs'], { live, env: {}, exists: () => false }), 'ran');
});
