import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, existsSync,
  chmodSync, linkSync, symlinkSync, openSync, closeSync, fstatSync, readSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { createClipboardCoordinator } from '../plugins/sleight/lib/clipboard.mjs';
import * as api from '../plugins/sleight/lib/clipboard-recovery.mjs';

const recoveryURL = new URL('../plugins/sleight/lib/clipboard-recovery.mjs', import.meta.url);
const launchURL = new URL('../plugins/sleight/lib/launch.mjs', import.meta.url);
const original = [[{ type: 'public.png', data: Buffer.alloc(70000, 0xa5).toString('base64') }]];
const staged = [[{ type: 'public.utf8-plain-text', data: 'Zml4dHVyZQ==' },
  { type: 'org.nspasteboard.TransientType', data: '' }]];
const minute = 60000;

// The native clipboard boundary launches a child. Replace the actual builtin
// exports while sweeping, including their already imported ESM bindings.
function withoutPasteboard(run, operations = []) {
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const saved = names.map(name => childProcess[name]);
  for (const name of names) childProcess[name] = () => {
    operations.push(name);
    throw Error('sweep attempted a child-process clipboard boundary');
  };
  syncBuiltinESMExports();
  let result;
  try { result = run(); }
  finally {
    names.forEach((name, i) => { childProcess[name] = saved[i]; });
    syncBuiltinESMExports();
  }
  assert.deepEqual(operations, [], 'a sweep must never launch pasteboard IO');
  return result;
}
function fixture(t, implementation = api) {
  const root = trackTemp(mkdtempSync(join(realpathSync(tmpdir()), 'sleight-sweep-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let time = 1800000000000, boot = 'current-boot';
  const options = { directory: join(root, 'clipboard'), now: () => time, bootSession: () => boot, excludeFromBackup() {} };
  const store = implementation.createClipboardSnapshotStore(options);
  const token = store.save({ original, staged }), path = join(store.directory, token.name), notices = [], operations = [];
  return { root, store, token, path, notices, operations,
    age(ms) { time += ms; },
    reboot() { boot = 'new-boot'; return implementation.createClipboardSnapshotStore(options); },
    sweep(selected = store) {
      assert.equal(typeof implementation.sweepClipboardSnapshots, 'function', 'delete-only sweep must exist');
      return withoutPasteboard(() => implementation.sweepClipboardSnapshots({ store: selected,
        notice: (code, file) => notices.push({ code, file }) }), operations);
    } };
}
const cases = {
  async 'reservation database is created at 0600 even with an open umask'(t, implementation) {
    const f = fixture(t, implementation), previous = process.umask(0);
    try { f.sweep(); }
    finally { process.umask(previous); }
    assert.equal(statSync(join(f.root, 'clipboard.sqlite')).mode & 0o777, 0o600);
    assert.equal(existsSync(f.path), true, 'the fresh snapshot remains available');
  },
  async 'active paste reservation protects a partially written record'(t, implementation) {
    const f = fixture(t, implementation), bytes = Buffer.from('partial snapshot'); writeFileSync(f.path, bytes);
    const reservation = createClipboardCoordinator(DatabaseSync, join(f.root, 'clipboard.sqlite'));
    reservation.acquire();
    try {
      f.sweep(); assert.equal(existsSync(f.path), true); assert.deepEqual(readFileSync(f.path), bytes);
      assert.equal(f.notices[0]?.code, 'CLIPBOARD_SNAPSHOT_SKIPPED_BUSY'); assert.deepEqual(f.operations, []);
    } finally { reservation.release(); }
    f.sweep(); assert.equal(existsSync(f.path), false);
  },
  async 'past boot deletes without pasteboard operations'(t, implementation) {
    const f = fixture(t, implementation); f.sweep(f.reboot());
    assert.equal(existsSync(f.path), false); assert.deepEqual(f.operations, []);
    assert.equal(f.notices[0]?.code, 'CLIPBOARD_SNAPSHOT_DISCARDED_BOOT');
  },
  async 'eleven minutes deletes and zeroes every byte before unlink'(t, implementation) {
    const f = fixture(t, implementation), fd = openSync(f.path, 'r');
    try {
      const size = fstatSync(fd).size; assert.ok(size > 65536); f.age(11 * minute); f.sweep();
      assert.equal(existsSync(f.path), false); assert.equal(fstatSync(fd).nlink, 0);
      const bytes = Buffer.alloc(size); assert.equal(readSync(fd, bytes, 0, size, 0), size);
      assert.ok(bytes.every(byte => byte === 0)); assert.deepEqual(f.operations, []);
    } finally { closeSync(fd); }
  },
  async 'nine minutes keeps bytes for later engine recovery'(t, implementation) {
    const f = fixture(t, implementation), before = readFileSync(f.path); f.age(9 * minute); f.sweep();
    assert.equal(existsSync(f.path), true);
    assert.deepEqual(readFileSync(f.path), before); assert.deepEqual(f.notices, []); assert.deepEqual(f.operations, []);
  },
  async 'exactly ten minutes still permits fresh recovery'(t, implementation) {
    const f = fixture(t, implementation); f.age(10 * minute); f.sweep();
    let board = { count: 7, items: staged }, writes = 0;
    const io = Object.assign(async request => {
      if (request.op === 'read') return board;
      if (request.op === 'write') { writes++; board = { count: 8, items: request.items }; }
    }, { snapshotStore: f.store });
    await implementation.recoverClipboardSnapshots(io);
    assert.equal(writes, 1); assert.deepEqual(board.items, implementation.restoredClipboardItems(original));
    assert.equal(existsSync(f.path), false);
  },
  async 'invalid file deletes without pasteboard operations'(t, implementation) {
    const f = fixture(t, implementation); writeFileSync(f.path, 'truncated'); f.sweep();
    assert.equal(existsSync(f.path), false); assert.deepEqual(f.operations, []);
    assert.equal(f.notices[0]?.code, 'CLIPBOARD_SNAPSHOT_DISCARDED_INVALID');
  },
  async 'symlink skips without following or zeroing its target'(t, implementation) {
    const f = fixture(t, implementation), target = join(f.root, 'target.bin');
    const before = readFileSync(f.path); writeFileSync(target, before, { mode: 0o600 });
    rmSync(f.path); symlinkSync(target, f.path); f.age(11 * minute); f.sweep();
    assert.equal(f.store.list()[0]?.code, 'CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE');
    assert.equal(existsSync(f.path), true); assert.deepEqual(readFileSync(target), before);
    assert.equal(f.notices[0]?.code, 'CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE');
  },
  async 'two hardlinks skip without zeroing either link'(t, implementation) {
    const f = fixture(t, implementation), target = join(f.root, 'other.bin'), before = readFileSync(f.path);
    linkSync(f.path, target); f.age(11 * minute); f.sweep();
    assert.equal(existsSync(f.path), true);
    assert.deepEqual(readFileSync(f.path), before); assert.deepEqual(readFileSync(target), before);
    assert.equal(f.notices[0]?.code, 'CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE');
  },
  async 'wrong mode skips without altering bytes'(t, implementation) {
    const f = fixture(t, implementation), before = readFileSync(f.path); chmodSync(f.path, 0o644);
    f.age(11 * minute); f.sweep(); assert.equal(existsSync(f.path), true); assert.deepEqual(readFileSync(f.path), before);
    assert.equal(f.notices[0]?.code, 'CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE');
  },
  async 'missing directory is a no-op and is not created'(t, implementation) {
    const f = fixture(t, implementation); rmSync(f.store.directory, { recursive: true }); f.sweep();
    assert.equal(existsSync(f.store.directory), false); assert.deepEqual(f.notices, []); assert.deepEqual(f.operations, []);
  },
  async 'exhausted record expires after eleven minutes'(t, implementation) {
    const f = fixture(t, implementation);
    const io = Object.assign(async request => {
      if (request.op === 'read') return { count: 7, items: staged };
      if (request.op === 'write') throw Error('fixture exhausted');
    }, { snapshotStore: f.store });
    await implementation.recoverClipboardSnapshots(io); assert.equal(existsSync(f.path), true);
    f.age(11 * minute); f.sweep(); assert.equal(existsSync(f.path), false);
  },
  async 'expired legacy runtime snapshots are deleted once'(t, implementation) {
    const f = fixture(t, implementation), legacy = join(f.store.directory, 'runtime-' + f.token.name);
    const before = readFileSync(f.path); writeFileSync(legacy, before, { mode: 0o600 });
    f.age(11 * minute); f.sweep(); assert.equal(existsSync(f.path), false);
    assert.equal(existsSync(legacy), false);
    assert.equal(f.notices.filter(row => row.code === 'CLIPBOARD_LEGACY_SNAPSHOTS_DISCARDED').length, 1);
  },
  async 'failed deletion and throwing notice do not stop later records'(t, implementation) {
    const f = fixture(t, implementation), later = f.store.save({ original, staged }); f.age(11 * minute);
    const entries = f.store.list(), order = [f.token.name, later.name];
    f.sweep({ ...f.store, list: () => order.map(name => entries.find(entry => entry.token.name === name)),
      remove(token) { if (token.name === f.token.name) throw Error('fixture changed'); f.store.remove(token); } });
    assert.equal(existsSync(f.path), true); assert.equal(existsSync(join(f.store.directory, later.name)), false);
    assert.equal(f.notices[0]?.code, 'CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE');
    assert.doesNotThrow(() => implementation.sweepClipboardSnapshots({ store: f.store, notice() { throw Error('fixture log'); } }));
    assert.equal(existsSync(f.path), false);
  },
};
for (const [name, check] of Object.entries(cases)) test('sweep: ' + name, t => check(t, api));

function replace(source, before, after) {
  assert.ok(source.includes(before), 'variant anchor: ' + before);
  return source.replace(before, after);
}
async function variant(before, after) {
  let source = readFileSync(recoveryURL, 'utf8');
  if (Array.isArray(before)) before.forEach((anchor, i) => { source = replace(source, anchor, after[i]); });
  else source = replace(source, before, after);
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const variants = [
  ['reservation bypassed', 'active paste reservation protects a partially written record',
    "reservation.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')", "reservation.exec('PRAGMA busy_timeout=0')"],
  ['boot rule removed', 'past boot deletes without pasteboard operations',
    "if (record.bootSession !== currentBoot())", 'if (false)'],
  ['expiry removed', 'eleven minutes deletes and zeroes every byte before unlink',
    'age > clipboardSnapshotLifetimeMs', 'false'],
  ['zeroing removed', 'eleven minutes deletes and zeroes every byte before unlink',
    'offset < stat.size;', 'false;'],
  ['eight minute expiry', 'nine minutes keeps bytes for later engine recovery',
    '10 * 60 * 1000', '8 * 60 * 1000'],
  ['boundary expires early', 'exactly ten minutes still permits fresh recovery',
    'age > clipboardSnapshotLifetimeMs', 'age >= clipboardSnapshotLifetimeMs'],
  ['invalid records kept', 'invalid file deletes without pasteboard operations',
    'if (discard) { store.remove(token); log(discard, path); }', 'if (discard && record) { store.remove(token); log(discard, path); }'],
  ['symlinks followed', 'symlink skips without following or zeroing its target',
    'constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK', 'constants.O_RDONLY | constants.O_NONBLOCK'],
  ['hardlinks permitted', 'two hardlinks skip without zeroing either link',
    'stat.nlink === 1', 'true'],
  ['permissive modes permitted', 'wrong mode skips without altering bytes',
    '(stat.mode & 0o7777) === 0o600', 'true'],
  ['missing directory treated as error', 'missing directory is a no-op and is not created',
    'if (!store.hasSnapshots({ legacy: true })) return;', 'if (!store.hasSnapshots({ legacy: true })) throw snapshotError();'],
  ['exhausted records never expire', 'exhausted record expires after eleven minutes',
    'age > clipboardSnapshotLifetimeMs', 'false'],
  ['legacy files never expire', 'expired legacy runtime snapshots are deleted once',
    'const legacy = legacySnapshotName(token?.name);', 'const legacy = legacySnapshotName(token?.name); if (legacy) continue;'],
  ['first removal failure stops sweep', 'failed deletion and throwing notice do not stop later records',
    "} catch { log('CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE', path); }",
    "} catch { log('CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE', path); return; }"],
  ['sweep opens pasteboard', 'past boot deletes without pasteboard operations',
    'for (const { token, record, path, code } of store.list({ legacy: true })) {',
    "execFileSync('/usr/bin/osascript', ['-e', 'the clipboard'], { timeout: 1000, killSignal: 'SIGKILL' });\n    for (const { token, record, path, code } of store.list({ legacy: true })) {"],
  ['reservation database follows umask', 'reservation database is created at 0600 even with an open umask',
    'constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600',
    'constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o666'],
];
for (const [name, scenario, before, after] of variants) test('broken variant rejected: ' + name,
  { skip: typeof api.sweepClipboardSnapshots !== 'function' && 'sweep not implemented on base' }, async t => {
    const broken = await variant(before, after);
    await assert.rejects(() => cases[scenario](t, broken), { code: 'ERR_ASSERTION' });
  });

function launchFixture(t, route, mutation) {
  const f = fixture(t), before = readFileSync(f.path); f.age(11 * minute);
  // Only the launcher gets the fixture sweep. Clipboard code retains its real exports.
  const sweepModule = `import * as api from ${JSON.stringify(recoveryURL.href)};
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import assert from 'node:assert/strict';
    ${withoutPasteboard.toString()}
    export function sweepClipboardSnapshots() {
      globalThis.events.push('sweep');
      return withoutPasteboard(() => api.sweepClipboardSnapshots({ store: api.createClipboardSnapshotStore({ directory: ${JSON.stringify(f.store.directory)},
        now: () => ${route === 'own' ? 1800000000000 : 1800000660000},
        bootSession: () => ${JSON.stringify(route === 'own' ? 'different-boot' : 'current-boot')}, excludeFromBackup() {} }),
        notice() {} }));
    }`;
  const source = `import { registerHooks } from 'node:module';
    import { readFileSync } from 'node:fs';
    globalThis.events = [];
    registerHooks({ resolve(specifier, context, next) {
      const stub = specifier === './clipboard-recovery.mjs' && context.parentURL === ${JSON.stringify(launchURL.href)}
        ? ${JSON.stringify(sweepModule)} : specifier === './runtime-select.mjs'
        ? "export async function prepareOwnRuntimeHost() { globalThis.events.push('prepare'); return {}; } export async function runOwnRuntime() { globalThis.events.push('own'); }"
        : specifier === './socket-bridge.mjs'
        ? "export async function socketCommand() { globalThis.events.push('socket'); return 0; }" : undefined;
      if (stub) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(stub) };
      return next(specifier, context);
    }, load(url, context, next) {
      const result = next(url, context);
      if (url !== ${JSON.stringify(launchURL.href)} || !${JSON.stringify(!!mutation)}) return result;
      const source = String(result.source), before = ${JSON.stringify(mutation?.[0])}, after = ${JSON.stringify(mutation?.[1])};
      if (!source.includes(before)) throw Error('missing launch mutation anchor');
      return { ...result, source: source.replace(before, after) };
    } });
    process.env.SLEIGHT_RUNTIME = ${JSON.stringify(route === 'engine' ? 'engine' : 'own')};
    ${route === 'socket' ? `process.argv = [process.execPath, ${JSON.stringify(launchURL.pathname)}, 'session'];` : ''}
    const { run } = await import(${JSON.stringify(launchURL.href)});
    ${route === 'socket' ? '' : `await run({ platform: 'darwin', directBrowser: null, shellRoute: ${route === 'own-shell'},
      recoverClipboard: async () => { globalThis.events.push('recover'); throw Error('fixture engine stop'); }
    }).catch(error => { if (error.message !== 'fixture engine stop') throw error; });`}
    console.log(JSON.stringify(globalThis.events));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ['sweep', ...(route === 'engine' ? ['recover'] : route === 'socket' ? ['socket'] : ['prepare', 'own'])]);
  assert.equal(existsSync(f.path), false);
  assert.ok(before.length > 0);
}
for (const route of ['own', 'own-shell', 'engine', 'socket']) test('launcher sweeps before ' + route, t => launchFixture(t, route));
for (const route of ['own', 'own-shell', 'engine', 'socket']) test('broken launch variant rejected: ' + route,
  { skip: typeof api.sweepClipboardSnapshots !== 'function' && 'sweep not implemented on base' }, t => {
    const mutation = route === 'socket' ? ['await sweepClipboardSnapshots();', '']
      : ['await sweepClipboard();', route === 'engine' ? '' : "if (selectRuntime() !== 'own') await sweepClipboard();"];
    assert.throws(() => launchFixture(t, route, mutation), { code: 'ERR_ASSERTION' });
  });
