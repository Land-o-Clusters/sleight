import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, renameSync, rmSync, realpathSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { assertUploadLocation, assertUploadOwnership, assertMacUploadMetadata, uploadRefusals } from '../plugins/sleight/lib/direct-browser/upload-paths.mjs';
import { createFileAuthority, consumeStagedFilePayloads } from '../plugins/sleight/lib/direct-browser/host-files.mjs';
import { createUserFileProvider } from '../plugins/sleight/lib/direct-browser/files.mjs';

const binding = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn', leaseGeneration: 1,
  target: 'target', frame: 'frame', document: 1, origin: 'https://fixture.invalid', operation: 'upload', ref: 'e1' };
const home = '/Users/upload-fixture';
function fixture(t) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'fd4-upload-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'resume.txt'); writeFileSync(file, 'user-approved bytes', { mode: 0o600 });
  const authority = createFileAuthority({ approve: async () => true, now: () => 100 });
  return { directory, file, authority };
}
const refuses = (fn, message) => assert.throws(fn, error => error.message === message);

test('hidden names are refused in every path component before filesystem access', () => {
  for (const path of ['/private/tmp/.env', '/private/tmp/.credentials/resume.txt', home + '/.ssh/id_ed25519',
    home + '/Documents/.resume.pdf', home + '/Library/Mobile Documents/com~apple~CloudDocs/.secret'])
    refuses(() => assertUploadLocation(path, { home }), uploadRefusals.hidden);
  assert.doesNotThrow(() => assertUploadLocation(home + '/Documents/resume.v2.pdf', { home }));
});

test('Library refuses even named files and case aliases; iCloud Drive documents are the narrow exception', () => {
  for (const suffix of ['/Library', '/Library/Application Support/session.txt', '/library/Cookies/cookies.db',
    '/LIBRARY/Keychains/login.keychain-db', '/Library/Mobile Documents/another-app/secret',
    '/Library/Mobile Documents/com~apple~CloudDocs-backup/secret'])
    refuses(() => assertUploadLocation(home + suffix, { home }), uploadRefusals.library);
  for (const suffix of ['/Library/Mobile Documents/com~apple~CloudDocs/resume.pdf', '/Library-backup/report.pdf'])
    assert.doesNotThrow(() => assertUploadLocation(home + suffix, { home }));
});

test('system paths are refused, while canonical temp files and ordinary document roots pass lexical checks', () => {
  for (const path of ['/System/a', '/Library/a', '/usr/a', '/bin/a', '/sbin/a', '/etc/a', '/dev/null',
    '/Applications/Any.app/Contents/Info.plist', '/var/a', '/private/etc/a', '/private/var/db/a', '/private/tmp-backup/a'])
    refuses(() => assertUploadLocation(path, { home }), uploadRefusals.system);
  for (const path of ['/private/tmp/resume.txt', '/private/var/folders/ab/account/T/resume.txt',
    '/Volumes/Documents/resume.txt', home + '/Documents/resume.txt'])
    assert.doesNotThrow(() => assertUploadLocation(path, { home }));
  for (const path of ['~/Documents/resume.txt', 'relative.txt', '/private/tmp/a/../b', '/private/tmp/a\0b'])
    assert.throws(() => assertUploadLocation(path, { home }), /absolute and normalized/);
});

test('macOS metadata refuses Finder-hidden files and mutating ACLs, retaining protective ACLs', () => {
  const file = '-rw-------  1 501  20 - 10 Oct 24 12:00 /synthetic/resume.txt';
  const folder = 'drwxr-xr-x+  2 501  20 - 64 Oct 24 12:00 /synthetic';
  const root = 'drwxr-xr-x  2 0  0 hidden 64 Oct 24 12:00 /private';
  assert.doesNotThrow(() => assertMacUploadMetadata([root, folder, ' 0: group:everyone deny delete', file].join('\n'), 501, 3));
  refuses(() => assertMacUploadMetadata(file.replace('20 -', '20 hidden'), 501, 1), uploadRefusals.hidden);
  refuses(() => assertMacUploadMetadata(folder.replace('20 -', '20 hidden'), 501, 1), uploadRefusals.hidden);
  refuses(() => assertMacUploadMetadata(root.replace('/private', '/Documents/root-owned'), 501, 1), uploadRefusals.hidden);
  for (const permission of ['write', 'append', 'delete', 'delete_child', 'add_file', 'add_subdirectory', 'writesecurity', 'writeattr'])
    refuses(() => assertMacUploadMetadata(folder + '\n 0: user:other allow ' + permission, 501, 1), uploadRefusals.shared);
  refuses(() => assertMacUploadMetadata('unknown output', 501, 1), uploadRefusals.metadata);
});

test('ownership policy rejects foreign owners and writable entries; root sticky parents are safe', () => {
  const uid = 501, stat = (owner, mode) => ({ uid: owner, mode });
  for (const [owner, mode, directory] of [[502, 0o700, true], [502, 0o600, false], [501, 0o777, true],
    [501, 0o660, false], [0, 0o777, true], [501, 0o1777, true], [0, 0o1666, false]])
    refuses(() => assertUploadOwnership(stat(owner, mode), uid, directory), uploadRefusals.shared);
  for (const [owner, mode, directory] of [[0, 0o1777, true], [501, 0o700, true], [501, 0o644, false], [0, 0o755, true]])
    assert.doesNotThrow(() => assertUploadOwnership(stat(owner, mode), uid, directory));
});

test('iCloud metadata exempts only its hidden home Library ancestor', () => {
  const library = `drwx------  2 501 20 hidden 64 Oct 24 12:00 ${home}/Library`;
  const root = `drwx------  2 501 20 - 64 Oct 24 12:00 ${home}/Library/Mobile Documents/com~apple~CloudDocs`;
  const file = `-rw-------  1 501 20 - 10 Oct 24 12:00 ${home}/Library/Mobile Documents/com~apple~CloudDocs/resume.txt`;
  assert.doesNotThrow(() => assertMacUploadMetadata([library, root, file].join('\n'), 501, 3, { home }));
  for (const hidden of [root, file]) {
    const entries = [library, root, file].map(line => line === hidden ? line.replace('20 -', '20 hidden') : line);
    refuses(() => assertMacUploadMetadata(entries.join('\n'), 501, 3, { home }), uploadRefusals.hidden);
  }
  for (const suffix of ['/Documents/resume.txt', '/Library/Application Support/resume.txt',
    '/Library/Mobile Documents/com~apple~CloudDocs-backup/resume.txt']) {
    refuses(() => assertMacUploadMetadata(library + '\n' + file.replace(/\/Library\/Mobile Documents\/com~apple~CloudDocs\/resume.txt$/, suffix),
      501, 2, { home }), uploadRefusals.hidden);
  }
});

test('hidden Volumes infrastructure passes but hidden mounts and files still refuse', () => {
  const volumes = 'drwxr-xr-x  2 0 0 hidden 64 Oct 24 12:00 /Volumes';
  const mount = 'drwxr-xr-x  2 501 20 - 64 Oct 24 12:00 /Volumes/Documents';
  const file = '-rw-------  1 501 20 - 10 Oct 24 12:00 /Volumes/Documents/resume.txt';
  assert.doesNotThrow(() => assertMacUploadMetadata([volumes, mount, file].join('\n'), 501, 3));
  for (const hidden of [mount, file]) {
    const entries = [volumes, mount, file].map(line => line === hidden ? line.replace('20 -', '20 hidden') : line);
    refuses(() => assertMacUploadMetadata(entries.join('\n'), 501, 3), uploadRefusals.hidden);
  }
  refuses(() => assertMacUploadMetadata(volumes.replace('2 0 0', '2 501 20') + '\n' + file, 501, 2), uploadRefusals.hidden);
});

test('files created under a 002 umask refuse until group-write access is removed', async t => {
  const f = fixture(t), file = join(f.directory, 'group-writable.txt');
  const previous = process.umask(0o002);
  try { writeFileSync(file, 'group writable'); } finally { process.umask(previous); }
  await assert.rejects(f.authority.issue([file], binding), error => error.message === uploadRefusals.shared);
  chmodSync(file, 0o640);
  const cap = await f.authority.issue([file], binding), stage = f.authority.stage(cap, binding);
  t.after(() => stage.cleanup());
  assert.equal(Buffer.from(consumeStagedFilePayloads(f.authority, stage, binding).payloads[0].base64, 'base64').toString(), 'group writable');
});

test('macOS per-account temp paths pass the complete authority and retain staging cleanup', { skip: process.platform !== 'darwin' }, async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'fd4b-temp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.match(directory, /^\/private\/var\/folders\/[^/]+\/[^/]+\/T\//);
  const file = join(directory, 'resume.txt'); writeFileSync(file, 'temporary bytes', { mode: 0o600 });
  const authority = createFileAuthority({ approve: async () => true });
  const cap = await authority.issue([file], binding), stage = authority.stage(cap, binding);
  t.after(() => stage.cleanup());
  assert.equal(Buffer.from(consumeStagedFilePayloads(authority, stage, binding).payloads[0].base64, 'base64').toString(), 'temporary bytes');
  assert.deepEqual(stage.cleanup(), { retained: false });
  const uid = userInfo().uid;
  assert.doesNotThrow(() => assertMacUploadMetadata([
    'drwxr-xr-x  2 0 0 hidden 64 Oct 24 12:00 /private',
    'drwxr-xr-x  2 0 0 hidden 64 Oct 24 12:00 /private/var',
    'drwxr-xr-x  2 0 0 hidden 64 Oct 24 12:00 /private/var/folders',
    `-rw-------  1 ${uid} 20 - 10 Oct 24 12:00 ${file}`,
  ].join('\n'), uid, 4));
});

test('approved ordinary files retain opaque single-use byte transfer and owned staging cleanup', async t => {
  const f = fixture(t), cap = await f.authority.issue([f.file], binding), stage = f.authority.stage(cap, binding);
  t.after(() => stage.cleanup());
  const transfer = consumeStagedFilePayloads(f.authority, stage, binding);
  assert.equal(Buffer.from(transfer.payloads[0].base64, 'base64').toString(), 'user-approved bytes');
  assert.equal(transfer.payloads[0].name, 'resume.txt');
  assert.throws(() => consumeStagedFilePayloads(f.authority, stage, binding));
  assert.deepEqual(stage.cleanup(), { retained: false });
});

test('explicit user naming and approval cannot authorize a hidden file or hidden ancestor', async t => {
  const f = fixture(t), user = {};
  for (const file of [join(f.directory, '.env'), join(f.directory, '.private', 'resume.txt')]) {
    mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'never transferred');
    const provider = createUserFileProvider({ current: () => binding,
      resolveInput: ref => ({ ...binding, ref, name: 'Resume' }),
      readUserMessage: event => event === user ? { session: 'client', text: `Upload "${file}" to Resume` } : null });
    refuses(() => provider.offer(user, [file], 'e1'), uploadRefusals.hidden);
    await assert.rejects(f.authority.issue([file], binding), error => error.message === uploadRefusals.hidden);
    assert.deepEqual(provider.dispose(), { retained: 0 });
  }
});

test('actual macOS Finder flag and write-granting ACL metadata refuse owned fixture files', { skip: process.platform !== 'darwin' }, async t => {
  const hidden = fixture(t), acl = fixture(t);
  execFileSync('/usr/bin/chflags', ['hidden', hidden.file]);
  await assert.rejects(hidden.authority.issue([hidden.file], binding), error => error.message === uploadRefusals.hidden);
  execFileSync('/bin/chmod', ['+a', 'everyone allow write', acl.file]);
  await assert.rejects(acl.authority.issue([acl.file], binding), error => error.message === uploadRefusals.shared);
});

test('symlink files and parent directories never become file capabilities', async t => {
  const f = fixture(t), alias = join(f.directory, 'alias.txt'), folder = join(f.directory, 'folder');
  symlinkSync(f.file, alias); symlinkSync(f.directory, folder);
  for (const file of [alias, join(folder, 'resume.txt')])
    await assert.rejects(f.authority.issue([file], binding), error => error.message === uploadRefusals.links);
});

test('writable files and swappable parent directories are refused and rechecked after approval', async t => {
  const f = fixture(t), parent = join(f.directory, 'shared'); mkdirSync(parent);
  const file = join(parent, 'resume.txt'); writeFileSync(file, 'approved');
  chmodSync(parent, 0o777);
  await assert.rejects(f.authority.issue([file], binding), error => error.message === uploadRefusals.shared);
  chmodSync(parent, 0o700); chmodSync(file, 0o666);
  await assert.rejects(f.authority.issue([file], binding), error => error.message === uploadRefusals.shared);
  chmodSync(file, 0o600);
  const cap = await f.authority.issue([file], binding); chmodSync(parent, 0o777);
  refuses(() => f.authority.stage(cap, binding), uploadRefusals.shared);
  chmodSync(parent, 0o700);
  assert.throws(() => f.authority.stage(cap, binding), /Invalid file capability/);
});

test('all folders are refused without recursive enumeration', async t => {
  const f = fixture(t), folder = join(f.directory, 'folder'); mkdirSync(folder);
  // The policy rejects the directory type itself. Its entry count cannot grant access.
  await assert.rejects(f.authority.issue([folder], binding), error => error.message === uploadRefusals.type);
  assert.equal(f.authority.checkPaths([f.file]).length, 1);
});

test('FIFO is refused before open, so no writer or blocking read is needed', { timeout: 3000 }, async t => {
  const f = fixture(t), pipe = join(f.directory, 'pipe');
  execFileSync('/usr/bin/mkfifo', [pipe]);
  await assert.rejects(f.authority.issue([pipe], binding), error => error.message === uploadRefusals.type);
});

test('replacement with equal bytes or a symlink after approval is refused and consumes the capability', async t => {
  for (const replacement of ['file', 'symlink']) {
    const f = fixture(t), cap = await f.authority.issue([f.file], binding), previous = join(f.directory, 'previous.txt');
    renameSync(f.file, previous);
    if (replacement === 'file') writeFileSync(f.file, 'user-approved bytes'); else symlinkSync(previous, f.file);
    assert.throws(() => f.authority.stage(cap, binding), /Approved file changed|symbolic links/);
    assert.throws(() => f.authority.stage(cap, binding), /Invalid file capability/);
  }
});

test('files over 40 MiB and aggregate uploads over 40 MiB are refused', async t => {
  const f = fixture(t);
  const sparse = (name, size) => {
    const file = join(f.directory, name), fd = openSync(file, 'wx', 0o600);
    try { ftruncateSync(fd, size); } finally { closeSync(fd); }
    return file;
  };
  const large = sparse('large.bin', 40 * 1024 * 1024 + 1);
  await assert.rejects(f.authority.issue([large], binding), error => error.message === uploadRefusals.size);
  const exact = sparse('exact.bin', 40 * 1024 * 1024);
  assert.equal(f.authority.checkPaths([exact])[0].size, 40 * 1024 * 1024);
  const a = sparse('a.bin', 21 * 1024 * 1024), b = sparse('b.bin', 20 * 1024 * 1024);
  await assert.rejects(f.authority.issue([a, b], binding), error => error.message === uploadRefusals.size);
  refuses(() => f.authority.checkPaths([a, b]), uploadRefusals.size);
});
