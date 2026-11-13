// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateIdentity, privateMatches, privateTrackedPath } from '../scripts/lib/public-privacy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('private identity checks use literal home and username values and exempt generic CI users', () => {
  const identity = { home: `${MAC_USERS}fixture.user`, username: 'fixture.user' };
  assert.deepEqual(privateMatches(`${MAC_USERS}fixture.user/file`, identity), ['home path', 'username']);
  assert.deepEqual(privateMatches('fixtureXuser', identity), []);
  for (const username of ['abc', 'runner', 'root', 'gitlab-runner', 'circleci']) {
    assert.deepEqual(privateMatches(username, { home: '/home/fixture', username }), []);
    assert.deepEqual(privateMatches('/home/fixture/file', { home: '/home/fixture', username }), ['home path']);
  }
  assert.deepEqual(privateMatches('~/fixture', identity), []);
});

test('private evidence and root reports are forbidden while nested public reports remain allowed', () => {
  assert.equal(privateTrackedPath('race-1017/private.json'), 'private evidence directory');
  assert.equal(privateTrackedPath('vp1-REPORT.md'), 'root lane report');
  assert.equal(privateTrackedPath('docs/example-REPORT.md'), null);
  assert.equal(privateTrackedPath('bench/validation/audit-140.mjs'), null);
});

test('every tracked file is safe for the public tree', () => {
  const identity = privateIdentity();
  const files = execFileSync('/usr/bin/git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.length, 'No tracked files were inspected');
  const hits = [];
  for (const file of files) {
    const forbidden = privateTrackedPath(file);
    if (forbidden) hits.push(`${file}: ${forbidden}`);
    for (const kind of privateMatches(readFileSync(join(root, file)).toString('utf8'), identity)) {
      hits.push(`${file}: ${kind}`);
    }
  }
  assert.deepEqual(hits, [], `Public tree contains private material:\n${hits.join('\n')}`);
});
