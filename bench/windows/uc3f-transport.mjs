// File-only UC3F adapter. Construction is inert. No Mac input or capture path.
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { runChild as defaultChild } from './kit.mjs';
import { UC3F_PROTOCOL, admitUC3FRow } from './uc3f-rows.mjs';
import { guestSelftestPlan, guestDiagnosticPlan } from './uc3f-selftest.mjs';
import { guestCommandOutput } from './guest-stdin.mjs';

const quote = value => "'" + value.replaceAll("'", "''") + "'";
const goodResult = r => r?.status === 0 && !r.signal && !r.reason;
export async function uc3fTransport(options, dependencies = {}) {
  if (options.host !== 'vm' || !['away', 'present'].includes(options.presence) ||
      !/^[A-Za-z0-9-]{1,80}$/.test(options.vmId ?? '') ||
      (options.guestRoot ?? 'C:\\sleight') !== 'C:\\sleight' || !/^[A-Za-z0-9_.-]{1,64}$/.test(options.guestUser ?? 'Sleight')) throw Error('UC3F_TRANSPORT_OPTIONS');
  const child = dependencies.runChild ?? defaultChild;
  const check = dependencies.check ?? (async () => {}), now = dependencies.now ?? Date.now;
  const pause = dependencies.sleep ?? sleep;
  const token = randomBytes(8).toString('hex'), bank = `C:\\sleight-setup\\uc3f-${token}`;
  let taskHostHash, staged = false, invocation = 0, busy = false, cancelled;
  let expected, exported = false;
  const ssh = async (script, timeout = 60000) => {
    await check(); if (cancelled) throw Error(cancelled);
    const r = await child('/usr/bin/ssh', ['-F', options.sshConfig, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'vm',
      'powershell -NoProfile -NonInteractive -Command -'], { timeout, maxBytes: 65536,
      input: `& {\n$ErrorActionPreference='Stop'\ntry {\n$bank=${quote(bank)}
$base=Get-Item -LiteralPath 'C:\\sleight-setup'
if (-not $base.PSIsContainer -or ($base.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'BANK_PATH_UNSAFE' }
if (Test-Path -LiteralPath $bank) {
  $item=Get-Item -LiteralPath $bank
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'BANK_PATH_UNSAFE' }
}
${script}\n[Console]::Out.WriteLine('SLEIGHT_GUEST_OK')\n} catch { [Console]::Error.WriteLine('UC3F_GUEST_REFUSED'); exit 1 }\n}\n\n` });
    if (!goodResult(r)) throw Error('GUEST_TRANSPORT_FAILED');
    return guestCommandOutput(r.stdout);
  };
  const scp = async (from, to) => {
    await check(); if (cancelled) throw Error(cancelled);
    const r = await child('/usr/bin/scp', ['-q', '-F', options.sshConfig, '-o', 'BatchMode=yes', from, to],
      { timeout: 30000, maxBytes: 4096 });
    if (!goodResult(r)) throw Error('GUEST_COPY_FAILED');
    await check();
  };
  const interrupt = reason => { cancelled ??= reason || 'CANCELLED'; };
  const taskCall = async (operation, payload) => {

    if (!staged) {
      await ssh(`New-Item -ItemType Directory -Path ${quote(bank)} -ErrorAction Stop | Out-Null`);
      await scp(fileURLToPath(new URL('./uc3f-task.ps1', import.meta.url)), `vm:${bank.replaceAll('\\', '/')}/uc3f-task.ps1`);
      await scp(fileURLToPath(new URL('./uc3f-task-host.cs', import.meta.url)), `vm:${bank.replaceAll('\\', '/')}/uc3f-task-host.cs`);
      const sourceHash = createHash('sha256').update(readFileSync(new URL('./uc3f-task-host.cs', import.meta.url))).digest('hex');
      const built = JSON.parse(await ssh(`$source=Join-Path $bank 'uc3f-task-host.cs'
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne '${sourceHash}') { throw 'TASK_HOST_SOURCE_CHANGED' }
$exe=Join-Path $bank 'uc3f-task-host.exe'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($source)) -OutputAssembly $exe -OutputType WindowsApplication
$receipt=@{sourceSha256='${sourceHash}';sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText((Join-Path $bank 'transport-host.json'),($receipt | ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
$receipt | ConvertTo-Json -Compress`));
      if (!/^[a-f0-9]{64}$/.test(built.sha256 ?? '')) throw Error('TASK_HOST_UNPROVED');
      taskHostHash = built.sha256;
      staged = true;
    }
    const id = String(++invocation), task = `sleight-uc3f-${token}-${id}`;
    const request = { protocol: UC3F_PROTOCOL, operation, invocation: id, token, presence: options.presence, vmId: options.vmId,
      expected, payload };
    const encoded = Buffer.from(JSON.stringify(request)).toString('base64');
    const expires = now() + (['row', 'selftest'].includes(operation) ? 900000 : 60000);
    let reply, completed = false;
    {
      await ssh(`$bank=${quote(bank)}; $task=${quote(task)}; $id=${quote(id)}
$request=Join-Path $bank "$id.request.json"
if (Test-Path -LiteralPath $request) { throw 'NO_REPLAY' }
$bytes=[Convert]::FromBase64String(${quote(encoded)})
$stream=[IO.File]::Open($request,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
$hostExe=Join-Path $bank 'uc3f-task-host.exe'
if ((Get-FileHash -LiteralPath $hostExe -Algorithm SHA256).Hash.ToLowerInvariant() -cne '${taskHostHash}') { throw 'TASK_HOST_CHANGED' }
$a=New-ScheduledTaskAction -Execute $hostExe -Argument ('"'+$bank+'" '+$id+' ${['row', 'selftest'].includes(operation) ? 900 : 45}') -WorkingDirectory $bank
$p=New-ScheduledTaskPrincipal -UserId ${quote(options.guestUser ?? 'Sleight')} -LogonType Interactive -RunLevel Limited
$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $task -Action $a -Principal $p -Settings $s -ErrorAction Stop | Out-Null
Start-ScheduledTask -TaskName $task
`, 60000);
      while (now() < expires) {
        const text = await ssh(`$bank=${quote(bank)}; $id=${quote(id)}
$rc=Join-Path $bank "$id.rc"; $result=Join-Path $bank "$id.result.json"
if (Test-Path -LiteralPath $rc) {
  if ((Get-Item -LiteralPath $result).Length -gt 32768) { throw 'GUEST_REPLY_LIMIT' }
  @{rc=(Get-Content -LiteralPath $rc -Raw).Trim(); result=(Get-Content -LiteralPath $result -Raw | ConvertFrom-Json)} | ConvertTo-Json -Depth 20 -Compress
} else { '{"pending":true}' }
`, Math.max(1, Math.min(60000, expires - now())));
        let state; try { state = JSON.parse(text); } catch { throw Error('GUEST_REPLY_INVALID'); }
        if (state.pending !== true) {
          const r = state.result;
          if (!r || r.protocol !== UC3F_PROTOCOL || r.token !== token || r.invocation !== id || r.operation !== operation ||
              !['0', '1'].includes(state.rc)) throw Error('GUEST_RECEIPT_MISMATCH');
          completed = true;
          if (state.rc !== '0' || r.error) {
            const error = Error(/^[A-Z][A-Z0-9_]{0,79}$/.test(r.error ?? '') ? r.error : 'GUEST_TASK_REFUSED');
            if (typeof r.guestCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(r.guestCode)) error.guestCode = r.guestCode;
            throw error;
          }
          reply = r.value; break;
        }
        // Poll at most once per two seconds, within the task deadline.
        await pause(Math.min(2000, Math.max(0, expires - now())));
      }
      if (!completed) throw Error('GUEST_TASK_TIMEOUT');
    }
    return reply;
  };
  return {
    protocol: UC3F_PROTOCOL, bank: `<guest-setup>/uc3f-${token}`, interrupt,
    async call(operation, payload = {}) {
      if (!['preflight', 'row', 'selftest', 'export'].includes(operation)) throw Error('INVALID_OPERATION');
      if (busy) throw Error('UC3F_TRANSPORT_BUSY');
      if (operation === 'preflight') {
        if (staged || expected) throw Error('NO_REPLAY');
        expected = payload.expected;
      } else if (!expected) throw Error('VM_IDENTITY_REQUIRED');
      await check(); if (cancelled) throw Error(cancelled);
      if (operation === 'selftest') {
        const planned = [...guestSelftestPlan(), ...guestDiagnosticPlan()].find(job => job.id === payload.job?.id);
        if (options.presence !== 'away' || !planned || JSON.stringify(planned) !== JSON.stringify(payload.job)) throw Error('INVALID_REQUEST');
        payload = { job: planned, row: { id: planned.rowId, presence: 'away' } };
      }
      if (operation === 'row') admitUC3FRow(payload.row, options.presence);
      busy = true;
      try {
        const value = await taskCall(operation, payload);
        if (operation === 'export') exported = value?.exported === true;
        return value;
      } finally { busy = false; }
    },
    async copyEvidence(paths) {
      if (!exported || busy) throw Error('EXPORT_UNCONFIRMED');
      if (paths.bundle !== options.evidenceOut || paths.attestation !== options.attestationOut ||
          ![paths.bundle, paths.attestation].every(p => typeof p === 'string' && resolve(p) === p) || paths.bundle === paths.attestation) throw Error('OUTPUT_UNSAFE');
      busy = true;
      const directory = mkdtempSync(join(tmpdir(), 'sleight-uc3f-copy-'));
      try {
        const values = [];
        for (const name of ['uc3f-observations.json', 'uc3f-observations.attestation.json']) {
          const local = join(directory, name);
          await scp(`vm:${bank.replaceAll('\\', '/')}/${name}`, local);
          const stat = lstatSync(local);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw Error('EVIDENCE_COPY_INVALID');
          const value = JSON.parse(readFileSync(local, 'utf8'));
          const safe = item => typeof item === 'string' ? Buffer.byteLength(item) <= 256 && !/iVBORw0KGgo/.test(item) :
            Array.isArray(item) ? item.every(safe) : item && typeof item === 'object' ?
              Object.entries(item).every(([k, v]) => !/screenshot|pixels|imageData/i.test(k) && safe(v)) : true;
          if (!safe(value)) throw Error('EVIDENCE_COPY_INVALID');
          values.push(value);
        }
        await check();
        const bundleBytes = readFileSync(join(directory, 'uc3f-observations.json'));
        if (values[1]?.bundleSha256 !== createHash('sha256').update(bundleBytes).digest('hex')) throw Error('EVIDENCE_COPY_INVALID');
        // Publish the original JSON bytes so the bundle's attested hash survives.
        const publish = dependencies.publishEvidence ?? (async (path, value, bytes) => {
          const { checkJSONOutput } = await import('../sitting-process.mjs');
          const { writeFileSync } = await import('node:fs');
          writeFileSync(checkJSONOutput(path), bytes, { flag: 'wx', mode: 0o600 });
        });
        await publish(paths.bundle, values[0], bundleBytes);
        await publish(paths.attestation, values[1], readFileSync(join(directory, 'uc3f-observations.attestation.json')));
        if (paths.raw) {
          if (typeof paths.raw !== 'string' || resolve(paths.raw) !== paths.raw || [paths.bundle, paths.attestation].includes(paths.raw)) throw Error('OUTPUT_UNSAFE');
          const rawPath = join(directory, 'uc3f-row-raw.json');
          await scp(`vm:${bank.replaceAll('\\', '/')}/uc3f-row-raw.json`, rawPath);
          const { readBounded, combineRowData } = await import('./uc3f-export.mjs');
          const rawBytes = readBounded(rawPath, 32 * 1024 * 1024), raw = JSON.parse(rawBytes);
          combineRowData([{ raw, bundleBytes, attestation: values[1] }]);
          await publish(paths.raw, raw, rawBytes);
        }
        return { confirmed: true };
      } finally { busy = false; rmSync(directory, { recursive: true, force: true }); }
    },
  };
}
