// Electron turbo's operator-owned files, all under ~/Library/Application Support/sleight/. The per-app opt-in
// (turbo-apps.json) is written only by `sleight-mcp turbo app on|off` (turbo-setup.mjs) and read with the same rules
// as installed-config.mjs reads turbo.json: absent is null, anything unsafe is INSTALLED_CONFIG_UNSAFE. Neither tool
// JSON, page content nor the environment can name an app here.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { immutableJSON } from './ipc.mjs';

const support = home => join(home, 'Library/Application Support/sleight');
const MAX_APPS = 64;
export const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const BUILD = /^[A-Za-z0-9._@+-]{1,128}$/;
const fail = code => { throw Error(code); };

export const appOptInPath = (home = userInfo().homedir) => join(support(home), 'turbo-apps.json');
export const grantStorePath = (home = userInfo().homedir) => join(support(home), 'electron-grants.json');
export const tempRoot = (home = userInfo().homedir) => join(support(home), 'electron-tmp');
// The registry launch.py reads, shipped in the package.
export const registryPath = fileURLToPath(new URL('./electron/recipes.json', import.meta.url));
// One resident host per app. The folder name is a digest of the key (an appKey or a bundle id), so the socket path
// (folder + /host.sock) stays under macOS's 104-byte limit for user names up to 32 characters.
export function hostStateDir(key, home = userInfo().homedir) {
  if (typeof key !== 'string' || !BUNDLE_ID.test(key)) fail('INVALID_APP_KEY');
  return join(support(home), 'e' + createHash('sha256').update(key).digest('hex').slice(0, 12));
}

/** The opt-in file { version: 1, apps: { [bundleId]: { enabled, build } } }, frozen. null when absent. */
export function readAppOptIns(path = appOptInPath()) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; fail('INSTALLED_CONFIG_UNSAFE'); }
  try {
    if (!isAbsolute(path) || normalize(path) !== path || !stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
        stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 1048576) throw Error();
    const data = immutableJSON(JSON.parse(readFileSync(path, 'utf8')));
    if (!data || Array.isArray(data) || Object.keys(data).sort().join() !== 'apps,version' || data.version !== 1 ||
        !data.apps || typeof data.apps !== 'object' || Array.isArray(data.apps) || Object.keys(data.apps).length > MAX_APPS) throw Error();
    for (const [id, app] of Object.entries(data.apps)) {
      if (!BUNDLE_ID.test(id) || !app || typeof app !== 'object' || Object.keys(app).sort().join() !== 'build,enabled' ||
          typeof app.enabled !== 'boolean' || typeof app.build !== 'string' || !BUILD.test(app.build) || !app.build.startsWith(id + '@')) throw Error();
    }
    return data;
  } catch { fail('INSTALLED_CONFIG_UNSAFE'); }
}

/** [{ bundleId, build }] for every enabled app, in file order. */
export const enabledApps = data => data ? Object.entries(data.apps).filter(([, app]) => app.enabled).map(([bundleId, app]) => ({ bundleId, build: app.build })) : [];
