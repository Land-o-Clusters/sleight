// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const window = { appId: 'com.apple.TextEdit', title: 'broker.txt', url: `file://${MAC_TMP}/broker.txt` };
const otherWindow = { ...window, title: 'other.txt', url: `file://${MAC_TMP}/other.txt` };
const fixture = fileURLToPath(new URL('./fixtures/lease-broker-cli.mjs', import.meta.url));
const claim = (client = 'outside A', target = window, scope = 'window') => ({ operation: 'acquire', client, window: target, scope });
const use = (operation, lease) => ({ operation, key: lease.key, token: lease.token });
function bank(t) {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-broker-test-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function broker(directory, now = () => 1000) {
  const module = await import('../plugins/sleight/lib/lease-broker.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.brokerRequest, 'function', 'the outside-client broker API must exist');
  return request => module.brokerRequest(request, { directory, now });
}
function cli(directory, request, time = 1000, mode = '') {
  const result = spawnSync(process.execPath, [fixture, directory, String(time), mode], {
    input: typeof request === 'string' ? request : JSON.stringify(request), encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('broker and ordinary sleight leases exclude each other in both acquisition orders', async t => {
  const directory = bank(t), request = await broker(directory);
  const relay = new InputLease({ directory, holder: 'sleight session', now: () => 1000 });
  t.after(() => relay.close());
  const outside = request(claim()).lease;
  assert.throws(() => relay.acquire(window), /outside A.*30 s/);
  request(use('release', outside));
  relay.acquire(window);
  assert.throws(() => request(claim()), /sleight session.*30 s/);
  relay.release();
  const next = request(claim('outside B')).lease;
  request(use('release', next));
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.json')), []);
});

test('two independent CLI processes racing one window grant exactly one client', async t => {
  const directory = bank(t);
  const children = ['outside A', 'outside B'].map(client => spawn(process.execPath,
    [fixture, directory, '1000'], { stdio: ['pipe', 'pipe', 'pipe'] }));
  const replies = children.map(child => new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  }));
  children.forEach((child, index) => child.stdin.end(JSON.stringify(claim(index ? 'outside B' : 'outside A'))));
  const results = await Promise.all(replies);
  assert.equal(results.filter(result => result.status === 0).length, 1, JSON.stringify(results));
  const winner = JSON.parse(results.find(result => result.status === 0).stdout).lease;
  const loser = JSON.parse(results.find(result => result.status === 1).stdout);
  assert.equal(loser.ok, false);
  assert.match(loser.error, /Input lease/);
  const released = cli(directory, use('release', winner));
  assert.equal(released.status, 0, released.stderr);
});

test('a crashed outside client leaves a lease that expires at 30 seconds and fences its old token', async t => {
  const directory = bank(t);
  const held = cli(directory, claim('crashed client'), 1000, 'crash');
  assert.equal(held.status, 1, held.stderr);
  assert.match(held.stderr, /simulated outside-client crash/);
  assert.equal(JSON.parse(held.stdout).ok, true);
  const old = JSON.parse(held.stdout).lease;
  assert.equal(cli(directory, claim('successor'), 30999).status, 1);
  const acquired = cli(directory, claim('successor'), 31000);
  assert.equal(acquired.status, 0, acquired.stderr);
  const next = JSON.parse(acquired.stdout).lease;
  assert.notEqual(next.token, old.token);
  const staleRelease = cli(directory, use('release', old), 31001);
  assert.equal(staleRelease.status, 1);
  assert.match(JSON.parse(staleRelease.stdout).error, /ownership|expired/i);
  const request = await broker(directory, () => 31001);
  assert.equal(request({ operation: 'status', key: next.key }).lease.holder, 'successor');
  assert.throws(() => request(claim('third')), /successor/);
  request(use('release', next));
});

test('a different client token cannot release a held lease, and repeated release is refused', async t => {
  const directory = bank(t), request = await broker(directory);
  const a = request(claim('outside A')).lease, b = request(claim('outside B', otherWindow)).lease;
  assert.throws(() => request({ ...use('release', a), token: b.token }), /ownership/i);
  assert.throws(() => request(claim('contender')), /outside A/);
  request(use('release', a));
  assert.throws(() => request(use('release', a)), /ownership/i);
  request(use('release', b));
});

test('renewal extends the held lease, status hides tokens, and expired tokens cannot renew or release', async t => {
  const directory = bank(t);
  let time = 1000;
  const request = await broker(directory, () => time), held = request(claim()).lease;
  assert.equal(held.expires, 31000);
  assert.equal(held.active, true);
  assert.ok(held.token);
  const status = request({ operation: 'status', key: held.key }).lease;
  assert.equal(status.holder, 'outside A');
  assert.equal(status.token, undefined);
  assert.equal(status.path, undefined);
  time = 21000;
  const renewed = request(use('renew', held)).lease;
  assert.equal(renewed.expires, 51000);
  assert.equal(renewed.token, undefined);
  assert.throws(() => request({ ...use('renew', held), token: '00000000-0000-4000-8000-000000000000' }), /ownership/i);
  time = 31000;
  assert.throws(() => request(claim()), /outside A.*20 s/);
  time = 51000;
  assert.equal(request({ operation: 'status', key: held.key }).lease.active, false);
  assert.throws(() => request(use('renew', held)), /expired/i);
  assert.throws(() => request(use('release', held)), /expired/i);
});

test('broker app and desktop scopes conflict with ordinary window leases in both orders', async t => {
  for (const scope of ['app', 'desktop']) for (const broadFirst of [true, false]) {
    const directory = bank(t), request = await broker(directory);
    const relay = new InputLease({ directory, holder: 'sleight session', now: () => 1000 });
    t.after(() => relay.close());
    const broad = scope === 'desktop' ? { appId: 'desktop', title: '' } : window;
    if (broadFirst) {
      const held = request(claim('outside', broad, scope)).lease;
      assert.throws(() => relay.acquire(otherWindow), /outside/);
      request(use('release', held));
    } else {
      relay.acquire(otherWindow);
      assert.throws(() => request(claim('outside', broad, scope)), /sleight session/);
    }
  }
});

test('invalid requests, path traversal and approval fields refuse before writing any lease', async t => {
  const directory = bank(t), request = await broker(directory);
  for (const invalid of [null, [], {}, { operation: 'approve', app: 'TextEdit' },
    { ...claim(), approval: true }, { ...claim(), client: '' }, { ...claim(), client: 'fake\nholder' },
    { ...claim(), scope: 'everything' }, { ...claim(), window: { title: 'missing bundle ID' } },
    { ...claim(), window: { ...window, approved: true } }, { ...claim(), window: { ...window, url: 42 } },
    { operation: 'status', key: '../outside' }, { operation: 'release', key: 'a'.repeat(64), token: '' },
    { operation: 'renew', key: 'a'.repeat(64), token: 'not-a-token' }]) {
    assert.throws(() => request(invalid), /broker.*invalid|broker.*unknown/i, JSON.stringify(invalid));
  }
  assert.deepEqual(readdirSync(directory), []);
  const missing = request({ operation: 'status', key: 'a'.repeat(64) });
  assert.equal(missing.lease, null);
});

test('CLI emits one JSON reply and nonzero status for malformed, oversized and refused requests', t => {
  const directory = bank(t), acquired = cli(directory, claim());
  assert.equal(acquired.status, 0, acquired.stderr);
  assert.equal(acquired.stdout.trim().split('\n').length, 1);
  const held = JSON.parse(acquired.stdout).lease;
  for (const invalid of ['{', '{}\n{}', ' '.repeat(16385), claim('contender')]) {
    const failed = cli(directory, invalid);
    assert.equal(failed.status, 1, failed.stderr);
    const reply = JSON.parse(failed.stdout);
    assert.equal(reply.ok, false);
    assert.ok(reply.error);
    assert.equal(failed.stdout.includes(held.token), false);
  }
  assert.equal(cli(directory, use('release', held)).status, 0);
  // Exercise the public entry point without ever selecting the user's real store.
  const entry = fileURLToPath(new URL('../plugins/sleight/lib/lease-broker-cli.mjs', import.meta.url));
  for (const args of [[], ['--directory', directory]]) {
    const result = spawnSync(process.execPath, [entry, ...args], { input: '{', encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout, 'the public CLI must return JSON for invalid requests');
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
});

test('checked store operations refuse foreign tokens without disturbing relay cleanup', t => {
  const directory = bank(t), relay = new InputLease({ directory, holder: 'sleight', now: () => 1000 });
  t.after(() => relay.close());
  assert.equal(typeof relay.releaseGrant, 'function', 'the store needs checked token release');
  const key = relay.acquire(window), token = relay.grant(key).token;
  const path = join(directory, key + '.json'), before = readFileSync(path, 'utf8');
  assert.throws(() => relay.releaseGrant(key, '00000000-0000-4000-8000-000000000000'), /ownership/i);
  assert.equal(readFileSync(path, 'utf8'), before);
  relay.releaseGrant(key, token);
  assert.equal(relay.owned.size, 0);
  assert.doesNotThrow(() => relay.release());
});
