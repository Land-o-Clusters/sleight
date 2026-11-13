import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ownWorkerProcess, workerProcessIdentity } from '../plugins/sleight/lib/direct-browser/worker-process.mjs';

function fixture(t, { identity, kill } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new EventEmitter(), signals = [], closes = [], unrefs = [];
  Object.assign(child, { pid: 4321, exitCode: null, signalCode: null, unref() { unrefs.push(true); },
    kill(name) { signals.push(name); kill?.(child, name); } });
  let start = 'birth-1', reads = 0;
  const owner = ownWorkerProcess(child, { identity: pid => { reads++; return identity ? identity(pid, reads) : { pid, start }; } });
  return { child, signals, closes, unrefs, owner, reads: () => reads, change: value => { start = value; },
    stop: () => owner.stop(() => closes.push('close')) };
}

test('worker identity reads only one pid and requires its parent and start time', () => {
  let calls = 0;
  const run = (path, args, options) => {
    calls++;
    assert.equal(path, '/bin/ps');
    assert.deepEqual(args, ['-o', 'pid=,ppid=,lstart=', '-p', '4321']);
    assert.equal(options.timeout, 500); assert.equal(options.maxBuffer, 1024);
    return `4321 ${process.pid} Tue Oct 27 12:00:00 2026\n`;
  };
  assert.deepEqual(workerProcessIdentity(4321, { run }), { pid: 4321, start: 'Tue Oct 27 12:00:00 2026' });
  for (const pid of [0, -1, NaN, '4321']) assert.equal(workerProcessIdentity(pid, { run }), undefined);
  assert.equal(calls, 1);
  for (const row of [`4322 ${process.pid} Tue Oct 27 12:00:00 2026`, '4321 0 Tue Oct 27 12:00:00 2026',
    `4321 ${process.pid} unknown`, '', `4321 ${process.pid} Tue Oct 27 12:00:00 2026\n4322 1 extra`])
    assert.equal(workerProcessIdentity(4321, { run: () => row }), undefined);
  assert.equal(workerProcessIdentity(4321, { run: () => { throw Error('gone'); } }), undefined);
});

test('worker gets a graceful close before TERM and KILL, with fresh identity checks for both', async t => {
  const f = fixture(t, { kill(child, signal) { if (signal === 'SIGKILL') { child.signalCode = signal; child.emit('exit', null, signal); } } });
  const stopped = f.stop();
  assert.equal(f.stop(), stopped); assert.deepEqual(f.closes, ['close']);
  t.mock.timers.tick(499); assert.deepEqual(f.signals, []);
  t.mock.timers.tick(1); assert.deepEqual(f.signals, ['SIGTERM']); assert.equal(f.reads(), 2);
  t.mock.timers.tick(999); assert.deepEqual(f.signals, ['SIGTERM']);
  t.mock.timers.tick(1); await stopped;
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']); assert.equal(f.reads(), 3);
  t.mock.timers.tick(10000); assert.equal(f.signals.length, 2);
});

test('graceful worker exit cancels escalation and repeated losses do not close twice', async t => {
  const f = fixture(t);
  const stopped = f.owner.stop(() => { f.closes.push('close'); f.child.exitCode = 0; f.child.emit('exit', 0); });
  await stopped; await f.stop(); t.mock.timers.tick(10000);
  assert.deepEqual(f.signals, []); assert.deepEqual(f.closes, ['close']); assert.equal(f.reads(), 1);
});

test('healthy worker close gets 1500 ms before TERM and can finish connection cleanup first', async t => {
  const f = fixture(t);
  const stopped = f.owner.stop(() => f.closes.push('close'), { graceful: true });
  t.mock.timers.tick(1000);
  assert.deepEqual(f.signals, []);
  f.child.exitCode = 0; f.child.emit('exit', 0); await stopped;
  t.mock.timers.tick(10000); assert.deepEqual(f.signals, []);
});

test('hung healthy close still has bounded escalation after its longer grace', async t => {
  const f = fixture(t);
  const stopped = f.owner.stop(() => f.closes.push('close'), { graceful: true });
  t.mock.timers.tick(1499); assert.deepEqual(f.signals, []);
  t.mock.timers.tick(1); assert.deepEqual(f.signals, ['SIGTERM']);
  t.mock.timers.tick(1000); assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']);
  t.mock.timers.tick(1000); await stopped; assert.equal(f.unrefs.length, 1);
});

for (const mode of ['recycled-before-term', 'recycled-before-kill', 'changed-pid', 'missing', 'unreadable', 'wrong-pid', 'exited'])
test(`worker escalation refuses ${mode}`, async t => {
  const f = fixture(t, { identity: ['missing', 'unreadable', 'wrong-pid'].includes(mode) ? (pid, n) => {
    if (mode === 'missing') return;
    if (mode === 'unreadable' && n > 1) throw Error('unreadable');
    return { pid: mode === 'wrong-pid' ? pid + 1 : pid, start: 'birth-1' };
  } : undefined });
  const stopped = f.stop();
  if (mode === 'recycled-before-kill') { t.mock.timers.tick(500); f.change('birth-2'); }
  else if (mode === 'recycled-before-term') f.change('birth-2');
  else if (mode === 'changed-pid') f.child.pid++;
  else if (mode === 'exited') { f.child.exitCode = 0; f.child.emit('exit', 0); }
  t.mock.timers.tick(10000); await stopped;
  assert.deepEqual(f.signals, mode === 'recycled-before-kill' ? ['SIGTERM'] : []);
  assert.equal(f.unrefs.length, mode === 'exited' ? 0 : 1);
});

test('a failed TERM still permits one checked KILL and collection has a final deadline', async t => {
  const f = fixture(t, { kill() { throw Error('signal failed'); } });
  let done = false;
  const stopped = f.stop().then(() => { done = true; });
  t.mock.timers.tick(2499); await Promise.resolve(); assert.equal(done, false);
  t.mock.timers.tick(1); await stopped;
  assert.deepEqual(f.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.unrefs.length, 1);
  t.mock.timers.tick(10000); assert.equal(f.signals.length, 2);
});
