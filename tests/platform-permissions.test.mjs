import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { createFilePermissions } from '../plugins/sleight/lib/platform/file-permissions.mjs';
import { getPlatform } from '../plugins/sleight/lib/platform/index.mjs';

function fixture(t) {
  const dir = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-permission-cache-'))));
  const path = join(dir, 'hand.json'); writeFileSync(path, '{}', { mode: 0o600 }); return { dir, path };
}

test('sync and async permissions cache by identity, ctime, mode, owner and kind', async t => {
  const { path, dir } = fixture(t); let checks = 0;
  const permissions = createFilePermissions({ inspect: () => { checks++; return { ok: true }; } });
  assert.equal(permissions.privateFile(path).ok, true);
  assert.equal(permissions.privateFile(path).ok, true);
  assert.equal((await permissions.privateFileAsync(path)).ok, true);
  assert.equal(checks, 1);
  chmodSync(path, 0o640); assert.equal((await permissions.privateFileAsync(path)).ok, true);
  assert.equal(checks, 2);
  permissions.privateFile(path, { uid: 123456 }); permissions.privateDirectory(path);
  assert.equal(checks, 4);
  const next = join(dir, 'replacement'); writeFileSync(next, '{}', { mode: 0o640 }); renameSync(next, path);
  assert.equal(permissions.privateFile(path).ok, true); assert.equal(checks, 5);
});

test('ctime changes alone invalidate permission evidence', () => {
  let ctimeMs = 1, checks = 0;
  const stat = () => ({ dev: 1, ino: 2, uid: 3, mode: 0o600, nlink: 1, size: 2, mtimeMs: 1, ctimeMs });
  const permissions = createFilePermissions({ stat, statAsync: async () => stat(), inspect: () => { checks++; return { ok: checks === 1, reason: 'DACL changed' }; } });
  assert.equal(permissions.privateFile('fixture').ok, true);
  ctimeMs++;
  assert.equal(permissions.privateFile('fixture').reason, 'DACL changed');
  assert.equal(checks, 2);
});

test('async validation that loses its identity never publishes a cached success', async t => {
  const { path, dir } = fixture(t); let checks = 0;
  const permissions = createFilePermissions({ inspectAsync: async () => {
    checks++; const replacement = join(dir, 'new'); writeFileSync(replacement, '{}', { mode: 0o600 }); renameSync(replacement, path);
    return { ok: true };
  } });
  assert.deepEqual(await permissions.privateFileAsync(path), { ok: false, reason: 'file changed' });
  assert.deepEqual(await permissions.privateFileAsync(path), { ok: false, reason: 'file changed' });
  assert.equal(checks, 2);
});

test('missing files, validator errors and unproved Windows ACLs fail closed with reasons', async t => {
  const { path } = fixture(t);
  const permissions = createFilePermissions({ inspect: () => { throw Object.assign(Error(), { code: 'ACL_UNREADABLE' }); } });
  assert.deepEqual(permissions.privateFile(path), { ok: false, reason: 'ACL_UNREADABLE' });
  assert.deepEqual(await permissions.privateFileAsync(path), { ok: false, reason: 'ACL_UNREADABLE' });
  assert.equal(permissions.privateFile(path + '.absent').reason, 'ENOENT');
  for (const method of ['privateFile', 'privateDirectory', 'privateFileAsync', 'privateDirectoryAsync']) {
    const result = await getPlatform('win32').filePermissions[method](path);
    assert.equal(result.ok, false); assert.match(result.reason, /WINDOWS_(?:PLATFORM_REQUIRED|PATH_UNSAFE)/);
  }
});

test('a sync cache miss can be proved asynchronously and then reused by the sync reader', async t => {
  const { path } = fixture(t); let checks = 0;
  const permissions = createFilePermissions({ inspect: () => ({ ok: false, reason: 'uncached' }),
    inspectAsync: async () => { checks++; return { ok: true }; } });
  assert.equal(permissions.privateFile(path).reason, 'uncached');
  assert.equal((await permissions.privateFileAsync(path)).ok, true);
  assert.equal(permissions.privateFile(path).ok, true); assert.equal(checks, 1);
});

test('permission cache evicts old evidence after 256 successful identities', () => {
  let checks = 0;
  const permissions = createFilePermissions({ stat: () => ({ dev: 1, ino: 2, ctimeMs: 3 }), inspect: () => { checks++; return { ok: true }; } });
  for (let i = 0; i < 257; i++) permissions.privateFile('fixture-' + i);
  permissions.privateFile('fixture-256'); assert.equal(checks, 257);
  permissions.privateFile('fixture-0'); assert.equal(checks, 258);
});
