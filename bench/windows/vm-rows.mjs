// Restore before every away row. Import and dry run start no processes.
import { constants, openSync, closeSync, fstatSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { verifyNetwork, verifyRecord } from './uc3f-sitting.mjs';
import { UC3F_PRESENT, UC3F_ROW_IDS } from './uc3f-rows.mjs';
import { combineRowExports, combineRowData, readBounded } from './uc3f-export.mjs';
import { runChild, isMain } from './kit.mjs';
import { guestCommandOutput } from './guest-stdin.mjs';
import { verifyKit } from './guest-integrity.mjs';

export const VM_LOCK = '/tmp/sleight-vm.lock';
export const UTMCTL = '/Applications/UTM.app/Contents/MacOS/utmctl';
const SCHEMA = 'sleight.vm-rows/1';
const modes = ['disposable', 'snapshot', 'save-state', 'cold'];
const away = UC3F_ROW_IDS.filter(id => !UC3F_PRESENT.includes(id));
const fail = code => { throw Error(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = s => "'" + s.replaceAll("'", "''") + "'";
const ok = r => r?.status === 0 && !r.signal && !r.reason;

export const READY_SOURCE = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VmSession {
  [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr value, out int bytes);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr value);
  public static string User() { IntPtr p; int n; if (!WTSQuerySessionInformation(IntPtr.Zero,1,5,out p,out n)) return "";
    try { return Marshal.PtrToStringUni(p); } finally { WTSFreeMemory(p); } }
  public static int State() { IntPtr p; int n; if (!WTSQuerySessionInformation(IntPtr.Zero,1,8,out p,out n)) return -1;
    try { return Marshal.ReadInt32(p); } finally { WTSFreeMemory(p); } }
}
'@
@{sessionId=1;user=[VmSession]::User();state=[VmSession]::State();
  addresses=@(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { $_.IPAddress })} | ConvertTo-Json -Compress`;

function readInput(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || stat.uid !== process.getuid() || stat.mode & 0o022) fail('INPUT_FILE_UNSAFE');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function guestUser(options) {
  let user = options.guestUser;
  if (user === undefined && options.sshConfig) {
    const config = readInput(options.sshConfig).toString('utf8');
    verifyNetwork(config);
    user = /^\s*User\s+(\S+)\s*$/im.exec(config)?.[1];
  }
  if (user === undefined) user = 'Sleight';
  if (typeof user !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(user)) fail('GUEST_USER_INVALID');
  return user;
}

// Darwin open(2)'s O_EXLOCK obtains flock(2)'s exclusive advisory lock atomically
// with opening the file. Keep the inode: unlinking it would permit two owners.
export function lockVM(path = VM_LOCK, platform = process.platform) {
  if (platform !== 'darwin') fail('MAC_FLOCK_REQUIRED');
  let fd;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x20, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o022) fail('VM_LOCK_UNSAFE');
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) fail('VM_LOCK_HELD');
    throw error;
  }
  let closed = false;
  return () => { if (!closed) { closeSync(fd); closed = true; } };
}

export function rowPlan(options = {}) {
  const restoreMode = options.restoreMode ?? 'disposable', snapshot = options.snapshot ?? 'clean-signed-in';
  const rows = options.rows ?? away.filter(id => id !== 'checkpoint-cost');
  if (!modes.includes(restoreMode)) fail('RESTORE_MODE_INVALID');
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(snapshot) || snapshot.startsWith('-')) fail('SNAPSHOT_INVALID');
  if (!Array.isArray(rows) || !rows.length || new Set(rows).size !== rows.length || rows.some(id => !away.includes(id))) fail('INVALID_ROWS');
  if (options.vmId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(options.vmId)) fail('VM_IDENTITY_REQUIRED');
  const vm = options.vmId ?? '<vm>';
  const restore = restoreMode === 'disposable' ? [['status', vm], ['stop', vm], ['start', '--disposable', '--hide', vm]] : restoreMode === 'snapshot' ? [['snapshot', 'restore', vm, snapshot]] :
    restoreMode === 'save-state' ? [['suspend', '--save-state', vm], ['start', vm]] : [['stop', vm], ['start', vm]];
  return { schema: SCHEMA, restoreMode, snapshot, guestUser: guestUser(options), restore, processes: 0,
    rows: rows.map(id => ({ id, presence: 'away', ...id === 'checkpoint-cost' ? { measurementOnly: true } : {},
      ...id === 'person-idle' ? { cases: ['notepad', 'wpf', 'calculator-refused'] } : {} })),
    steps: ['lock-vm', 'owner-away', 'wait-hold', 'restore', 'wait-ssh', 'verify-vm', 'set-clock', 'copy-kit', 'set-acl', 'interactive-task', 'copy-raw'] };
}

// The only Mac executables admitted by this transport. SSH pins the endpoint
// after validating the standalone config again, including before every copy.
export function commandPolicy(options, hostName, command, args, settings) {
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string') ||
      !Number.isSafeInteger(settings?.timeout) || settings.timeout <= 0 || settings.timeout > 60000) fail('MAC_COMMAND_REFUSED');
  const plan = rowPlan(options);
  if (command === UTMCTL) {
    const allowed = [...plan.restore, ['status', options.vmId]];
    if (!allowed.some(v => JSON.stringify(v) === JSON.stringify(args))) fail('MAC_COMMAND_REFUSED');
    return args;
  }
  const ssh = command === '/usr/bin/ssh';
  if (!ssh && command !== '/usr/bin/scp') fail('MAC_COMMAND_REFUSED');
  const prefix = ssh ? ['-F', options.sshConfig, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'] :
    ['-q', '-F', options.sshConfig, '-o', 'BatchMode=yes'];
  const tail = args.slice(prefix.length);
  if (prefix.some((v, i) => args[i] !== v) || (ssh ? tail.length !== 2 || tail[0] !== 'vm' ||
      tail[1] !== 'powershell -NoProfile -NonInteractive -Command -' :
      tail.length !== (tail[0] === '-r' ? 3 : 2) ||
      tail.filter(a => /^vm:C:\/[A-Za-z0-9/._-]+$/.test(a)).length !== 1 ||
      tail.filter(a => a.startsWith('/') && !/[\r\n:]/.test(a)).length !== 1)) fail('MAC_COMMAND_REFUSED');
  const pinned = [`HostName=${hostName}`, 'ProxyCommand=none', 'ProxyJump=none', 'PermitLocalCommand=no',
    'ClearAllForwardings=yes', 'RemoteCommand=none', 'StrictHostKeyChecking=yes'].flatMap(v => ['-o', v]);
  return [...prefix, ...pinned, ...tail];
}

export function createRowTransport(options, { child = runChild, check = () => {}, pause = sleep, now = Date.now } = {}) {
  const config = () => readInput(options.sshConfig).toString('utf8');
  const hostName = verifyNetwork(config()), expected = JSON.parse(readInput(options.vmRecord));
  const user = guestUser(options);
  verifyRecord(expected, options.vmId, hostName);
  const call = async (command, args, settings = {}, finishing = false) => {
    if (!finishing) check();
    if (verifyNetwork(config()) !== hostName) fail('NOT_VM_NETWORK');
    const admitted = commandPolicy(options, hostName, command, args, settings);
    const result = await child(command, admitted, settings);
    if (!ok(result)) fail(command === UTMCTL ? 'VM_RESTORE_FAILED' : 'VM_TRANSPORT_FAILED');
    return result.stdout;
  };
  const ssh = async (script, finishing = false) => guestCommandOutput(await call('/usr/bin/ssh', ['-F', options.sshConfig, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    'vm', 'powershell -NoProfile -NonInteractive -Command -'], { timeout: 60000, maxBytes: 65536,
    input: `& {\n$ErrorActionPreference='Stop'\ntry {\n${script}\n[Console]::Out.WriteLine('SLEIGHT_GUEST_OK')\n} catch { [Console]::Error.WriteLine('VM_ROW_REFUSED'); exit 1 }\n}\n\n` }, finishing));
  const scp = (from, to, recursive = false, finishing = false) => call('/usr/bin/scp', ['-q', '-F', options.sshConfig, '-o', 'BatchMode=yes',
    ...recursive ? ['-r'] : [], from, to], { timeout: 60000, maxBytes: 4096 }, finishing);
  const status = async () => {
    const value = (await call(UTMCTL, ['status', options.vmId], { timeout: 30000, maxBytes: 4096 }, true)).trim();
    if (!['started', 'paused', 'stopped', 'starting', 'stopping', 'resuming', 'pausing'].includes(value)) fail('VM_STATUS_INVALID');
    return value;
  };
  const stopDisposable = async () => {
    const current = await status();
    if (current !== 'stopped') {
      if (current !== 'stopping') await call(UTMCTL, ['stop', options.vmId], { timeout: 60000, maxBytes: 4096 }, true);
      const end = now() + 30000;
      for (let polls = 0; await status() !== 'stopped'; polls++) {
        if (now() >= end || polls >= 30) fail('VM_STOP_TIMEOUT');
        await pause(1000);
      }
    }
  };
  return {
    status,
    async restore() {
      const plan = rowPlan(options);
      if (plan.restoreMode === 'disposable') {
        await stopDisposable();
        await call(UTMCTL, ['start', '--disposable', '--hide', options.vmId], { timeout: 60000, maxBytes: 4096 });
      } else for (const args of plan.restore) await call(UTMCTL, args, { timeout: 60000, maxBytes: 4096 });
    },
    async finish() {
      if (rowPlan(options).restoreMode === 'disposable') await stopDisposable();
    },
    async ready() {
      const end = now() + 300000;
      let session;
      for (;;) {
        try {
          session = JSON.parse(await ssh(READY_SOURCE));
          if (!Array.isArray(session.addresses) || !session.addresses.includes(hostName)) fail('VM_ADDRESS_CHANGED');
          if (session.sessionId !== 1 || session.user?.toLowerCase() !== user.toLowerCase() || session.state !== 0) fail('VM_SESSION_NOT_READY');
          break;
        } catch (error) {
          if (!['VM_TRANSPORT_FAILED', 'VM_SESSION_NOT_READY'].includes(error.message) || now() >= end) throw error;
          await pause(2000);
        }
      }
      // The pinned endpoint and the active interactive login must both be ready.
      const pin = Buffer.from(JSON.stringify(expected)).toString('base64');
      await ssh(`$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pin}')) | ConvertFrom-Json
function Hash([string]$v) { $h=[Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($v.Trim().ToLowerInvariant())))).Replace('-','').ToLowerInvariant() } finally { $h.Dispose() } }
$system=Get-CimInstance Win32_ComputerSystem
$guid=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid
if ($system.Manufacturer -cne 'QEMU' -or $system.Model -cne $expected.model -or
    [int](Get-CimInstance Win32_OperatingSystem).BuildNumber -ne $expected.build -or
    (Hash $system.Name) -cne $expected.hostnameSha256 -or (Hash $guid) -cne $expected.machineGuidSha256) { throw 'VM_IDENTITY_MISMATCH' }`);
      return session;
    },
    async probe() {
      const sample = JSON.parse(await ssh(`$guestUser=${quote(user)}\n` + readFileSync(new URL('./vm-session-probe.ps1', import.meta.url), 'utf8')));
      if (sample.clipboard?.sessionId !== 1 || sample.clipboard.station !== 'WinSta0' || sample.clipboard.desktop !== 'Default' ||
          sample.clipboard.error !== 0 || !Number.isSafeInteger(sample.clipboard.sequence) || sample.clipboard.sequence < 0 ||
          typeof sample.whoami !== 'string' || sample.whoami.split('\\').at(-1).toLowerCase() !== user.toLowerCase()) fail('VM_PROBE_INVALID');
      return sample;
    },
    async settle(row) {
      if (!['person-key-before', 'person-key-during', 'escape-ignored-injected'].includes(row.id)) return;
      const end = now() + 300000;
      for (;;) {
        // This is guest fixture preparation, not a Mac presence guard. Waiting
        // out the guest's own lock never grants the injector permission to act.
        const sample = await this.probe(), c = sample.clipboard;
        if (c.lastInputOk !== true || c.foregroundLockOk !== true || !Number.isSafeInteger(c.lastInputAgeMs) ||
            c.lastInputAgeMs < 0 || !Number.isSafeInteger(c.foregroundLockMs) || c.foregroundLockMs < 0) fail('VM_PROBE_INVALID');
        // A configured interval can be days long. Record it without changing
        // guest policy or treating an unexpired interval as fixture admission.
        if (c.foregroundLockMs > 300000) return { ...sample, foregroundSettle: 'interval-exceeds-wait-budget' };
        if (c.lastInputAgeMs >= c.foregroundLockMs) return sample;
        if (now() >= end) fail('VM_SESSION_NOT_READY');
        check(); await pause(Math.min(60000, c.foregroundLockMs - c.lastInputAgeMs + 50));
      }
    },
    async clock() { await ssh(`Set-Date -Date ([DateTimeOffset]::Parse('${new Date(now()).toISOString()}').LocalDateTime) | Out-Null`); },
    async kit() {
      await ssh("New-Item -ItemType Directory -Path 'C:\\sleight' -Force | Out-Null");
      await scp(resolve(options.kit) + '/.', 'vm:C:/sleight/', true);
      // /T visits files too. Inheritance flags on those grants left files with
      // empty protected DACLs in the guest, despite icacls returning success.
      await ssh(`& icacls.exe 'C:\\sleight' /reset /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'KIT_ACL_FAILED' }
& icacls.exe 'C:\\sleight' /inheritance:r /grant:r ${quote(user + ':RX')} 'SYSTEM:F' '*S-1-5-32-544:F' /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'KIT_ACL_FAILED' }`);
    },
    async row(row, token) {
      const bank = `C:\\sleight-setup\\uc3f-${token}`;
      const request = Buffer.from(JSON.stringify({ row, expected })).toString('base64');
      await ssh(`$bank=${quote(bank)}
New-Item -ItemType Directory -Path $bank -ErrorAction Stop | Out-Null
& icacls.exe $bank /inheritance:r /grant:r ${quote(user + ':(OI)(CI)M')} 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'BANK_ACL_FAILED' }
[IO.File]::WriteAllBytes((Join-Path $bank 'row.json'),[Convert]::FromBase64String('${request}'))
$launchSource=${quote(`& 'C:\\sleight\\bench\\windows\\vm-row-task.ps1' -Bank '${bank}'`)}
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launchSource))
$arguments='/d /s /c ""C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand '+$encoded+' 1> "'+$bank+'\\row-launch.stdout.txt" 2> "'+$bank+'\\row-launch.stderr.txt""'
$a=New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\cmd.exe' -Argument $arguments -WorkingDirectory $bank
$p=New-ScheduledTaskPrincipal -UserId ${quote(user)} -LogonType Interactive -RunLevel Limited
$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'sleight-vm-${token}' -Action $a -Principal $p -Settings $s -ErrorAction Stop | Out-Null
Start-ScheduledTask -TaskName 'sleight-vm-${token}'`);
      const started = now(), end = started + 900000;
      for (;;) {
        const reply = JSON.parse(await ssh(`$path=${quote(bank + '\\row-result.json')}
if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw } else {
  $task=Get-ScheduledTask -TaskName 'sleight-vm-${token}' -ErrorAction Stop
  $info=Get-ScheduledTaskInfo -InputObject $task
  $diagnostic=@{state=$task.State.ToString();result=[long]$info.LastTaskResult;
    lastRun=$info.LastRunTime.ToUniversalTime().ToString('o');actions=@($task.Actions | Select-Object Execute,Arguments,WorkingDirectory)}
  $diagnostic.scriptExists=Test-Path -LiteralPath 'C:\\sleight\\bench\\windows\\vm-row-task.ps1'
  $diagnostic.kitAcls=@('C:\\sleight','C:\\sleight\\bench','C:\\sleight\\bench\\windows','C:\\sleight\\bench\\windows\\vm-row-task.ps1') | ForEach-Object {@{path=$_;acl=(Get-Acl -LiteralPath $_).Sddl}}
  $diagnostic.kitEntries=@(Get-ChildItem -LiteralPath 'C:\\sleight' | Select-Object Name)
  $diagnostic.bankAcl=(Get-Acl -LiteralPath ${quote(bank)}).Sddl
  $diagnostic.taskXml=Export-ScheduledTask -TaskName 'sleight-vm-${token}'
  $json=$diagnostic | ConvertTo-Json -Depth 4 -Compress
  [IO.File]::WriteAllText(${quote(bank + '\\row-task-status.json')},$json,(New-Object Text.UTF8Encoding($false)))
  @{pending=$true;task=$diagnostic} | ConvertTo-Json -Depth 5 -Compress
}`));
        if (reply.pending !== true) {
          if (reply.recorded !== true || reply.row !== row.id) fail('VM_ROW_FAILED');
          return reply;
        }
        if (reply.task?.state === 'Ready' && Number.isSafeInteger(reply.task.result) &&
            (reply.task.result !== 0 && ![267009, 267011].includes(reply.task.result) ||
             reply.task.result === 0 && now() - started >= 15000)) fail('VM_ROW_FAILED');
        if (now() >= end) fail('VM_ROW_TIMEOUT');
        await pause(2000);
      }
    },
    async capture(token, destination) {
      if (!/^[a-f0-9]{16}$/.test(token)) fail('ROW_TOKEN_INVALID');
      const name = 'capture-' + randomBytes(8).toString('hex');
      await ssh(`$bank=${quote('C:\\sleight-setup\\uc3f-' + token)}
$stage=Join-Path $bank ${quote(name)}
$files=@(Get-ChildItem -LiteralPath $bank -File)
$raw=Join-Path $bank 'raw'
if (Test-Path -LiteralPath $raw) {
  if ((Get-Item -LiteralPath $raw).Attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'CAPTURE_UNSAFE'}
  $files+=@(Get-ChildItem -LiteralPath $raw -File)
}
if ($files.Count -gt 2000) {throw 'CAPTURE_LIMIT'}
$bytes=0L
foreach ($file in $files) {
  if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -gt 33554432) {throw 'CAPTURE_UNSAFE'}
  $bytes+=$file.Length
}
if ($bytes -gt 134217728) {throw 'CAPTURE_LIMIT'}
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($file in $files) {
  $target=$stage
  if ($file.DirectoryName -eq $raw) {
    $target=Join-Path $stage 'raw'
    if (!(Test-Path -LiteralPath $target)) {New-Item -ItemType Directory -Path $target | Out-Null}
  }
  Copy-Item -LiteralPath $file.FullName -Destination $target
}`, true);
      if (!existsSync(destination)) mkdirSync(destination, { mode: 0o700 });
      if (!lstatSync(destination).isDirectory() || lstatSync(destination).isSymbolicLink()) fail('BANK_UNSAFE');
      await scp(`vm:C:/sleight-setup/uc3f-${token}/${name}/`, join(destination, name), true, true);
    },
    async copy(token, paths) {
      for (const [name, path] of [['uc3f-row-raw.json', paths.rawOut], ['uc3f-observations.json', paths.evidenceOut],
        ['uc3f-observations.attestation.json', paths.attestationOut]]) await scp(`vm:C:/sleight-setup/uc3f-${token}/${name}`, path, false, true);
    },
  };
}

function atomic(path, value) {
  const stage = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(stage, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(stage, path);
}
function failedBootstrap(attempt, raw) {
  if (attempt?.receipt?.status !== 'fail' || attempt.receipt.code !== 'HOST_CACHE_UNSAFE') return false;
  if (!raw) {
    raw = JSON.parse(readBounded(attempt.rawOut, 32 * 1024 * 1024));
    combineRowData([{ raw, bundleBytes: readBounded(attempt.evidenceOut),
      attestation: JSON.parse(readBounded(attempt.attestationOut, 16384)) }]);
  }
  return raw.logs.length > 0 && raw.logs.every(text => {
    const lines = text.trim().split(/\r?\n/).map(JSON.parse), end = lines.at(-1);
    return end.kind === 'end' && end.code === 'HOST_CACHE_UNSAFE' && end.trials === 0 && end.hookRemoved === false &&
      !lines.some(line => line.kind === 'trial');
  });
}
export async function runRows(options, dependencies = {}) {
  const plan = rowPlan(options);
  if (!['bank', 'kit', 'sshConfig', 'vmId', 'vmRecord'].every(k => typeof options[k] === 'string' && options[k])) fail('RUN_ARGUMENTS_REQUIRED');
  const bank = resolve(options.bank), ownerAwayFile = options.ownerAwayFile ?? (dependencies.env ?? process.env).SLEIGHT_OWNER_AWAY_FILE;
  if (typeof ownerAwayFile !== 'string' || !ownerAwayFile) fail('OWNER_AWAY_REQUIRED');
  const check = () => { if (!existsSync(ownerAwayFile)) fail('OWNER_AWAY_REQUIRED'); };
  const holdFile = options.holdFile ?? '/tmp/sleight-hold';
  const waitHold = async state => {
    if (!existsSync(holdFile)) return;
    const start = (dependencies.now ?? Date.now)();
    state.waits ??= [];
    const wait = { reason: 'hold', start: new Date(start).toISOString() }; state.waits.push(wait);
    atomic(join(bank, 'state.json'), state);
    while (existsSync(holdFile)) { check(); await (dependencies.pause ?? sleep)(60000); }
    wait.ms = (dependencies.now ?? Date.now)() - start;
  };
  const unlock = (dependencies.lock ?? lockVM)();
  try {
    check();
    const manifest = readBounded(join(options.kit, 'guest-manifest.json'), 4 * 1024 * 1024);
    const kit = JSON.parse(manifest);
    verifyKit(options.kit, { expectedCommit: kit.commit, expectedManifestSha256: hash(manifest) });
    if (!['bench/windows/vm-row-task.ps1', 'bench/windows/vm-row-guest.mjs'].every(path => kit.files.some(f => f.path === path))) fail('ROW_ADAPTER_REQUIRED');
    const identity = { restoreMode: plan.restoreMode, snapshot: plan.snapshot, guestUser: plan.guestUser, vmId: options.vmId, rows: plan.rows,
      kit: resolve(options.kit), kitHash: hash(manifest), sshHash: hash(readInput(options.sshConfig)),
      vmHash: hash(readInput(options.vmRecord)), ownerAwayFile: resolve(ownerAwayFile) };
    if (!existsSync(bank)) mkdirSync(bank, { mode: 0o700 });
    if (!lstatSync(bank).isDirectory() || lstatSync(bank).isSymbolicLink()) fail('BANK_UNSAFE');
    const statePath = join(bank, 'state.json');
    const state = existsSync(statePath) ? JSON.parse(readBounded(statePath, 1024 * 1024)) :
      { schema: SCHEMA, identity, rows: plan.rows.map(r => ({ id: r.id, status: 'pending', attempts: [] })) };
    if (state.schema !== SCHEMA || JSON.stringify(state.identity) !== JSON.stringify(identity) ||
        !Array.isArray(state.rows) || state.rows.length !== plan.rows.length || state.rows.some((r, i) => r.id !== plan.rows[i].id ||
          !['pending', 'running', 'finished', 'evidence-lost'].includes(r.status) || !Array.isArray(r.attempts))) fail('STATE_IDENTITY_CHANGED');
    const save = () => atomic(statePath, state);
    const transport = (dependencies.transport ?? createRowTransport)(options, { ...dependencies, check });
    const verifyAttempt = (row, attempt) => {
      const raw = JSON.parse(readBounded(attempt.rawOut, 32 * 1024 * 1024));
      const expected = JSON.parse(readInput(options.vmRecord));
      if (raw.context?.revision !== kit.commit || raw.context?.kitManifestSha256 !== identity.kitHash ||
          Object.entries(raw.context.vm).some(([k, v]) => expected[k] !== v) || !raw.logs?.length ||
          raw.logs.some(text => JSON.parse(text.split('\n')[0]).rowId !== row.id)) fail('ROW_EVIDENCE_MISMATCH');
      combineRowData([{ raw, bundleBytes: readBounded(attempt.evidenceOut),
        attestation: JSON.parse(readBounded(attempt.attestationOut, 16384)) }]);
      return raw;
    };
    delete state.stop;
    save();
    try {
      // Preserve the current guest before an earlier incomplete row can
      // restore it. A failed recursive browser-profile copy may have left
      // valid attested row files on the host already.
      for (const row of state.rows) {
        const previous = row.attempts.at(-1);
        if (!previous?.evidencePending) continue;
        await waitHold(state);
        try { await transport.capture(previous.token, previous.failureOut); }
        catch {
          previous.copyFailure = 'VM_EVIDENCE_COPY_FAILED'; save();
          if (plan.restoreMode !== 'disposable' || await transport.status() !== 'stopped') fail('VM_EVIDENCE_COPY_FAILED');
          previous.evidencePending = false; row.status = 'evidence-lost'; row.reason = 'VM_EVIDENCE_LOST_AFTER_STOP'; save();
          continue;
        }
        previous.evidencePending = false;
        if (previous.receipt?.recorded === true && previous.receipt.row === row.id) {
          try {
            const raw = verifyAttempt(row, previous);
            if (!failedBootstrap(previous, raw)) row.status = 'finished';
          } catch { /* preserve partial files and retry the unfinished row */ }
        }
        save(); await transport.finish();
      }
      for (const [i, row] of state.rows.entries()) {
        const last = row.attempts.at(-1);
        if (last?.disposePending) {
          await waitHold(state); await transport.finish(); last.disposePending = false; save();
        }
        if (row.status === 'evidence-lost') {
          let recovered = false;
          // An interrupted full-bank copy may fail even after all three
          // attested files arrived. Only a verified zero-trial bootstrap can
          // recover this way; unavailable row observations stay excluded.
          try { recovered = failedBootstrap(last); } catch { /* keep the recorded loss */ }
          if (recovered) {
            last.recoveredLoss = row.reason; last.harnessStop = 'HOST_CACHE_UNSAFE';
            delete row.reason; row.status = 'running'; save();
          }
        }
        // Older banks called a failed host bootstrap finished even though no
        // trial or observer ran. Verify those bytes before reopening that row.
        if (row.status === 'finished' && failedBootstrap(last)) {
          last.harnessStop = 'HOST_CACHE_UNSAFE'; row.status = 'running'; save();
        }
        if (row.status === 'finished' || row.status === 'evidence-lost') continue;
        check();
        await waitHold(state);
        const token = randomBytes(8).toString('hex'), base = join(bank, `${row.id}-${token}`);
        const paths = { rawOut: base + '-raw.json', evidenceOut: base + '-evidence.json', attestationOut: base + '-attestation.json' };
        row.attempts.push({ token, ...paths, failureOut: base + '-guest' }); row.status = 'running'; save();
        const attempt = row.attempts.at(-1), started = (dependencies.now ?? Date.now)();
        try {
          check(); await transport.restore();
          check(); attempt.ready = await transport.ready();
          attempt.restoreToReadyMs = (dependencies.now ?? Date.now)() - started; save();
          if (transport.settle) {
            const before = (dependencies.now ?? Date.now)();
            attempt.fixtureBaseline = await transport.settle(plan.rows[i]);
            attempt.fixtureSettleMs = (dependencies.now ?? Date.now)() - before; save();
          }
          await waitHold(state);
          for (const step of ['clock', 'kit']) { check(); await transport[step](); }
          attempt.evidencePending = true; save();
          check(); row.attempts.at(-1).receipt = await transport.row(plan.rows[i], token); save();
          await transport.copy(token, paths);
          if (attempt.receipt?.status === 'fail') await transport.capture(token, attempt.failureOut);
          // Verify copied bytes and their attestation before committing the row.
          const raw = verifyAttempt(row, attempt);
          if (failedBootstrap(attempt, raw)) {
            attempt.evidencePending = false; attempt.harnessStop = 'HOST_CACHE_UNSAFE'; save(); fail('VM_ROW_FAILED');
          }
          attempt.evidencePending = false; row.status = 'finished'; save();
        } catch (error) {
          if (attempt.evidencePending) {
            try { await transport.capture(token, attempt.failureOut); attempt.evidencePending = false; }
            catch {
              attempt.copyFailure = 'VM_EVIDENCE_COPY_FAILED';
              if (!existsSync(ownerAwayFile)) {
                attempt.evidencePending = false; row.status = 'evidence-lost'; row.reason = 'VM_EVIDENCE_COPY_FAILED_ON_OWNER_RETURN';
              }
            }
            save();
          }
          throw error;
        } finally {
          if (!attempt.evidencePending) {
            attempt.disposePending = plan.restoreMode === 'disposable'; save();
            await transport.finish(); attempt.disposePending = false; save();
          }
        }
        check();
      }
      state.completed = true;
    } catch (error) { state.completed = false; state.stop = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : 'VM_ROWS_FAILED'; }
    const sources = state.rows.filter(r => r.status === 'finished').map(r => r.attempts.at(-1));
    try { if (sources.length) {
      // A recovered bootstrap can replace an unmeasured source at the same
      // row count. Preserve every earlier immutable combined bundle.
      const output = join(bank, 'export-' + hash(JSON.stringify(sources.map(s => s.rawOut))).slice(0, 16));
      if (!existsSync(output)) mkdirSync(output, { mode: 0o700 });
      if (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink()) fail('BANK_UNSAFE');
      state.export = combineRowExports(sources, output);
    } }
    catch { state.completed = false; state.stop ??= 'VM_EXPORT_FAILED'; }
    save(); return state;
  } finally { unlock(); }
}

export function parseArgs(args) {
  const options = {}, seen = new Set();
  const values = { '--bank': 'bank', '--kit': 'kit', '--ssh-config': 'sshConfig', '--vm-id': 'vmId', '--vm-record': 'vmRecord',
    '--restore-mode': 'restoreMode', '--snapshot': 'snapshot', '--rows': 'rows', '--owner-away-file': 'ownerAwayFile', '--guest-user': 'guestUser',
    '--test-gate-file': 'testGateFile', '--legacy-done-file': 'legacyDoneFile', '--legacy-blocked-file': 'legacyBlockedFile' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) fail('DUPLICATE_OPTION'); seen.add(flag);
    if (flag === '--dry-run') options.dryRun = true;
    else if (values[flag] && args[i + 1] && !args[i + 1].startsWith('--')) options[values[flag]] = flag === '--rows' ? args[++i].split(',') : args[++i];
    else fail('INVALID_OPTION');
  }
  rowPlan(options); return options;
}
export async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(args);
  const result = options.dryRun ? { ...rowPlan(options), dryRun: true } : await runRows(options, dependencies);
  (dependencies.print ?? (s => process.stdout.write(s)))(JSON.stringify(result, null, 2) + '\n'); return result;
}
if (isMain(import.meta.url)) main().then(r => { process.exitCode = r.dryRun || r.completed ? 0 : 1; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
