import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { trackPageWaits, waitForThinPage, waitForPage, stopPageWaits } from '../plugins/sleight/lib/direct-browser/waits.mjs';

// Only the browser transport is replaced. The wait tracker and retry policy run
// unchanged, with a clock that records every requested delay.
function fixture() {
  const page = new EventEmitter();
  let time = 0, reads = 0, closed = false;
  const row = { revision: 0, ready: true, length: 100 };
  const frame = (read = async () => row, world = 'utility') => ({
    _connection: { toImpl: () => ({ utilityContext: async () => ({ world,
      evaluateExpression: async () => { reads++; return read(); } }) }) },
  });
  let frames = [frame()];
  page.frames = () => frames;
  page.isClosed = () => closed;
  const clock = { now: () => time, sleep: async ms => { time += ms; } };
  return { page, frame, row, clock, time: () => time, reads: () => reads,
    frames: next => { frames = next; }, close: () => { closed = true; } };
}

test('tracking navigation requests needs no observation of the about:blank document', async () => {
  const f = fixture();
  f.frames([f.frame(async () => { throw Error('Execution context was destroyed'); })]);
  await trackPageWaits(f.page);
  assert.equal(f.reads(), 0);
  const request = { resourceType: () => 'fetch' };
  f.page.emit('request', request);
  f.frames([f.frame()]);
  const pending = await waitForPage(f.page, { ms: 600 }, f.clock);
  assert.match(pending, /activity still pending/);
  f.page.emit('requestfinished', request);
  const ready = await waitForPage(f.page, { ms: 600 }, f.clock);
  assert.match(ready, /settled after 500 ms/);
  await stopPageWaits(f.page);
  assert.equal(f.page.listenerCount('request'), 0);
});

test('a healthy populated page needs one trusted sample and no retry delay', async () => {
  const f = fixture();
  await waitForThinPage(f.page, f.clock);
  assert.equal(f.time(), 0);
  assert.equal(f.reads(), 1);
  await stopPageWaits(f.page);
});

for (const message of ['Execution context was destroyed, most likely because of a navigation',
  'Execution context was destroyed, most likely because of a navigation.',
  'Frame was detached']) test(`a transient ${message} retries the complete frame sample`, async () => {
  const f = fixture();
  const child = f.frame(async () => {
    f.frames([f.frame()]);
    throw Error(message);
  });
  f.frames([f.frame(), child]);
  await waitForThinPage(f.page, f.clock);
  assert.equal(f.reads(), 3, 'discard the partial sample and read the surviving main frame again');
  assert.ok(f.time() > 0 && f.time() < 3000);
  await stopPageWaits(f.page);
});

test('a transient navigation read restarts the no-condition quiet interval', async () => {
  const f = fixture();
  let observations = 0;
  f.frames([f.frame(async () => {
    if (++observations === 2) throw Error('Execution context was destroyed');
    return f.row;
  })]);
  const result = await waitForPage(f.page, { ms: 1000 }, f.clock);
  assert.match(result, /settled after/);
  assert.ok(f.time() >= 650, `new document must settle for 500 ms after the retry, got ${f.time()} ms`);
  assert.ok(f.time() < 1000);
  await stopPageWaits(f.page);
});

test('a newly attached frame is observed before a wait can report a populated page', async () => {
  const f = fixture();
  let attached = false;
  const child = f.frame(async () => { throw Error('TRUSTED_DOM_REQUIRED'); });
  const main = f.frame(async () => {
    if (!attached) { attached = true; f.frames([main, child]); }
    return f.row;
  });
  f.frames([main]);
  await assert.rejects(waitForThinPage(f.page, f.clock), /TRUSTED_DOM_REQUIRED/);
  f.frames([f.frame()]);
  await stopPageWaits(f.page);
});

test('repeated context destruction is bounded and never treated as a successful sample', async () => {
  const f = fixture();
  f.frames([f.frame(async () => { throw Error('Execution context was destroyed'); })]);
  await assert.rejects(waitForThinPage(f.page, f.clock), /Execution context was destroyed/);
  assert.ok(f.reads() > 1 && f.reads() <= 10, `${f.reads()} observations`);
  assert.ok(f.time() > 0 && f.time() < 3000, `${f.time()} ms`);
});

for (const message of ['TRUSTED_DOM_REQUIRED', 'Target page, context or browser has been closed',
  'Unrelated read failure']) test(`${message} is not retried or hidden`, async () => {
  const f = fixture();
  f.frames([f.frame(async () => { throw Error(message); })]);
  await assert.rejects(waitForThinPage(f.page, f.clock), { message });
  assert.equal(f.reads(), 1);
  assert.equal(f.time(), 0);
});

test('a missing utility world still refuses without consulting the main world', async () => {
  const f = fixture();
  f.frames([f.frame(async () => assert.fail('must not evaluate in MAIN'), 'main')]);
  await assert.rejects(waitForThinPage(f.page, f.clock), /Trusted wait observation unavailable/);
  assert.equal(f.reads(), 0);
  assert.equal(f.time(), 0);
});

test('a closed page does not retry a destroyed context', async () => {
  const f = fixture();
  f.frames([f.frame(async () => { f.close(); throw Error('Execution context was destroyed'); })]);
  await assert.rejects(waitForThinPage(f.page, f.clock), /Execution context was destroyed/);
  assert.equal(f.reads(), 1);
  assert.equal(f.time(), 0);
});
