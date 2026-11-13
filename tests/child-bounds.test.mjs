import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertBoundedChildren, boundViolations, childCalls } from './fixtures/child-bounds.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

test('synchronous children have deadlines and forced termination', () => {
  assertBoundedChildren(fileURLToPath(new URL('..', import.meta.url)));
});

test('guard rejects an unbounded fixture file and accepts a bounded file', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-child-bounds-')));
  mkdirSync(join(root, 'cases'));
  const file = join(root, 'cases', 'child.mjs');
  const prefix = "import { spawnSync } from 'node:child_process';\n";
  writeFileSync(file, prefix + "spawnSync(process.execPath, ['-e', ''], { input: Buffer.alloc(4 << 20) });\n");
  assert.throws(() => assertBoundedChildren(root, ['cases']), /cases\/child.mjs:2: spawnSync needs positive timeout/);
  writeFileSync(file, prefix + "spawnSync(process.execPath, ['-e', ''], { timeout: 60000, killSignal: 'SIGKILL' });\n");
  assert.doesNotThrow(() => assertBoundedChildren(root, ['cases']));
});

test('parser follows aliases, namespaces, injected helpers, spreads and nested parentheses', () => {
  const source = `import {spawnSync as child, execFileSync} from 'node:child_process';
    import * as cp from 'node:child_process';
    const common = {timeout: 60000, killSignal: 'SIGKILL'};
    const alias = child;
    alias(process.execPath, [String(Math.max(1, (2 + 3)))], {...common});
    cp.execSync('true', {timeout: 30000, killSignal: 'SIGKILL'});
    function wrapper(run = execFileSync) { return run('tool', [], {timeout: 15000, killSignal: 'SIGKILL'}); }
    function injected({run = execFileSync} = {}) { return run('tool', []); }
    function shadow(child) { child('ordinary callback'); }
    const example = "spawnSync('not executable')";
    // execFileSync('also not executable')
  `;
  const calls = childCalls(source);
  assert.equal(calls.length, 4);
  assert.equal(boundViolations(calls).length, 1);
  assert.match(boundViolations(calls)[0], /fixture.mjs:8: execFileSync/);
});

test('CommonJS aliases, default namespaces and dynamic imports are checked', () => {
  for (const source of [
    "const {spawnSync: run} = require('child_process'); run('tool', []);",
    "const cp = require('node:child_process'); cp['execSync']('tool');",
    "import cp from 'node:child_process'; cp.execFileSync('tool', []);",
    "const cp = await import('node:child_process'); cp.spawnSync('tool', []);",
    "import {spawnSync} from 'node:child_process'; let run; run = spawnSync; run('tool', []);",
    "import {execFileSync} from 'node:child_process'; const run = execFileSync.bind(null); run('tool', []);",
  ]) assert.equal(boundViolations(childCalls(source)).length, 1, source);
});

test('missing, disabled and overridden bounds fail; opt-outs require an adjacent explanation', () => {
  const prefix = "import {spawnSync} from 'node:child_process';\n";
  for (const options of ['{}', "{timeout: 0, killSignal: 'SIGKILL'}", "{timeout: null, killSignal: 'SIGKILL'}",
    "{timeout: undefined, killSignal: 'SIGKILL'}", "{timeout: Infinity, killSignal: 'SIGKILL'}", "{timeout: NaN, killSignal: 'SIGKILL'}",
    "{timeout: 60000, killSignal: 'SIGTERM'}", "{...{timeout: 60000}, timeout: 0, killSignal: 'SIGKILL'}"])
    assert.equal(boundViolations(childCalls(prefix + `spawnSync('tool', [], ${options})`)).length, 1);
  assert.equal(boundViolations(childCalls(prefix + "/* child-bounds: cannot-hang: in-memory stub */ spawnSync('stub')")).length, 0);
  assert.equal(boundViolations(childCalls(prefix + "/* child-bounds: cannot-hang: */ spawnSync('tool')")).length, 1);
  assert.throws(() => childCalls('const = ;', 'invalid.mjs'), /invalid.mjs:1/);
  assert.equal(boundViolations(childCalls(prefix + "const disabled = 0; spawnSync('tool', [], {timeout: disabled, killSignal: 'SIGKILL'});")).length, 1);
  assert.equal(boundViolations(childCalls("spawnSync('tool', []);")).length, 1);
});

test('status assertion identifies a timeout and a terminating signal', () => {
  assert.throws(() => assertChildStatus({ status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' } }, 0, 'compile'), /compile\nchild: ETIMEDOUT/);
  assert.throws(() => assertChildStatus({ status: null, signal: 'SIGKILL' }, 0), /child: SIGKILL/);
  assertChildStatus({ status: 65 }, 65);
  assertChildStatus({ status: 65 }, 0, '', 'notEqual');
});

test('forced deadline ends a synchronous child that never consumes its input', () => {
  const result = spawnSync(process.execPath, ['-e', "process.on('SIGTERM', () => {}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], {
    input: Buffer.alloc(2 << 20), timeout: 250, killSignal: 'SIGKILL',
  });
  assert.equal(result.status, null);
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.signal, 'SIGKILL');
});
