import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const moduleURL = new URL('../plugins/sleight/lib/direct-browser/windows-host.mjs', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
test('Windows consent cancels a FrameFault on first layout and DPI changes', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/Consent.cs', import.meta.url), 'utf8');
  const created = source.slice(source.indexOf('protected override void OnHandleCreated'), source.indexOf('protected override void OnFormClosed'));
  assert.match(created, /try\s*\{\s*LayoutCard\(Win\.GetDpiForWindow\(Handle\), Screen\.FromHandle\(Handle\)\.WorkingArea\);\s*\}/);
  assert.match(created, /catch\s*\(FrameFault\)\s*\{\s*Answer\("cancel"\);\s*BeginInvoke\(new Action\(Close\)\);\s*return;\s*\}/);
  assert.ok(created.indexOf('return;') < created.indexOf('input = new ConsentInput(Handle)'), 'a refused layout cannot arm input or start its timer');
  const wndProc = source.slice(source.indexOf('protected override void WndProc', source.indexOf('void Finish(')));
  assert.match(wndProc, /try\s*\{\s*LayoutCard\(dpi, workArea\);\s*\}\s*catch\s*\(FrameFault\)\s*\{\s*Finish\("cancel"\);\s*\}/);
});
test('Windows frame ingestion skips the unused UIA query while secure suppression stays unconditional', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/Overlay.cs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /secureInput|\.IsSecure\(/);
  assert.match(source, /WIN3: no UIA query/);
  assert.match(source, /Secure\s*=\s*\(\)\s*=>\s*true/);
});
async function fixture(t) {
  const api = await import(moduleURL);
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-win-host-'))));
  const sourceRoot = join(root, 'source'), cacheRoot = join(root, 'cache');
  mkdirSync(sourceRoot);
  const files = api.windowsHostSources.map(name => {
    writeFileSync(join(sourceRoot, name), 'source ' + name, { mode: 0o600 });
    return { path: 'native/win/' + name, sha256: sha('source ' + name) };
  });
  const calls = [], compiler = join(root, 'csc.exe');
  writeFileSync(compiler, 'fake csc', { mode: 0o600 });
  const options = { platform: 'win32', sourceRoot, cacheRoot, compiler,
    inventory: { accepted: true, protocol: 1, node: process.version, helperMode: 'source', files },
    access(checks) { for (const [operation, path] of checks) if (operation === 'create') mkdirSync(path, { recursive: true, mode: 0o700 }); return {}; },
    compile: async ({ sources, binary, signal }) => {
      signal?.throwIfAborted(); calls.push(sources.map(path => readFileSync(path, 'utf8')));
      writeFileSync(binary, 'fake PE', { mode: 0o700 });
    } };
  return { api, root, options, calls };
}

test('Windows helper refuses other platforms before inspecting or creating paths', async () => {
  const api = await import(moduleURL);
  const result = await api.prepareWindowsHandHost({ platform: 'darwin', sourceRoot: '/absent', access() { assert.fail(); }, compile() { assert.fail(); } });
  assert.deepEqual(result, { status: 'unavailable', code: 'PLATFORM' });
});

test('compiler discovery checks only in-box Framework compiler paths, preferring Framework64', async () => {
  const api = await import(moduleURL);
  const paths = [];
  const found = api.findWindowsCompiler({ platform: 'win32', exists: path => { paths.push(path); return path.includes('Framework\\'); } });
  assert.equal(found, 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe');
  assert.equal(paths.length, 2);
  assert.equal(api.findWindowsCompiler({ platform: 'darwin', exists() { assert.fail(); } }), undefined);

});

test('fake csc build publishes hashed sources and binaries, reuses cache, and issues a frozen receipt', async t => {
  const { api, options, calls } = await fixture(t);
  const built = await api.prepareWindowsHandHost(options);
  assert.equal(built.status, 'ready'); assert.equal(calls.length, 1);
  assert.equal(calls[0].length, api.windowsHostSources.filter(name => name.endsWith('.cs')).length);
  assert.ok(Object.isFrozen(built.receipt));
  assert.equal(api.windowsHostExecutable(built.receipt, { platform: 'win32' }), join(built.directory, 'cursor-host.exe'));
  const record = JSON.parse(readFileSync(join(built.directory, 'build.json')));
  assert.equal(record.binaries['cursor-host.exe'], sha('fake PE'));
  assert.deepEqual(record.compiler, { path: options.compiler, sha256: sha('fake csc') });
  assert.equal(Object.keys(record.sources).length, api.windowsHostSources.length);
  assert.equal((await api.prepareWindowsHandHost(options)).status, 'ready'); assert.equal(calls.length, 1);
  assert.throws(() => api.windowsHostExecutable({}, { platform: 'win32' }), /DISTRIBUTION_ACCEPTANCE_REQUIRED/);
  assert.throws(() => api.windowsHostExecutable(built.receipt, { platform: 'darwin' }), /DISTRIBUTION_ACCEPTANCE_REQUIRED/);
});

test('receipt detects binary, record and source mutation before launch', async t => {
  for (const which of ['binary', 'record', 'source']) {
    const { api, options } = await fixture(t);
    const built = await api.prepareWindowsHandHost(options); assert.equal(built.status, 'ready');
    const path = which === 'binary' ? join(built.directory, 'cursor-host.exe') : which === 'record' ? join(built.directory, 'build.json') : join(options.sourceRoot, api.windowsHostSources[0]);
    writeFileSync(path, 'changed');
    assert.throws(() => api.windowsHostExecutable(built.receipt, { platform: 'win32' }), /HOST_PACKAGE_MISMATCH/);
  }
});

test('accepted source inventory is required and source changes during compile refuse publication', async t => {
  const { api, options } = await fixture(t);
  for (const inventory of [{}, { ...options.inventory, accepted: false }, { ...options.inventory, node: 'other' },
    { ...options.inventory, files: options.inventory.files.slice(1) }, { ...options.inventory, files: [...options.inventory.files, options.inventory.files[0]] }]) {
    await assert.rejects(api.prepareWindowsHandHost({ ...options, inventory }), /DISTRIBUTION_ACCEPTANCE_REQUIRED/);
  }
  const compile = options.compile;
  const built = await api.prepareWindowsHandHost({ ...options, compile: async args => { await compile(args); writeFileSync(join(options.sourceRoot, api.windowsHostSources[0]), 'changed'); } });
  assert.equal(built.status, 'unavailable'); assert.equal(built.code, 'HOST_SOURCE_MISMATCH');
  assert.deepEqual(readdirSync(options.cacheRoot), []);
});

test('failed or aborted compiler cleans its private staging and lock without publishing', async t => {
  const { api, options } = await fixture(t);
  for (const error of [Object.assign(Error('compiler failed'), { code: 23 }), Object.assign(Error('aborted'), { name: 'AbortError' })]) {
    const built = await api.prepareWindowsHandHost({ ...options, compile: async () => { throw error; } });
    assert.equal(built.status, 'unavailable'); assert.deepEqual(readdirSync(options.cacheRoot), []);
    assert.equal(built.detail?.[error.name === 'AbortError' ? 'errorCode' : 'exitCode'], error.name === 'AbortError' ? 'ABORT_ERR' : 23);
  }
});

test('concurrent builders serialize, and cache symlinks and failed ACL checks refuse', async t => {
  const { api, root, options } = await fixture(t);
  let release, began;
  const compiling = new Promise(resolve => { began = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const build = api.prepareWindowsHandHost({ ...options, compile: async args => { began(); await held; await options.compile(args); } });
  await compiling;
  assert.equal((await api.prepareWindowsHandHost(options)).code, 'HOST_BUILD_BUSY');
  release(); assert.equal((await build).status, 'ready');
  const link = join(root, 'link'); symlinkSync(options.cacheRoot, link, 'dir');
  assert.equal((await api.prepareWindowsHandHost({ ...options, cacheRoot: join(link, 'child') })).code, 'HOST_CACHE_UNSAFE');
  assert.equal(existsSync(join(options.cacheRoot, 'child')), false);
  assert.equal((await api.prepareWindowsHandHost({ ...options, access() { throw Error('HOST_CACHE_UNSAFE'); } })).code, 'HOST_CACHE_UNSAFE');
});

test('host handle validates capture/style and refuses consent before spawning', async t => {
  const { api, options } = await fixture(t);
  const calls = [], run = (file, args, config) => { calls.push({ file, args, config }); return new EventEmitter(); };
  const built = await api.prepareWindowsHandHost({ ...options, run });
  assert.equal(built.status, 'ready');
  for (const invalid of [{ capture: 'other' }, { cursorStyle: 'glove' }, { consent: true }]) assert.throws(() => built.spawn(invalid));
  assert.equal(calls.length, 0);
  built.spawn();
  assert.deepEqual(calls[0].args, ['--hand', '--capture=hidden', '--cursor-style=ring']);
  assert.deepEqual(calls[0].config.stdio, ['pipe', 'pipe', 'ignore']);
});

test('compiler adapter fixes arguments, hides the process and waits for close after abort', async t => {
  const { api, root } = await fixture(t);
  const binary = join(root, 'host.exe'), calls = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let killed = 0; child.kill = () => { killed++; };
  const abort = new AbortController();
  const pending = api.compileWindowsHost({ compiler: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', sources: ['one.cs', 'two.cs'], binary, signal: abort.signal,
    run(file, args, options) { calls.push({ file, args, options }); return child; } });
  let settled = false; const result = pending.catch(error => { settled = true; return error; });
  abort.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(killed, 1); assert.equal(settled, false);
  assert.ok(calls[0].args.includes('/noconfig'));
  assert.deepEqual(calls[0].args.slice(-2), ['one.cs', 'two.cs']);
  assert.ok(calls[0].args.includes('/out:' + binary));
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.cwd, root);
  assert.ok(!calls[0].args.includes('/warnaserror+'));
  assert.ok(calls[0].args.filter(a => a.startsWith('/r:')).every(a => /^\/r:C:\\Windows\\/.test(a)));
  assert.equal(calls[0].options.env.SystemRoot, 'C:\\Windows');
  assert.equal(calls[0].options.shell, undefined);
  child.emit('close', 1); assert.equal((await result).name, 'AbortError');
});

test('cache creation secures missing parent directories before the build bank', async t => {
  const { api, root, options } = await fixture(t);
  const cacheRoot = join(root, 'local', 'sleight', 'host'), created = [];
  const built = await api.prepareWindowsHandHost({ ...options, cacheRoot,
    access(checks) { for (const [op, path] of checks) if (op === 'create') { assert.ok(existsSync(join(path, '..'))); mkdirSync(path); created.push(path); } } });
  assert.equal(built.status, 'ready');
  assert.deepEqual(created, [join(root, 'local'), join(root, 'local', 'sleight'), cacheRoot]);
});

test('missing source or LocalAppData refuses without calling the compiler', async t => {
  const { api, root, options, calls } = await fixture(t);
  assert.equal((await api.prepareWindowsHandHost({ ...options, inventory: undefined, sourceRoot: join(root, 'absent') })).code, 'HOST_SOURCE_MISMATCH');
  assert.equal((await api.prepareWindowsHandHost({ ...options, cacheRoot: '' })).code, 'HOST_CACHE_UNSAFE');
  assert.equal(calls.length, 0);
});

test('SystemRoot and PATH cannot redirect compiler or PowerShell discovery', async () => {
  const api = await import(moduleURL);
  const saved = process.env.SystemRoot;
  try {
    process.env.SystemRoot = '/tmp/project-controlled-windows';
    const seen = [];
    const compiler = api.findWindowsCompiler({ platform: 'win32', exists(path) { seen.push(path); return true; } });
    assert.equal(compiler, 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
    assert.equal(api.windowsPowerShell, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(seen.length, 1);
  } finally { if (saved === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = saved; }
});

test('cached launch batches ACL checks once and spawn rechecks hashes without PowerShell', async t => {
  const { api, options } = await fixture(t);
  await api.prepareWindowsHandHost(options);
  const batches = [];
  const built = await api.prepareWindowsHandHost({ ...options, access(checks) { batches.push(checks); }, run() { return {}; } });
  assert.equal(built.status, 'ready'); assert.equal(batches.length, 1);
  assert.ok(batches[0].some(([op, path]) => op === 'system' && path === options.compiler));
  built.spawn(); built.spawn();
  assert.equal(batches.length, 1);
});

test('compiler failures retain capped, redacted diagnostics and wait for close', async t => {
  const { api, root } = await fixture(t), binary = join(root, 'host.exe');
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let kills = 0; child.kill = () => { kills++; };
  const result = api.compileWindowsHost({ sources: [], binary, compiler: 'C:\\Windows\\csc.exe', run: () => child }).catch(e => e);
  child.stdout.write(root + '/Program.cs(4): error CS0001: fixture error\n');
  child.stderr.write(Buffer.alloc(70000, 255));
  assert.equal(kills, 1);
  child.emit('close', 1);
  const error = await result;
  assert.ok(error.stdout.includes('error CS0001')); assert.ok(!error.stdout.includes(root));
  assert.ok(Buffer.byteLength(error.stdout + error.stderr) <= 65536);
});

test('stale locks recover by missing pid, process birth, or age; fresh/unknown locks stay busy', async t => {
  for (const kind of ['gone', 'reused', 'old', 'fresh', 'unknown', 'no-owner-old', 'no-owner-fresh']) {
    const { api, options } = await fixture(t);
    const hashes = Object.fromEntries(options.inventory.files.map(f => [f.path.split('/').at(-1), f.sha256]));
    const key = sha(JSON.stringify({ protocol: 1, arch: process.arch, sources: hashes }));
    mkdirSync(options.cacheRoot);
    const lock = join(options.cacheRoot, key + '.lock'); mkdirSync(lock);
    if (!kind.startsWith('no-owner')) writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 123, started: 10000,
      created: Date.now() - (kind === 'old' ? 700000 : 0) }));
    if (kind === 'no-owner-old') utimesSync(lock, new Date(0), new Date(0));
    const access = options.access;
    const built = await api.prepareWindowsHandHost({ ...options, access(checks) {
      access(checks); return { ownerStarted: kind === 'gone' ? null : kind === 'reused' ? 20000 : kind === 'unknown' ? 'unknown' : 10000 };
    } });
    assert.equal(built.status, ['gone', 'reused', 'old', 'no-owner-old'].includes(kind) ? 'ready' : 'unavailable', kind);
    if (built.status === 'unavailable') assert.equal(built.code, 'HOST_BUILD_BUSY', kind);
  }
});

test('an owner-record race cannot reclaim a newly replaced live lock', async t => {
  const { api, options } = await fixture(t);
  const hashes=Object.fromEntries(options.inventory.files.map(f=>[f.path.split('/').at(-1),f.sha256]));
  const key=sha(JSON.stringify({protocol:1,arch:process.arch,sources:hashes}));
  mkdirSync(options.cacheRoot);
  const lock=join(options.cacheRoot,key+'.lock');mkdirSync(lock);
  writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:123,started:1,created:Date.now()}));
  const built=await api.prepareWindowsHandHost({...options,access(checks){
    options.access(checks);
    writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:124,started:2,created:Date.now()}));
    return {ownerStarted:null};
  }});
  assert.equal(built.code,'HOST_BUILD_BUSY');
  assert.equal(JSON.parse(readFileSync(join(lock,'owner.json'))).pid,124);
});

test('doctor host lookup is read-only and requires current sources, compiler, binary and ACL evidence', async t => {
  const { api, options, calls } = await fixture(t);
  assert.equal(typeof api.windowsHandHostBuilt, 'function');
  assert.equal(api.windowsHandHostBuilt(options), false);
  assert.equal(existsSync(options.cacheRoot), false);
  const result = await api.prepareWindowsHandHost(options); assert.equal(result.status, 'ready');
  const operations = [];
  assert.equal(api.windowsHandHostBuilt({ ...options, access(checks) { operations.push(...checks.map(([op]) => op)); } }), true);
  assert.ok(operations.length > 0 && !operations.includes('create'));
  assert.equal(api.windowsHandHostBuilt({ ...options, access() { throw Error('unsafe ACL'); } }), false);
  writeFileSync(join(result.directory, 'cursor-host.exe'), 'tampered');
  assert.equal(api.windowsHandHostBuilt(options), false); assert.equal(calls.length, 1);
});

test('doctor host lookup stays inert on macOS', async () => {
  const api = await import(moduleURL);
  assert.equal(typeof api.windowsHandHostBuilt, 'function');
  assert.equal(api.windowsHandHostBuilt({ platform: 'darwin', access: () => assert.fail('Windows ACL call') }), false);
});

test('read-only cached receipt binds native gate launches to the current binary', async t => {
  const { api, options } = await fixture(t);
  assert.equal(api.windowsCachedHostReceipt(options), undefined);
  const built = await api.prepareWindowsHandHost(options);
  const receipt = api.windowsCachedHostReceipt(options);
  assert.ok(receipt && Object.isFrozen(receipt));
  assert.equal(api.windowsHostExecutable(receipt, { platform: 'win32' }), join(built.directory, 'cursor-host.exe'));
  writeFileSync(join(built.directory, 'cursor-host.exe'), 'tampered');
  assert.throws(() => api.windowsHostExecutable(receipt, { platform: 'win32' }), /HOST_PACKAGE_MISMATCH/);
  assert.equal(api.windowsCachedHostReceipt(options), undefined);
});
