import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const worktrees = ['sleight', 'wt/'].join('-');
const marker = ['lanes', 'may', 'test'].join('-');
const forbidden = [worktrees, marker];
const historyFiles = new Set(['docs/status/STATE.md', 'docs/status/ROADMAP.md']);
function references(file, source) {
  if (historyFiles.has(file)) return [];
  return source.split('\n').flatMap((line, index) => forbidden.some(text => line.includes(text)) ? [`${file}:${index + 1}`] : []);
}

test('private ledger scan catches dependencies and quoted paths with line locations', () => {
  assert.deepEqual(references('bench/tool.mjs', `const gate = "~/Projects/${worktrees}ledger/vc/night/${marker}";`), ['bench/tool.mjs:1']);
  assert.deepEqual(references('docs/design/example.md', `Example\n${marker}`), ['docs/design/example.md:2']);
  assert.deepEqual(references('scripts/tool.py', `${worktrees}other-bank`), ['scripts/tool.py:1']);
  assert.deepEqual(references('bench/tool.mjs', 'process.env.SLEIGHT_BENCH_GATE_FILE'), []);
});

test('private ledger exceptions cover exactly two status histories', () => {
  for (const file of historyFiles) assert.deepEqual(references(file, forbidden.join('\n')), []);
  for (const file of ['docs/status/LAWS.md', 'docs/status/new.md', 'docs/status/STATE.md.copy', 'docs/status-copy/example.md', 'tests/private-ledger.test.mjs', 'tests/private-ledger-copy.test.mjs'])
    assert.equal(references(file, forbidden.join('\n')).length, 2);
});

test('tracked public files contain no private worktree paths or operator test marker', () => {
  const files = execFileSync('/usr/bin/git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' }).split('\0').filter(Boolean);
  assert.ok(files.length, 'No tracked files were inspected');
  const hits = files.flatMap(file => references(file, readFileSync(join(root, file), 'utf8')));
  assert.deepEqual(hits, [], `Private ledger references at:\n${hits.join('\n')}`);
});
