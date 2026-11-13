// Six user tasks through the real Windows MCP path. No processes start on import or --dry-run.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { isMain, runChild, checkReportPath, writeReport, redactText } from './kit.mjs';
import { verifyKit, sha256 } from './guest-integrity.mjs';
import { guestCommandOutput } from './guest-stdin.mjs';
import { verifyNetwork } from './uc3f-sitting.mjs';
import { commandPolicy, createRowTransport, lockVM, guestUser } from './vm-rows.mjs';
import { RESULT_SCHEMA, TASK_IDS } from './real-tasks-guest.mjs';
import { quietTaskSetup } from './quiet-task.mjs';
export { RESULT_SCHEMA };

const quote = s => "'" + s.replaceAll("'", "''") + "'";
const fail = code => { throw Error(code); };
const MAX_WALL = 540000, CLEANUP_RESERVE = 45000;
const pathFlags = { '--kit': 'kit', '--ssh-config': 'sshConfig', '--vm-record': 'vmRecord',
  '--owner-away-file': 'ownerAwayFile', '--output': 'output' };

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--dry-run') return { dryRun: true };
  const options = {}, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) fail('DUPLICATE_ARGUMENT'); seen.add(flag);
    if (flag === '--allow-fixture-approvals') { options.allowFixtureApprovals = true; continue; }
    const key = pathFlags[flag] ?? ({ '--vm-id': 'vmId', '--guest-user': 'guestUser' })[flag];
    const value = args[++i];
    if (!key || !value || value.startsWith('-') || /[\r\n\0]/.test(value)) fail('INVALID_ARGUMENT');
    options[key] = pathFlags[flag] ? resolve(value) : value;
  }
  if (![...Object.values(pathFlags), 'vmId', 'guestUser', 'allowFixtureApprovals'].every(k => options[k])) fail('RUN_ARGUMENTS_REQUIRED');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(options.vmId)) fail('VM_IDENTITY_REQUIRED');
  guestUser(options);
  return options;
}

export function taskLaunchScript(options, token, expected, kit) {
  if (!/^[a-f0-9]{16}$/.test(token)) fail('TASK_TOKEN_INVALID');
  const bank = `C:\\sleight-setup\\uc3f-${token}`, user = guestUser(options);
  const request = Buffer.from(JSON.stringify({ token, expected, commit: kit.commit, manifestSha256: kit.manifestSha256,
    allowFixtureApprovals: options.allowFixtureApprovals === true })).toString('base64');
  // WH1O's windowless launcher and vm-rows' interactive principal. SSH is outside WinSta0.
  return `$bank=${quote(bank)}
New-Item -ItemType Directory -Path $bank -ErrorAction Stop | Out-Null
& icacls.exe $bank /inheritance:r /grant:r ${quote(user + ':(OI)(CI)M')} 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'BANK_ACL_FAILED' }
[IO.File]::WriteAllBytes((Join-Path $bank 'request.json'),[Convert]::FromBase64String('${request}'))
$launchSource=${quote(`& 'C:\\sleight\\bench\\windows\\real-tasks-task.ps1' -Bank '${bank}'`)}
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launchSource))
${quietTaskSetup('$bank')}
$powershellArguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand '+$encoded
$command=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($powershellArguments))
$arguments=$bank+' '+$command+' row-launch'
$a=New-ScheduledTaskAction -Execute $launcher -Argument $arguments -WorkingDirectory $bank
$p=New-ScheduledTaskPrincipal -UserId ${quote(user)} -LogonType Interactive -RunLevel Limited
$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'sleight-wrt1-${token}' -Action $a -Principal $p -Settings $s -ErrorAction Stop | Out-Null
Start-ScheduledTask -TaskName 'sleight-wrt1-${token}'`;
}

export function parseGuestResult(text, expected) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1048576) fail('RESULT_TOO_LARGE');
  const r = JSON.parse(text);
  if (r.schema !== RESULT_SCHEMA || ['token', 'commit', 'manifestSha256'].some(k => r[k] !== expected[k]) ||
      !Number.isSafeInteger(r.wallMs) || r.wallMs < 0 || r.wallMs >= 600000 || r.cleanup !== 'restore-required' ||
      !Array.isArray(r.tasks) || r.tasks.length !== TASK_IDS.length || !Array.isArray(r.approvals) || r.approvals.length > 32) fail('RESULT_INVALID');
  for (let i = 0; i < TASK_IDS.length; i++) {
    const t = r.tasks[i];
    if (t.id !== TASK_IDS[i] || !['pass', 'fail'].includes(t.status) || typeof t.reason !== 'string' || t.reason.length > 4096 ||
        !Number.isSafeInteger(t.durationMs) || t.durationMs < 0 || t.durationMs > r.wallMs) fail('RESULT_INVALID');
    if (t.status === 'pass') {
      const proof = { notepad: 'fileMatches', explorer: 'treeHasName', edge: 'browserRefused', 'blocked-app': 'refusal', approval: 'declined' }[t.id];
      if (!proof || t.evidence?.[proof] !== true || ['blocked-app', 'approval'].includes(t.id) && t.evidence?.acquisitionOnly !== true) fail('RESULT_PASS_UNPROVED');
    }
  }
  for (const a of r.approvals) {
    if (!TASK_IDS.includes(a.task) || typeof a.app !== 'string' || a.app.length > 200 || !['accept', 'decline'].includes(a.action) ||
        a.action === 'accept' && !(a.task === 'notepad' && /^notepad\.exe$/i.test(a.app) || a.task === 'explorer' && /^explorer\.exe$/i.test(a.app))) fail('RESULT_APPROVAL_INVALID');
  }
  if (r.tasks.find(t => t.id === 'approval').status === 'pass' &&
      !r.approvals.some(a => a.task === 'approval' && a.action === 'decline')) fail('RESULT_PASS_UNPROVED');
  return r;
}

export function resultLines(result) {
  return result.tasks.map(t => `${t.status.toUpperCase()} ${t.id}: ${redactText(t.reason).replace(/[\r\n\t]/g, ' ').slice(0, 500)}`);
}

export function verifyInputs(options) {
  const bytes = readFileSync(resolve(options.kit, 'guest-manifest.json'));
  const manifest = JSON.parse(bytes), manifestSha256 = sha256(bytes);
  const kit = verifyKit(options.kit, { expectedCommit: manifest.commit, expectedManifestSha256: manifestSha256 });
  for (const path of ['bench/windows/real-tasks-guest.mjs', 'bench/windows/real-tasks-task.ps1']) {
    if (!kit.files.some(f => f.path === path)) fail('REAL_TASKS_KIT_REQUIRED');
  }
  return { commit: kit.commit, manifestSha256, expected: JSON.parse(readFileSync(options.vmRecord, 'utf8')) };
}

export function createTaskTransport(options, { check, now = Date.now, deadline, child = runChild, pause = sleep } = {}) {
  const baseOptions = { ...options, restoreMode: 'disposable' };
  const boundedChild = (command, args, settings) => {
    const remaining = deadline - now();
    if (remaining <= 0) fail('RUN_DEADLINE');
    return child(command, args, { ...settings, timeout: Math.max(1, Math.min(settings.timeout, remaining)) });
  };
  const base = createRowTransport(baseOptions, { child: boundedChild, check, pause, now });
  const host = verifyNetwork(readFileSync(options.sshConfig, 'utf8'));
  const ssh = async script => {
    check();
    const settings = { timeout: 60000, maxBytes: 1100000, input: `& {\n$ErrorActionPreference='Stop'\ntry {\n${script}\n[Console]::Out.WriteLine('SLEIGHT_GUEST_OK')\n} catch { [Console]::Error.WriteLine('REAL_TASKS_TRANSPORT_FAILED'); exit 1 }\n}\n\n` };
    const args = commandPolicy(baseOptions, host, '/usr/bin/ssh', ['-F', options.sshConfig, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      'vm', 'powershell -NoProfile -NonInteractive -Command -'], settings);
    if (verifyNetwork(readFileSync(options.sshConfig, 'utf8')) !== host) fail('NOT_VM_NETWORK');
    const r = await boundedChild('/usr/bin/ssh', args, settings);
    if (r.status !== 0 || r.reason || r.signal) fail('REAL_TASKS_TRANSPORT_FAILED');
    return guestCommandOutput(r.stdout);
  };
  return { ...base,
    // The VM's base disk keeps older sittings' kits in C:\sleight, and the guest's kit check refuses unexpected
    // files. This run's boot is disposable, so the old kit goes before the copy. Reparse points stop it.
    async kit() {
      await ssh(`$kit='C:\\sleight'
if (Test-Path -LiteralPath $kit) {
  if ((Get-Item -LiteralPath $kit -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'KIT_PATH_UNSAFE' }
  if (@(Get-ChildItem -LiteralPath $kit -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop).Count) { throw 'KIT_PATH_UNSAFE' }
  Remove-Item -LiteralPath $kit -Recurse -Force -ErrorAction Stop
}`);
      await base.kit();
    },
    async tasks(token, identity) {
      await ssh(taskLaunchScript(options, token, identity.expected, identity));
      for (;;) {
        const text = await ssh(`$result=${quote(`C:\\sleight-setup\\uc3f-${token}\\result.json`)}
if (Test-Path -LiteralPath $result) {
  if ((Get-Item -LiteralPath $result).Length -gt 1048576) { throw 'RESULT_TOO_LARGE' }
  Get-Content -LiteralPath $result -Raw
} else {
  $task=Get-ScheduledTask -TaskName 'sleight-wrt1-${token}' -ErrorAction Stop
  $info=Get-ScheduledTaskInfo -InputObject $task
  $guestError=Join-Path ${quote(`C:\\sleight-setup\\uc3f-${token}`)} 'guest-error.txt'
  $reason=if (Test-Path -LiteralPath $guestError) { (Get-Content -LiteralPath $guestError -Raw).Trim() } else { '' }
  @{pending=$true;state=$task.State.ToString();lastResult=[long]$info.LastTaskResult;guestError=$reason} | ConvertTo-Json -Compress
}`);
        const value = JSON.parse(text);
        if (value.pending !== true) return parseGuestResult(text, { ...identity, token });
        if (value.state === 'Ready' && ![0, 267009, 267011].includes(value.lastResult)) {
          const reason = typeof value.guestError === 'string' ? value.guestError.replace(/[^A-Za-z0-9_ .:-]/g, '?').slice(0, 200) : '';
          fail('TASK_LAUNCH_FAILED_' + value.lastResult + (reason ? ' ' + reason : ''));
        }
        check(); await pause(2000);
      }
    },
  };
}

export async function runRealTasks(options, dependencies = {}) {
  const now = dependencies.now ?? Date.now, started = now(), deadline = started + MAX_WALL;
  const signals = dependencies.signals ?? process;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  const check = () => {
    if (interrupted) fail('INTERRUPTED');
    if (dependencies.check) return dependencies.check();
    if (!existsSync(options.ownerAwayFile)) fail('OWNER_AWAY_REQUIRED');
    if (now() >= deadline - CLEANUP_RESERVE) fail('RUN_DEADLINE');
  };
  (dependencies.checkOutput ?? checkReportPath)(options.output);
  const token = (dependencies.token ?? (() => randomBytes(8).toString('hex')))();
  let identity = {}, unlock, result, transport, error, cleanupError, vmStopped = false;
  signals.on('SIGINT', interrupt); signals.on('SIGTERM', interrupt);
  try {
    check();
    identity = (dependencies.verify ?? verifyInputs)(options);
    unlock = (dependencies.lock ?? lockVM)();
    transport = (dependencies.createTransport ?? createTaskTransport)(options, { ...dependencies, check, now, deadline });
    await transport.restore(); await transport.ready(); await transport.kit();
    result = await transport.tasks(token, identity);
    // Validate even an injected transport; the real transport also validates at intake.
    result = parseGuestResult(JSON.stringify(result), { ...identity, token });
    check();
  } catch (failure) { error = failure.message; }
  finally {
    if (transport) {
      try { await transport.finish(); vmStopped = true; } catch (failure) { cleanupError = failure.message; }
    }
    unlock?.();
    signals.removeListener('SIGINT', interrupt); signals.removeListener('SIGTERM', interrupt);
  }
  result ??= { schema: RESULT_SCHEMA, token, commit: identity.commit, manifestSha256: identity.manifestSha256,
    tasks: TASK_IDS.map(id => ({ id, status: 'fail', reason: error ?? 'TASK_NOT_RUN', durationMs: 0 })), approvals: [] };
  result = { ...result, wallMs: now() - started, vmStopped, ...error ? { error } : {}, ...cleanupError ? { cleanupError } : {} };
  result.ok = result.tasks.every(t => t.status === 'pass') && vmStopped && !result.error && !result.shutdownError && !result.cleanupError;
  (dependencies.write ?? writeReport)(options.output, result);
  for (const line of resultLines(result)) (dependencies.log ?? console.log)(line);
  return result;
}

if (isMain(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.dryRun) console.log(JSON.stringify({ schema: RESULT_SCHEMA, tasks: TASK_IDS, maxWallMs: MAX_WALL,
      cleanupReserveMs: CLEANUP_RESERVE, processes: 0, fixtureApprovals: ['notepad.exe', 'explorer.exe'],
      steps: ['disposable-boot', 'copy-verified-kit', 'interactive-limited-task', 'stdio-mcp-js', 'read-results', 'stop-disposable-vm'],
      escape: 'owner-present: the driver ignores injected Escape' }, null, 2));
    else {
      if (process.platform !== 'darwin') fail('MAC_COORDINATOR_REQUIRED');
      const result = await runRealTasks(options); process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
