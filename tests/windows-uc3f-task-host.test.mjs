import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { asciiJSON, inspectorBinding, powershellCall, GUEST_OPERATIONS } from '../bench/windows/uc3f-collect.mjs';

const collectorURL = new URL('../bench/windows/uc3f-fixtures.mjs', import.meta.url);
const collector = readFileSync(collectorURL, 'utf8');
const host = readFileSync(new URL('../bench/windows/uc3f-task-host.cs', import.meta.url), 'utf8');
const transport = readFileSync(new URL('../bench/windows/uc3f-transport.mjs', import.meta.url), 'utf8');
const task = readFileSync(new URL('../bench/windows/uc3f-task.ps1', import.meta.url), 'utf8');

test('PowerShell payloads preserve U+200B, non-Latin text, apostrophes and surrogate pairs using ASCII JSON', async t => {
  const value = { title: "Microsoft\u200b Edge's \u65e5\u672c\u8a9e \ud83d\ude80" };
  assert.deepEqual(JSON.parse(asciiJSON(value)), value);
  assert.equal(/[^\x20-\x7e]/.test(asciiJSON(value)), false);
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'uc3st5-unicode-'))); t.after(() => removeTemp(bank));
  const now = Date.now(), lease = { row: 'person-idle', presence: 'away', token: 'a'.repeat(32), expiresUtc: new Date(now + 60000).toISOString() };
  writeFileSync(join(bank, 'lease.json'), JSON.stringify(lease));
  const call = powershellCall({ bank, ownerAway: true, lease }, { now: () => now, validateBank() {}, execute: async (_exe, _args, { input }) => {
    const payload = /\$r = '([^]*?)' \| ConvertFrom-Json/.exec(input)[1];
    assert.equal(/[^\x20-\x7e]/.test(payload), false);
    assert.equal(JSON.parse(payload.replaceAll("''", "'")).fixture.title, value.title);
    return { status: 0, stdout: '{}\nSLEIGHT_GUEST_OK\n' };
  } });
  await call('inspect', { fixture: value });
  const broken = Function(`return (${asciiJSON.toString().replace(".replace(/[\\u007f-\\uffff]/g, c => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))", '')})`)();
  assert.notEqual(broken(value), asciiJSON(value));
});
test('native and persistent PowerShell output use UTF-8 and persistent input preserves JSON strings', () => {
  const audit = s => {
    assert.ok(s.includes('[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)'));
    assert.ok(s.includes('[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)'));
    assert.ok(s.includes('const payload = asciiJSON({ ...values, operation'));
  };
  audit(collector);
  for (const needle of ['[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    '[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)', 'const payload = asciiJSON({ ...values, operation'])
    assert.throws(() => audit(collector.replaceAll(needle, 'REMOVED')), assert.AssertionError);
  assert.ok(GUEST_OPERATIONS.startsWith('\n[Console]::OutputEncoding'));
});
test('refusal-only Calculator inspector retains the detached-window validation mode', () => {
  const fixture = { pid: 1, processStart: '134381480457763838', windowId: '44', image: 'C:\\Calculator.exe',
    title: 'Calculator', className: 'ApplicationFrameWindow', coreWindowId: '45', framePid: 2,
    frameProcessStart: '134381480457763837', frameImage: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', refusalOnly: true,
    refusalObserved: true, content: 'never transferred' };
  const actual = inspectorBinding(fixture);
  assert.equal(actual.refusalOnly, true);
  assert.equal(Object.hasOwn(actual, 'content'), false);
  assert.equal(Object.hasOwn(actual, 'refusalObserved'), false);
  const body = inspectorBinding.toString();
  const broken = Function(`return (${body.replace(", 'refusalOnly'", '')})`)();
  assert.notEqual(broken(fixture).refusalOnly, true);
});
test('Calculator inspector forwards the activation and baseline witnesses required by its existing census', () => {
  const fixture = { pid: 1, processStart: '134381480457763838', windowId: '44', image: 'C:\\Calculator.exe',
    title: 'Calculator', className: 'ApplicationFrameWindow', coreWindowId: '45', framePid: 2,
    frameProcessStart: '134381480457763837', frameImage: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', refusalOnly: true,
    activationSince: '134381480457000000', baselineWindows: ['12', '13'] };
  const requireWitnesses = project => {
    const actual = project(fixture);
    assert.equal(actual.activationSince, fixture.activationSince);
    assert.deepEqual(actual.baselineWindows, fixture.baselineWindows);
  };
  requireWitnesses(inspectorBinding);
  for (const field of ['activationSince', 'baselineWindows']) {
    const source = inspectorBinding.toString();
    assert.ok(source.includes(", '" + field + "'"));
    const broken = Function(`return (${source.replace(", '" + field + "'", '')})`)();
    assert.throws(() => requireWitnesses(broken), assert.AssertionError);
  }
  assert.match(GUEST_OPERATIONS, /RequireCalculatorReceipt\(\$f.pid,\$f.processStart,\$f.activationSince/);
  assert.match(GUEST_OPERATIONS, /-cnotin \$f.baselineWindows/);
});
test('GUI task host bounds output and waits, leaving timed-out guest children for restore', () => {
  const audit = s => {
    for (const needle of ['start.UseShellExecute = false', 'start.CreateNoWindow = true', 'start.WorkingDirectory = args[0]',
      'start.RedirectStandardOutput = true', 'start.RedirectStandardError = true', 'child.WaitForExit(50)',
      'clock.ElapsedMilliseconds >= budget', 'outputBytes) > 131072', 'Task.WaitAll(new[] { output, errors }, 5000)',
      'child.Dispose()']) assert.ok(s.includes(needle), needle);
    assert.doesNotMatch(s, /\.Kill\(|CreateJobObject|SetInformationJobObject|AssignProcessToJobObject/);
    assert.doesNotMatch(s, /WaitForExit\(\)|Task\.WaitAll\([^,]+\)/);
  };
  audit(host);
  for (const needle of ['start.CreateNoWindow = true', 'clock.ElapsedMilliseconds >= budget', 'child.Dispose()'])
    assert.throws(() => audit(host.replaceAll(needle, 'REMOVED')), assert.AssertionError);
});
test('transport compiles a byte-pinned WindowsApplication and launches its exact binary hash with bounded task budgets', () => {
  const audit = s => {
    for (const needle of ["new URL('./uc3f-task-host.cs', import.meta.url)", "'TASK_HOST_SOURCE_CHANGED'",
      '-OutputType WindowsApplication', "'TASK_HOST_CHANGED'", '-Execute $hostExe', "${['row', 'selftest'].includes(operation) ? 900 : 45}"])
      assert.ok(s.includes(needle), needle);
  };
  audit(transport);
  for (const needle of ["'TASK_HOST_SOURCE_CHANGED'", '-OutputType WindowsApplication', "'TASK_HOST_CHANGED'", '-Execute $hostExe'])
    assert.throws(() => audit(transport.replaceAll(needle, 'REMOVED')), assert.AssertionError);
  const auditChild = s => {
    for (const needle of ['$start.CreateNoWindow = $true', '$start.UseShellExecute = $false', '$start.WorkingDirectory = $Bank',
      '$child.WaitForExit($budget)', '$child.Dispose()']) assert.ok(s.includes(needle), needle);
    assert.doesNotMatch(s, /\.Kill\(/);
  };
  auditChild(task);
  for (const needle of ['$start.CreateNoWindow = $true', '$child.WaitForExit($budget)', '$child.Dispose()'])
    assert.throws(() => auditChild(task.replaceAll(needle, 'REMOVED')), assert.AssertionError);
});
