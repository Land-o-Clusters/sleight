import { execFileSync } from 'node:child_process';
export const REBUILD_TOOLCHAIN = Object.freeze({ macOS: '27.0.1', cwebp: '1.6.0' });
// Drift is a skipped qualification, not a character regression. Dependency injection
// keeps missing-tool, unknown OS and different-version coverage independent of the host.
export function rebuildSkipReason({ platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'darwin') return 'needs macOS sips';
  let version;
  try { version = run('cwebp', ['-version'], { encoding: 'utf8' }).trim().split('\n')[0]; }
  catch { return 'cwebp is unavailable on PATH'; }
  if (version !== REBUILD_TOOLCHAIN.cwebp) return `untested cwebp ${version}; tested ${REBUILD_TOOLCHAIN.cwebp}`;
  let os;
  try { os = run('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(); }
  catch { return 'cannot determine macOS product version'; }
  if (os !== REBUILD_TOOLCHAIN.macOS) return `untested macOS ${os}; tested ${REBUILD_TOOLCHAIN.macOS}`;
  return false;
}
