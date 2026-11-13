import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { immutableJSON } from './ipc.mjs';
import { createPackageInventory } from './session-host.mjs';
import { browserApplicationName, browserDefinitions } from './browsers.mjs';

const packageRoot = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const inventoryRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const entries = ['../launch.mjs', '../../bin/sleight-mcp', '../../hooks/register.tsx'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// The writer (turbo-setup.mjs) builds the file from these same values, never from a copy of its format.
export const INSTALLED_PLUGIN_ROOT = inventoryRoot;
export const INSTALLED_ENTRIES = Object.freeze([...entries]);
export const sha256Hex = hash;
// The operator-owned file is the only opt-in source. Neither HOME, environment,
// MCP input nor a project settings file can select acceptance or a profile.
export const installedConfigPath = (home = userInfo().homedir) => join(home, 'Library/Application Support/sleight/turbo.json');
// The file itself: absent is null, anything unsafe throws. An opted-out file (enabled: false) is returned as it is.
export function readInstalledConfigFile(path = installedConfigPath()) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw Error('INSTALLED_CONFIG_UNSAFE'); }
  try {
    if (!isAbsolute(path) || normalize(path) !== path || !stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
        stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 1048576) throw Error();
    const data = immutableJSON(JSON.parse(readFileSync(path, 'utf8')));
    if (!data || Object.keys(data).some(k => !['version', 'enabled', 'profileRoot', 'executable', 'receipt', 'entryHashes'].includes(k)) ||
        data.version !== 1 || typeof data.enabled !== 'boolean') throw Error();
    return data;
  } catch { throw Error('INSTALLED_CONFIG_UNSAFE'); }
}
// The shape an enabled file must have. Throws INSTALLED_CONFIG_UNSAFE.
export function validateEnabledConfig(data) {
  try {
    if (['profileRoot', 'executable'].some(k => typeof data[k] !== 'string' || !isAbsolute(data[k]) || normalize(data[k]) !== data[k]) ||
        data.receipt?.node !== process.version || data.receipt.accepted !== true || data.receipt.protocol !== 1 ||
        data.receipt.helperMode !== 'source' || !Array.isArray(data.receipt.files) || !data.receipt.files.length ||
        !data.entryHashes || Object.keys(data.entryHashes).length !== entries.length ||
        entries.some(k => !/^[a-f0-9]{64}$/.test(data.entryHashes[k] ?? ''))) throw Error();
    return data;
  } catch { throw Error('INSTALLED_CONFIG_UNSAFE'); }
}
export function readInstalledConfig(path = installedConfigPath(), env = process.env) {
  const data = readInstalledConfigFile(path);
  if (!data || !data.enabled) return null;
  const config = validateEnabledConfig(data);
  // A config written for a qualification check never outlives it: an unqualified browser connects only while the
  // operator's own environment sets the override, so turbo stays off for it in every other session.
  const name = browserApplicationName(config.executable), browser = browserDefinitions().find(b => b.name === name);
  if (browser && !browser.qualified && env.SLEIGHT_TURBO_UNQUALIFIED !== '1') return null;
  return config;
}
// pluginRoot is the installed loader's own folder. Only turbo-setup and tests pass another one, to check a copy.
export function acceptedInstalledPackage(config, { pluginRoot = inventoryRoot } = {}) {
  if (!config) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
  const root = pluginRoot, dir = pluginRoot === inventoryRoot ? packageRoot : join(pluginRoot, 'lib/direct-browser');
  const inventory = createPackageInventory({ root, receipt: config.receipt });
  const current = () => inventory.current() && entries.every(path => {
    try {
      const file = join(dir, path), stat = lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() && realpathSync(file) === file && !(stat.mode & 0o022) &&
        (stat.uid === process.getuid() || stat.uid === 0) && hash(readFileSync(file)) === config.entryHashes[path];
    } catch { return false; }
  });
  if (!current()) throw Error('HOST_PACKAGE_MISMATCH');
  return Object.freeze({ inventory, current });
}
