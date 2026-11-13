import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const api = await import('../bench/lcu-arm-setup.mjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(t) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-lcu-arm-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitRepo(t) {
  const repo = tempDir(t);
  execFileSync('/usr/bin/git', ['-C', repo, 'init', '-q']);
  return repo;
}

test('refuses a folder inside a git repo, whether it exists yet or not', t => {
  const repo = gitRepo(t);
  assert.throws(() => api.assertOutsideRepo(repo), /inside the git repo/);
  assert.throws(() => api.assertOutsideRepo(join(repo, 'not-created-yet', 'lcu-arm')), /inside the git repo/);
  // The refusal must not create the folder it refuses.
  assert.equal(existsSync(join(repo, 'not-created-yet')), false);
});

test('accepts a folder outside any git repo', t => {
  const dir = tempDir(t);
  api.assertOutsideRepo(dir);
  api.assertOutsideRepo(join(dir, 'deep', 'lcu-arm'));
});

test('registers the claude-code agent at project scope, without chrome or audio', t => {
  const dir = join(tempDir(t), 'lcu-arm');
  assert.deepEqual(api.setupArgs(dir),
    ['setup', '--agent', 'claude-code', '--scope', 'project', '--project', dir, '--no-chrome', '--no-audio', '--yes']);
});

test('folder defaults to the benchmark cache, overridable by LCU_ARM_DIR and --project', t => {
  const saved = process.env.LCU_ARM_DIR;
  delete process.env.LCU_ARM_DIR;
  try {
    assert.equal(api.projectDir([]), join(homedir(), 'Library', 'Caches', 'sleight-bench', 'lcu-arm'));
    process.env.LCU_ARM_DIR = '/tmp/from-env';
    assert.equal(api.projectDir([]), '/tmp/from-env');
    assert.equal(api.projectDir(['--project', '/tmp/from-flag']), '/tmp/from-flag');
  } finally {
    if (saved === undefined) delete process.env.LCU_ARM_DIR; else process.env.LCU_ARM_DIR = saved;
  }
});

test('child PATH puts the repo Python first', () => {
  const env = api.childEnv();
  assert.ok(env.PATH.startsWith(join(ROOT, '.dev', 'py') + ':'), `PATH starts elsewhere: ${env.PATH}`);
});

test('main registers the arm folder and verifies it, using the runtime it is given', t => {
  const dir = join(tempDir(t), 'lcu-arm');
  const bin = tempDir(t);
  // A stand-in `lcu` that records the registration the way the real one writes it.
  const script = join(bin, 'lcu');
  writeFileSync(script, `#!/bin/sh
prev=""
for a in "$@"; do
  if [ "$prev" = "--project" ]; then printf '{"mcpServers":{"lcu":{"command":"/fake/lcu"}}}' > "$a/.mcp.json"; fi
  prev="$a"
done
[ "$1" = "--version" ] && echo "lcu 0.8.8-fake"
exit 0
`);
  chmodSync(script, 0o755);
  const saved = process.env.LCU_BIN;
  process.env.LCU_BIN = script;
  try {
    const done = api.main(['--project', dir]);
    assert.equal(done.dir, dir);
    assert.match(done.version, /lcu 0\.8\.8-fake/);
    const config = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    assert.ok(config.mcpServers.lcu, 'the registration must name the lcu server run.mjs looks for');
  } finally {
    if (saved === undefined) delete process.env.LCU_BIN; else process.env.LCU_BIN = saved;
  }
});
