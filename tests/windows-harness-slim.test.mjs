import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { createGuestBackend, runTransportRequest } from '../bench/windows/uc3f-collect.mjs';

import { fakeWindows } from './fixtures/windows-driver-fake.mjs';
import { syntheticObserver } from './fixtures/uc3f-observer-synthetic.mjs';
import { VM_RECORD_PROVENANCE } from '../bench/windows/uc3f-rows.mjs';
import { commandPolicy, UTMCTL } from '../bench/windows/vm-rows.mjs';

const windows = new URL('../bench/windows/', import.meta.url);
const read = name => readFileSync(new URL(name, windows), 'utf8');

function macPolicy(source, name) {
  assert.doesNotMatch(source, /\b(?:osascript|CGEvent\w*|NSEvent|screencapture|SCScreenshotManager|CGWindowListCreateImage)\b/);
  assert.doesNotMatch(source, /\butmctl\s+[a-z-]+/);
  if (name === 'vm-rows.mjs') {
    const calls = [...source.matchAll(/\bcall\(UTMCTL,\s*([^\n]+)/g)].map(m => m[1]);
    assert.equal(calls.length, 4);
    for (const call of calls) assert.match(call, /^(?:\['(?:status|stop)', options\.vmId\],|\['start', '--disposable', '--hide', options\.vmId\],|args,)/);
    assert.match(source, /const admitted = commandPolicy\(options, hostName, command, args, settings\)/);
    assert.match(source, /await child\(command, admitted, settings\)/);
    assert.doesNotMatch(source, /\brunChild\s*\(/);
  }
  // Only the guest collector and fixture worker spawn native guest children.
  if (!['uc3f-collect.mjs', 'uc3f-fixtures.mjs', 'kit.mjs'].includes(name))
    assert.doesNotMatch(source, /['"](?:node:)?child_process['"]/);
}
test('kept Mac source policy rejects input, capture, unapproved utmctl verbs and child-process imports', () => {
  for (const name of ['uc3f-sitting.mjs', 'uc3f-transport.mjs', 'uc3f-collect.mjs', 'uc3f-fixtures.mjs', 'kit.mjs', 'vm-rows.mjs', 'rt31-sitting.mjs']) {
    const source = read(name); macPolicy(source, name);
    for (const addition of ['osascript', 'CGEventPost', 'CGEvent', 'NSEvent', 'screencapture',
      'SCScreenshotManager', 'CGWindowListCreateImage', 'utmctl send-key escape', 'utmctl start vm', 'utmctl stop vm', 'utmctl list'])
      assert.throws(() => macPolicy(source + '\n' + addition, name), assert.AssertionError, `${name}: ${addition}`);
    if (!['uc3f-collect.mjs', 'uc3f-fixtures.mjs', 'kit.mjs'].includes(name))
      for (const addition of ["import { spawn } from 'node:child_process';", "await import('child_process')"])
        assert.throws(() => macPolicy(source + '\n' + addition, name), assert.AssertionError);
  }
  const runner = read('vm-rows.mjs');
  for (const changed of [runner.replace("['stop', options.vmId]", "['delete', options.vmId]"),
    runner.replace('child(command, admitted, settings)', 'child(command, args, settings)')])
    assert.throws(() => macPolicy(changed, 'vm-rows.mjs'), assert.AssertionError);
});

test('Mac VM policy admits an independent verb allow-list for each restore mode', () => {
  const vmId = 'fixture', snapshot = 'clean-signed-in', timeout = { timeout: 60000 };
  const allowed = {
    disposable: [['status', vmId], ['stop', vmId], ['start', '--disposable', '--hide', vmId]],
    snapshot: [['status', vmId], ['snapshot', 'restore', vmId, snapshot]],
    'save-state': [['status', vmId], ['suspend', '--save-state', vmId], ['start', vmId]],
    cold: [['status', vmId], ['stop', vmId], ['start', vmId]],
  };
  const candidates = [...Object.values(allowed).flat(), ['list'], ['delete', vmId], ['exec', vmId, 'anything'], ['start', 'foreign']];
  for (const [restoreMode, verbs] of Object.entries(allowed)) for (const args of candidates) {
    const call = () => commandPolicy({ restoreMode, vmId, snapshot }, '192.168.64.2', UTMCTL, args, timeout);
    if (verbs.some(v => JSON.stringify(v) === JSON.stringify(args))) assert.deepEqual(call(), args);
    else assert.throws(call, /MAC_COMMAND_REFUSED/);
  }
});

function guestPolicy(source) {
  assert.doesNotMatch(source, /\b(?:Stop-Process|taskkill|CloseMainWindow|WM_CLOSE|WM_QUIT|Stop-ScheduledTask|kill|TerminateProcess)\b|\.\s*(?:kill|Terminate)\s*\(|Invoke-CimMethod[^\n]*\bTerminate\b/i);
  // A job with this flag kills descendants even without an explicit Kill call.
  assert.doesNotMatch(source, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|Basic\.Flags\s*=\s*0x2000/i);
}
test('snapshot restore owns guest cleanup, including children started by guest scripts', () => {
  // All four reviewed calls were guest-side: direct driver, task adapter,
  // task host and persistent inspector. No owned Mac ssh/scp child is banned.
  for (const name of ['uc3f-collect.mjs', 'uc3f-fixtures.mjs', 'uc3f-task.ps1', 'uc3f-task-host.cs',
    'uc3f-inject.ps1', 'uc3f-observer.ps1', 'uc3f-export.mjs', 'uc3f-transport.mjs', 'uc3f-selftest.mjs']) {
    const source = read(name); guestPolicy(source);
    for (const addition of ['Stop-Process -Id 42', '$child.Kill()', 'child.kill()', 'taskkill /PID 42',
      '$child.CloseMainWindow()', 'WM_CLOSE', 'WM_QUIT', '$child.Terminate()', 'TerminateProcess', 'kill -Id 42',
      'Invoke-CimMethod -MethodName Terminate', 'limits.Basic.Flags = 0x2000;'])
      assert.throws(() => guestPolicy(source + '\n' + addition), assert.AssertionError, `${name}: ${addition}`);
  }
  const kit = read('kit.mjs'), macStop = "if (platform !== 'win32') { child.kill(); return; }";
  assert.ok(kit.includes(macStop)); guestPolicy(kit.replace(macStop, ''));
  assert.throws(() => guestPolicy(kit.replace(macStop, '') + '\nchild.kill()'), assert.AssertionError);
  for (const name of ['uc3f-transport.mjs', 'uc3f-fixtures.mjs']) {
    const audit = source => {
      const settings = source.split('\n').filter(line => line.includes('New-ScheduledTaskSettingsSet'));
      assert.equal(settings.length, 1);
      assert.ok(settings[0].includes('-ExecutionTimeLimit ([TimeSpan]::Zero)'));
    };
    const source = read(name); audit(source);
    assert.throws(() => audit(source.replace('[TimeSpan]::Zero', 'TimeSpan.FromSeconds(900)')), assert.AssertionError);
  }
});

test('collector stays below the redesign line and failure-code limits', () => {
  const source = read('uc3f-collect.mjs');
  const audit = text => {
    assert.ok(text.trimEnd().split('\n').length < 1500);
    // Counting every uppercase literal also counts non-failure status constants.
    const codes = new Set([...text.matchAll(/['"]([A-Z][A-Z0-9_]{2,79})['"]/g)].map(m => m[1]));
    assert.ok(codes.size < 60, `${codes.size} distinct uppercase literals`);
  };
  audit(source);
  assert.throws(() => audit(source + '\n// extra line'.repeat(1500)), assert.AssertionError);
  const extraCodes = Array.from({ length: 60 }, (_unused, i) => `'MUTANT_CODE_${i}'`).join(';');
  assert.throws(() => audit(source + '\n' + extraCodes), assert.AssertionError);
});
test('retired census, recovery, preservation and Mac input handshake modules are absent', () => {
  for (const name of ['uc3f-processes.mjs', 'uc3f-recover.mjs', 'uc3f-recovery-source.mjs', 'uc3f-away-block.mjs',
    'uc3f-kit-install.mjs', 'wcb2e-saved-diagnostics.ps1', 'uc3f-input-gate.mjs', 'fixture-profiles.mjs', 'renamed-runtime.mjs'])
    assert.equal(existsSync(new URL(name, windows)), false, name);
  for (const name of ['uc3f-collect.mjs', 'uc3f-sitting.mjs', 'uc3f-transport.mjs', 'uc3f-fixtures.mjs', 'uc3f-inject.ps1', 'uc3f-task.ps1'])
    assert.doesNotMatch(read(name), /lease\.json|cleanup-lease|startGuard|acquireLiveLock|liveLockRetained|GUEST_CLOCK_SKEW|process-snapshot|prove-launch-cleanup|Stop-ScheduledTask|preserveRenamedRuntime/);
});
test('Windows scripts and their tests have no relative imports of missing files', () => {
  for (const directory of [windows, new URL('./', import.meta.url)]) {
    for (const name of readdirSync(directory).filter(n => n.endsWith('.mjs') && (directory === windows || /^(?:windows-|driver-|sitting-)/.test(n)))) {
      const url = new URL(name, directory), source = readFileSync(url, 'utf8');
      for (const match of source.matchAll(/^import\s+(?:[^;]*?from\s+)?['"](\.\.?\/[^'"\n]+)['"]/gm))
        assert.ok(existsSync(new URL(match[1], url)), `${name}: ${match[1]}`);
    }
  }
});

test('changing fixture-helper bytes after kit attestation refuses before fixture setup', async t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'wh1d-kit-'))), bank = join(root, 'bank');
  mkdirSync(bank); mkdirSync(join(root, 'bench', 'windows'), { recursive: true });
  const paths = ['uc3f-collect.mjs', 'uc3f-fixtures.mjs', 'uc3f-observer.ps1', 'uc3f-inject.ps1'];
  const bytes = 'reviewed fixture source', revision = 'a'.repeat(40);
  const files = paths.map(name => {
    const path = 'bench/windows/' + name; writeFileSync(join(root, path), bytes);
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  writeFileSync(join(root, 'guest-manifest.json'), JSON.stringify({ commit: revision, files }));
  writeFileSync(join(root, 'bench/windows/uc3f-fixtures.mjs'), bytes + 'changed');
  const identity = { vmId: 'fixture', manufacturer: 'QEMU', model: 'Virtual Machine', build: 26300,
    hostnameSha256: 'b'.repeat(64), machineGuidSha256: 'c'.repeat(64) };
  const backend = createGuestBackend({ bank, rows: ['person-key-before'], revision, ownerAway: true, expected: identity }, {
    platform: 'win32', root, validateBank() {}, assertStandardUser: async () => {}, tick: () => 100,
    guestCall: async operation => { assert.equal(operation, 'preflight'); return { ...identity, tickMs: 100 }; },
    execute() { assert.fail('no native process before kit validation'); },
  });
  await assert.rejects(backend.preflight(), { code: 'KIT_HASH_MISMATCH' });
});

test('a product identity finding keeps its observed diff without requesting fixture cleanup', async t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'wh1d-finding-'))), token = 'a'.repeat(16);
  const bank = join(root, 'uc3f-' + token); mkdirSync(bank); mkdirSync(join(bank, 'raw'));
  const revision = 'b'.repeat(40), row = { id: 'person-key-before', presence: 'away' };
  const expected = { schema: 'sleight.uc3f-vm-record/1', hostName: '192.168.64.8', vmId: 'fixture',
    manufacturer: 'QEMU', model: 'Virtual Machine', build: 26300, hostnameSha256: 'c'.repeat(64), machineGuidSha256: 'd'.repeat(64),
    provenance: VM_RECORD_PROVENANCE };
  const request = { protocol: 'sleight.uc3f-transport/1', operation: 'row', invocation: '1', token,
    presence: 'away', vmId: 'fixture', expected, payload: { row } };
  writeFileSync(join(bank, '1.request.json'), JSON.stringify(request));
  writeFileSync(join(root, 'guest-manifest.json'), JSON.stringify({ commit: revision }));
  const detail = { proof: 'driver-request', object: 'typeText', expected: { topologyGeneration: 1 }, observed: { topologyGeneration: 3 } };
  const observer = syntheticObserver({ durationMs: 100, lease: { token: token.repeat(2), row: row.id, expiresUtc: '2026-11-05T00:00:00.000Z' } });
  let raw;
  const result = await runTransportRequest(['--transport-request', join(bank, '1.request.json'), '--transport-result', join(bank, '1.value.json')], {
    platform: 'win32', root, validateBank() {}, createBackend: () => ({
      tick: () => 100, guard: async () => {}, preflight: async () => {},
      setup: async (_row, { register }) => register(fakeWindows[0]), inspect: async f => f,
      startObserver: async () => ({ ready: true, invocation: '1', finish: async () => observer.map(JSON.stringify).join('\n') }),
      measure: async () => { throw Object.assign(Error('IDENTITY_CHANGED'), { code: 'IDENTITY_CHANGED', detail }); },
      closeClients: async () => {}, writeRaw: async (_row, records) => { raw = records; },
    }),
  });
  assert.equal(result.value.collected, false); assert.equal(result.value.code, 'IDENTITY_CHANGED');
  assert.deepEqual(result.value.failureDetail, detail); assert.equal(raw.at(-1).code, 'IDENTITY_CHANGED');
  assert.deepEqual(JSON.parse(readFileSync(join(bank, 'raw/1.failure.json'))).failureDetail, detail);
});
