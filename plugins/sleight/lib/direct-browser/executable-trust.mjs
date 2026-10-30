// Which browser executables turbo connects to. The connection (selected-connection.mjs) enforces it, and setup
// (turbo-setup.mjs) mirrors it so a browser the connection would refuse is never written into turbo.json.
//
// The base rule: a plain file at its canonical path, owned by the user or root, executable, and writable by nobody
// else. A file another account can write could be swapped before the browser starts, and turbo would then drive that
// account's program with the user's pages and typing.
//
// The one relaxation: a drag install into /Applications by an admin user leaves the bundle mode 775 with group admin,
// and macOS App Management stops the user from changing another app's bundle. Such an executable (group-writable by
// admin or the user's own primary group, never world-writable) is accepted only at qualified Chrome's or Helium's fixed
// place in /Applications or ~/Applications, and then only after the running main process proves its code. The kernel's
// live status for that process (csops, read by native/peer-host.c) must show valid code with the kill,
// library-validation and runtime flags, and the cdhash it runs must be the cdhash of the bundle on disk that codesign
// verifies against that browser's Developer ID requirement (bundle identifier and Apple-issued Team ID), checked in one
// codesign call. With those flags, every library the main process loads must be signed by the same team or Apple, DYLD
// environment injection is ignored, and a code page that fails validation kills it. The proof covers only that main
// process at that moment. Helpers the browser starts later (renderer, GPU, network) run from the bundle on disk and
// are not proven (docs/known-problems.md). It is cached per process incarnation (pid plus start time) and executable
// inode, mtime, ctime, mode and group.
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { browserDefinitions } from './browsers.mjs';
import { runOnceMore } from './transient.mjs';

const CODESIGN = '/usr/bin/codesign';
const environment = { PATH: '/usr/bin:/bin', LANG: 'C' };
// Kernel code-signing status bits (xnu osfmk/kern/cs_blobs.h): CS_VALID 0x1, CS_KILL 0x200, CS_REQUIRE_LV 0x2000,
// CS_RUNTIME 0x10000. A process marked CS_DEBUGGED (0x10000000) may have run invalid pages, so it is refused.
export const REQUIRED_STATUS_FLAGS = 0x1 | 0x200 | 0x2000 | 0x10000;
export const REFUSED_STATUS_FLAGS = 0x10000000;
// The same bits as code directory flags, which setup reads from the file (no CS_VALID there).
export const REQUIRED_CODE_FLAGS = 0x200 | 0x2000 | 0x10000;
// The group IDs whose write bit the relaxation tolerates: admin (80), the group of a drag install, and the user's own.
export const ADMIN_GID = 80;

const team = value => typeof value === 'string' && /^[A-Z0-9]{10}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(value);

/** The Developer ID requirement for a bundle identifier and Team ID: Apple's anchor, the Developer ID intermediate and
 *  leaf markers, and the leaf's Team ID, the same shape as Chrome's and Helium's own designated requirements. */
export function codeRequirement({ bundleId, team: teamId }) {
  if (!identifier(bundleId) || !team(teamId)) throw Error('SIGNATURE_REQUIREMENT_INVALID');
  return `identifier "${bundleId}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] ` +
    `and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${teamId}"`;
}

export const defaultAppRoots = () => ['/Applications', join(userInfo().homedir, 'Applications')];

/** The signed browser whose fixed executable path this is, or undefined. Only exact
 *  <root>/<Name>.app/Contents/MacOS/<Name> paths under the given roots match, and only qualified browsers with a Team
 *  ID (Chrome and Helium). The qualified flag is the table's own, which no setting or environment variable changes. */
export function signedBrowserAt(path, { appRoots = defaultAppRoots(), browsers } = {}) {
  if (typeof path !== 'string') return undefined;
  for (const root of appRoots) {
    const table = browsers ?? browserDefinitions(undefined, root);
    for (const browser of table) {
      if (browser.qualified !== true || !browser.team || browser.executable !== join(root, `${browser.name}.app/Contents/MacOS/${browser.name}`) ||
          browser.executable !== path) continue;
      return Object.freeze({ name: browser.name, bundleId: browser.bundleId, team: browser.team, requirement: browser.requirement ?? codeRequirement(browser) });
    }
  }
  return undefined;
}

/** 'strict' when nobody else can write the file, 'signature' when only its group can and that group is admin or the
 *  user's own primary group, otherwise undefined. stat is an fs.Stats (mode and gid). */
export function writeClass(stat, primaryGid = process.getgid?.()) {
  if (!(stat.mode & 0o022)) return 'strict';
  if (!(stat.mode & 0o002) && (stat.gid === ADMIN_GID || Number.isSafeInteger(primaryGid) && stat.gid === primaryGid)) return 'signature';
  return undefined;
}

export const proofKey = (incarnation, stat) => [incarnation, stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size, stat.mode, stat.gid].join(':');

function codeFlags(text) {
  const lines = String(text).split('\n').filter(line => line.startsWith('CodeDirectory '));
  const match = lines.length === 1 && / flags=0x([0-9a-f]{1,8})\(/.exec(lines[0]);
  if (!match) throw Error();
  return Number.parseInt(match[1], 16);
}

/** Proves the running main process is the signed browser. status is peer-host --code-status output for it: the
 *  kernel's live status flags, the architecture it runs and its cdhash. The flags must include REQUIRED_STATUS_FLAGS,
 *  and one codesign call verifies the bundle on disk, at that architecture, against the requirement plus the running
 *  cdhash, so the code the kernel runs is the code that satisfies the Developer ID requirement. run is execFile in
 *  promise form. The caller binds status to one incarnation by reading process metadata before and after. Throws
 *  SELECTED_SIGNATURE_UNPROVED. */
export async function proveRunningCode(run, status, requirement, executable) {
  try {
    if (!status || typeof status !== 'object' || typeof requirement !== 'string' || typeof executable !== 'string' ||
        !Number.isSafeInteger(status.flags) || !/^(arm64e?|x86_64h?)$/.test(status.arch) || !/^[0-9a-f]{40}$/.test(status.cdhash)) throw Error();
    if ((status.flags & REQUIRED_STATUS_FLAGS) !== REQUIRED_STATUS_FLAGS || status.flags & REFUSED_STATUS_FLAGS) throw Error();
    const bundle = dirname(dirname(dirname(executable)));
    if (!bundle.endsWith('.app') || join(bundle, 'Contents/MacOS') !== dirname(executable)) throw Error();
    const options = { env: environment, timeout: 10000, maxBuffer: 65536 };
    // A codesign that its timeout killed runs once more; a codesign that refused is final.
    await runOnceMore(run, CODESIGN, ['--verify', '--strict', '--architecture', status.arch,
      `-R=(${requirement}) and cdhash H"${status.cdhash}"`, bundle], options);
    return true;
  } catch { throw Error('SELECTED_SIGNATURE_UNPROVED'); }
}

const onDisk = new Map();

/** Setup's static mirror: the executable's bundle on disk satisfies the requirement, and its code directory has the
 *  same flags. runSync has spawnSync's shape. Cached per inode, mtime and ctime. Returns { ok: true } or
 *  { ok: false, reason }, never throws. reason is 'detritus' when codesign --strict refused the bundle for Finder
 *  metadata (a resource fork or Finder info on the bundle folder, which a Mac set up from a backup carries over)
 *  while the signature itself may be fine, 'signature' when the bundle fails the requirement, 'flags' when its code
 *  directory lacks the kill, library-validation and runtime flags, and 'error' when codesign could not run.
 *  It decides only what setup writes; the connection still proves the running process. */
export function onDiskVerdict(executable, requirement, stat, runSync = spawnSync) {
  const key = [executable, requirement, stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size].join(':');
  if (onDisk.has(key)) return onDisk.get(key);
  let verdict;
  try {
    const bundle = dirname(dirname(dirname(executable)));
    const options = { env: environment, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' };
    if (!bundle.endsWith('.app')) verdict = { ok: false, reason: 'signature' };
    else {
      const verified = runSync(CODESIGN, ['--verify', '--strict', '-R=' + requirement, bundle], options);
      if (verified.status !== 0) verdict = { ok: false, reason: /detritus/.test(String(verified.stderr ?? '')) ? 'detritus' : 'signature' };
      else {
        const shown = runSync(CODESIGN, ['--display', '--verbose=1', executable], options);
        const flagged = shown.status === 0 && (codeFlags(String(shown.stderr ?? '') + '\n' + String(shown.stdout ?? '')) & REQUIRED_CODE_FLAGS) === REQUIRED_CODE_FLAGS;
        verdict = flagged ? { ok: true } : { ok: false, reason: 'flags' };
      }
    }
  } catch { verdict = { ok: false, reason: 'error' }; }
  Object.freeze(verdict);
  if (onDisk.size > 64) onDisk.clear();
  onDisk.set(key, verdict);
  return verdict;
}

/** onDiskVerdict as a boolean. */
export const verifiedOnDisk = (executable, requirement, stat, runSync) => onDiskVerdict(executable, requirement, stat, runSync).ok;
