// Read-only AX schema investigation. The script owns its compile/helper process
// and shared live lock, and emits only API names, counts and categorical errors.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mimestreamHelper } from './real-mimestream.mjs';
import { runOwned } from './preapproved-process.mjs';
import { publishPrivateMailResults } from './private-mail.mjs';

export async function probeMimestream({ helper = mimestreamHelper, run = runOwned, auditFile,
  acquireLock = () => mkdirSync('/tmp/sleight-live.lock'), releaseLock = () => rmdirSync('/tmp/sleight-live.lock'),
  write = value => console.log(value) } = {}) {
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT', abort); process.once('SIGTERM', abort);
let locked = false, collected = true;
const observedTerms = [];
let exitCode = 0;
function auditResults(ownerName) {
  if (!auditFile) return undefined;
  const root = fileURLToPath(new URL('../', import.meta.url)), path = join(root, auditFile);
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || !realpathSync(path).startsWith(realpathSync(root) + '/')) throw new Error('MIMESTREAM_RESULT_AUDIT_REFUSED');
  const patterns = [...new Set(['@', ownerName, ...observedTerms].flatMap(value => String(value).split(/\r?\n/)).filter(Boolean))];
  let absent = false;
  try { execFileSync('/usr/bin/grep', ['-F', '-q', '-f', '-', path], { input: patterns.join('\n') + '\n', stdio: ['pipe', 'ignore', 'ignore'] }); }
  catch (error) { absent = error.status === 1; }
  if (!absent) throw new Error('MIMESTREAM_RESULT_AUDIT_REFUSED');
  return 'passed';
}
function report(metadata) {
  const bank = mkdtempSync(join(tmpdir(), 'sleight-mimestream-schema-audit-'));
  try {
    const ownerName = execFileSync('/usr/bin/id', ['-F'], { encoding: 'utf8' }).trim();
    if (!ownerName) throw new Error('PRIVATE_MAIL_OWNER_AUDIT_UNAVAILABLE');
    const json = JSON.stringify({ ...metadata, privacyAudit: 'passed', resultsAudit: auditResults(ownerName) });
    publishPrivateMailResults(join(bank, 'metadata.json'), json, { ownerName, terms: observedTerms });
    write(json);
  } finally { rmSync(bank, { recursive: true, force: true }); }
}
try {
  if (auditFile && !/^(bench\/results|docs\/benchmarks)\/[A-Za-z0-9_-]+\.json$/.test(auditFile)) throw Object.assign(new Error(), { code: 'MIMESTREAM_AUDIT_ARGUMENT_INVALID' });
  acquireLock(); locked = true;
  const executable = await helper(controller.signal);
  const result = await run(executable, ['--schema'], { signal: controller.signal, timeoutMs: 30000 });
  collected = result.groupClean === true;
  let schema;
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.stage === 'private-terms') observedTerms.push(...event.labels.filter(value => typeof value === 'string'));
    if (event.schema === true) schema = event;
  }
  if (result.exit.code !== 0 || !collected) {
    const code = /^MIMESTREAM_[A-Z_]+$/.test(result.stderr.trim()) ? result.stderr.trim() : 'MIMESTREAM_NATIVE_CAPABILITY_UNSUPPORTED';
    report({ attempt: 'mimestream-readonly-schema', input: false, outcome: 'refused', code, helperCollected: collected });
    exitCode = 1;
  } else {
    report({ attempt: 'mimestream-readonly-schema', input: false, outcome: 'observed', helperCollected: true,
      windowCount: schema.windowCount, roles: schema.roles, attributes: schema.attributes, actions: schema.actions });
  }
} catch (error) {
  if (error.code === 'MIMESTREAM_HELPER_UNCOLLECTED') collected = false;
  const code = /^MIMESTREAM_[A-Z_]+$/.test(error.code ?? '') ? error.code : error.code === 'EEXIST' ? 'MIMESTREAM_LIVE_LOCK_HELD' : 'MIMESTREAM_SCHEMA_FAILED';
  try { report({ attempt: 'mimestream-readonly-schema', input: false, outcome: 'refused', code }); }
  catch { write(JSON.stringify({ attempt: 'mimestream-readonly-schema', input: false, outcome: 'audit-refused' })); }
  if (error.compileDiagnostic) console.error(error.compileDiagnostic);
  exitCode = 1;
} finally {
  if (locked && collected) releaseLock();
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
}
return exitCode;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const auditFile = args.length === 2 && args[0] === '--audit-results' ? args[1] : args.length ? 'invalid' : undefined;
  process.exitCode = await probeMimestream({ auditFile });
}
