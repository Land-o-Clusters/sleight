import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WindowsInputLease } from '../plugins/sleight/lib/windows-driver/leases.mjs';

let moduleId = 0;
const fresh = () => import('../plugins/sleight/lib/direct-browser/windows-gates.mjs?gate-test=' + moduleId++);
const file = 'C:\\Users\\fixture\\sleight\\leases';
const request = { op: 'private-file', path: file };
const options = { platform: 'win32', receipt: {}, executable: () => 'C:\\cache\\host.exe' };
function child() {
  const value = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) value[name] = new PassThrough();
  value.kills = [];
  value.kill = signal => value.kills.push(signal);
  return value;
}
function permissions(module, runSync) {
  return module.createWindowsFilePermissions({ platform: 'win32',
    helper: module.createWindowsGateHelper({ ...options, runSync }) });
}
for (const [cause, reply] of [
  ['timeout', { error: { code: 'ETIMEDOUT', message: 'private details' }, status: null, signal: 'SIGKILL' }],
  ['exit', { status: 1, stderr: 'private details' }],
  ['exit', { status: null, signal: 'SIGKILL' }],
  ['spawn', { error: { code: 'ENOENT', message: 'private details' }, status: null }],
  ['reply', { error: { code: 'ENOBUFS' }, status: null }],
]) test('sync gate preserves only the fixed cause ' + cause + ' for ' + JSON.stringify(reply), async () => {
  const module = await fresh();
  const proof = permissions(module, () => reply).privateFile(file);
  assert.deepEqual(proof, { ok: false, reason: 'WINDOWS_GATE_UNPROVED: cause=' + cause });
});
test('a synchronous spawn exception gets a fixed cause', async () => {
  const module = await fresh();
  assert.equal(permissions(module, () => { throw Error('private details'); }).privateFile(file).reason,
    'WINDOWS_GATE_UNPROVED: cause=spawn');
});
for (const reply of [undefined, 7, 'bad JSON', '{}', '{"ok":true,"evidence":{}}', 'x'.repeat(65537)]) {
  test('bad reply gets the reply cause, length ' + String(reply).length, async () => {
    const module = await fresh();
    const proof = permissions(module, () => ({ status: 0, stdout: reply })).privateFile(file);
    assert.equal(proof.reason, 'WINDOWS_GATE_UNPROVED: cause=reply');
  });
}
test('lease acquisition error retains the fixed gate cause', async () => {
  const module = await fresh();
  for (const [cause, reply] of [['timeout', { error: { code: 'ETIMEDOUT' } }], ['exit', { status: 1 }],
    ['spawn', { error: { code: 'ENOENT' } }], ['reply', { status: 0, stdout: '{}' }]]) {
    const lease = new WindowsInputLease({ directory: file, permissions: permissions(module, () => reply), operate() { assert.fail(); } });
    assert.throws(() => lease.prove(file, true), { message: 'WINDOWS_LEASE_UNPROVED: WINDOWS_GATE_UNPROVED: cause=' + cause });
  }
});
test('first sync gate gets 30000 ms, later adapters share 10000 ms', async () => {
  const module = await fresh(), seen = [];
  const runSync = (file, args, settings) => { seen.push(settings.timeout); return { status: 1 }; };
  const first = module.createWindowsGateHelper({ ...options, runSync });
  const second = module.createWindowsGateHelper({ ...options, runSync });
  for (const helper of [first, first, second]) assert.throws(() => helper.requestSync(request), /cause=exit/);
  assert.deepEqual(seen, [30000, 10000, 10000]);
});
test('first async gate gets 30000 ms and a later sync gate gets 10000 ms', async t => {
  const module = await fresh(), process = child();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const helper = module.createWindowsGateHelper({ ...options, run: () => process });
  const pending = helper.request(request);
  t.mock.timers.tick(10001); assert.deepEqual(process.kills, []);
  t.mock.timers.tick(19998); assert.deepEqual(process.kills, []);
  t.mock.timers.tick(1); assert.deepEqual(process.kills, ['SIGKILL']);
  let settled = false; const checked = pending.catch(error => { settled = true; return error; });
  await Promise.resolve(); assert.equal(settled, false);
  process.emit('close', null, 'SIGKILL');
  assert.equal((await checked).message, 'WINDOWS_GATE_UNPROVED: cause=timeout');
  const second = module.createWindowsGateHelper({ ...options,
    runSync(file, args, settings) { assert.equal(settings.timeout, 10000); return { status: 0, stdout: 'ok' }; } });
  assert.equal(second.requestSync(request), 'ok');
});
test('later async gate times out at 10000 ms even after the first failed spawn', async t => {
  const module = await fresh();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const broken = module.createWindowsGateHelper({ ...options, run() { throw Error('private details'); } });
  await assert.rejects(broken.request(request), { message: 'WINDOWS_GATE_UNPROVED: cause=spawn' });
  const process = child(), helper = module.createWindowsGateHelper({ ...options, run: () => process });
  const pending = helper.request(request);
  t.mock.timers.tick(9999); assert.deepEqual(process.kills, []);
  t.mock.timers.tick(1); assert.deepEqual(process.kills, ['SIGKILL']);
  process.emit('close', null, 'SIGKILL');
  await assert.rejects(pending, { message: 'WINDOWS_GATE_UNPROVED: cause=timeout' });
});
for (const cause of ['exit', 'spawn', 'reply']) test('async gate cause ' + cause + ' waits for the owned close when needed', async () => {
  const module = await fresh(), process = child();
  const helper = module.createWindowsGateHelper({ ...options, run: () => process });
  const pending = helper.request(request);
  if (cause === 'spawn') process.emit('error', Error('private details'));
  if (cause === 'reply') process.stdout.write(Buffer.alloc(65537));
  if (cause !== 'spawn') process.emit('close', cause === 'exit' ? 1 : 0);
  await assert.rejects(pending, { message: 'WINDOWS_GATE_UNPROVED: cause=' + cause });
  process.emit('close', -1);
});
test('timeout cause survives later pipe errors and late events cannot kill a reaped child', async t => {
  const module = await fresh(), process = child(), abort = new AbortController();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const helper = module.createWindowsGateHelper({ ...options, run: () => process });
  const pending = helper.request(request, { signal: abort.signal });
  t.mock.timers.tick(30000);
  process.stdin.emit('error', Error('private details'));
  process.emit('close', null, 'SIGKILL');
  await assert.rejects(pending, { message: 'WINDOWS_GATE_UNPROVED: cause=timeout' });
  process.stdin.emit('error', Error('late'));
  abort.abort();
  assert.deepEqual(process.kills, ['SIGKILL']);
});
test('consent keeps its explicit deadline and does not spend the cold gate allowance', async t => {
  const module = await fresh(), process = child();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const helper = module.createWindowsGateHelper({ ...options, run: () => process,
    runSync(file, args, settings) { assert.equal(settings.timeout, 30000); return { status: 0, stdout: 'ok' }; } });
  const pending = helper.request({ op: 'consent' }, { timeout: 60000 });
  t.mock.timers.tick(59999); assert.deepEqual(process.kills, []);
  process.stdout.write('cancel'); process.emit('close', 0);
  assert.equal(await pending, 'cancel'); assert.equal(helper.requestSync(request), 'ok');
});
