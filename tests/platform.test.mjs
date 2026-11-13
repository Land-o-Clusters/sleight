import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { getPlatform } from '../plugins/sleight/lib/platform/index.mjs';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';

test('platform selection uses the runtime by default and preserves Linux fixture behavior', () => {
  assert.equal(typeof getPlatform, 'function');
  assert.equal(getPlatform().id, process.platform === 'win32' ? 'win32' : 'darwin');
  for (const name of ['darwin', 'win32']) assert.equal(getPlatform(name).id, name);
  assert.equal(getPlatform('linux').id, 'darwin');
  for (const name of ['', null, 'windows']) assert.throws(() => getPlatform(name), { code: 'PLATFORM_UNSUPPORTED' });
});

test('darwin folders retain the existing home-based values and ignore environment redirection', () => {
  const home = posix.join('/', 'Users', 'person');
  assert.deepEqual(getPlatform('darwin').paths({ home, env: { HOME: '/wrong', APPDATA: 'C:\\wrong' } }), {
    settings: posix.join(home, 'Library/Application Support/sleight'),
    cache: posix.join(home, 'Library/Caches/sleight'),
    characters: posix.join(home, 'Library/Application Support/sleight/characters'),
    cursorRenderers: posix.join(home, 'Library/Application Support/sleight/cursor/renderers'),
    helperCache: posix.join(home, 'Library/Caches/sleight/turbo-host'),
  });
});

test('win32 authority settings, cache, characters and discovery use local AppData', () => {
  assert.deepEqual(getPlatform('win32').paths({ home: 'C:\\Users\\person', env: {
    APPDATA: 'D:\\Roaming Data', LOCALAPPDATA: 'E:\\Local Data', HOME: '/wrong',
  } }), {
    settings: 'E:\\Local Data\\sleight', cache: 'E:\\Local Data\\sleight',
    characters: 'E:\\Local Data\\sleight\\characters',
    cursorRenderers: 'E:\\Local Data\\sleight\\cursor\\renderers',
    helperCache: 'E:\\Local Data\\sleight\\turbo-host',
  });
});

test('win32 missing folder variables use the account home, including spaces and Unicode', () => {
  const paths = getPlatform('win32').paths({ home: 'C:\\Users\\José Smith', env: {} });
  assert.equal(paths.settings, 'C:\\Users\\José Smith\\AppData\\Local\\sleight');
  assert.equal(paths.cache, 'C:\\Users\\José Smith\\AppData\\Local\\sleight');
});

test('win32 refuses relative, device and malformed folder roots', () => {
  for (const root of ['', 'relative', 'C:relative', '\\relative', '\\\\?\\C:\\Data', 'C:\\bad\u0000path', 123]) {
    assert.throws(() => getPlatform('win32').paths({ home: 'C:\\Users\\person', env: { APPDATA: root } }), { code: 'PLATFORM_PATH_INVALID' });
    assert.throws(() => getPlatform('win32').paths({ home: 'C:\\Users\\person', env: { LOCALAPPDATA: root } }), { code: 'PLATFORM_PATH_INVALID' });
  }
});

test('win32 refuses UNC roots for private stores', () => {
  for (const key of ['APPDATA', 'LOCALAPPDATA']) {
    assert.throws(() => getPlatform('win32').paths({ home: 'C:\\Users\\person', env: { [key]: '\\\\server\\profiles\\person' } }), { code: 'PLATFORM_PATH_INVALID' });
  }
  assert.throws(() => getPlatform('win32').paths({ home: '\\\\server\\profiles\\person' }), { code: 'PLATFORM_PATH_INVALID' });
});

test('win32 helper environment retains required OS folders and strips command and loader overrides', () => {
  assert.deepEqual(getPlatform('win32').nativeHost.environment({ env: {
    SystemRoot: 'C:\\Windows', TEMP: 'C:\\Users\\person\\Local Temp', TMP: 'D:\\Temp',
    PATH: 'C:\\attacker', COMSPEC: 'C:\\attacker\\cmd.exe', NODE_OPTIONS: '--require=bad', SLEIGHT_HAND: '1',
  } }), { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows', TEMP: 'C:\\Users\\person\\Local Temp', TMP: 'D:\\Temp' });
  assert.deepEqual(getPlatform('win32').nativeHost.environment({ env: { SYSTEMROOT: 'D:\\Windows' } }),
    { SystemRoot: 'D:\\Windows', PATH: 'D:\\Windows\\System32;D:\\Windows' });
});

test('Windows explicit environment injections are case-insensitive and ambiguous keys refuse', () => {
  assert.equal(getPlatform('win32').paths({ home: 'C:\\Users\\person', env: { localappdata: 'D:\\Local' } }).settings, 'D:\\Local\\sleight');
  assert.deepEqual(getPlatform('win32').nativeHost.environment({ env: { sYsTeMrOoT: 'D:\\Windows', temp: 'D:\\Temp' } }),
    { SystemRoot: 'D:\\Windows', PATH: 'D:\\Windows\\System32;D:\\Windows', TEMP: 'D:\\Temp' });
  assert.throws(() => getPlatform('win32').nativeHost.environment({ env: { SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\evil' } }), { code: 'PLATFORM_PATH_INVALID' });
});

test('production roots ignore the inherited environment, including helper PATH', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { getPlatform } from './plugins/sleight/lib/platform/index.mjs';
    const paths = getPlatform('win32').paths({home: 'C:\\\\Users\\\\person'});
    assert.equal(paths.settings, 'C:\\\\Users\\\\person\\\\AppData\\\\Local\\\\sleight');
    try {
      const env = getPlatform('win32').nativeHost.environment();
      assert.equal(env.SystemRoot, 'C:\\\\Windows');
      assert.equal(env.PATH, 'C:\\\\Windows\\\\System32;C:\\\\Windows');
      assert.equal(env.TEMP, undefined);
    } catch (e) { if (!['ENOENT', 'PLATFORM_PATH_INVALID'].includes(e.code)) throw e; }
    console.log('ok');
  `;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env,
    APPDATA: 'Z:\\evil', LOCALAPPDATA: 'Z:\\evil', SystemRoot: 'Z:\\evil', SYSTEMROOT: 'Z:\\evil', TEMP: 'Z:\\evil', TMP: 'Z:\\evil' }, timeout: 60000, killSignal: 'SIGKILL' }).trim(), 'ok');
});

test('lightweight consumers never load the Mac host; lazy operations delegate only when invoked', () => {
  const loader = fileURLToPath(new URL('./fixtures/platform-no-mac-host-loader.mjs', import.meta.url));
  const source = `
    import assert from 'node:assert/strict';
    for (const module of ['hand/settings', 'hand/events', 'hand/client', 'person-gate']) await import('./plugins/sleight/lib/' + module + '.mjs');
    const { getPlatform } = await import('./plugins/sleight/lib/platform/index.mjs');
    const mac = getPlatform('darwin');
    assert.equal(mac.nativeHost.built({sourceRoot:'/missing-sleight-source'}), false);
    await assert.rejects(mac.nativeHost.prepare(), /MAC_HOST_LOADED/);
    await assert.rejects(mac.person.prepareConfirm(), /MAC_HOST_LOADED/);
    console.log('ok');
  `;
  assert.equal(execFileSync(process.execPath, ['--no-warnings', '--loader', loader, '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' }).trim(), 'ok');
});

test('darwin sink default uses the account renderer folder without filesystem access', async () => {
  const prior = process.env.SLEIGHT_CURSOR_STREAM_DIR; delete process.env.SLEIGHT_CURSOR_STREAM_DIR;
  let inspected;
  const sink = getPlatform('darwin').cursorSink.create({ defer: fn => fn(), inspect: async path => { inspected = path; throw Error('fixture'); } });
  try {
    sink.refresh(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(inspected, join(userInfo().homedir, 'Library/Application Support/sleight/cursor/renderers'));
  } finally { sink.close(); if (prior !== undefined) process.env.SLEIGHT_CURSOR_STREAM_DIR = prior; }
});

test('darwin helper lookup retains the account cache default', async () => {
  const { defaultHelperCache } = await import('../plugins/sleight/lib/direct-browser/host-cache.mjs');
  assert.equal(defaultHelperCache(), join(userInfo().homedir, 'Library/Caches/sleight/turbo-host'));
});

test('Windows recording guard recognizes local settings and refuses unimplemented held-handle writes', async () => {
  const { insideSettings, writeOutsideSettings } = await import('../plugins/sleight/lib/person-gate.mjs');
  const options = { home: 'C:\\Users\\person', platform: 'win32', real: path => path, stat: () => ({ nlink: 1 }) };
  assert.equal(insideSettings('c:\\users\\PERSON\\AppData\\Local\\sleight\\runs\\out.json', options), true);
  assert.equal(insideSettings('C:\\Users\\person\\AppData\\Local\\sleight-other\\out.json', options), false);
  assert.equal(insideSettings('C:\\Users\\person\\work\\out.json', { ...options, real: () => { throw Error('unreadable'); } }), true);
  assert.equal(insideSettings('C:\\Users\\person\\work\\out.json', { ...options, stat: () => ({ nlink: 2 }) }), true);
  assert.throws(() => writeOutsideSettings('C:\\work\\out.json', 'fixture', { platform: 'win32' }), { code: 'SETTINGS_OUT' });
});

test('win32 helper environment refuses missing or relative OS and temporary folders', () => {
  for (const env of [{}, { SystemRoot: 'Windows' }, { SystemRoot: 'C:\\Windows', TEMP: 'relative' }, { SystemRoot: 'C:\\Windows', TMP: 'D:relative' }]) {
    assert.throws(() => getPlatform('win32').nativeHost.environment({ env }), { code: 'PLATFORM_PATH_INVALID' });
  }
});

test('darwin host and person confirmation preserve the existing entry points', async () => {
  const host = await import('../plugins/sleight/lib/direct-browser/host.mjs');
  const mac = getPlatform('darwin');
  assert.equal(mac.nativeHost.built, host.handHostBuilt);
  assert.equal(typeof mac.nativeHost.prepare, 'function');
  assert.equal(mac.nativeHost.createFrameChannel, host.createUiChannel);
  assert.equal(typeof mac.person.prepareConfirm, 'function');
  assert.deepEqual(mac.nativeHost.environment(), { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' });
  assert.deepEqual(mac.nativeHost.environment({ env: { PATH: '/wrong', LANG: 'wrong' } }), host.environment());
});

test('darwin frame channel retains nonce authentication and one-use replies without a host', () => {
  const read = new PassThrough(), write = new PassThrough();
  let sent = '', answer;
  write.on('data', chunk => { sent += chunk; });
  const channel = getPlatform('darwin').nativeHost.createFrameChannel({ read, write });
  channel.present('request', {}, ['allow'], event => { answer = event; });
  const frame = JSON.parse(sent);
  assert.match(frame.nonce, /^[a-f0-9]{64}$/);
  read.write(JSON.stringify({ id: 'request', nonce: frame.nonce, choice: 'allow' }) + '\n');
  assert.equal(channel.authenticate(answer), true);
  assert.equal(channel.authenticate(answer), false);
  channel.close(); read.destroy(); write.destroy();
});

test('darwin person walk retains fail-closed results without reading live processes', () => {
  const walk = getPlatform('darwin').person.walkAncestors;
  assert.deepEqual(walk({ pid: 1, ps: () => { throw Error('must not run'); } }), { ok: false, reason: 'orphaned' });
  assert.deepEqual(walk({ pid: 200, ps: () => '??' }), { ok: false, reason: 'no tty' });
});

test('darwin private files and directories retain exact owner, type and mode checks', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'win1-private-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  chmodSync(dir, 0o700);
  const file = join(dir, 'hand.json'); writeFileSync(file, '{}', { mode: 0o600 });
  const permissions = getPlatform('darwin').filePermissions, uid = process.getuid();
  assert.equal(permissions.privateFile(file, { uid }).ok, true);
  assert.equal(permissions.privateDirectory(dir, { uid }).ok, true);
  assert.equal((await permissions.privateFileAsync(file, { uid })).ok, true);
  assert.equal((await permissions.privateDirectoryAsync(dir, { uid })).ok, true);
  assert.equal(permissions.privateFile(file, { uid: uid + 1 }).reason, 'another owner');
  assert.equal(permissions.privateFile(dir, { uid }).reason, 'wrong type');
  chmodSync(file, 0o644); assert.equal(permissions.privateFile(file, { uid }).reason, 'wrong mode');
  mkdirSync(join(dir, 'public'), { mode: 0o755 });
  assert.equal(permissions.privateDirectory(join(dir, 'public'), { uid }).ok, false);
  symlinkSync(file, join(dir, 'link'));
  assert.equal(permissions.privateFile(join(dir, 'link'), { uid }).reason, 'symlink');
});

test('win32 retains explicit missing-item errors for the drawing host and implements WIN5 person checks', () => {
  const win = getPlatform('win32');
  assert.equal(win.cursorSink.transport, 'named-pipe');
  for (const [operation, item] of [
    [win.nativeHost.built, 'WIN3'], [win.nativeHost.prepare, 'WIN3'], [win.nativeHost.createFrameChannel, 'WIN3'],
  ]) assert.throws(() => operation(), error => error.code === 'NOT_IMPLEMENTED' && error.item === item && error.message.includes(item));
  assert.equal(typeof win.person.walkAncestors, 'function');
  assert.equal(typeof win.person.prepareConfirm, 'function');
});

test('settings call sites use selected folders and refuse Windows mode bits as proof of privacy', async t => {
  const { handConfigPath, readHandConfig, handSetting } = await import('../plugins/sleight/lib/hand/settings.mjs');
  const home = 'C:\\Users\\person', options = { platform: 'win32', env: {} };
  assert.equal(handConfigPath(home, options), 'C:\\Users\\person\\AppData\\Local\\sleight\\hand.json');
  const dir = mkdtempSync(join(tmpdir(), 'win1-settings-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'hand.json'); writeFileSync(path, '{"version":1,"enabled":true}', { mode: 0o600 });
  assert.deepEqual(readHandConfig(path, process.getuid(), options), { state: 'unsafe' });
  assert.equal(handSetting({ platform: 'win32', path, env: { SLEIGHT_HAND: '1' }, read: () => ({ state: 'absent' }) }).enabled, true);
});

test('Windows person calls refuse and the cursor uses its platform sink before macOS commands can run', async () => {
  const { walkAncestors, settingsRefusal } = await import('../plugins/sleight/lib/person-gate.mjs');
  const { helperConfirm } = await import('../plugins/sleight/lib/person-confirm.mjs');
  const { createRendererSink } = await import('../plugins/sleight/lib/hand/events.mjs');
  assert.deepEqual(walkAncestors({ platform: 'win32', ps: () => { throw Error('Mac ps called'); } }), { ok: false, reason: 'check failed' });
  assert.match(settingsRefusal(['hand', 'on'], { platform: 'win32', stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} }), /Reason: check failed/);
  assert.equal(await helperConfirm({ key: 'turbo-on' }, { platform: 'win32' }), 'no helper');
  const sink = createRendererSink({ platform: 'win32', windows: { discover: async () => [] }, connect: () => { throw Error('Unix socket opened'); } });
  assert.equal(sink.stats().connected, 0); sink.close();
});

test('a Windows hand client fails closed without preparing a Mac host', async () => {
  const { createHandClient } = await import('../plugins/sleight/lib/hand/client.mjs');
  const traces = [];
  const client = createHandClient({ platform: 'win32', setting: () => ({ enabled: true }), permissions: null, usage: null,
    watch: () => undefined, trace: (kind, detail) => traces.push([kind, detail]) });
  try {
    client.send({ kind: 'click', pid: 42, windowId: 7, at: [10, 20] });
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.enabled, false);
    assert.ok(traces.some(([, detail]) => detail.code === 'NOT_IMPLEMENTED'));
  } finally { client.close(); }
});
