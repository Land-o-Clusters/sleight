#!/usr/bin/env node
// Public PID-posting rows only. Dry runs and imports never contact the VM.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { noHold, publishJSON, checkJSONOutput, sittingCommand, startGuard } from '../sitting-process.mjs';
import { startTool, superviseSignals } from '../rt31-probe.mjs';
import { guestCommandOutput } from './guest-stdin.mjs';

export function vmPlan() {
  return { expectedMinutes: 9, maximumMinutes: 10, backgroundOnly: true,
    rows: [['move-text', 'move', 'text'], ['move-toolbar', 'move', 'toolbar'], ['click-after-5', 'click', 'after5'], ['click-after-2', 'click', 'after2'],
      ['mapped-keys', 'mapped-keys'], ['belief-keys', 'belief-keys']].map(([id, row, point]) => ({ id, row, ...(point && { point }), mode: 'background' })),
    counts: { moves: 2, clicks: 2, mappedKeyPairs: 6, beliefIntervals: 1, unicodePairs: 0 },
    omitted: ['owner manual demo', 'foreground rows', 'Unicode row', 'preference change'], restore: true, closeGuest: true };
}
export function verifyGuest(current, initial, setup = false) {
  if (current?.fixture !== true || current.windowId !== initial?.windowId || current.processStart !== initial?.processStart ||
      current.layout !== '00000409' || current.captureOff !== true || !Number.isSafeInteger(current.caret) || current.caret < 0 || current.caret > current.text?.length ||
      current.selectionLength !== 0 || typeof current.text !== 'string' || !/^[0123456789q\n]{1,64}$/.test(current.text) || current.text.replace(/[q\n]/g, '') !== '0123456789' ||
      setup && (current.text !== '0123456789' || current.caret !== 0) ||
      initial?.editorBounds && JSON.stringify(current.editorBounds) !== JSON.stringify(initial.editorBounds)) throw Error('NOTEPAD_NOT_FIXTURE');
}
export function mapGuestPoints(guest, inspection) {
  const desktop = guest.guestDesktop, content = inspection.axContentFrame, frame = inspection.windowFrame;
  if (![desktop, content, frame].every(Array.isArray) || desktop.length !== 2 || content.length !== 4 || frame.length !== 4 ||
      ![...desktop, ...content, ...frame].every(Number.isFinite) || desktop.some(v => v <= 0) || content[2] <= 0 || content[3] <= 0 ||
      Math.abs(content[2] / desktop[0] / (content[3] / desktop[1]) - 1) > .02) throw Error('DISPLAY_MAPPING_UNCONFIRMED');
  const keys = ['text', 'toolbar', 'after5', 'after2'];
  if (!guest.guestPoints || Object.keys(guest.guestPoints).sort().join() !== [...keys].sort().join()) throw Error('GUEST_POINT_GEOMETRY_REQUIRED');
  return Object.fromEntries(keys.map(key => {
    const p = guest.guestPoints[key];
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || p.some((v, i) => v <= 0 || v >= desktop[i])) throw Error('GUEST_POINT_GEOMETRY_REQUIRED');
    return [key, [content[0] - frame[0] + p[0] * content[2] / desktop[0], frame[3] - (content[1] - frame[1] + p[1] * content[3] / desktop[1])]];
  }));
}
const codeOf = e => /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.message) ? e.message : 'VM_SITTING_FAILED';
export async function runVMSitting({ backend, fixtureCheckOnly = false, clock = () => performance.now() } = {}) {
  const plan = fixtureCheckOnly ? { ...vmPlan(), rows: [], counts: { posts: 0 }, expectedMinutes: 1, maximumMinutes: 2 } : vmPlan();
  const report = { schema: 'sleight.rt31-sitting/1', ...plan, fixtureCheckOnly, rows: [], startedAt: new Date().toISOString(), completed: false };
  const began = clock(); let initial, pending = false;
  try {
    initial = await backend.start(); verifyGuest(initial, initial, true);
    if (clock() - began > plan.maximumMinutes * 60000) throw Error('DEADLINE_EXCEEDED');
    report.fixture = initial;
    for (const row of plan.rows) {
      if (clock() - began > plan.maximumMinutes * 60000) throw Error('DEADLINE_EXCEEDED');
      await backend.check();
      const before = await backend.read(); verifyGuest(before, initial);
      await backend.check();
      const entry = { ...row, guestBefore: before }; report.rows.push(entry);
      const result = entry.posting = await backend.row(row);
      pending = result.records.length !== 1 || result.records.some(r => r.pending !== 0 || r.beliefCleared !== true);
      if (pending) throw Error('CLEANUP_UNCONFIRMED');
      if (result.code !== 0 || result.records.length !== 1 || result.records[0].ok !== true || result.records[0].maxCriticalSectionMs > 100) throw Error(result.reason ?? 'POSTING_REFUSED');
      await backend.check();
      const after = await backend.read(); verifyGuest(after, initial); entry.guestAfter = after;
      entry.effect = { textChanged: after.text !== before.text, caretChanged: after.caret !== before.caret,
        // Hover delivery cannot be inferred from cursor motion or unchanged text.
        guestReceipt: row.row === 'move' ? 'unknown' : after.text !== before.text || after.caret !== before.caret ? 'observed' : 'not-observed' };
      if (row.row === 'click') entry.effect.expectedCaret = row.point === 'after5' ? 6 : 3;
      if (row.row === 'mapped-keys' || row.row === 'belief-keys') {
        entry.effect.expectedText = before.text.slice(0, before.caret) + '\nq' + before.text.slice(before.caret);
        entry.effect.expectedCaret = before.caret + 1;
      }
      if (entry.effect.expectedCaret !== undefined) entry.effect.matchesExpected = after.caret === entry.effect.expectedCaret &&
        after.text === (entry.effect.expectedText ?? before.text);
    }
  } catch (error) { report.stop = codeOf(error); }
  finally {
    // Text restore stops after takeover, hold, prompt or uncertain release.
    // Bound fixture close is handled separately by backend.close().
    const canRestore = initial && !pending && (!report.stop || ['POSTING_REFUSED', 'BELIEF_TIMEOUT', 'BELIEF_UNAVAILABLE'].includes(report.stop));
    if (fixtureCheckOnly && initial && !report.stop) report.restore = { confirmed: true, skipped: true, reason: 'FIXTURE_CHECK_ONLY' };
    else if (canRestore) try { await backend.check(); report.restore = await backend.restore(); verifyGuest(report.restore, initial, true); } catch (e) { report.restore = { confirmed: false, reason: codeOf(e) }; }
    else report.restore = { confirmed: false, reason: 'RESTORE_DEFERRED_AFTER_STOP' };
    try { report.collection = await backend.close({ retain: !!initial && report.restore.confirmed !== true, pending }); report.cleanupConfirmed = report.collection?.confirmed === true && !pending; } catch { report.cleanupConfirmed = false; }
    report.completed = !report.stop && report.rows.length === plan.rows.length && report.restore.confirmed === true && report.cleanupConfirmed;
    report.finishedAt = new Date().toISOString(); report.elapsedMs = clock() - began;
  }
  return report;
}

// Bounded transport through the operator-supplied existing SSH config. Every
// PowerShell operation runs in a one-off unelevated interactive scheduled task.
export async function guestTransport(options, dependencies = {}) {
  // UC3F has its own row protocol. The default RT31 path below is unchanged.
  if (options.protocol === 'sleight.uc3f-transport/1') return (await import('./uc3f-transport.mjs')).uc3fTransport(options, dependencies);
  const runChild = dependencies.runChild ?? (await import('./kit.mjs')).runChild;
  const token = randomBytes(8).toString('hex'), bank = `C:\\sleight-setup\\rt31-${token}`;
  const quote = s => "'" + s.replaceAll("'", "''") + "'";
  const ssh = async script => {
    const r = await runChild('/usr/bin/ssh', ['-F', options.sshConfig, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', options.host,
      'powershell -NoProfile -NonInteractive -Command -'], { input: `& {\ntry {\n$ErrorActionPreference='Stop'\n${script}\n[Console]::Out.WriteLine('SLEIGHT_GUEST_OK')\n} catch { [Console]::Error.WriteLine('GUEST_COMMAND_REFUSED'); exit 1 }\n}\n\n`, timeout: 60000, maxBytes: 32768 });
    if (r.status !== 0 || r.signal || r.reason) throw Error('GUEST_TRANSPORT_FAILED');
    return guestCommandOutput(r.stdout);
  };
  let staged = false, invocation = 0, collected = true;
  return {
    bank: `<guest-setup>/rt31-${token}`,
    get cleanupConfirmed() { return collected; },
    async call(operation) {
      if (!['setup', 'read', 'restore', 'close'].includes(operation)) throw Error('INVALID_OPERATION');
      // Closing a verified owned guest fixture still runs after a host stop.
      // Never overlap a task whose collection was not confirmed.
      if (!collected) throw Error('GUEST_TASK_CLEANUP_UNCONFIRMED');
      if (operation !== 'close') noHold();
      if (!staged) {
        await ssh(`$ErrorActionPreference='Stop'\nNew-Item -ItemType Directory -Path ${quote(bank)} -ErrorAction Stop | Out-Null\n`);
        for (const file of ['rt31-guest.ps1', 'rt31-guest-read.mjs']) {
          const r = await runChild('/usr/bin/scp', ['-q', '-F', options.sshConfig, '-o', 'BatchMode=yes', fileURLToPath(new URL('./' + file, import.meta.url)),
            `${options.host}:${bank.replaceAll('\\', '/')}/${file}`], { timeout: 30000, maxBytes: 4096 });
          if (r.status !== 0 || r.reason) throw Error('GUEST_STAGE_FAILED');
        }
        staged = true;
      }
      const id = String(++invocation), task = `sleight-rt31-${token}-${id}`;
      collected = false;
      const output = await ssh(`$ErrorActionPreference='Stop'
$bank=${quote(bank)}; $task=${quote(task)}; $op=${quote(operation)}; $invocation=${quote(id)}
$rc=Join-Path $bank "$op-$invocation.rc"; $result=Join-Path $bank "$op-$invocation.json"
if (Test-Path $rc) { throw 'NO_REPLAY' }
$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoLogo -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$bank+'\\rt31-guest.ps1" -Operation '+$op+' -Invocation '+$invocation+' -Bank "'+$bank+'" -GuestRoot "'+${quote(options.guestRoot)}+'"')
$p=New-ScheduledTaskPrincipal -UserId ${quote(options.guestUser)} -LogonType Interactive -RunLevel Limited
$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 35)
Register-ScheduledTask -TaskName $task -Action $a -Principal $p -Settings $s -ErrorAction Stop | Out-Null
try {
  Start-ScheduledTask -TaskName $task
  $end=(Get-Date).AddSeconds(40)
  while (-not (Test-Path $rc) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 200 }
  if (-not (Test-Path $rc)) { throw 'GUEST_TASK_TIMEOUT' }
  $taskRC=(Get-Content $rc -Raw).Trim()
  $payload=Get-Content $result -Raw
} finally {
  if ((Get-ScheduledTask -TaskName $task).State -in @('Running','Queued')) { Stop-ScheduledTask -TaskName $task }
  if ((Get-ScheduledTask -TaskName $task).State -in @('Running','Queued')) { throw 'GUEST_TASK_CLEANUP_UNCONFIRMED' }
  Unregister-ScheduledTask -TaskName $task -Confirm:$false
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { throw 'GUEST_TASK_CLEANUP_UNCONFIRMED' }
}
if ($taskRC -ne '0') {
  $failure=$payload | ConvertFrom-Json
  if ($failure.fixture -ne $false -or $failure.error -cnotmatch '^[A-Z][A-Z0-9_]{0,79}$') { throw 'GUEST_TASK_REFUSED' }
}
Write-Output $payload
`);
      collected = true;
      let r; try { r = JSON.parse(output); } catch { throw Error('GUEST_REPLY_INVALID'); }
      if (r.fixture !== true || r.driverRead !== true) throw Error(/^[A-Z][A-Z0-9_]{0,79}$/.test(r.error ?? '') ? r.error : 'NOTEPAD_NOT_FIXTURE');
      return r;
    },
  };
}

export async function createVMBackend(options, dependencies = {}) {
  const makeGuard = dependencies.startGuard ?? startGuard, postingTool = dependencies.startTool ?? startTool;
  let guard, transport, initial, binding, run, runMayPost = false, unlock, stopped, incomplete = false, fixtureStarted = false, fixtureRestored = false, fixtureClosed = false;
  const stop = reason => { stopped ??= reason; run?.interrupt(); };
  const check = async () => { noHold(); if (stopped) throw Error(stopped); await guard.check(); };
  const read = async () => { await check(); const g = await transport.call('read'); await check(); return { ...g, captureOff: true }; };
  const removeSignals = superviseSignals(() => stop('CANCELLED'));
  return {
    async start() {
      if ((dependencies.platform ?? process.platform) !== 'darwin' || !(dependencies.env ?? process.env).CLAUDE_CONFIG_DIR) throw Error('ISOLATED_MAC_HOST_REQUIRED');
      noHold();
      const acquireLiveLock = dependencies.acquireLiveLock ?? (await import('../live-lock.mjs')).acquireLiveLock; unlock = await acquireLiveLock();
      guard = makeGuard(join(options.tools, 'guard'), { kind: 'vm', onStop: stop });
      await guard.start(); await check();
      binding = await guard.call({ op: 'check' });
      transport = await (dependencies.guestTransport ?? guestTransport)(options);
      fixtureStarted = true;
      initial = await transport.call('setup'); await check();
      const inspected = postingTool(join(options.tools, 'rt31-probe'), { version: 1, pid: binding.vmPID, window: binding.vmWindow, row: 'mapped-keys', mode: 'background' }, { inspect: true });
      runMayPost = false; run = inspected; const facts = await inspected.done; run = undefined;
      if (facts.code !== 0) throw Error(facts.reason ?? 'INSPECTION_FAILED');
      binding = { ...binding, ...facts.records[0] };
      options.points ??= mapGuestPoints(initial, binding);
      const metadata = dependencies.metadata ?? (async () => {
        const { readAppPlist, readEngine } = await import('../engine-version.mjs');
        const { release, arch } = await import('node:os');
        return { utm: readAppPlist('/Applications/UTM.app'), expectedEngine: readEngine(), macOSKernel: release(), architecture: arch() };
      });
      return { ...initial, captureOff: true, declaredVMID: options.vmId, hostInspection: binding, versions: await metadata() };
    }, check, read,
    async row(row) {
      await check();
      const request = { version: 1, pid: binding.vmPID, window: binding.vmWindow, row: row.row, mode: 'background' };
      if (row.point) {
        const point = options.points[row.point];
        if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) throw Error('INSPECTED_POINT_REQUIRED');
        Object.assign(request, { point, toolbarHeight: binding.toolbarHeight, titleBarHeight: binding.titleBarHeight,
          coordinateMapping: 'window-bottom-left-to-cg-top-left' });
      }
      // Inspect the exact geometry and point with zero posts before the live row.
      runMayPost = false; run = postingTool(join(options.tools, 'rt31-probe'), request, { inspect: true });
      const inspected = await run.done; run = undefined;
      if (inspected.code !== 0) throw Error(inspected.reason ?? 'INSPECTION_FAILED');
      await check();
      runMayPost = true; run = postingTool(join(options.tools, 'rt31-probe'), request);
      const result = await run.done; run = undefined; return result;
    },
    async restore() { await check(); const r = await transport.call('restore'); await check(); fixtureRestored = r.confirmed === true; return { ...r, captureOff: true }; },
    async close({ retain = false, pending = false } = {}) {
      incomplete ||= pending;
      if (run) try {
        run.interrupt(); const r = await run.done;
        if (runMayPost) incomplete ||= r.records.length !== 1 || r.records.some(r => r.pending !== 0 || r.beliefCleared !== true);
      } catch { incomplete = true; }
      finally { run = undefined; }
      let closeReason;
      if (fixtureStarted && !incomplete && transport?.cleanupConfirmed !== false) try {
        const r = await transport.call('close');
        fixtureClosed = r.closed === true && r.confirmed === true && (!initial || r.windowId === initial.windowId && r.processStart === initial.processStart);
      } catch (error) { closeReason = codeOf(error); }
      try { await guard?.close(); } catch { incomplete = true; }
      removeSignals();
      // A closed fixture needs no manual text restore after a stop. A pending
      // key release still retains the lock even when guest cleanup succeeded.
      incomplete ||= retain && !fixtureClosed || transport?.cleanupConfirmed === false || fixtureStarted && !fixtureClosed;
      if (!incomplete && unlock) try { await unlock(); } catch { incomplete = true; }
      return { confirmed: !incomplete, guestBank: transport?.bank, fixtureStarted, fixtureRestored, fixtureClosed, closeReason, hostBinding: binding };
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  const o = { host: 'vm', guestUser: 'Sleight', guestRoot: 'C:\\sleight' }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const k = args[i]; if (seen.has(k)) throw Error('DUPLICATE_OPTION'); seen.add(k);
    if (['--dry-run', '--owner-away', '--fixture-check-only'].includes(k)) { o[k.slice(2)] = true; continue; }
    const keys = { '--tools': 'tools', '--ssh-config': 'sshConfig', '--host': 'host', '--guest-user': 'guestUser', '--guest-root': 'guestRoot', '--vm-id': 'vmId', '--points': 'pointsPath', '--out': 'out' };
    if (!keys[k] || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('INVALID_OPTION');
    o[keys[k]] = args[++i];
  }
  if (!o['owner-away']) throw Error('OWNER_AWAY_REQUIRED');
  const command = sittingCommand('bench/windows/rt31-sitting.mjs', args);
  if (o['dry-run']) { console.log(JSON.stringify({ dryRun: true, ...vmPlan(), ...(o['fixture-check-only'] && { fixtureCheckOnly: true, rows: [], counts: { posts: 0 }, expectedMinutes: 1, maximumMinutes: 2 }), command }, null, 2)); return 0; }
  if (!o.tools || !o.sshConfig || !o.out || !/^[a-zA-Z0-9-]{1,80}$/.test(o.vmId ?? '') || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(o.host) || !/^[A-Za-z0-9 _.-]{1,64}$/.test(o.guestUser) || !/^[A-Za-z]:\\[A-Za-z0-9\\ _.-]{1,120}$/.test(o.guestRoot)) throw Error('LIVE_ARGUMENTS_REQUIRED');
  if (o.pointsPath) {
    o.points = JSON.parse(readFileSync(o.pointsPath, 'utf8'));
    if (Object.keys(o.points).sort().join() !== 'after2,after5,text,toolbar') throw Error('INSPECTED_POINT_REQUIRED');
  }
  checkJSONOutput(o.out);
  console.error(command + (o['fixture-check-only'] ? '\nFixture preflight planned allocation: 1 minute.' : '\nPlanned allocation: 9 minutes; hard limit: 10 minutes.'));
  const report = await runVMSitting({ backend: await createVMBackend(o), fixtureCheckOnly: o['fixture-check-only'] });
  publishJSON(o.out, report); return report.completed ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(e => { console.error(codeOf(e)); process.exitCode = 1; });
