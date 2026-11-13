import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { containerProgram, runContainerChecks, runOwnedCommand, runLinuxPreflight } from '../scripts/linux-preflight.mjs';

const commit = 'a'.repeat(40), runId = 'sleight-linux-00000000-0000-0000-0000-000000000000';
const privateText = 'private-sentinel/path-and-token';
const tap = '# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const ok = stdout => ({ status: 0, stdout, stderr: '', collected: true });
const baseExecute = async (command, args) => ok(command === 'npm' ? args[0] === 'test' ? tap : '' : args[0] === 'rev-parse' ? commit : 'README\0');
const exception = code => () => { throw Object.assign(Error(privateText), { code }); };
const base = { platform: 'linux', commit, runId, prepare() {}, makeConfig: () => '/config', removeConfig() {}, log() {}, execute: baseExecute };

test('failed container boundaries report closed diagnostics without private strings', async () => {
  const cases = [
    { overrides: { prepare: exception('EACCES') }, failure: { stage: 'prepare', code: 'exception', errorCode: 'EACCES' } },
    { overrides: { makeConfig: exception('ENOENT') }, failure: { stage: 'config-create', code: 'exception', errorCode: 'ENOENT' } },
    { overrides: { execute: async () => ({ status: 128, stdout: '', stderr: `fatal: detected dubious ownership ${privateText}`, collected: true }) },
      failure: { stage: 'git-head', code: 'child-failed', childExitCode: 128, reason: 'unsafe-repository' } },
    { overrides: { execute: async () => ({ status: null, stdout: '', stderr: '', collected: true, errorCode: 'ENOENT' }) },
      failure: { stage: 'git-head', code: 'child-failed', childExitCode: null, reason: 'no-stderr', errorCode: 'ENOENT' } },
    { overrides: { execute: async () => ok('b'.repeat(40)) }, failure: { stage: 'git-head', code: 'identity-mismatch' } },
    { overrides: { execute: async (c, args) => args[0] === 'ls-files' ? ({ status: 128, stdout: '', stderr: `Permission denied ${privateText}`, collected: true }) : baseExecute(c, args) },
      failure: { stage: 'git-tracked', code: 'child-failed', childExitCode: 128, reason: 'permission-denied' } },
    { overrides: { execute: async (c, args) => args[0] === 'ls-files' ? ok('README') : baseExecute(c, args) },
      failure: { stage: 'git-tracked', code: 'invalid-tracked' } },
    { overrides: { execute: async (c, args) => args[0] === 'ls-files' ? ok('\0') : baseExecute(c, args) },
      failure: { stage: 'git-tracked', code: 'empty-tracked' } },
    { overrides: { execute: async (c, args) => c === 'npm' && args[0] === 'test' ? ({ status: 7, stdout: '', stderr: privateText, collected: true }) : baseExecute(c, args) },
      failure: { stage: 'test', code: 'child-failed', childExitCode: 7, reason: 'other-stderr' }, exitCode: 7 },
    { overrides: { execute: async (c, args) => c === 'npm' && args[0] === 'test' ? ({ status: 9, stdout: tap, stderr: '', collected: true }) : baseExecute(c, args) },
      failure: { stage: 'test', code: 'child-failed', childExitCode: 9, reason: 'no-stderr' }, exitCode: 9 },
    { overrides: { execute: async (c, args) => c === 'npm' && args[0] === 'test' ? ok('') : baseExecute(c, args) },
      failure: { stage: 'counts', code: 'invalid-counts' } },
    { overrides: { removeConfig: exception('EPERM') }, failure: { stage: 'config-cleanup', code: 'exception', errorCode: 'EPERM' } },
    { overrides: { prepare: exception(privateText) }, failure: { stage: 'prepare', code: 'exception', errorCode: 'other' } },
    { overrides: { prepare() { throw null; } }, failure: { stage: 'prepare', code: 'exception', errorCode: 'other' } },
    { overrides: { execute: async () => ({ status: 128, stdout: '', stderr: 'not a git repository', collected: true }), removeConfig: exception('EPERM') },
      failure: { stage: 'git-head', code: 'child-failed', childExitCode: 128, reason: 'not-repository', cleanupErrorCode: 'EPERM' } },
  ];
  for (const { overrides, failure, exitCode = 1 } of cases) {
    const receipt = await runContainerChecks({ ...base, ...overrides });
    assert.deepEqual(receipt.failure, failure, failure.stage);
    assert.equal(receipt.exitCode, exitCode, failure.stage);
    assert.equal(JSON.stringify(receipt).includes(privateText), false);
  }
});

test('success keeps its existing receipt shape without diagnostics', async () => {
  const receipt = await runContainerChecks(base);
  assert.equal(receipt.exitCode, 0);
  assert.deepEqual(Object.keys(receipt).sort(), ['schemaVersion', 'platform', 'command', 'commit', 'runId', 'executed',
    'exitCode', 'dependencyMode', 'counts', 'trackedFiles'].sort());
});

test('serialized program emits the same closed Git failure and preserves one JSON output', async () => {
  const output = [], logs = [];
  const process = { platform: 'linux', env: {}, argv: ['node', commit, runId], stdout: { write: text => output.push(text) }, stderr: { write: text => logs.push(text) } };
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stderr.emit('data', `fatal: not a git repository ${privateText}`); child.emit('close', 128, null); });
    return child;
  };
  await runInNewContext(`(async () => {${containerProgram.replace(/^import .*;\n/gm, '')}})()`, {
    process, spawn, cpSync() {}, mkdtempSync: () => '/config', rmSync() {}, tmpdir: () => '/temp', join,
    setTimeout, clearTimeout, queueMicrotask });
  assert.equal(output.length, 1);
  const receipt = JSON.parse(output[0]);
  assert.deepEqual(receipt.failure, { stage: 'git-head', code: 'child-failed', childExitCode: 128, reason: 'not-repository' });
  assert.equal(process.exitCode, 1);
  assert.equal((output.join('') + logs.join('')).includes(privateText), false);
});

test('owned process startup reports only a closed spawn errno', async () => {
  const result = await runOwnedCommand('/no-such-executable-diagnostic', []);
  assert.equal(result.status, null);
  assert.equal(result.errorCode, 'ENOENT');
  assert.equal(result.collected, true);
  assert.equal(result.stderr, '');
});

test('host receipt keeps only validated diagnostics and rejects a passing receipt carrying failure', async t => {
  const bank = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-diagnostics-'))));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const worktree = join(bank, 'source'); mkdirSync(worktree);
  const env = { PATH: process.env.PATH, HOME: bank, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = async args => {
    const result = await runOwnedCommand('/usr/bin/git', args, { cwd: worktree, env });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  await git(['init', '--quiet']); writeFileSync(join(worktree, 'README'), 'fixture\n');
  await git(['add', '--', 'README']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture', '--', 'README']);
  const head = await git(['rev-parse', 'HEAD']);
  const failure = { stage: 'git-head', code: 'child-failed', childExitCode: 128, reason: 'unsafe-repository' };
  const copyFailure = { stage: 'prepare', code: 'exception', errorCode: 'ERR_FS_CP_EEXIST', copy: {
    nodeVersion: 'v24.19.0', destination: { state: 'empty', count: 0 },
    collision: { location: 'descendant', area: '.git', pathSha256: 'a'.repeat(64) },
  } };
  for (const [diagnostic, passing, expected] of [
    [{ ...failure, stderr: privateText, error: privateText, path: privateText }, false, failure],
    [{ ...failure, stage: privateText }, false, undefined],
    [{ ...failure, childExitCode: privateText }, false, undefined],
    [{ ...failure, stage: ['git-head'] }, false, undefined],
    [{ ...failure, reason: privateText }, false, undefined],
    [failure, true, failure],
    [{ ...copyFailure, copy: { ...copyFailure.copy, path: privateText } }, false, copyFailure],
    [{ ...copyFailure, copy: { ...copyFailure.copy, nodeVersion: privateText } }, false, undefined],
    [{ ...copyFailure, copy: { ...copyFailure.copy, nodeVersion: ['v24.19.0'] } }, false, undefined],
    [{ ...copyFailure, copy: { ...copyFailure.copy, nodeVersion: 'v24.19.0\n' } }, false, undefined],
    [{ ...copyFailure, copy: { ...copyFailure.copy, destination: { state: 'empty', count: 1 } } }, false, undefined],
    [{ ...copyFailure, copy: { ...copyFailure.copy, collision: { location: 'descendant', area: '.git', pathSha256: privateText } } }, false, undefined],
    [{ ...copyFailure, copy: { ...copyFailure.copy, collision: { location: 'descendant', area: '.git', pathSha256: ['a'.repeat(64)] } } }, false, undefined],
    [{ ...copyFailure, copy: { ...copyFailure.copy, collision: { location: 'descendant', area: '.git', pathSha256: 'a'.repeat(64) + '\n' } } }, false, undefined],
    [{ ...copyFailure, copy: { ...copyFailure.copy, collision: { location: 'descendant', area: privateText, pathSha256: 'a'.repeat(64) } } }, false, undefined],
  ]) {
    let name;
    const result = await runLinuxPreflight({ worktree, commit: head, log() {}, execute: async (command, args, options) => {
      if (command === '/usr/bin/git') return runOwnedCommand(command, args, options);
      assert.equal(command, 'docker');
      if (args[0] === 'create') { name = args[args.indexOf('--name') + 1]; return ok('d'.repeat(64)); }
      if (args[0] === 'inspect') return ok(`sha256:${'e'.repeat(64)}`);
      if (args[0] === 'start') return { ...ok(JSON.stringify({ schemaVersion: 1, platform: 'linux', command: ['npm', 'test'],
        commit: head, runId: name, executed: passing, exitCode: passing ? 0 : 1, dependencyMode: 'checkout-only',
        trackedFiles: passing ? 1 : 0, counts: passing ? { tests: 1, suites: 0, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 } : null,
        failure: diagnostic })), status: passing ? 0 : 1 };
      if (args[0] === 'rm' || args[0] === 'container') return ok('');
      assert.fail('Unexpected operation');
    } });
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.cleanupConfirmed, true);
    assert.deepEqual(result.failure, expected);
    assert.equal(JSON.stringify(result).includes(privateText), false);
  }
});
