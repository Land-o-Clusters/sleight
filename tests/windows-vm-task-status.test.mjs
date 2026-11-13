import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import * as production from '../bench/windows/vm-rows.mjs';
import { VM_RECORD_PROVENANCE } from '../bench/windows/uc3f-rows.mjs';

let { createRowTransport } = production;
if (process.env.WH1E_VM_BROKEN) {
  const url = new URL('../bench/windows/vm-rows.mjs', import.meta.url);
  const edits = {
    'task-status': ["if (reply.task?.state === 'Ready'", "if (false && reply.task?.state === 'Ready'"],
    'file-acl': ["quote(user + ':RX')", "quote(user + ':(OI)(CI)RX')"],
    'kit-reset': [' /reset /T /Q', ' /T /Q'],
    'foreground-settle': ["if (!['person-key-before', 'person-key-during', 'escape-ignored-injected'].includes(row.id)) return;", 'return;'],
    'evidence-staging': ['Get-ChildItem -LiteralPath $bank -File', 'Get-ChildItem -LiteralPath $bank -Recurse'],
  };
  const edit = edits[process.env.WH1E_VM_BROKEN], source = readFileSync(url, 'utf8');
  assert.ok(edit && source.includes(edit[0]));
  const changed = source.replace(edit[0], edit[1]).replace(/from '(\.\.?\/[^']+)'/g,
    (_all, path) => `from '${new URL(path, url).href}'`).replace('if (isMain(import.meta.url))', 'if (false)')
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  ({ createRowTransport } = await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64')));
}

function fixture(t, replies, { check = () => {}, foregroundLockMs = 200000 } = {}) {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-vm-task-status-')));
  const sshConfig = join(root, 'ssh'), vmRecord = join(root, 'vm.json');
  writeFileSync(sshConfig, 'Host vm\n HostName 192.168.64.2\n User Sleight\n');
  writeFileSync(vmRecord, JSON.stringify({ schema: 'sleight.uc3f-vm-record/1', vmId: 'fixture', hostName: '192.168.64.2',
    manufacturer: 'QEMU', model: 'Virtual Machine', build: 26300, hostnameSha256: 'a'.repeat(64),
    machineGuidSha256: 'b'.repeat(64), provenance: VM_RECORD_PROVENANCE }));
  let clock = 0, polls = 0, launch, probes = 0, copied;
  const transport = createRowTransport({ sshConfig, vmRecord, kit: root, vmId: 'fixture', guestUser: 'sleight-test' }, {
    now: () => clock, pause: async ms => { clock += ms; }, check,
    child: async (command, args, settings) => {
      assert.ok(['/usr/bin/ssh', '/usr/bin/scp'].includes(command));
      assert.ok(args.includes('HostName=192.168.64.2'));
      if (command === '/usr/bin/scp') { copied = args; return { status: 0, stdout: '' }; }
      let value = '';
      if (settings.input.includes('GetClipboardSequenceNumber')) {
        probes++;
        value = JSON.stringify({ whoami: 'sleight-test', clipboard: { sessionId: 1, user: 'sleight-test',
          station: 'WinSta0', desktop: 'Default', sequence: 0, error: 0, lastInputOk: true, lastInputAgeMs: 40000 + clock,
          foregroundLockOk: true, foregroundLockMs, foregroundPid: 1000 }, foregroundProcess: 'explorer' });
      } else if (settings.input.includes('row-result.json')) {
        value = JSON.stringify(replies[Math.min(polls++, replies.length - 1)]);
      } else launch = settings.input;
      return { status: 0, stdout: value + '\nSLEIGHT_GUEST_OK\n' };
    },
  });
  return { run: () => transport.row({ id: 'cancel-frame', presence: 'away' }, 'a'.repeat(16)),
    kit: () => transport.kit(), settle: row => transport.settle(row), probes: () => probes,
    capture: () => transport.capture('a'.repeat(16), join(root, 'capture')), copied: () => copied,
    elapsed: () => clock, polls: () => polls, launch: () => launch };
}

test('an exited task with a launch error fails before the fifteen-minute row deadline', async t => {
  const f = fixture(t, [{ pending: true, task: { state: 'Ready', result: 2147942405 } }]);
  await assert.rejects(f.run(), /VM_ROW_FAILED/);
  assert.equal(f.polls(), 1);
  assert.equal(f.elapsed(), 0);
});

test('a running task can report its running status until the row receipt arrives', async t => {
  const receipt = { recorded: true, row: 'cancel-frame', status: 'recorded' };
  const f = fixture(t, [{ pending: true, task: { state: 'Running', result: 267009 } }, receipt]);
  assert.deepEqual(await f.run(), receipt);
  assert.equal(f.polls(), 2);
});

test('a successful task exit without a receipt gets a bounded publication grace', async t => {
  const f = fixture(t, [{ pending: true, task: { state: 'Ready', result: 0 } }]);
  await assert.rejects(f.run(), /VM_ROW_FAILED/);
  assert.ok(f.elapsed() >= 15000 && f.elapsed() <= 18000);
});

test('a queued task is not mistaken for an exited task', async t => {
  const receipt = { recorded: true, row: 'cancel-frame' };
  const f = fixture(t, [{ pending: true, task: { state: 'Queued', result: 267011 } }, receipt]);
  assert.deepEqual(await f.run(), receipt);
});

test('the task receives the normalized bank accepted by the guest admission regex', async t => {
  const f = fixture(t, [{ recorded: true, row: 'cancel-frame' }]);
  await f.run();
  const bank = /^\$bank='([^']+)'/m.exec(f.launch())?.[1];
  assert.equal(bank, 'C:\\sleight-setup\\uc3f-aaaaaaaaaaaaaaaa');
  assert.match(bank, /^C:\\sleight-setup\\uc3f-[a-f0-9]{16}$/);
  const launch = /^\$launchSource='((?:''|[^'])*)'/m.exec(f.launch())?.[1].replaceAll("''", "'");
  assert.ok(launch.includes("& 'C:\\sleight\\bench\\windows\\vm-row-task.ps1'"));
  // cmd owns both handles. A second PowerShell redirection to the same stderr
  // file fails with a sharing violation before the row script starts.
  assert.doesNotMatch(launch, /2>/);
  assert.equal(f.launch().match(/row-launch\.stderr\.txt/g)?.length, 1);
  assert.equal(f.launch().match(/row-launch\.stdout\.txt/g)?.length, 1);
});

test('recursive kit permissions grant rights to files as well as directories', async t => {
  const f = fixture(t, []);
  await f.kit();
  assert.ok(f.launch().indexOf('/reset /T /Q') >= 0);
  assert.ok(f.launch().indexOf('/reset /T /Q') < f.launch().indexOf('/inheritance:r'));
  assert.match(f.launch(), /\/inheritance:r \/grant:r 'sleight-test:RX' 'SYSTEM:F' '\*S-1-5-32-544:F' \/T \/Q/);
  assert.doesNotMatch(f.launch(), /\(OI\)|\(CI\)/);
});

test('injected-key fixtures wait for the measured Windows foreground-lock interval to expire', async t => {
  const f = fixture(t, []);
  const sample = await f.settle({ id: 'person-key-before' });
  assert.ok(f.elapsed() >= 160000 && f.elapsed() <= 161000);
  assert.ok(f.probes() >= 2);
  assert.equal(sample.clipboard.foregroundLockMs, 200000);
  assert.ok(sample.clipboard.lastInputAgeMs >= sample.clipboard.foregroundLockMs);
});

test('background-only rows do not wait for a foreground-lock interval', async t => {
  const f = fixture(t, []);
  await f.settle({ id: 'cancel-frame' });
  assert.equal(f.elapsed(), 0);
  assert.equal(f.probes(), 0);
});

test('an unusually long guest lock remains diagnostic and leaves fixture admission to the injector', async t => {
  const f = fixture(t, [], { foregroundLockMs: 2147483647 });
  const sample = await f.settle({ id: 'person-key-during' });
  assert.equal(sample.foregroundSettle, 'interval-exceeds-wait-budget');
  assert.equal(sample.clipboard.foregroundLockMs, 2147483647);
  assert.equal(f.elapsed(), 0);
});

test('failed-row capture stages root and raw artifacts without copying live browser profiles', async t => {
  const f = fixture(t, [], { check: () => { throw Error('OWNER_AWAY_REQUIRED'); } });
  await f.capture();
  assert.match(f.launch(), /Get-ChildItem -LiteralPath \$bank -File/);
  assert.match(f.launch(), /Join-Path \$bank 'raw'/);
  assert.doesNotMatch(f.launch(), /Stop-Process|Stop-ScheduledTask|\.Kill\(/);
  assert.match(f.copied().at(-2), /uc3f-aaaaaaaaaaaaaaaa\/capture-[a-f0-9]{16}\/$/);
});
