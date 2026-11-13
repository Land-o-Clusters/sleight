// Run only after signing exists. This is a live keychain probe, never part of offline tests.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const [helper, team, ...extra] = process.argv.slice(2);
if (extra.length || !isAbsolute(helper ?? '') || !/^[A-Z0-9]{10}$/.test(team ?? '')) {
  console.error('usage: node probe-sealed-keychain.mjs /absolute/signed/probe-helper TEAMID');
  process.exit(64);
}
const run = (file, args) => spawnSync(file, args, { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 10000, killSignal: 'SIGKILL',
  maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const requirement = `identifier "com.landoclusters.sleight.helper" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] ` +
  `and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${team}"`;
if (run('/usr/bin/codesign', ['--verify', '--strict', '-R=' + requirement, helper]).status !== 0) {
  console.error('PROBE_SIGNATURE_REQUIRED'); process.exit(1);
}
const directory = mkdtempSync(join(tmpdir(), 'sleight-keychain-probe-'));
const service = 'com.landoclusters.sleight.probe.' + randomUUID();
let created = false, cleanup = false;
try {
  const unsigned = join(directory, 'adhoc-probe');
  copyFileSync(helper, unsigned); chmodSync(unsigned, 0o700);
  if (run('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements,flags', unsigned]).status !== 0) throw Error('PROBE_ADHOC_COPY_FAILED');
  const call = (binary, name, op) => run(binary, ['--key-store-probe', name, op, team + '.com.landoclusters.sleight']);
  const refusedByKeychain = result => result.status !== 0 && /^key-store-probe status=-34018\s*$/.test(result.stdout);
  const added = call(helper, service, 'add');
  created = added.status === 0;
  if (!created) throw Error('PROBE_ENTITLED_ADD_FAILED');
  const entitledRead = call(helper, service, 'read').status === 0;
  // Keep all output private. Even an unexpected successful read must never print a key.
  const securityRefused = run('/usr/bin/security', ['find-generic-password', '-s', service, '-w']).status !== 0;
  const unsignedRefused = refusedByKeychain(call(unsigned, service, 'read'));
  const unsignedAddRefused = refusedByKeychain(call(unsigned, service + '.unsigned', 'add'));
  const unsignedDeleteRefused = refusedByKeychain(call(unsigned, service, 'delete'));
  const extraCleanup = call(helper, service + '.unsigned', 'delete');
  if (extraCleanup.status !== 0 && !/^key-store-probe status=-25300\s*$/.test(extraCleanup.stdout)) throw Error('PROBE_EXTRA_CLEANUP_UNPROVED');
  cleanup = call(helper, service, 'delete').status === 0;
  console.log(JSON.stringify({ entitledAdd: created, entitledRead, securityRefused, unsignedRefused, unsignedAddRefused,
    unsignedDeleteRefused, cleanup, promptObservation: 'operator must confirm no dialog appeared' }));
  if (![entitledRead, securityRefused, unsignedRefused, unsignedAddRefused, unsignedDeleteRefused, cleanup].every(Boolean)) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (created && !cleanup && run(helper, ['--key-store-probe', service, 'delete', team + '.com.landoclusters.sleight']).status !== 0) console.error('PROBE_CLEANUP_UNPROVED');
  rmSync(directory, { recursive: true, force: true });
}
