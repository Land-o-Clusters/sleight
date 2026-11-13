import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { guestTransport } from '../bench/windows/rt31-sitting.mjs';
import { uc3fTransport } from '../bench/windows/uc3f-transport.mjs';
import { createUC3FBackend, verifyRecord } from '../bench/windows/uc3f-sitting.mjs';
import { UC3F_PROTOCOL, VM_RECORD_PROVENANCE, UC3F_BLOCK_SECONDS, admitUC3FRow } from '../bench/windows/uc3f-rows.mjs';
import { startGuard } from '../bench/sitting-process.mjs';

const identity = { schema: 'sleight.uc3f-vm-record/1', hostName: '192.168.64.8', provenance: VM_RECORD_PROVENANCE,
  vmId: 'fixture-vm', manufacturer: 'QEMU', model: 'Virtual Machine', build: 26200,
  hostnameSha256: 'a'.repeat(64), machineGuidSha256: 'b'.repeat(64) };
const options = { protocol: UC3F_PROTOCOL, host: 'vm', presence: 'away', vmId: identity.vmId, expected: identity, sshConfig: '/fixture/config',
  evidenceOut: '/fixture/evidence.json', attestationOut: '/fixture/attestation.json' };
const row = { id: 'person-key-before', presence: 'away' };

const sittingURL = new URL('../bench/windows/uc3f-sitting.mjs', import.meta.url);
async function mutant(before, after) {
  let source = readFileSync(sittingURL, 'utf8');
  assert.ok(source.includes(before), 'mutation site exists');
  source = source.replace(before, after).replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, sittingURL).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(sittingURL.href));
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
async function backendRefusal(create, { config = 'Host vm\n HostName 192.168.64.8\n', record = identity, code }) {
  let transports = 0, children = 0;
  await assert.rejects(create({ ...options, ownerAway: true, ownerAwayFile: '/fixture/away', vmRecord: '/fixture/vm.json' }, {
    platform: 'darwin', env: { CLAUDE_CONFIG_DIR: '/fixture/isolated' }, exists: () => true,
    readFile: path => path === options.sshConfig ? config : JSON.stringify(record),
    guestTransport: (...args) => { transports++; return guestTransport(...args); },
    runChild: async () => { children++; return { status: 0, stdout: '' }; },
  }), { message: code });
  assert.equal(transports, 0); assert.equal(children, 0);
}
test('VM record provenance refuses at backend entry before any transport or child, with broken variants', async () => {
  const audit = async create => {
    for (const record of [
      { ...identity, provenance: undefined },
      { ...identity, provenance: { ...identity.provenance, hostname: 'plan' } },
      { ...identity, provenance: { ...identity.provenance, extra: 'unreviewed' } },
      { ...identity, hostName: '192.168.64.9' },
    ]) await backendRefusal(create, { record, code: 'VM_RECORD_PROVENANCE_REQUIRED' });
  };
  verifyRecord(identity, identity.vmId, identity.hostName);
  await audit(createUC3FBackend);
  const broken = await mutant('verifyRecord(expected, options.vmId, hostName);', '/* missing record validation */');
  await assert.rejects(audit(broken.createUC3FBackend), assert.AssertionError);
  const unpinned = await mutant('record.hostName !== hostName', 'false');
  await assert.rejects(backendRefusal(unpinned.createUC3FBackend, {
    record: { ...identity, hostName: '192.168.64.9' }, code: 'VM_RECORD_PROVENANCE_REQUIRED',
  }), assert.AssertionError);
});
test('backend refuses a non-VM subnet before transport construction, with a broken variant', async () => {
  const audit = create => backendRefusal(create, { config: 'Host vm\n HostName 10.0.0.8\n', code: 'NOT_VM_NETWORK' });
  await audit(createUC3FBackend);
  const broken = await mutant("throw Error('NOT_VM_NETWORK');", 'return hostName;');
  await assert.rejects(audit(broken.createUC3FBackend), assert.AssertionError);
});

function rig(patch = {}) {
  let time = 1700000000000, request, held = false;
  const calls = [], requests = [], publications = [], sleeps = [];
  const state = { requestPatch: {}, rowPatch: {}, pending: 0, cleanupFails: false, ...patch };
  const dependencies = {
    now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; }, noHold: () => { if (held) throw Error('TIMED_WINDOW_HOLD'); },
    check: async () => { if (held) throw Error('TIMED_WINDOW_HOLD'); },
    publishEvidence: async (...args) => publications.push(args),
    runChild: async (command, args, settings) => {
      calls.push({ command, args, settings, at: time });
      const script = settings.input ?? '';
      if (script.includes('Add-Type -TypeDefinition ([IO.File]::ReadAllText($source))')) return { status: 0, stdout: JSON.stringify({ sha256: 'f'.repeat(64) }) + '\nSLEIGHT_GUEST_OK\n' };
      if (state.cleanupFails && script.includes('Unregister-ScheduledTask')) return { status: 1, stdout: '' };
      if (script.includes('Register-ScheduledTask -TaskName')) {
        const encoded = /FromBase64String\('([^']+)'\)/.exec(script)[1];
        request = JSON.parse(Buffer.from(encoded, 'base64'));
        requests.push(request);
        state.onRegister?.(request);
      }
      if (script.includes('$rc=Join-Path')) {
        state.onPoll?.(request);
        if (state.pending-- > 0) return { status: 0, stdout: '{"pending":true}\nSLEIGHT_GUEST_OK\n' };
        const op = request.operation;
        const value = op === 'preflight' ? { ...identity, sessionId: 1, elevated: false } :
          op === 'row' ? { row: request.payload.row.id, collected: true, hookRemoved: true, ...state.rowPatch } :
          op === 'export' ? { exported: true } : op === 'close' ? { closed: true } :
          op === 'cleanup-check' ? { tasks: 0, fixtures: 0, hooks: 0, bankFiles: 0, connected: true, unlocked: true } : { confirmed: true };
        return { status: 0, stdout: JSON.stringify({ rc: '0', result: { ...request, value, ...state.requestPatch } }) + '\nSLEIGHT_GUEST_OK\n' };
      }
      if (command === '/usr/bin/scp' && args.at(-2).startsWith('vm:')) {
        const bytes = state.evidenceBytes ?? '{"schema":"fixture"}\n';
        writeFileSync(args.at(-1), args.at(-2).includes('.attestation.') ? state.attestationBytes ?? JSON.stringify({
          bundleSha256: createHash('sha256').update(bytes).digest('hex'),
        }) : bytes);
      }
      return { status: 0, stdout: settings.input ? 'SLEIGHT_GUEST_OK\n' : '' };
    },
  };
  return { calls, requests, publications, sleeps, state, dependencies, setHold: () => { held = true; }, advance: ms => { time += ms; }, now: () => time };
}
async function prepared(r) {
  const transport = await uc3fTransport(options, r.dependencies);
  await transport.call('preflight', { expected: identity });
  return transport;
}
test('the selected console user owns Limited interactive tasks while SSH stays on vm', async () => {
  const r = rig();
  const transport = await uc3fTransport({ ...options, guestUser: 'sleight-test' }, r.dependencies);
  await transport.call('preflight', { expected: identity });
  const task = r.calls.find(c => c.settings.input?.includes('Register-ScheduledTask -TaskName'));
  assert.match(task.settings.input, /-UserId 'sleight-test' -LogonType Interactive -RunLevel Limited/);
  assert.equal(task.args.at(-2), 'vm');
  for (const guestUser of ["Sleight';exit", 'space user', '', 'x'.repeat(65)]) {
    const bad = rig();
    await assert.rejects(uc3fTransport({ ...options, guestUser }, bad.dependencies), /UC3F_TRANSPORT_OPTIONS/);
    assert.equal(bad.calls.length, 0);
  }
});
test('transport construction is inert and unsupported operations refuse before any child', async () => {
  const r = rig(), transport = await uc3fTransport(options, r.dependencies);
  assert.equal(r.calls.length, 0);
  for (const op of ['lease', 'revoke', 'close', 'cleanup-check', 'recover']) await assert.rejects(transport.call(op), /INVALID_OPERATION/);
  assert.equal(r.calls.length, 0);
});
test('one Limited interactive task measures a row with no guard permit or cleanup request', async () => {
  const r = rig(), transport = await prepared(r);
  assert.deepEqual(await transport.call('row', { row }), { row: row.id, collected: true, hookRemoved: true });
  assert.deepEqual(r.requests.map(r => r.operation), ['preflight', 'row']);
  assert.deepEqual(r.requests.at(-1).payload, { row });
  const scripts = r.calls.map(c => c.settings.input ?? '').join('\n');
  assert.match(scripts, /-LogonType Interactive -RunLevel Limited/);
  assert.doesNotMatch(scripts, /lease.json|Unregister-ScheduledTask|Stop-ScheduledTask|input-request|recovery/);
  assert.ok(r.calls.every(c => ['/usr/bin/ssh', '/usr/bin/scp'].includes(c.command)));
});
test('wrong receipt identity, row presence and VM alias fail closed', async () => {
  const r = rig({ requestPatch: { token: '0'.repeat(16) } });
  await assert.rejects(prepared(r), /GUEST_RECEIPT_MISMATCH/);
  const good = rig(), transport = await prepared(good);
  await assert.rejects(transport.call('row', { row: { ...row, presence: 'present' } }), /ROW_MODE_MISMATCH/);
  await assert.rejects(uc3fTransport({ ...options, host: 'other' }), /UC3F_TRANSPORT_OPTIONS/);
});
test('task polling is bounded and stops on caller interruption without signaling guest fixtures', async () => {
  const r = rig({ pending: 2 }), transport = await prepared(r);
  assert.equal(r.sleeps.length, 2); assert.ok(r.sleeps.every(ms => ms === 2000));
  transport.interrupt('OWNER_AWAY_ENDED');
  await assert.rejects(transport.call('row', { row }), /OWNER_AWAY_ENDED/);
});
test('copied bundle preserves its exact attested bytes and rejects a changed sidecar', async () => {
  const r = rig(), transport = await prepared(r);
  await transport.call('export');
  assert.deepEqual(await transport.copyEvidence({ bundle: options.evidenceOut, attestation: options.attestationOut }), { confirmed: true });
  assert.equal(r.publications.length, 2);
  assert.equal(createHash('sha256').update(r.publications[0][2]).digest('hex'), r.publications[1][1].bundleSha256);
  const broken = rig({ attestationBytes: JSON.stringify({ bundleSha256: '0'.repeat(64) }) }), other = await prepared(broken);
  await other.call('export');
  await assert.rejects(other.copyEvidence({ bundle: options.evidenceOut, attestation: options.attestationOut }), /EVIDENCE_COPY_INVALID/);
  assert.equal(broken.publications.length, 0);
});
