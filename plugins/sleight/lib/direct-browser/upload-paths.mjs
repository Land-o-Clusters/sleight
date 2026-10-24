import { userInfo } from 'node:os';
import { isAbsolute, normalize } from 'node:path';
import { execFileSync } from 'node:child_process';

export const uploadRefusals = Object.freeze({
  hidden: 'Upload refused: hidden files and files in hidden folders are not allowed. Ask the user to copy the file to a visible file in Documents and name that copy.',
  library: 'Upload refused: files in ~/Library are not allowed except iCloud Drive documents. Ask the user to copy the file to a visible file in Documents and name that copy.',
  system: 'Upload refused: system files are not allowed. Ask the user to copy the file to a visible file in Documents and name that copy.',
  links: 'Upload refused: symbolic links are not allowed. Ask the user to copy the file to a visible file in Documents and name that copy.',
  shared: 'Upload refused: another account could change this file or its path. Ask the user to copy the file to a visible file in Documents and name that copy.',
  type: 'Upload refused: only regular files are allowed, not folders, devices, pipes or sockets. Ask the user to name a regular file.',
  size: 'Upload refused: files must total 40 MiB or less. Ask the user to name smaller files.',
  metadata: 'Upload refused: file access metadata could not be checked. Ask the user to copy the file to a visible file in Documents and name that copy.',
});
export const uploadByteLimit = 40n * 1024n * 1024n;
export const uploadRefusalMessage = error => Object.values(uploadRefusals).includes(error?.message) ? error.message : undefined;
const home = userInfo().homedir;
const folded = path => path.normalize('NFC').toLowerCase();
const under = (path, root) => path === root || path.startsWith(root + '/');

// Pure lexical policy, checked before touching the path. Defaults come from the
// OS account, never HOME. The explicit roots support synthetic-path unit tests;
// the file authority always uses the defaults.
export function assertUploadLocation(path, roots = { home }) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0'))
    throw Error('File path must be absolute and normalized');
  if (path.split('/').some(part => part.startsWith('.'))) throw Error(uploadRefusals.hidden);
  const value = folded(path), library = folded(roots.home + '/Library');
  if (under(value, library) && !under(value, library + '/mobile documents/com~apple~clouddocs')) throw Error(uploadRefusals.library);
  // /tmp is a symlink on macOS and the authority refuses it. Its real path and
  // the OS account's temporary directory remain usable for task-made files.
  if (['/system', '/library', '/applications', '/bin', '/sbin', '/usr', '/etc', '/dev', '/var', '/private', '/cores', '/network']
    .some(root => under(value, root)) && !under(value, '/private/tmp') && !/^\/private\/var\/folders\/[^/]+\/[^/]+\/t(?:\/|$)/.test(value))
    throw Error(uploadRefusals.system);
}

// A sticky root-owned temp directory protects this user's next entry from
// other accounts. Other writable parents or foreign owners can swap entries.
export function assertUploadOwnership(stat, uid, directory = false) {
  const owner = Number(stat.uid), mode = Number(stat.mode);
  if (![0, uid].includes(owner) || mode & 0o022 && !(directory && owner === 0 && mode & 0o1000))
    throw Error(uploadRefusals.shared);
}

// Node's stat omits macOS Finder flags and ACLs. ls reads both in one bounded,
// metadata-only process for the path chain. Treat any write-granting ACL as
// unsafe, including owner-only grants we cannot interpret conclusively.
export function assertMacUploadMetadata(output, uid, expected, roots = { home }) {
  const lines = output.split('\n');
  const entries = lines.map(line => /^([bcdlps-][rwxstST-]{9})[+@]?\s+\d+\s+(\d+)\s+\d+\s+(\S+)\s+\d+\s+\S+\s+\d+\s+\S+\s+(.+)$/.exec(line)).filter(Boolean);
  if (entries.length !== expected) throw Error(uploadRefusals.metadata);
  const library = folded(roots.home + '/Library');
  const iCloud = under(folded(entries.at(-1)?.[4] ?? ''), library + '/mobile documents/com~apple~clouddocs');
  for (const entry of entries) {
    // Canonical system/temp ancestors can be Finder-hidden. A root-owned
    // hidden directory inside Documents still refuses like any hidden folder.
    const infrastructure = /^\/(?:Volumes|private(?:\/(?:tmp|var(?:\/folders)?))?)?$/.test(entry[4]);
    const exempt = entry[1][0] === 'd' && (iCloud && folded(entry[4]) === library || Number(entry[2]) === 0 && infrastructure);
    if (!exempt && entry[3].split(',').includes('hidden'))
      throw Error(uploadRefusals.hidden);
  }
  if (lines.some(line => /^\s*\d+:\s/.test(line) && /\ballow\b/.test(line) &&
      /\b(?:write|append|delete|delete_child|add_file|add_subdirectory|writeattr|writeextattr|writesecurity|chown)\b/.test(line)))
    throw Error(uploadRefusals.shared);
}

export function checkUploadMetadata(paths, uid) {
  if (process.platform !== 'darwin') return;
  let output;
  try { output = execFileSync('/bin/ls', ['-dlenO', '--', ...paths], { encoding: 'utf8', timeout: 2000, maxBuffer: 65536, env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' } }); }
  catch { throw Error(uploadRefusals.metadata); }
  assertMacUploadMetadata(output, uid, paths.length);
}
