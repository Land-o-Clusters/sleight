import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseModule } from '../plugins/sleight/vendor/meriyah/dist/meriyah.min.mjs';

const source = readFileSync(new URL('../bench/windows/clipboard-context.ps1', import.meta.url), 'utf8');
function contract(text) {
  assert.doesNotMatch(text, /OpenClipboard|GetClipboardData|SetClipboardData|EmptyClipboard|SendInput|SetForegroundWindow|SetProcessWindowStation|SetThreadDesktop/);
  assert.match(text, /-LogonType Interactive -RunLevel Limited/);
  assert.match(text, /GetProcessWindowStation\(\)/);
  assert.match(text, /GetThreadDesktop\(GetCurrentThreadId\(\)\)/);
  assert.match(text, /driver\.SessionId/);
  assert.match(text, /GetThreadDesktop\(\(uint\)thread\.Id\)/);
  assert.match(text, /CompareObjectHandles\(handle, GetThreadDesktop\(GetCurrentThreadId\(\)\)\)/);
  assert.match(text, /counts\[i\] = GetClipboardSequenceNumber\(\)/);
  assert.match(text, /product = await sample\('product-spawn', launch, driver\.pid\)/);
  assert.match(text, /finally \{ await client\.close\(\); \}/);
  assert.match(text, /limits\.Basic\.Flags = 0x2000/);
  assert.match(text, /AssignProcessToJobObject\(job, child\.Handle\)/);
  assert.match(text, /finally \{ CloseHandle\(job\); \}/);
  assert.match(text, /finally \{ if \(args.Length == 2 && args\[0\] == "launch"\) File.WriteAllText\(Path.Combine\(args\[1\], "task.done"\), "done"\); \}/);
  assert.match(text, /-ExecutionTimeLimit \(New-TimeSpan -Seconds 90\)/);
  assert.match(text, /Unregister-ScheduledTask -TaskName \$task -Confirm:\$false/);
  const module = /\$module = @'\n([^]*?)\n'@/.exec(text)?.[1];
  assert.ok(module);
  parseModule(module, { next: true });
}
test('probe measures actual native driver identity and inherits its exact launch options', () => contract(source));
test('audit is read-only and limits content to owned probe evidence', () => {
  const audit = readFileSync(new URL('../bench/windows/clipboard-context-audit.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(audit, /Stop-Process|Stop-ScheduledTask|Unregister-ScheduledTask|Remove-Item|WriteAllText|ReadAllBytes/);
  assert.match(audit, /Get-ScheduledTask -TaskName 'sleight-wt1c-context-\*'/);
  assert.ok(audit.includes("'^wt1c-context-[a-f0-9]{32}$'"));
  assert.match(audit, /\[IO\.FileAttributes\]::ReparsePoint/);
  assert.match(audit, /\$_.Length -le 32768/);
});
test('completed-task cleanup refuses live or foreign actions and reports its census', () => {
  const cleanup = readFileSync(new URL('../bench/windows/clipboard-context-cleanup.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(cleanup, /Stop-Process|Stop-ScheduledTask|Remove-Item/);
  for (const needle of ["$task.State -ne 'Ready'", '$actions.Count -ne 1', 'PROBE_CLEANUP_IDENTITY_UNPROVED',
    '$actions[0].Arguments -cne', 'remainingTasks=$remaining.Count', 'probeProcesses=$processes.Count']) assert.ok(cleanup.includes(needle), needle);
  assert.ok(cleanup.indexOf('PROBE_CLEANUP_IDENTITY_UNPROVED') < cleanup.indexOf('Unregister-ScheduledTask'));
});
for (const [name, from, to] of [
  ['noninteractive task', '-LogonType Interactive', '-LogonType S4U'],
  ['unrelated spawn', "sample('product-spawn', launch, driver.pid)", "sample('product-spawn', {}, driver.pid)"],
  ['fabricated count', 'counts[i] = GetClipboardSequenceNumber()', 'counts[i] = 1'],
  ['missing driver cleanup', 'finally { await client.close(); }', 'finally {}'],
  ['missing job containment', 'AssignProcessToJobObject(job, child.Handle)', 'true'],
  ['clipboard access', 'static extern uint GetClipboardSequenceNumber();', 'static extern uint GetClipboardData();'],
  ['unproved driver desktop', 'CompareObjectHandles(handle, GetThreadDesktop(GetCurrentThreadId()))', 'true'],
  ['missing task completion', '"task.done"), "done"', '"other.done"), "done"'],
]) test(`probe contract rejects ${name}`, () => {
  assert.ok(source.includes(from));
  assert.throws(() => contract(source.replace(from, to)), assert.AssertionError);
});
