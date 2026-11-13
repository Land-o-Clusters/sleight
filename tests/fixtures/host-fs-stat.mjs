// A fake of the mod host's $.fs.stat(path, { resolve: true }) that answers in the shapes Claude Code 2.1.309 returned,
// recorded in host-fs-stat-2.1.309.json. Its rejections have no code or errno: the errno name is the message's last word.
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';

export const recorded = JSON.parse(readFileSync(new URL('./host-fs-stat-2.1.309.json', import.meta.url), 'utf8'));
const rejection = recorded.cases.find(entry => entry.case === 'missing path');
const resolution = recorded.cases.find(entry => entry.case === 'existing file').resolves;

/** The host's rejection for `path`. ENOENT and ENOTDIR were recorded; any other errno uses the same format. */
export function hostStatError(path, errno) {
  const { rejects } = rejection;
  const error = new Error(rejects.message.replace(`(${rejection.path})`, `(${path})`).replace(/ENOENT$/, errno));
  error.name = rejects.name;
  error.line = rejects.line;
  error.column = rejects.column;
  return error;
}

/** The host's resolved value: realPath is left out when the path leads nowhere (a dangling link). */
export function hostStatValue({ kind = 'dir', size = 64, mtimeMs = 0, isLink = false, realPath } = {}) {
  const value = { kind, size, mtimeMs, isLink, realPath };
  return Object.fromEntries(resolution.ownProperties.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

/** Stat the real disk and answer as the host did. */
export async function hostDiskStat(path) {
  let own;
  try { own = lstatSync(path); } catch (error) { throw hostStatError(path, error.code); }
  let target, realPath;
  try { target = statSync(path); realPath = realpathSync(path); } catch (error) { if (!own.isSymbolicLink()) throw hostStatError(path, error.code); }
  const info = target ?? own;
  const kind = target?.isFile() ? 'file' : target?.isDirectory() ? 'dir' : 'other';
  return hostStatValue({ kind, size: info.size, mtimeMs: info.mtimeMs, isLink: own.isSymbolicLink(), realPath });
}

/**
 * A host stat over a described tree. `answer(path)` returns the real path for an existing path, undefined for a
 * missing one (ENOENT), `{ errno }` for another rejection, or `{ dangling: true }` for a link that leads nowhere.
 */
export const hostStatFrom = answer => async path => {
  const result = await answer(path);
  if (typeof result === 'string') return hostStatValue({ realPath: result });
  if (result === undefined || result === null) throw hostStatError(path, 'ENOENT');
  if (result.errno) throw hostStatError(path, result.errno);
  return hostStatValue({ kind: 'other', size: 30, isLink: true });
};
