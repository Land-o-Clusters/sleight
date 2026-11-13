import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { withPreapprovedLockAsync } from '../plugins/sleight/lib/preapproved.mjs';

const macTest = (name, action) => test(name, { skip: process.platform !== 'darwin' }, action);
const bank = trackTemp(fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-pa1b-native-'))));
const binary = join(bank, 'selftest');
const source = process.env.PA1B_SWIFT_SOURCE ?? fileURLToPath(new URL('../plugins/sleight/lib/mac-driver/native/SealedSettings.swift', import.meta.url));
const run = (command, args) => spawnSync(command, args, { timeout: 600000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
before(() => {
  if (process.platform !== 'darwin') return;
  fs.copyFileSync(new URL('./fixtures/sealed-settings-main.swift', import.meta.url), join(bank, 'main.swift'));
  const built = run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), '-D', 'SLEIGHT_TEST_KEYSTORE', '-D', 'SLEIGHT_KEYSTORE_PROBE', source, join(bank, 'main.swift'), '-o', binary]);
  assert.equal(built.status, 0, built.stderr);
});
after(() => fs.rmSync(bank, { recursive: true, force: true }));
function fixture(t) {
  const root = registerTemp(t, fs.mkdtempSync(join(bank, 'settings-'))), key = join(root, 'key.json');
  const call = (op, ...args) => run(binary, [root, key, op, ...args]);
  const seed = call('click', 'A', 'physical'); assert.equal(seed.status, 0, seed.stderr);
  return { root, call, lock: join(root, 'preapproved.json.lock') };
}
for (const risks of ['low,high', 'high,low', 'high,medium,low']) macTest(`native duplicates selftest uses the lowest ceiling: ${risks}`, t => {
  const f = fixture(t), result = f.call('selftest-duplicates', risks);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /duplicates selftest passed/);
});
macTest('native schema accepts 2.0 launchTeam values and rejects malformed ones', t => {
  const f = fixture(t), result = f.call('selftest-launch-team');
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /launch team selftest passed/);
});
for (const op of ['block', 'unblock']) for (const count of [1, 2]) macTest(`native deny edit ${op} with ${count} existing entries`, t => {
  const f = fixture(t), result = f.call('selftest-deny-edit', op, String(count));
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /deny edit selftest passed/);
});
for (const kind of ['dead', 'reused', 'leftover-reclaim']) for (const op of ['click', 'remove']) macTest(`native ${op} recovers ${kind}`, t => {
  const f = fixture(t), dead = f.call('verify'); assert.equal(dead.status, 0);
  fs.writeFileSync(f.lock, JSON.stringify({ pid: kind === 'reused' ? process.pid : dead.pid, startTime: '1' }), { mode: 0o600 });
  if (kind === 'leftover-reclaim') fs.writeFileSync(f.lock + '.reclaim', '', { mode: 0o600 });
  const result = op === 'click' ? f.call('click', 'B', 'physical') : f.call('remove', 'A');
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.existsSync(f.lock), false);
  const verified = f.call('verify'); assert.equal(verified.status, 0);
  const row = verified.stdout.trim().split('\n').map(JSON.parse).find(row => row.file === 'preapproved.json');
  assert.deepEqual(JSON.parse(row.content).apps.map(app => app.app), op === 'click' ? ['A', 'B'] : []);
});
macTest('native garbled lock names the lock and repair command', t => {
  const f = fixture(t); fs.writeFileSync(f.lock, '{', { mode: 0o600 });
  const result = f.call('click', 'B', 'physical');
  assert.equal(result.status, 65); assert.ok(result.stderr.includes(f.lock)); assert.match(result.stderr, /rm -f --/);
});
macTest('Node recovery leaves its persistent guard usable by Swift', async t => {
  const f = fixture(t), dead = f.call('verify');
  fs.writeFileSync(f.lock, JSON.stringify({ pid: dead.pid }), { mode: 0o600 });
  // Node must not strand the recovery guard when its asynchronous acquisition completes.
  await withPreapprovedLockAsync(join(f.root, 'preapproved.json'), () => {});
  const result = f.call('click', 'B', 'physical'); assert.equal(result.status, 0, result.stderr);
});

macTest('native recovery waits for the same kernel guard held by Node', async t => {
  const f = fixture(t), guard = f.lock + '.reclaim', dead = f.call('verify');
  fs.writeFileSync(guard, '', { mode: 0o600 });
  fs.writeFileSync(f.lock, JSON.stringify({ pid: dead.pid }), { mode: 0o600 });
  const holder = spawn('/usr/bin/lockf', ['-k', guard, process.execPath, '-e', 'process.stdout.write("ready"); process.stdin.resume();'],
    { stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000, killSignal: 'SIGKILL' });
  const holderClosed = new Promise((resolve, reject) => { holder.once('error', reject); holder.once('close', code => resolve(code)); });
  t.after(async () => { holder.stdin.end(); await holderClosed; });
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
  const writer = spawn(binary, [f.root, join(f.root, 'key.json'), 'click', 'B', 'physical'],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, killSignal: 'SIGKILL' });
  let stderr = ''; writer.stderr.on('data', data => stderr += data); writer.stdout.resume();
  const closed = new Promise((resolve, reject) => { writer.once('error', reject); writer.once('close', code => resolve(code)); });
  let finished = false; closed.then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(finished, false, 'native writer must wait for kernel recovery admission');
  assert.equal(fs.existsSync(f.lock), true);
  holder.stdin.end(); assert.equal(await holderClosed, 0);
  assert.equal(await closed, 0, stderr);
  assert.equal(fs.existsSync(f.lock), false);
});
