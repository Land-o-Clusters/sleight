import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { VM_RECORD_PROVENANCE } from '../bench/windows/uc3f-rows.mjs';
import { parseArgs, taskLaunchScript, parseGuestResult, resultLines, runRealTasks, createTaskTransport, RESULT_SCHEMA } from '../bench/windows/real-tasks.mjs';

const sha = 'a'.repeat(40), token = 'b'.repeat(16);
const options = { kit: '/tmp/kit', sshConfig: '/tmp/ssh_config', vmRecord: '/tmp/vm.json', vmId: 'test-vm',
  guestUser: 'sleight-test', ownerAwayFile: '/tmp/owner-away', output: '/tmp/result.json', allowFixtureApprovals: true };
const report = () => ({ schema: RESULT_SCHEMA, token, commit: sha, manifestSha256: 'c'.repeat(64), wallMs: 123,
  tasks: ['notepad', 'explorer', 'edge', 'blocked-app', 'approval', 'escape'].map(id => ({ id, status: 'fail', reason: 'not run', durationMs: 0 })),
  approvals: [], cleanup: 'restore-required' });

test('arguments are explicit, reject duplicates, unknown flags and missing run authority', () => {
  const args = ['--kit', options.kit, '--ssh-config', options.sshConfig, '--vm-record', options.vmRecord,
    '--vm-id', options.vmId, '--guest-user', options.guestUser, '--owner-away-file', options.ownerAwayFile,
    '--output', options.output, '--allow-fixture-approvals'];
  assert.deepEqual(parseArgs(args), options);
  for (const bad of [args.slice(0, -1), [...args, '--kit', '/tmp/other'], [...args, '--retries', '2'],
    args.map(v => v === 'test-vm' ? '-bad' : v), args.map(v => v === 'sleight-test' ? "user'; run" : v)])
    assert.throws(() => parseArgs(bad));
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true });
});

test('launch uses a limited interactive scheduled task, fixed kit paths and hidden PowerShell', () => {
  const script = taskLaunchScript(options, token, { vmId: options.vmId }, { commit: sha, manifestSha256: 'c'.repeat(64) });
  assert.match(script, /-LogonType Interactive -RunLevel Limited/);
  assert.match(script, /real-tasks-task\.ps1/);
  assert.match(script, /-WindowStyle Hidden/);
  assert.match(script, /New-ScheduledTaskAction -Execute \$launcher/);
  assert.match(script, /-OutputType WindowsApplication/);
  assert.match(script, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.doesNotMatch(script, /Stop-Process|taskkill|SendKeys|SetForegroundWindow|Stop-ScheduledTask/);
  assert.throws(() => taskLaunchScript(options, "x';bad", {}, {}));
  const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)[1];
  const request = JSON.parse(Buffer.from(encoded, 'base64'));
  assert.equal(request.token, token);
  assert.equal(request.commit, sha);
  assert.equal(request.allowFixtureApprovals, true);
});

test('actual transport pins SSH, waits for one task without relaunch and validates result identity', async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-real-tasks-')));
  const o = { ...options, sshConfig: join(dir, 'ssh_config'), vmRecord: join(dir, 'vm.json') };
  const expected = { schema: 'sleight.uc3f-vm-record/1', provenance: VM_RECORD_PROVENANCE, vmId: o.vmId,
    hostName: '192.168.64.2', manufacturer: 'QEMU', model: 'Virtual Machine', build: 26300,
    hostnameSha256: 'e'.repeat(64), machineGuidSha256: 'f'.repeat(64) };
  writeFileSync(o.sshConfig, 'Host vm\n HostName 192.168.64.2\n User sleight-test\n BatchMode yes\n', { mode: 0o600 });
  writeFileSync(o.vmRecord, JSON.stringify(expected), { mode: 0o600 });
  const calls = [], pauses = [];
  let poll = 0;
  const transport = createTaskTransport(o, { now: () => 0, deadline: 540000, check: () => {},
    pause: async ms => pauses.push(ms), child: async (command, args, settings) => {
      calls.push({ command, args, settings });
      assert.equal(command, '/usr/bin/ssh');
      assert.ok(args.includes('StrictHostKeyChecking=yes'));
      assert.ok(args.includes('HostName=192.168.64.2'));
      assert.equal(settings.timeout, 60000);
      assert.ok(settings.input.endsWith('\n\n'));
      let value = '';
      if (settings.input.includes('$result=')) value = JSON.stringify(++poll === 1 ? { pending: true, state: 'Running', lastResult: 267009 } : report());
      return { status: 0, stdout: value + '\nSLEIGHT_GUEST_OK\n' };
    } });
  const r = await transport.tasks(token, { expected, commit: sha, manifestSha256: 'c'.repeat(64) });
  assert.equal(r.tasks.length, 6);
  assert.equal(calls.filter(c => c.settings.input.includes('Register-ScheduledTask')).length, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(pauses, [2000]);
});

test('result parser pins identity, all six rows, status, duration and approval evidence', () => {
  const expected = { token, commit: sha, manifestSha256: 'c'.repeat(64) };
  assert.equal(parseGuestResult(JSON.stringify(report()), expected).tasks.length, 6);
  const mutations = [r => r.tasks.pop(), r => r.tasks.push(r.tasks[0]), r => r.token = 'd'.repeat(16),
    r => r.commit = 'f'.repeat(40), r => r.manifestSha256 = 'e'.repeat(64), r => r.tasks[0].status = 'skip',
    r => r.tasks[0].durationMs = -1, r => r.wallMs = 600000, r => r.approvals = [{ task: 'approval', action: 'accept', app: 'CalculatorApp.exe' }],
    r => { r.tasks[0] = { id: 'notepad', status: 'pass', reason: 'done', durationMs: 1 }; }];
  for (const mutate of mutations) { const r = report(); mutate(r); assert.throws(() => parseGuestResult(JSON.stringify(r), expected)); }
  assert.throws(() => parseGuestResult('{', expected));
  assert.throws(() => parseGuestResult(' '.repeat(1048577), expected));
});

test('one output line per row cannot gain terminal controls or multiline output', () => {
  const r = report(); r.tasks[0].reason = 'bad\nforged pass\u001b[31m';
  const lines = resultLines(r);
  assert.equal(lines.length, 6);
  assert.equal(lines.join('\n').split('\n').length, 6);
  assert.doesNotMatch(lines.join(''), /\u001b/);
});

test('host runs once, preserves failures and stops the disposable VM on success or failure', async () => {
  for (const fails of [false, true]) {
    const calls = [], written = [];
    const transport = Object.fromEntries(['restore', 'ready', 'kit', 'finish'].map(k => [k, async () => calls.push(k)]));
    transport.tasks = async () => { calls.push('tasks'); if (fails) throw Error('TASK_LAUNCH_FAILED'); return report(); };
    const result = await runRealTasks(options, { now: () => 1, check: () => {}, lock: () => () => calls.push('unlock'),
      verify: () => ({ commit: sha, manifestSha256: 'c'.repeat(64), expected: {} }), token: () => token,
      createTransport: () => transport, write: (_p, r) => written.push(r), checkOutput: () => {}, log: () => {} });
    assert.deepEqual(calls, ['restore', 'ready', 'kit', 'tasks', 'finish', 'unlock']);
    assert.equal(written.length, 1);
    assert.equal(result.tasks.length, 6);
    assert.equal(result.vmStopped, true);
    assert.equal(result.tasks.filter(t => t.status === 'fail').length, 6);
  }
});

test('owner return stops later work, cleanup failure remains a failure and no retry occurs', async () => {
  let attempts = 0;
  const result = await runRealTasks(options, { now: () => 1, check: () => {}, lock: () => () => {},
    verify: () => ({ commit: sha, manifestSha256: 'c'.repeat(64), expected: {} }), token: () => token,
    createTransport: () => ({ restore: async () => {}, ready: async () => {}, kit: async () => {},
      tasks: async () => { attempts++; throw Error('OWNER_AWAY_REQUIRED'); }, finish: async () => { throw Error('VM_STOP_FAILED'); } }),
    write: () => {}, checkOutput: () => {}, log: () => {} });
  assert.equal(attempts, 1);
  assert.equal(result.vmStopped, false);
  assert.match(result.cleanupError, /VM_STOP_FAILED/);
  assert.match(result.error, /OWNER_AWAY_REQUIRED/);
});

test('preflight failure writes six failures without starting or stopping the VM', async () => {
  let written, locked = 0;
  const r = await runRealTasks(options, { now: () => 1, checkOutput: () => {},
    check: () => { throw Error('OWNER_AWAY_REQUIRED'); }, lock: () => { locked++; },
    token: () => token, write: (_path, value) => written = value, log: () => {} });
  assert.equal(r.tasks.length, 6);
  assert.equal(r.tasks.every(t => t.reason === 'OWNER_AWAY_REQUIRED'), true);
  assert.equal(locked, 0);
  assert.equal(written, r);
});

test('interrupt during a wait still disposes the VM and releases the lock', async () => {
  const signals = new EventEmitter(); let disposed = false, unlocked = false;
  const r = await runRealTasks(options, { signals, now: () => 1, check: () => {}, checkOutput: () => {},
    verify: () => ({ commit: sha, manifestSha256: 'c'.repeat(64), expected: {} }), token: () => token,
    lock: () => () => unlocked = true, write: () => {}, log: () => {}, createTransport: () => ({
      restore: async () => {}, ready: async () => {}, kit: async () => {},
      tasks: async () => { signals.emit('SIGINT'); return report(); }, finish: async () => { disposed = true; },
    }) });
  assert.equal(disposed, true); assert.equal(unlocked, true);
  assert.equal(r.error, 'INTERRUPTED');
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('a failed guest task names the guest reason, stripped of controls', async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-real-tasks-')));
  const o = { ...options, sshConfig: join(dir, 'ssh_config'), vmRecord: join(dir, 'vm.json') };
  const expected = { schema: 'sleight.uc3f-vm-record/1', provenance: VM_RECORD_PROVENANCE, vmId: o.vmId,
    hostName: '192.168.64.2', manufacturer: 'QEMU', model: 'Virtual Machine', build: 26300,
    hostnameSha256: 'e'.repeat(64), machineGuidSha256: 'f'.repeat(64) };
  writeFileSync(o.sshConfig, 'Host vm\n HostName 192.168.64.2\n User sleight-test\n BatchMode yes\n', { mode: 0o600 });
  writeFileSync(o.vmRecord, JSON.stringify(expected), { mode: 0o600 });
  const transport = createTaskTransport(o, { now: () => 0, deadline: 540000, check: () => {}, pause: async () => {},
    child: async (command, args, settings) => {
      const value = settings.input.includes('$result=')
        ? JSON.stringify({ pending: true, state: 'Ready', lastResult: 1, guestError: 'KIT_UNEXPECTED_FILE\u001b[2J\nx' }) : '';
      return { status: 0, stdout: value + '\nSLEIGHT_GUEST_OK\n' };
    } });
  await assert.rejects(transport.tasks(token, { expected, commit: sha, manifestSha256: 'c'.repeat(64) }),
    { message: 'TASK_LAUNCH_FAILED_1 KIT_UNEXPECTED_FILE??2J?x' });
});

test('kit copy first clears the disposable boot\'s old kit, refusing reparse points', async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-real-tasks-')));
  const o = { ...options, kit: dir, sshConfig: join(dir, 'ssh_config'), vmRecord: join(dir, 'vm.json') };
  const expected = { schema: 'sleight.uc3f-vm-record/1', provenance: VM_RECORD_PROVENANCE, vmId: o.vmId,
    hostName: '192.168.64.2', manufacturer: 'QEMU', model: 'Virtual Machine', build: 26300,
    hostnameSha256: 'e'.repeat(64), machineGuidSha256: 'f'.repeat(64) };
  writeFileSync(o.sshConfig, 'Host vm\n HostName 192.168.64.2\n User sleight-test\n BatchMode yes\n', { mode: 0o600 });
  writeFileSync(o.vmRecord, JSON.stringify(expected), { mode: 0o600 });
  const calls = [];
  const transport = createTaskTransport(o, { now: () => 0, deadline: 540000, check: () => {}, pause: async () => {},
    child: async (command, args, settings) => {
      calls.push({ command, input: settings.input ?? '' });
      return { status: 0, stdout: command.endsWith('ssh') ? '\nSLEIGHT_GUEST_OK\n' : '' };
    } });
  await transport.kit();
  const removal = calls.findIndex(c => c.input.includes('Remove-Item -LiteralPath $kit -Recurse -Force'));
  const copy = calls.findIndex(c => c.command === '/usr/bin/scp');
  assert.ok(removal >= 0 && copy > removal);
  assert.ok(calls[removal].input.indexOf('ReparsePoint') < calls[removal].input.indexOf('Remove-Item'));
});

test('host accepts an Edge pass only with the browser refusal proof', () => {
  const r = report();
  r.tasks[2] = { id: 'edge', status: 'pass', reason: 'browser acquisition refused by name', durationMs: 1, evidence: { replyError: true, browserRefused: true } };
  const identity = { commit: sha, manifestSha256: 'c'.repeat(64), token };
  assert.equal(parseGuestResult(JSON.stringify(r), identity).tasks[2].status, 'pass');
  r.tasks[2].evidence = { replyError: true, titleRead: true };
  assert.throws(() => parseGuestResult(JSON.stringify(r), identity), /RESULT_PASS_UNPROVED/);
});
