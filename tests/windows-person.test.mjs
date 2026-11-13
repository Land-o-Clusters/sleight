import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateWindowsAncestors, walkWindowsAncestors, windowsPresent, prepareWindowsPerson, prepareWindowsGate,
  windowsPersonPresence, prepareWindowsConfirmation } from '../plugins/sleight/lib/platform/win32-person.mjs';
import { settingsRefusalAsync } from '../plugins/sleight/lib/person-gate.mjs';
import { confirmationRefusal, confirmationLine, helperConfirm, highStakesChange } from '../plugins/sleight/lib/person-confirm.mjs';

const system = 'C:\\Windows\\System32', apps = 'C:\\Program Files\\WindowsApps';
const terminal = apps + '\\Microsoft.WindowsTerminal_1.22.1.0_x64__8wekyb3d8bbwe\\WindowsTerminal.exe';
const consolePath = system + '\\conhost.exe', shell = system + '\\WindowsPowerShell\\v1.0\\powershell.exe';
const birth = ms => String(134000000000000000n + BigInt(ms) * 10000n);
const row = (pid, parent, image, ms = 0) => ({ pid, parent, image, birth: birth(ms), after: birth(ms), session: 2, sid: 'S-1-5-21-11-22-33-1001' });
const fixture = () => ({ schema: 'sleight.person-snapshot/1', self: 500, session: 2, sid: 'S-1-5-21-11-22-33-1001',
  system32: system, programFiles: 'C:\\Program Files', now: birth(30000), console: { pid: 250, members: [300, 500] },
  rows: [row(500, 300, 'C:\\nodejs\\node.exe', 29000), row(300, 100, shell, 1000),
    row(100, 1, 'C:\\Windows\\explorer.exe'), row(250, 100, consolePath, 1100)] });
const check = (table, options) => evaluateWindowsAncestors(table, { self: 500, pid: 300, ...options });

test('System32 PowerShell and cmd pass with an independently bound console and Explorer', () => {
  for (const file of [shell, system + '\\cmd.exe', shell.toUpperCase()]) {
    const table = fixture(); table.rows[1].image = file;
    assert.deepEqual(check(table), { ok: true }, file);
  }
});
test('Windows Terminal ancestry and its sibling OpenConsole process pass by the full package path', () => {
  for (const arch of ['x64', 'x86', 'arm64']) {
    const table = fixture(); table.rows[1].parent = 200;
    const file = terminal.replace('_x64__', `_${arch}__`);
    table.rows.push(row(200, 100, file, 500));
    table.rows[3].image = file.replace('WindowsTerminal.exe', 'OpenConsole.exe');
    assert.deepEqual(check(table), { ok: true });
  }
});
test('ConPTY can prove a console sibling without a Windows Terminal ancestor; unknown hosts still refuse', () => {
  const table = fixture(); table.rows[3].image = terminal.replace('WindowsTerminal.exe', 'OpenConsole.exe');
  assert.deepEqual(check(table), { ok: true });
  table.rows[3].image = 'C:\\Tools\\OpenConsole.exe';
  assert.deepEqual(check(table), { ok: false, reason: 'session' });
});
test('Store PowerShell and the ACL-proved Program Files 7 installation pass', () => {
  const table = fixture();
  table.rows[1].image = apps + '\\Microsoft.PowerShell_7.5.0.0_arm64__8wekyb3d8bbwe\\pwsh.exe';
  assert.deepEqual(check(table), { ok: true });
  table.rows[1].image = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  assert.equal(check(table).ok, false);
  table.rows[1].adminWritableOnly = true;
  assert.deepEqual(check(table), { ok: true });
  for (const file of ['C:\\Tools\\pwsh.exe', 'C:\\Program Files\\PowerShell\\8\\pwsh.exe', 'C:\\Program Files-evil\\PowerShell\\7\\pwsh.exe']) {
    table.rows[1].image = file; assert.equal(check(table).ok, false);
  }
});
test('names and prefix collisions never substitute for the known executable path', () => {
  for (const file of ['C:\\Tools\\powershell.exe', 'C:\\Windows\\System32-evil\\cmd.exe',
    'C:\\Windows\\System32\\..\\Tools\\cmd.exe', '\\\\server\\System32\\cmd.exe',
    apps + '-evil\\Microsoft.WindowsTerminal_1.0_x64__8wekyb3d8bbwe\\WindowsTerminal.exe',
    terminal.replace('__8wekyb3d8bbwe', '__attacker'), terminal + '\\evil.exe']) {
    const table = fixture(); table.rows[1].image = file;
    assert.equal(check(table).ok, false, file);
  }
});
test('agents, editors, remote shells and multiplexers refuse in any ancestry position', () => {
  for (const file of ['C:\\Tools\\claude.exe', 'C:\\Tools\\codex.exe', 'C:\\Tools\\ChatGPT.exe',
    'C:\\VS Code\\Code.exe', 'C:\\Cursor\\Cursor.exe', 'C:\\Tools\\tmux.exe', 'C:\\Tools\\zellij.exe',
    'C:\\Tools\\wsl.exe', 'C:\\Tools\\ConEmu64.exe', 'C:\\Tools\\sshd.exe', 'C:\\Tools\\Warp.exe',
    'C:\\Tools\\node.exe', 'C:\\Tools\\python.exe']) {
    for (const aboveTerminal of [false, true]) {
      const table = fixture(); table.rows[1].parent = 200;
      if (aboveTerminal) { table.rows.push(row(200, 150, terminal, 500), row(150, 100, file, 100)); }
      else table.rows.push(row(200, 100, file, 500));
      assert.equal(check(table).ok, false, file);
    }
  }
});
test('a terminal launched through a shell above it refuses', () => {
  const table = fixture(); table.rows[1].parent = 200;
  table.rows.push(row(200, 150, terminal, 500), row(150, 100, shell, 100));
  assert.deepEqual(check(table), { ok: false, reason: 'unknown ancestor' });
});
test('PID reuse, changed births, dead rows, cycles and duplicate PIDs refuse', () => {
  const mutations = [t => { t.rows[1].birth = t.rows[1].after = birth(29999); },
    t => { t.rows[1].after = birth(2000); }, t => { t.rows[1].birth = t.rows[1].after = 134000000000000000; },
    t => { t.rows[1].parent = 500; }, t => { t.rows.push({ ...t.rows[1] }); }, t => { t.rows.splice(1, 1); },
    t => { t.rows[0].parent = 999; }, t => { t.rows[1].birth = t.rows[1].after = birth(31000); }];
  for (const mutate of mutations) { const table = fixture(); mutate(table); assert.equal(check(table).ok, false); }
});
test('every row, including console siblings, must have this user and this session', () => {
  for (let i = 0; i < 4; i++) for (const [key, value] of [['sid', 'S-1-5-21-1-2-3-999'], ['session', 3]]) {
    const table = fixture(); table.rows[i][key] = value; assert.equal(check(table).ok, false);
  }
});
test('console membership must bind the launcher and its parent with a bounded unique list', () => {
  for (const members of [[], [500], [300], [500, 300, 300], ['500', 300], Array.from({ length: 257 }, (_, i) => i + 1)]) {
    const table = fixture(); table.console.members = members; assert.equal(check(table).ok, false);
  }
  const table = fixture(); table.console.pid = 999; assert.equal(check(table).ok, false);
});
test('fresh session bar uses the outer shell, with exact boundary and the same exemption', () => {
  const table = fixture(); table.now = birth(30000);
  table.rows[1].birth = table.rows[1].after = birth(20001);
  assert.deepEqual(check(table), { ok: false, reason: 'fresh session' });
  assert.deepEqual(check(table, { freshMs: 0 }), { ok: true });
  table.rows[1].birth = table.rows[1].after = birth(20000);
  assert.deepEqual(check(table), { ok: true });
});
test('bounded walks and malformed native data fail closed', () => {
  assert.deepEqual(check(fixture(), { levels: 1 }), { ok: false, reason: 'too deep' });
  for (const table of [null, {}, { ...fixture(), now: 0 }, { ...fixture(), schema: 'new/2' }, { ...fixture(), system32: 'relative' }]) assert.equal(check(table).ok, false);
  for (const options of [{ freshMs: NaN }, { levels: 0 }, { levels: 1000 }, { self: -1 }, { pid: 0 }]) assert.equal(check(fixture(), options).ok, false);
});
test('walk enforces a total elapsed budget and native failures refuse', () => {
  let time = 0;
  const options = { self: 500, pid: 300, now: () => time, budgetMs: 100,
    snapshot: (pid, budget) => { assert.deepEqual([pid, budget], [500, 100]); time += 101; return fixture(); } };
  assert.deepEqual(walkWindowsAncestors(options), { ok: false, reason: 'timeout' });
  assert.deepEqual(walkWindowsAncestors({ self: 500, pid: 300, snapshot: () => fixture() }), { ok: true });
  assert.deepEqual(walkWindowsAncestors({ snapshot: () => { throw Object.assign(Error(), { code: 'ETIMEDOUT' }); } }), { ok: false, reason: 'timeout' });
  assert.equal(walkWindowsAncestors({ snapshot: () => { throw Error(); } }).ok, false);
});
const present = overrides => ({ schema: 'sleight.person-presence/1', active: true, unlocked: true, idleMs: 1, ...overrides });
test('presence requires an unlocked active WTS session and less than 120 seconds idle', () => {
  assert.equal(windowsPresent(present({ idleMs: 119999 })), true);
  for (const value of [undefined, {}, present({ idleMs: 120000 }), present({ idleMs: -1 }), present({ idleMs: NaN }),
    present({ idleMs: 2 ** 32 - 1 }), present({ active: false }), present({ unlocked: false }), present({ unlocked: null })]) assert.equal(windowsPresent(value), false);
});
test('Windows confirmation refuses false and unknown presence without asking', async () => {
  for (const presence of [async () => false, async () => undefined, async () => { throw Error(); }]) {
    let asks = 0;
    const line = await confirmationRefusal(['turbo', 'on'], { platform: 'win32', presence, confirm: () => { asks++; return 'ok'; } });
    assert.equal(asks, 0); assert.match(line, /Windows Hello.*locked, idle/); assert.doesNotMatch(line, /Mac|Touch ID/);
  }
});
test('the common high-stakes list and removal exemptions apply on Windows', async () => {
  const low = [['turbo', 'off'], ['turbo', 'app', 'off', 'com.example.App'], ['permissions', 'block', 'com.example.App'],
    ['permissions', 'revoke', 'all'], ['permissions', 'memory', 'clear', 'all'], ['allow', 'remove', 'com.example.App'],
    ['routine', 'remove', 'r1'], ['routine', '--remove', 'r1'], ['watch', 'remove', 'w1'], ['hand', 'on'], ['cursor', 'style', 'ring']];
  for (const args of low) {
    assert.equal(highStakesChange(args), undefined);
    assert.equal(await confirmationRefusal(args, { platform: 'win32', confirm: () => { throw Error('asked'); } }), undefined);
  }
  for (const args of [['turbo', 'on'], ['permissions', 'sites'], ['permissions', 'unblock', 'com.example.App'],
    ['routine', 'add'], ['routine', 'unlock'], ['watch', 'record'], ['watch', 'unlock'], ['turbo', 'new-writer']]) {
    let asks = 0;
    assert.equal(await confirmationRefusal(args, { platform: 'win32', presence: async () => true, confirm: () => { asks++; return 'ok'; } }), undefined);
    assert.equal(asks, 1);
  }
});
test('Windows notices, result failures and deadlines use Windows Hello wording', async () => {
  const notices = [];
  for (const code of ['failed', 'cancelled', 'timeout', 'unavailable', 'invalid', 'unverified', 'away', 'no helper']) {
    const line = await confirmationRefusal(['turbo', 'on'], { platform: 'win32', presence: async () => true,
      notice: value => notices.push(value), confirm: () => code });
    assert.equal(line, confirmationLine('turbo on', code, 'win32')); assert.doesNotMatch(line, /Touch ID|Apple|Mac/);
  }
  assert.ok(notices.every(value => value.includes('Windows Hello in the Windows dialog')));
  const line = await confirmationRefusal(['turbo', 'on'], { platform: 'win32', presence: async () => true,
    confirm: (_, options) => { options.ready(); return new Promise(() => {}); }, timeoutMs: 5, graceMs: 0 });
  assert.equal(line, confirmationLine('turbo on', 'timeout', 'win32'));
});
test('an abandoned Windows build never spawns a prompt', async () => {
  let spawned = 0;
  const result = await helperConfirm({ key: 'turbo-on' }, { platform: 'win32', abandoned: () => true,
    prepare: async () => ({ status: 'ready', spawn: () => { spawned++; } }) });
  assert.equal(result, 'no helper'); assert.equal(spawned, 0);
});
test('native away result and identity mismatch cannot grant', async () => {
  const prepare = (code, report) => async () => ({ status: 'ready', spawn: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.sleightExpected = { path: 'fixed', sha256: 'hash' };
    setImmediate(() => { child.stdout.write(JSON.stringify(report ?? child.sleightExpected) + '\n'); child.emit('close', code); });
    return child;
  } });
  assert.equal(await helperConfirm({ key: 'settings' }, { platform: 'win32', prepare: prepare(4) }), 'away');
  assert.equal(await helperConfirm({ key: 'settings' }, { platform: 'win32', prepare: prepare(0, { path: 'other', sha256: 'hash' }) }), 'unverified');
  for (const [code, expected] of [[0, 'ok'], [1, 'failed'], [2, 'cancelled'], [3, 'timeout'], [64, 'invalid'], [69, 'unavailable'], [null, 'failed']])
    assert.equal(await helperConfirm({ key: 'settings' }, { platform: 'win32', prepare: prepare(code) }), expected);
});
test('async gate preserves TTY, agent marker and macOS short circuits without a Windows build', async () => {
  let builds = 0;
  const prepare = async () => { builds++; return { status: 'unavailable' }; };
  const base = { platform: 'win32', stdin: { isTTY: true }, stdout: { isTTY: true }, env: {}, prepare };
  assert.equal(await settingsRefusalAsync(['turbo', 'status'], base), undefined);
  assert.match(await settingsRefusalAsync(['turbo', 'on'], { ...base, stdin: {} }), /no terminal/);
  assert.match(await settingsRefusalAsync(['turbo', 'on'], { ...base, env: { CLAUDECODE: '1' } }), /agent/);
  assert.equal(builds, 0);
  assert.equal(await settingsRefusalAsync(['hand', 'on'], { ...base, platform: 'darwin', ancestors: () => ({ ok: true }) }), undefined);
  assert.equal(builds, 0);
  assert.match(await settingsRefusalAsync(['turbo', 'on'], base), /check failed/); assert.equal(builds, 1);
});
test('one launcher builds and copies once for snapshot, presence and confirmation', async () => {
  let copies = 0, cleanups = 0, builds = 0, verifications = 0;
  const calls = [], children = [];
  const prepare = async options => {
    builds++; assert.equal(options.kind, 'person'); assert.equal(options.cacheRoot, 'C:\\fixture\\cache');
    return { status: 'ready', personCopy: () => ({ path: 'C:\\fixture\\run\\person-host.exe', sha256: 'hash', verify: () => verifications++, cleanup: () => { cleanups++; }, id: ++copies }) };
  };
  const sync = (file, args, options) => { calls.push([file, args, options]); return JSON.stringify(args[0] === '--person-presence' ? present() : fixture()); };
  const run = (file, args, options) => {
    assert.equal(verifications, 3);
    calls.push([file, args, options]); const child = new EventEmitter(); child.stdout = new PassThrough();
    child.kill = signal => { child.signal = signal; }; children.push(child); return child;
  };
  const options = { platform: 'win32', cacheRoot: 'C:\\fixture\\cache', prepare, sync, run };
  const host = await prepareWindowsGate(options);
  assert.equal(windowsPersonPresence instanceof Function, true);
  assert.equal(await windowsPersonPresence(), true);
  assert.deepEqual(host.snapshot(500, 99), fixture());
  const child = host.spawn('turbo-on', 'Google Chrome');
  assert.deepEqual(child.sleightExpected, { path: calls[2][0], sha256: 'hash' });
  assert.deepEqual(calls[2][1], ['--confirm-person', 'turbo-on', 'Google Chrome']);
  for (const [, , options] of calls) {
    assert.deepEqual(options.env, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' }); assert.equal(options.windowsHide, true);
  }
  assert.equal(calls[1][2].timeout, 99);
  child.emit('close', 2); child.emit('error', Error());
  assert.equal(await prepareWindowsConfirmation(), host);
  assert.equal(builds, 1); assert.equal(copies, 1); assert.equal(cleanups, 1);
  assert.throws(() => host.spawn('settings'), /ALREADY_ATTEMPTED/);
});
test('build, copy and spawn errors refuse without falling through to macOS', async () => {
  assert.equal((await prepareWindowsPerson({ platform: 'darwin', prepare: () => { throw Error('called'); } })).code, 'PLATFORM');
  assert.equal((await prepareWindowsPerson({ platform: 'win32', cacheRoot: 'C:\\cache', prepare: () => { throw Error(); } })).status, 'unavailable');
  let cleanup = 0;
  const host = await prepareWindowsPerson({ platform: 'win32', cacheRoot: 'C:\\cache',
    prepare: async () => ({ status: 'ready', personCopy: () => ({ path: 'C:\\cache\\run.exe', verify() {}, cleanup: () => cleanup++ }) }),
    run: () => { throw Error('spawn failed'); }, sync: () => { throw Error('sync failed'); } });
  assert.throws(() => host.spawn('settings'), /spawn failed/); assert.throws(() => host.snapshot(500, 10), /CLOSED/);
  assert.equal(cleanup, 1);
});
test('native reason table matches the Mac fixed strings and browser names', () => {
  const swift = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const cs = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/PersonHello.cs', import.meta.url), 'utf8');
  const reasons = [...swift.matchAll(/"([a-z-]+)": \("([^"]+)", (?:"([^"]+)"|nil)\)/g)];
  assert.equal(reasons.filter(([, key]) => key === 'owner-present-sitting').length, 1);
  const entries = reasons.filter(([, key]) => key !== 'owner-present-sitting');
  assert.equal(entries.length, 15);
  for (const [, key, plain, subject] of entries) {
    assert.ok(cs.includes(`{ "${key}", new[] { "${plain}"`));
    if (subject) assert.ok(cs.includes(subject.replace('%@', '{0}')));
  }
  const names = /let personConfirmBrowsers[^=]*= \[([\s\S]*?)\]/.exec(swift)[1].match(/"[^"]+"/g).map(JSON.parse);
  for (const name of names) assert.ok(cs.includes(`"${name}"`));
});
test('WinRT generic operation IID derives from the documented signature', () => {
  const namespace = Buffer.from('11f47ad57b7342c0abae878b1e16adee', 'hex');
  const signature = 'pinterface({9fc2b0bb-e446-44e2-aa61-9cab8f636af2};enum(Windows.Security.Credentials.UI.UserConsentVerificationResult;i4))';
  const bytes = createHash('sha1').update(namespace).update(signature).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex'), iid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  assert.equal(iid, 'fd596ffd-2318-558f-9dbe-d21df43764a5');
  assert.ok(readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/PersonHello.cs', import.meta.url), 'utf8').includes(iid));
});

test('System32 DCOM boundary passes only directly above a verified Windows Terminal', () => {
  const table = fixture(); table.rows[1].parent = 200;
  table.rows[2] = { ...row(100, 1, system + '\\svchost.exe'), session: 0, sid: 'S-1-5-18' };
  table.rows.push(row(200, 100, terminal, 500));
  assert.deepEqual(check(table), { ok: true });
  for (const mutate of [t => { t.rows[1].parent = 100; }, t => { t.rows[2].image = 'C:\\Tools\\svchost.exe'; },
    t => { t.rows[2].sid = t.sid; }, t => { t.rows[2].session = 2; },
    t => { t.rows[2].birth = t.rows[2].after = birth(501); }, t => { t.rows[4].image = 'C:\\Tools\\WindowsTerminal.exe'; }]) {
    const changed = structuredClone(table); mutate(changed); assert.equal(check(changed).ok, false);
  }
});
test('only the exact session-zero DCOM boundary may lack a readable token', () => {
  const table = fixture(); table.rows[1].parent = 200;
  table.rows[2] = { ...row(100, 1, system + '\\svchost.exe'), session: 0, sid: null };
  table.rows.push(row(200, 100, terminal, 500));
  assert.deepEqual(check(table), { ok: true });
  for (const mutate of [t => { t.rows[1].parent = 100; }, t => { t.rows[2].image = 'C:\\Tools\\svchost.exe'; },
    t => { t.rows[2].session = 2; }, t => { t.rows[2].birth = t.rows[2].after = birth(501); },
    t => { t.rows[4].image = 'C:\\Tools\\WindowsTerminal.exe'; }, t => { t.rows[1].sid = null; },
    t => { t.rows[3].sid = null; }, t => { delete t.rows[2].sid; },
    t => { t.rows.push({ ...row(900, 1, system + '\\svchost.exe'), sid: null, session: 0 }); }]) {
    const changed = structuredClone(table); mutate(changed); assert.equal(check(changed).ok, false);
  }
});
test('access removal runs the Windows ancestor walk with no session-age wait', async () => {
  const walked = [];
  const base = { platform: 'win32', stdin: { isTTY: true }, stdout: { isTTY: true }, env: {},
    prepare: () => assert.fail('injected walk needs no helper'), ancestors: options => { walked.push(options); return { ok: true }; } };
  for (const args of [['hand', 'off'], ['turbo', 'off'], ['turbo', 'app', 'off', 'com.example.App'], ['permissions', 'block', 'com.example.App'], ['permissions', 'revoke', 'all']]) {
    assert.equal(await settingsRefusalAsync(args, base), undefined);
    assert.deepEqual(walked.at(-1), { freshMs: 0 });
    assert.match(await settingsRefusalAsync(args, { ...base, ancestors: () => ({ ok: false, reason: 'agent' }) }), /agent/);
    const count = walked.length;
    assert.match(await settingsRefusalAsync(args, { ...base, stdin: {} }), /no terminal/);
    assert.match(await settingsRefusalAsync(args, { ...base, env: { CLAUDECODE: '1' } }), /agent/);
    assert.equal(walked.length, count);
  }
  assert.equal(walked.length, 5);
});
test('a live confirmation is stopped on launcher interruption and cleans the shared copy on close', async () => {
  let cleanups = 0;
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = signal => { child.signal = signal; };
  const host = await prepareWindowsPerson({ platform: 'win32', cacheRoot: 'C:\\fixture', run: () => child,
    prepare: async () => ({ status: 'ready', personCopy: () => ({ path: 'C:\\fixture\\run.exe', verify() {}, cleanup: () => cleanups++ }) }) });
  host.spawn('settings'); process.emit('SIGINT'); assert.equal(child.signal, 'SIGTERM');
  child.emit('close', null); assert.equal(cleanups, 1);
});

test('Windows helper deadline sends one termination and a late password success never grants', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); let stopped = 0;
  child.sleightExpected = { path: 'fixture', sha256: 'hash' }; child.kill = () => { stopped++; };
  const pending = helperConfirm({ key: 'settings' }, { platform: 'win32', timeoutMs: 1,
    prepare: async () => ({ status: 'ready', spawn: () => child }) });
  setImmediate(() => child.stdout.write(JSON.stringify(child.sleightExpected) + '\n'));
  assert.equal(await pending, 'timeout'); assert.equal(stopped, 1);
  child.emit('close', 0); assert.equal(stopped, 1);
});
test('availability operation has the independently derived WinRT enum IID', () => {
  const namespace = Buffer.from('11f47ad57b7342c0abae878b1e16adee', 'hex');
  const signature = 'pinterface({9fc2b0bb-e446-44e2-aa61-9cab8f636af2};enum(Windows.Security.Credentials.UI.UserConsentVerifierAvailability;i4))';
  const bytes = createHash('sha1').update(namespace).update(signature).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex'), iid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  assert.ok(readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/PersonHello.cs', import.meta.url), 'utf8').includes(iid));
});


test('five exact removal forms report the terminal fallback only for a missing compiler', async () => {
  const { settingsRefusalAsync } = await import('../plugins/sleight/lib/person-gate.mjs');
  let prepared = 0; const notices = [];
  const options = { platform: 'win32', stdin: { isTTY: true }, stdout: { isTTY: true }, env: {},
    stderr: { write: text => notices.push(text) },
    prepare: async () => { prepared++; return { status: 'unavailable', code: 'WINDOWS_COMPILER_MISSING' }; } };
  const removals = [['hand', 'off'], ['turbo', 'off'], ['turbo', 'app', 'off', 'com.example.App'],
    ['permissions', 'block', 'com.example.App'], ['permissions', 'revoke', 'all']];
  for (const args of removals) {
    assert.equal(await settingsRefusalAsync(args, options), undefined);
    assert.equal(notices.length, prepared);
    assert.equal(notices.at(-1), "sleight: could not verify the terminal's ancestry; this form only removes access, so it ran on the terminal and agent-marker checks.\n");
    const count = prepared;
    for (const streams of [{ stdin: {} }, { stdout: {} }])
      assert.match(await settingsRefusalAsync(args, { ...options, ...streams }), /no terminal/);
    for (const env of [{ CLAUDECODE: '1' }, { CLAUDE_CODE_ENTRYPOINT: 'cli' }])
      assert.match(await settingsRefusalAsync(args, { ...options, env }), /agent/);
    assert.equal(prepared, count, 'terminal and marker refusals happen before preparation');
  }
  assert.equal(prepared, 5);
  for (const args of [['hand', 'on'], ['turbo', 'on'], ['permissions', 'unblock', 'com.example.App'],
    ['hand', 'off', 'extra'], ['turbo', 'app', 'off'], ['permissions', 'revoke']])
    assert.match(await settingsRefusalAsync(args, options), /check failed/);
  assert.match(await settingsRefusalAsync(['hand', 'off'], { ...options, prepare: async () => ({ status: 'ready' }) }), /check failed/,
    'an available helper with an unreadable walk does not use the fallback');
  assert.equal(notices.length, 5, 'only successful fallbacks emit one line each');
});
test('removal fails closed on tamper, unknown and thrown helper failures without a fallback notice', async () => {
  const options = { platform: 'win32', stdin: { isTTY: true }, stdout: { isTTY: true }, env: {},
    stderr: { write: () => assert.fail('refused calls must not report a fallback') } };
  for (const args of [['hand', 'off'], ['turbo', 'off'], ['turbo', 'app', 'off', 'com.example.App'],
    ['permissions', 'block', 'com.example.App'], ['permissions', 'revoke', 'all']]) {
    for (const code of ['HOST_CACHE_UNSAFE', 'HOST_COMPILER_UNSAFE', 'HOST_PACKAGE_MISMATCH', 'HOST_SOURCE_MISMATCH',
      'DISTRIBUTION_ACCEPTANCE_REQUIRED', 'NATIVE_HELPERS_UNAVAILABLE', 'PERSON_HELPER_UNAVAILABLE', 'HOST_BUILD_BUSY', undefined])
      assert.match(await settingsRefusalAsync(args, { ...options, prepare: async () => ({ status: 'unavailable', code }) }), /check failed/, code);
    assert.match(await settingsRefusalAsync(args, { ...options, prepare: async () => { throw Error('HOST_PACKAGE_MISMATCH'); } }), /check failed/);
  }
});
