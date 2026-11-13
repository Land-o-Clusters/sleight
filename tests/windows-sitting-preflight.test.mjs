import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { preflight, kitACL, INVENTORY } from '../bench/windows/sitting-preflight.mjs';
import { createManifest } from '../bench/windows/guest-integrity.mjs';
import { createHash } from 'node:crypto';
import { VM_RECORD_PROVENANCE } from '../bench/windows/uc3f-rows.mjs';
import { measureGuestTrial, hardwareReady, createGuestInspector } from '../bench/windows/uc3f-collect.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ownerInstructions } from '../bench/windows/uc3f-sitting.mjs';

function rig() {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'windows-sitting-preflight-')));
  const record = { schema: 'sleight.uc3f-vm-record/1', hostName: '192.168.64.8', vmId: 'fixture-vm',
    manufacturer: 'QEMU', model: 'Virtual Machine', build: 26200, hostnameSha256: 'a'.repeat(64),
    machineGuidSha256: 'b'.repeat(64), provenance: VM_RECORD_PROVENANCE };
  const options = { sshConfig: join(root, 'config'), vmRecord: join(root, 'vm.json'), vmId: record.vmId };
  writeFileSync(options.sshConfig, 'Host vm\n HostName 192.168.64.8\n StrictHostKeyChecking yes\n');
  writeFileSync(options.vmRecord, JSON.stringify(record));
  const calls = [];
  let released = 0;
  const dependencies = { lock: () => () => { released++; }, runChild: async (command, args, settings) => {
    calls.push({ command, args, settings });
    return { status: 0, stdout: command.endsWith('utmctl') ? 'started\n' :
      JSON.stringify({ sessionId: 1, user: 'sleight-test', state: 0 }) + '\n' + JSON.stringify(record) + '\nSLEIGHT_GUEST_OK\n' };
  } };
  return { options, dependencies, calls, released: () => released };
}

test('inventory pins transport, verifies identity and releases the VM lock on a mismatch', async () => {
  const r = rig();
  const result = await preflight(r.options, r.dependencies);
  assert.equal(result.status, 'started');
  assert.equal(r.released(), 1);
  assert.equal(r.calls.length, 2);
  const ssh = r.calls[1];
  for (const value of ['HostName=192.168.64.8', 'StrictHostKeyChecking=yes', 'ProxyCommand=none', 'ClearAllForwardings=yes'])
    assert.ok(ssh.args.includes(value));
  const bad = rig(), invoke = bad.dependencies.runChild;
  bad.dependencies.runChild = async (...args) => {
    const result = await invoke(...args);
    result.stdout = result.stdout.replace('a'.repeat(64), 'c'.repeat(64));
    return result;
  };
  await assert.rejects(preflight(bad.options, bad.dependencies), /VM_IDENTITY_MISMATCH/);
  assert.equal(bad.released(), 1);
});

test('a different console user refuses before changing kit ACLs or running a self-test', async () => {
  const r = rig();
  await assert.rejects(preflight({ ...r.options, guestUser: 'other', lockKit: 'yes' }, r.dependencies), /VM_SESSION_MISMATCH/);
  assert.equal(r.calls.length, 2);
  assert.equal(r.released(), 1);
});

test('kit source ACLs grant only the console user RX alongside SYSTEM and Administrators', () => {
  const script = kitACL('sleight-test');
  assert.match(script, /'sleight-test:RX' 'SYSTEM:F' '\*S-1-5-32-544:F'/);
  assert.doesNotMatch(script, /GetCurrent|S-1-5-32-545|\(OI\)|\(CI\)/);
  for (const user of ["x';exit", '', 'with space', '../test']) assert.throws(() => kitACL(user), /GUEST_USER_INVALID/);
});

test('inventory parses only the small Node receipt in PowerShell and names failure stages', () => {
  assert.doesNotMatch(INVENTORY, /Get-Content[^\n]*-Raw|ReadAllText|EncodedCommand|Get-FileHash/);
  for (const stage of ['word-inventory', 'system-inventory', 'kit-inventory', 'task-inventory']) assert.ok(INVENTORY.includes(stage));
  assert.match(INVENTORY, /hash\.update\(chunk\.subarray/);
});

test('deployment copies to staging, verifies all sizes and hashes, then preserves and atomically renames', async () => {
  for (const broken of [false, true]) {
    const r = rig(), root = trackTemp(mkdtempSync(join(tmpdir(), 'windows-kit-deploy-')));
    writeFileSync(join(root, 'payload'), 'payload');
    const manifest = createManifest(root, 'a'.repeat(40)), bytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(root, 'guest-manifest.json'), bytes);
    const hash = createHash('sha256').update(bytes).digest('hex'), events = [];
    const invoke = r.dependencies.runChild;
    r.dependencies.runChild = async (cmd, args, settings) => {
      const source = settings.input ?? '';
      if (cmd.endsWith('scp')) { events.push('copy'); assert.equal(args.at(-1), 'vm:C:/sleight-stage-fixture'); return { status: 0, stdout: '' }; }
      if (source.includes("$stage='verify-staged-kit'")) {
        events.push('verify-and-publish');
        assert.ok(source.indexOf('$verified =') < source.indexOf("$stage='publish-kit'"));
        assert.ok(source.indexOf("-NewName 'sleight-kit-fixture'") < source.indexOf("-NewName 'sleight'"));
        assert.match(source, /catch \{\n if \(\$preserved/);
        for (const value of [manifest.commit, hash, 'expectedBytes', 'entry.sha256']) assert.ok(source.includes(value));
        return broken ? { status: 1, stdout: '', stderr: 'verify-staged-kit: KIT_FILE_CHANGED' } :
          { status: 0, stdout: JSON.stringify({ commit: manifest.commit, files: 1, manifestSha256: hash }) + '\nSLEIGHT_GUEST_OK\n' };
      }
      if (source.includes('BACKUP_EXISTS')) { events.push('check-destinations'); assert.doesNotMatch(source, /Rename-Item/); return { status: 0, stdout: 'SLEIGHT_GUEST_OK\n' }; }
      if (source.includes('icacls')) { events.push('acl'); return { status: 0, stdout: '{"acl":"pass"}\nSLEIGHT_GUEST_OK\n' }; }
      return invoke(cmd, args, settings);
    };
    const run = preflight({ ...r.options, kit: root, backupToken: 'fixture' }, r.dependencies);
    if (broken) await assert.rejects(run, /PREFLIGHT_CHILD_FAILED/);
    else assert.equal((await run).deployed.manifestSha256, hash);
    assert.deepEqual(events, ['check-destinations', 'copy', 'verify-and-publish', ...broken ? [] : ['acl']]);
    assert.equal(r.released(), 1);
  }
});

test('a failed non-drawing build keeps its receipt and a resume never relaunches it', async () => {
  for (const mode of [{ driverBuild: 'yes' }, { resumeBuild: '0123456789abcdef' }]) {
  const r = rig(), invoke = r.dependencies.runChild;
  let registrations = 0;
  r.dependencies.runChild = async (...args) => {
    const source = args[2].input ?? '';
    if (source.includes('Register-ScheduledTask')) { registrations++; return { status: 0, stdout: 'SLEIGHT_GUEST_OK\n' }; }
    if (source.includes('$task.State')) return { status: 0, stdout: '{"state":"Ready","files":["build.json","build.rc"]}\nSLEIGHT_GUEST_OK\n' };
    if (args[0] === '/usr/bin/scp') {
      writeFileSync(args[1].at(-1), args[1].at(-2).endsWith('.rc') ? '1' : '{"verdict":"failed"}');
      return { status: 0, stdout: '' };
    }
    const result = await invoke(...args);
    if (args[0] === '/usr/bin/ssh') result.stdout = result.stdout.replace('"build":26200', '"build":26200,"kitCommit":"' + 'a'.repeat(40) + '"');
    return result;
  };
  await assert.rejects(preflight({ ...r.options, ...mode }, r.dependencies), error => {
    assert.equal(error.message, 'DRIVER_BUILD_FAILED');
    assert.ok(error.operations.some(op => op.operation === 'driver-build-receipt' && op.report.verdict === 'failed'));
    return true;
  });
  assert.equal(r.released(), 1);
  assert.equal(registrations, mode.resumeBuild ? 0 : 1);
  }
});

test('hardware readiness waits out the click and prior Escape without crossing the DWORD wrap incorrectly', () => {
  const fixtures = [{ target: 'wpf', pid: 42 }], state = { foregroundPid: 42, tickMs: 1000, lastInputTickMs: 1000 };
  for (const age of [0, 1, 499]) assert.equal(hardwareReady({ ...state, lastInputTickMs: 1000 - age }, fixtures), false);
  for (const age of [500, 501, 1000]) assert.equal(hardwareReady({ ...state, lastInputTickMs: 1000 - age }, fixtures), true);
  assert.equal(hardwareReady({ ...state, tickMs: 0x100000010, lastInputTickMs: 0xfffffe1c }, fixtures), true);
  assert.equal(hardwareReady({ ...state, foregroundPid: 7, lastInputTickMs: 0 }, fixtures), false);
  assert.equal(hardwareReady({ ...state, lastInputTickMs: undefined }, fixtures), false);
});

test('two row inspectors create separate files in the same bank without overwriting the earlier script', () => {
  const names = new Set();
  for (let row = 0; row < 2; row++) {
    const child = new EventEmitter();
    for (const stream of ['stdin', 'stdout', 'stderr']) child[stream] = new PassThrough();
    createGuestInspector({ bank: 'C:\\sleight-setup\\uc3f-0123456789abcdef', ownerAway: false, executable: 'fixture', env: {},
      writeOwned: (name, text) => {
        assert.equal(names.has(name), false);
        names.add(name); assert.ok(text.includes('INSPECTOR_PROTOCOL')); return name;
      }, spawnChild: () => child });
    child.emit('close');
  }
  assert.equal(names.size, 2);
});

test('the two selected row prompts explain hardware timing and the separate typing fixture', () => {
  const escape = ownerInstructions({ id: 'escape-stop-hardware' });
  assert.match(escape, /10 separate bursts/); assert.match(escape, /physical Escape/); assert.match(escape, /WPF/);
  assert.match(ownerInstructions({ id: 'person-idle', cases: ['background-word'] }), /disposable Word document/);
  assert.match(ownerInstructions({ id: 'person-idle', cases: ['background-word'] }), /Never type in the Notepad fixture/);
  assert.equal(ownerInstructions({ id: 'present-block' }), '');
});

async function hardwareTrials(measure) {
  let latched = true, turn = 0;
  const typed = [], followups = [], order = [];
  const client = { async request(method) { assert.equal(method, 'turn-end'); latched = false; turn++; order.push('end'); } };
  const fixture = { target: 'wpf' };
  for (let trial = 0; trial < 10; trial++) {
    const facts = await measure({ rowId: 'escape-stop-hardware', caseId: 'hardware', trial,
      fixtures: [fixture], check: async () => {}, request: async (_client, method, target, params) => {
        assert.equal(target, fixture);
        if (method === 'getAXState') return { reply: { readId: 1, text: '1 text area Editor' } };
        assert.equal(method, 'typeText'); order.push(params.args[0].length);
        const units = latched ? 0 : 17;
        latched = true;
        (params.args[0].length === 4000 ? typed : followups).push({ turn, units });
        return { raw: { ok: false, code: 'USER_STOPPED', reason: 'escape', typed: units } };
      } }, { client: async () => client });
    assert.equal(facts.driver.length, 4);
  }
  assert.deepEqual(typed.map(x => x.units), Array(10).fill(17));
  assert.deepEqual(followups.map(x => x.units), Array(10).fill(0));
  assert.deepEqual(typed.map(x => x.turn), Array.from({ length: 10 }, (_, i) => i + 1));
  assert.deepEqual(order, Array.from({ length: 10 }, () => ['end', 4000, 1]).flat());
}
test('all ten Escape trials start a new turn and preserve the follow-up refusal within that turn', async () => {
  await hardwareTrials(measureGuestTrial);
  const url = new URL('../bench/windows/uc3f-collect.mjs', import.meta.url);
  const before = "if (rowId === 'escape-stop-hardware') await client.request('turn-end', {});";
  const source = readFileSync(url, 'utf8');
  assert.ok(source.includes(before));
  const broken = source.replace(before, '').replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, url).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(broken).toString('base64'));
  await assert.rejects(hardwareTrials(mutant.measureGuestTrial), assert.AssertionError);
});
