import { userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

export function darwinPaths({ home = userInfo().homedir } = {}) {
  const settings = posix.join(home, 'Library/Application Support/sleight'), cache = posix.join(home, 'Library/Caches/sleight');
  return Object.freeze({ settings, cache, characters: posix.join(settings, 'characters'),
    cursorRenderers: posix.join(settings, 'cursor/renderers'), helperCache: posix.join(cache, 'turbo-host') });
}

function windowsRoot(value) {
  // Private stores and helper search roots must be on a local drive.
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value) ||
      !/^[a-z]:[\\/]/i.test(value)) {
    throw Object.assign(Error('Windows account folder must be an absolute local drive path.'), { code: 'PLATFORM_PATH_INVALID' });
  }
  return win32.normalize(value);
}

// Explicit env is a test seam only. Production callers never forward process.env here.
export const windowsEnv = (env, name) => {
  const keys = Object.keys(env ?? {}).filter(key => key.toLowerCase() === name.toLowerCase());
  if (keys.length > 1 && keys.some(key => env[key] !== env[keys[0]])) throw Object.assign(Error('Ambiguous Windows environment key.'), { code: 'PLATFORM_PATH_INVALID' });
  return keys.length ? env[keys[0]] : undefined;
};
export function win32Paths({ home = userInfo().homedir, env } = {}) {
  // Validate even unused roaming overrides so tests cannot bless a UNC authority root.
  const roaming = windowsEnv(env, 'APPDATA');
  if (roaming !== undefined) windowsRoot(roaming);
  const local = windowsRoot(windowsEnv(env, 'LOCALAPPDATA') ?? win32.join(windowsRoot(home), 'AppData', 'Local'));
  const settings = win32.join(local, 'sleight'), cache = win32.join(local, 'sleight');
  return Object.freeze({ settings, cache, characters: win32.join(cache, 'characters'),
    cursorRenderers: win32.join(cache, 'cursor', 'renderers'), helperCache: win32.join(cache, 'turbo-host') });
}

function checkedSystemRoot() {
  const root = 'C:\\Windows';
  for (const folder of [root, win32.join(root, 'System32')]) {
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(folder).toLowerCase() !== folder.toLowerCase()) {
      throw Object.assign(Error('Windows system folder could not be verified.'), { code: 'PLATFORM_PATH_INVALID' });
    }
  }
  return root;
}
// No inherited PATH, SystemRoot or temp folder can redirect a native helper. Non-C installations refuse until
// the native known-folder API supplies an OS-verified root. Explicit env bypasses this check only in tests.
export function win32Environment({ env } = {}) {
  const systemRoot = windowsRoot(env === undefined ? checkedSystemRoot() : windowsEnv(env, 'SystemRoot'));
  const result = { SystemRoot: systemRoot, PATH: win32.join(systemRoot, 'System32') + ';' + systemRoot };
  for (const key of ['TEMP', 'TMP']) { const value = windowsEnv(env, key); if (value !== undefined) result[key] = windowsRoot(value); }
  return Object.freeze(result);
}

export const darwinEnvironment = (_options = {}) => ({ PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' });
export const platformPaths = ({ platform = process.platform, ...options } = {}) => platform === 'win32' ? win32Paths(options) : darwinPaths(options);
export const platformJoin = (platform = process.platform) => platform === 'win32' ? win32.join : posix.join;
