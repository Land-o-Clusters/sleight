import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
const adapterURL = new URL('../bench/windows/vm-row-guest.mjs', import.meta.url);
let adapterSource = readFileSync(adapterURL, 'utf8');
if (process.env.WH1F_ADAPTER_BROKEN) {
  assert.equal(process.env.WH1F_ADAPTER_BROKEN, 'lease');
  adapterSource = adapterSource.replace('payload: { row }', 'payload: { row, lease: {} }')
    .replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, adapterURL).href}'`)
    .replace('if (isMain(import.meta.url))', 'if (false)');
}
const { runGuestRow, archiveRow, guestMain } = process.env.WH1F_ADAPTER_BROKEN
  ? await import('data:text/javascript;base64,' + Buffer.from(adapterSource).toString('base64')) : await import(adapterURL);
import { verifyAttestation, combineRowData } from '../bench/windows/uc3f-export.mjs';
import { VM_RECORD_PROVENANCE } from '../bench/windows/uc3f-rows.mjs';
import { revision, rowObservations } from './fixtures/vm-row-observations.mjs';

const vm = { vmId: 'test-vm', manufacturer: 'QEMU', model: 'Virtual Machine', build: 26300,
  hostnameSha256: 'e'.repeat(64), machineGuidSha256: 'f'.repeat(64) };
const context = { revision, kitManifestSha256: 'b'.repeat(64), exporterSha256: 'c'.repeat(64), observerSha256: 'd'.repeat(64), vm, userSidSha256: '1'.repeat(64) };
function fixture(t) {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-vm-row-guest-')));
  const bank = join(root, 'uc3f-' + '3'.repeat(16)); mkdirSync(bank); mkdirSync(join(bank, 'raw'));
  const expected = { ...vm, schema: 'sleight.uc3f-vm-record/1', hostName: '192.168.64.2', provenance: VM_RECORD_PROVENANCE };
  const row = { id: 'cancel-frame', presence: 'away' };
  writeFileSync(join(bank, 'row.json'), JSON.stringify({ row, expected }));
  writeFileSync(join(bank, 'vm-identity.json'), JSON.stringify({ ...vm, sessionId: 1, elevated: false }));
  writeFileSync(join(root, 'guest-manifest.json'), JSON.stringify({ commit: revision }));
  return { root, bank, row, expected };
}

test('non-Windows invocation refuses before reading or starting a backend', async () => {
  await assert.rejects(runGuestRow('missing', { platform: 'darwin' }), /WINDOWS_REQUIRED/);
});

test('interactive identity and away admission precede the collector', async t => {
  const f = fixture(t); let calls = 0;
  const dependencies = { platform: 'win32', checkBank: () => {}, root: f.root,
    createBackend: () => { calls++; throw Error('UNEXPECTED_BACKEND'); } };
  for (const change of [{ sessionId: 0 }, { elevated: true }, { manufacturer: 'Other' }, { machineGuidSha256: '0'.repeat(64) }]) {
    writeFileSync(join(f.bank, 'vm-identity.json'), JSON.stringify({ ...vm, sessionId: 1, elevated: false, ...change }));
    await assert.rejects(runGuestRow(f.bank, dependencies));
  }
  writeFileSync(join(f.bank, 'vm-identity.json'), JSON.stringify({ ...vm, sessionId: 1, elevated: false }));
  writeFileSync(join(f.bank, 'row.json'), JSON.stringify({ expected: f.expected, row: { id: 'lock-refused', presence: 'away' } }));
  await assert.rejects(runGuestRow(f.bank, dependencies), /ROW_MODE_MISMATCH/);
  assert.equal(calls, 0);
});

test('recorded and failed product rows both archive and publish a receipt', async t => {
  for (const status of ['recorded', 'fail']) {
    const f = fixture(t), events = [];
    const receipt = await runGuestRow(f.bank, { platform: 'win32', checkBank: () => {}, root: f.root,
      createBackend: options => {
        events.push('backend'); assert.equal(options.lease, undefined); assert.equal(options.ownerAway, true);
        assert.equal(options.transportInvocation, '1'); assert.equal(options.rowToken, '3'.repeat(32));
        const request = JSON.parse(readFileSync(join(f.bank, '1.request.json')));
        assert.equal(request.token, '3'.repeat(16)); assert.deepEqual(request.payload.row, f.row); return {};
      },
      collect: async options => {
        events.push('collect'); assert.equal(options.rowId, f.row.id);
        return { status, code: status === 'fail' ? 'IDENTITY_CHANGED' : 'RECORDED', ...status === 'fail' ? { failureDetail: { proof: 'fixture-after-request', object: 'typeText' } } : {} };
      },
      archive: async options => { events.push('archive'); assert.equal(options.revision, revision); },
    });
    assert.deepEqual(events, ['backend', 'collect', 'archive']); assert.equal(receipt.recorded, true); assert.equal(receipt.status, status);
    if (status === 'fail') assert.equal(receipt.failureDetail.proof, 'fixture-after-request');
    assert.deepEqual(JSON.parse(readFileSync(join(f.bank, 'row-result.json'))), receipt);
    assert.equal(existsSync(join(f.bank, 'row-result.json.new')), false);
  }
});

test('raw archive preserves product failures and the existing exporter grades passing rows', async t => {
  for (const failed of [false, true]) {
    const f = fixture(t);
    let text = await rowObservations('cancel-frame');
    if (failed) text = text.replace('"code":"RECORDED"', '"code":"IDENTITY_CHANGED"');
    writeFileSync(join(f.bank, 'raw/cancel-frame.jsonl'), text);
    await archiveRow({ bank: f.bank, revision, root: f.root }, { loadContext: async () => context });
    const raw = JSON.parse(readFileSync(join(f.bank, 'uc3f-row-raw.json')));
    const bundleBytes = readFileSync(join(f.bank, 'uc3f-observations.json'));
    const attestation = JSON.parse(readFileSync(join(f.bank, 'uc3f-observations.attestation.json')));
    assert.equal(raw.logs[0], text);
    const evidence = verifyAttestation(bundleBytes, attestation, context);
    assert.equal(evidence.has('cancel-frame'), !failed);
    const combined = combineRowData([{ raw, bundleBytes, attestation }]);
    assert.equal(combined.bundle.rows.length, failed ? 0 : 1);
    if (failed) assert.ok(combined.diagnostics.some(d => d.id === 'cancel-frame'));
  }
});


test('real collector and backend accept a lease-free row and leave guest clients open', async t => {
  const f = fixture(t), names = ['uc3f-collect.mjs', 'uc3f-fixtures.mjs', 'uc3f-observer.ps1', 'uc3f-inject.ps1'];
  mkdirSync(join(f.root, 'bench/windows'), { recursive: true });
  const files = names.map(name => {
    const path = 'bench/windows/' + name, bytes = readFileSync(new URL('../' + path, import.meta.url));
    writeFileSync(join(f.root, path), bytes); return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  writeFileSync(join(f.root, 'guest-manifest.json'), JSON.stringify({ commit: revision, files }));
  let preflight = 0, driverCalls = 0, closes = 0;
  const launchedFixture = { pid: 41, windowId: '101', processStart: '134059077770000001',
    image: 'C:\\fixture\\receiver.exe', title: 'Sleight WDR7 WPF', className: 'HwndWrapper[fixture]' };
  const receipt = await runGuestRow(f.bank, { platform: 'win32', checkBank() {}, validateBank() {}, root: f.root,
    assertStandardUser: async () => {}, tick: () => 100,
    guestCall: async operation => {
      if (operation === 'preflight') { preflight++; return { ...vm, tickMs: 100 }; }
      if (operation === 'compile-fixture') return {};
      if (operation === 'launch') return { expectedImage: launchedFixture.image,
        launcher: { ...launchedFixture, observedEnd: launchedFixture.processStart }, windows: [launchedFixture] };
      throw Error('unexpected guest operation ' + operation);
    },
    createClient: () => ({ request: async () => { driverCalls++; throw Object.assign(Error('DRIVER_EXIT'), { code: 'DRIVER_EXIT' }); }, close: async () => { closes++; } }),
    archive: async () => {},
  });
  assert.equal(preflight, 1); assert.equal(receipt.recorded, true);
  assert.equal(receipt.code, 'DRIVER_EXIT'); assert.equal(driverCalls, 1); assert.equal(closes, 0);
  const request = JSON.parse(readFileSync(join(f.bank, '1.request.json')));
  assert.deepEqual(Object.keys(request.payload), ['row']);
  const { readdirSync } = await import('node:fs');
  const raw = readdirSync(join(f.bank, 'raw')).find(n => n.endsWith('.jsonl'));
  assert.ok(raw); assert.match(readFileSync(join(f.bank, 'raw', raw), 'utf8'), /DRIVER_EXIT/);
});

test('collector and fixture sources have no cleanup that terminates guest processes', () => {
  const collector = readFileSync(new URL('../bench/windows/uc3f-collect.mjs', import.meta.url), 'utf8');
  const fixtures = readFileSync(new URL('../bench/windows/uc3f-fixtures.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(collector, /client\.close\(|c\.close\(|inspector\.close\(|repl\?\.close\(/);
  assert.doesNotMatch(fixtures, /child\.kill\(|\$child\.Kill\(/);
});


test('an adapter exception leaves a fixed diagnostic for the host failure copy', async t => {
  const f = fixture(t);
  const status = await guestMain(f.bank, { platform: 'win32', root: f.root, checkBank() {},
    createBackend: () => ({}), collect: async () => { throw Error('ROW_CRASHED'); } });
  assert.equal(status, 1); assert.deepEqual(JSON.parse(readFileSync(join(f.bank, 'row-error.json'))), { code: 'ROW_CRASHED' });
  assert.equal(existsSync(join(f.bank, 'row-result.json')), false);
});
