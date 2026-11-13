import test from 'node:test';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { prepareWindowsPerson } from '../plugins/sleight/lib/platform/win32-person.mjs';
import { prepareWindowsHandHost, windowsPersonSources, windowsHostSources, compileWindowsHost, sweepWindowsPersonRuns } from '../plugins/sleight/lib/direct-browser/windows-host.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-win5-build-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'sources'), cacheRoot = join(root, 'cache'), compiler = join(root, 'csc.exe');
  mkdirSync(sourceRoot); writeFileSync(compiler, 'compiler');
  for (const name of windowsPersonSources) writeFileSync(join(sourceRoot, name), 'source ' + name);
  const compiles = [], checks = [];
  const options = { platform: 'win32', kind: 'person', sourceRoot, cacheRoot, compiler,
    access(batch) { checks.push(batch); for (const [op, path] of batch) if (op === 'create') mkdirSync(path, { recursive: true }); },
    compile: async args => { compiles.push(args); writeFileSync(args.binary, 'person PE'); } };
  return { root, options, compiles, checks };
}
test('person profile compiles exactly four C# sources and the verified WIN3 ACL script', async t => {
  const { options, compiles } = fixture(t);
  const host = await prepareWindowsHandHost(options);
  assert.equal(host.status, 'ready', JSON.stringify(host));
  assert.deepEqual(compiles[0].sources.map(source => source.split('/').at(-1)), ['PersonNative.cs', 'PersonHello.cs', 'PersonPassword.cs', 'PersonHost.cs']);
  const record = JSON.parse(readFileSync(host.record));
  assert.deepEqual(Object.keys(record.sources), [...windowsPersonSources]);
  assert.equal((await prepareWindowsHandHost(options)).status, 'ready'); assert.equal(compiles.length, 1);
  assert.throws(() => host.spawn(), /HOST_KIND_INVALID/);
});
test('private copies hold the verified bytes, have checked ACLs, and remove their own run directories', async t => {
  const { options, checks } = fixture(t);
  const host = await prepareWindowsHandHost(options);
  const copy = host.personCopy(), second = host.personCopy();
  assert.notEqual(copy.path, second.path);
  assert.equal(readFileSync(copy.path, 'utf8'), 'person PE'); assert.equal(copy.sha256, sha('person PE'));
  assert.ok(checks.some(batch => batch.some(([op, path]) => op === 'private' && path === copy.path)));
  copy.cleanup(); second.cleanup();
  assert.equal(readdirSync(options.cacheRoot).filter(name => name.startsWith('person-run-')).length, 0);
  writeFileSync(join(host.directory, 'cursor-host.exe'), 'changed');
  assert.throws(() => host.personCopy(), /HOST_PACKAGE_MISMATCH/);
});
test('a failed copy ACL check leaves no run directory or spawnable result', async t => {
  const { options } = fixture(t);
  const access = options.access;
  const host = await prepareWindowsHandHost({ ...options, access(batch) {
    if (batch.some(([, path]) => path.includes('person-run-'))) throw Error('HOST_CACHE_UNSAFE');
    return access(batch);
  } });
  assert.equal(host.status, 'ready');
  assert.throws(() => host.personCopy(), /HOST_CACHE_UNSAFE/);
  assert.equal(readdirSync(options.cacheRoot).filter(name => name.startsWith('person-run-')).length, 0);
});
test('compiler selects an explicit entry point when both host modes share a build', async () => {
  for (const [sources, main] of [
    [['C:\\source\\PersonHost.cs'], 'Sleight.Person.PersonHost'],
    [['C:\\source\\Program.cs', 'C:\\source\\PersonHost.cs'], 'Sleight.Cursor.Program'],
  ]) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let args;
    const pending = compileWindowsHost({ compiler: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
      sources, binary: 'C:\\build\\test.exe', run: (_file, vector) => { args = vector; return child; } });
    child.emit('close', 0); await pending;
    assert.ok(args.includes('/main:' + main));
    assert.ok(!args.some(value => /nuget|windows\.winmd|contracts/i.test(value)));
  }
});
test('WIN3 entry dispatches person modes before initializing the overlay', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/Program.cs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('PersonHost.Handles(args)') < source.indexOf('options = Options.Parse(args)'));
  for (const name of windowsPersonSources.filter(name => name.endsWith('.cs'))) assert.ok(windowsHostSources.includes(name));
});

test('next prepare sweeps only ordinary person runs older than one hour', async t => {
  const { options, root } = fixture(t);
  const host = await prepareWindowsHandHost(options);
  const old = host.personCopy(), recent = host.personCopy();
  utimesSync(old.path.replace(/[/\\]person-host.exe$/, ''), new Date(0), new Date(0));
  const target = join(root, 'unrelated'); mkdirSync(target); writeFileSync(join(target, 'keep'), 'keep');
  symlinkSync(target, join(options.cacheRoot, 'person-run-link'));
  mkdirSync(join(options.cacheRoot, 'build-keep'));
  assert.equal((await prepareWindowsHandHost(options)).status, 'ready');
  assert.throws(() => readFileSync(old.path), /ENOENT/);
  assert.equal(readFileSync(recent.path, 'utf8'), 'person PE');
  assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'keep');
  assert.ok(readdirSync(options.cacheRoot).includes('build-keep'));
  recent.cleanup();
});
test('stale sweep retains folders when ACL proof fails', async t => {
  const { options } = fixture(t); const host = await prepareWindowsHandHost(options); const copy = host.personCopy();
  const folder = copy.path.replace(/[/\\]person-host.exe$/, ''); utimesSync(folder, new Date(0), new Date(0));
  sweepWindowsPersonRuns(options.cacheRoot, { check: () => { throw Error('ACL'); } });
  assert.equal(readFileSync(copy.path, 'utf8'), 'person PE'); copy.cleanup();
});
test('VM can select only the in-box metadata compile variant', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let args;
  const pending = compileWindowsHost({ compiler: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    sources: ['PersonHost.cs'], binary: 'fixture.exe', winrt: 'metadata', run: (_file, vector) => { args = vector; return child; } });
  child.emit('close', 0); await pending;
  assert.ok(args.includes('/define:PERSON_WINRT_METADATA'));
  for (const suffix of ['WinMetadata\\Windows.Security.winmd', 'WinMetadata\\Windows.Foundation.winmd', 'System.Runtime.WindowsRuntime.dll'])
    assert.ok(args.some(arg => arg.startsWith('/r:C:\\Windows\\') && arg.endsWith(suffix)));
  assert.ok(!args.some(arg => /nuget|cswinrt|sdk/i.test(arg)));
  await assert.rejects(compileWindowsHost({ winrt: 'sdk' }), /INVALID/);
});

test('full adapter preparation checks exactly one private copy across three helper operations', async t => {
  const { options, compiles, checks } = fixture(t);
  const child = new EventEmitter(); child.stdout = new PassThrough();
  let runs = 0;
  const host = await prepareWindowsPerson({ ...options, prepare: prepareWindowsHandHost,
    sync: (_file, args) => { runs++; return JSON.stringify(args[0] === '--person-presence' ?
      { schema: 'sleight.person-presence/1', active: true, unlocked: true, idleMs: 0 } : {}); },
    run: () => { runs++; return child; } });
  assert.equal(host.status, 'ready'); host.snapshot(500, 100); assert.equal(host.presence(), true); host.spawn('settings');
  child.emit('close', 0);
  assert.equal(runs, 3); assert.equal(compiles.length, 1);
  assert.equal(checks.filter(batch => batch.some(([, path]) => path.includes('person-run-'))).length, 1);
});

for (const change of ['replace', 'remove']) test(`confirmation refuses a ${change}d helper after snapshot and presence`, async t => {
  const { options } = fixture(t);
  let helperPath, spawned = 0;
  const host = await prepareWindowsPerson({ ...options, prepare: prepareWindowsHandHost,
    sync: (file, args) => { helperPath = file; return JSON.stringify(args[0] === '--person-presence' ?
      { schema: 'sleight.person-presence/1', active: true, unlocked: true, idleMs: 0 } : {}); },
    run: () => { spawned++; throw Error('must not spawn'); } });
  assert.equal(host.status, 'ready'); host.snapshot(500, 100); assert.equal(host.presence(), true);
  if (change === 'replace') writeFileSync(helperPath, 'replacement PE'); else rmSync(helperPath);
  assert.throws(() => host.spawn('settings'), /HOST_PACKAGE_MISMATCH|ENOENT/);
  assert.equal(spawned, 0);
  assert.equal(readdirSync(options.cacheRoot).filter(name => name.startsWith('person-run-')).length, 0);
});

for (const operation of ['snapshot', 'presence']) for (const change of ['replace', 'remove'])
  test(`${operation} refuses a ${change}d helper before running it`, async t => {
    const { options } = fixture(t);
    let copyPath, runs = 0;
    const host = await prepareWindowsPerson({ ...options, prepare: async args => {
      const prepared = await prepareWindowsHandHost(args);
      return { ...prepared, personCopy() { const copy = prepared.personCopy(); copyPath = copy.path; return copy; } };
    }, sync: () => { runs++; return '{}'; } });
    assert.equal(host.status, 'ready');
    if (change === 'replace') writeFileSync(copyPath, 'replacement PE'); else rmSync(copyPath);
    assert.throws(() => operation === 'snapshot' ? host.snapshot(500, 100) : host.presence(), /HOST_PACKAGE_MISMATCH|ENOENT/);
    assert.equal(runs, 0);
    assert.equal(readdirSync(options.cacheRoot).filter(name => name.startsWith('person-run-')).length, 0);
    assert.throws(() => host.snapshot(500, 100), /CLOSED/);
  });

for (const present of [true, false]) test(`metadata compile handles System.Runtime facade present=${present}`, async () => {
  const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const facade = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\Facades\\System.Runtime.dll';
  for (const winrt of ['metadata', 'abi']) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let args;
    const pending = compileWindowsHost({ compiler, sources: ['PersonHost.cs'], binary: 'fixture.exe', winrt,
      exists: file => { assert.equal(file, facade); return present; }, run: (_file, vector) => { args = vector; return child; } });
    child.emit('close', 0); await pending;
    assert.equal(args.includes('/r:' + facade), winrt === 'metadata' && present);
  }
});
