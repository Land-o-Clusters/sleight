import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createCharacterStageCache, characterStageHash, spawnStageRender } from '../plugins/sleight/lib/hand/character-stage.mjs';
import { checkBuiltinCharacter, resolveCharacterStates } from '../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../plugins/sleight/lib/hand/character-frame.mjs';
import { fixtureRender } from './fixtures/character-stage-render.mjs';
import { processStartTime } from '../plugins/sleight/lib/routine-lock.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { writePrivateFileAtomic } from '../plugins/sleight/skills/make-character/tool/lib/atomic-private-file.mjs';
const pack = () => checkBuiltinCharacter('tsugi');
function world(t) {
  const base = registerTemp(t, trackTemp(fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-stage-render-')))));
  return { base, root: join(base, 'cache') };
}
test('atomic cache files are private and invisible until all bytes are synced', t => {
  const w = world(t), target = join(w.base, 'receipt.json'), bytes = Buffer.from('{"ready":true}');
  const write = fs.writeFileSync, sync = fs.fsyncSync, rename = fs.renameSync;
  let synced = false, renamed = false;
  t.mock.method(fsDefault, 'writeFileSync', (fd, data) => {
    assert.equal(typeof fd, 'number'); assert.equal(fs.existsSync(target), false);
    assert.equal(fs.fstatSync(fd).mode & 0o7777, 0o600);
    write(fd, data);
  });
  t.mock.method(fsDefault, 'fsyncSync', fd => {
    assert.equal(fs.existsSync(target), false);
    sync(fd); synced = true;
  });
  t.mock.method(fsDefault, 'renameSync', (temp, path) => {
    assert.equal(synced, true); assert.equal(path, target); assert.equal(dirname(temp), dirname(target));
    assert.deepEqual(fs.readFileSync(temp), bytes);
    rename(temp, path); renamed = true;
  });
  syncBuiltinESMExports();
  try { writePrivateFileAtomic(target, bytes); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(renamed, true); assert.deepEqual(fs.readFileSync(target), bytes);
  assert.deepEqual(fs.readdirSync(w.base), ['receipt.json']);
});
test('a failed cache-file sync publishes nothing and removes the temporary bytes', t => {
  const w = world(t), target = join(w.base, 'receipt.json');
  t.mock.method(fsDefault, 'fsyncSync', () => { throw Object.assign(Error('sync failed'), { code: 'EIO' }); });
  syncBuiltinESMExports();
  try { assert.throws(() => writePrivateFileAtomic(target, 'partial'), { code: 'EIO' }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(fs.readdirSync(w.base), []);
});
for (const kind of ['file', 'symlink', 'dangling-link', 'hardlink']) test(`atomic cache writes preserve an existing ${kind}`, t => {
  const w = world(t), target = join(w.base, 'receipt.json'), original = join(w.base, 'original');
  fs.writeFileSync(original, 'keep', { mode: 0o600 });
  if (kind === 'file') fs.writeFileSync(target, 'keep', { mode: 0o600 });
  else if (kind === 'hardlink') fs.linkSync(original, target);
  else fs.symlinkSync(kind === 'symlink' ? original : join(w.base, 'absent'), target);
  const before = fs.lstatSync(target);
  assert.throws(() => writePrivateFileAtomic(target, 'replace'), { code: 'EEXIST' });
  assert.equal(fs.lstatSync(target).ino, before.ino); assert.equal(fs.readFileSync(original, 'utf8'), 'keep');
  if (kind !== 'dangling-link') assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(w.base).sort(), ['original', 'receipt.json']);
});
test('cache miss publishes all strips atomically; cache hit renders zero times and builds pinned frames', async t => {
  const w = world(t); let calls = 0;
  const options = { root: w.root, fingerprint: () => 'a'.repeat(64), render: async input => {
    calls++; assert.equal(fs.existsSync(join(w.root, 'tsugi', 'a'.repeat(64))), false);
    const owner = JSON.parse(fs.readFileSync(join(w.root, 'tsugi', `.${'a'.repeat(64)}.lock`, 'owner.json')));
    assert.equal(owner.pid, process.pid); assert.match(owner.startTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    await fixtureRender(input);
  } };
  const ready = await createCharacterStageCache(options).ensure(pack());
  assert.ok(ready); assert.equal(calls, 1); assert.equal(Object.values(ready.stage.states).filter(s => s.own).length, 21);
  const again = await createCharacterStageCache(options).ensure(pack());
  assert.equal(again.stageFolder, ready.stageFolder); assert.equal(calls, 1);
  const frame = characterFrame(again, { nonce: 'b'.repeat(64), seq: 1, resolve: resolveCharacterStates });
  assert.equal(frame.stage.cache, 'a'.repeat(64));
  assert.equal(frame.sheet, join(pack().folder, 'sheet.webp'));
  assert.ok(Object.values(frame.stage.table).every(s => s.file.startsWith(ready.stageFolder + '/stage/') && /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.deepEqual(fs.readdirSync(join(w.root, 'tsugi')), ['a'.repeat(64)]);
});
test('changed generator source, design or version changes the hash and stale keys render again', async t => {
  const w = world(t), p = pack(), generatorRoot = join(w.base, 'generator');
  fs.mkdirSync(generatorRoot); const source = join(generatorRoot, 'version.mjs');
  fs.writeFileSync(source, 'export const version = 1;'); const before = characterStageHash(p, { generatorRoot });
  fs.writeFileSync(source, 'export const version = 2;'); const after = characterStageHash(p, { generatorRoot });
  assert.notEqual(before, after);
  const changed = { ...p, files: new Map(p.files) }; changed.files.set('character.json', Buffer.from('changed design'));
  assert.notEqual(characterStageHash(changed, { generatorRoot }), after);
  let calls = 0; const render = async options => { calls++; await fixtureRender(options); };
  const first = await createCharacterStageCache({ root: w.root, fingerprint: () => before, render }).ensure(p);
  const second = await createCharacterStageCache({ root: w.root, fingerprint: () => after, render }).ensure(p);
  assert.equal(calls, 2); assert.notEqual(first.stageFolder, second.stageFolder);
});
test('two independent session processes share one first-use render', async t => {
  const w = world(t), count = join(w.base, 'renders');
  const run = () => new Promise((done, fail) => {
    const child = spawn(process.execPath, [new URL('./fixtures/character-stage-session.mjs', import.meta.url).pathname, w.root, count], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
    child.once('error', fail); child.once('close', code => { try { assert.equal(code, 0, err); done(JSON.parse(out)); } catch (error) { fail(error); } });
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.deepEqual(a, b); assert.equal(a.states, 21); assert.equal(fs.readFileSync(count, 'utf8'), 'render\n');
});
test('two session processes share one render while the owner writes its receipt slowly', { timeout: 15000 }, async t => {
  const w = world(t), count = join(w.base, 'renders'), release = join(w.base, 'release');
  const run = mode => {
    const child = spawn(process.execPath, [new URL('./fixtures/character-stage-session.mjs', import.meta.url).pathname,
      w.root, count, mode, release], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '', err = '';
    child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
    const messages = [];
    child.on('message', value => messages.push(value.event));
    const result = new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', code => { try { assert.equal(code, 0, err); done(JSON.parse(out)); } catch (error) { fail(error); } });
    });
    const saw = async event => {
      const deadline = Date.now() + 5000;
      while (!messages.includes(event)) {
        assert.ok(Date.now() < deadline, `missing ${event}: ${err}`);
        await new Promise(done => setTimeout(done, 5));
      }
    };
    return { result, saw };
  };
  const owner = run('slow-owner');
  t.after(() => { if (fs.existsSync(w.base)) fs.writeFileSync(release, 'release'); });
  await owner.saw('owner-writing');
  const visibleDuringWrite = fs.existsSync(join(w.root, 'tsugi', `.${'c'.repeat(64)}.lock`, 'owner.json'));
  const reader = run('watch-owner');
  try { await reader.saw('owner-read'); }
  finally { fs.writeFileSync(release, 'release'); }
  const [a, b] = await Promise.all([owner.result, reader.result]);
  assert.deepEqual(a, b); assert.equal(a.states, 21);
  assert.equal(visibleDuringWrite, false, 'an incomplete owner receipt must stay at a temporary name');
  assert.equal(fs.readFileSync(count, 'utf8'), 'render\n');
  assert.deepEqual(fs.readdirSync(join(w.root, 'tsugi')), ['c'.repeat(64)]);
});
test('render failure leaves medium fallback, removes staging and lock, logs one line per session', async t => {
  const w = world(t), logs = []; let calls = 0;
  const cache = createCharacterStageCache({ root: w.root, fingerprint: () => 'd'.repeat(64), log: x => logs.push(x), render: async ({ output }) => {
    calls++; fs.writeFileSync(join(output, 'partial'), 'partial'); throw Error('STAGE_RENDER_TIMEOUT');
  } });
  assert.deepEqual(await Promise.all([cache.ensure(pack()), cache.ensure(pack())]), [null, null]);
  assert.equal(await cache.ensure(pack()), null); assert.equal(calls, 1); assert.equal(logs.length, 1);
  assert.match(logs[0], /STAGE_RENDER_TIMEOUT.*shown at medium/);
  assert.deepEqual(fs.readdirSync(join(w.root, 'tsugi')), []);
  assert.equal(characterFrame(pack(), { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates }).stage, undefined);
});
test('cache directories are 0700 and every data file is 0600', async t => {
  const w = world(t), result = await createCharacterStageCache({ root: w.root, render: fixtureRender }).ensure(pack());
  assert.ok(result);
  function verify(path) {
    const s = fs.lstatSync(path); assert.equal(s.uid, process.getuid());
    assert.equal(s.mode & 0o7777, s.isDirectory() ? 0o700 : 0o600);
    if (s.isDirectory()) for (const name of fs.readdirSync(path)) verify(join(path, name));
  }
  verify(w.root);
});
for (const kind of ['root-mode', 'root-link', 'parent-link', 'strip-mode', 'strip-link', 'strip-hardlink', 'stage-mode', 'receipt-mode', 'missing-receipt', 'extra-link', 'extra-mode', 'output-link', 'dangling-output']) {
  test(`unsafe cache ${kind} fails closed without rendering`, async t => {
    const w = world(t), options = { root: w.root, fingerprint: () => 'e'.repeat(64), render: fixtureRender };
    const ready = await createCharacterStageCache(options).ensure(pack()); assert.ok(ready);
    const strip = join(ready.stageFolder, 'stage/lie.png');
    if (kind === 'root-mode') fs.chmodSync(w.root, 0o755);
    if (kind === 'root-link') { fs.renameSync(w.root, w.root + '-real'); fs.symlinkSync(w.root + '-real', w.root); }
    if (kind === 'parent-link') { const link = join(w.base, 'alias'); fs.symlinkSync(w.base, link); options.root = join(link, 'cache'); }
    if (kind === 'strip-mode') fs.chmodSync(strip, 0o644);
    if (kind === 'strip-link') { fs.unlinkSync(strip); fs.symlinkSync(join(ready.stageFolder, 'stage/sit.png'), strip); }
    if (kind === 'strip-hardlink') fs.linkSync(strip, join(w.base, 'linked.png'));
    if (kind === 'stage-mode') fs.chmodSync(join(ready.stageFolder, 'stage'), 0o755);
    if (kind === 'receipt-mode') fs.chmodSync(join(ready.stageFolder, 'receipt.json'), 0o644);
    if (kind === 'missing-receipt') fs.unlinkSync(join(ready.stageFolder, 'receipt.json'));
    if (kind === 'extra-link') fs.symlinkSync(w.base, join(ready.stageFolder, 'stage/extra.png'));
    if (kind === 'extra-mode') fs.writeFileSync(join(ready.stageFolder, 'extra'), 'bad mode', { mode: 0o644 });
    if (kind === 'output-link' || kind === 'dangling-output') {
      fs.renameSync(ready.stageFolder, ready.stageFolder + '-saved');
      fs.symlinkSync(kind === 'output-link' ? ready.stageFolder + '-saved' : join(w.base, 'absent'), ready.stageFolder);
    }
    let calls = 0; const logs = [];
    assert.equal(await createCharacterStageCache({ ...options, render: () => { calls++; }, log: x => logs.push(x) }).ensure(pack()), null);
    assert.equal(calls, 0); assert.equal(logs.length, 1);
  });
}
test('imported packs never render or create a cache bank', async t => {
  const w = world(t); let calls = 0;
  assert.equal(await createCharacterStageCache({ root: w.root, render: () => calls++ }).ensure({ ...pack(), builtin: false }), null);
  assert.equal(calls, 0); assert.equal(fs.existsSync(w.root), false);
});

for (const kind of ['strip-hash', 'receipt-hash', 'missing-strip', 'extra-file']) {
  test(`a damaged cache (${kind}) is replaced by one validated render`, async t => {
    const w = world(t), options = { root: w.root, fingerprint: () => 'b'.repeat(64), render: fixtureRender };
    const ready = await createCharacterStageCache(options).ensure(pack()); assert.ok(ready);
    if (kind === 'strip-hash') fs.appendFileSync(join(ready.stageFolder, 'stage/lie.png'), 'changed');
    if (kind === 'receipt-hash') fs.writeFileSync(join(ready.stageFolder, 'receipt.json'), '{}');
    if (kind === 'missing-strip') fs.unlinkSync(join(ready.stageFolder, 'stage/lie.png'));
    if (kind === 'extra-file') fs.writeFileSync(join(ready.stageFolder, 'extra'), 'orphan', { mode: 0o600 });
    let calls = 0; const logs = [];
    const cache = createCharacterStageCache({ ...options, log: line => logs.push(line), render: async input => { calls++; await fixtureRender(input); } });
    const [a, b] = await Promise.all([cache.ensure(pack()), cache.ensure(pack())]);
    assert.ok(a); assert.equal(a, b); assert.equal(calls, 1); assert.deepEqual(logs, []);
    assert.deepEqual(fs.readdirSync(join(w.root, 'tsugi')), ['b'.repeat(64)]);
    assert.ok(await createCharacterStageCache({ ...options, render: () => assert.fail('repaired cache should be reusable') }).ensure(pack()));
  });
}

test('a failed repair renders once and keeps medium art for the session', async t => {
  const w = world(t), options = { root: w.root, fingerprint: () => 'b'.repeat(64), render: fixtureRender };
  const ready = await createCharacterStageCache(options).ensure(pack());
  fs.appendFileSync(join(ready.stageFolder, 'stage/lie.png'), 'changed');
  let calls = 0; const logs = [];
  const cache = createCharacterStageCache({ ...options, log: line => logs.push(line), render: async () => { calls++; throw Error('STAGE_RENDER_FAILED'); } });
  assert.equal(await cache.ensure(pack()), null); assert.equal(await cache.ensure(pack()), null);
  assert.equal(calls, 1); assert.equal(logs.length, 1); assert.deepEqual(fs.readdirSync(join(w.root, 'tsugi')), []);
});

test('successful publication prunes only old private caches and staging for the same character', async t => {
  const w = world(t), key = 'a'.repeat(64), bank = join(w.root, 'tsugi'), old = new Date(Date.now() - 11 * 60 * 1000);
  fs.mkdirSync(bank, { recursive: true, mode: 0o700 });
  const make = (name, aged = true) => {
    const path = join(bank, name); fs.mkdirSync(path, { mode: 0o700 });
    fs.writeFileSync(join(path, 'partial'), 'orphan', { mode: 0o600 });
    if (aged) fs.utimesSync(path, old, old);
    return path;
  };
  const prior = make('b'.repeat(64)), orphan = make(`.${'c'.repeat(64)}-ABC123`);
  const recent = make('d'.repeat(64), false), recentStage = make(`.${'e'.repeat(64)}-ABC123`, false);
  const odd = make('unrelated'), unsafe = make('f'.repeat(64)); fs.chmodSync(unsafe, 0o755);
  const hardlink = make('1'.repeat(64)); fs.linkSync(join(hardlink, 'partial'), join(w.base, 'held'));
  const link = join(bank, '2'.repeat(64)); fs.symlinkSync(w.base, link);
  const active = make(`.${'3'.repeat(64)}-ABC123`), activeLock = join(bank, `.${'3'.repeat(64)}.lock`);
  fs.mkdirSync(activeLock, { mode: 0o700 });
  fs.writeFileSync(join(activeLock, 'owner.json'), JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid) }), { mode: 0o600 });
  fs.utimesSync(activeLock, old, old);
  const stranded = make(`.${'4'.repeat(64)}-ABC123`), deadLock = join(bank, `.${'4'.repeat(64)}.lock`);
  fs.mkdirSync(deadLock, { mode: 0o700 });
  fs.writeFileSync(join(deadLock, 'owner.json'), JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
  const other = join(w.root, 'dennis'); fs.mkdirSync(other, { mode: 0o700 }); fs.utimesSync(other, old, old);
  assert.ok(await createCharacterStageCache({ root: w.root, fingerprint: () => key, render: fixtureRender }).ensure(pack()));
  assert.equal(fs.existsSync(prior), false); assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(stranded), false);
  for (const path of [recent, recentStage, odd, unsafe, hardlink, link, other, active]) assert.equal(fs.existsSync(path), true, path);
});

test('losing the render lock refuses publication and preserves the replacement owner', async t => {
  const w = world(t), key = 'a'.repeat(64), lock = join(w.root, 'tsugi', `.${key}.lock`), logs = [];
  const ready = await createCharacterStageCache({ root: w.root, fingerprint: () => key, log: line => logs.push(line), render: async input => {
    fs.renameSync(lock, lock + '-saved'); fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(join(lock, 'owner.json'), 'replacement', { mode: 0o600 });
    await fixtureRender(input);
  } }).ensure(pack());
  assert.equal(ready, null); assert.equal(logs.length, 1); assert.match(logs[0], /STAGE_CACHE_LOCK/);
  assert.equal(fs.existsSync(join(w.root, 'tsugi', key)), false);
  assert.equal(fs.readFileSync(join(lock, 'owner.json'), 'utf8'), 'replacement');
});

for (const kind of ['missing-owner', 'partial-owner', 'stale-recovery', 'recycled-pid']) {
  test(`a stranded ${kind} lock recovers in this request without the render deadline`, async t => {
    const w = world(t), key = 'f'.repeat(64), lock = join(w.root, 'tsugi', `.${key}.lock`);
    fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
    const old = new Date(Date.now() - 70000);
    if (kind !== 'missing-owner') fs.writeFileSync(join(lock, 'owner.json'), kind === 'partial-owner' ? '{"pid":' : JSON.stringify({
      pid: kind === 'recycled-pid' ? process.pid : 2147483647, startTime: '2000-01-01T00:00:00.000Z',
    }), { mode: 0o600 });
    if (kind === 'missing-owner' || kind === 'partial-owner') fs.utimesSync(lock, old, old);
    if (kind === 'stale-recovery') { fs.mkdirSync(lock + '.recover', { mode: 0o700 }); fs.utimesSync(lock + '.recover', old, old); }
    let calls = 0;
    const ready = await createCharacterStageCache({ root: w.root, fingerprint: () => key, timeoutMs: 100,
      render: async input => { calls++; await fixtureRender(input); } }).ensure(pack());
    assert.ok(ready); assert.equal(calls, 1); assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(lock + '.recover'), false);
  });
}

for (const kind of ['mode', 'symlink', 'hardlink', 'invalid-pid']) test(`an unsafe ${kind} owner receipt refuses without rendering or removing its lock`, async t => {
  const w = world(t), key = 'f'.repeat(64), lock = join(w.root, 'tsugi', `.${key}.lock`), owner = join(lock, 'owner.json');
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid) }), { mode: 0o600 });
  if (kind === 'mode') fs.chmodSync(owner, 0o644);
  if (kind === 'symlink') { fs.renameSync(owner, join(w.base, 'owner')); fs.symlinkSync(join(w.base, 'owner'), owner); }
  if (kind === 'hardlink') fs.linkSync(owner, join(w.base, 'owner'));
  if (kind === 'invalid-pid') fs.writeFileSync(owner, '{"pid":0}');
  let calls = 0; const logs = [];
  const result = await createCharacterStageCache({ root: w.root, fingerprint: () => key, log: line => logs.push(line),
    render: () => { calls++; } }).ensure(pack());
  assert.equal(result, null); assert.equal(calls, 0); assert.equal(logs.length, 1);
  assert.match(logs[0], kind === 'invalid-pid' ? /STAGE_CACHE_LOCK/ : /STAGE_CACHE_PERMISSIONS/);
  assert.equal(fs.existsSync(lock), true); assert.equal(fs.lstatSync(owner).isSymbolicLink(), kind === 'symlink');
});

for (const kind of ['missing-owner', 'partial-owner', 'live-owner', 'fresh-recovery']) {
  test(`a ${kind} creation window is left alone until its holder releases it`, async t => {
    const w = world(t), key = 'f'.repeat(64), lock = join(w.root, 'tsugi', `.${key}.lock`);
    fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
    if (kind !== 'missing-owner') fs.writeFileSync(join(lock, 'owner.json'), kind === 'partial-owner' ? '{"pid":' : JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid) }), { mode: 0o600 });
    if (kind === 'live-owner') { const old = new Date(Date.now() - 70000); fs.utimesSync(lock, old, old); }
    if (kind === 'fresh-recovery') fs.mkdirSync(lock + '.recover', { mode: 0o700 });
    let released = false;
    const work = createCharacterStageCache({ root: w.root, fingerprint: () => key, render: async input => {
      assert.equal(released, true); await fixtureRender(input);
    } }).ensure(pack());
    assert.equal(fs.existsSync(lock), true);
    fs.rmSync(lock, { recursive: true }); if (kind === 'fresh-recovery') fs.rmdirSync(lock + '.recover'); released = true;
    assert.ok(await work);
  });
}

test('a dead session lock is reclaimed before one render', async t => {
  const w = world(t), key = 'f'.repeat(64), lock = join(w.root, 'tsugi', `.${key}.lock`);
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
  let calls = 0;
  const ready = await createCharacterStageCache({ root: w.root, fingerprint: () => key,
    render: async input => { calls++; await fixtureRender(input); } }).ensure(pack());
  assert.ok(ready); assert.equal(calls, 1); assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(lock + '.recover'), false);
});

test('the real sandboxed worker deadline reaps a timed-out renderer without publishing', { skip: process.platform !== 'darwin' }, async t => {
  const w = world(t), output = join(w.base, 'render'); fs.mkdirSync(output, { mode: 0o700 });
  await assert.rejects(spawnStageRender({ id: 'tsugi', output, timeoutMs: 1 }), /STAGE_RENDER_TIMEOUT/);
  assert.equal(fs.existsSync(join(output, 'stage.json')), false);
});
