// Built-in stage strips are disposable, private data. Base art remains package-pinned.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { BUILTIN_CHARACTER_IDS, STAGE_STATES, stageFilename, parseCharacterJSON, resolveStageStates } from './character.mjs';
import { processStartTime, sameProcessStart } from '../routine-lock.mjs';
import { writePrivateFileAtomic } from '../../skills/make-character/tool/lib/atomic-private-file.mjs';

export const STAGE_RENDER_TIMEOUT_MS = 60000;
const PRUNE_AGE_MS = 10 * 60 * 1000;
export const characterStageDirectory = () => join(userInfo().homedir, 'Library', 'Application Support', 'sleight', 'character-stage');
const generator = fileURLToPath(new URL('../../skills/make-character/tool/', import.meta.url));
const worker = fileURLToPath(new URL('./character-stage-worker.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pause = ms => new Promise(done => setTimeout(done, ms));
const present = path => fs.lstatSync(path, { throwIfNoEntry: false }) !== undefined;

// Hash every shipped generator input, including the version, renderer, rigs, design and lines.
export function characterStageHash(character, { generatorRoot = generator } = {}) {
  const digest = createHash('sha256').update('sleight-stage-cache/1\0');
  function visit(folder, prefix = '') {
    for (const name of fs.readdirSync(folder).sort()) {
      const path = join(folder, name), relative = prefix + name, st = fs.lstatSync(path);
      if (st.isSymbolicLink()) throw Error('STAGE_GENERATOR_SYMLINK');
      if (st.isDirectory()) visit(path, relative + '/');
      else if (/\.(mjs|json)$/.test(name)) digest.update(relative + '\0').update(fs.readFileSync(path)).update('\0');
    }
  }
  visit(generatorRoot); digest.update(fs.readFileSync(worker));
  digest.update(character.manifest.id);
  for (const [name, bytes] of [...character.files].sort(([a], [b]) => a.localeCompare(b))) digest.update(name + '\0').update(bytes);
  return digest.digest('hex');
}

function directory(path, create = false) {
  if (!isAbsolute(path) || resolve(path) !== path) throw Error('STAGE_CACHE_PATH');
  if (create && !fs.existsSync(path)) {
    directoryParent(dirname(path));
    try { fs.mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const s = fs.lstatSync(path);
  if (!s.isDirectory() || fs.realpathSync(path) !== path || s.uid !== process.getuid() || (s.mode & 0o7777) !== 0o700) throw Error('STAGE_CACHE_PERMISSIONS');
  return s;
}
function directoryParent(path) {
  if (!fs.existsSync(path)) { directoryParent(dirname(path)); try { fs.mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const s = fs.lstatSync(path);
  if (!s.isDirectory() || fs.realpathSync(path) !== path || s.uid !== process.getuid() || (s.mode & 0o7022)) throw Error('STAGE_CACHE_PARENT');
}
function readPrivate(path, cap) {
  const before = fs.lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || (before.mode & 0o7777) !== 0o600 || before.size > cap) throw Error('STAGE_CACHE_PERMISSIONS');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.mode !== before.mode || opened.uid !== before.uid || opened.nlink !== 1 || opened.size !== before.size) throw Error('STAGE_CACHE_CHANGED');
    const bytes = Buffer.alloc(opened.size + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0), after = fs.fstatSync(fd);
    if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw Error('STAGE_CACHE_CHANGED');
    return bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}

function sameDirectory(path, stamp) {
  try { const live = directory(path); return live.dev === stamp.dev && live.ino === stamp.ino; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Missing or incomplete receipts get a creation grace period. A PID only owns its recorded process start.
function lockState(lock, timeoutMs) {
  const stamp = directory(lock);
  let owner;
  try { owner = JSON.parse(readPrivate(join(lock, 'owner.json'), 512)); }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && error.message !== 'STAGE_CACHE_CHANGED') throw error;
  }
  let dead = Date.now() - stamp.mtimeMs > timeoutMs + 5000;
  if (owner) {
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw Error('STAGE_CACHE_LOCK');
    try {
      process.kill(owner.pid, 0);
      const start = processStartTime(owner.pid);
      if (start && owner.startTime) dead = !sameProcessStart(owner.startTime, start);
    } catch (error) { if (error.code === 'ESRCH') dead = true; else if (error.code !== 'EPERM') throw error; }
  }
  return { stamp, dead };
}

function recoverDeadLock(lock, timeoutMs) {
  const recovery = lock + '.recover';
  const expired = stamp => Date.now() - stamp.mtimeMs > timeoutMs + 5000;
  try { fs.mkdirSync(recovery, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const stale = directory(recovery);
      if (!expired(stale)) return;
      // Recovery is synchronous and its directory stays empty. Never recursively delete an unknown holder.
      fs.rmdirSync(recovery);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  const holder = directory(recovery);
  try {
    const { stamp, dead } = lockState(lock, timeoutMs);
    if (dead && sameDirectory(recovery, holder) && sameDirectory(lock, stamp) && fs.lstatSync(lock).mtimeMs === stamp.mtimeMs) {
      fs.rmSync(lock, { recursive: true });
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { if (sameDirectory(recovery, holder)) fs.rmdirSync(recovery); }
}

// Check the whole disposable tree before moving or deleting it, including unreferenced files.
function privateTree(path) {
  directory(path);
  for (const name of fs.readdirSync(path)) {
    const child = join(path, name), st = fs.lstatSync(child);
    if (st.isDirectory()) privateTree(child);
    else if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o7777) !== 0o600) throw Error('STAGE_CACHE_PERMISSIONS');
  }
}

function prune(bank, key) {
  for (const name of fs.readdirSync(bank)) {
    if (name === key || !(/^[a-f0-9]{64}$/.test(name) || /^\.[a-f0-9]{64}-[A-Za-z0-9]{6}$/.test(name))) continue;
    const path = join(bank, name);
    try {
      const siblingKey = name.startsWith('.') ? name.slice(1, 65) : name;
      const siblingLock = join(bank, `.${siblingKey}.lock`);
      if (siblingKey !== key && present(siblingLock) && !lockState(siblingLock, STAGE_RENDER_TIMEOUT_MS).dead) continue;
      const stamp = directory(path);
      if (Date.now() - stamp.mtimeMs <= PRUNE_AGE_MS) continue;
      privateTree(path);
      if (sameDirectory(path, stamp)) fs.rmSync(path, { recursive: true });
    } catch {} // Hygiene never changes a successful render into a failure.
  }
}

function cached(character, folder, key, { receipt = true } = {}) {
  directory(folder); directory(join(folder, 'stage'));
  const stage = parseCharacterJSON(readPrivate(join(folder, 'stage.json'), 16383), 'stage.json');
  const stageManifestHash = hash(JSON.stringify(stage));
  if (Object.keys(stage.states ?? {}).sort().join() !== Object.keys(STAGE_STATES).sort().join()) throw Error('STAGE_CACHE_STATES');
  const files = new Map(character.files), pins = {}, names = fs.readdirSync(join(folder, 'stage')).sort();
  let total = character.total;
  if (names.length !== 21) throw Error('STAGE_CACHE_FILES');
  for (const name of names) {
    const relative = `stage/${name}`;
    if (!stageFilename(relative)) throw Error('STAGE_CACHE_FILENAME');
    const bytes = readPrivate(join(folder, relative), 4 * 1024 ** 2);
    total += bytes.length; if (total > 48 * 1024 ** 2) throw Error('STAGE_CACHE_SIZE');
    files.set(relative, bytes); pins[relative] = hash(bytes);
  }
  if (receipt) {
    const stamp = parseCharacterJSON(readPrivate(join(folder, 'receipt.json'), 16383), 'receipt.json');
    if (stamp.key !== key || stamp.stage !== hash(JSON.stringify(stage)) || JSON.stringify(stamp.pins) !== JSON.stringify(pins)) throw Error('STAGE_CACHE_HASH');
    if (fs.readdirSync(folder).sort().join() !== 'receipt.json,stage,stage.json') throw Error('STAGE_CACHE_FILES');
  }
  const manifest = { ...character.manifest, stage }, warnings = [];
  const resolved = resolveStageStates(manifest, files, warnings, character.perch);
  if (warnings.length || Object.values(resolved.states).some(s => !s.own)) throw Error('STAGE_CACHE_INVALID');
  return { ...character, manifest, stage: resolved, stageFolder: folder, stageKey: key, stagePins: pins, stageManifestHash };
}

function reusable(character, folder, key) {
  try { return cached(character, folder, key); }
  catch (error) {
    if (!['STAGE_CACHE_HASH', 'STAGE_CACHE_FILES'].includes(error.message)) throw error;
    readPrivate(join(folder, 'receipt.json'), 16383);
    privateTree(folder);
    return null;
  }
}

// The only executable path is shipped code. Seatbelt denies network. sips also uses the user's system temporary bank.
export function spawnStageRender({ id, output, timeoutMs = STAGE_RENDER_TIMEOUT_MS }) {
  if (process.platform !== 'darwin' || !BUILTIN_CHARACTER_IDS.includes(id)) return Promise.reject(Error('STAGE_RENDER_PLATFORM'));
  const imageTemp = fs.realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL' }).trim());
  directoryParent(imageTemp);
  const profile = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null") (subpath ${JSON.stringify(output)}) (subpath ${JSON.stringify(imageTemp)}))`;
  return new Promise((done, fail) => {
    const child = spawn('/usr/bin/nice', ['-n', '20', '/usr/bin/sandbox-exec', '-p', profile, process.execPath, worker, id, output], {
      stdio: ['ignore', 'ignore', 'pipe'], detached: true, cwd: output,
      env: { PATH: '/usr/bin:/bin', TMPDIR: output, HOME: output },
    });
    let timedOut = false, diagnostic = '';
    child.stderr.on('data', bytes => { if (diagnostic.length < 4096) diagnostic += bytes.toString().slice(0, 4096 - diagnostic.length); });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) done();
      else { const error = Error(timedOut ? 'STAGE_RENDER_TIMEOUT' : 'STAGE_RENDER_FAILED'); error.diagnostic = diagnostic; fail(error); }
    });
  });
}

export function createCharacterStageCache({ root = characterStageDirectory(), render = spawnStageRender, fingerprint = characterStageHash,
  timeoutMs = STAGE_RENDER_TIMEOUT_MS, log = line => process.stderr.write(line + '\n') } = {}) {
  const requests = new Map();
  return { ensure(character) {
    const id = character.manifest.id;
    if (!character.builtin || !BUILTIN_CHARACTER_IDS.includes(id)) return Promise.resolve(null);
    if (requests.has(id)) return requests.get(id);
    const work = (async () => {
      let lock, temp, damaged, ownerStamp;
      try {
        const key = fingerprint(character); if (!hex(key)) throw Error('STAGE_CACHE_KEY');
        directory(root, true); const bank = join(root, id); directory(bank, true);
        const output = join(bank, key); lock = join(bank, `.${key}.lock`);
        const deadline = Date.now() + timeoutMs + 5000;
        for (;;) {
          if (present(output)) { const hit = reusable(character, output, key); if (hit) return hit; }
          try {
            fs.mkdirSync(lock, { mode: 0o700 }); ownerStamp = directory(lock);
            const startTime = processStartTime(process.pid) ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
            writePrivateFileAtomic(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startTime }));
            break;
          } catch (error) { if (error.code !== 'EEXIST' || ownerStamp) throw error; recoverDeadLock(lock, timeoutMs); }
          if (Date.now() >= deadline) throw Error('STAGE_RENDER_BUSY');
          await pause(100);
        }
        // Another session may have published between the miss and lock acquisition.
        if (present(output)) {
          const hit = reusable(character, output, key); if (hit) return hit;
          damaged = fs.mkdtempSync(join(bank, `.${key}-`));
          fs.renameSync(output, join(damaged, 'damaged'));
        }
        temp = fs.mkdtempSync(join(bank, `.${key}-`)); fs.chmodSync(temp, 0o700);
        await render({ id, output: temp, timeoutMs });
        const built = cached(character, temp, key, { receipt: false });
        writePrivateFileAtomic(join(temp, 'receipt.json'), JSON.stringify({ key, stage: built.stageManifestHash, pins: built.stagePins }));
        cached(character, temp, key);
        if (!sameDirectory(lock, ownerStamp)) throw Error('STAGE_CACHE_LOCK');
        fs.renameSync(temp, output); temp = undefined;
        try { prune(bank, key); } catch {} // A published cache remains usable if cleanup fails.
        return { ...built, stageFolder: output };
      } catch (error) {
        const reason = /^[A-Z_]{1,64}$/.test(error.code ?? error.message) ? error.code ?? error.message : 'STAGE_RENDER_FAILED';
        try { log(`sleight: ${id} stage unavailable (${reason}); shown at medium`); } catch {}
        return null;
      } finally {
        if (temp) try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
        if (damaged) try { fs.rmSync(damaged, { recursive: true, force: true }); } catch {}
        if (ownerStamp) try { if (sameDirectory(lock, ownerStamp)) fs.rmSync(lock, { recursive: true }); } catch {}
      }
    })();
    requests.set(id, work); return work;
  } };
}
