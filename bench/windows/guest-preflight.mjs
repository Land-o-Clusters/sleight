import { readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { sha256, verifyKit, requirements } from './guest-integrity.mjs';
import { checkReportPath, isMain, ROOT, runChild, writeReport } from './kit.mjs';

const nativePath = 'plugins/sleight/lib/direct-browser/native/win';
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const quotePowerShell = value => "'" + value.replaceAll("'", "''") + "'";
function verifiedScript(root, kit, path) {
  const file = kit.files.find(file => file.path === path);
  const bytes = readFileSync(join(root, path));
  if (!file || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw Error('Kit script hash mismatch: ' + path);
  return bytes.toString('utf8');
}
function encodedArgs(script) {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}
export function sourceChecks(root, files) {
  const kitRoot = win32.resolve(root);
  return [['source', kitRoot], ['source', win32.join(kitRoot, nativePath)],
    ...files.filter(file => file.path.startsWith(nativePath + '/')).map(file => ['source', win32.join(kitRoot, file.path)])];
}
function folderFailure(report, root, reason) {
  report.code = 'KIT_FOLDER_WRITABLE';
  report.reason = reason;
  if (reason === 'unproved') {
    report.mismatches.push('Kit source ACL checks unproved; retain this report and retry preflight with a new report name');
    return report;
  }
  report.mismatches.push('Kit source ACL checks refused; check folder ownership and required elevation before applying the lock step and rerunning preflight');
  report.fix = [
    '(Get-Acl -LiteralPath ' + quotePowerShell(root) + ').Owner',
    'icacls ' + quotePowerShell(root) + ' /inheritance:r /grant:r ' +
      "'*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' " +
      '"*$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value):(OI)(CI)F" ' + "'*S-1-5-32-545:(OI)(CI)RX'",
    'icacls ' + quotePowerShell(win32.join(root, '*')) + ' /reset /T /C /Q',
  ];
  return report;
}

export function parsePreflightArgs(args) {
  const options = {}, seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--expected-commit', '--expected-manifest-sha256', '--output'].includes(key) || seen.has(key) || !value) throw Error('Invalid preflight arguments');
    seen.add(key);
    options[{ '--expected-commit': 'expectedCommit', '--expected-manifest-sha256': 'expectedManifestSha256', '--output': 'output' }[key]] = value;
  }
  if (seen.size !== 3) throw Error('Preflight requires --expected-commit, --expected-manifest-sha256 and --output');
  return options;
}
export async function preflight(options, { root = ROOT, platform = process.platform, arch = process.arch,
  nodeVersion = process.versions.node, execute = runChild, env = process.env } = {}) {
  const kit = verifyKit(root, options); // Reject changed scripts before PowerShell executes.
  const report = { schema: 'sleight.windows-guest-preflight/1', verdict: 'fail', ...kit,
    platform, architecture: arch, node: nodeVersion, windows: null, mismatches: [] };
  if (platform !== requirements.platform) report.mismatches.push('Windows required');
  if (arch !== requirements.architecture) report.mismatches.push('Native ARM64 Node required');
  if (nodeVersion !== requirements.node) report.mismatches.push('Node version mismatch');
  if (report.mismatches.length) return report;
  // Retain verified bytes before starting any child. Never execute a kit path after hashing it.
  const accessScript = verifiedScript(root, kit, nativePath + '/cache-access.ps1');
  const probeScript = verifiedScript(root, kit, 'bench/windows/guest-preflight.ps1');
  const kitRoot = win32.resolve(root);
  const checks = sourceChecks(kitRoot, kit.files);
  const data = Buffer.from(JSON.stringify({ checks })).toString('base64');
  try {
    const access = await execute(powershell, encodedArgs(accessScript + "\nInvoke-HostChecks '" + data + "'"),
      { cwd: win32.dirname(powershell), env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
        lowPriority: true, timeout: 10000, maxBytes: 4096 });
    if (!access.reason && access.status === 65 && access.stderr?.split(/\r?\n/).includes('HOST_CACHE_UNSAFE')) return folderFailure(report, kitRoot, 'refused');
    if (access.reason || access.status !== 0) return folderFailure(report, kitRoot, 'unproved');
    const info = JSON.parse(access.stdout.replace(/^\uFEFF/, ''));
    if (info?.ownerStarted !== 'unknown') return folderFailure(report, kitRoot, 'unproved');
  } catch { return folderFailure(report, kitRoot, 'unproved'); }
  const result = await execute(powershell, encodedArgs(probeScript),
    { cwd: root, env, lowPriority: true, timeout: 15000, maxBytes: 4096 });
  let info;
  try { info = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); } catch { /* fail below */ }
  if (result.reason || result.status !== 0 || !info || !Number.isInteger(info.build) || !Number.isInteger(info.revision)) {
    report.mismatches.push('Windows/UIA probe failed'); return report;
  }
  report.windows = info;
  if (info.build < requirements.minimumBuild) report.mismatches.push('Windows 11 build required');
  if (String(info.architecture).toUpperCase() !== 'ARM64') report.mismatches.push('Windows architecture mismatch');
  if (info.uiaAvailable !== true) report.mismatches.push('UI Automation unavailable');
  report.verdict = report.mismatches.length ? 'fail' : 'pass';
  return report;
}
export async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parsePreflightArgs(args); checkReportPath(options.output);
  let report;
  try { report = await preflight(options, dependencies); }
  catch (error) { report = { schema: 'sleight.windows-guest-preflight/1', verdict: 'fail', reason: error.message }; }
  writeReport(options.output, report);
  return report;
}
if (isMain(import.meta.url)) main().then(report => {
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.verdict === 'pass' ? 0 : 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });
