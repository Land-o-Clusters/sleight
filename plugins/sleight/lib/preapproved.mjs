// Authority comes only from the OS user's private file, never project settings or HOME.
import * as fs from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

const RISK = new Map([['low', 0], ['medium', 1], ['high', 2]]);
const error = message => new Error(`Preapproved apps: ${message}`);
const fields = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) &&
  Object.keys(object).every(key => keys.includes(key));

export class PreapprovedApps {
  #apps = new Map();
  constructor(config) {
    if (!fields(config, ['version', 'apps']) || config.version !== 1 || !Array.isArray(config.apps)) {
      throw error('expected version 1 and an apps array');
    }
    for (const entry of config.apps) {
      // `added` and `source` record an "Always allow" click (owner, 2026-10-10); hand-written entries omit them.
      if (!fields(entry, ['app', 'riskLevel', 'added', 'source']) || typeof entry.app !== 'string' || !entry.app.trim() ||
          (entry.added !== undefined && !/^\d{4}-\d\d-\d\d$/.test(entry.added)) ||
          (entry.source !== undefined && entry.source !== 'always-allow') ||
          entry.app !== entry.app.trim() || /[\u0000-\u001f\u007f*]/.test(entry.app) ||
          !RISK.has(entry.riskLevel) || this.#apps.has(entry.app)) throw error('invalid or duplicate app entry');
      this.#apps.set(entry.app, RISK.get(entry.riskLevel));
    }
  }
  get size() { return this.#apps.size; }
  // The user's own "Always allow" click, applied for the rest of this session as well.
  add(app, riskLevel) {
    if (RISK.has(riskLevel) && RISK.get(riskLevel) > (this.#apps.get(app) ?? -1)) this.#apps.set(app, RISK.get(riskLevel));
  }
  allows(app, riskLevel) {
    return this.#apps.has(app) && RISK.has(riskLevel) && RISK.get(riskLevel) <= this.#apps.get(app);
  }
}

function validate(stat, uid) {
  if (stat.isSymbolicLink()) throw error('symlinks are refused');
  if (!stat.isFile()) throw error('expected a regular file');
  if (stat.uid !== uid) throw error('file owner must be the current user');
  if (stat.mode & 0o022) throw error('group- or world-writable files are refused');
  if (stat.size > 1024 * 1024) throw error('file exceeds 1 MiB');
}

// The optional filesystem boundary lets unit tests use private fixtures. Startup
// calls this with no arguments; there is no environment or settings path option.
export const preapprovedFile = (home = userInfo().homedir) => join(home, 'Library/Application Support/sleight/preapproved.json');

// The list's raw entries, for showing and editing. Missing means empty; anything invalid throws.
function readList(io, file, uid) {
  let fd;
  try {
    let before;
    try { before = io.lstatSync(file); } catch (err) { if (err.code === 'ENOENT') return { version: 1, apps: [] }; throw err; }
    validate(before, uid);
    fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    validate(io.fstatSync(fd), uid);
    const config = JSON.parse(io.readFileSync(fd, 'utf8'));
    new PreapprovedApps(config); // validates
    return config;
  } finally { if (fd !== undefined) io.closeSync(fd); }
}

// Writes the whole list through a private temporary file and a rename, so a reader never sees half of it.
function writeList(io, file, config) {
  io.mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  io.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  io.renameSync(temp, file);
}

// The user clicked "Always allow" for this app: add it at the request's risk level with the date,
// or raise a lower level already listed. Only sleight's approval prompt calls this, never Claude.
export function addPreapproved(app, riskLevel, { io = fs, home = userInfo().homedir, uid = userInfo().uid, now = new Date() } = {}) {
  if (typeof app !== 'string' || !app.trim() || !RISK.has(riskLevel)) throw error('invalid app or risk level');
  const file = preapprovedFile(home);
  const config = readList(io, file, uid);
  const existing = config.apps.find(entry => entry.app === app);
  if (existing && RISK.get(existing.riskLevel) >= RISK.get(riskLevel)) return false;
  if (existing) existing.riskLevel = riskLevel;
  else config.apps.push({ app, riskLevel, added: now.toISOString().slice(0, 10), source: 'always-allow' });
  writeList(io, file, config);
  return true;
}

export function removePreapproved(app, { io = fs, home = userInfo().homedir, uid = userInfo().uid } = {}) {
  const file = preapprovedFile(home);
  const config = readList(io, file, uid);
  const kept = config.apps.filter(entry => entry.app !== app);
  if (kept.length === config.apps.length) return false;
  writeList(io, file, { ...config, apps: kept });
  return true;
}

export function listPreapproved({ io = fs, home = userInfo().homedir, uid = userInfo().uid } = {}) {
  return readList(io, preapprovedFile(home), uid).apps;
}

export function loadPreapproved(io = fs) {
  let fd;
  try {
    const user = userInfo();
    const file = preapprovedFile(user.homedir);
    let before;
    try { before = io.lstatSync(file); } catch (err) {
      if (err.code === 'ENOENT') return new PreapprovedApps({ version: 1, apps: [] });
      throw err;
    }
    validate(before, user.uid);
    if (io.realpathSync(file) !== file) throw error('symlinked paths are refused');
    fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = io.fstatSync(fd);
    validate(opened, user.uid);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw error('file changed while opening');
    return new PreapprovedApps(JSON.parse(io.readFileSync(fd, 'utf8')));
  } catch (err) { throw err.message.startsWith('Preapproved apps:') ? err : error(err.message); }
  finally { if (fd !== undefined) io.closeSync(fd); }
}
