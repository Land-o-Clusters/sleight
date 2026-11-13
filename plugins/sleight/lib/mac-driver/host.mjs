import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { darwinEnvironment } from '../platform/paths.mjs';

// Replace only in the reviewed packaging commit, alongside the matching binary.
// No manifest, environment variable or model input can configure this policy.
export const MAC_DRIVER_RELEASE_PIN = null;
const bundledBinary = fileURLToPath(new URL('./prebuilt/darwin-arm64/glide-engine', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function refuse(reason, code = 'HOST_PACKAGE_MISMATCH') {
  throw Object.assign(Error(code), { reason });
}

function tool(file, args, reason = 'signature') {
  const result = spawnSync(file, args, { env: darwinEnvironment(), encoding: 'utf8',
    timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0 || result.signal) refuse(reason, 'HOST_SIGNATURE_MISMATCH');
  return { stdout: result.stdout, stderr: result.stderr };
}

// This also checks the release script's result before it writes a release pin.
// allowAdHoc is an internal test seam. Shipping policy always requires Developer ID.
export function verifyMacDriverSignature({ binary, pin, allowAdHoc = false }) {
  if (pin?.arch !== 'arm64') refuse('architecture', 'HOST_SIGNATURE_MISMATCH');
  if (pin.identifier !== 'com.sleight.glide-engine') refuse('identifier', 'HOST_SIGNATURE_MISMATCH');
  if (pin.kind !== 'developer-id' && !(allowAdHoc && pin.kind === 'adhoc' && pin.teamId === null))
    refuse('signature', 'HOST_SIGNATURE_MISMATCH');
  if (pin.kind === 'developer-id' && !/^[A-Z0-9]{10}$/.test(pin.teamId ?? '')) refuse('team', 'HOST_SIGNATURE_MISMATCH');
  // Read identity separately so an unmet team requirement has its own diagnostic.
  // Display is not verification. Acceptance still requires the strict check below.
  const { stderr } = tool('/usr/bin/codesign', ['--display', '--verbose=4', binary]);
  if (!stderr.split('\n').includes('Identifier=' + pin.identifier)) refuse('identifier', 'HOST_SIGNATURE_MISMATCH');
  if (!stderr.split('\n').includes('TeamIdentifier=' + (pin.teamId ?? 'not set'))) refuse('team', 'HOST_SIGNATURE_MISMATCH');
  if (pin.kind === 'adhoc' ? !/^Signature=adhoc$/m.test(stderr) : !/^CodeDirectory .*flags=.*\bruntime\b/m.test(stderr))
    refuse('signature', 'HOST_SIGNATURE_MISMATCH');
  const args = ['--verify', '--strict', '--all-architectures'];
  if (pin.kind === 'developer-id') {
    args.push('-R', `identifier "com.sleight.glide-engine" and anchor apple generic and certificate leaf[subject.OU] = "${pin.teamId}"` +
      ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists');
  }
  tool('/usr/bin/codesign', [...args, binary]);
  if (tool('/usr/bin/lipo', ['-archs', binary], 'architecture').stdout.trim() !== 'arm64')
    refuse('architecture', 'HOST_SIGNATURE_MISMATCH');
  return true;
}

// Construction/import never inspects or launches a helper. Options are loader/test
// seams only, never propagated from tools, projects, settings or process.env.
export function preparePrebuiltMacDriver({ sourceHash, build, arch = process.arch,
  binary = bundledBinary, pin = MAC_DRIVER_RELEASE_PIN, allowAdHoc = false,
  onRefusal = reason => process.stderr.write(`sleight: prebuilt Mac helper refused (${reason}); using source compilation.\n`) } = {}) {
  if (!pin) return null;
  try {
    // Snapshot the pin so a caller cannot change an already-issued receipt.
    pin = Object.freeze({ ...pin });
    if (arch !== 'arm64' || pin.arch !== arch) refuse('architecture');
    if (!hash(sourceHash) || pin.sourceHash !== sourceHash) refuse('source-hash');
    if (!hash(build) || pin.build !== build) refuse('build-id');
    if (!hash(pin.sha256)) refuse('binary-hash');
    const validate = () => {
      const stat = lstatSync(binary);
      if (stat.isSymbolicLink() || realpathSync(binary) !== binary) refuse('symlink');
      if (!stat.isFile()) refuse('file');
      if (stat.mode & 0o022 || !(stat.mode & 0o100)) refuse('file-mode');
      if (stat.uid !== process.getuid() && stat.uid !== 0) refuse('file-owner');
      if (digest(readFileSync(binary)) !== pin.sha256) refuse('binary-hash');
    };
    validate();
    verifyMacDriverSignature({ binary, pin, allowAdHoc });
    validate();
    return Object.freeze({ binary, build, validate });
  } catch (error) {
    // Fixed reason codes only: never echo paths, signing output or account data.
    // stderr is private diagnostics, not a tool result or a model-facing notice.
    try { onRefusal(error.reason ?? 'file'); } catch { /* Logging cannot prevent fallback. */ }
    return null;
  }
}
