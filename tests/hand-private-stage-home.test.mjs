import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { privateStageHome } from '../bench/hand/private-stage-home.mjs';
test('both benchmark builds redirect all native home writes to their owned temporary bank', t => {
  const work = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-private-home-'))));
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const built = privateStageHome(source, work);
  assert.doesNotMatch(built, /FileManager\.default\.homeDirectoryForCurrentUser|NSHomeDirectory\(\)/);
  assert.match(built, /init\(root: String = stageBenchHome\.appendingPathComponent/);
  assert.equal(statSync(join(work, 'host-home')).mode & 0o777, 0o700);
  const systemTemp = realpathSync('/tmp');
  for (const path of ['../outside', '/tmp/alias', `${systemTemp}/../outside`]) assert.throws(() => privateStageHome(source, path));
  for (const file of ['check4-build.mjs', 'stage-live.mjs']) assert.match(readFileSync(new URL('../bench/hand/' + file, import.meta.url), 'utf8'), /privateStageHome\(/);
});
