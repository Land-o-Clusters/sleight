// Windows native helper. Drawing and trusted cards use separate explicit modes.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, normalize, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { win32Paths } from '../platform/paths.mjs';

export const windowsHostSources = Object.freeze(['Protocol.cs', 'RingPlanner.cs', 'Sprites.cs', 'WebPLossless.cs', 'SecureInput.cs', 'Overlay.cs', 'BrowserGate.cs', 'Consent.cs', 'Program.cs',
  'PersonNative.cs', 'PersonHello.cs', 'PersonPassword.cs', 'PersonHost.cs', 'cache-access.ps1']);
export const windowsDriverSources = Object.freeze(['Driver.cs', 'DriverUia.cs', 'DriverInventory.cs', 'DriverCapture.cs', 'DriverIdentity.cs', 'DriverActions.cs',
  'DriverActionPlan.cs', 'DriverInput.cs', 'DriverHook.cs', 'DriverPatterns.cs', 'DriverSettle.cs', 'DriverClipboard.cs', 'Program.cs', 'cache-access.ps1']);
export const windowsPersonSources = Object.freeze(['PersonNative.cs', 'PersonHello.cs', 'PersonPassword.cs', 'PersonHost.cs', 'cache-access.ps1']);
const defaultSources = fileURLToPath(new URL('./native/win/', import.meta.url));
const receipts = new WeakMap();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
// No environment-based executable lookup, including SystemRoot, PATH or WINDIR.
export const windowsSystemRoot = 'C:\\Windows';
export const windowsPowerShell = windowsSystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export function findWindowsCompiler({ platform = process.platform, exists = existsSync } = {}) {
  if (platform !== 'win32') return;
  for (const framework of ['Framework64', 'Framework']) {
    const path = win32.join(windowsSystemRoot, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (exists(path)) return path;
  }
}
function ordinary(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || !same(realpathSync(path), path)) throw Error('HOST_PACKAGE_MISMATCH');
  return readFileSync(path);
}
function systemBytes(path) {
  const st = lstatSync(path);
  // Serviced Windows executables may also have a TrustedInstaller-owned WinSxS link.
  if (!st.isFile() || st.isSymbolicLink() || !same(realpathSync(path), path)) throw Error('HOST_COMPILER_UNSAFE');
  return readFileSync(path);
}
function ancestors(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path) throw Error('HOST_CACHE_UNSAFE');
  for (let p = path; ; p = dirname(p)) {
    try {
      const st = lstatSync(p);
      if (!st.isDirectory() || st.isSymbolicLink() || !same(realpathSync(p), p)) throw Error('HOST_CACHE_UNSAFE');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(p) === p) break;
  }
}
// Execute only the already-hashed script bytes. Batch every ACL check in one child.
function windowsAccess(checks, script, ownerPid) {
  const data = Buffer.from(JSON.stringify({ checks, ownerPid })).toString('base64');
  const command = script.toString('utf8') + '\nInvoke-HostChecks \'' + data + "'";
  try {
    return JSON.parse(execFileSync(windowsPowerShell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { windowsHide: true, cwd: win32.dirname(windowsPowerShell), timeout: 10000, maxBuffer: 4096,
        encoding: 'utf8', env: { SystemRoot: windowsSystemRoot, WINDIR: windowsSystemRoot }, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL' }));
  } catch { throw Error('HOST_CACHE_UNSAFE'); }
}
function sourcesFor(inventory, names = windowsHostSources) {
  if (inventory?.accepted !== true || inventory.protocol !== 1 || inventory.helperMode !== 'source' ||
      inventory.node !== process.version || !Array.isArray(inventory.files)) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
  return Object.fromEntries(names.map(name => {
    const entries = inventory.files.filter(f => f.path === 'native/win/' + name || f.path?.endsWith('/native/win/' + name));
    if (entries.length !== 1 || !/^[a-f0-9]{64}$/.test(entries[0].sha256 ?? '')) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
    return [name, entries[0].sha256];
  }));
}
function sourceBytes(root, hashes) {
  return Object.fromEntries(Object.entries(hashes).map(([name, expected]) => {
    const bytes = ordinary(join(root, name));
    if (hash(bytes) !== expected) throw Error('HOST_SOURCE_MISMATCH');
    return [name, bytes];
  }));
}
function sourceInventory(sourceRoot, names = windowsHostSources) {
  return { accepted: true, protocol: 1, node: process.version, helperMode: 'source',
    files: names.map(name => ({ path: 'native/win/' + name, sha256: hash(ordinary(join(sourceRoot, name))) })) };
}
const buildKey = hashes => hash(JSON.stringify({ protocol: 1, arch: process.arch, sources: hashes }));
const accountCache = () => join(win32Paths().cache, 'cursor-host');

// Doctor never creates directories, repairs permissions, takes a build lock or compiles.
export function windowsCachedHostReceipt({ platform = process.platform, sourceRoot = defaultSources, cacheRoot,
  inventory, compiler = findWindowsCompiler({ platform }), access } = {}) {
  if (platform !== 'win32') return undefined;
  try {
    cacheRoot ??= accountCache();
    if (!compiler) return undefined;
    const hashes = sourcesFor(inventory ?? sourceInventory(sourceRoot)), bytes = sourceBytes(sourceRoot, hashes);
    const directory = join(cacheRoot, buildKey(hashes)), record = join(directory, 'build.json'), binary = join(directory, 'cursor-host.exe');
    ancestors(cacheRoot); ancestors(directory);
    (access ?? (checks => windowsAccess(checks, bytes['cache-access.ps1'])))([
      ['private', cacheRoot], ['private', directory], ['private', record], ['private', binary], ['system', compiler],
      ...Object.keys(hashes).map(name => ['source', join(sourceRoot, name)]),
    ]);
    const data = JSON.parse(ordinary(record));
    if (data.protocol !== 1 || data.arch !== process.arch || JSON.stringify(data.sources) !== JSON.stringify(hashes) ||
        data.compiler?.path !== compiler || data.compiler?.sha256 !== hash(systemBytes(compiler)) ||
        !/^[a-f0-9]{64}$/.test(data.binaries?.['cursor-host.exe'] ?? '') || hash(ordinary(binary)) !== data.binaries['cursor-host.exe']) return undefined;
    const receipt = Object.freeze({});
    receipts.set(receipt, { node: process.version, cacheRoot, directory, record, sourceRoot, sources: hashes,
      binaryHash: data.binaries['cursor-host.exe'], recordHash: hash(ordinary(record)) });
    return receipt;
  } catch { return undefined; }
}
export function windowsHandHostBuilt(options) { return !!windowsCachedHostReceipt(options); }

function validate(build) {
  ancestors(build.cacheRoot); ancestors(build.directory);
  sourceBytes(build.sourceRoot, build.sources);
  if (hash(ordinary(build.record)) !== build.recordHash) throw Error('HOST_PACKAGE_MISMATCH');
  const binary = join(build.directory, build.binaryName ?? 'cursor-host.exe');
  if (hash(ordinary(binary)) !== build.binaryHash) throw Error('HOST_PACKAGE_MISMATCH');
  return binary;
}
export function windowsHostExecutable(receipt, { platform = process.platform } = {}) {
  const build = receipts.get(receipt);
  if (platform !== 'win32' || !build || build.node !== process.version) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
  try { return validate(build); } catch { throw Error('HOST_PACKAGE_MISMATCH'); }
}
function redacted(bytes, paths = [], limit = 65536) {
  let text = bytes.toString('utf8');
  for (const path of paths.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(path).join('<build>');
  text = text.replace(/[A-Za-z]:\\[^\r\n"<>|]*?(?=\(\d|: (?:error|warning)|$)/gm, '<path>').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  return Buffer.from(text).subarray(0, limit).toString('utf8').replace(/\ufffd$/, '');
}
export async function compileWindowsHost({ sources, binary, signal, compiler = findWindowsCompiler(), run = spawn, winrt = 'abi', exists = existsSync }) {
  if (!['abi', 'metadata'].includes(winrt)) throw Error('HOST_WINRT_INVALID');
  if (!compiler) throw Error('WINDOWS_COMPILER_MISSING');
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const framework = win32.dirname(compiler);
    const driver = sources.some(source => win32.basename(source) === 'Driver.cs');
    const person = sources.some(source => win32.basename(source) === 'PersonHost.cs');
    const cursor = sources.some(source => win32.basename(source) === 'Program.cs');
    const references = driver ? ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'] : person && !cursor ? ['System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'] :
      ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll',
        'WPF\\UIAutomationClient.dll', 'WPF\\UIAutomationTypes.dll', 'WPF\\WindowsBase.dll'];
    const main = driver ? ['/define:SLEIGHT_DRIVER', '/main:Sleight.Cursor.Program'] : person ? cursor ? ['/main:Sleight.Cursor.Program'] : ['/main:Sleight.Person.PersonHost'] : [];
    const facade = win32.join(framework, 'Facades', 'System.Runtime.dll');
    const metadata = winrt === 'metadata' ? ['/define:PERSON_WINRT_METADATA',
      '/r:' + win32.join(windowsSystemRoot, 'System32', 'WinMetadata', 'Windows.Security.winmd'),
      '/r:' + win32.join(windowsSystemRoot, 'System32', 'WinMetadata', 'Windows.Foundation.winmd'),
      '/r:' + win32.join(framework, 'System.Runtime.WindowsRuntime.dll'),
      ...exists(facade) ? ['/r:' + facade] : []] : [];
    const args = ['/nologo', '/noconfig', '/langversion:5', '/target:exe', '/platform:anycpu', '/optimize+', '/out:' + binary, ...main, ...metadata,
      ...references.map(name => '/r:' + win32.join(framework, name)), ...sources];
    const child = run(compiler, args, { windowsHide: true, cwd: dirname(binary), stdio: ['ignore', 'pipe', 'pipe'],
      env: { SystemRoot: windowsSystemRoot, WINDIR: windowsSystemRoot, TEMP: dirname(binary), TMP: dirname(binary) } });
    let failure, bytes = 0, stopped = false;
    const stdout = [], stderr = [];
    const stop = error => { failure ??= error; if (!stopped) { stopped = true; child.kill(); } };
    const abort = () => stop(Object.assign(Error('Native helper build aborted.'), { name: 'AbortError' }));
    const timer = setTimeout(() => stop(Object.assign(Error('Native helper build timed out.'), { code: 'HOST_BUILD_TIMEOUT' })), 300000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
      const buffer = Buffer.from(chunk), remaining = Math.max(0, 65536 - bytes);
      chunks.push(buffer.subarray(0, remaining)); bytes += buffer.length;
      if (bytes > 65536) stop(Error('HOST_COMPILER_OUTPUT_LIMIT'));
    });
    child.once('error', error => { failure ??= error; });
    child.once('close', (code, killedBy) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (code !== 0 || killedBy) failure ??= Object.assign(Error('Native helper compiler failed.'), { code });
      if (failure) {
        failure.stdout = redacted(Buffer.concat(stdout), [dirname(binary)]);
        failure.stderr = redacted(Buffer.concat(stderr), [dirname(binary)], 65536 - Buffer.byteLength(failure.stdout));
        reject(failure);
      } else resolve();
    });
  });
}
const lockLimit = 600000;
export function sweepWindowsPersonRuns(cacheRoot, { now = Date.now(), check } = {}) {
  // A failed deletion (notably a still-running exe on Windows) is left for the next prepare.
  for (const name of readdirSync(cacheRoot)) {
    if (!/^person-run-[A-Za-z0-9]+$/.test(name)) continue;
    const folder = join(cacheRoot, name);
    try {
      const st = lstatSync(folder);
      if (!st.isDirectory() || st.isSymbolicLink() || !same(realpathSync(folder), folder) || now - st.mtimeMs <= 3600000) continue;
      check([['private', folder]]);
      const after = lstatSync(folder);
      if (after.ino !== st.ino || after.mtimeMs !== st.mtimeMs) continue;
      rmSync(folder, { recursive: true, force: true });
    } catch {} // never make a stale run prevent an access-removing command
  }
}
function readOwner(lock) { try { return JSON.parse(ordinary(join(lock, 'owner.json'))); } catch { return undefined; } }
function takeLock(lock, started, inspectedOwner) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let made = false;
    try {
      mkdirSync(lock); made = true;
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: Date.now() - process.uptime() * 1000, created: Date.now() }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (made) rmSync(lock, { recursive: true, force: true });
      if (error.code !== 'EEXIST' || made) throw error;
    }
    const stat = lstatSync(lock), owner = readOwner(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('HOST_CACHE_UNSAFE');
    const valid = Number.isSafeInteger(owner?.pid) && owner.pid > 0 && Number.isFinite(owner.created);
    const identityMatches = JSON.stringify(owner) === JSON.stringify(inspectedOwner);
    const stale = valid ? Date.now() - owner.created > lockLimit || identityMatches && (started === null ||
      Number.isFinite(started) && Number.isFinite(owner.started) && Math.abs(started - owner.started) > 2000) : Date.now() - stat.mtimeMs > lockLimit;
    if (attempt || !stale) return false;
    const aside = lock + '.stale-' + process.pid + '-' + randomBytes(4).toString('hex');
    try { renameSync(lock, aside); } catch { return false; }
    if (lstatSync(aside).ino !== stat.ino) { try { renameSync(aside, lock); } catch {} return false; }
    rmSync(aside, { recursive: true, force: true });
  }
  return false;
}
export async function prepareWindowsHandHost({ platform = process.platform, inventory,
  sourceRoot = defaultSources, cacheRoot,
  compile = compileWindowsHost, access, run = spawn, signal, compiler = findWindowsCompiler({ platform }), kind = 'cursor', winrt = 'abi' } = {}) {
  if (platform !== 'win32') return Object.freeze({ status: 'unavailable', code: 'PLATFORM' });
  if (!['cursor', 'person', 'driver'].includes(kind)) throw Error('HOST_KIND_INVALID');
  if (!['abi', 'metadata'].includes(winrt)) throw Error('HOST_WINRT_INVALID');
  const names = kind === 'driver' ? windowsDriverSources : kind === 'person' ? windowsPersonSources : windowsHostSources;
  const binaryName = kind === 'driver' ? 'driver-host.exe' : 'cursor-host.exe';
  try {
    inventory ??= sourceInventory(sourceRoot, names);
  } catch { return Object.freeze({ status: 'unavailable', code: 'HOST_SOURCE_MISMATCH' }); }
  const hashes = sourcesFor(inventory, names), key = winrt === 'metadata' ? hash(JSON.stringify({ protocol: 1, arch: process.arch,
    sources: hashes, winrt })) : buildKey(hashes);
  let bank, lock, locked = false;
  const unavailable = (code, detail) => Object.freeze({ status: 'unavailable', code, ...detail ? { detail } : {} });
  try {
    cacheRoot ??= accountCache();
    const bytes = sourceBytes(sourceRoot, hashes);
    const check = access ?? ((checks, ownerPid) => windowsAccess(checks, bytes['cache-access.ps1'], ownerPid));
    ancestors(cacheRoot);
    if (!compiler) throw Error('WINDOWS_COMPILER_MISSING');
    const directory = join(cacheRoot, key), record = join(directory, 'build.json');
    lock = join(cacheRoot, key + '.lock');
    const missing = [];
    for (let path = cacheRoot; !existsSync(path); path = dirname(path)) missing.push(path);
    const checks = missing.reverse().map(path => ['create', path]);
    checks.push(['private', cacheRoot], ['system', compiler], ...Object.keys(hashes).map(name => ['source', join(sourceRoot, name)]));
    if (existsSync(lock)) checks.push(['private', lock], ...existsSync(join(lock, 'owner.json')) ? [['private', join(lock, 'owner.json')]] : []);
    const hasRecord = existsSync(record);
    if (hasRecord) checks.push(['private', directory], ['private', record], ['private', join(directory, binaryName)]);
    const owner = readOwner(lock), proof = check(checks, Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? owner.pid : undefined) ?? {};
    if (kind === 'person') sweepWindowsPersonRuns(cacheRoot, { check });
    const compilerHash = hash(systemBytes(compiler));
    const cached = (aclChecked = false) => {
      const data = JSON.parse(ordinary(record));
      if (data.protocol !== 1 || data.arch !== process.arch || JSON.stringify(data.sources) !== JSON.stringify(hashes) ||
          data.compiler?.path !== compiler || data.compiler?.sha256 !== compilerHash ||
          !/^[a-f0-9]{64}$/.test(data.binaries?.[binaryName] ?? '')) throw Error('HOST_PACKAGE_MISMATCH');
      if (!aclChecked) check([['private', directory], ['private', record], ['private', join(directory, binaryName)]]);
      const build = { node: process.version, cacheRoot, directory, record, sourceRoot, sources: hashes, binaryName,
        binaryHash: data.binaries[binaryName], recordHash: hash(ordinary(record)) };
      validate(build);
      const receipt = Object.freeze({}); receipts.set(receipt, build);
      return Object.freeze({ status: 'ready', directory, record, receipt,
        personCopy() {
          if (kind !== 'person') throw Error('HOST_KIND_INVALID');
          const binary = windowsHostExecutable(receipt, { platform });
          const folder = mkdtempSync(join(cacheRoot, 'person-run-'));
          const path = join(folder, 'person-host.exe');
          try {
            const bytes = ordinary(binary);
            if (hash(bytes) !== build.binaryHash) throw Error('HOST_PACKAGE_MISMATCH');
            writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
            check([['private', folder], ['private', path]]);
            return { path, sha256: build.binaryHash,
              verify() { if (hash(ordinary(path)) !== build.binaryHash) throw Error('HOST_PACKAGE_MISMATCH'); },
              cleanup: () => rmSync(folder, { recursive: true, force: true }) };
          } catch (error) { rmSync(folder, { recursive: true, force: true }); throw error; }
        },
        spawn({ capture = 'hidden', cursorStyle = 'ring', consent = false, nonce } = {}) {
          if (kind === 'driver') {
            if (!/^[a-f0-9]{64}$/.test(nonce ?? '')) throw Error('DRIVER_NONCE_INVALID');
            return run(windowsHostExecutable(receipt, { platform }), ['--driver'],
              { windowsHide: true, cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
                env: { SystemRoot: windowsSystemRoot, WINDIR: windowsSystemRoot, SLEIGHT_DRIVER_NONCE: nonce,
                  ...process.env.SLEIGHT_ALLOW_FORBIDDEN_TARGETS === '1' ? { SLEIGHT_ALLOW_FORBIDDEN_TARGETS: '1' } : {} } });
          }
          if (kind !== 'cursor') throw Error('HOST_KIND_INVALID');
          if (consent !== false) throw Error('WINDOWS_CONSENT_UNAVAILABLE');
          if (!['hidden', 'visible'].includes(capture)) throw Error('HAND_CAPTURE_INVALID');
          if (!['ring', 'seam', 'sprite'].includes(cursorStyle)) throw Error('HAND_CURSOR_STYLE_INVALID');
          return run(windowsHostExecutable(receipt, { platform }), ['--hand', '--capture=' + capture, '--cursor-style=' + cursorStyle],
            { windowsHide: true, cwd: directory, stdio: ['pipe', 'pipe', 'ignore'], env: { SystemRoot: windowsSystemRoot } });
        } });
    };
    if (hasRecord) try { return cached(true); } catch {}
    if (!takeLock(lock, proof.ownerStarted, owner)) return unavailable('HOST_BUILD_BUSY');
    locked = true;
    bank = mkdtempSync(join(cacheRoot, 'build-'));
    for (const [name, content] of Object.entries(bytes)) writeFileSync(join(bank, name), content, { flag: 'wx', mode: 0o600 });
    signal?.throwIfAborted();
    const binary = join(bank, binaryName);
    await compile({ sources: names.filter(n => n.endsWith('.cs')).map(n => join(bank, n)), binary, signal, compiler, winrt });
    signal?.throwIfAborted(); sourceBytes(sourceRoot, hashes); sourceBytes(bank, hashes);
    if (hash(systemBytes(compiler)) !== compilerHash) throw Error('HOST_COMPILER_UNSAFE');
    const binaries = { [binaryName]: hash(ordinary(binary)) };
    writeFileSync(join(bank, 'build.json'), JSON.stringify({ protocol: 1, arch: process.arch, sources: hashes, binaries,
      compiler: { path: compiler, sha256: compilerHash } }), { flag: 'wx', mode: 0o600 });
    if (existsSync(directory)) { ancestors(directory); check([['private', directory]]); rmSync(directory, { recursive: true }); }
    renameSync(bank, directory); bank = undefined;
    return cached();
  } catch (error) {
    return unavailable(['HOST_CACHE_UNSAFE', 'HOST_SOURCE_MISMATCH', 'HOST_COMPILER_UNSAFE', 'WINDOWS_COMPILER_MISSING'].includes(error.message) ? error.message : 'NATIVE_HELPERS_UNAVAILABLE',
      { ...error.name === 'AbortError' ? { errorCode: 'ABORT_ERR' } : Number.isInteger(error.code) ? { exitCode: error.code } :
          ['HOST_BUILD_TIMEOUT', 'HOST_COMPILER_OUTPUT_LIMIT'].includes(error.code ?? error.message) ? { errorCode: error.code ?? error.message } : {},
        ...error.stdout ? { stdout: error.stdout } : {}, ...error.stderr ? { stderr: error.stderr } : {} });
  } finally {
    if (bank) rmSync(bank, { recursive: true, force: true });
    if (locked && readOwner(lock)?.pid === process.pid) rmSync(lock, { recursive: true, force: true });
  }
}
