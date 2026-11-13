// Windows turbo groundwork. Discovery is read-only and supplies hints, never permission or peer proof.
// No command, registry read or profile read happens at import, or on a non-Windows platform.
import * as filesystem from 'node:fs';
import { win32 as path } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseActivePort } from './discovery.mjs';
import { win32Paths, win32Environment } from '../platform/paths.mjs';
import { getPlatform } from '../platform/index.mjs';

const MAX_OUTPUT = 262144;
const definitions = [
  { id: 'chrome', name: 'Google Chrome', image: 'chrome.exe', vendor: 'Google\\Chrome', scheme: 'chrome' },
  { id: 'edge', name: 'Microsoft Edge', image: 'msedge.exe', vendor: 'Microsoft\\Edge', scheme: 'edge' },
  { id: 'brave', name: 'Brave Browser', image: 'brave.exe', vendor: 'BraveSoftware\\Brave-Browser', scheme: 'brave' },
];
const fail = code => { throw Error(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const unique = values => [...new Map(values.map(value => [value.toLowerCase(), value])).values()];
// No UNC, device paths, ADS, traversal, trailing-dot aliases or command fragments. Native handle/DACL checks
// remain necessary before connecting: Node's realpath/lstat cannot prove the absence of every reparse-point race.
function localPath(value) {
  return typeof value === 'string' && value.length <= 32767 && /^[A-Za-z]:\\/.test(value) &&
    !/[\x00-\x1f<>"|?*]/.test(value) && !value.slice(2).includes(':') && !value.includes('/') &&
    value === path.normalize(value) && value.slice(3).split('\\').every(part => part && !/[. ]$/.test(part));
}
const samePath = (a, b) => localPath(a) && localPath(b) && a.toLowerCase() === b.toLowerCase();
const environment = env => Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
const localRoot = vars => vars.LOCALAPPDATA ?? (localPath(vars.USERPROFILE) ? path.join(vars.USERPROFILE, 'AppData', 'Local') : undefined);
const installRoots = vars => unique([localRoot(vars), vars.PROGRAMW6432, vars.PROGRAMFILES, vars['PROGRAMFILES(X86)'], vars['PROGRAMFILES(ARM)']].filter(localPath));
// Environment overrides are a test seam. Production roots come from the account, never inherited settings.
const browserEnvironment = (env, home) => env === undefined ? {
  LOCALAPPDATA: path.dirname(win32Paths({ home }).settings),
  PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  'PROGRAMFILES(ARM)': 'C:\\Program Files (Arm)',
} : environment(env);

export function windowsBrowserDefinitions({ env, home } = {}) {
  const vars = browserEnvironment(env, home), local = localRoot(vars);
  if (!localPath(local)) return [];
  const roots = installRoots(vars);
  return definitions.map(({ vendor, scheme, ...browser }) => ({ ...browser, platform: 'win32', qualified: false,
    profileRoot: path.join(local, vendor, 'User Data'), inspectURL: `${scheme}://inspect/#remote-debugging`,
    candidates: roots.map(root => ({ path: path.join(root, vendor, 'Application', browser.image), source: 'standard' })) }));
}

export function parseWindowsAppPath(value, image, env) {
  if (typeof value !== 'string' || value.length > 32767 || !definitions.some(row => row.image === image)) return undefined;
  const vars = browserEnvironment(env);
  value = value.replace(/%([^%]+)%/g, (whole, key) => typeof vars[key.toUpperCase()] === 'string' ? vars[key.toUpperCase()] : whole);
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  return !value.includes('%') && localPath(value) && path.basename(value).toLowerCase() === image ? value : undefined;
}

// Fixed in-box PowerShell 5.1 scripts. No executable path, profile name or tool argument enters script text.
// Both registry views matter for x86 installs on x64/ARM64. OpenSubKey is read-only by default. Missing keys
// are normal; an unreadable hive/view fails the query. UTF-8 avoids the console's locale-dependent OEM codepage.
const registryScript = String.raw`
$ErrorActionPreference = 'Stop'
$output = [Console]::OpenStandardOutput()
$utf8 = New-Object System.Text.UTF8Encoding($false)
$names = @{ chrome = 'chrome.exe'; edge = 'msedge.exe'; brave = 'brave.exe' }
$result = @{}
foreach ($id in @('chrome', 'edge', 'brave')) {
  $values = @()
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
      $base = $null; $key = $null
      try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        $key = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\App Paths\' + $names[$id])
        if ($null -ne $key) {
          $value = $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          if ($value -is [string]) { $values += $value }
        }
      } finally { if ($null -ne $key) { $key.Dispose() }; if ($null -ne $base) { $base.Dispose() } }
    }
  }
  $result[$id] = @($values)
}
$bytes = $utf8.GetBytes((ConvertTo-Json -InputObject $result -Compress -Depth 4) + [char]10)
$output.Write($bytes, 0, $bytes.Length)
$output.Flush()
`;

// tasklist lacks executable path and process birth time. CIM supplies both plus GetOwnerSid, so observations can
// exclude another login and a different desktop session without elevation. Command lines stay inside this adapter.
// This is NOT GetExtendedTcpTable/GetProcessTimes/WinVerifyTrust evidence and must never authorize a connection.
const processScript = String.raw`
$ErrorActionPreference = 'Stop'
$output = [Console]::OpenStandardOutput()
$utf8 = New-Object System.Text.UTF8Encoding($false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$session = (Get-Process -Id $PID).SessionId
$rows = @()
$items = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe'")
foreach ($p in $items) {
  if ($p.SessionId -ne $session) { continue }
  if ($p.CommandLine -match '(?i)(?:^|\s)"?--type(?:=|\s)') { continue }
  try { $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid } catch { throw 'WINDOWS_PROCESS_UNPROVED' }
  if ($null -eq $owner -or $owner.ReturnValue -ne 0 -or [string]::IsNullOrEmpty($owner.Sid)) { throw 'WINDOWS_PROCESS_UNPROVED' }
  if ($owner.Sid -ne $sid) { continue }
  if ($null -eq $p.ExecutablePath -or $null -eq $p.CreationDate -or $null -eq $p.CommandLine) { throw 'WINDOWS_PROCESS_UNPROVED' }
  $rows += @{ pid = [int]$p.ProcessId; application = $p.ExecutablePath; ownerSid = $owner.Sid;
    sessionId = [int]$p.SessionId; start = ([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds();
    main = $true; commandLine = $p.CommandLine }
}
$json = ConvertTo-Json -InputObject @{ currentSid = $sid; currentSession = [int]$session; processes = @($rows) } -Compress -Depth 4
$bytes = $utf8.GetBytes($json + [char]10)
$output.Write($bytes, 0, $bytes.Length)
$output.Flush()
`;

const sid = value => typeof value === 'string' && /^S-1-\d+(?:-\d+){1,15}$/.test(value) && value.length <= 184;
const sessionId = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;

// Decode Windows argv quoting as data. Never execute or return the command line. A profile switch must
// occur once and name a local absolute root; absent switches retain the default as an unproved hint.
export function windowsProcessProfile(commandLine, defaultRoot) {
  if (typeof commandLine !== 'string' || !commandLine.length || commandLine.length > 32767 || /[\0\r\n]/.test(commandLine))
    fail('WINDOWS_PROCESS_UNPROVED');
  const args = [];
  let i = 0;
  while (i < commandLine.length) {
    while (/[ \t]/.test(commandLine[i] ?? '') && i < commandLine.length) i++;
    if (i === commandLine.length) break;
    let arg = '', quoted = false;
    while (i < commandLine.length && (quoted || !/[ \t]/.test(commandLine[i]))) {
      let slashes = 0;
      while (commandLine[i] === '\\') { slashes++; i++; }
      if (commandLine[i] === '"') {
        arg += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) { arg += '"'; i++; }
        else if (quoted && commandLine[i + 1] === '"') { arg += '"'; i += 2; }
        else { quoted = !quoted; i++; }
      } else {
        arg += '\\'.repeat(slashes);
        if (i < commandLine.length && (quoted || !/[ \t]/.test(commandLine[i]))) arg += commandLine[i++];
      }
    }
    if (quoted) fail('WINDOWS_PROCESS_UNPROVED');
    args.push(arg);
  }
  let root, count = 0;
  for (let n = 1; n < args.length; n++) {
    if (args[n] === '--') break;
    if (args[n] === '--user-data-dir') { count++; root = args[++n]; }
    else if (args[n].startsWith('--user-data-dir=')) { count++; root = args[n].slice(16); }
  }
  if (count > 1 || !localPath(count ? root : defaultRoot)) fail('WINDOWS_PROCESS_UNPROVED');
  return { profileRoot: count ? root : defaultRoot, profileSource: count ? 'command-line' : 'default' };
}

export function parseWindowsProcesses(text, browser) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_OUTPUT) throw Error();
    const data = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!object(data) || !sid(data.currentSid) || !sessionId(data.currentSession) || !Array.isArray(data.processes) || data.processes.length > 4096 ||
        !Array.isArray(browser?.candidates)) throw Error();
    const candidates = browser.candidates;
    const seen = new Set(), found = [];
    for (const row of data.processes) {
      if (!object(row) || !sessionId(row.sessionId)) throw Error();
      if (row.sessionId !== data.currentSession || row.main === false) continue;
      if (!sid(row.ownerSid)) throw Error();
      if (row.ownerSid !== data.currentSid) continue;
      if (!Number.isSafeInteger(row.pid) || row.pid < 1 || row.pid > 2147483647 || seen.has(row.pid) ||
          !Number.isSafeInteger(row.start) || row.start <= 0 || !localPath(row.application) || typeof row.main !== 'boolean') throw Error();
      seen.add(row.pid);
      if (!candidates.some(candidate => samePath(candidate.path, row.application))) continue;
      let profile;
      try { profile = windowsProcessProfile(row.commandLine, browser.profileRoot); }
      catch { profile = { profileSource: 'unproved' }; }
      // Retain the unknown instance, so a caller cannot mistake a partial scan for a unique browser.
      found.push({ pid: row.pid, application: row.application, ownerSid: row.ownerSid, sessionId: row.sessionId, start: row.start,
        ...profile, authenticated: false });
    }
    return found;
  } catch { fail('WINDOWS_PROCESS_UNPROVED'); }
}

const equalFile = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => typeof a[key] === 'bigint' && a[key] === b[key]);
function activePortHint(fs, permissions, browser, process) {
  let fd;
  try {
    const { pid, start, application, profileRoot } = process ?? {};
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647 || !Number.isSafeInteger(start) || start <= 0 ||
        !localPath(profileRoot) || !browser?.candidates?.some(candidate => samePath(candidate.path, application))) throw Error();
    const file = path.join(profileRoot, 'DevToolsActivePort');
    if (typeof permissions.readBrowserFile === 'function') {
      // Read through the same non-reparse handle whose ACL was inspected. No second Node open.
      const proof = permissions.readBrowserFile(file);
      if (!samePath(proof.path, file) || proof.kind !== 'file' || proof.mtime <= start) throw Error();
      return { ...parseActivePort(proof.text), file, canonicalPath: file, text: proof.text, mtime: proof.mtime,
        pid, start, application, profileRoot, authenticated: false };
    }
    const before = fs.lstatSync(file, { bigint: true });
    if (permissions.privateFile(file, { stat: before }).ok !== true) throw Error();
    const plain = s => s.isFile() && !s.isSymbolicLink() && typeof s.dev === 'bigint' && typeof s.ino === 'bigint' &&
      typeof s.size === 'bigint' && s.size > 0n && s.size <= 512n && typeof s.mtimeMs === 'bigint' && s.mtimeMs > BigInt(start);
    const canonicalPath = fs.realpathSync(file);
    if (!plain(before) || !samePath(canonicalPath, file)) throw Error();
    fd = fs.openSync(file, filesystem.constants.O_RDONLY);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!plain(stat) || !equalFile(before, stat)) throw Error();
    const bytes = Buffer.alloc(Number(stat.size));
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || !equalFile(stat, fs.fstatSync(fd, { bigint: true })) ||
        !equalFile(stat, fs.lstatSync(file, { bigint: true })) || !samePath(fs.realpathSync(file), file)) throw Error();
    const text = bytes.toString('utf8');
    if (!bytes.equals(Buffer.from(text))) throw Error();
    const mtime = Number(stat.mtimeMs);
    if (!Number.isSafeInteger(mtime)) throw Error();
    return { ...parseActivePort(text), file, canonicalPath, text, mtime,
      pid, start, application, profileRoot, authenticated: false };
  } catch { fail('WINDOWS_ENDPOINT_UNPROVED'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Trusted startup/test adapter, never MCP or config input. This deliberately cannot connect, launch a browser,
 * change debugging settings, accept consent, or write turbo.json. All Windows browsers remain unqualified. */
export function createWindowsTurboDiscovery({ platform = process.platform, env, home, run = promisify(execFile), fs = filesystem,
  filePermissions = getPlatform('win32').filePermissions } = {}) {
  if (platform !== 'win32') return undefined;
  const vars = browserEnvironment(env, home);
  const query = async (script, code) => {
    try {
      if (env !== undefined && (!localPath(vars.SYSTEMROOT) || !samePath(vars.SYSTEMROOT, vars.WINDIR))) throw Error();
      const safe = env === undefined ? win32Environment() : win32Environment({ env });
      const executable = path.join(safe.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // Matching environment spellings avoid accidental redirection; neither variable proves OS trust.
      const childEnv = { SystemRoot: safe.SystemRoot, windir: safe.SystemRoot };
      for (const name of ['TEMP', 'TMP']) if (localPath(vars[name])) childEnv[name] = vars[name];
      const { stdout } = await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { env: childEnv, encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000, maxBuffer: MAX_OUTPUT });
      if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT) throw Error();
      return stdout.replace(/^\uFEFF/, '');
    } catch { fail(code); }
  };
  return Object.freeze({
    async browsers() {
      const rows = windowsBrowserDefinitions({ env, home });
      if (!rows.length) return [];
      let registry, registryState = 'available';
      try {
        registry = JSON.parse(await query(registryScript, 'WINDOWS_REGISTRY_UNAVAILABLE'));
        if (!object(registry) || !definitions.every(b => Array.isArray(registry[b.id]) && registry[b.id].length <= 4 && registry[b.id].every(v => typeof v === 'string'))) throw Error();
      } catch { registry = {}; registryState = 'unavailable'; }
      return rows.map(browser => {
        const standardRoots = installRoots(vars);
        const hints = unique((registry[browser.id] ?? []).map(value => parseWindowsAppPath(value, browser.image, env)).filter(Boolean))
          .filter(value => !browser.candidates.some(candidate => samePath(candidate.path, value)))
          .map(value => ({ path: value, source: 'registry', location: standardRoots.some(root => value.toLowerCase().startsWith(root.toLowerCase() + '\\')) ? 'standard' : 'unverified-location' }));
        const candidates = [...browser.candidates, ...hints.filter(hint => hint.location === 'standard'), ...hints.filter(hint => hint.location !== 'standard')];
        const installed = candidates.filter(candidate => {
          try { const stat = fs.lstatSync(candidate.path); return stat.isFile() && !stat.isSymbolicLink() && samePath(fs.realpathSync(candidate.path), candidate.path); } catch { return false; }
        });
        return { ...browser, candidates, registry: registryState, installed: installed.length > 0, executable: installed[0]?.path,
          executableSource: installed[0]?.source, executableLocation: installed[0]?.location,
          executables: installed.map(candidate => candidate.path) };
      });
    },
    async processes(browser) { return parseWindowsProcesses(await query(processScript, 'WINDOWS_PROCESS_UNPROVED'), browser); },
    activePort(browser, process) { return activePortHint(fs, filePermissions, browser, process); },
  });
}

// Shape bridge only. It deliberately supplies no setting, capability or connection/peer evidence.
// A launcher must refresh process observations and prove the same PID/birth/profile before use.
export function mapWindowsDiscovery({ selected, processes, hint } = {}) {
  const identity = row => ({ application: row.application, root: row.profileRoot, pid: row.pid, start: row.start });
  if (!Array.isArray(processes) || !selected || !hint ||
      !['pid', 'start'].every(key => hint[key] === selected[key]) ||
      !['application', 'profileRoot'].every(key => samePath(hint[key], selected[key])) ||
      !localPath(selected.profileRoot) || !samePath(hint.file, path.join(selected.profileRoot, 'DevToolsActivePort')) ||
      !samePath(hint.canonicalPath, hint.file) || !processes.includes(selected)) fail('WINDOWS_ENDPOINT_UNPROVED');
  return { platform: 'win32', selected: identity(selected), canonicalRoot: path.dirname(hint.canonicalPath),
    processes: processes.map(row => ({ ...identity(row), alive: true })),
    file: { path: hint.file, canonicalPath: hint.canonicalPath, text: hint.text, mtime: hint.mtime } };
}
