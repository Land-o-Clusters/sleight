import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = '6a12d606511d8fd7cb6a32530aafb068cc64aeb2';
const oldPin = '8b689249ba4e33d2626487aad930605c62e2c6a7';
const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
const source = file => readFileSync(join(root, file), 'utf8');

test('BF1 current benchmark pins name the new build and retain labeled old provenance', async () => {
  assert.match(source('bench/fowl/rounds.sh'), /^PIN=6a12d60$/m);
  const suite = JSON.parse(source('bench/world/suite.json'));
  assert.equal(suite.provenance.fowlbrowser.commit, pin);
  assert.equal(suite.provenance.fowlbrowser.previousCommit, oldPin);
  assert.ok(source('bench/validation/workflow-docs-ab.mjs').includes(`const UPSTREAM = '${pin}'`));
  const { fowlRunnerReference } = await import('../bench/validation/classify-140.mjs');
  assert.equal(typeof fowlRunnerReference, 'function');
  assert.equal(fowlRunnerReference(suite), `FowlBrowser@${pin}/tools/rounds.mjs`);
  assert.equal(fowlRunnerReference({ provenance: { fowlbrowser: { commit: oldPin } } }), `FowlBrowser@${oldPin}/tools/rounds.mjs`);
  assert.throws(() => fowlRunnerReference({}), /provenance/);
});

test('BF1 forwards only the named rounds config through the clean round environment', () => {
  const shell = source('bench/fowl/rounds.sh');
  assert.equal((shell.match(/FOWLBROWSER_ROUNDS_CONFIG="\$FOWLBROWSER_ROUNDS_CONFIG"/g) || []).length, 2);
});

test('BF1 patch applies cleanly to the exact new runner and preserves its config and output handling', { skip: !existsSync(join(cache, '.git')) && 'benchmark cache absent' }, async t => {
  const original = execFileSync('/usr/bin/git', ['-C', cache, 'show', `${pin}:tools/rounds.mjs`], { encoding: 'utf8' });
  const dir = mkdtempSync(join(tmpdir(), 'bf1-patch-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'tools'));
  const runner = join(dir, 'tools/rounds.mjs');
  writeFileSync(runner, original);
  const patch = join(root, 'bench/fowl/sleight-surface.patch');
  const check = spawnSync('/usr/bin/git', ['apply', '--check', patch], { cwd: dir, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  execFileSync('/usr/bin/git', ['apply', patch], { cwd: dir });
  const patched = readFileSync(runner, 'utf8');
  assert.doesNotMatch(patched, /^(<<<<<<<|=======|>>>>>>>)/m);
  for (const needle of ['local/rounds.json', "setting('devtools')", "setting('guiDriver')", 'fs.mkdtempSync(path.join(os.tmpdir()', 'if (import.meta.main) await main().catch']) {
    assert.ok(patched.includes(needle), needle);
  }
  const syntax = spawnSync(process.execPath, ['--check', runner], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  // Importing the runner only defines functions. It never runs main or starts an agent.
  const m = await import(pathToFileURL(runner).href);
  assert.throws(() => m.setting('bf1Missing'), error => error.setting === 'bf1Missing');
  const task = { name: 'bf1', browser: 'chrome', prompt: 'Read the local fixture.', result: 'JSON' };
  const setup = m.agentSetup({ task, surface: 'fowlbrowser', dir, mcpRoot: dir, settings: join(dir, 'settings.json'), model: 'haiku', effort: 'high' });
  assert.equal(setup.mcpConfig.mcpServers.fowlbrowser.command, join(dir, 'mcp/bin/fowlbrowser-mcp'));
  assert.ok(m.isCodex('sleight-turbo'));
});
