// One background Calculator read. Doctor owns and collects its bounded engine.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { doctor, resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { sanitizeHelperEvidence } from './helper-evidence.mjs';

if (process.argv.slice(2).join('\0') !== '--doctor\0Calculator') throw new Error('usage: node bench/doctor-app-read.mjs --doctor Calculator');
const bank = mkdtempSync('/private/tmp/sleight-doctor-read-');
const name = `2026-10-09-doctor-preapproved-${basename(bank)}.json`;
const output = fileURLToPath(new URL(`../docs/benchmarks/${name}`, import.meta.url));
const staged = join(bank, 'receipt.json');
const audit = join(userInfo().homedir, 'Library/Logs/sleight', `preapproved-${process.pid}.jsonl`);
const record = { started: new Date().toISOString(), app: 'Calculator', engine: resolveServer().version,
  invocation: 'node bench/doctor-app-read.mjs --doctor Calculator', logs: [], grants: [], lockAcquired: false,
  lockReleased: false, interrupted: false, doctorExit: null, exitCode: 1 };
// Let the bounded doctor finish collecting its engine before releasing the lock.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { record.interrupted = true; });
try {
  if (existsSync('/tmp/sleight-hold')) throw new Error('/tmp/sleight-hold exists; no live read');
  mkdirSync('/tmp/sleight-live.lock');
  record.lockAcquired = true;
  if (existsSync('/tmp/sleight-hold')) throw new Error('/tmp/sleight-hold appeared; no live read');
  record.doctorExit = await doctor({ env: { ...process.env, SLEIGHT_SURFACES: 'computer' }, log: line => record.logs.push(line) });
  if (existsSync(audit)) record.grants = readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean)
    .map(JSON.parse).filter(entry => entry.t >= record.started);
  record.exitCode = record.interrupted ? 130 : record.doctorExit;
} catch (err) { record.error = err.message; }
finally {
  if (record.lockAcquired) {
    try { rmdirSync('/tmp/sleight-live.lock'); record.lockReleased = true; }
    catch (err) { record.error = err.message; record.exitCode = 1; }
  }
  record.finished = new Date().toISOString();
  writeFileSync(staged, sanitizeHelperEvidence(record) + '\n', { mode: 0o600 });
  try { writeFileSync(output, sanitizeHelperEvidence(record) + '\n', { flag: 'wx' }); }
  catch (err) {
    record.publicationError = err.message;
    record.exitCode = 1;
    writeFileSync(staged, sanitizeHelperEvidence(record) + '\n', { mode: 0o600 });
  }
  console.log(sanitizeHelperEvidence({ ...record, receipt: staged, publication: output }));
  process.exitCode = record.exitCode;
}
