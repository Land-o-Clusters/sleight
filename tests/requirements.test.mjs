import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandSkip, macCommandSkip, packageSkip } from './requirements.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('benchmark imports and non-parser guards work when TypeScript cannot resolve', () => {
  const modules = ['../bench/remote-approval-guard.mjs', '../bench/world/method-check.mjs',
    '../bench/code-ast/oracle.mjs', '../bench/code-ast/statement-oracle.mjs', './requirements.mjs']
    .map(path => new URL(path, import.meta.url).href);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    import assert from 'node:assert/strict';
    registerHooks({ resolve(name, context, next) {
      if (name === 'typescript') throw Object.assign(Error('missing test parser'), { code: 'MODULE_NOT_FOUND' });
      return next(name, context);
    } });
    const [guard, world, oracle, statements, requirements] = await Promise.all(${JSON.stringify(modules)}.map(url => import(url)));
    assert.equal(requirements.packageSkip('typescript'), 'needs the typescript dependency');
    assert.equal(guard.remoteGuardDecision({ tool_name: 'other' }), false);
    assert.equal(guard.remoteGuardDecision({ tool_name: 'mcp__plugin_sleight_computer__turn_ended',
      tool_input: { sleight_resume: true } }), true);
    assert.deepEqual(oracle.astCalls(null), []);
    for (const call of [() => oracle.typescriptCalls(''), () => statements.justifyResult('', 'statements', { spans: [] }),
      () => world.dragMethodAudit(''), () => guard.remoteGuardDecision({ tool_name: 'mcp__plugin_sleight_computer__js',
        tool_input: { code: 'await app.getAXState()' } })]) assert.throws(call, { code: 'MODULE_NOT_FOUND' });
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
});

test('every parser-dependent test skips when TypeScript resolution is blocked', t => {
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(name, context, next) {
      if (name === 'typescript') throw Object.assign(Error('missing test parser'), { code: 'MODULE_NOT_FOUND' });
      return next(name, context);
    } });
  `);
  const files = ['code-ast-oracle', 'statement-oracle', 'code-ast-batch', 'remote-approval-live', 'shell-guard', 'turn-stats-mod']
    .map(name => new URL(`./${name}.test.mjs`, import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--import', preload, '--test', '--test-concurrency=1', '--test-reporter=tap',
    ...files.map(fileURLToPath)], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /^# fail 0$/m);
  assert.match(child.stdout, /# SKIP needs the typescript dependency/);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
    [key, Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(child.stdout)?.[1])]));
  assert.ok(counts.skipped > 0 && counts.pass > 0);
  t.diagnostic(JSON.stringify({ parserUnavailable: counts }));
});

test('command requirements reject absent, nonexecutable and directory entries without launching them', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-requirement-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(commandSkip('fake', dir), /fake.*PATH/);
  const path = join(dir, 'fake'); writeFileSync(path, '#!/bin/sh\nexit 99\n', { mode: 0o600 });
  assert.match(commandSkip('fake', dir), /fake.*PATH/);
  chmodSync(path, 0o700);
  assert.equal(commandSkip('fake', dir), false);
  mkdirSync(join(dir, 'directory'));
  assert.match(commandSkip('directory', dir), /directory.*PATH/);
  assert.match(macCommandSkip('fake', dir, 'linux'), /macOS/);
  assert.equal(macCommandSkip('fake', dir, 'darwin'), false);
});

test('package requirements name the absent package and accept built-in modules', () => {
  assert.match(packageSkip('sleight-absent-test-dependency'), /sleight-absent-test-dependency/);
  assert.equal(packageSkip('node:fs'), false);
});
