import { execFileSync } from 'node:child_process';
import { realpathSync, statSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import { isAbsolute, join, dirname, relative } from 'node:path';
import { userInfo } from 'node:os';

export const supportsReplNode = flags => flags.has('--permission') && flags.has('--allow-net');
const probe = "JSON.stringify({version:process.version,permission:process.allowedNodeEnvironmentFlags.has('--permission'),net:process.allowedNodeEnvironmentFlags.has('--allow-net')})";
const machOMagic = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const identity = file => ({ dev: file.dev, ino: file.ino, mtimeMs: file.mtimeMs, size: file.size });
const sameFile = (before, after) => Object.keys(before).every(key => before[key] === after[key]);
function readMagic(path) {
  const fd = openSync(path, 'r'), bytes = Buffer.alloc(4);
  try { return bytes.subarray(0, readSync(fd, bytes, 0, 4, 0)); }
  finally { closeSync(fd); }
}

// Keep diagnostics bounded and never include exception text or ancestor paths.
export function nodeSelectionRefusals(selector) {
  const refusals = selector.refusals ?? (selector.lastRefusal ? [selector.lastRefusal] : []);
  const ordered = [...refusals.filter(row => row.reason !== 'missing'), ...refusals.filter(row => row.reason === 'missing')];
  return ordered.slice(0, 2).map(({ path, reason }) => `${path.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 128)}: ${reason}`).join('; ') +
    (refusals.length > 2 ? `; ${refusals.length - 2} more` : '');
}

// Negative results stay cached. Positive fallback results are checked on each
// selection (including every fork), with one new scan if the pinned file changes.
export function createReplNodeSelector({ node = process, platform = process.platform, env = process.env,
  home = () => userInfo().homedir, uid = process.getuid?.(), realpath = realpathSync, stat = statSync,
  lstat = lstatSync, magic = readMagic, cwd = () => process.cwd(), now = () => performance.now(), exec = execFileSync } = {}) {
  let checked = false, selected;
  const refusals = [];
  const refuse = (path, reason) => { refusals.push({ path, reason }); };
  function checkFile(executable) {
    const file = stat(executable);
    if (!file.isFile()) throw Error('not regular');
    if (file.uid !== 0 && file.uid !== uid) throw Error('owner');
    if ((file.mode & 0o6022) || !(file.mode & 0o111)) throw Error('mode');
    for (let parent = dirname(executable);;) {
      const directory = lstat(parent);
      if (!directory.isDirectory()) throw Error('ancestor not directory');
      if (directory.uid !== 0 && directory.uid !== uid) throw Error('ancestor owner');
      if ((directory.mode & 0o002) && !(directory.mode & 0o1000)) throw Error('ancestor mode');
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return identity(file);
  }
  const reasons = new Set(['not regular', 'owner', 'mode', 'ancestor not directory', 'ancestor owner', 'ancestor mode']);
  const reasonFor = error => error?.code === 'ENOENT' ? 'missing' : reasons.has(error?.message) ? error.message : 'unreadable';
  const valid = () => {
    try { return sameFile(selected.identity, checkFile(selected.execPath)); }
    catch { return false; }
  };
  const select = () => {
    if (checked) {
      if (!selected?.fallback || valid()) return selected;
      refuse(selected.execPath, 'changed');
      selected = undefined;
    }
    checked = true;
    const flags = node.allowedNodeEnvironmentFlags;
    if (supportsReplNode(flags)) return selected = { execPath: node.execPath, version: node.version, flags, fallback: false };
    if (platform !== 'darwin') return undefined;
    try {
      const deadline = now() + 6000, current = cwd();
      const inCwd = path => { const child = relative(current, path); return child === '' || child !== '..' && !child.startsWith('../') && !isAbsolute(child); };
      const paths = (env.PATH ?? '').split(':').filter(path => isAbsolute(path) && !inCwd(path)).map(directory => join(directory, 'node'));
      paths.push('/opt/homebrew/bin/node', '/usr/local/bin/node', join(home(), '.local/bin/node'));
      const seen = new Set();
      for (const path of paths) {
        if (now() >= deadline) { refuse(path, 'selection timeout'); break; }
        let stage = 'file';
        try {
          const executable = realpath(path);
          if (!isAbsolute(executable)) { refuse(path, 'relative target'); continue; }
          if (seen.has(executable)) continue;
          seen.add(executable);
          if (inCwd(executable)) { refuse(path, 'inside cwd'); continue; }
          const pinned = checkFile(executable);
          if (!machOMagic.has(magic(executable).toString('hex'))) { refuse(path, 'not Mach-O'); continue; }
          const remaining = Math.floor(deadline - now());
          if (remaining < 1) { refuse(path, 'selection timeout'); break; }
          stage = 'probe';
          const result = JSON.parse(exec(executable, ['-p', probe], {
            timeout: Math.max(1, Math.min(2000, remaining)), killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 4096, env: {}, shell: false,
            stdio: ['ignore', 'pipe', 'ignore'],
          }));
          if (now() >= deadline) { refuse(path, 'probe timeout'); break; }
          const major = /^v(\d+)\./.exec(result?.version)?.[1];
          if (!major || Number(major) < 25) { refuse(path, 'version'); continue; }
          if (result.permission !== true || result.net !== true) { refuse(path, 'flags'); continue; }
          stage = 'file';
          if (!sameFile(pinned, checkFile(executable))) { refuse(path, 'changed'); continue; }
          return selected = { execPath: executable, version: result.version, identity: pinned,
            flags: new Set(['--permission', '--allow-net']), fallback: true };
        } catch (error) {
          refuse(path, stage === 'probe' ? error?.code === 'ETIMEDOUT' ? 'probe timeout' : 'probe failed' : reasonFor(error));
        }
      }
    } catch { refuse('~/.local/bin/node', 'discovery failed'); }
    return undefined;
  };
  Object.defineProperties(select, {
    lastRefusal: { get: () => refusals[0] },
    refusals: { get: () => refusals.map(refusal => ({ ...refusal })) },
  });
  return select;
}

export const selectReplNode = createReplNodeSelector();
