import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { disposableProbe } from '../bench/windows/vm-disposable-probe.mjs';
import { createRowTransport, parseArgs, runRows } from '../bench/windows/vm-rows.mjs';
import { VM_RECORD_PROVENANCE } from '../bench/windows/uc3f-rows.mjs';

function fixture(t) {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'wh1f-probe-')));
  const options = { bank: join(root, 'result'), ownerAwayFile: join(root, 'owner-away'), testGateFile: join(root, 'test-gate'),
    legacyDoneFile: join(root, 'legacy-done'), legacyBlockedFile: join(root, 'legacy-blocked') };
  for (const path of [options.ownerAwayFile, options.testGateFile, options.legacyDoneFile]) writeFileSync(path, '');
  return { root, options };
}
test('zero-row probe stops before a one-row smoke and holds the legacy lock across both', async t => {
  const f = fixture(t), events = [];
  const transport = Object.fromEntries(['restore', 'ready', 'probe', 'finish'].map(step => [step, async () => { events.push(step); return {}; }]));
  await disposableProbe({ ...f.options, kit: 'fixture-kit' }, { legacyLockPath: join(f.root, 'live.lock'), holdFile: join(f.root, 'hold'),
    liveLock: async () => { events.push('live-lock'); return async () => events.push('live-unlock'); },
    lock: () => { events.push('vm-lock'); return () => events.push('vm-unlock'); }, transport: () => transport,
    runRows: async options => { events.push('one-row'); assert.deepEqual(options.rows, ['person-idle']); return { completed: true }; } });
  assert.deepEqual(events, ['live-lock', 'vm-lock', 'restore', 'ready', 'probe', 'finish', 'vm-unlock', 'one-row', 'live-unlock']);
  assert.equal(JSON.parse(readFileSync(join(f.options.bank, 'probe.json'))).rows, 0);
});
test('dry-run or explicit rows refuse without a lock or VM command', async () => {
  for (const options of [{ dryRun: true, bank: 'unused' }, { rows: ['person-idle'], bank: 'unused' }])
    await assert.rejects(disposableProbe(options), /PROBE_ARGUMENTS_REQUIRED/);
});
test('marker paths are explicit CLI values and missing paths refuse before creating the bank or taking locks', async t => {
  const f = fixture(t);
  const parsed = parseArgs(['--owner-away-file', f.options.ownerAwayFile, '--test-gate-file', f.options.testGateFile,
    '--legacy-done-file', f.options.legacyDoneFile, '--legacy-blocked-file', f.options.legacyBlockedFile]);
  for (const key of ['ownerAwayFile', 'testGateFile', 'legacyDoneFile', 'legacyBlockedFile']) {
    assert.equal(parsed[key], f.options[key]);
    await assert.rejects(disposableProbe({ ...f.options, [key]: undefined }, { env: {},
      liveLock: () => assert.fail('missing marker paths took the live lock'),
      lock: () => assert.fail('missing marker paths took the VM lock') }), /PROBE_MARKER_PATHS_REQUIRED/);
    assert.equal(existsSync(f.options.bank), false);
  }
  await assert.rejects(runRows({ bank: f.options.bank, kit: 'unused', sshConfig: 'unused', vmId: 'fixture', vmRecord: 'unused', guestUser: 'Sleight' },
    { env: {}, lock: () => assert.fail('missing owner-away path took the VM lock') }), /OWNER_AWAY_REQUIRED/);
  assert.equal(existsSync(f.options.bank), false);
});
test('probe waits on caller-selected markers, rechecks the gate before its row and forwards the environment owner marker', async t => {
  const f = fixture(t), events = [];
  unlinkSync(f.options.legacyDoneFile);
  unlinkSync(f.options.testGateFile);
  const env = { SLEIGHT_OWNER_AWAY_FILE: f.options.ownerAwayFile, SLEIGHT_BENCH_GATE_FILE: f.options.testGateFile,
    SLEIGHT_VM_LEGACY_DONE_FILE: f.options.legacyDoneFile, SLEIGHT_VM_LEGACY_BLOCKED_FILE: f.options.legacyBlockedFile };
  const transport = Object.fromEntries(['restore', 'ready', 'probe', 'finish'].map(step => [step, async () => {
    events.push(step); if (step === 'finish') unlinkSync(f.options.testGateFile); return {};
  }]));
  let waits = 0;
  await disposableProbe({ bank: f.options.bank, kit: 'fixture-kit' }, { env,
    legacyLockPath: join(f.root, 'live.lock'), holdFile: join(f.root, 'hold'), print() {},
    pause: async ms => {
      assert.equal(ms, 60000); waits++;
      if (waits === 1) writeFileSync(f.options.legacyBlockedFile, '');
      else writeFileSync(f.options.testGateFile, '');
    },
    liveLock: async () => { assert.equal(waits, 2); events.push('live-lock'); return async () => events.push('live-unlock'); },
    lock: () => { events.push('vm-lock'); return () => events.push('vm-unlock'); }, transport: () => transport,
    runRows: async options => {
      assert.equal(waits, 3); assert.equal(options.ownerAwayFile, f.options.ownerAwayFile);
      events.push('one-row'); return { completed: true };
    } });
  assert.deepEqual(events, ['live-lock', 'vm-lock', 'restore', 'ready', 'probe', 'finish', 'vm-unlock', 'one-row', 'live-unlock']);
  assert.equal(waits, 3);
});
test('probe stops waiting when the caller-selected owner marker disappears', async t => {
  const f = fixture(t); unlinkSync(f.options.testGateFile);
  await assert.rejects(disposableProbe(f.options, { env: {}, legacyLockPath: join(f.root, 'live.lock'), print() {},
    pause: async () => unlinkSync(f.options.ownerAwayFile),
    liveLock: () => assert.fail('owner returned before the live lock'), lock: () => assert.fail('owner returned before the VM lock'),
  }), /OWNER_AWAY_REQUIRED/);
});
test('clipboard probe requires session 1 Default desktop and a valid counter', async t => {
  const f = fixture(t), sshConfig = join(f.root, 'ssh'), vmRecord = join(f.root, 'vm.json');
  writeFileSync(sshConfig, 'Host vm\n HostName 192.168.64.2\n User Sleight\n');
  writeFileSync(vmRecord, JSON.stringify({ schema: 'sleight.uc3f-vm-record/1', vmId: 'fixture', hostName: '192.168.64.2',
    manufacturer: 'QEMU', model: 'QEMU', build: 26300, hostnameSha256: 'a'.repeat(64), machineGuidSha256: 'b'.repeat(64), provenance: VM_RECORD_PROVENANCE }));
  for (const change of [{}, { sessionId: 0 }, { error: 5 }, { desktop: 'Winlogon' }]) {
    const transport = createRowTransport({ vmId: 'fixture', sshConfig, vmRecord }, { child: async (_cmd, _args, settings) => {
      assert.match(settings.input, /GetClipboardSequenceNumber/);
      assert.doesNotMatch(settings.input, /OpenClipboard|SetClipboardData|Stop-Process|\.Kill\(/);
      return { status: 0, stdout: JSON.stringify({ whoami: 'fixture\\sleight', clipboard: {
        sessionId: 1, station: 'WinSta0', desktop: 'Default', sequence: 0, error: 0, ...change } }) + '\nSLEIGHT_GUEST_OK\n' };
    } });
    if (Object.keys(change).length) await assert.rejects(transport.probe(), /VM_PROBE_INVALID/);
    else assert.equal((await transport.probe()).clipboard.sequence, 0);
  }
});
