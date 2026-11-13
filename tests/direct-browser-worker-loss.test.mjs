import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createV3Bridge } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { ownWorkerProcess } from '../plugins/sleight/lib/direct-browser/worker-process.mjs';

test('loss kills only the spawned hung worker and clears its shared sign-in card on confirmed exit', async t => {
  let child, exited, card = true, detached = 0, reset;
  const resetDone = new Promise(resolve => { reset = resolve; });
  const bridge = await createV3Bridge({ timeoutMs: 1000 }, {
    readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    shareConsent: () => ({ write: 1, read: 0, release() {}, detached() { detached++; card = false; reset(); } }),
    forkWorker(_path, _args, options) {
      child = fork(fileURLToPath(new URL('./fixtures/ho6-worker.mjs', import.meta.url)), [], { ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      return child;
    }
  });
  t.after(async () => { await bridge.detach(); await exited; });
  await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'loss-turn', text: 'Sign in.' });
  assert.equal((await bridge.call({ name: 'browser_tabs', arguments: { do: 'handoff', tab: 't1', wait: true } }, { handoffPresent: false })).isError, false);
  assert.equal(bridge.handoffPending(), true); assert.equal(card, true);
  // The parent sees protocol loss while the child cannot handle close/disconnect.
  child.emit('message', { invalid: true });
  assert.equal(child.connected, false);
  const result = await exited; await resetDone;
  assert.equal(result.code, null); assert.ok(['SIGTERM', 'SIGKILL'].includes(result.signal));
  assert.equal(detached, 1); assert.equal(card, false);
  assert.equal(bridge.handoffPending(), false);
  assert.equal((await bridge.call({ name: 'browser_read', arguments: { tab: 't1' } })).isError, true);
});

test('a headless child ignoring TERM is collected by the bounded KILL', async t => {
  const child = fork(fileURLToPath(new URL('./fixtures/ho6-worker.mjs', import.meta.url)), [],
    { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, HO6_IGNORE_TERM: '1' } });
  const owner = ownWorkerProcess(child), closed = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)));
  t.after(async () => { await owner.stop(() => { if (child.connected) child.disconnect(); }); await closed; });
  await new Promise(resolve => child.once('message', resolve));
  child.send({ method: 'call', id: 'hang' });
  await new Promise(resolve => child.once('message', resolve));
  const stopped = owner.stop(() => { if (child.connected) child.disconnect(); });
  assert.equal(await closed, 'SIGKILL'); await stopped;
});
