import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const source = process.env.PA1B_LOCK_MODULE ? pathToFileURL(process.env.PA1B_LOCK_MODULE) : new URL('../plugins/sleight/lib/preapproved.mjs', import.meta.url);
const store = await import(source.href);
const lockAsync = store.withPreapprovedLockAsync ?? (async (...args) => store.withPreapprovedLock(...args));
const addAsync = store.addPreapprovedAsync ?? store.addPreapproved;
function fixture(t) {
  const home = registerTemp(t, trackTemp(fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-pa1b-')))));
  const file = store.preapprovedFile(home);
  fs.mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ version: 1, apps: [{ app: 'A', riskLevel: 'low' }, { app: 'B', riskLevel: 'low' }] }), { mode: 0o600 });
  return { home, file, lock: file + '.lock' };
}
async function deadPID() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(String(code)))); });
  return child.pid;
}
for (const kind of ['dead', 'reused', 'leftover-reclaim']) {
  for (const operation of ['add', 'remove', 'remove-all']) test(`${operation} recovers ${kind} without restoring a grant`, { skip: !['darwin', 'linux'].includes(process.platform) && kind !== 'dead' }, async t => {
    const f = fixture(t), pid = kind === 'reused' ? process.pid : await deadPID();
    fs.writeFileSync(f.lock, JSON.stringify({ pid, startTime: '1' }), { mode: 0o600 });
    if (kind === 'leftover-reclaim') fs.writeFileSync(f.lock + '.reclaim', '', { mode: 0o600 });
    if (operation === 'add') assert.equal(await addAsync('C', 'low', { home: f.home }), true);
    else if (operation === 'remove') assert.equal(store.removePreapproved('A', { home: f.home }), true);
    else assert.equal(store.removeAllPreapproved({ home: f.home }), 2);
    assert.deepEqual(store.listPreapproved({ home: f.home }).map(app => app.app), operation === 'add' ? ['A', 'B', 'C'] : operation === 'remove' ? ['B'] : []);
    assert.equal(fs.existsSync(f.lock), false);
  });
}
for (const record of ['', '{', '{"pid":0}', '{"pid":2147483648}']) test(`unprovable lock ${JSON.stringify(record)} names its path and one repair command`, async t => {
  const f = fixture(t); fs.writeFileSync(f.lock, record, { mode: 0o600 });
  await assert.rejects(lockAsync(f.file, () => assert.fail('must not enter'), { timeoutMs: 30 }), err => {
    assert.ok(err.message.includes(f.lock));
    assert.ok(err.message.includes(`rm -f -- '${f.lock}' '${f.lock}.reclaim'`));
    return true;
  });
  assert.equal(fs.readFileSync(f.lock, 'utf8'), record);
  assert.deepEqual(store.listPreapproved({ home: f.home }).map(app => app.app), ['A', 'B']);
});
test('a genuine live owner is retained and timeout remains five seconds while timers run', async t => {
  const f = fixture(t); fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20), started = Date.now();
  try { await assert.rejects(lockAsync(f.file, () => assert.fail('must not enter')), /writer busy/); }
  finally { clearInterval(timer); }
  assert.ok(Date.now() - started >= 4900);
  assert.ok(ticks >= 2, `event loop advanced ${ticks} times`);
  assert.equal(fs.existsSync(f.lock), true);
});
test('Always allow waits asynchronously and succeeds when the live writer releases', async t => {
  const f = fixture(t); fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; fs.unlinkSync(f.lock); }, 100);
  try { assert.equal(await addAsync('C', 'low', { home: f.home }), true); }
  finally { clearTimeout(timer); }
  assert.equal(timerFired, true);
  assert.deepEqual(store.listPreapproved({ home: f.home }).map(app => app.app), ['A', 'B', 'C']);
});
for (const outcome of ['live', 'error', 'invalid']) test(`async process identity lookup yields during contention: ${outcome}`, async t => {
  const f = fixture(t), birth = 'Mon Nov  2 00:00:00 2026', startTime = String(Date.parse(birth + ' GMT') / 1000);
  const record = JSON.stringify({ pid: process.pid, startTime });
  fs.writeFileSync(f.lock, record, { mode: 0o600 });
  const calls = []; let syncCalls = 0, ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  t.after(() => { clearInterval(timer); t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(childProcess, 'execFileSync', () => { syncCalls++; return birth; });
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    const before = ticks;
    calls.push({ command, args, options });
    setTimeout(() => {
      assert.ok(ticks > before, 'timers must run while ps is pending');
      callback(outcome === 'error' ? Object.assign(new Error('ps timeout'), { code: 'ETIMEDOUT' }) : null,
        outcome === 'invalid' ? 'unreadable birth' : birth);
    }, 40);
  });
  syncBuiltinESMExports();
  const started = Date.now();
  await assert.rejects(lockAsync(f.file, () => assert.fail('must retain live holder'), { timeoutMs: 250 }), /writer busy/);
  assert.equal(syncCalls, 0, 'neither own birth nor holder birth may call synchronous ps');
  assert.ok(calls.length >= 3, `expected own birth and repeated holder polls, got ${calls.length}`);
  for (const { command, args, options } of calls) {
    assert.equal(command, '/bin/ps'); assert.deepEqual(args, ['-o', 'lstart=', '-p', String(process.pid)]);
    assert.ok(options.timeout > 0 && options.timeout <= 1000); assert.equal(options.killSignal, 'SIGKILL');
  }
  assert.ok(Date.now() - started >= 250, 'contention must last until its deadline');
  assert.equal(fs.readFileSync(f.lock, 'utf8'), record);
});
test('unsafe recovery guard refuses with repair command without touching its target', async t => {
  const f = fixture(t), target = join(f.home, 'target');
  fs.writeFileSync(f.lock, JSON.stringify({ pid: await deadPID() }), { mode: 0o600 });
  fs.writeFileSync(target, 'unchanged', { mode: 0o600 }); fs.symlinkSync(target, f.lock + '.reclaim');
  await assert.rejects(lockAsync(f.file, () => assert.fail('unsafe guard')), err => {
    assert.ok(err.message.includes(f.lock)); assert.match(err.message, /rm -f --/); return true;
  });
  assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
});

test('simultaneous stale-lock reclaimers serialize additions and revocations', async t => {
  const f = fixture(t), moduleURL = source.href;
  for (const operation of ['add', 'remove']) {
    fs.writeFileSync(f.lock, JSON.stringify({ pid: await deadPID() }), { mode: 0o600 });
    const code = `import * as fs from 'node:fs'; import { setTimeout as delay } from 'node:timers/promises';
      const store = await import(process.argv[1]), home = process.argv[2], app = process.argv[3], op = process.argv[4];
      fs.writeFileSync(home + '/ready-' + op + app, '');
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(home + '/ready-' + op + (app === 'A' ? 'B' : 'A'))) { if (Date.now() >= deadline) throw Error('rendezvous timeout'); await delay(5); }
      if (op === 'add') await (store.addPreapprovedAsync ?? store.addPreapproved)(app + 'new', 'low', { home });
      else store.removePreapproved(app, { home });`;
    const writers = ['A', 'B'].map(app => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, moduleURL, f.home, app, operation],
        { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000, killSignal: 'SIGKILL' });
      let stderr = ''; child.stderr.on('data', data => stderr += data);
      return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => code === 0 ? resolve() : reject(Error(`${code ?? signal}: ${stderr}`))); });
    });
    await Promise.all(writers);
    assert.deepEqual(store.listPreapproved({ home: f.home }).map(app => app.app).sort(), operation === 'add' ? ['A', 'Anew', 'B', 'Bnew'] : ['Anew', 'Bnew']);
  }
});
for (const startTime of ['', 'garbled', '-1']) test(`a live PID with malformed birth ${JSON.stringify(startTime)} is not evicted`, async t => {
  const f = fixture(t), record = JSON.stringify({ pid: process.pid, startTime });
  fs.writeFileSync(f.lock, record, { mode: 0o600 });
  await assert.rejects(lockAsync(f.file, () => assert.fail('live owner'), { timeoutMs: 30 }), /writer busy/);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), record);
});
test('parked platforms retain legacy dead-owner recovery without a flock dependency', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.lock, JSON.stringify({ pid: await deadPID() }), { mode: 0o600 });
  const code = `Object.defineProperty(process, 'platform', { value: 'win32' });
    const store = await import(process.argv[1]);
    store.withPreapprovedLock(process.argv[2], () => {}, { timeoutMs: 100 });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, source.href, f.file],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000, killSignal: 'SIGKILL' });
  let stderr = ''; child.stderr.on('data', data => stderr += data);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(exit, 0, stderr);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(fs.existsSync(f.lock + '.reclaim'), false);
});
for (const change of ['remove', 'lower']) test(`a pending Always allow cannot undo a later ${change}`, async t => {
  const f = fixture(t);
  if (change === 'lower') fs.writeFileSync(f.file, JSON.stringify({ version: 1, apps: [{ app: 'A', riskLevel: 'medium' }, { app: 'B', riskLevel: 'low' }] }), { mode: 0o600 });
  fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const pending = addAsync('A', 'high', { home: f.home });
  const refused = assert.rejects(pending, /approval changed while waiting/);
  await new Promise(resolve => setTimeout(resolve, 30));
  fs.unlinkSync(f.lock);
  if (change === 'remove') store.removePreapproved('A', { home: f.home });
  else fs.writeFileSync(f.file, JSON.stringify({ version: 1, apps: [{ app: 'A', riskLevel: 'low' }, { app: 'B', riskLevel: 'low' }] }), { mode: 0o600 });
  await refused;
  const apps = store.listPreapproved({ home: f.home });
  assert.deepEqual(apps.map(app => app.app), change === 'remove' ? ['B'] : ['A', 'B']);
  assert.equal(apps.find(app => app.app === 'A')?.riskLevel, change === 'remove' ? undefined : 'low');
});
