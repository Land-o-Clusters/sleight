import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { Socket } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { immutableJSON } from './ipc.mjs';
import { runOnceMore } from './transient.mjs';

// Fixed entry. The installed loader supplies source acceptance outside model or
// project input. Only this local compiler can issue a native launch receipt.
const sources = fileURLToPath(new URL('./native/', import.meta.url)).replace(/\/$/, '');
const nativeBuilds = new WeakMap();
const helperSources = { 'peer-host': 'peer-host.c', 'consent-host': 'consent-host.swift' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const processProviders = new WeakSet();
export const isNativeProcessProvider = value => typeof value === 'function' && processProviders.has(value);
function ordinary(path, mode) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
      stat.mode & 0o022 || stat.uid !== process.getuid() && stat.uid !== 0 ||
      mode !== undefined && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== mode)) throw Error('HOST_PACKAGE_MISMATCH');
  return readFileSync(path);
}
function privateDirectory(path) {
  const stat = lstatSync(path);
  if (!isAbsolute(path) || normalize(path) !== path || !stat.isDirectory() || stat.isSymbolicLink() ||
      realpathSync(path) !== path || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw Error('HOST_CACHE_UNSAFE');
}
function createPrivateCache(path) {
  if (!isAbsolute(path) || normalize(path) !== path) throw Error('HOST_CACHE_UNSAFE');
  // Check existing ancestors before recursive mkdir so a linked parent cannot
  // redirect even a rejected build's directory creation.
  for (let parent = path; ; parent = dirname(parent)) {
    try {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent) throw Error('HOST_CACHE_UNSAFE');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(parent) === parent) break;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 }); privateDirectory(path);
}
function sourceBytes(sourceRoot, hashes) {
  const bytes = {};
  for (const name of Object.keys(hashes)) {
    bytes[name] = ordinary(join(sourceRoot, name));
    if (digest(bytes[name]) !== hashes[name]) throw Error('HOST_SOURCE_MISMATCH');
  }
  return bytes;
}
function validateBuild(build) {
  privateDirectory(build.cacheRoot); privateDirectory(build.directory);
  sourceBytes(build.sourceRoot, build.sources);
  if (digest(ordinary(build.record, 0o600)) !== build.recordHash) throw Error('HOST_PACKAGE_MISMATCH');
  for (const name of Object.keys(build.binaries))
    if (digest(ordinary(join(build.directory, name), 0o700)) !== build.binaries[name]) throw Error('HOST_PACKAGE_MISMATCH');
}
function executable(name, receipt) {
  const build = nativeBuilds.get(receipt);
  if (process.platform !== 'darwin' || !build || build.node !== process.version || !Object.hasOwn(build.binaries, name)) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
  try { validateBuild(build); return join(build.directory, name); }
  catch { throw Error('HOST_PACKAGE_MISMATCH'); }
}
export const environment = () => ({ PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' });
// A cached binary's compile path is temporary. Resolve the card asset from the installed trusted JS package instead.
export const consentEnvironment = () => ({ ...environment(),
  SLEIGHT_BUILTIN_CHARACTERS: fileURLToPath(new URL('../../characters/', import.meta.url)).replace(/\/$/, ''),
  SLEIGHT_CONSENT_ICON: fileURLToPath(new URL('../../assets/icon.png', import.meta.url)) });

// A cold module cache rebuilds AppKit's modules: over 120 s at load 31 to 38 (2026-10-14), so first use allows 300 s.
async function compileNative({ name, source, binary, moduleCache, signal }) {
  const args = name === 'peer-host' ? ['clang', '-Wall', '-Werror', '-fmodules-cache-path=' + moduleCache, source, '-lbsm', '-o', binary]
    : ['swiftc', '-module-cache-path', moduleCache, source, '-o', binary];
  // Abort can reject before close. Keep the bank and lock until the compiler has closed its pipes.
  await new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let failure, stderr = '';
    // swiftc starts swift-frontend children that inherit its pipes. Own the whole
    // group so a deadline or turn abort cannot leave a compiler using the bank.
    const child = spawn('/usr/bin/xcrun', args, { env: environment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = error => {
      failure ??= error;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') failure = error; }
      }
    };
    const abort = () => stop(Object.assign(Error('Native helper build aborted.'), { name: 'AbortError', code: 'ABORT_ERR' }));
    const timer = setTimeout(() => stop(Object.assign(Error('Native helper build timed out.'), { killed: true })), 300000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      let length = 0;
      stream.on('data', bytes => {
        if (name === 'stderr') stderr += bytes.subarray(0, Math.max(0, 65536 - length)).toString('utf8');
        length += bytes.length;
        if (length > 65536) stop(Object.assign(Error('Native helper compiler output exceeded its limit.'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }));
      });
    }
    child.once('error', error => stop(error));
    child.once('close', (code, killedBy) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (code !== 0 || killedBy) failure ??= Object.assign(Error('Native helper compiler failed.'), { code, signal: killedBy });
      if (failure && killedBy) failure.signal ??= killedBy;
      if (failure) { failure.stderr = stderr; reject(failure); } else resolve();
    });
  });
}

function helperSourceHashes(inventory, selectedSources = helperSources) {
  const hashes = {};
  for (const name of Object.values(selectedSources)) {
    const entries = inventory.files.filter(file => file.path === 'native/' + name || file.path?.endsWith('/native/' + name));
    if (entries.length !== 1 || !/^[a-f0-9]{64}$/.test(entries[0].sha256 ?? '')) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
    hashes[name] = entries[0].sha256;
  }
  return hashes;
}
const helperBuildKey = hashes => digest(JSON.stringify({ protocol: 1, arch: process.arch, sources: hashes }));
const defaultHelperCache = () => join(userInfo().homedir, 'Library/Caches/sleight/turbo-host');

// Read-only: whether the helpers for this receipt are already compiled. Doctor uses it. It never builds or validates a binary.
export function nativeHelpersBuilt({ inventory, cacheRoot = defaultHelperCache() } = {}) {
  try {
    const hashes = helperSourceHashes(inventory), directory = join(cacheRoot, helperBuildKey(hashes));
    const data = JSON.parse(readFileSync(join(directory, 'build.json'), 'utf8'));
    return data.protocol === 1 && data.arch === process.arch && JSON.stringify(data.sources) === JSON.stringify(hashes) &&
      Object.keys(helperSources).every(name => lstatSync(join(directory, name)).isFile());
  } catch { return false; }
}

// The build lock is a private folder holding its owner's pid, process start and creation time. A session killed mid-compile
// leaves it behind (the ghost hand builds in the background of any session), so a later build reclaims a lock whose owner is
// gone, whose pid now belongs to a process that started later, or that is older than two compiles' deadline. A lock with no
// owner record yet is reclaimed only past that age, since its owner may be between creating it and writing the record.
const lockLimit = 600000;
const ownStart = () => Date.now() - process.uptime() * 1000;
function processStart(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) { return error.code === 'EPERM' ? Infinity : undefined; }
  try {
    const text = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: environment(), timeout: 2000, encoding: 'utf8' }).trim();
    return Date.parse(text) || Infinity;
  } catch { return Infinity; }
}
function staleLock(lock) {
  const stat = lstatSync(lock);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('HOST_CACHE_UNSAFE');
  let owner;
  try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); } catch {}
  if (!Number.isSafeInteger(owner?.pid) || !Number.isFinite(owner?.created)) return Date.now() - stat.mtimeMs > lockLimit && stat;
  if (Date.now() - owner.created > lockLimit) return stat;
  const started = processStart(owner.pid);
  // ps reports start times to the second.
  return (started === undefined || started !== Infinity && Number.isFinite(owner.started) && Math.abs(started - owner.started) > 2000) && stat;
}
function takeLock(lock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let made = false;
    try {
      mkdirSync(lock, { mode: 0o700 }); made = true;
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: ownStart(), created: Date.now() }), { mode: 0o600, flag: 'wx' });
      return true;
    } catch (error) {
      if (made) rmSync(lock, { recursive: true, force: true });
      if (error.code !== 'EEXIST' || made) throw error;
    }
    const stale = attempt === 0 && staleLock(lock);
    if (!stale) return false;
    // Move the stale lock aside, then check it is the folder judged stale and not a newer builder's.
    const aside = `${lock}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
    try { renameSync(lock, aside); } catch { return false; }
    if (lstatSync(aside).ino !== stale.ino) { try { renameSync(aside, lock); } catch {} return false; }
    rmSync(aside, { recursive: true, force: true });
  }
  return false;
}
function releaseLock(lock) {
  try {
    if (JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).pid === process.pid) rmSync(lock, { recursive: true, force: true });
  } catch {}
}

// Internal loader options, never exposed as tool arguments. Compile staged exact
// source bytes and publish the bank only after both artifacts pass validation.
export function prepareNativeHelpers(options = {}) { return prepareHelpers(options, helperSources); }
// PDF parsing is compiled only on its first read, with the same accepted-source and private-bank checks.
export function preparePdfHelper(options = {}) { return prepareHelpers(options, { 'pdf-host': 'pdf-host.swift' }); }
async function prepareHelpers({ inventory, cacheRoot = defaultHelperCache(),
  sourceRoot = sources, compile = compileNative, onProgress = () => {}, signal } = {}, selectedSources) {
  if (inventory?.accepted !== true || inventory.protocol !== 1 || inventory.helperMode !== 'source' ||
      inventory.node !== process.version || !Array.isArray(inventory.files)) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
  const hashes = helperSourceHashes(inventory, selectedSources);
  const started = Date.now(), key = helperBuildKey(hashes);
  let stage = 'sources', helper;
  const scrub = value => String(value).split(cacheRoot).join('<helper-cache>').split(sourceRoot).join('<helper-sources>')
    .split(userInfo().homedir).join('~').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 4096);
  const detail = () => ({ stage, ...helper ? { helper, compiler: helper === 'peer-host' ? 'clang' : 'swiftc', timeoutMs: 300000 } : {},
    cacheRoot: cacheRoot.split(userInfo().homedir).join('~'), key, sources: hashes, elapsedMs: Date.now() - started });
  const progress = extra => { try { onProgress({ ...detail(), ...extra }); } catch {} };
  const unavailable = (code, extra = {}) => {
    const diagnostic = Object.freeze({ ...detail(), ...extra });
    progress({ status: 'unavailable', code, ...extra });
    return Object.freeze({ status: 'unavailable', code, detail: diagnostic, fallback: 'engine',
      message: code === 'NATIVE_HELPERS_UNAVAILABLE' ? 'Turbo native helpers need Apple command-line tools and a successful local build. Keep using the engine path.'
        : 'Turbo native helpers are unavailable. Keep using the engine path.' });
  };
  if (process.platform !== 'darwin') return unavailable('NATIVE_HELPERS_UNAVAILABLE');
  let bank, locked = false;
  const lock = join(cacheRoot, 'build.lock');
  try {
    signal?.throwIfAborted();
    const bytes = sourceBytes(sourceRoot, hashes);
    stage = 'cache'; progress();
    createPrivateCache(cacheRoot);
    const directory = join(cacheRoot, key), record = join(directory, 'build.json');
    const cached = () => {
      const contents = ordinary(record, 0o600), data = JSON.parse(contents);
      if (data.protocol !== 1 || data.arch !== process.arch || JSON.stringify(data.sources) !== JSON.stringify(hashes)) throw Error();
      if (!data.binaries || Object.keys(data.binaries).sort().join(',') !== Object.keys(selectedSources).sort().join(',')) throw Error();
      const build = { cacheRoot, directory, record, sourceRoot, sources: hashes, binaries: data.binaries, recordHash: digest(contents), node: process.version };
      validateBuild(build);
      const receipt = Object.freeze({}); nativeBuilds.set(receipt, build);
      return Object.freeze({ status: 'ready', directory, record, receipt });
    };
    try { const result = cached(); progress({ status: 'ready', cached: true }); return result; } catch {}
    stage = 'lock'; progress();
    if (!takeLock(lock)) return unavailable('HOST_BUILD_BUSY');
    locked = true;
    bank = mkdtempSync(join(cacheRoot, 'build-')); chmodSync(bank, 0o700);
    const moduleCache = join(bank, 'module-cache'); mkdirSync(moduleCache, { mode: 0o700 });
    const binaries = {};
    for (const [name, filename] of Object.entries(selectedSources)) {
      signal?.throwIfAborted();
      stage = 'compile'; helper = name; progress();
      const source = join(bank, filename), binary = join(bank, name);
      writeFileSync(source, bytes[filename], { mode: 0o600, flag: 'wx' });
      await compile({ name, source, binary, moduleCache, bank, signal });
      signal?.throwIfAborted();
      chmodSync(binary, 0o700); binaries[name] = digest(ordinary(binary, 0o700));
      if (digest(ordinary(source, 0o600)) !== hashes[filename]) throw Error('HOST_SOURCE_MISMATCH');
    }
    stage = 'publish'; helper = undefined; progress();
    sourceBytes(sourceRoot, hashes);
    writeFileSync(join(bank, 'build.json'), JSON.stringify({ protocol: 1, arch: process.arch, sources: hashes, binaries }), { mode: 0o600, flag: 'wx' });
    // Replacement is limited to our validated private bank, never a linked or
    // external directory. Running processes retain their old executable inode.
    try { privateDirectory(directory); rmSync(directory, { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    renameSync(bank, directory); bank = undefined;
    const result = cached(); progress({ status: 'ready', cached: false }); return result;
  } catch (error) {
    return unavailable(['HOST_CACHE_UNSAFE', 'HOST_SOURCE_MISMATCH'].includes(error.message) ? error.message : 'NATIVE_HELPERS_UNAVAILABLE', {
      ...error.name === 'AbortError' ? { errorCode: 'ABORT_ERR' } : typeof error.code === 'string' ? { errorCode: error.code } : {},
      ...Number.isInteger(error.code) ? { exitCode: error.code } : {},
      ...error.signal ? { signal: error.signal } : {}, ...error.killed ? { killed: true } : {},
      ...error.stderr ? { stderr: scrub(error.stderr) } : {},
    });
  } finally {
    if (bank) rmSync(bank, { recursive: true, force: true });
    if (locked) releaseLock(lock);
  }
}

// Data only on stdin. PDFKit never creates a view, runs actions, or opens another application.
export async function extractPdf(receipt, path, { page = 0, offset = 0 } = {}, { signal } = {}) {
  const binary = executable('pdf-host', receipt);
  return new Promise((resolve, reject) => {
    let failure, output;
    const child = execFile(binary, [], { env: environment(), timeout: 10000, maxBuffer: 300000, killSignal: 'SIGKILL', signal }, (error, stdout) => {
      failure = error; output = stdout;
    });
    child.once('close', () => {
      if (failure) return reject(Error('PDF text extraction failed or timed out.'));
      try { resolve(JSON.parse(output)); } catch { reject(Error('PDF helper returned invalid data.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ path, page, offset }));
  });
}

/** Parses peer-host output for pid: --process-pid (code false) or --code-status (code true, which adds the kernel's
 *  code-signing status flags, the running architecture and the running cdhash). Throws on any other shape. */
export function parseProcessMetadata(stdout, pid, code = false) {
  const metadata = immutableJSON(JSON.parse(stdout));
  if (Object.keys(metadata).length !== (code ? 7 : 4) || metadata.uid !== process.getuid() || metadata.pid !== pid ||
      !Number.isFinite(metadata.start) || metadata.start <= 0 ||
      !new RegExp('^p' + pid + '-s[1-9]\\d*-u\\d+$').test(metadata.incarnation)) throw Error();
  if (code && (!Number.isSafeInteger(metadata.flags) || metadata.flags < 0 || metadata.flags > 0xffffffff ||
      !/^(arm64e?|x86_64h?)$/.test(metadata.arch) || !/^[0-9a-f]{40}$/.test(metadata.cdhash))) throw Error();
  return metadata;
}

// Private loader capability. Only the compiled, receipt-bound peer helper may
// observe a selected PID; callers cannot supply native output or an executable
// helper. The helper checks UID, canonical executable and birth on both reads.
// provider.codeStatus reads the same metadata plus the live code-signing status (executable-trust.mjs).
export function createNativeProcessProvider(receipt) {
  executable('peer-host', receipt);
  const read = (mode, code, failure) => async (pid, expected) => {
    if (!Number.isSafeInteger(pid) || pid < 1 || typeof expected !== 'string' ||
        !isAbsolute(expected) || normalize(expected) !== expected) throw Error(failure);
    try {
      // A helper that its timeout killed runs once more; a helper that refused (exit 64 or 65) is final.
      const { stdout } = await runOnceMore(promisify(execFile), executable('peer-host', receipt),
        [mode, String(pid), expected], { env: environment(), timeout: 3000, maxBuffer: 1024 });
      return parseProcessMetadata(stdout, pid, code);
    } catch { throw Error(failure); }
  };
  const provider = read('--process-pid', false, 'SELECTED_PROCESS_UNPROVED');
  provider.codeStatus = read('--code-status', true, 'SELECTED_SIGNATURE_UNPROVED');
  Object.freeze(provider);
  processProviders.add(provider); return provider;
}

// Pure private channel parser. read/write are inherited pipes of the selected
// child, never a local socket, page bridge or model endpoint. Tests inject streams
// solely to test framing/replay logic, not to claim native-user authentication.
export function createUiChannel({ read, write, onLoss = () => {}, discardOldNonce = false }) {
  const nonce = randomBytes(32).toString('hex'), pending = new Map(), retired = new Map(), events = new WeakSet();
  const retire = (id, record) => { retired.set(id, record); if (retired.size > 256) retired.delete(retired.keys().next().value); };
  let buffer = '', closed = false;
  const lose = () => { if (closed) return; closed = true; pending.clear(); onLoss(); };
  read.on('data', chunk => {
    try {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 131072) throw Error();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const raw = immutableJSON(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
        // A successor worker inherits the same session pipe. Only a reply to its fresh nonce can authenticate.
        if (discardOldNonce && raw?.nonce !== nonce && /^[0-9a-f]{64}$/.test(raw?.nonce ?? '')) continue;
        const old = retired.get(raw.id);
        if (old?.dismissed && raw.nonce === nonce && Object.keys(raw).length === 3 && old.choices.includes(raw.choice)) continue;
        const record = pending.get(raw.id);
        if (!record || raw.nonce !== nonce || Object.keys(raw).length !== 3 ||
            !record.choices.includes(raw.choice) || Date.now() >= record.deadline) throw Error();
        pending.delete(raw.id); retire(raw.id, record);
        const event = Object.freeze({ id: raw.id, choice: raw.choice, action: raw.choice,
          selection: record.selection });
        events.add(event); Promise.resolve(record.deliver(event)).catch(lose);
      }
    } catch { lose(); }
  });
  read.on('end', lose); read.on('error', lose); write.on('error', lose);
  const channel = Object.freeze({
    present(id, data, choices, deliver, { selection, deadline = Date.now() + 30000 } = {}) {
      for (const [key, record] of pending) if (Date.now() >= record.deadline || data?.status && record.status) pending.delete(key);
      if (closed || pending.has(id) || pending.size >= 32 || typeof id !== 'string' ||
          !Array.isArray(choices) || !choices.length || typeof deliver !== 'function' ||
          !Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 300000) throw Error('TRUSTED_UI_UNAVAILABLE');
      const frame = immutableJSON({ id, nonce, data, choices, deadline });
      if (Buffer.byteLength(JSON.stringify(frame)) > 65536) throw Error('TRUSTED_UI_UNAVAILABLE');
      pending.set(id, { choices: [...choices], deliver, status: data?.status,
        selection: selection && immutableJSON(selection), deadline });
      write.write(JSON.stringify(frame) + '\n');
    },
    authenticate(event) { if (!event || !events.has(event)) return false; events.delete(event); return !closed; },
    dismiss(id) {
      if (closed) return;
      const record = pending.get(id) ?? retired.get(id);
      if (!record || record.dismissed) return;
      pending.delete(id); retire(id, { ...record, dismissed: true });
      write.write(JSON.stringify({ id, nonce, dismiss: true }) + '\n');
    },
    revoke() { pending.clear(); },
    close() { lose(); write.end(); },
  });
  return channel;
}

// The ghost hand runs the consent host's binary with --hand, from the same build and cache. Its inventory is the helper sources
// on disk, hashed now: the hand only draws, so it needs no turbo acceptance, and its handle can start only the hand, never the
// consent channel or the peer helper. A build for one serves the other when the sources match.
function handInventory(sourceRoot) {
  return { accepted: true, protocol: 1, node: process.version, helperMode: 'source',
    files: Object.values(helperSources).map(name => ({ path: 'native/' + name, sha256: digest(ordinary(join(sourceRoot, name))) })) };
}
export function handHostBuilt({ cacheRoot = defaultHelperCache(), sourceRoot = sources } = {}) {
  try { return nativeHelpersBuilt({ inventory: handInventory(sourceRoot), cacheRoot }); } catch { return false; }
}
// Whether Apple's command-line tools are installed, asked through xcode-select: xcrun without them opens macOS's install
// dialog, which a background build must never put in front of the person.
export async function appleToolsPresent({ run = promisify(execFile), exists = existsSync } = {}) {
  try {
    const { stdout } = await run('/usr/bin/xcode-select', ['-p'], { env: environment(), timeout: 5000, maxBuffer: 4096 });
    const dir = String(stdout).trim();
    if (!isAbsolute(dir) || normalize(dir) !== dir) return false;
    return ['swiftc', 'clang'].every(tool => ['usr/bin', 'Toolchains/XcodeDefault.xctoolchain/usr/bin'].some(folder => exists(join(dir, folder, tool))));
  } catch { return false; }
}
export const handCursorStyles = Object.freeze(['glove', 'ring', 'seam', 'sprite']);
async function handBuild({ cacheRoot = defaultHelperCache(), sourceRoot = sources, compile = compileNative,
  tools = appleToolsPresent, onProgress, signal } = {}) {
  let inventory;
  try { inventory = handInventory(sourceRoot); } catch { return Object.freeze({ status: 'unavailable', code: 'HOST_SOURCE_MISMATCH' }); }
  if (!nativeHelpersBuilt({ inventory, cacheRoot }) && !await tools()) return Object.freeze({ status: 'unavailable', code: 'APPLE_TOOLS_MISSING' });
  const built = await prepareNativeHelpers({ inventory, cacheRoot, sourceRoot, compile, onProgress, signal });
  return built.status === 'ready' ? built : Object.freeze({ status: built.status, code: built.code, detail: built.detail });
}
export async function prepareHandHost(options = {}) {
  const built = await handBuild(options);
  if (built.status !== 'ready') return built;
  const { receipt } = built;
  // capture is 'hidden' (absent from every capture) or 'visible' (screenshots and recordings show the hand). The host is the
  // session's: hand frames on stdin and control events on stdout. Session clients open fds 3 and 4 at first use, then
  // pass those consent pipes to each turbo worker. --menu remains available to standalone hand clients. cursorStyle is the
  // glove, the Split Seam+ ring or plain Split Seam ('seam', for comparison).
  return Object.freeze({ status: 'ready', spawn: ({ capture = 'hidden', consent = false, cursorStyle = 'glove' } = {}) => {
    if (!['hidden', 'visible'].includes(capture) || typeof consent !== 'boolean') throw Error('HAND_CAPTURE_INVALID');
    if (!handCursorStyles.includes(cursorStyle)) throw Error('HAND_CURSOR_STYLE_INVALID');
    return spawn(executable('consent-host', receipt), ['--hand', '--capture=' + capture, '--cursor-style=' + cursorStyle, consent ? '--consent' : '--menu'],
      { env: consentEnvironment(), stdio: ['pipe', 'pipe', 'ignore', ...consent ? ['pipe', 'pipe'] : []] });
  }, checkCharacter: (frame, options) => checkCharacterInHost(executable('consent-host', receipt), frame, options) });
}
// The live host's own checks for a character frame (hand/character-frame.mjs), through the same sandboxed decode child:
// { id, loaded, reason, warnings }. `sleight-mcp cursor check` shows the reason the host would draw the ring alone.
export function checkCharacterInHost(binary, frame, { run = spawn, timeoutMs = 10000, root } = {}) {
  return new Promise((resolve, reject) => {
    const child = run(binary, ['--check-character', ...root ? [root] : []], { env: consentEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('CHARACTER_CHECK_TIMEOUT')); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; if (out.length > 4096) child.kill('SIGKILL'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      let result;
      try { result = JSON.parse(out.split('\n')[0]); } catch {}
      const keys = result && typeof result === 'object' ? Object.keys(result).sort().join() : '';
      if (code !== 0 || keys !== 'id,loaded,reason,warnings') return reject(Error('CHARACTER_CHECK_FAILED'));
      resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(frame) + '\n');
  });
}

// The person confirmation for high-stakes settings changes (person-confirm.mjs): the same binary and build as the hand, in its
// --confirm-person mode, which shows only macOS's own Touch ID or password sheet and opens no window of its own. Its key
// and subject are checked again against the host's fixed table. notice(text) hears about a first-use build.
// The build is the one keyed by the source hashed now (handInventory). The binary that runs is a private copy of bytes read
// through one open file and hashed there, which closes a swap between the path check and the hash. The copy goes in a fresh
// 0700 run-<random> folder beside the build cache (~/Library/Caches/sleight, which the guard hook keeps Claude's tools out
// of). It's removed when the helper exits or fails to start, and when this process exits or gets SIGINT, SIGTERM or SIGHUP.
// The child carries what it must report on its first line, which person-confirm.mjs compares; that narrows the window
// between writing the copy and running it, though code running as the same user still owns it. The build record the hash
// is checked against is in the same cache (docs/design/person-confirm.md). run is a test seam for spawn.
const CONFIRM_KEY = /^[a-z][a-z-]{0,39}$/;
function privateParent(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.uid !== process.getuid() || stat.mode & 0o022) throw Error('HOST_CACHE_UNSAFE');
}
// Run folders a killed launcher left behind, older than 10 minutes (a confirmation lasts at most about 62 s).
function sweepRuns(runRoot, now = Date.now()) {
  let names;
  try { names = readdirSync(runRoot); } catch { return; }
  for (const name of names.filter(name => /^run-[A-Za-z0-9]{6}$/.test(name))) {
    try {
      const path = join(runRoot, name), stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && now - stat.mtimeMs > 600000) rmSync(path, { recursive: true, force: true });
    } catch {}
  }
}
export async function prepareConfirmHost({ notice = () => {}, run = spawn, ...options } = {}) {
  if (process.platform !== 'darwin') return Object.freeze({ status: 'unavailable', code: 'PLATFORM' });
  if (!handHostBuilt(options)) notice('sleight: building the confirmation helper from source (first use, up to a few minutes).\n');
  const built = await handBuild(options);
  if (built.status !== 'ready') return built;
  const { receipt } = built, runRoot = dirname(options.cacheRoot ?? defaultHelperCache());
  return Object.freeze({ status: 'ready', spawn: (key, subject) => {
    if (!CONFIRM_KEY.test(key) || subject !== undefined && (typeof subject !== 'string' || subject.length > 100)) throw Error('CONFIRM_INVALID');
    const path = executable('consent-host', receipt), expected = nativeBuilds.get(receipt).binaries['consent-host'];
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o022) throw Error('HOST_PACKAGE_MISMATCH');
      bytes = readFileSync(fd);
    } finally { closeSync(fd); }
    if (digest(bytes) !== expected) throw Error('HOST_PACKAGE_MISMATCH');
    privateParent(runRoot);
    sweepRuns(runRoot);
    const folder = mkdtempSync(join(runRoot, 'run-')), copy = join(folder, 'consent-host');
    let child;
    // Ctrl-C reaches the helper too, which withdraws its sheet and exits; SIGTERM or SIGHUP to the launcher alone stops the
    // helper here. Either way the folder goes at once, and so it does on a throw or this process's exit.
    const stop = () => { try { child?.kill('SIGTERM'); } catch {} remove(); };
    const remove = () => {
      try { rmSync(folder, { recursive: true, force: true }); } catch {}
      process.off('exit', remove); for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
    };
    process.on('exit', remove); for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
    try {
      chmodSync(folder, 0o700); privateDirectory(folder);
      writeFileSync(copy, bytes, { mode: 0o700, flag: 'wx' });
      child = run(copy, ['--confirm-person', key, ...subject === undefined ? [] : [subject]], { env: environment(), stdio: ['ignore', 'pipe', 'ignore'] });
      child.once('exit', remove); child.once('error', remove);
    } catch (error) { remove(); throw error; }
    child.sleightExpected = Object.freeze({ path: copy, sha256: expected });
    return child;
  } });
}

// The worker's end of the session's shared host: the same consent channel over the fds the relay passed at fork (4 writes to
// the host's fd 3, 5 reads its fd 4). Only a receipt holder opens it, as with createNativeUi.
export function createSharedUi(receipt, onLoss, { fds = [4, 5] } = {}) {
  executable('consent-host', receipt);
  const write = new Socket({ fd: fds[0], readable: false, writable: true }), read = new Socket({ fd: fds[1], readable: true, writable: false });
  return createUiChannel({ read, write, onLoss, discardOldNonce: true });
}

export function createNativeUi(receipt, onLoss) {
  const path = executable('consent-host', receipt);
  const child = spawn(path, [], { env: consentEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] });
  const channel = createUiChannel({ read: child.stdout, write: child.stdin, onLoss });
  child.on('error', () => channel.close()); child.on('close', () => channel.close());
  return channel;
}

export async function prepareHandoffUi() {
  const built = await prepareNativeHelpers({ inventory: handInventory(sources) });
  if (built.status !== 'ready') throw Error('TRUSTED_UI_UNAVAILABLE');
  return createNativeUi(built.receipt);
}
