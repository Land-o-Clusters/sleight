// UC3F Mac orchestration. Import and dry run have no host or guest side effects.
import { guestSelftestPlan, guestDiagnosticPlan, selftestTable, SELFTEST_SCHEMA, validateSelftestJob } from './uc3f-selftest.mjs';
import { constants, openSync, fstatSync, readFileSync, closeSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishJSON, checkJSONOutput } from '../sitting-process.mjs';
import { guestTransport } from './rt31-sitting.mjs';
import { runChild } from './kit.mjs';
import { UC3F_ROWS } from './driver-sitting.mjs';
import { UC3F_PROTOCOL, UC3F_BLOCK_SECONDS, UC3F_PRESENT, UC3F_ROW_IDS, admitUC3FRow, VM_RECORD_PROVENANCE } from './uc3f-rows.mjs';
import { createInterface } from 'node:readline';
import { createReadStream, createWriteStream } from 'node:fs';

const protocol = UC3F_PROTOCOL, present = new Set(UC3F_PRESENT), rowIds = UC3F_ROW_IDS;
const codeOf = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.message ?? '') ? error.message : 'UC3F_SITTING_FAILED';

export function vmPlan(options = {}) {
  if ((options.ownerAway === true) === (options.ownerPresent === true)) throw Error('OWNER_MODE_REQUIRED');
  if (options.selftestJob !== undefined && !options.guestSelftest) throw Error('SELFTEST_MODE_REQUIRED');
  const presence = options.ownerAway ? 'away' : 'present';
  if (options.guestSelftest) {
    if (presence !== 'away' || options.rows !== undefined || options.guardOnly) throw Error('SELFTEST_AWAY_REQUIRED');
    const fullJobs = guestSelftestPlan();
    let jobs = options.selftestJob === undefined ? fullJobs : fullJobs.filter(job => job.id === options.selftestJob);
    if (!jobs.length) jobs = guestDiagnosticPlan().filter(job => job.id === options.selftestJob);
    if (!jobs.length) throw Error('SELFTEST_JOB_INVALID');
    return { schema: SELFTEST_SCHEMA, presence, rows: [], jobs, blockSeconds: UC3F_BLOCK_SECONDS.away, guestOnly: true, trials: 0, sendsInput: false,
      ...(options.selftestJob === undefined ? {} : { diagnosticOnly: true, fullJobCount: fullJobs.length }) };
  }
  const requested = options.rows ?? rowIds.filter(id => id === 'person-idle' || present.has(id) === !!options.ownerPresent);
  if (!Array.isArray(requested) || !requested.length || new Set(requested).size !== requested.length ||
      requested.some(id => !rowIds.includes(id))) throw Error('INVALID_ROWS');
  const rows = requested.map(id => {
    if (id !== 'person-idle' && present.has(id) !== !!options.ownerPresent) {
      throw Error(present.has(id) ? 'OWNER_PRESENT_REQUIRED' : 'OWNER_AWAY_REQUIRED');
    }
    return { id, presence, ...(id === 'person-idle' && { cases: options.ownerAway ? ['notepad', 'wpf', 'calculator-refused'] : ['background-word'] }),
      ...(id === 'checkpoint-cost' && { skip: 'NO_NOISE_CONSTANT' }) };
  });
  const scheduled = rows.filter(r => !r.skip).flatMap(r => UC3F_ROWS.find(rule => rule.id === r.id).cases.filter(c => !r.cases || r.cases.includes(c.id)));
  return { schema: 'sleight.uc3f-sitting/1', presence, rows, plannedCases: scheduled.length, plannedTrials: scheduled.reduce((sum, c) => sum + c.trials, 0), blockSeconds: UC3F_BLOCK_SECONDS[presence],
    guestOnly: true, hardwareEscape: 'owner-keyboard', evidence: 'bundle-and-attestation',
    // The present Word case completes person-idle in a second sitting.
    partialPersonIdle: true };
}

export function parseArgs(args) {
  const options = { host: 'vm', guestRoot: 'C:\\sleight', guestUser: 'Sleight' }, seen = new Set();
  const flags = { '--dry-run': 'dryRun', '--owner-away': 'ownerAway', '--owner-present': 'ownerPresent', '--guest-selftest': 'guestSelftest' };
  const values = { '--tools': 'tools', '--ssh-config': 'sshConfig', '--vm-id': 'vmId', '--vm-record': 'vmRecord',
    '--out': 'out', '--evidence-out': 'evidenceOut', '--attestation-out': 'attestationOut', '--raw-out': 'rawOut', '--owner-away-file': 'ownerAwayFile', '--rows': 'rows', '--guest-selftest-job': 'selftestJob', '--guest-user': 'guestUser' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw Error('DUPLICATE_OPTION');
    seen.add(key);
    if (flags[key]) options[flags[key]] = true;
    else {
      if (!values[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('INVALID_OPTION');
      options[values[key]] = key === '--rows' ? args[++i].split(',') : args[++i];
    }
  }
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(options.guestUser)) throw Error('GUEST_USER_INVALID');
  vmPlan(options);
  return options;
}

// Accept a small standalone SSH config, with no includes, commands, wildcard
// sections, proxies or forwarding. Its only endpoint is UTM's shared subnet.
export function verifyNetwork(text, alias = 'vm') {
  if (alias !== 'vm') throw Error('VM_ALIAS_REQUIRED');
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) throw Error('SSH_CONFIG_UNSAFE');
  const entries = new Map(); let host = false;
  const allowed = new Set(['hostname', 'user', 'identityfile', 'userknownhostsfile', 'identitiesonly',
    'stricthostkeychecking', 'batchmode', 'connecttimeout', 'port', 'loglevel']);
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim(); if (!value || value.startsWith('#')) continue;
    const match = /^(\w+)\s+([^\r\n]+)$/.exec(value);
    if (!match) throw Error('SSH_CONFIG_UNSAFE');
    const key = match[1].toLowerCase(), argument = match[2];
    if (key === 'host') {
      if (host || argument !== 'vm') throw Error('SSH_CONFIG_UNSAFE');
      host = true; continue;
    }
    if (!host || !allowed.has(key) || entries.has(key) || /["'`$%#]/.test(argument)) throw Error('SSH_CONFIG_UNSAFE');
    entries.set(key, argument);
  }
  if (!host) throw Error('SSH_CONFIG_UNSAFE');
  const hostName = entries.get('hostname');
  if (!/^192\.168\.64\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(hostName ?? '')) throw Error('NOT_VM_NETWORK');
  for (const key of ['identitiesonly', 'stricthostkeychecking', 'batchmode']) {
    if (entries.has(key) && entries.get(key) !== 'yes') throw Error('SSH_CONFIG_UNSAFE');
  }
  if (entries.has('port') && entries.get('port') !== '22' || entries.has('connecttimeout') && entries.get('connecttimeout') !== '10' ||
      entries.has('user') && !/^[A-Za-z0-9_.-]{1,64}$/.test(entries.get('user')) ||
      entries.has('loglevel') && entries.get('loglevel') !== 'ERROR') throw Error('SSH_CONFIG_UNSAFE');
  return hostName;
}

export function verifyRecord(record, vmId, hostName = record?.hostName) {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(vmId ?? '') || record?.vmId !== vmId || record.manufacturer !== 'QEMU' ||
      typeof record.model !== 'string' || !/^[A-Za-z0-9 ._-]{1,80}$/.test(record.model) ||
      !Number.isSafeInteger(record.build) || record.build < 22000 ||
      ![record.hostnameSha256, record.machineGuidSha256].every(v => /^[a-f0-9]{64}$/.test(v ?? ''))) throw Error('VM_IDENTITY_REQUIRED');
  if (record.schema !== 'sleight.uc3f-vm-record/1' || record.hostName !== hostName ||
      !/^192\.168\.64\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(hostName ?? '') ||
      !record.provenance || Object.keys(record.provenance).sort().join() !== Object.keys(VM_RECORD_PROVENANCE).sort().join() ||
      Object.entries(VM_RECORD_PROVENANCE).some(([k, v]) => record.provenance[k] !== v)) throw Error('VM_RECORD_PROVENANCE_REQUIRED');
}
export function verifyGuest(current, expected, vmId) {
  verifyRecord(expected, vmId);
  if (current?.manufacturer !== 'QEMU') throw Error('NOT_VM');
  for (const key of ['vmId', 'model', 'build', 'hostnameSha256', 'machineGuidSha256']) {
    if (current[key] !== expected[key]) throw Error('VM_IDENTITY_MISMATCH');
  }
  if (!Number.isSafeInteger(current.sessionId) || current.sessionId <= 0) throw Error('INTERACTIVE_SESSION_REQUIRED');
  if (current.elevated !== false) throw Error('UNELEVATED_REQUIRED');
}

function readSmallFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw Error('INPUT_FILE_UNSAFE');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

// Only a local controlling terminal can authorize present mode. A redirected
// stdin, SSH or Claude session, or absent TTY refuses. This is not user authentication.
export function ownerInstructions(row) {
  if (row.id === 'escape-stop-hardware') return 'After go, focus the pinned UTM window and the new Sleight WDR7 WPF editor. Wait for a burst of q characters, then press physical Escape once. Repeat for 10 separate bursts. Do not type other keys. Setup can take about a minute.\n';
  if (row.id === 'person-idle' && row.cases?.includes('background-word')) return 'After go, click the new Sleight WDR7 WPF editor whose text starts Owner typing target in the Windows guest and keep typing there while sleight writes to its separate Notepad fixture. Keep the pointer over the WPF editor. A disposable Word document also works when Word is installed. Each of 20 trials needs fresh input within 2 seconds in that foreground typing target. Continue until this Terminal prints Row collected. Never type in the Notepad fixture.\n';
  return '';
}
export async function promptOwner(row, { signal, env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || !stdin.isTTY || !stdout.isTTY) throw Error('LOCAL_OWNER_TTY_REQUIRED');
  const input = createReadStream('/dev/tty'), output = createWriteStream('/dev/tty');
  const terminal = createInterface({ input, output, terminal: true });
  let abort;
  try {
    return await new Promise((accept, reject) => {
      const fail = () => reject(Error('OWNER_GO_REQUIRED'));
      input.once('error', fail); output.once('error', fail); terminal.once('close', fail);
      abort = () => { terminal.close(); fail(); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else terminal.question(ownerInstructions(row) + `UC3F ${row.id}: be at this Mac. Act only inside the VM when instructed. Type go to continue: `,
        answer => { signal?.removeEventListener('abort', abort); accept(answer); });
    });
  } finally { if (abort) signal?.removeEventListener('abort', abort); terminal.close(); input.destroy(); output.end(); }
}

export async function createUC3FBackend(options, dependencies = {}) {
  const plan = vmPlan(options), read = dependencies.readFile ?? readSmallFile;
  if ((dependencies.platform ?? process.platform) !== 'darwin' || !(dependencies.env ?? process.env).CLAUDE_CONFIG_DIR) throw Error('ISOLATED_MAC_HOST_REQUIRED');
  const hostName = verifyNetwork(read(options.sshConfig), options.host);
  const expected = JSON.parse(read(options.vmRecord)); verifyRecord(expected, options.vmId, hostName);
  let stopped;
  const abort = new AbortController();
  const check = async () => {
    if (stopped) throw Error(stopped);
    if (plan.presence === 'away' && (!options.ownerAwayFile || !(dependencies.exists ?? existsSync)(options.ownerAwayFile))) throw Error('OWNER_AWAY_ENDED');
  };
  const child = async (command, args, settings = {}) => {
    await check();
    if (!['/usr/bin/ssh', '/usr/bin/scp'].includes(command)) throw Error('MAC_COMMAND_REFUSED');
    const ssh = command === '/usr/bin/ssh';
    const prefix = ssh ? ['-F', options.sshConfig, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'] :
      ['-q', '-F', options.sshConfig, '-o', 'BatchMode=yes'];
    if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string') || args.length !== prefix.length + 2 ||
        prefix.some((arg, i) => args[i] !== arg) ||
        !Number.isSafeInteger(settings.timeout) || settings.timeout <= 0 || settings.timeout > 60000) throw Error('MAC_COMMAND_REFUSED');
    const tail = args.slice(prefix.length);
    if (ssh ? tail[0] !== 'vm' || tail[1] !== 'powershell -NoProfile -NonInteractive -Command -' :
      tail.filter(arg => /^vm:[A-Za-z0-9/:._-]+$/.test(arg)).length !== 1 ||
      tail.filter(arg => arg.startsWith('/') && !/[:\r\n]/.test(arg)).length !== 1) throw Error('MAC_COMMAND_REFUSED');
    if (verifyNetwork(read(options.sshConfig), options.host) !== hostName) throw Error('NOT_VM_NETWORK');
    const pinned = [`HostName=${hostName}`, 'ProxyCommand=none', 'ProxyJump=none', 'PermitLocalCommand=no',
      'ClearAllForwardings=yes', 'RemoteCommand=none', 'StrictHostKeyChecking=yes'].flatMap(value => ['-o', value]);
    return (dependencies.runChild ?? runChild)(command, [...prefix, ...pinned, ...tail], settings);
  };
  await check();
  const transport = await (dependencies.guestTransport ?? guestTransport)({ ...options, expected, protocol, presence: plan.presence }, { runChild: child, check });
  if (transport?.protocol !== protocol || typeof transport.call !== 'function' || typeof transport.copyEvidence !== 'function') throw Error('UC3F_TRANSPORT_PROTOCOL_REQUIRED');
  return {
    interrupt(reason) { stopped ??= reason; abort.abort(); transport.interrupt?.(reason); },
    async start() {
      await check();
      if (plan.presence === 'present' && await (dependencies.prompt ?? promptOwner)({ id: 'present-block' }, { signal: abort.signal }) !== 'go') throw Error('OWNER_GO_REQUIRED');
      verifyGuest(await transport.call('preflight', { expected }), expected, options.vmId);
      await check();
    },
    async selftest() {
      const results = [];
      for (const job of plan.jobs) {
        await check();
        const value = await transport.call('selftest', { job });
        validateSelftestJob(value, job);
        results.push(value);
        dependencies.onSelftestJob?.(value);
      }
      return results;
    },
    async row(row) {
      admitUC3FRow(row, plan.presence);
      await check();
      if (row.presence === 'present' && await (dependencies.prompt ?? promptOwner)(row, { signal: abort.signal }) !== 'go') throw Error('OWNER_GO_REQUIRED');
      const value = await transport.call('row', { row });
      if (value?.row !== row.id || value.collected !== true || value.hookRemoved !== true) throw Error(value?.code ?? 'ROW_UNCOLLECTED');
      await check();
      if (row.presence === 'present') (dependencies.notice ?? (text => process.stdout.write(text)))(`Row collected: ${row.id}. Return to this Terminal.\n`);
      return { id: row.id, status: 'collected' };
    },
    async collect() {
      await check();
      if ((await transport.call('export'))?.exported !== true) throw Error('EXPORT_UNCONFIRMED');
      const copied = await transport.copyEvidence({ bundle: options.evidenceOut, attestation: options.attestationOut, ...(options.rawOut && { raw: options.rawOut }) });
      if (copied?.confirmed !== true) throw Error('EVIDENCE_COPY_UNCONFIRMED');
      await check();
    },
    async close() { await transport.close?.(); },
  };
}

export async function runUC3FSitting(options, dependencies = {}) {
  const plan = vmPlan(options), report = { ...plan, rows: [], completed: false, evidenceCopied: false };
  if (!options.guestSelftest && plan.rows.length && plan.rows.every(row => row.skip)) {
    report.rows = plan.rows.map(row => ({ id: row.id, status: 'skip', reason: row.skip }));
    report.completed = true;
    return report;
  }
  let backend;
  const signals = dependencies.signals ?? process, handlers = new Map();
  let interrupted;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => { interrupted ??= signal; backend?.interrupt(interrupted); };
    handlers.set(signal, handler); signals.on(signal, handler);
  }
  try {
    backend = await createUC3FBackend(options, { ...dependencies, onSelftestJob: job => {
      (report.selftest ??= []).push(job); dependencies.onSelftestJob?.(job);
    } });
    if (interrupted) backend.interrupt(interrupted);
    await backend.start();
    if (options.guestSelftest) report.selftest = await backend.selftest();
    for (const row of plan.rows) {
      if (row.skip) report.rows.push({ id: row.id, status: 'skip', reason: row.skip });
      else report.rows.push(await backend.row(row));
    }
    if (!options.guestSelftest) { await backend.collect(); report.evidenceCopied = true; }
  } catch (error) {
    report.stop = codeOf(error);
    if (typeof error?.guestCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.guestCode)) report.guestCode = error.guestCode;
  }
  finally {
    try { await backend?.close(); } catch (error) { report.stop ??= codeOf(error); }
    for (const [signal, handler] of handlers) signals.removeListener(signal, handler);
  }
  if (interrupted) report.stop = interrupted;
  const selftestPassed = options.guestSelftest && report.selftest?.length === plan.jobs.length && report.selftest.every(job => job.operations.every(r => r.status !== 'fail'));
  report.completed = !report.stop && report.rows.length === plan.rows.length && (selftestPassed || report.evidenceCopied);
  return report;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(args), print = dependencies.print ?? (text => process.stdout.write(text));
  if (options.dryRun) {
    const result = { dryRun: true, ...vmPlan(options) }; print(JSON.stringify(result, null, 2) + '\n'); return result;
  }
  if (!(options.guestSelftest ? ['sshConfig', 'vmId', 'vmRecord', 'out'] : ['sshConfig', 'vmId', 'vmRecord', 'out', 'evidenceOut', 'attestationOut']).every(k => typeof options[k] === 'string' && options[k])) throw Error('LIVE_ARGUMENTS_REQUIRED');
  const outputs = [...(options.guestSelftest ? [options.out] : [options.out, options.evidenceOut, options.attestationOut, ...options.rawOut ? [options.rawOut] : []]),
].map(resolvePath => resolve(resolvePath));
  if (new Set(outputs).size !== outputs.length) throw Error('OUTPUT_UNSAFE');
  outputs.forEach(checkJSONOutput);
  const report = await runUC3FSitting(options, dependencies);
  if (options.guestSelftest) print(selftestTable(report));
  (dependencies.publishJSON ?? publishJSON)(options.out, report);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(report => { process.exitCode = report.dryRun || report.completed ? 0 : 1; })
    .catch(error => { console.error(codeOf(error)); process.exitCode = 1; });
}
