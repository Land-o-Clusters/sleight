import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../bench/runtime-owner-away.mjs', import.meta.url), 'utf8');
async function stopContract(text) {
  const start = text.indexOf('  const forceStop = '), end = text.indexOf('  const interrupt = ', start);
  assert.ok(start >= 0 && end > start);
  for (const rejected of [false, true]) {
    const calls = [];
    const context = createContext({ forcing: undefined, stopped: undefined, cleanup: true,
      controller: { abort: () => calls.push('abort') },
      engine: { forceClose: async () => calls.push('engine') }, latencies: undefined,
      witness: { send: () => {}, forceClose: async () => calls.push('witness') },
      guard: { forceClose: async () => calls.push('guard') }, bounded: operation => operation(),
      releaseLock: async () => { calls.push('lock'); if (rejected) throw Error('LOCK_FAILED'); },
      dependencies: { forceExit: code => calls.push(code) },
    });
    runInContext(text.slice(start, end).replace('const forceStop = ', 'globalThis.forceStop = '), context);
    await assert.doesNotReject(context.forceStop());
    await assert.doesNotReject(context.forceStop());
    assert.equal(context.stopped, 'OWNER_FORCE_STOPPED'); assert.equal(context.cleanup, false);
    assert.equal(calls.filter(value => value === 130).length, 1);
    assert.ok(calls.indexOf('lock') < calls.indexOf(130));
  }
}
test('forced stop handles rejected lock cleanup when the exit callback returns', () => stopContract(source));
test('forced stop catches the rejected-cleanup broken variant', async () => {
  assert.ok(source.includes('catch { cleanup = false; }\n    finally'));
  await assert.rejects(stopContract(source.replace('catch { cleanup = false; }\n    finally', 'finally')), assert.AssertionError);
});
