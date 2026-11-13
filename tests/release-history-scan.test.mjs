import { assertChildStatus } from './fixtures/child-status.mjs';
// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanHistory } from '../scripts/release-history-scan.mjs';
import { privateIdentity } from '../scripts/lib/public-privacy.mjs';

const script = fileURLToPath(new URL('../scripts/release-history-scan.mjs', import.meta.url));
function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rel1-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' }).trim();
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
  const clean = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(clean, 0, clean.stderr);
  const { home } = privateIdentity();
  const bad = commit('private.txt', `${home}/private-fixture\n`);
  const hit = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(hit, 1, hit.stderr);
  assert.ok(hit.stdout.includes(bad));
  assert.match(hit.stdout, /private\.txt/);
  assert.match(hit.stdout, /home path/);
  assert.equal(hit.stdout.includes(home), false);
  assert.equal(hit.stdout.includes('private-fixture'), false);
  const badRange = spawnSync(process.execPath, [script, 'missing-ref..HEAD'], { cwd: dir, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(badRange, 1);
  assert.match(badRange.stderr, /git log failed/);
  const option = spawnSync(process.execPath, [script, '--all'], { cwd: dir, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(option, 1);
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

const identity = { home: '/fixture/dummy.user', username: 'dummy.user' };
for (const [name, text, expectedLines] of [
  ['lone CR before identity', `x\r${identity.home}/private\n`, [1]],
  ['diff header after CR', `x\rdiff --git a b\n${identity.home}/private\n`, [2]],
  ['hunk header after CR', `x\r@@ -1 +100 @@\n${identity.home}/private\n`, [2]],
  ['commit marker after CR', `x\r\0${'a'.repeat(40)}\n${identity.home}/private\n`, [2]],
  ['CRLF', `public\r\n${identity.home}/private\r\n`, [2]],
  ['long line crossing stream chunks', `${'x'.repeat(512 * 1024)}\r${identity.home}/private\n`, [1]],
  // Stripping CR would invent an identity match that was never present in the file.
  ['CR inside identity is preserved', '/fixture/dummy.\ruser/private\n', []],
]) {
  test(`history scan preserves content and line numbers: ${name}`, async t => {
    const { dir, commit, base } = repository(t);
    // Force a text diff for the NUL fixture, which Git would otherwise treat as binary.
    commit('.gitattributes', '*.txt diff\n');
    const revision = commit('cr.txt', text);
    const hits = [];
    const result = await scanHistory({ cwd: dir, range: `${base}..HEAD`, identity, onHit: hit => hits.push(hit) });
    assert.equal(result.hits, expectedLines.length);
    assert.deepEqual(hits.map(h => [h.commit, h.file, h.line]), expectedLines.map(line => [revision, 'cr.txt', line]));
  });
}

// Replace only the Git process boundary so malformed output can reach the real parser.
async function scanGitOutput(t, output, onHit) {
  const mock = t.mock.method(childProcess, 'spawn', () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Readable.from(typeof output === 'string' ? [output] : output, { objectMode: false }),
      stderr: new PassThrough(),
    });
    child.stdout.once('end', () => {
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  });
  syncBuiltinESMExports();
  try { return await scanHistory({ identity, onHit }); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
}

const patchHeader = `\0${'b'.repeat(40)}\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n`;

for (const line of ['unprefixed private fixture', '\rhidden', 'diff --git a b', `\0${'a'.repeat(40)}`]) {
  test(`history scan refuses an unrecognized in-hunk line ${JSON.stringify(line)}`, async t => {
    // The valid context closes the hunk, so EOF cannot mask a missing unknown-line check.
    const patch = `${patchHeader}@@ -1 +1 @@\n${line}\n public\n`;
    await assert.rejects(scanGitOutput(t, patch), /unrecognized line/i);
  });
}

test('history scan refuses an incomplete hunk containing only valid lines at EOF', async t => {
  await assert.rejects(scanGitOutput(t, `${patchHeader}@@ -1,2 +1,2 @@\n public\n`), /incomplete Git hunk/i);
});

for (const [name, hunk] of [
  ['addition', '@@ -1 +0,0 @@\n+unexpected\n-old\n'],
  ['deletion', '@@ -0,0 +1 @@\n-unexpected\n+new\n'],
]) {
  test(`history scan refuses a hunk-count overflow from ${name}`, async t => {
    await assert.rejects(scanGitOutput(t, patchHeader + hunk), /unrecognized line/i);
  });
}

for (const header of ['@@ -invalid +1 @@', '@@-1 +1 @@']) {
  test(`history scan refuses a malformed hunk header without an open hunk ${JSON.stringify(header)}`, async t => {
    await assert.rejects(scanGitOutput(t, `${patchHeader}${header}\n`), /unrecognized Git hunk/i);
  });
}

for (const line of ['+extra', '-extra', ' extra']) {
  test(`history scan refuses a counted line outside a complete hunk ${JSON.stringify(line)}`, async t => {
    await assert.rejects(scanGitOutput(t, `${patchHeader}@@ -1 +1 @@\n public\n${line}\n`), /unrecognized line/i);
  });
}

test('history scan counts bare empty context and preserves the next addition line number', async t => {
  const hits = [];
  assert.deepEqual(await scanGitOutput(t, `${patchHeader}@@ -1 +1,2 @@\n\n+${identity.home}/private\n`, hit => hits.push(hit)), { hits: 1 });
  assert.equal(hits[0].line, 2);
});

test('history scan pins blank context and path prefixes despite repository diff config', async t => {
  const { dir, git, commit, base } = repository(t);
  mkdirSync(join(dir, 'b'));
  commit('b/config.txt', 'before\n\nafter\n');
  const revision = commit('b/config.txt', `before\n\n${identity.home}/private\n`);
  git('config', 'diff.suppressBlankEmpty', 'true');
  // Verify the scratch repository really emits a bare blank context line.
  assert.match(git('log', '-1', '--format=', '-p'), /\n\n-after\n/);
  git('config', 'diff.noprefix', 'true');
  git('config', 'diff.mnemonicPrefix', 'true');
  git('config', 'diff.srcPrefix', 'old/');
  git('config', 'diff.dstPrefix', 'new/');
  const actualSpawn = childProcess.spawn;
  const calls = [];
  let configuredBlanks = false;
  const mock = t.mock.method(childProcess, 'spawn', (...args) => {
    calls.push(args);
    if (configuredBlanks) {
      // Exercise real suppressed blank output as well as the pinned invocation.
      const gitArgs = [...args[1]];
      const setting = gitArgs.indexOf('diff.suppressBlankEmpty=false');
      assert.equal(gitArgs[setting - 1], '-c');
      gitArgs.splice(setting - 1, 2);
      return actualSpawn(args[0], gitArgs, args[2]);
    }
    return actualSpawn(...args);
  });
  syncBuiltinESMExports();
  const hits = [];
  try {
    assert.deepEqual(await scanHistory({ cwd: dir, range: `${base}..HEAD`, identity, onHit: hit => hits.push(hit) }), { hits: 1 });
    assert.deepEqual(hits.map(h => [h.commit, h.file, h.line]), [[revision, 'b/config.txt', 3]]);
    assert.ok(calls[0][1].some((arg, i, args) => arg === '-c' && args[i + 1] === 'diff.suppressBlankEmpty=false'));
    configuredBlanks = true;
    hits.length = 0;
    assert.deepEqual(await scanHistory({ cwd: dir, range: `${base}..HEAD`, identity, onHit: hit => hits.push(hit) }), { hits: 1 });
    assert.deepEqual(hits.map(h => [h.commit, h.file, h.line]), [[revision, 'b/config.txt', 3]]);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('history scan consumes a 32 MiB single line across chunks in under 500 ms', async t => {
  const bytes = 32 * 1024 * 1024;
  const chunk = 'x'.repeat(64 * 1024);
  function* chunks() {
    yield `${patchHeader}@@ -0,0 +1 @@\n+`;
    for (let i = 0; i < bytes / chunk.length; i++) yield chunk;
    yield `${identity.home}/private\n`;
  }
  const start = performance.now();
  assert.deepEqual(await scanGitOutput(t, chunks()), { hits: 1 });
  const elapsed = performance.now() - start;
  t.diagnostic(`32 MiB line scan: ${elapsed.toFixed(3)} ms`);
  assert.ok(elapsed < 500, `32 MiB line scan took ${elapsed.toFixed(3)} ms (limit 500 ms)`);
});

test('history scan counts context and deletions across hunks and files without a final LF', async t => {
  const { dir, commit, base } = repository(t);
  const lines = Array.from({ length: 40 }, (_, i) => `public line ${i + 1}`);
  commit('context.txt', lines.join('\n'));
  lines[1] = `${identity.home}/first`;
  lines[39] = `${identity.home}/last`;
  const revision = commit('context.txt', lines.join('\n'));
  commit('context.txt', '');
  const hits = [];
  assert.deepEqual(await scanHistory({ cwd: dir, range: `${base}..HEAD`, identity, onHit: hit => hits.push(hit) }), { hits: 2 });
  assert.deepEqual(hits.map(h => [h.commit, h.file, h.line]), [[revision, 'context.txt', 2], [revision, 'context.txt', 40]]);
});
