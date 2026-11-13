import test from 'node:test';
import assert from 'node:assert/strict';
import { runTypingNativeChecks, TYPING_NATIVE_JOBS } from '../bench/windows/typing-native-checks.mjs';

test('headless guest compile runs fixed files separately with isolated configs, low priority and bounded children', async () => {
  const calls = [], removed = []; let configs = 0;
  const result = await runTypingNativeChecks({ platform: 'win32', temporary: () => '/scratch/config-' + ++configs,
    remove: path => removed.push(path), run: async (command, args, options) => {
      calls.push({ command, args, options });
      const count = TYPING_NATIVE_JOBS[calls.length - 1].minimumPass;
      return { status: 0, stdout: `# tests ${count}\n# pass ${count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`, stderr: '' };
    } });
  assert.equal(result.passed, true); assert.equal(result.drawing, false);
  assert.deepEqual(calls.map(c => c.args.at(-1)), TYPING_NATIVE_JOBS.map(j => j.file));
  assert.deepEqual(removed, TYPING_NATIVE_JOBS.map((_, index) => '/scratch/config-' + (index + 1)));
  for (const [index, c] of calls.entries()) {
    assert.equal(c.command, process.execPath); assert.equal(c.options.lowPriority, true);
    assert.equal(c.options.timeout, 910000); assert.equal(c.options.maxBytes, 4 * 1024 * 1024);
    assert.equal(c.options.env.CLAUDE_CONFIG_DIR, '/scratch/config-' + (index + 1));
    assert.ok(c.args.includes('--test-timeout=900000'));
  }
});

test('headless compile refuses another platform and stops after failed or unproved child work', async () => {
  await assert.rejects(runTypingNativeChecks({ platform: 'darwin' }), /WINDOWS_REQUIRED/);
  for (const failure of [{ status: 1 }, { status: 0, cleanup: 'tree-unconfirmed' }, { status: 0, reason: 'timeout' }]) {
    let calls = 0, removed = 0;
    const result = await runTypingNativeChecks({ platform: 'win32', temporary: () => '/scratch/config', remove: () => removed++,
      run: async () => { calls++; return { stdout: '', stderr: '', ...failure }; } });
    assert.equal(result.passed, false); assert.equal(calls, 1); assert.equal(removed, 1);
  }
  let calls = 0;
  const lateFailure = await runTypingNativeChecks({ platform: 'win32', temporary: () => '/scratch/config', remove() {},
    run: async () => ({ status: 0, stdout: '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
      ...++calls === 2 ? { cleanup: 'tree-unconfirmed' } : {} }) });
  assert.equal(lateFailure.passed, false);
  const skipped = await runTypingNativeChecks({ platform: 'win32', temporary: () => '/scratch/config', remove() {},
    run: async () => ({ status: 0, stdout: '# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n' }) });
  assert.equal(skipped.passed, false); assert.equal(skipped.results.length, 1);
});
