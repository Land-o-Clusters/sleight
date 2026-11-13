// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanHistory } from '../scripts/release-history-scan.mjs';
import { privateIdentity } from '../scripts/lib/public-privacy.mjs';

const script = fileURLToPath(new URL('../scripts/release-history-scan.mjs', import.meta.url));
function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rel1-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const commit = (name, text) => {
    writeFileSync(join(dir, name), text);
    git('add', '--', name); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture change', '--', name);
    return git('rev-parse', 'HEAD');
  };
  const base = commit('public.txt', 'public fixture\n');
  git('update-ref', 'refs/remotes/origin/main', base);
  return { dir, git, commit, base };
}

test('scan reports private additions by commit and file even after the final tree is clean', async t => {
  const { dir, commit, base } = repository(t);
  const identity = { home: `${MAC_USERS}fixture.user`, username: 'fixture.user' };
  const bad = commit('private file.txt', `public fixture\n++ ${MAC_USERS}fixture.user/private\nfixture.user\n`);
  commit('private file.txt', 'public fixture\n');
  const hits = [];
  const result = await scanHistory({ cwd: dir, range: `${base}..HEAD`, identity, onHit: hit => hits.push(hit) });
  assert.equal(result.hits, 2);
  assert.deepEqual(hits.map(h => [h.commit, h.file, h.line]), [[bad, 'private file.txt', 2], [bad, 'private file.txt', 3]]);
  assert.deepEqual(hits[0].matches, ['home path', 'username']);
  assert.deepEqual(await scanHistory({ cwd: dir, range: 'HEAD~1..HEAD', identity }), { hits: 0 });
});

test('CLI defaults to origin/main..HEAD, exits 1 on hits, and never echoes private lines', t => {
  const { dir, commit } = repository(t);
  const clean = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr);
  const { home } = privateIdentity();
  const bad = commit('private.txt', `${home}/private-fixture\n`);
  const hit = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
  assert.equal(hit.status, 1, hit.stderr);
  assert.ok(hit.stdout.includes(bad));
  assert.match(hit.stdout, /private\.txt/);
  assert.match(hit.stdout, /home path/);
  assert.equal(hit.stdout.includes(home), false);
  assert.equal(hit.stdout.includes('private-fixture'), false);
  const badRange = spawnSync(process.execPath, [script, 'missing-ref..HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.equal(badRange.status, 1);
  assert.match(badRange.stderr, /git log failed/);
  const option = spawnSync(process.execPath, [script, '--all'], { cwd: dir, encoding: 'utf8' });
  assert.equal(option.status, 1);
  assert.match(option.stderr, /revision range/);
});

test('history scan skips generic and short usernames while still detecting their home paths', async t => {
  const { dir, commit, base } = repository(t);
  commit('ci.txt', 'runner abc\n/home/ci-fixture/private\n');
  assert.deepEqual(await scanHistory({ cwd: dir, range: `${base}..HEAD`, identity: { home: '/fixture', username: 'runner' } }), { hits: 0 });
  assert.deepEqual(await scanHistory({ cwd: dir, range: `${base}..HEAD`, identity: { home: '/fixture', username: 'abc' } }), { hits: 0 });
  assert.deepEqual(await scanHistory({ cwd: dir, range: `${base}..HEAD`, identity: { home: '/home/ci-fixture', username: 'runner' } }), { hits: 1 });
});

test('scan includes private additions made only by a merge commit', async t => {
  const { dir, git, commit, base } = repository(t);
  const first = commit('first.txt', 'first branch\n');
  git('checkout', '-q', '--detach', base);
  const second = commit('second.txt', 'second branch\n');
  writeFileSync(join(dir, 'merge.txt'), `${MAC_USERS}fixture.user/merge-only\n`);
  git('add', '--', 'merge.txt');
  const tree = git('write-tree');
  const merge = git('commit-tree', tree, '-p', first, '-p', second, '-m', 'Fixture merge');
  git('update-ref', 'HEAD', merge);
  const hits = [];
  const result = await scanHistory({ cwd: dir, range: `${base}..HEAD`,
    identity: { home: `${MAC_USERS}fixture.user`, username: 'fixture.user' }, onHit: hit => hits.push(hit) });
  assert.equal(result.hits, 1);
  assert.equal(hits[0].commit, merge);
  assert.equal(hits[0].file, 'merge.txt');
});
