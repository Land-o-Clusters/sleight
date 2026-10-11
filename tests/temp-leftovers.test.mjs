import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/temp-leftovers.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAST = new Date(Date.now() - 7 * 60 * 60 * 1000);

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env },
  });
}

function tempRoots() {
  const roots = [];
  for (const raw of [process.env.TMPDIR, tmpdir(), '/private/tmp', '/tmp']) {
    if (!raw) continue;
    try { roots.push(realpathSync(raw)); } catch { roots.push(raw); }
  }
  return [...new Set(roots)];
}

function listPrefix(prefix) {
  const found = [];
  for (const base of tempRoots()) {
    try {
      for (const name of readdirSync(base)) {
        if (name.startsWith(prefix)) found.push(join(base, name));
      }
    } catch {}
  }
  return [...new Set(found)].sort();
}

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'sleight-leftovers-harness-'));
  t.after(() => { if (process.env.SLEIGHT_KEEP_TEMP !== '1') rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('lists old sleight folders without removing them and skips sleight-bench', t => {
  const root = harness(t);
  const oldDir = mkdtempSync(join(root, 'sleight-old-'));
  const newDir = mkdtempSync(join(root, 'sleight-new-'));
  const other = mkdtempSync(join(root, 'other-'));
  mkdirSync(join(root, 'sleight-bench'));
  writeFileSync(join(oldDir, 'note.txt'), 'x');
  utimesSync(oldDir, PAST, PAST);
  const listed = run(['--root', root]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /sleight-old/);
  assert.match(listed.stdout, /sleight-old-.*\n|sleight-old/);
  assert.doesNotMatch(listed.stdout, /sleight-new-/);
  assert.doesNotMatch(listed.stdout, /other-/);
  assert.doesNotMatch(listed.stdout, /sleight-bench/);
  assert.equal(existsSync(oldDir), true);
  assert.equal(existsSync(newDir), true);
  assert.equal(existsSync(other), true);
  assert.equal(existsSync(join(root, 'sleight-bench')), true);
});

test('refuses a path that is not a sleight- folder', t => {
  const root = harness(t);
  const other = mkdtempSync(join(root, 'other-'));
  const listed = run(['--root', root, other]);
  assert.notEqual(listed.status, 0);
  assert.match(`${listed.stderr}${listed.stdout}`, /refuses a path that is not sleight-/);
  assert.equal(existsSync(other), true);
  const removed = run(['--remove', other]);
  assert.notEqual(removed.status, 0);
  assert.match(`${removed.stderr}${removed.stdout}`, /refuses a path that is not sleight-/);
  assert.equal(existsSync(other), true);
});

test('--remove deletes only old sleight folders and leaves a held-open one', t => {
  const root = harness(t);
  const oldDir = mkdtempSync(join(root, 'sleight-old-'));
  const held = mkdtempSync(join(root, 'sleight-held-'));
  mkdirSync(join(root, 'sleight-bench'));
  writeFileSync(join(oldDir, 'note.txt'), 'x');
  writeFileSync(join(held, 'open.txt'), 'y');
  utimesSync(oldDir, PAST, PAST);
  utimesSync(held, PAST, PAST);
  const fd = openSync(join(held, 'open.txt'), 'r');
  t.after(() => closeSync(fd));
  const removed = run(['--root', root, '--remove']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(oldDir), false);
  assert.equal(existsSync(held), true);
  assert.equal(existsSync(join(root, 'sleight-bench')), true);
});

function leftoverAfter(file, prefix) {
  const before = listPrefix(prefix);
  const env = { ...process.env, TMPDIR: process.env.TMPDIR || tmpdir() };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', fileURLToPath(new URL(file, import.meta.url))], {
    encoding: 'utf8', cwd: ROOT, env,
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return listPrefix(prefix).filter(path => !before.includes(path));
}

test('open-file test leaves no sleight-open-file folder', () => {
  assert.deepEqual(leftoverAfter('./open-file.test.mjs', 'sleight-open-file-'), []);
});

test('skill-rules test leaves no sleight-skill folder', () => {
  assert.deepEqual(leftoverAfter('./skill-rules.test.mjs', 'sleight-skill-'), []);
});

test('preapproved-always test leaves no sleight-always folder', () => {
  assert.deepEqual(leftoverAfter('./preapproved-always.test.mjs', 'sleight-always-'), []);
});
