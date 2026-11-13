import { trackTemp } from '../scripts/temp-leftovers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync,
  symlinkSync, openSync, readSync, fstatSync, closeSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClipboardSnapshotStore, recoverClipboardSnapshots, readClipboardBootSession,
  excludeClipboardSnapshotsFromBackup } from '../plugins/sleight/lib/clipboard-recovery.mjs';
import { createClipboardPasteSession, recoverNativeClipboard } from '../plugins/sleight/lib/clipboard.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { PassThrough } from 'node:stream';

const original = [[{ type: 'public.utf8-plain-text', data: Buffer.from('original fixture').toString('base64') }]];
const transient = { type: 'org.nspasteboard.TransientType', data: '' };
const staged = [[{ type: 'public.utf8-plain-text', data: Buffer.from('staged fixture').toString('base64') }, transient]];
const snapshotNames = directory => readdirSync(directory).filter(name => name.startsWith('snapshot-'));
function fixture(t, options = {}) {
  const root = trackTemp(mkdtempSync(join(realpathSync(tmpdir()), 'sleight-snapshot-policy-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'clipboard'), protection = [], notices = [];
  let time = 1800000000000, boot = 'fixture-boot', board = { count: 1, items: structuredClone(staged) }, writes = 0, held = false;
  const storeOptions = { directory, now: () => time, bootSession: () => boot,
    excludeFromBackup: path => protection.push(path), ...options };
  const store = createClipboardSnapshotStore(storeOptions);
  const io = async request => {
    if (request.op === 'acquire') { assert.equal(held, false); held = true; return; }
    if (request.op === 'release') { held = false; return; }
    assert.equal(held, true);
    if (request.op === 'read') return structuredClone(board);
    assert.equal(request.op, 'write'); assert.equal(request.expectedCount, board.count);
    writes++; board = { count: board.count + 1, items: structuredClone(request.items) }; return { count: board.count };
  };
  io.snapshotStore = store;
  return { root, directory, store, io, protection, notices, notice: (code, path) => notices.push({ code, path }),
    board: () => board, writes: () => writes, held: () => held, age: ms => { time += ms; },
    boot: value => { boot = value; io.snapshotStore = createClipboardSnapshotStore(storeOptions); },
    setBoard: items => { board = { count: board.count + 1, items: structuredClone(items) }; } };
}

for (const kind of ['unsafe-file', 'unsafe-directory', 'exhausted']) test(`startup skips ${kind}, names the path and collects its reservation`, async t => {
  const f = fixture(t); const first = f.store.save({ original, staged });
  let expectedPath = join(f.directory, first.name), laterAttempts = 0;
  if (kind === 'unsafe-file') { rmSync(expectedPath); symlinkSync(join(f.root, 'missing'), expectedPath); }
  if (kind === 'unsafe-directory') {
    rmSync(f.directory, { recursive: true }); mkdirSync(join(f.root, 'outside')); symlinkSync(join(f.root, 'outside'), f.directory);
    expectedPath = f.directory;
  }
  const later = kind === 'unsafe-directory' ? undefined : f.store.save({ original, staged });
  const entries = kind === 'unsafe-directory' ? undefined : f.store.list();
  const io = async request => {
    if (request.op === 'write' && kind === 'exhausted') {
      if (++laterAttempts <= 5) throw Error('fixture restore unavailable');
    }
    return f.io(request);
  };
  // Keep ordering deterministic so a broken record is followed by a valid one.
  io.snapshotStore = entries ? { ...f.store, list: () => [entries.find(e => e.token?.name === first.name || e.path === expectedPath),
    entries.find(e => e.token?.name === later.name)] } : f.store;
  await recoverNativeClipboard({ io, notice: f.notice });
  assert.equal(f.held(), false);
  assert.ok(f.notices.some(row => row.path === expectedPath && row.code === (kind === 'exhausted'
    ? 'CLIPBOARD_SNAPSHOT_RETAINED' : 'CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE')), JSON.stringify(f.notices));
  if (later) {
    assert.equal(f.writes(), 1, 'the later valid record was restored');
    assert.ok(!snapshotNames(f.directory).includes(later.name));
  }
});

for (const kind of ['expired', 'different-boot', 'future', 'legacy']) test(`empty pasteboard never restores a ${kind} snapshot`, async t => {
  const f = fixture(t), token = f.store.save({ original, staged }); f.setBoard([]);
  if (kind === 'expired') f.age(600001);
  if (kind === 'different-boot') f.boot('next-boot');
  if (kind === 'future') f.age(-1);
  if (kind === 'legacy') {
    const path = join(f.directory, token.name), bytes = readFileSync(path), size = bytes.readUInt32BE();
    const metadata = JSON.parse(bytes.subarray(4, 4 + size)); metadata.version = 1;
    delete metadata.createdAt; delete metadata.bootSession;
    const header = Buffer.from(JSON.stringify(metadata)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
    writeFileSync(path, Buffer.concat([prefix, header, bytes.subarray(4 + size)]));
  }
  await recoverClipboardSnapshots(f.io, { notice: f.notice });
  assert.equal(f.writes(), 0); assert.deepEqual(f.board().items, []); assert.deepEqual(snapshotNames(f.directory), []);
  assert.ok(f.notices.some(row => row.path === join(f.directory, token.name)));
});
test('snapshot carries its creation time and boot session, and the ten minute boundary still restores', async t => {
  const f = fixture(t); f.store.save({ original, staged });
  assert.equal(f.store.list()[0].record.createdAt, 1800000000000);
  assert.equal(f.store.list()[0].record.bootSession, 'fixture-boot');
  f.age(600000); f.setBoard([]);
  await recoverClipboardSnapshots(f.io); assert.equal(f.writes(), 1);
});

for (const type of ['org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType', 'com.agilebits.onepassword',
  'de.petermaurer.TransientPasteboardType', 'com.typeit4me.clipping', 'Pasteboard generator type',
  'application/x-nspasteboard-concealed-type', 'com.trolltech.anymime.application--x-nspasteboard-concealed-type']) {
  test(`original marked ${type} stays in memory, including markers on a later item`, async t => {
    const f = fixture(t), secret = [...structuredClone(original), [{ type, data: '' }]];
    f.setBoard(secret);
    const io = Object.assign(request => f.io(request), { snapshotStore: { ...f.store,
      save: record => { assert.fail('sensitive originals must bypass persistence entirely'); } } });
    await createClipboardPasteSession(io).paste('paste fixture', async () => {
      assert.equal(readdirSync(f.root).length, 0);
    });
    assert.deepEqual(f.board().items, secret.map(reps => reps.some(rep => rep.type === transient.type) ? reps : [...reps, transient]));
    assert.equal(f.store.save({ original: secret, staged }), undefined, 'the store also refuses direct sensitive saves');
    assert.deepEqual(readdirSync(f.root), []);
  });
}
test('memory-only original is never persisted after restoration exhausts', async t => {
  const f = fixture(t), secret = [[...original[0], { type: 'org.nspasteboard.ConcealedType', data: '' }]]; f.setBoard(secret);
  let writes = 0;
  const io = Object.assign(async request => {
    if (request.op === 'write' && request.items.length && ++writes > 1) throw Error('fixture restore unavailable');
    return f.io(request);
  }, { snapshotStore: f.store });
  await assert.rejects(createClipboardPasteSession(io).paste('fixture', async () => {}), /restoration unconfirmed/);
  assert.deepEqual(readdirSync(f.root), []); assert.deepEqual(f.board().items, []);
});
test('removal overwrites every saved byte with zero before unlinking', t => {
  const f = fixture(t), large = [[{ type: 'public.png', data: Buffer.alloc(150000, 0xa5).toString('base64') }]];
  const token = f.store.save({ original: large, staged }), path = join(f.directory, token.name);
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size; assert.ok(size > 0);
    f.store.remove(token);
    assert.equal(fstatSync(fd).nlink, 0);
    const bytes = Buffer.alloc(size); assert.equal(readSync(fd, bytes, 0, size, 0), size);
    assert.ok(bytes.every(byte => byte === 0));
  } finally { closeSync(fd); }
});
test('snapshot directory excludes backup and indexing before persistence', t => {
  const f = fixture(t); f.store.save({ original, staged });
  assert.deepEqual(f.protection, [f.directory]);
  assert.equal(statSync(join(f.directory, '.metadata_never_index')).isFile(), true);
});
test('recovery and helper cleanup failures are non-fatal even when logging fails', async t => {
  const f = fixture(t);
  const io = Object.assign(async () => { throw Error('unavailable'); }, {
    snapshotStore: { directory: f.directory, hasSnapshots() { throw Error('unsafe'); } }, close: async () => { throw Error('close'); } });
  await recoverNativeClipboard({ io, notice: () => { throw Error('log unavailable'); } });
});
test('boot session reads only kern.boottime, keeps microseconds and refuses unproved values', () => {
  assert.equal(readClipboardBootSession((command, args, options) => {
    assert.equal(command, '/usr/sbin/sysctl'); assert.deepEqual(args, ['-n', 'kern.boottime']);
    assert.equal(options.timeout, 1000); assert.equal(options.maxBuffer, 4096);
    return '{ sec = 1790000000, usec = 123 } Sat Sep 12 12:00:00 2026\n';
  }), '1790000000:123');
  assert.throws(() => readClipboardBootSession(() => 'unknown'), /snapshot/);
});
test('backup exclusion uses the metadata xattr and a binary plist value', () => {
  excludeClipboardSnapshotsFromBackup('/fixture', (command, args, options) => {
    assert.equal(command, '/usr/bin/xattr');
    assert.deepEqual(args.slice(0, 2), ['-wx', 'com.apple.metadata:com_apple_backup_excludeItem']);
    assert.equal(Buffer.from(args[2], 'hex').subarray(0, 8).toString(), 'bplist00');
    assert.ok(Buffer.from(args[2], 'hex').includes(Buffer.from('com.apple.backupd')));
    assert.equal(args[3], '/fixture'); assert.equal(options.timeout, 1000);
  });
});
test('macOS backup exclusion xattr is present on the owned fixture directory', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t, { excludeFromBackup: excludeClipboardSnapshotsFromBackup }); f.store.save({ original, staged });
  const value = execFileSync('/usr/bin/xattr', ['-px', 'com.apple.metadata:com_apple_backup_excludeItem', f.directory], { encoding: 'utf8' });
  const bytes = Buffer.from(value.replace(/\s/g, ''), 'hex');
  assert.equal(bytes.subarray(0, 8).toString(), 'bplist00'); assert.ok(bytes.includes(Buffer.from('com.apple.backupd')));
});
test('protection failure at startup still attempts every snapshot', async t => {
  const f = fixture(t), token = f.store.save({ original, staged });
  f.io.snapshotStore = { ...f.store, protect: () => { throw Error('fixture xattr unavailable'); } };
  await recoverNativeClipboard({ io: f.io, notice: f.notice });
  assert.equal(f.writes(), 1); assert.deepEqual(snapshotNames(f.directory), []);
  assert.deepEqual(f.notices, [{ code: 'CLIPBOARD_SNAPSHOT_PROTECTION_FAILED', path: f.directory },
    { code: 'CLIPBOARD_SNAPSHOT_RESTORED', path: join(f.directory, token.name) }]);
});
test('an unavailable boot session refuses persistence before staging, and startup skips it without reading the board', async t => {
  const f = fixture(t), token = f.store.save({ original, staged });
  f.io.snapshotStore = createClipboardSnapshotStore({ directory: f.directory, bootSession: () => { throw Error('fixture sysctl unavailable'); },
    excludeFromBackup: () => {} });
  const io = Object.assign(request => {
    assert.ok(!['read', 'write'].includes(request.op)); return f.io(request);
  }, { snapshotStore: f.io.snapshotStore });
  await recoverNativeClipboard({ io, notice: f.notice });
  assert.deepEqual(snapshotNames(f.directory), [token.name]); assert.equal(f.writes(), 0);
  f.setBoard(original);
  await assert.rejects(createClipboardPasteSession(f.io).paste('fixture', () => assert.fail('no input')), /fixture sysctl unavailable/);
  assert.equal(f.writes(), 0);
});
test('relay still accepts and returns a request after unsafe startup recovery', async t => {
  const f = fixture(t); mkdirSync(join(f.root, 'outside')); symlinkSync(join(f.root, 'outside'), f.directory);
  await recoverNativeClipboard({ io: f.io, notice: f.notice });
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const forwarded = [], replies = [];
  serverIn.on('data', data => forwarded.push(JSON.parse(data))); clientOut.on('data', data => replies.push(JSON.parse(data)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, clipboardIO: f.io });
  try {
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(forwarded[0].method, 'tools/list');
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) + '\n');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(replies[0].id, 1);
    assert.equal(f.notices[0].code, 'CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE');
  } finally { await relay.close(); }
});
test('a worker crash loses a concealed original because no recovery snapshot exists', async t => {
  const f = fixture(t), boardPath = join(f.root, 'board.json');
  const child = spawnSync(process.execPath, [new URL('./fixtures/clipboard-crash.mjs', import.meta.url).pathname,
    f.directory, boardPath, 'org.nspasteboard.ConcealedType'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.deepEqual(readdirSync(f.root), ['board.json']);
  f.setBoard(JSON.parse(readFileSync(boardPath, 'utf8')).items);
  await recoverNativeClipboard({ io: f.io, notice: f.notice });
  assert.equal(f.writes(), 0); assert.deepEqual(f.board().items[0].find(rep => rep.type === 'public.utf8-plain-text'),
    { type: 'public.utf8-plain-text', data: Buffer.from('private').toString('base64') });
});
test('a concealed on-disk record is zeroed and discarded before clipboard IO', async t => {
  const f = fixture(t), token = f.store.save({ original, staged }), path = join(f.directory, token.name);
  const bytes = readFileSync(path), size = bytes.readUInt32BE(), metadata = JSON.parse(bytes.subarray(4, 4 + size));
  metadata.original[0].push({ type: 'org.nspasteboard.ConcealedType', size: 0 });
  const header = Buffer.from(JSON.stringify(metadata)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
  writeFileSync(path, Buffer.concat([prefix, header, bytes.subarray(4 + size)]));
  const fd = openSync(path, 'r');
  const io = Object.assign(request => { assert.ok(!['read', 'write'].includes(request.op)); return f.io(request); }, { snapshotStore: f.store });
  try {
    await recoverNativeClipboard({ io, notice: f.notice });
    const zeros = Buffer.alloc(fstatSync(fd).size); readSync(fd, zeros, 0, zeros.length, 0);
    assert.equal(fstatSync(fd).nlink, 0); assert.ok(zeros.every(byte => byte === 0));
    assert.deepEqual(f.notices, [{ code: 'CLIPBOARD_SNAPSHOT_DISCARDED_CONCEALED', path }]);
  } finally { closeSync(fd); }
});
