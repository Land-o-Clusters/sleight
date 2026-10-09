import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startLoadWorkers } from '../bench/load-workers.mjs';

test('a worker spawn error aborts the run and cleanup collects earlier workers', async () => {
  const children = [], errors = [];
  const stop = startLoadWorkers(2, { onError: error => errors.push(error.message), spawnWorker: () => {
    const child = new EventEmitter();
    child.kill = signal => { child.signal = signal; queueMicrotask(() => child.emit('close', null, signal)); };
    children.push(child); return child;
  } });
  children[1].emit('error', new Error('spawn EAGAIN'));
  children[1].emit('close', -1, null);
  const results = await stop();
  assert.deepEqual(errors, ['spawn EAGAIN']);
  assert.equal(children[0].signal, 'SIGTERM');
  assert.equal(children[1].signal, undefined);
  assert.equal(results.length, 2);
  assert.equal(results[1].error, 'spawn EAGAIN');
  assert.deepEqual(await stop(), results);
});

test('a synchronous spawn error still returns cleanup for children already started', async () => {
  const child = new EventEmitter(); let attempts = 0, error;
  child.kill = signal => queueMicrotask(() => child.emit('close', null, signal));
  const stop = startLoadWorkers(3, { onError: value => { error = value; }, spawnWorker: () => {
    if (attempts++) throw new Error('spawn failed');
    return child;
  } });
  assert.equal(error.message, 'spawn failed');
  assert.equal((await stop()).length, 2);
});
