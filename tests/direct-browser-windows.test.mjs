import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowsTurboDiscovery as createDiscovery, mapWindowsDiscovery, parseWindowsAppPath, parseWindowsProcesses, windowsBrowserDefinitions, windowsProcessProfile } from '../plugins/sleight/lib/direct-browser/windows-platform.mjs';
import { discoverSelected } from '../plugins/sleight/lib/direct-browser/discovery.mjs';

const createWindowsTurboDiscovery = options => createDiscovery({ filePermissions: { privateFile: () => ({ ok: true }) }, ...options });
const env = { LOCALAPPDATA: 'C:\\Users\\Lane\\AppData\\Local', ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)', 'ProgramFiles(Arm)': 'C:\\Program Files (Arm)',
  SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', PSModulePath: 'D:\\Untrusted' };
const chrome = () => windowsBrowserDefinitions({ env })[0];
const stat = { dev: 1n, ino: 3n, size: 40n, mtimeMs: 200n, ctimeMs: 150n, mtimeNs: 200000000n, ctimeNs: 150000000n,
  isFile: () => true, isSymbolicLink: () => false };
const scriptFrom = call => Buffer.from(call[1].at(-1), 'base64').toString('utf16le');

test('registry and process discovery emit private UTF-8 bytes without changing the console code page', async () => {
  const calls = [];
  const discovery = createWindowsTurboDiscovery({ platform: 'win32', env,
    run: async (...args) => { calls.push(args); return { stdout: calls.length === 1 ?
      JSON.stringify({ chrome: [], edge: [], brave: [] }) : JSON.stringify({ currentSid: 'S-1-5-21-1', currentSession: 1, processes: [] }) }; },
    fs: { lstatSync() { throw Error('not installed'); } } });
  await discovery.browsers(); await discovery.processes(chrome());
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const script = scriptFrom(call);
    assert.doesNotMatch(script, /\[Console\]::(?:OutputEncoding|WriteLine)|SetConsoleOutputCP/);
    assert.match(script, /\[Console\]::OpenStandardOutput\(\)/);
    assert.match(script, /UTF8Encoding\(\$false\)/);
    assert.match(script, /\$output\.Write\(\$bytes, 0, \$bytes\.Length\)/);
    assert.match(script, /\$output\.Flush\(\)/);
  }
});

test('Windows table has user profiles, local and machine installs, and no qualified browser', () => {
  const rows = windowsBrowserDefinitions({ env });
  assert.deepEqual(rows.map(b => b.id), ['chrome', 'edge', 'brave']);
  assert.deepEqual(rows.map(b => b.profileRoot), [
    'C:\\Users\\Lane\\AppData\\Local\\Google\\Chrome\\User Data',
    'C:\\Users\\Lane\\AppData\\Local\\Microsoft\\Edge\\User Data',
    'C:\\Users\\Lane\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data',
  ]);
  assert.deepEqual(rows[0].candidates, [
    'C:\\Users\\Lane\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (Arm)\\Google\\Chrome\\Application\\chrome.exe',
  ].map(path => ({ path, source: 'standard' })));
  assert.ok(rows.every(b => b.qualified === false && b.platform === 'win32' && b.bundleId === undefined));
  assert.equal(rows[1].image, 'msedge.exe'); assert.equal(rows[2].image, 'brave.exe');
  assert.equal(rows[1].inspectURL, 'edge://inspect/#remote-debugging');
});

test('Windows paths never fall back to macOS folders or a relative directory', () => {
  assert.equal(windowsBrowserDefinitions({ env: {} }).length, 0);
  const fallback = windowsBrowserDefinitions({ env: { USERPROFILE: 'D:\\Users\\Other' } });
  assert.equal(fallback[0].profileRoot, 'D:\\Users\\Other\\AppData\\Local\\Google\\Chrome\\User Data');
  assert.equal(fallback[0].candidates.length, 1);
  assert.equal(windowsBrowserDefinitions({ env: { LOCALAPPDATA: 'relative' } }).length, 0);
});

test('App Paths accepts only an exact local executable, with bounded environment expansion', () => {
  assert.equal(parseWindowsAppPath('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"', 'chrome.exe', env),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(parseWindowsAppPath('%localappdata%\\Google\\Chrome\\Application\\CHROME.EXE', 'chrome.exe', env),
    'C:\\Users\\Lane\\AppData\\Local\\Google\\Chrome\\Application\\CHROME.EXE');
  for (const path of ['chrome.exe', 'C:chrome.exe', '\\\\server\\share\\chrome.exe', '\\\\?\\C:\\chrome.exe',
    'C:\\x\\..\\chrome.exe', 'C:\\x\\chrome.exe --flag', '"C:\\x\\chrome.exe" --flag',
    'C:\\x\\edge.exe', '%UNKNOWN%\\chrome.exe', 'C:\\x\\chrome.exe:stream', 'C:\\x.\\chrome.exe', 'C:\\x\\chrome.exe\n'])
    assert.equal(parseWindowsAppPath(path, 'chrome.exe', env), undefined, path);
});

test('platform guard performs zero Windows reads or commands on macOS', () => {
  const boom = () => assert.fail('must not inspect host');
  assert.equal(createWindowsTurboDiscovery({ platform: 'darwin', env, run: boom, fs: new Proxy({}, { get: boom }) }), undefined);
});

test('standard paths precede tagged registry hints and missing or linked executables do not count as installed', async () => {
  const calls = [], reads = [];
  const standard = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const discovery = createWindowsTurboDiscovery({ platform: 'win32', env,
    run: async (...args) => { calls.push(args); return { stdout: JSON.stringify({ chrome: ['D:\\Apps\\chrome.exe', 'D:\\Linked\\chrome.exe'], edge: [], brave: [] }) }; },
    fs: { lstatSync(path) { reads.push(path); if ([standard, 'D:\\Apps\\chrome.exe'].includes(path)) return stat;
      if (path === 'D:\\Linked\\chrome.exe') return { ...stat, isSymbolicLink: () => true };
      throw Object.assign(Error(), { code: 'ENOENT' }); }, realpathSync: path => path } });
  const rows = await discovery.browsers();
  assert.equal(rows[0].executable, standard); assert.equal(rows[0].installed, true);
  assert.equal(rows[0].executableSource, 'standard'); assert.equal(rows[0].registry, 'available');
  assert.deepEqual(rows[0].candidates.at(-2), { path: 'D:\\Apps\\chrome.exe', source: 'registry', location: 'unverified-location' });
  assert.deepEqual(rows[0].executables, [standard, 'D:\\Apps\\chrome.exe']);
  assert.equal(rows[0].qualified, false); assert.equal(rows[1].installed, false);
  assert.equal(rows[1].executable, undefined);
  assert.ok(reads.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(calls[0][1].slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.deepEqual(calls[0][2].env, { SystemRoot: env.SystemRoot, windir: env.windir, TEMP: env.TEMP, TMP: env.TMP });
  assert.equal(calls[0][2].windowsHide, true); assert.equal(calls[0][2].shell, false);
  assert.ok(calls[0][2].timeout <= 5000 && calls[0][2].maxBuffer <= 262144);
});

test('registry failure or malformed output degrades to standard paths with an unavailable marker', async () => {
  const standard = chrome().candidates[0].path;
  const fs = { lstatSync(path) { if (path === standard) return stat; throw Error('missing'); }, realpathSync: path => path };
  for (const stdout of ['', 'not-json', '[]', '{}', JSON.stringify({ chrome: 'x', edge: [], brave: [] })]) {
    const d = createWindowsTurboDiscovery({ platform: 'win32', env, fs, run: async () => ({ stdout }) });
    const rows = await d.browsers();
    assert.equal(rows[0].executable, standard); assert.ok(rows.every(row => row.registry === 'unavailable'));
    assert.ok(rows.flatMap(row => row.candidates).every(candidate => candidate.source === 'standard'));
  }
  const d = createWindowsTurboDiscovery({ platform: 'win32', env, fs, run: async () => { throw Error('denied'); } });
  assert.equal((await d.browsers())[0].executable, standard);
  assert.equal((await d.browsers())[0].registry, 'unavailable');
});

test('all three standard installs can be discovered when App Paths is empty', async () => {
  const installed = new Set(['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\Lane\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe']);
  const d = createWindowsTurboDiscovery({ platform: 'win32', env,
    run: async () => ({ stdout: JSON.stringify({ chrome: [], edge: [], brave: [] }) }),
    fs: { lstatSync(path) { if (installed.has(path)) return stat; throw Error('missing'); }, realpathSync: path => path } });
  assert.deepEqual((await d.browsers()).map(row => row.executable), [...installed]);
});

test('BOM and non-ASCII App Paths survive JSON decoding and environment values never become script text', async () => {
  const executable = 'D:\\Aplicações\\chrome.exe', calls = [];
  const d = createWindowsTurboDiscovery({ platform: 'win32', env,
    run: async (...args) => { calls.push(args); return { stdout: '\uFEFF' + JSON.stringify({ chrome: [executable], edge: [], brave: [] }) }; },
    fs: { lstatSync(path) { if (path === executable) return stat; throw Error('missing'); }, realpathSync: path => path } });
  assert.equal((await d.browsers())[0].executable, executable);
  assert.equal(scriptFrom(calls[0]).includes(executable), false);
  assert.equal(scriptFrom(calls[0]).includes(env.PSModulePath), false);
  assert.equal((await d.browsers())[0].executableLocation, 'unverified-location');
});

test('invalid SystemRoot and absent local profile roots never fall back to PATH lookup', async () => {
  const boom = async () => assert.fail('must not start an unbound executable');
  for (const patch of [{ SystemRoot: 'relative' }, { windir: undefined }, { windir: 'D:\\Windows' }]) {
    const noSystem = createWindowsTurboDiscovery({ platform: 'win32', env: { ...env, ...patch }, run: boom,
      fs: { lstatSync() { throw Error('missing'); } } });
    assert.ok((await noSystem.browsers()).every(row => row.registry === 'unavailable' && row.installed === false));
    await assert.rejects(noSystem.processes(chrome()), /WINDOWS_PROCESS_UNPROVED/);
  }
  assert.deepEqual(await createWindowsTurboDiscovery({ platform: 'win32', env: {}, run: boom }).browsers(), []);
});

const processRow = extra => ({ pid: 42, application: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ownerSid: 'S-1-5-21-100', sessionId: 2, start: 1793016000000, main: true,
  commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"', ...extra });
const processText = rows => JSON.stringify({ currentSid: 'S-1-5-21-100', currentSession: 2, processes: rows });

test('CIM observations retain only this user and session, exact image path, and browser main process', () => {
  const rows = parseWindowsProcesses(processText([processRow(), processRow({ pid: 43, ownerSid: 'S-1-5-21-200' }),
    processRow({ pid: 44, sessionId: 3 }), processRow({ pid: 45, main: false }),
    processRow({ pid: 46, application: 'D:\\Impostor\\chrome.exe' })]), chrome());
  assert.deepEqual(rows, [{ pid: 42, application: processRow().application, ownerSid: 'S-1-5-21-100', sessionId: 2,
    start: 1793016000000, profileRoot: chrome().profileRoot, profileSource: 'default', authenticated: false }]);
  assert.equal(parseWindowsProcesses(processText([processRow({ application: processRow().application.toUpperCase() })]), chrome()).length, 1);
  assert.equal(parseWindowsProcesses(processText([processRow(), processRow({ pid: 47 })]), chrome()).length, 2, 'ambiguity must remain visible');
});

test('CIM parser refuses malformed identities, times, duplicate pids and oversized observations', () => {
  for (const patch of [{ pid: 0 }, { pid: 1.5 }, { pid: 2147483648 }, { start: 0 }, { start: '2026-10-26' },
    { application: null }, { application: 'chrome.exe' }, { main: null }])
    assert.throws(() => parseWindowsProcesses(processText([processRow(patch)]), chrome()), /WINDOWS_PROCESS_UNPROVED/);
  for (const text of ['', '[]', JSON.stringify({ currentSid: null, currentSession: 2, processes: [] }),
    processText([processRow(), processRow()]), ' '.repeat(262145)])
    assert.throws(() => parseWindowsProcesses(text, chrome()), /WINDOWS_PROCESS_UNPROVED/);
});

test('other sessions and child rows need no owner lookup, but a same-session main row needs an owner', () => {
  const inaccessible = { pid: 43, sessionId: 3, ownerSid: null, application: null, commandLine: null };
  const child = { pid: 44, sessionId: 2, main: false, ownerSid: null };
  assert.deepEqual(parseWindowsProcesses(processText([inaccessible, child, processRow()]), chrome()).map(row => row.pid), [42]);
  assert.throws(() => parseWindowsProcesses(processText([processRow({ ownerSid: null })]), chrome()), /WINDOWS_PROCESS_UNPROVED/);
});

test('custom profile switches follow Windows quoting and stay out of returned command text', () => {
  const root = 'D:\\Browser Profiles\\Work', executable = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
  for (const suffix of [` --user-data-dir="${root}"`, ` "--user-data-dir=${root}"`, ` --user-data-dir "${root}"`]) {
    assert.deepEqual(windowsProcessProfile(executable + suffix, chrome().profileRoot), { profileRoot: root, profileSource: 'command-line' });
    const rows = parseWindowsProcesses(processText([processRow({ commandLine: executable + suffix + ' https://private.invalid/' })]), chrome());
    assert.equal(rows[0].profileRoot, root); assert.equal(rows[0].commandLine, undefined);
    assert.equal(JSON.stringify(rows).includes('private.invalid'), false);
  }
  assert.equal(windowsProcessProfile(executable + ' -- --user-data-dir=D:\\Ignored', chrome().profileRoot).profileSource, 'default');
  for (const suffix of [' --user-data-dir=', ' --user-data-dir relative', ' --user-data-dir=\\\\server\\share',
    ' --user-data-dir=C:\\x\\..\\y', ' --user-data-dir=C:\\a --user-data-dir=C:\\b',
    ' --user-data-dir="D:\\unterminated', ' --user-data-dir="D:\\quote\\\"inside"', ' --user-data-dir'])
    assert.throws(() => windowsProcessProfile(executable + suffix, chrome().profileRoot), /WINDOWS_PROCESS_UNPROVED/, suffix);
});

test('registry candidates under standard roots rank before outside hints, with duplicate standard paths removed', async () => {
  const standard = chrome().candidates[1].path, inside = 'C:\\Program Files\\Alternate\\chrome.exe', outside = 'D:\\Downloads\\chrome.exe';
  const d = createWindowsTurboDiscovery({ platform: 'win32', env,
    run: async () => ({ stdout: JSON.stringify({ chrome: [outside, inside, standard.toUpperCase()], edge: [], brave: [] }) }),
    fs: { lstatSync: () => stat, realpathSync: path => path } });
  const row = (await d.browsers())[0];
  assert.deepEqual(row.candidates.slice(-2), [{ path: inside, source: 'registry', location: 'standard' },
    { path: outside, source: 'registry', location: 'unverified-location' }]);
  assert.equal(row.candidates.filter(candidate => candidate.path.toLowerCase() === standard.toLowerCase()).length, 1);
  assert.equal(row.candidates[1].source, 'standard');
});

test('process adapter uses a bounded hidden CIM query and propagates uncertainty', async () => {
  const calls = [];
  const d = createWindowsTurboDiscovery({ platform: 'win32', env, run: async (...args) => { calls.push(args); return { stdout: processText([processRow()]) }; } });
  assert.equal((await d.processes(chrome()))[0].pid, 42);
  assert.equal(calls.length, 1); assert.equal(calls[0][2].windowsHide, true);
  const script = scriptFrom(calls[0]), loop = script.slice(script.indexOf('foreach ($p in $items)'));
  assert.ok(loop.indexOf('$p.SessionId -ne $session') < loop.indexOf('$p.CommandLine -match'));
  assert.ok(loop.indexOf('$p.CommandLine -match') < loop.indexOf('Invoke-CimMethod'));
  assert.match(loop, /main = \$true/);
  const broken = createWindowsTurboDiscovery({ platform: 'win32', env, run: async () => { throw Error('timeout'); } });
  await assert.rejects(broken.processes(chrome()), /WINDOWS_PROCESS_UNPROVED/);
});

function fileFixture(text = '9222\r\n/devtools/browser/fixture\r\n', extra = {}) {
  const bytes = Buffer.from(text), closed = [], opened = [], s = { ...stat, size: BigInt(bytes.length) };
  const path = 'C:\\Users\\Lane\\AppData\\Local\\Google\\Chrome\\User Data\\DevToolsActivePort';
  return { path, closed, opened, fs: { lstatSync(p, options) { assert.deepEqual(options, { bigint: true }); return s; }, realpathSync: p => p,
    openSync(p) { opened.push(p); return 7; }, fstatSync(fd, options) { assert.deepEqual(options, { bigint: true }); return s; },
    readSync(fd, target) { bytes.copy(target); return bytes.length; }, closeSync: fd => closed.push(fd), ...extra } };
}
const observed = extra => ({ ...parseWindowsProcesses(processText([processRow()]), chrome())[0], start: 100, ...extra });

test('DevToolsActivePort reads CRLF through one descriptor and returns only an unauthenticated hint', () => {
  const f = fileFixture(), d = createWindowsTurboDiscovery({ platform: 'win32', env, fs: f.fs });
  assert.deepEqual(d.activePort(chrome(), observed()), { port: 9222, path: '/devtools/browser/fixture',
    file: f.path, canonicalPath: f.path, text: '9222\r\n/devtools/browser/fixture\r\n', mtime: 200,
    pid: 42, start: 100, application: processRow().application, profileRoot: chrome().profileRoot, authenticated: false });
  assert.deepEqual(f.opened, [f.path]); assert.deepEqual(f.closed, [7]);
});

test('DevToolsActivePort refuses stale, huge, linked, redirected, changed and partial files', () => {
  const variants = [
    { lstatSync: () => ({ ...stat, mtimeMs: 99n }) },
    { lstatSync: () => ({ ...stat, size: 513n }) },
    { lstatSync: () => ({ ...stat, isSymbolicLink: () => true }) },
    { realpathSync: () => 'D:\\Other\\DevToolsActivePort' },
    { fstatSync: () => ({ ...stat, ino: 999n }) },
    { readSync: () => 1 },
  ];
  for (const extra of variants) {
    const f = fileFixture(undefined, extra), d = createWindowsTurboDiscovery({ platform: 'win32', env, fs: f.fs });
    assert.throws(() => d.activePort(chrome(), observed()), /WINDOWS_ENDPOINT_UNPROVED/);
    assert.equal(f.closed.length, f.opened.length);
  }
  for (const text of ['9222', '65536\n/devtools/browser/x', '9222\n/devtools/browser/../x', '9222\n/devtools/browser/x\nextra']) {
    const f = fileFixture(text), d = createWindowsTurboDiscovery({ platform: 'win32', env, fs: f.fs });
    assert.throws(() => d.activePort(chrome(), observed()), /WINDOWS_ENDPOINT_UNPROVED/);
    assert.deepEqual(f.closed, [7]);
  }
});

test('DevToolsActivePort validates process birth before reading and closes on a post-read file change', () => {
  const f = fileFixture(), d = createWindowsTurboDiscovery({ platform: 'win32', env, fs: f.fs });
  for (const start of [undefined, 0, NaN, '100']) assert.throws(() => d.activePort(chrome(), observed({ start })), /WINDOWS_ENDPOINT_UNPROVED/);
  for (const patch of [{ pid: undefined }, { pid: 0 }, { profileRoot: 'relative' }, { application: 'D:\\Other\\chrome.exe' }])
    assert.throws(() => d.activePort(chrome(), observed(patch)), /WINDOWS_ENDPOINT_UNPROVED/);
  assert.deepEqual(f.opened, []);
  let reads = 0;
  const changed = fileFixture();
  // Only the second identity observation changes.
  const size = BigInt(Buffer.byteLength('9222\r\n/devtools/browser/fixture\r\n'));
  changed.fs.fstatSync = () => ({ ...stat, size, ino: ++reads === 1 ? 3n : 4n });
  const adapter = createWindowsTurboDiscovery({ platform: 'win32', env, fs: changed.fs });
  assert.throws(() => adapter.activePort(chrome(), observed()), /WINDOWS_ENDPOINT_UNPROVED/);
  assert.deepEqual(changed.closed, [7]);
});

test('file identity retains distinct 64-bit IDs that collapse to the same Number', () => {
  const a = 9007199254740992n, b = a + 1n, bytes = BigInt(Buffer.byteLength('9222\r\n/devtools/browser/fixture\r\n'));
  assert.equal(Number(a), Number(b));
  const f = fileFixture(undefined, { lstatSync: () => ({ ...stat, size: bytes, ino: a }),
    fstatSync: () => ({ ...stat, size: bytes, ino: b }) });
  const d = createWindowsTurboDiscovery({ platform: 'win32', env, fs: f.fs });
  assert.throws(() => d.activePort(chrome(), observed()), /WINDOWS_ENDPOINT_UNPROVED/);
  assert.deepEqual(f.closed, [7]);
});

test('custom profile file and process map into discoverSelected without connection authority', () => {
  const selected = observed({ profileRoot: 'D:\\Profiles\\Work', profileSource: 'command-line' }), processes = [selected];
  const f = fileFixture(), d = createWindowsTurboDiscovery({ platform: 'win32', env, fs: f.fs });
  const hint = d.activePort(chrome(), selected);
  assert.equal(f.opened[0], 'D:\\Profiles\\Work\\DevToolsActivePort');
  const mapped = mapWindowsDiscovery({ selected, processes, hint });
  assert.equal(mapped.processes[0].alive, true); assert.equal(mapped.selected.root, selected.profileRoot);
  assert.equal(mapped.file.text, hint.text); assert.equal(mapped.file.path, hint.file);
  assert.equal(mapped.file.canonicalPath, hint.file);
  assert.deepEqual(discoverSelected({ ...mapped, setting: true, supported: true }), { state: 'disconnected', reason: 'hint-is-not-liveness' });
  assert.deepEqual(discoverSelected(mapped), { state: 'stale-instance', reason: 'selected-identity-unproved' });
  const connection = { state: 'connected', redirected: false, endpoint: 'ws://127.0.0.1:9222/devtools/browser/fixture' };
  assert.deepEqual(discoverSelected({ ...mapped, setting: true, supported: true, connection }),
    { state: 'stale-instance', reason: 'connection-identity-unproved' });
  for (const patch of [{ pid: 43 }, { start: 101 }, { application: 'D:\\Other\\chrome.exe' },
    { profileRoot: chrome().profileRoot }, { canonicalPath: 'D:\\Other\\DevToolsActivePort' }])
    assert.throws(() => mapWindowsDiscovery({ selected, processes, hint: { ...hint, ...patch } }), /WINDOWS_ENDPOINT_UNPROVED/);
  assert.throws(() => mapWindowsDiscovery({ selected, processes: [], hint }), /WINDOWS_ENDPOINT_UNPROVED/);
});

test('one unproved custom profile does not hide the other browser observations', () => {
  const rows = parseWindowsProcesses(processText([processRow({ pid: 41, commandLine: 'chrome.exe --user-data-dir=relative' }), processRow()]), chrome());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].profileSource, 'unproved'); assert.equal(rows[0].profileRoot, undefined);
  assert.equal(rows[1].profileRoot, chrome().profileRoot);
});

test('Windows path casing is ignored across hint mapping and selected discovery', () => {
  const selected = observed(), f = fileFixture();
  const d = createWindowsTurboDiscovery({ platform: 'win32', env, fs: f.fs, filePermissions: { privateFile: () => ({ ok: true }) } });
  const hint = d.activePort(chrome(), selected);
  hint.application = hint.application.toUpperCase(); hint.profileRoot = hint.profileRoot.toUpperCase(); hint.file = hint.file.toUpperCase();
  const mapped = mapWindowsDiscovery({ selected, processes: [selected], hint });
  mapped.canonicalRoot = mapped.canonicalRoot.toUpperCase(); mapped.processes[0].application = mapped.processes[0].application.toUpperCase();
  assert.deepEqual(discoverSelected({ ...mapped, setting: true, supported: true }), { state: 'disconnected', reason: 'hint-is-not-liveness' });
});

test('active-port permission refusal occurs before opening the endpoint file', () => {
  const f = fileFixture(); let inspected;
  const d = createWindowsTurboDiscovery({ platform: 'win32', env, fs: f.fs,
    filePermissions: { privateFile: path => { inspected = path; return { ok: false }; } } });
  assert.throws(() => d.activePort(chrome(), observed()), /WINDOWS_ENDPOINT_UNPROVED/);
  assert.equal(inspected, f.path); assert.deepEqual(f.opened, []);
});

test('production browser roots use the account home instead of inherited LOCALAPPDATA', () => {
  const rows = windowsBrowserDefinitions({ home: 'D:\\Users\\Account' });
  assert.equal(rows[0].profileRoot, 'D:\\Users\\Account\\AppData\\Local\\Google\\Chrome\\User Data');
});

test('registry App Paths under account LOCALAPPDATA are standard location hints', async () => {
  const inside = env.LOCALAPPDATA + '\\Alternate\\chrome.exe';
  const d = createWindowsTurboDiscovery({ platform: 'win32', env,
    run: async () => ({ stdout: JSON.stringify({ chrome: [inside], edge: [], brave: [] }) }),
    fs: { lstatSync: () => stat, realpathSync: p => p } });
  const rows = await d.browsers();
  assert.deepEqual(rows[0].candidates.at(-1), { path: inside, source: 'registry', location: 'standard' });
});
