import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

for (const platform of ['darwin', 'win32']) test(`${platform} stores retain platform paths without inherited redirection`, () => {
  const source = `
    import assert from 'node:assert/strict';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import { posix, win32 } from 'node:path';
    const platform = ${JSON.stringify(platform)};
    const home = platform === 'win32' ? 'C:\\\\Users\\\\person' : posix.join('/', 'Users', 'person');
    os.userInfo = () => ({ homedir: home }); syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { value: platform });
    const path = platform === 'win32' ? win32 : posix;
    const settings = path.join(home, platform === 'win32' ? 'AppData/Local/sleight' : 'Library/Application Support/sleight');
    const cache = path.join(home, platform === 'win32' ? 'AppData/Local/sleight' : 'Library/Caches/sleight');
    const lib = './plugins/sleight/lib/';
    const preapproved = await import(lib + 'preapproved.mjs');
    const permissions = await import(lib + 'permissions.mjs');
    const installed = await import(lib + 'direct-browser/installed-config.mjs');
    const electron = await import(lib + 'direct-browser/electron-config.mjs');
    const character = await import(lib + 'hand/character.mjs');
    const socket = await import(lib + 'socket-bridge.mjs');
    const hand = await import(lib + 'hand/settings.mjs');
    for (const [actual, name] of [[preapproved.preapprovedFile(), 'preapproved.json'], [permissions.permissionsPath(), 'permissions.json'],
      [permissions.usedFolder(), 'used'], [installed.installedConfigPath(), 'turbo.json'], [electron.appOptInPath(), 'turbo-apps.json'],
      [electron.grantStorePath(), 'electron-grants.json'], [electron.tempRoot(), 'electron-tmp'], [hand.handConfigPath(), 'hand.json'],
      [character.charactersDirectory(), 'characters']]) assert.equal(actual, path.join(settings, name));
    assert.equal(electron.hostStateDir('test.app').startsWith(settings + path.sep), true);
    assert.equal(socket.socketDirectory(), path.join(cache, 'shell'));
    console.log('ok');
  `;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8',
    env: { ...process.env, HOME: '/wrong', APPDATA: 'Z:\\wrong', LOCALAPPDATA: 'Z:\\wrong' }, timeout: 60000, killSignal: 'SIGKILL' }).trim(), 'ok');
});
