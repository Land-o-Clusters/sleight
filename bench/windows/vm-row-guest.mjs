// One restore-scoped collector invocation. WH1-D supplies the lease-free backend.
import { writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createGuestBackend, collectRow, checkBank } from './uc3f-collect.mjs';
import { exportRawLogs, createAttestation, loadAttestationContext, rawArchiveHash, readBounded } from './uc3f-export.mjs';
import { ROOT, isMain } from './kit.mjs';
import { runGuestChild } from './guest-child.mjs';
import { verifyGuest } from './uc3f-sitting.mjs';
import { UC3F_PRESENT, UC3F_ROW_IDS } from './uc3f-rows.mjs';

export async function archiveRow({ bank, revision, root = ROOT }, dependencies = {}) {
  const context = await (dependencies.loadContext ?? loadAttestationContext)({ bank, revision, root, execute: runGuestChild });
  const raw = { schema: 'sleight.uc3f-row-raw/1', context,
    logs: readdirSync(join(bank, 'raw')).filter(n => n.endsWith('.jsonl')).sort().map(n => readBounded(join(bank, 'raw', n), 16 * 1024 * 1024).toString('utf8')),
    injectorLogs: readdirSync(bank).filter(n => /^(?:[1-9][0-9]{0,5}\.[a-z0-9-]+\.)?inject-[0-9]{1,4}\.jsonl$/.test(n)).sort()
      .map(n => readBounded(join(bank, n), 2048).toString('utf8')) };
  raw.sha256 = rawArchiveHash(raw);
  // Keep refused and incomplete raw rows too. The existing exporter omits
  // those rows from the attested bundle and gives their diagnostic codes.
  const { bundle } = exportRawLogs(raw.logs, revision, raw.injectorLogs);
  const bytes = Buffer.from(JSON.stringify(bundle) + '\n');
  const attestation = createAttestation(bytes, context);
  for (const [name, value] of [['uc3f-row-raw.json', JSON.stringify(raw) + '\n'], ['uc3f-observations.json', bytes],
    ['uc3f-observations.attestation.json', JSON.stringify(attestation) + '\n']])
    writeFileSync(join(bank, name), value, { flag: 'wx', mode: 0o600 });
}

export async function runGuestRow(bank, dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'win32') throw Error('WINDOWS_REQUIRED');
  (dependencies.checkBank ?? checkBank)(bank);
  const { row, expected } = JSON.parse(readBounded(join(bank, 'row.json'), 16384));
  if (row?.presence !== 'away' || !UC3F_ROW_IDS.includes(row.id) || UC3F_PRESENT.includes(row.id) ||
      row.id === 'person-idle' && JSON.stringify(row.cases) !== '["notepad","wpf","calculator-refused"]') throw Error('ROW_MODE_MISMATCH');
  const identity = JSON.parse(readBounded(join(bank, 'vm-identity.json'), 16384));
  verifyGuest(identity, expected, expected.vmId);
  const root = dependencies.root ?? ROOT;
  const manifest = JSON.parse(readBounded(join(root, 'guest-manifest.json'), 4 * 1024 * 1024));
  const token = /^uc3f-([a-f0-9]{16})$/.exec(basename(bank))?.[1];
  if (!token) throw Error('BANK_IDENTITY');
  // The observer and injector consume the existing file-request envelope.
  const request = { protocol: 'sleight.uc3f-transport/1', operation: 'row', invocation: '1', token,
    presence: 'away', vmId: expected.vmId, expected, payload: { row } };
  writeFileSync(join(bank, '1.request.json'), JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  const options = { bank, expected, ownerAway: true, revision: manifest.commit, rows: [row.id], rowId: row.id, cases: row.cases,
    transportInvocation: '1', rowToken: token.repeat(2) };
  const backend = (dependencies.createBackend ?? createGuestBackend)(options, { ...dependencies, root });
  const result = await (dependencies.collect ?? collectRow)(options, backend);
  // A product refusal remains a raw observation. Export it, then let the next
  // restore discard the guest state. No process is stopped by this adapter.
  await (dependencies.archive ?? archiveRow)({ bank, revision: manifest.commit, root });
  const receipt = { recorded: true, row: row.id, status: result.status, code: result.code,
    ...result.failureDetail ? { failureDetail: result.failureDetail } : {} };
  writeFileSync(join(bank, 'row-result.json.new'), JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(join(bank, 'row-result.json.new'), join(bank, 'row-result.json'));
  return receipt;
}
export async function guestMain(bank, dependencies = {}) {
  try { await runGuestRow(bank, dependencies); return 0; }
  catch (error) {
    try {
      (dependencies.checkBank ?? checkBank)(bank);
      const value = error.code ?? error.message;
      const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'GUEST_ROW_FAILED';
      writeFileSync(join(bank, 'row-error.json'), JSON.stringify({ code }) + '\n', { flag: 'wx', mode: 0o600 });
    } catch { /* Preserve an earlier diagnostic or an unsafe bank unchanged. */ }
    return 1;
  }
}
if (isMain(import.meta.url)) guestMain(process.argv[2]).then(status => process.exit(status));
