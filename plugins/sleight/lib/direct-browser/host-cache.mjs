import { createHash } from 'node:crypto';
import { lstatSync, statSync, realpathSync, readFileSync } from 'node:fs';
import { lstat, realpath, readdir, readFile, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { darwinPaths } from '../platform/paths.mjs';
import { SETTINGS_BUILD_POLICY } from '../settings-build-policy.mjs';

const sources = fileURLToPath(new URL('./native/', import.meta.url)).replace(/\/$/, '');
const helperSources = { 'peer-host': 'peer-host.c', 'consent-host': 'consent-host.swift' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function ordinary(path, mode) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
      stat.mode & 0o022 || stat.uid !== process.getuid() && stat.uid !== 0 ||
      mode !== undefined && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== mode)) throw Error('HOST_PACKAGE_MISMATCH');
  return readFileSync(path);
}
export function helperSourceHashes(inventory, selectedSources = helperSources) {
  const hashes = {};
  for (const name of Object.values(selectedSources)) {
    const entries = inventory.files.filter(file => file.path === 'native/' + name || file.path?.endsWith('/native/' + name));
    if (entries.length !== 1 || !/^[a-f0-9]{64}$/.test(entries[0].sha256 ?? '')) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
    hashes[name] = entries[0].sha256;
  }
  if (Object.values(selectedSources).includes('consent-host.swift')) {
    const seal = inventory.files.filter(file => file.path === 'mac-driver/native/SealedSettings.swift' || file.path?.endsWith('/mac-driver/native/SealedSettings.swift'));
    if (seal.length > 1 || seal.length === 1 && !/^[a-f0-9]{64}$/.test(seal[0].sha256 ?? '')) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
    if (seal.length) hashes['../../mac-driver/native/SealedSettings.swift'] = seal[0].sha256;
  }
  return hashes;
}
// These arguments also describe the cache recipe. Temporary paths are placeholders in receipts.
export function helperCompileArgs(name, { sources, binary, moduleCache, settingsFlags = [], recipe = 'optimized' }) {
  if (!['default', 'optimized'].includes(recipe)) throw Error('HOST_RECIPE_INVALID');
  return name === 'peer-host'
    ? ['clang', '-Wall', '-Werror', '-fmodules-cache-path=' + moduleCache, ...sources, '-lbsm', '-o', binary]
    : ['swiftc', ...name === 'consent-host' && recipe === 'optimized' ? ['-O'] : [], '-module-cache-path', moduleCache, ...settingsFlags, ...sources, '-o', binary];
}
export function helperSettingsFlags(sealed) {
  return sealed ? ['-D', 'SLEIGHT_SEALED_SETTINGS',
    ...SETTINGS_BUILD_POLICY.enforce && SETTINGS_BUILD_POLICY.team !== null ? ['-D', 'SLEIGHT_ENFORCE_SETTINGS'] : []] : [];
}
export function helperBuildRecipes(hashes, recipe = 'optimized') {
  return Object.fromEntries(Object.keys(hashes).filter(file => !file.includes('/')).map(file => {
    const name = file.replace(/\.(c|swift)$/, '');
    return [name, { command: '/usr/bin/xcrun', args: helperCompileArgs(name, {
      sources: ['<source>'], binary: '<binary>', moduleCache: '<module-cache>', recipe,
      settingsFlags: name === 'consent-host' ? helperSettingsFlags(Object.hasOwn(hashes, '../../mac-driver/native/SealedSettings.swift')) : [],
    }) }];
  }));
}
export const helperBuildKey = (hashes, recipe = 'optimized') => digest(JSON.stringify({ protocol: 1, arch: process.arch, sources: hashes, recipes: helperBuildRecipes(hashes, recipe) }));
export const defaultHelperCache = () => darwinPaths().helperCache;

// xcrun uses the system selection: environment() strips DEVELOPER_DIR. Detect
// compiler replacement and selection changes without running a compiler.
export function helperToolchainKey({ io = { realpathSync, statSync } } = {}) {
  let selected;
  try { selected = io.realpathSync('/var/db/xcode_select_link'); } catch {}
  const roots = [...new Set([selected, '/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer'].filter(Boolean))];
  const files = roots.flatMap(root => ['usr/bin/swiftc', 'usr/bin/clang',
    'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc', 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang',
    '../version.plist', 'SDKs'].map(name => {
    const path = join(root, name);
    try { const stat = io.statSync(path); return [io.realpathSync(path), stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]; }
    catch { return [path, null]; }
  }));
  return digest(JSON.stringify({ selected, arch: process.arch, files }));
}

export function helperCompileFailure({ cacheRoot, key, toolchain = helperToolchainKey(), now = Date.now() }) {
  try {
    const stat = lstatSync(cacheRoot), path = join(cacheRoot, key + '.startup-failed.json');
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(cacheRoot) !== cacheRoot ||
        stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700 || lstatSync(path).size > 1024) return;
    const marker = JSON.parse(ordinary(path, 0o600));
    if (marker.key !== key || marker.toolchain !== toolchain || marker.code !== 'HOST_COMPILE_FAILED' ||
        !Number.isSafeInteger(marker.failedAt) || marker.failedAt <= 0 || marker.failedAt > now) return;
    return { ...marker, retryAfterMs: Math.max(0, 3600000 - (now - marker.failedAt)) };
  } catch { /* An absent or invalid diagnostic cannot authorize or block a build. */ }
}

// Advisory only. A previous duration cannot validate a build or grant input.
export function helperCompileDuration({ cacheRoot, toolchain }) {
  try {
    const stat = lstatSync(cacheRoot), path = join(cacheRoot, 'startup-compile.json');
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(cacheRoot) !== cacheRoot ||
        stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700 || lstatSync(path).size > 1024) return;
    const record = JSON.parse(ordinary(path, 0o600));
    if (record.toolchain === toolchain && Number.isFinite(record.compileMs) && record.compileMs > 0 && record.compileMs <= 600000)
      return record.compileMs;
  } catch {}
}

// Read-only: hash the cached files and receipt without building or executing a helper.
export function nativeHelpersBuilt({ inventory, cacheRoot = defaultHelperCache(), selectedSources = helperSources, recipe = 'auto' } = {}) {
  if (recipe === 'auto') return ['optimized', 'default'].some(recipe => nativeHelpersBuilt({ inventory, cacheRoot, selectedSources, recipe }));
  try {
    const hashes = helperSourceHashes(inventory, selectedSources), directory = join(cacheRoot, helperBuildKey(hashes, recipe));
    for (const path of [cacheRoot, directory]) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) return false;
    }
    const data = JSON.parse(ordinary(join(directory, 'build.json'), 0o600));
    return data.protocol === 1 && data.arch === process.arch && JSON.stringify(data.sources) === JSON.stringify(hashes) &&
      JSON.stringify(data.recipes) === JSON.stringify(helperBuildRecipes(hashes, recipe)) &&
      Object.keys(data.binaries ?? {}).sort().join() === Object.keys(selectedSources).sort().join() &&
      Object.keys(selectedSources).every(name => digest(ordinary(join(directory, name), 0o700)) === data.binaries[name]);
  } catch { return false; }
}

// The ghost hand runs the consent host's binary with --hand, from the same build and cache. Its inventory is the helper sources
// on disk, hashed now: the hand only draws, so it needs no turbo acceptance, and its handle can start only the hand, never the
// consent channel or the peer helper. A build for one serves the other when the sources match.
export function handInventory(sourceRoot) {
  const sealing = join(sourceRoot, '../../mac-driver/native/SealedSettings.swift');
  let seal;
  try { seal = { path: 'mac-driver/native/SealedSettings.swift', sha256: digest(ordinary(sealing)) }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { accepted: true, protocol: 1, node: process.version, helperMode: 'source',
    files: [...Object.values(helperSources).map(name => ({ path: 'native/' + name, sha256: digest(ordinary(join(sourceRoot, name))) })), ...seal ? [seal] : []] };
}
export function handHostBuilt({ cacheRoot = defaultHelperCache(), sourceRoot = sources } = {}) {
  try { return nativeHelpersBuilt({ inventory: handInventory(sourceRoot), cacheRoot }); } catch { return false; }
}

// Offline diagnosis of the recipe selected for the next launch. No helper is executed.
export function handHostRecipe({ cacheRoot = defaultHelperCache(), sourceRoot = sources } = {}) {
  try {
    const inventory = handInventory(sourceRoot);
    for (const recipe of ['optimized', 'default']) {
      if (nativeHelpersBuilt({ inventory, cacheRoot, recipe })) return recipe;
    }
  } catch {}
  return 'not built';
}

const hashName = /^[a-f0-9]{64}$/, stageName = /^build-[A-Za-z0-9]{6}$/;
const stageAge = 60 * 60 * 1000;
const recentAge = 24 * stageAge;
const privateDir = stat => stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

// Internal maintenance only. The process reader returns kernel executable paths, never command-line arguments.
// Unknown ownership or inventory means keep the files. rm does not traverse symlinks inside a removed directory.
export async function pruneHelperCache({ cacheRoot, currentKeys, processes, now = Date.now }) {
  try {
    if (!isAbsolute(cacheRoot) || normalize(cacheRoot) !== cacheRoot || await realpath(cacheRoot) !== cacheRoot) return;
    const root = await lstat(cacheRoot);
    if (!privateDir(root)) return;
    const inventory = async () => {
      const rows = await processes();
      if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(row.pid) || row.pid < 1 ||
          typeof row.path !== 'string' || !isAbsolute(row.path) || normalize(row.path) !== row.path)) throw Error('PROCESS_INVENTORY_UNPROVED');
      return rows;
    };
    const rows = await inventory(), entries = [];
    for (const name of await readdir(cacheRoot)) {
      if (!hashName.test(name) && !stageName.test(name)) continue;
      try {
        const stat = await lstat(join(cacheRoot, name));
        if (privateDir(stat)) entries.push({ name, stat });
      } catch {}
    }
    const keep = new Set(entries.filter(e => hashName.test(e.name)).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.name.localeCompare(b.name))
      .slice(0, 2).map(e => e.name));
    const compiler = rows => rows.some(row => /^(swiftc|swift-driver|swift-frontend|clang|clang-[0-9]+|ld|ld-classic|dsymutil)$/.test(basename(row.path)));
    for (const { name, stat } of entries) {
      try {
        if (keep.has(name) || currentKeys.has(name)) continue;
        const path = join(cacheRoot, name), staged = stageName.test(name);
        if (staged && now() - stat.mtimeMs <= stageAge) continue;
        if (!staged && now() - stat.mtimeMs <= recentAge) continue;
        // Refresh just before deleting, since a helper may have launched during the scan.
        const live = await inventory();
        if (live.some(row => row.path.normalize('NFC').startsWith((path + '/').normalize('NFC')))) continue;
        if (staged) {
          // Orphan compiler children may outlive their Node owner. Preserve staging while any compiler runs.
          if (compiler(rows) || compiler(live)) continue;
          let owner;
          try {
            const ownerPath = join(path, 'owner.json'), ownerStat = await lstat(ownerPath);
            if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 4096) continue;
            owner = JSON.parse(await readFile(ownerPath, 'utf8'));
            if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || live.some(row => row.pid === owner.pid)) continue;
          } catch (error) {
            if (error.code !== 'ENOENT') continue;
            // Old builders did not write a per-stage owner. Any build lock protects those banks.
            try { await lstat(join(cacheRoot, 'build.lock')); continue; } catch (error) { if (error.code !== 'ENOENT') continue; }
          }
        }
        if (await realpath(cacheRoot) !== cacheRoot || !same(root, await lstat(cacheRoot))) return;
        const before = await lstat(path);
        if (!privateDir(before) || !same(stat, before) || before.mtimeMs !== stat.mtimeMs || currentKeys.has(name)) continue;
        await rm(path, { recursive: true, force: true });
      } catch { /* Maintenance failures never affect a helper build or another candidate. */ }
    }
  } catch { /* Leave the cache intact when its root or process inventory cannot be proved. */ }
}

let cleanupScheduled = false;
const currentKeys = new Set();
// Prune once per process. Cache hits retry module cleanup in the background and add their key to the keep set.
export function scheduleHelperCacheCleanup({ cacheRoot, key, processes, cleanup }) {
  currentKeys.add(key);
  const prune = !cleanupScheduled;
  if (!prune && !cleanup) return;
  cleanupScheduled = true;
  const timer = setTimeout(async () => {
    try { await cleanup?.(); } catch {}
    if (prune) await pruneHelperCache({ cacheRoot, currentKeys, processes });
  }, 0);
  timer.unref();
}
