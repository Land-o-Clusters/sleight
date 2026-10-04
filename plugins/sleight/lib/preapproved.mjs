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
      if (!fields(entry, ['app', 'riskLevel']) || typeof entry.app !== 'string' || !entry.app.trim() ||
          entry.app !== entry.app.trim() || /[\u0000-\u001f\u007f*]/.test(entry.app) ||
          !RISK.has(entry.riskLevel) || this.#apps.has(entry.app)) throw error('invalid or duplicate app entry');
      this.#apps.set(entry.app, RISK.get(entry.riskLevel));
    }
  }
  get size() { return this.#apps.size; }
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
export function loadPreapproved(io = fs) {
  let fd;
  try {
    const user = userInfo();
    const file = join(user.homedir, 'Library/Application Support/sleight/preapproved.json');
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
