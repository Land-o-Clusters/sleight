import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { join } from 'node:path';
import { win32 } from 'node:path';
import { createWindowsSettingsStore, windowsFileOperation } from '../plugins/sleight/lib/platform/win32-files.mjs';

function fixture() {
  const data = new Map(), calls = [];
  const operate = request => {
    calls.push(request.operation + ':' + request.path);
    if (request.operation === 'inspect') return { ok: true };
    if (request.operation === 'write') { data.set(request.path, request.text); return { ok: true, text: request.text }; }
    return data.has(request.path) ? { ok: true, text: data.get(request.path) } : { ok: true, absent: true };
  };
  const adapter = { join: win32.join, paths: () => ({ settings: 'C:\\Users\\Person\\AppData\\Local\\sleight' }) };
  return { data, calls, adapter, operate, store: createWindowsSettingsStore({ adapter, operate }) };
}
test('approval revocation never bootstraps an absent Windows settings root through Node', t => {
  const bank = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-win-lock-')))), root = join(bank, 'absent');
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const store = createWindowsSettingsStore({ adapter: { join, paths: () => ({ settings: root }) },
    operate: () => assert.fail('an absent store has no ACL or grants to read') });
  assert.equal(store.withPreapprovedLock(({ absent }) => absent), true);
  assert.equal(existsSync(root), false);
});
test('Windows writes use account paths, native ACL proof and exact native readback', () => {
  const f = fixture(); f.store.write('hand.json', { version: 1, enabled: true });
  assert.deepEqual(f.calls.map(c => c.split(':')[0]), ['write']);
  assert.ok(f.calls.every(c => c.endsWith('C:\\Users\\Person\\AppData\\Local\\sleight\\hand.json')));
  assert.deepEqual(f.store.read('hand.json'), { version: 1, enabled: true });
  assert.equal(f.calls.at(-1).split(':')[0], 'read');
});
test('absent Windows settings read as absent without POSIX permission fallback', () => {
  const f = fixture(); assert.equal(f.store.read('hand.json'), undefined); assert.equal(f.calls.length, 1);
});
test('Windows ACL failures and wrong readback refuse the store', () => {
  const f = fixture(); f.store.write('hand.json', { version: 1, enabled: false });
  assert.throws(() => createWindowsSettingsStore({ adapter: f.adapter, operate: () => { throw Error('WINDOWS_FILE_UNSAFE'); } }).read('hand.json'), /WINDOWS_FILE_UNSAFE/);
  assert.throws(() => createWindowsSettingsStore({ adapter: f.adapter, operate: () => ({ ok: true, text: 'changed' }) }).write('hand.json', {}), /WINDOWS_SETTING_READBACK/);
});
test('settings names and payload sizes are bounded before native work', () => {
  const f = fixture();
  for (const name of ['../hand.json', 'grant-seal.key', 'C:\\other', 'HAND.JSON']) assert.throws(() => f.store.write(name, {}), /WINDOWS_SETTING_INVALID/);
  assert.throws(() => f.store.write('hand.json', 'x'.repeat(262144)), /TOO_LARGE/); assert.deepEqual(f.calls, []);
});
test('fixed Windows file helper receives request data only on stdin with a clean environment', () => {
  const request = { operation: 'inspect', path: 'C:\\folder with spaces\\name.json', kind: 'file' };
  let observed;
  const result = windowsFileOperation(request, { platform: 'win32', environment: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' },
    run: (file, args, options) => { observed = { file, args, options }; return '{"ok":true}'; } });
  assert.equal(result.ok, true); assert.equal(observed.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(observed.options.input, JSON.stringify(request));
  assert.equal(observed.options.env.NODE_OPTIONS, undefined);
  assert.equal(observed.args.includes(request.path), false);
  assert.ok(observed.args.at(-1).length < 30000);
  assert.throws(() => windowsFileOperation(request, { platform: 'darwin' }), /WINDOWS_ONLY/);
});
test('native settings source holds parents, rejects reparse/hardlinks and protects ACLs at creation', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/platform/win32-files.ps1', import.meta.url), 'utf8');
  for (const contract of ['GetSecurityInfo', 'GetFileInformationByHandle', 'GetFinalPathNameByHandle', 'info.Links == 1', 'AreAccessRulesProtected', 'AreAccessRulesCanonical', 'SetAccessRuleProtection(true, false)', 'FileMode.CreateNew', 'File.Replace', 'file.Flush(true)', 'Parents(root)', 'h.Dispose()', 'SpecialFolder]::LocalApplicationData']) assert.ok(source.includes(contract), contract);
  assert.match(source, /CreateFile\(p, access, 3,/);
  assert.match(source, /new FileStream\(handle, FileAccess.Read\)/);
  assert.doesNotMatch(source, /new FileStream\(path, FileMode.Open/);
  assert.match(source, /i\.Attributes & 0x400/);
  assert.doesNotMatch(source, /Invoke-Expression|Start-Process|SendInput|SetForegroundWindow/);
});
test('Windows settings helper compiles and validates paths without reading or writing settings', { skip: process.platform !== 'win32' && 'Windows .NET Framework only' }, () => {
  assert.deepEqual(windowsFileOperation({ operation: 'selftest' }), { ok: true, checks: 13 });
});

test('hot Windows settings reads reuse one native worker and recheck unsafe replies', async () => {
  const { createWindowsFileWorker } = await import('../plugins/sleight/lib/platform/win32-files.mjs');
  const { createWindowsHandSettingReader } = await import('../plugins/sleight/lib/windows-hand-settings.mjs');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  let spawns = 0, requests = 0, now = 0, safe = true;
  const worker = createWindowsFileWorker({ platform: 'win32', environment: { SystemRoot: 'C:\\Windows' }, run: () => {
    spawns++;
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.stdin.on('data', bytes => {
      const request = JSON.parse(bytes); requests++;
      child.stdout.write(JSON.stringify({ id: request.id, ok: safe,
        text: JSON.stringify({ version: 1, enabled: true, stream: true, style: 'ring' }) }) + '\n');
    });
    child.stdin.on('finish', () => { child.emit('close', 0); });
    child.kill = () => assert.fail('worker exits on EOF');
    queueMicrotask(() => child.stdout.write('{"ready":true}\n')); return child;
  } });
  const reader = createWindowsHandSettingReader({ worker, env: {}, now: () => now, path: 'C:\\Users\\Menéndez\\AppData\\Local\\sleight\\hand.json' });
  try {
    await reader.ready(); assert.equal(reader().stream, true);
    for (let i = 0; i < 10; i++) { now += 250; reader(); await reader.ready(); assert.equal(reader().enabled, true); }
    assert.equal(spawns, 1); assert.equal(requests, 11);
    safe = false; now += 250; reader(); await reader.ready();
    assert.equal(reader().enabled, false); assert.equal(reader().reason, 'unsafe');
  } finally { await reader.close(); }
});


test('Windows requests explicitly decode UTF-8 for non-ASCII account paths', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/platform/win32-files.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\[Console\]::(?:Input|Output)Encoding\s*=/);
  assert.match(source, /OpenStandardInput\(\)/);
  assert.match(source, /OpenStandardOutput\(\)/);
  const request = { operation: 'read', path: 'C:\\Users\\Menéndez 日本\\AppData\\Local\\sleight\\hand.json' };
  windowsFileOperation(request, { platform: 'win32', environment: { SystemRoot: 'C:\\Windows' },
    run: (_file, _args, options) => { assert.deepEqual(JSON.parse(Buffer.from(options.input, 'utf8').toString('utf8')), request); return '{"ok":true,"absent":true}'; } });
});

test('ACL bootstrap hash refuses changed source before any native spawn', async () => {
  const { createWindowsFileWorker } = await import('../plugins/sleight/lib/platform/win32-files.mjs');
  const bytes = readFileSync(new URL('../plugins/sleight/lib/platform/win32-files.ps1', import.meta.url));
  const drift = Buffer.from(bytes); drift[0] ^= 1;
  const options = { platform: 'win32', environment: { SystemRoot: 'C:\\Windows' }, read: () => drift,
    run: () => assert.fail('changed checker must not execute') };
  assert.throws(() => windowsFileOperation({ operation: 'inspect' }, options), /hash mismatch/);
  const worker = createWindowsFileWorker(options);
  await assert.rejects(worker.operate({ operation: 'read' }), /hash mismatch/); await worker.close();
});

for (const scenario of ['startup', 'malformed', 'timeout']) test(`native settings worker ${scenario} failure rejects and collects its child`, async () => {
  const { createWindowsFileWorker } = await import('../plugins/sleight/lib/platform/win32-files.mjs');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  let kills = 0, spawns = 0;
  const worker = createWindowsFileWorker({ platform: 'win32', environment: { SystemRoot: 'C:\\Windows' }, startupMs: 20, timeoutMs: 20,
    run: () => {
      spawns++; const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
      child.kill = () => { kills++; child.emit('close', 1); };
      child.stdin.on('data', () => { if (scenario === 'malformed') child.stdout.write('broken\n'); });
      if (scenario !== 'startup') queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
      return child;
    } });
  await assert.rejects(worker.operate({ operation: 'read', path: 'C:\\fixture' }), /WINDOWS_FILE_/);
  await worker.close(); assert.equal(kills, 1); assert.equal(spawns, 1);
  await assert.rejects(worker.operate({ operation: 'read', path: 'C:\\fixture' })); assert.equal(spawns, 1);
});

test('a native exit-65 refusal becomes the unsafe-file result used by CLI recovery', () => {
  assert.throws(() => windowsFileOperation({ operation: 'read', path: 'C:\\fixture' }, {
    platform: 'win32', environment: { SystemRoot: 'C:\\Windows' },
    run: () => { throw Object.assign(Error('native exited'), { status: 65, stdout: '{"ok":false}' }); },
  }), /WINDOWS_FILE_UNSAFE/);
});

test('settings creation uses the current Windows strict ACL principals', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/platform/win32-files.ps1', import.meta.url), 'utf8');
  const acl = source.slice(source.indexOf('static FileSecurity FileAcl()'), source.indexOf('public static void Inspect'));
  assert.doesNotMatch(acl, /S-1-5-32-544/);
  assert.match(acl, /User, "S-1-5-18"/);
  assert.match(source, /Allowed\(rule.SecurityIdentifier.Value, parent, sharedRoot\)/);
});

test('malformed private JSON gets the settings error used by file-specific recovery', () => {
  const f = fixture();
  const store = createWindowsSettingsStore({ adapter: f.adapter, operate: () => ({ ok: true, text: '{broken' }) });
  assert.throws(() => store.read('hand.json'), /WINDOWS_SETTING_INVALID/);
});


test('closing idle survives a two-second gap without any settings reads', async t => {
  const { createWindowsHandSettingReader } = await import('../plugins/sleight/lib/windows-hand-settings.mjs');
  const { createCursorEvents } = await import('../plugins/sleight/lib/hand/events.mjs');
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0, reads = 0, stalled = false, cancel;
  const reader = createWindowsHandSettingReader({ now: () => now, path: 'C:\\fixture\\hand.json', env: {}, worker: {
    operate: async () => { reads++; if (stalled) return new Promise(resolve => { cancel = () => resolve({ ok: false }); });
      return { ok: true, text: '{"version":1,"enabled":true,"stream":true}' }; }, close: async () => { cancel?.(); },
  } });
  const events = [];
  const cursor = createCursorEvents({ platform: 'win32', setting: reader,
    repeat: () => ({ unref() {} }), cancelRepeat() {}, sink: { write: event => events.push(event), close() {} } });
  await reader.ready(); cursor.status('thinking');
  for (let i = 0; i < 8; i++) { now += 250; t.mock.timers.tick(250); await new Promise(setImmediate); }
  cursor.status('idle');
  assert.deepEqual(events.filter(e => e.type === 'status').map(e => e.state), ['thinking', 'idle']);
  assert.ok(reads >= 9, 'refreshes happen during the gap without a caller');
  stalled = true;
  for (let i = 0; i < 5; i++) { now += 250; t.mock.timers.tick(250); await new Promise(setImmediate); }
  assert.equal(reader().enabled, false, 'a stalled worker expires within about one second');
  cursor.close();
  await reader.close();
  const stoppedAt = reads;
  now += 2000; t.mock.timers.tick(2000); await new Promise(setImmediate);
  assert.equal(reads, stoppedAt, 'closing cancels background polling');
});


test('shared settings root accepts the host builder principals while leaf files stay strict', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/platform/win32-files.ps1', import.meta.url), 'utf8');
  const host = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/cache-access.ps1', import.meta.url), 'utf8');
  const hostPrincipals = /\$trusted = @\(\$user.Value, ([^\n]+)\)/.exec(host)[1];
  assert.equal(hostPrincipals, "'S-1-5-18', 'S-1-5-32-544'");
  assert.match(source, /Allowed\(string sid, bool parent, bool sharedRoot\)/);
  assert.match(source, /\(parent \|\| sharedRoot\) \? Trusted\(sid\) : Private\(sid\)/);
  assert.match(source, /directory && p.Equals\(Path.Combine\(Environment.GetFolderPath\(Environment.SpecialFolder.LocalApplicationData\), "sleight"\), StringComparison.OrdinalIgnoreCase\)/);
  assert.match(source, /foreach \(string sid in new string\[\] \{User, "S-1-5-18", "S-1-5-32-544"\}\)/);
});

test('ACL command retains at least ten thousand characters of Windows command-line headroom', () => {
  let command;
  windowsFileOperation({ operation: 'selftest' }, { platform: 'win32', environment: { SystemRoot: 'C:\\Windows' },
    run: (file, args) => { command = [file, ...args].join(' '); return '{"ok":true}'; } });
  assert.ok(command.length < 22767, String(command.length));
});

test('Node discovery uses byte streams without changing a shared console code page', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/windows-node.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\[Console\]::(?:Input|Output)Encoding\s*=/);
  assert.match(source, /OpenStandardInput\(\)/); assert.match(source, /OpenStandardOutput\(\)/);
});


test('compressed bootstrap round-trips the exact pinned native source in both modes', async () => {
  const { gunzipSync } = await import('node:zlib');
  const { createWindowsFileWorker } = await import('../plugins/sleight/lib/platform/win32-files.mjs');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const source = readFileSync(new URL('../plugins/sleight/lib/platform/win32-files.ps1', import.meta.url), 'utf8');
  const decode = args => {
    const bootstrap = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const payload = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(bootstrap)[1];
    assert.ok(args.at(-1).length < 22000);
    return gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
  };
  windowsFileOperation({ operation: 'selftest' }, { platform: 'win32', environment: { SystemRoot: 'C:\\Windows' },
    run: (_file, args) => { assert.equal(decode(args), source); return '{"ok":true}'; } });
  const worker = createWindowsFileWorker({ platform: 'win32', environment: { SystemRoot: 'C:\\Windows' }, run: (_file, args) => {
    assert.equal(decode(args), '$sleightWorker = $true\n' + source);
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.stdin.on('data', bytes => child.stdout.write(JSON.stringify({ id: JSON.parse(bytes).id, ok: true }) + '\n'));
    child.stdin.on('finish', () => child.emit('close', 0));
    queueMicrotask(() => child.stdout.write('{"ready":true}\n')); return child;
  } });
  await worker.operate({ operation: 'selftest' }); await worker.close();
});
