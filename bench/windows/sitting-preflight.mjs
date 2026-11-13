// Read-only VM inventory and reviewed kit deployment. No boot, input or capture.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { verifyNetwork, verifyRecord, runUC3FSitting } from './uc3f-sitting.mjs';
import { lockVM, UTMCTL, READY_SOURCE } from './vm-rows.mjs';
import { runChild, isMain } from './kit.mjs';
import { guestCommandOutput } from './guest-stdin.mjs';
import { verifyKit } from './guest-integrity.mjs';
import { checkJSONOutput } from '../sitting-process.mjs';

const quote = value => "'" + value.replaceAll("'", "''") + "'";
const probeSource = readFileSync(new URL('./kit-probe.cjs', import.meta.url), 'utf8');
export function kitProbe(root, commit = '', hash = '') {
  return `& {
$kit = & 'C:\\Program Files\\nodejs\\node.exe' -e ${quote(probeSource + '\nconsole.log(JSON.stringify(probe(...process.argv.slice(1))))')} -- ${quote(root)} ${quote(commit)} ${quote(hash)}
if ($LASTEXITCODE -ne 0) { throw 'KIT_PROBE_FAILED' }
$kit | ConvertFrom-Json
}`;
}
export function kitACL(user) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(user ?? '')) throw Error('GUEST_USER_INVALID');
  // The SSH administrator must not remain an additional source writer for the
  // Limited console user. Give that console user read/execute only.
  return `icacls 'C:\\sleight' /reset /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'KIT_ACL_FAILED' }
$acl=icacls 'C:\\sleight' /inheritance:r /grant:r ${quote(user + ':RX')} 'SYSTEM:F' '*S-1-5-32-544:F' /T /Q
if ($LASTEXITCODE -ne 0 -or ($acl -join ' ') -notmatch 'Failed processing 0 files') { throw 'KIT_CHILD_ACL_FAILED' }
@{acl=($acl -join ' ')} | ConvertTo-Json -Compress`;
}
export const INVENTORY = `${READY_SOURCE}
$stage='word-inventory'
$word = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WINWORD.EXE',
 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WINWORD.EXE',
 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WINWORD.EXE') |
 ForEach-Object { if (Test-Path -LiteralPath $_) { (Get-Item -LiteralPath $_).GetValue('') } }
$office = @('C:\\Program Files\\Microsoft Office','C:\\Program Files (x86)\\Microsoft Office') |
 Where-Object { Test-Path -LiteralPath $_ } |
 ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter WINWORD.EXE -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName } }
$wordFiles = @(@($word) + @($office) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)
$manifest = 'C:\\sleight\\guest-manifest.json'
$stage='system-inventory'
$system = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
function Hash([string]$value) {
 $sha = [Security.Cryptography.SHA256]::Create()
 try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value.Trim().ToLowerInvariant())))).Replace('-','').ToLowerInvariant() }
 finally { $sha.Dispose() }
}
$key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\\Microsoft\\Cryptography')
try { $guid = Hash ([string]$key.GetValue('MachineGuid')) } finally { $key.Close() }
$stage='kit-inventory'
$kitInfo = if(Test-Path -LiteralPath $manifest) { ${kitProbe('C:\\sleight')} } else { $null }
$stage='task-inventory'
$tasks=@(Get-ScheduledTask -TaskName 'sleight-wsit1-build-*' -ErrorAction SilentlyContinue | ForEach-Object {
  $taskBank=[regex]::Match($_.Actions[0].Arguments,'^"(C:\\\\sleight-setup\\\\uc3f-[a-f0-9]{16})" 1 900$').Groups[1].Value
  @{name=$_.TaskName;state=[string]$_.State;arguments=$_.Actions[0].Arguments;
   files=$(if($taskBank){@(Get-ChildItem -LiteralPath $taskBank -File | ForEach-Object { @{name=$_.Name;bytes=$_.Length} })}else{@()})}
 })
$stage='inventory-output'
@{manufacturer=$system.Manufacturer; model=$system.Model; build=[int]$os.BuildNumber;
 hostnameSha256=(Hash ([string]$system.Name)); machineGuidSha256=$guid;
 sshUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name;
 sshElevated=(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
 nodeVersion=(& 'C:\\Program Files\\nodejs\\node.exe' --version);
 nodeArch=(& 'C:\\Program Files\\nodejs\\node.exe' -p process.arch);
 wordInstalled=($wordFiles.Count -gt 0); wordPaths=$wordFiles;
 buildTasks=$tasks; kitCommit=$kitInfo.commit; kitManifestSha256=$kitInfo.manifestSha256;
 kitProbe=$kitInfo;
 utc=[DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 5 -Compress`;

export async function preflight(options, dependencies = {}) {
  const child = dependencies.runChild ?? runChild;
  const hostName = verifyNetwork(readFileSync(options.sshConfig, 'utf8'));
  const expected = JSON.parse(readFileSync(options.vmRecord, 'utf8'));
  verifyRecord(expected, options.vmId, hostName);
  const operations = [];
  const call = async (command, args, settings = {}) => {
    const result = await child(command, args, { timeout: 60000, maxBytes: 1024 * 1024, ...settings });
    operations.push({ command, status: result.status, reason: result.reason, stdout: result.stdout, stderr: result.stderr });
    if (result.status !== 0 || result.reason || result.signal) throw Error('PREFLIGHT_CHILD_FAILED');
    return result.stdout;
  };
  const pinned = [`HostName=${hostName}`, 'BatchMode=yes', 'ConnectTimeout=10', 'StrictHostKeyChecking=yes',
    'ProxyCommand=none', 'ProxyJump=none', 'PermitLocalCommand=no', 'ClearAllForwardings=yes', 'RemoteCommand=none']
    .flatMap(value => ['-o', value]);
  const ssh = async source => {
    if (verifyNetwork(readFileSync(options.sshConfig, 'utf8')) !== hostName) throw Error('SSH_CONFIG_CHANGED');
    return guestCommandOutput(await call('/usr/bin/ssh', ['-F', options.sshConfig, ...pinned, 'vm',
      'powershell -NoProfile -NonInteractive -Command -'], { input: `& {\n$ErrorActionPreference='Stop'\n$stage='session'\ntry {\n${source}\n[Console]::Out.WriteLine('SLEIGHT_GUEST_OK')\n} catch { [Console]::Error.WriteLine($stage+': '+$_.Exception.GetType().FullName+': '+$_.Exception.Message); exit 1 }\n}\n\n` }));
  };
  const unlock = (dependencies.lock ?? lockVM)();
  try {
    const status = (await call(UTMCTL, ['status', options.vmId])).trim();
    if (status !== 'started') throw Error('VM_NOT_STARTED');
    const inventory = (await ssh(INVENTORY)).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    for (const key of ['manufacturer', 'model', 'build', 'hostnameSha256', 'machineGuidSha256'])
      if (inventory.at(-1)[key] !== expected[key]) throw Error('VM_IDENTITY_MISMATCH');
    let deployed;
    const user = options.guestUser ?? inventory[0]?.user;
    if (options.guestUser && options.guestUser.toLowerCase() !== inventory[0]?.user?.toLowerCase()) throw Error('VM_SESSION_MISMATCH');
    if (options.kit) {
      const kit = resolve(options.kit), bytes = readFileSync(resolve(kit, 'guest-manifest.json'));
      const manifest = JSON.parse(bytes), hash = createHash('sha256').update(bytes).digest('hex');
      verifyKit(kit, { expectedCommit: manifest.commit, expectedManifestSha256: hash });
      const backup = `sleight-kit-${options.backupToken}`;
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(options.backupToken ?? '')) throw Error('BACKUP_TOKEN_REQUIRED');
      const stage = `sleight-stage-${options.backupToken}`;
      await ssh(`if (Test-Path -LiteralPath 'C:\\${backup}') { throw 'BACKUP_EXISTS' }
if (Test-Path -LiteralPath 'C:\\${stage}') { throw 'STAGE_EXISTS' }`);
      await call('/usr/bin/scp', ['-q', '-F', options.sshConfig, ...pinned, '-r', kit, `vm:C:/${stage}`]);
      const receipt = await ssh(`$stage='verify-staged-kit'
$verified = ${kitProbe(`C:\\${stage}`, manifest.commit, hash)}
$stage='publish-kit'
if (Test-Path -LiteralPath 'C:\\${backup}') { throw 'BACKUP_EXISTS' }
$preserved=$false
if (Test-Path -LiteralPath 'C:\\sleight') {
 Rename-Item -LiteralPath 'C:\\sleight' -NewName '${backup}' -ErrorAction Stop
 $preserved=$true
}
try { Rename-Item -LiteralPath 'C:\\${stage}' -NewName 'sleight' -ErrorAction Stop }
catch {
 if ($preserved -and -not (Test-Path -LiteralPath 'C:\\sleight')) { Rename-Item -LiteralPath 'C:\\${backup}' -NewName 'sleight' -ErrorAction Stop }
 throw
}
$verified | ConvertTo-Json -Compress`);
      deployed = JSON.parse(receipt);
    }
    const acl = options.kit || options.lockKit === 'yes' ? JSON.parse(await ssh(kitACL(user))) : undefined;
    let selftest;
    if (options.selftestJob) {
      selftest = await runUC3FSitting({ host: 'vm', guestRoot: 'C:\\sleight', guestUser: user,
        guestSelftest: true, selftestJob: options.selftestJob, ownerAway: true, ownerAwayFile: options.ownerAwayFile,
        sshConfig: options.sshConfig, vmRecord: options.vmRecord, vmId: options.vmId });
    }
    let driverBuild;
    if (options.driverBuild === 'yes' || options.resumeBuild) {
      const token = options.resumeBuild ?? randomBytes(8).toString('hex');
      if (!/^[a-f0-9]{16}$/.test(token)) throw Error('BUILD_IDENTITY_REQUIRED');
      const bank = `C:\\sleight-setup\\uc3f-${token}`;
      const task = `sleight-wsit1-build-${token}`, revision = deployed?.commit ?? inventory.at(-1).kitCommit;
      operations.push({ operation: 'driver-build', bank, task });
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(user ?? '') || !/^[a-f0-9]{40}$/.test(revision ?? '')) throw Error('BUILD_IDENTITY_REQUIRED');
      const source = `$ErrorActionPreference='Stop'
try {
 $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
 if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0) { throw 'LIMITED_SESSION_REQUIRED' }
 $env:CLAUDE_CONFIG_DIR=Join-Path $env:TEMP ('lane-claude-'+[Guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $env:CLAUDE_CONFIG_DIR | Out-Null
 [Diagnostics.Process]::GetCurrentProcess().PriorityClass='Idle'
 Set-Location -LiteralPath 'C:\\sleight'
 & 'C:\\Program Files\\nodejs\\node.exe' bench/windows/driver-sitting.mjs --phase build --revision '${revision}' --output '${bank}\\build.json'
 [IO.File]::WriteAllText('${bank}\\build.rc',[string]$LASTEXITCODE)
} catch { [IO.File]::WriteAllText('${bank}\\build.error',[string]$_.Exception.Message) }`;
      const encoded = Buffer.from(source).toString('base64');
      if (!options.resumeBuild) await ssh(`New-Item -ItemType Directory -Path '${bank}' -ErrorAction Stop | Out-Null
[IO.File]::WriteAllBytes('${bank}\\uc3f-task.ps1',[Convert]::FromBase64String('${encoded}'))
$source=[IO.File]::ReadAllText('C:\\sleight\\bench\\windows\\uc3f-task-host.cs')
Add-Type -TypeDefinition $source -OutputAssembly '${bank}\\uc3f-task-host.exe' -OutputType WindowsApplication
$a=New-ScheduledTaskAction -Execute '${bank}\\uc3f-task-host.exe' -Argument '"${bank}" 1 900' -WorkingDirectory '${bank}'
$p=New-ScheduledTaskPrincipal -UserId ${quote(user)} -LogonType Interactive -RunLevel Limited
$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName '${task}' -Action $a -Principal $p -Settings $s -ErrorAction Stop | Out-Null
Start-ScheduledTask -TaskName '${task}'`);
      const deadline = Date.now() + 330000;
      while (Date.now() < deadline) {
        const state = JSON.parse(await ssh(`$task=Get-ScheduledTask -TaskName '${task}'
@{state=[string]$task.State;files=@(Get-ChildItem -LiteralPath '${bank}' -File | ForEach-Object { $_.Name })} | ConvertTo-Json -Compress`));
        if (state.files.includes('build.error')) throw Error('DRIVER_BUILD_FAILED');
        if (state.files.includes('build.rc')) {
          const stage = mkdtempSync(join(tmpdir(), 'windows-build-receipt-'));
          try {
            for (const name of ['build.json', 'build.rc'])
              await call('/usr/bin/scp', ['-q', '-F', options.sshConfig, ...pinned, `vm:${bank.replaceAll('\\', '/')}/${name}`, join(stage, name)]);
            driverBuild = { rc: readFileSync(join(stage, 'build.rc'), 'utf8').trim(), report: JSON.parse(readFileSync(join(stage, 'build.json'), 'utf8')), bank, task };
            operations.push({ operation: 'driver-build-receipt', ...driverBuild });
          } finally { rmSync(stage, { recursive: true, force: true }); }
          break;
        }
        if (state.state === 'Ready') throw Error('DRIVER_BUILD_NO_RECEIPT');
        await sleep(2000);
      }
      if (!driverBuild) throw Error('DRIVER_BUILD_TIMEOUT');
      if (driverBuild.rc !== '0') throw Error('DRIVER_BUILD_FAILED');
    }
    return { status, inventory, deployed, acl, selftest, driverBuild, operations };
  } catch (error) { error.operations = operations; throw error; }
  finally { unlock(); }
}

if (isMain(import.meta.url)) {
  const options = {}, seen = new Set();
  const names = { '--ssh-config': 'sshConfig', '--vm-record': 'vmRecord', '--vm-id': 'vmId', '--kit': 'kit', '--backup-token': 'backupToken', '--out': 'out',
    '--selftest-job': 'selftestJob', '--guest-user': 'guestUser', '--owner-away-file': 'ownerAwayFile', '--lock-kit': 'lockKit', '--driver-build': 'driverBuild', '--resume-build': 'resumeBuild' };
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!names[process.argv[i]] || !process.argv[i + 1] || seen.has(process.argv[i])) throw Error('INVALID_OPTION');
    seen.add(process.argv[i]);
    options[names[process.argv[i]]] = process.argv[i + 1];
  }
  if (['lockKit', 'driverBuild'].some(key => options[key] !== undefined && options[key] !== 'yes')) throw Error('INVALID_OPTION');
  checkJSONOutput(options.out);
  let report;
  try { report = await preflight(options); }
  catch (error) { report = { error: error.message, operations: error.operations }; process.exitCode = 1; }
  writeFileSync(options.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (report.selftest && !report.selftest.completed) process.exitCode = 1;
  console.log(JSON.stringify({ error: report.error, status: report.status, inventory: report.inventory, deployed: report.deployed, acl: report.acl, selftest: report.selftest, driverBuild: report.driverBuild }));
}
