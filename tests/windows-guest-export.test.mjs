import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { createManifest, MANIFEST_NAME, sha256, verifyKit, checkPortable, safePath } from '../bench/windows/guest-integrity.mjs';
import { exportGuest, EXPORT_PATHS, parseExportArgs } from '../bench/windows/export-guest.mjs';
import { preflight, main as preflightMain, parsePreflightArgs, sourceChecks } from '../bench/windows/guest-preflight.mjs';
import { buildHost } from '../bench/windows/build-host.mjs';
import { discoverSuites } from '../bench/windows/run-checks.mjs';
import { windowsHostSources, windowsDriverSources, windowsPersonSources, windowsPowerShell } from '../plugins/sleight/lib/direct-browser/windows-host.mjs';

const temp = t => registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-guest-kit-')));
const ok = info => ({ status: 0, stdout: JSON.stringify(info), reason: null });
const windows = () => ({ build: 26200, revision: 1, architecture: 'ARM64', uiaAvailable: true });
const nativePath = 'plugins/sleight/lib/direct-browser/native/win';
const buildSources = [...new Set([...windowsHostSources, ...windowsDriverSources, ...windowsPersonSources])].sort();
// Reconstruct the stderr shape observed with PowerShell 5.1 on 2026-10-31.
const clixmlProgress = '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
  '<Obj S="progress" RefId="0"><MS><I64 N="SourceId">1</I64><PR N="Record">' +
  '<AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC>' +
  '<T>Completed</T><SR /><SD> </SD></PR></MS></Obj></Objs>';
function kit(t) {
  const root = temp(t); writeFileSync(join(root, 'source.mjs'), '// fixture\n');
  for (const path of ['bench/windows/guest-preflight.ps1', ...buildSources.map(name => nativePath + '/' + name)]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), readFileSync(new URL('../' + path, import.meta.url)));
  }
  const commit = 'a'.repeat(40), manifest = createManifest(root, commit);
  const bytes = JSON.stringify(manifest) + '\n'; writeFileSync(join(root, MANIFEST_NAME), bytes);
  return { root, expectedCommit: commit, expectedManifestSha256: sha256(bytes) };
}
function repository(t) {
  const root = temp(t), out = temp(t);
  const git = args => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, killSignal: 'SIGKILL' }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  for (const path of EXPORT_PATHS) {
    const file = path.includes('.') && !path.endsWith('windows') && !path.endsWith('lib') && !path.endsWith('bin') && !path.endsWith('vendor') && !path.includes('plugin') ? path : path + '/fixture.txt';
    mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), '// committed fixture\n');
  }
  writeFileSync(join(root, '.gitignore'), 'node_modules\nignored-secret\n');
  git(['add', '--', ...EXPORT_PATHS, '.gitignore']); git(['commit', '-qm', 'Fixture']);
  return { root, output: join(out, 'kit'), git, revision: git(['rev-parse', 'HEAD']) };
}
test('export uses commit bytes only, omits host state and prints reproducible manifest identity', { skip: process.platform === 'win32' }, t => {
  const h = repository(t);
  mkdirSync(join(h.root, 'node_modules')); writeFileSync(join(h.root, 'node_modules', 'token'), 'host only');
  writeFileSync(join(h.root, 'ignored-secret'), 'host only');
  const receipt = exportGuest(h);
  assert.equal(receipt.commit, h.revision);
  const selectedFiles = h.git(['ls-tree', '-rz', h.revision, '--', ...EXPORT_PATHS]).split('\0').filter(Boolean).length;
  assert.equal(receipt.files, selectedFiles);
  assert.equal(existsSync(join(h.output, '.git')), false); assert.equal(existsSync(join(h.output, 'node_modules')), false);
  assert.equal(existsSync(join(h.output, 'ignored-secret')), false);
  assert.equal(verifyKit(h.output, { expectedCommit: h.revision, expectedManifestSha256: receipt.manifestSha256 }).files.length, receipt.files);
  const other = exportGuest({ ...h, output: h.output + '-2' }); assert.equal(other.manifestSha256, receipt.manifestSha256);
  assert.throws(() => exportGuest(h), /Output must be absent/);
});
test('export refuses an archive that export-ignore makes smaller than the selected tree', { skip: process.platform === 'win32' }, t => {
  for (const path of ['package.json', 'bench/windows']) {
    const h = repository(t);
    writeFileSync(join(h.root, '.gitattributes'), path + ' export-ignore\n');
    h.git(['add', '--', '.gitattributes']); h.git(['commit', '-qm', 'Exclude selected source']);
    assert.throws(() => exportGuest({ ...h, revision: h.git(['rev-parse', 'HEAD']) }), /Extracted file count .* does not match ls-tree count/);
    assert.equal(existsSync(h.output), false);
  }
});
test('dirty tracked, staged and untracked trees refuse before any export', { skip: process.platform === 'win32' }, t => {
  const h = repository(t), file = join(h.root, 'package.json');
  writeFileSync(file, 'changed'); assert.throws(() => exportGuest(h), /Dirty tree/);
  h.git(['add', '--', 'package.json']); assert.throws(() => exportGuest(h), /Dirty tree/);
  h.git(['reset', '--hard', 'HEAD']); writeFileSync(join(h.root, 'untracked'), 'new');
  assert.throws(() => exportGuest(h), /Dirty tree/); assert.equal(existsSync(h.output), false);
});
test('exporting an older commit ignores later committed bytes', { skip: process.platform === 'win32' }, t => {
  const h = repository(t); writeFileSync(join(h.root, 'package.json'), 'newer');
  h.git(['add', '--', 'package.json']); h.git(['commit', '-qm', 'Newer']);
  exportGuest(h); assert.equal(readFileSync(join(h.output, 'package.json'), 'utf8'), '// committed fixture\n');
});
test('tracked symlinks and nonportable content refuse without publishing', { skip: process.platform === 'win32' }, t => {
  for (const mode of ['link', 'home', 'credential']) {
    const h = repository(t), file = 'bench/windows/unsafe.txt';
    if (mode === 'link') symlinkSync('/etc/passwd', join(h.root, file));
    else writeFileSync(join(h.root, file), mode === 'home' ? ['/', 'Users', 'fixture', 'private'].join('/') : 'ghp_' + 'a'.repeat(36));
    h.git(['add', '--', file]); h.git(['commit', '-qm', 'Unsafe']);
    assert.throws(() => exportGuest({ ...h, revision: h.git(['rev-parse', 'HEAD']) }), /refused|Nonportable/);
    assert.equal(existsSync(h.output), false);
  }
});
test('path, credential and export argument policies reject unsafe inputs', () => {
  for (const path of ['../x', '/x', 'a//b', 'a/../b', '.git/config', 'a/node_modules/x', 'C:/x', 'a\\x', 'a./b', 'AUX.txt', 'a/COM1']) assert.throws(() => safePath(path));
  for (const path of ['.env', 'x/auth.json', 'credentials.json', 'id_ed25519']) assert.throws(() => checkPortable(path, Buffer.from('x')));
  for (const args of [[], ['HEAD'], ['--commit', 'a', '--output'], ['--output', 'x', '--commit', 'a']]) assert.throws(() => parseExportArgs(args));
  assert.equal(parseExportArgs(['--commit', 'abc1234', '--output', 'folder']).revision, 'abc1234');
});
test('hash verification detects changed, missing, unexpected and symlinked files', t => {
  for (const which of ['changed', 'missing', 'extra', 'symlink', 'manifest']) {
    const h = kit(t), file = join(h.root, 'source.mjs');
    if (which === 'changed') writeFileSync(file, 'changed');
    if (which === 'missing' || which === 'symlink') rmSync(file);
    if (which === 'extra') writeFileSync(join(h.root, 'extra'), 'extra');
    if (which === 'symlink') symlinkSync(join(h.root, MANIFEST_NAME), file);
    if (which === 'manifest') writeFileSync(join(h.root, MANIFEST_NAME), '{}');
    assert.throws(() => verifyKit(h.root, h));
  }
});
test('external pins are mandatory and wrong commit or duplicate manifest entries refuse', t => {
  const h = kit(t); assert.throws(() => verifyKit(h.root, {}), /Pin/);
  assert.throws(() => verifyKit(h.root, { ...h, expectedCommit: 'b'.repeat(40) }), /contract mismatch/);
  const manifest = JSON.parse(readFileSync(join(h.root, MANIFEST_NAME))); manifest.files.push(manifest.files[0]);
  const bytes = JSON.stringify(manifest); writeFileSync(join(h.root, MANIFEST_NAME), bytes);
  assert.throws(() => verifyKit(h.root, { ...h, expectedManifestSha256: sha256(bytes) }), /duplicate/);
});
test('measurement outputs do not change source identity on a repeated preflight', t => {
  const h = kit(t); mkdirSync(join(h.root, 'vm-results')); writeFileSync(join(h.root, 'vm-results', 'first.json'), '{}');
  const files = verifyKit(h.root, h).files;
  assert.equal(files.length, 28);
  assert.ok(files.some(file => file.path === nativePath + '/DriverHook.cs'));
});
test('preflight reports every hash and probes Windows/UIA without an app or content read', async t => {
  const h = kit(t), calls = [];
  const report = await preflight(h, { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0', execute: async (...args) => {
    calls.push(args); return ok(calls.length === 1 ? { ownerStarted: 'unknown' } : windows());
  } });
  assert.equal(report.verdict, 'pass'); assert.equal(report.files.length, 28); assert.equal(report.windows.build, 26200);
  assert.ok(report.files.some(file => file.path === nativePath + '/DriverHook.cs'));
  assert.equal(calls.length, 2);
  for (const [command, args, options] of calls) {
    assert.equal(command, windowsPowerShell);
    assert.ok(args.includes('-EncodedCommand')); assert.ok(!args.includes('-File'));
    assert.equal(options.lowPriority, true); assert.equal(options.maxBytes, 4096);
  }
  const script = Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le');
  const cache = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/cache-access.ps1', import.meta.url), 'utf8');
  assert.ok(script.startsWith(cache + '\nInvoke-HostChecks '));
  const payload = JSON.parse(Buffer.from(script.match(/\nInvoke-HostChecks '([^']+)'$/)[1], 'base64').toString('utf8'));
  assert.deepEqual(payload, { checks: [['source', win32.resolve(h.root)],
    ['source', win32.join(win32.resolve(h.root), nativePath)],
    ...buildSources.map(name => ['source', win32.join(win32.resolve(h.root), nativePath, name)])] });
  assert.deepEqual(calls[0][2].env, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' });
  assert.equal(calls[0][2].cwd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  assert.equal(calls[0][2].timeout, 10000);
  const source = readFileSync(new URL('../bench/windows/guest-preflight.ps1', import.meta.url), 'utf8');
  assert.equal(Buffer.from(calls[1][1].at(-1), 'base64').toString('utf16le'), source);
  assert.match(source, /CreateInstance/); assert.match(source, /FinalReleaseComObject/);
  assert.doesNotMatch(source, /RootElement|GetRootElement|FindAll|SendInput|Start-Process/);
});
test('source ACL checks normalize a trailing Windows root separator and cover only native win files', () => {
  assert.deepEqual(sourceChecks('C:\\sleight\\', [
    { path: nativePath + '/Program.cs' }, { path: nativePath + '/cache-access.ps1' },
    { path: 'source.mjs' }, { path: nativePath + '-other/ignored.cs' },
  ]), [
    ['source', 'C:\\sleight'],
    ['source', 'C:\\sleight\\plugins\\sleight\\lib\\direct-browser\\native\\win'],
    ['source', 'C:\\sleight\\plugins\\sleight\\lib\\direct-browser\\native\\win\\Program.cs'],
    ['source', 'C:\\sleight\\plugins\\sleight\\lib\\direct-browser\\native\\win\\cache-access.ps1'],
  ]);
});
test('a refused source file ACL stops preflight in the single checker call', async t => {
  const h = kit(t); let calls = 0;
  const report = await preflight(h, { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0',
    execute: async (_command, args) => {
      calls++;
      if (calls > 1) return ok(windows());
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      const { checks } = JSON.parse(Buffer.from(script.match(/\nInvoke-HostChecks '([^']+)'$/)[1], 'base64').toString('utf8'));
      const file = win32.join(win32.resolve(h.root), nativePath, 'DriverClipboard.cs');
      return checks.some(([operation, path]) => operation === 'source' && path === file)
        ? { status: 65, stdout: '', stderr: 'HOST_CACHE_UNSAFE\r\n' } : ok({ ownerStarted: 'unknown' });
    } });
  assert.equal(calls, 1); assert.equal(report.verdict, 'fail'); assert.equal(report.windows, null);
  assert.equal(report.reason, 'refused'); assert.match(report.mismatches[0], /refused/);
});
test('unsafe kit folders print the owner check and SID-based lock commands only after a checker refusal', async t => {
  const h = kit(t);
  const report = await preflight(h, { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0',
    execute: async () => ({ status: 65, stdout: '', stderr: 'HOST_CACHE_UNSAFE' }) });
  assert.equal(report.code, 'KIT_FOLDER_WRITABLE'); assert.equal(report.reason, 'refused');
  assert.equal(report.fix.length, 3);
  assert.equal(report.fix[0], "(Get-Acl -LiteralPath '" + win32.resolve(h.root) + "').Owner");
  assert.ok(report.fix[1].startsWith("icacls '" + win32.resolve(h.root) + "' /inheritance:r /grant:r "));
  assert.ok(report.fix[1].includes('"*$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value):(OI)(CI)F"'));
  assert.ok(!report.fix[1].includes('/T'));
  assert.equal(report.fix[2], "icacls '" + win32.join(win32.resolve(h.root), '*') + "' /reset /T /C /Q");
});
test('successful ACL JSON proceeds despite PowerShell CLIXML progress on stderr', async t => {
  const h = kit(t);
  for (const stderr of ['#< CLIXML\r\n' + clixmlProgress,
    '#< CLIXML\r\nHOST_CACHE_UNSAFE\r\n' + clixmlProgress]) {
    let calls = 0;
    const report = await preflight(h, { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0',
      execute: async () => ++calls === 1 ? { ...ok({ ownerStarted: 'unknown' }), stderr } : ok(windows()) });
    assert.equal(calls, 2); assert.equal(report.verdict, 'pass'); assert.equal(report.windows.build, 26200);
    assert.equal(report.code, undefined); assert.equal(report.reason, undefined); assert.equal(report.fix, undefined);
    assert.doesNotMatch(JSON.stringify(report), /CLIXML|Preparing modules|HOST_CACHE_UNSAFE/);
  }
});
test('exit 65 with an exact marker line refuses amid PowerShell CLIXML progress', async t => {
  const h = kit(t);
  for (const lines of [['#< CLIXML', 'HOST_CACHE_UNSAFE', clixmlProgress],
    ['HOST_CACHE_UNSAFE', '#< CLIXML', clixmlProgress],
    ['#< CLIXML', clixmlProgress, 'HOST_CACHE_UNSAFE']]) {
    for (const newline of ['\r\n', '\n']) {
      let calls = 0;
      const report = await preflight(h, { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0',
        execute: async () => { calls++; return { status: 65, stdout: '', stderr: lines.join(newline) + newline }; } });
      assert.equal(calls, 1); assert.equal(report.verdict, 'fail'); assert.equal(report.windows, null);
      assert.equal(report.code, 'KIT_FOLDER_WRITABLE'); assert.equal(report.reason, 'refused');
      assert.equal(report.fix.length, 3); assert.match(report.mismatches[0], /refused/);
      assert.doesNotMatch(JSON.stringify(report), /CLIXML|Preparing modules|HOST_CACHE_UNSAFE/);
    }
  }
});
test('unproved ACL replies fail closed without suggesting a folder lock', async t => {
  const h = kit(t), base = { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0' };
  for (const reply of [{ status: 65, stdout: '', stderr: 'untrusted detail' },
    ...['prefix HOST_CACHE_UNSAFE', 'HOST_CACHE_UNSAFE suffix', ' HOST_CACHE_UNSAFE ',
      '<Objs><S>HOST_CACHE_UNSAFE</S></Objs>'].map(stderr => ({ status: 65, stdout: '', stderr: '#< CLIXML\r\n' + stderr })),
    { status: 1, stdout: '', stderr: 'HOST_CACHE_UNSAFE' },
    { status: 65, stdout: '', stderr: 'HOST_CACHE_UNSAFE', reason: 'timeout' },
    { status: 65, stdout: '', stderr: '#< CLIXML\r\nHOST_CACHE_UNSAFE\r\n' + clixmlProgress, reason: 'timeout' },
    { status: null, stdout: '', reason: 'spawn-failed' },
    { ...ok({ ownerStarted: 'unknown' }), status: 1 }, { ...ok({ ownerStarted: 'unknown' }), reason: 'timeout' },
    { ...ok({ ownerStarted: 'unknown' }), reason: 'output-limit' }, { status: 0, stdout: 'invalid JSON' },
    ok({}), ok(null), undefined]) {
    let calls = 0;
    const report = await preflight(h, { ...base, execute: async () => { calls++; return reply; } });
    assert.equal(calls, 1); assert.equal(report.verdict, 'fail'); assert.equal(report.windows, null);
    assert.equal(report.code, 'KIT_FOLDER_WRITABLE'); assert.equal(report.reason, 'unproved');
    assert.match(report.mismatches[0], /unproved/); assert.equal(report.fix, undefined);
    assert.doesNotMatch(JSON.stringify(report), /untrusted detail|icacls/);
  }
});
test('ACL runner exceptions retain the folder code as unproved without repair commands or child detail', async t => {
  const h = kit(t); let calls = 0;
  const report = await preflight(h, { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0',
    execute: async () => { calls++; throw Error('spawn error, untrusted detail'); } });
  assert.equal(calls, 1); assert.equal(report.verdict, 'fail'); assert.equal(report.code, 'KIT_FOLDER_WRITABLE');
  assert.equal(report.reason, 'unproved'); assert.equal(report.fix, undefined);
  assert.doesNotMatch(JSON.stringify(report), /untrusted detail|icacls/);
});
test('both preflight scripts stay bound to their hashed bytes when the runner changes kit files', async t => {
  const h = kit(t), probe = join(h.root, 'bench/windows/guest-preflight.ps1');
  const original = readFileSync(probe, 'utf8'); let calls = 0;
  const report = await preflight(h, { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0',
    execute: async (_command, args) => {
      calls++;
      if (calls === 1) { writeFileSync(probe, 'throw "replaced"'); return ok({ ownerStarted: 'unknown' }); }
      assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), original);
      return ok(windows());
    } });
  assert.equal(report.verdict, 'pass'); assert.equal(calls, 2);
});
test('changed preflight or ACL script bytes start zero PowerShell children', async t => {
  for (const path of ['bench/windows/guest-preflight.ps1', 'plugins/sleight/lib/direct-browser/native/win/cache-access.ps1']) {
    const h = kit(t); writeFileSync(join(h.root, path), 'changed');
    await assert.rejects(preflight(h, { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0',
      execute: () => assert.fail('must not spawn') }), /hash mismatch/);
  }
});
test('platform, Node, architecture and kit mismatches start zero guest processes', async t => {
  const h = kit(t), base = { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0', execute: () => assert.fail('must not spawn') };
  for (const change of [{ platform: 'darwin' }, { arch: 'x64' }, { nodeVersion: '24.0.0' }, { nodeVersion: '25.0.1' }]) {
    assert.equal((await preflight(h, { ...base, ...change })).verdict, 'fail');
  }
  writeFileSync(join(h.root, 'source.mjs'), 'changed'); await assert.rejects(preflight(h, base), /hash mismatch/);
});
test('old build, Windows arch, missing UIA and malformed probe replies refuse', async t => {
  const h = kit(t), base = { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0' };
  for (const reply of [{ ...windows(), build: 19045 }, { ...windows(), architecture: 'AMD64' }, { ...windows(), uiaAvailable: false }, {}].map(ok)
    .concat([{ status: 1, stdout: '' }, { ...ok(windows()), reason: 'timeout' }])) {
    let calls = 0;
    const report = await preflight(h, { ...base, execute: async () => ++calls === 1 ? ok({ ownerStarted: 'unknown' }) : reply });
    assert.equal(report.verdict, 'fail'); assert.equal(report.code, undefined); assert.equal(calls, 2);
  }
});
test('preflight CLI retains failure reports and refuses output overwrites', async t => {
  const h = kit(t); mkdirSync(join(h.root, 'vm-results')); const output = join(h.root, 'vm-results', 'preflight.json');
  const args = ['--expected-commit', h.expectedCommit, '--expected-manifest-sha256', h.expectedManifestSha256, '--output', output];
  assert.equal(parsePreflightArgs(args).output, output); assert.throws(() => parsePreflightArgs(args.concat('--output', 'other')));
  assert.equal((await preflightMain(args, { root: h.root, platform: 'darwin' })).verdict, 'fail');
  assert.equal(JSON.parse(readFileSync(output)).verdict, 'fail'); await assert.rejects(preflightMain(args), /already exists/);
});
test('preflight CLI writes the ACL refusal, owner check and repair commands to its failure report', async t => {
  const h = kit(t); mkdirSync(join(h.root, 'vm-results')); const output = join(h.root, 'vm-results', 'acl-failure.json');
  const args = ['--expected-commit', h.expectedCommit, '--expected-manifest-sha256', h.expectedManifestSha256, '--output', output];
  let calls = 0;
  const report = await preflightMain(args, { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0',
    execute: async () => { calls++; return { status: 65, stdout: '', stderr: 'HOST_CACHE_UNSAFE' }; } });
  assert.equal(calls, 1); assert.equal(report.verdict, 'fail'); assert.equal(report.code, 'KIT_FOLDER_WRITABLE');
  const retained = JSON.parse(readFileSync(output));
  assert.deepEqual(retained.fix, report.fix); assert.equal(retained.fix.length, 3);
  assert.equal(retained.reason, 'refused');
  assert.equal(retained.code, 'KIT_FOLDER_WRITABLE'); assert.equal(retained.windows, null);
});
test('preflight CLI retains an unproved timeout without lock commands or child text', async t => {
  const h = kit(t); mkdirSync(join(h.root, 'vm-results')); const output = join(h.root, 'vm-results', 'acl-timeout.json');
  const args = ['--expected-commit', h.expectedCommit, '--expected-manifest-sha256', h.expectedManifestSha256, '--output', output];
  let calls = 0;
  const report = await preflightMain(args, { root: h.root, platform: 'win32', arch: 'arm64', nodeVersion: '25.0.0',
    execute: async () => { calls++; return { status: 65, reason: 'timeout', stdout: '', stderr: 'HOST_CACHE_UNSAFE\nuntrusted detail' }; } });
  const retained = JSON.parse(readFileSync(output));
  assert.equal(calls, 1); assert.equal(report.verdict, 'fail'); assert.deepEqual(retained, report);
  assert.equal(retained.reason, 'unproved'); assert.equal(retained.windows, null); assert.equal(retained.fix, undefined);
  assert.doesNotMatch(JSON.stringify(retained), /untrusted detail|HOST_CACHE_UNSAFE|icacls/);
});
test('build command copies the receipt-verified binary without launching it', async t => {
  const root = temp(t); mkdirSync(join(root, 'vm-results')); const source = join(root, 'built.exe'); writeFileSync(source, 'fake PE');
  const receipt = {}, options = { root, platform: 'win32', prepare: async () => ({ status: 'ready', receipt }), executable: value => { assert.equal(value, receipt); return source; } };
  const result = await buildHost('vm-results/consent-host.exe', options);
  assert.equal(result.launched, false); assert.equal(result.sha256, sha256(Buffer.from('fake PE')));
  await assert.rejects(buildHost('vm-results/consent-host.exe', options), /already exists/);
  await assert.rejects(buildHost('outside.exe', options), /Use vm-results/);
  await assert.rejects(buildHost('vm-results/consent-host.exe', { ...options, platform: 'darwin' }), /requires Windows/);
});
test('build refusal publishes no executable', async t => {
  const root = temp(t); mkdirSync(join(root, 'vm-results'));
  await assert.rejects(buildHost('vm-results/consent-host.exe', { root, platform: 'win32', prepare: async () => ({ status: 'unavailable', code: 'COMPILER_MISSING' }), executable: () => assert.fail() }), /COMPILER_MISSING/);
  assert.equal(existsSync(join(root, 'vm-results', 'consent-host.exe')), false);
});
test('integrated guest manifest selects nine existing files and excludes Mac-specific platform/JXA suites', () => {
  const root = fileURLToPath(new URL('../', import.meta.url)), manifest = JSON.parse(readFileSync(new URL('../bench/windows/check-manifest.json', import.meta.url)));
  const files = discoverSuites(root, manifest).flatMap(s => s.files);
  assert.equal(files.length, 9); assert.ok(!files.includes('tests/platform.test.mjs'));
  assert.ok(!files.includes('tests/direct-browser-electron-windows.test.mjs'));
});
test('every runbook Node entry is archived and has focused mock coverage', () => {
  const book = readFileSync(new URL('../bench/windows/vm-runbook.md', import.meta.url), 'utf8');
  const entries = [...new Set([...book.matchAll(/^node (bench\/windows\/[^\s]+\.mjs)/gm)].map(m => m[1]))];
  assert.deepEqual(entries.sort(), ['build-host', 'guest-preflight', 'probe-engine', 'run-checks'].map(name => 'bench/windows/' + name + '.mjs').sort());
  for (const entry of entries) {
    assert.ok(existsSync(new URL('../' + entry, import.meta.url)));
    assert.ok(EXPORT_PATHS.some(path => entry.startsWith(path + '/')));
  }
  for (const path of ['tests/windows-guest-export.test.mjs', 'tests/windows-vm-kit.test.mjs', 'tests/windows-driver-sitting.test.mjs']) assert.ok(existsSync(new URL('../' + path, import.meta.url)));
  assert.ok(book.includes('if ($LASTEXITCODE -ne 0)'));
});
