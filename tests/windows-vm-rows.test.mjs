import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { createManifest } from '../bench/windows/guest-integrity.mjs';
import { createAttestation, exportRawLogs, rawArchiveHash, summarizeExport } from '../bench/windows/uc3f-export.mjs';
import { evaluateSafetyEvidence } from '../bench/windows/driver-sitting.mjs';
import { VM_RECORD_PROVENANCE } from '../bench/windows/uc3f-rows.mjs';
import { revision, rowObservations } from './fixtures/vm-row-observations.mjs';
import * as production from '../bench/windows/vm-rows.mjs';

const url = new URL('../bench/windows/vm-rows.mjs', import.meta.url);
const source = readFileSync(url, 'utf8');
const mutations = {
  disposable: ["options.restoreMode ?? 'disposable'", "options.restoreMode ?? 'snapshot'"],
  stopped: ["if (current !== 'stopped')", 'if (true)'],
  session: ["if (session.sessionId !== 1 || session.user?.toLowerCase() !== user.toLowerCase() || session.state !== 0)", 'if (false)'],
  address: ["if (!Array.isArray(session.addresses) || !session.addresses.includes(hostName))", 'if (false)'],
  hold: ['await waitHold(state);', ''],
  capture: ['await transport.capture(token, attempt.failureOut)', 'await Promise.resolve()'],
  resumeInputs: ['JSON.stringify(state.identity) !== JSON.stringify(identity)', "JSON.stringify({ ...state.identity, kitHash: identity.kitHash, sshHash: identity.sshHash, vmHash: identity.vmHash }) !== JSON.stringify(identity)"],
  verb: ["if (!allowed.some(v => JSON.stringify(v) === JSON.stringify(args)))", 'if (false)'],
  subnet: ['verifyNetwork(config())', "'192.168.64.2'"],
  away: ['if (!existsSync(ownerAwayFile))', 'if (false)'],
  lock: ['const unlock = (dependencies.lock ?? lockVM)();', 'const unlock = () => {};'],
  resume: ["if (row.status === 'finished' || row.status === 'evidence-lost') continue;", 'if (false) continue;'],
  guestUser: ["let user = options.guestUser;", "let user = 'Sleight';"],
  guestReady: ['session.user?.toLowerCase() !== user.toLowerCase()', "session.user?.toLowerCase() !== 'sleight'"],
  guestAcl: ["quote(user + ':RX')", "quote('Sleight:RX')"],
  guestBankAcl: ["quote(user + ':(OI)(CI)M')", "quote('Sleight:(OI)(CI)M')"],
  guestTask: ['-UserId ${quote(user)}', "-UserId 'Sleight'"],
  guestProbe: ['sample.whoami.split(\'\\\\\').at(-1).toLowerCase() !== user.toLowerCase()', "sample.whoami.split('\\\\').at(-1).toLowerCase() !== 'sleight'"],
  guestProbePrincipal: ["readFileSync(new URL('./vm-session-probe.ps1', import.meta.url), 'utf8')",
    "readFileSync(new URL('./vm-session-probe.ps1', import.meta.url), 'utf8').replace('-UserId $guestUser', \"-UserId 'Sleight'\")"],
  guestIdentity: ['guestUser: plan.guestUser, vmId:', 'guestUser: undefined, vmId:'],
  lost: ["plan.restoreMode !== 'disposable' || await transport.status() !== 'stopped'", 'true'],
  lostRerun: ["previous.evidencePending = false; row.status = 'evidence-lost'; row.reason = 'VM_EVIDENCE_LOST_AFTER_STOP'; save();\n          continue;",
    "previous.evidencePending = false; save();"],
  readyStop: ['if (!attempt.evidencePending) {', 'if (attempt.evidencePending === false) {'],
  ownerCopy: ['await transport.copy(token, paths);', 'check(); await transport.copy(token, paths);'],
  ownerFinish: ['async finish() {', 'async finish() { check();'],
  stopPoll: ["for (let polls = 0; await status() !== 'stopped'; polls++)", 'for (let polls = 0; false; polls++)'],
  stopBound: ["if (now() >= end || polls >= 30)", 'if (polls >= 31)'],
  list: ["const allowed = [...plan.restore, ['status', options.vmId]];", "const allowed = [...plan.restore, ['status', options.vmId], ['list']];"],
  costQualification: ["...id === 'checkpoint-cost' ? { measurementOnly: true } : {},", ''],
  bootstrapStop: ['if (failedBootstrap(attempt, raw)) {', 'if (false) {'],
  bootstrapLegacy: ["if (row.status === 'finished' && failedBootstrap(last))", 'if (false)'],
  bootstrapLost: ["if (row.status === 'evidence-lost') {", 'if (false) {'],
  exportSources: ["const output = join(bank, 'export-' + hash(JSON.stringify(sources.map(s => s.rawOut))).slice(0, 16));", 'const output = bank;'],
  pendingOrder: ['for (const row of state.rows) {', 'for (const row of []) {'],
};
let runner = production;
if (process.env.WH1C_BROKEN) {
  const edit = mutations[process.env.WH1C_BROKEN]; assert.ok(edit && source.includes(edit[0]));
  const changed = source.replaceAll(edit[0], edit[1]).replace(/from '(\.\.?\/[^']+)'/g,
    (_all, path) => `from '${new URL(path, url).href}'`).replace('if (isMain(import.meta.url))', 'if (false)').replaceAll('import.meta.url', JSON.stringify(url.href));
  runner = await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}
const vm = { vmId: 'test-vm', manufacturer: 'QEMU', model: 'Virtual Machine', build: 26300,
  hostnameSha256: 'e'.repeat(64), machineGuidSha256: 'f'.repeat(64) };
function setup(t, extra = {}) {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-vm-rows-')));
  const kit = join(dir, 'kit'); mkdirSync(kit);
  for (const name of ['vm-row-task.ps1', 'vm-row-guest.mjs']) {
    const path = join(kit, 'bench/windows', name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'fixture\n');
  }
  const manifest = createManifest(kit, revision);
  writeFileSync(join(kit, 'guest-manifest.json'), JSON.stringify(manifest));
  const options = { restoreMode: 'snapshot', rows: production.rowPlan({ rows: undefined }).rows.map(r => r.id).concat('checkpoint-cost'), holdFile: join(dir, 'hold'), bank: join(dir, 'bank'), kit, sshConfig: join(dir, 'ssh-config'), vmId: vm.vmId,
    vmRecord: join(dir, 'vm.json'), ownerAwayFile: join(dir, 'owner-away'), ...extra };
  writeFileSync(options.sshConfig, 'Host vm\n HostName 192.168.64.2\n User Sleight\n BatchMode yes\n');
  writeFileSync(options.vmRecord, JSON.stringify({ ...vm, schema: 'sleight.uc3f-vm-record/1', hostName: '192.168.64.2', provenance: VM_RECORD_PROVENANCE }));
  writeFileSync(options.ownerAwayFile, '');
  const context = { revision, kitManifestSha256: productionHash(readFileSync(join(kit, 'guest-manifest.json'))),
    exporterSha256: 'c'.repeat(64), observerSha256: 'd'.repeat(64), vm, userSidSha256: '1'.repeat(64) };
  return { dir, options, context, lock: () => runner.lockVM(join(dir, 'vm.lock')) };
}
import { createHash } from 'node:crypto';
const productionHash = x => createHash('sha256').update(x).digest('hex');
const cache = new Map();
async function rawFor(id, context) {
  if (!cache.has(id)) cache.set(id, await rowObservations(id));
  const logs = [cache.get(id)], raw = { schema: 'sleight.uc3f-row-raw/1', context, logs, injectorLogs: [] };
  raw.sha256 = rawArchiveHash(raw);
  const projected = exportRawLogs(logs, revision), bytes = Buffer.from(JSON.stringify(projected.bundle) + '\n');
  return { raw, bytes, attestation: createAttestation(bytes, context) };
}
function fakeTransport(f, hooks = {}) {
  const events = [], rows = [];
  let current;
  const transport = () => ({
    ...Object.fromEntries(['restore', 'ready', 'clock', 'kit'].map(step => [step, async () => { events.push(step); await hooks[step]?.(); }])),
    async row(row, token) { events.push('row'); rows.push(row.id); current = { id: row.id, token }; await hooks.row?.(row); },
    async finish() { await hooks.finish?.(); },
    async status() { return await hooks.status?.() ?? 'started'; },
    async capture(token, path) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'partial.jsonl'), 'partial evidence'); await hooks.capture?.(path); },
    async copy(token, paths) {
      events.push('copy'); assert.equal(token, current.token);
      const { raw, bytes, attestation } = await rawFor(current.id, f.context);
      writeFileSync(paths.rawOut, JSON.stringify(raw)); writeFileSync(paths.evidenceOut, bytes);
      writeFileSync(paths.attestationOut, JSON.stringify(attestation)); await hooks.copy?.(paths);
    },
  });
  return { transport, events, rows, lock: process.platform === 'darwin' ? f.lock : () => () => {} };
}

test('dry run prints eleven rows, the restore plan and starts zero processes', async () => {
  let printed = '', processes = 0;
  const forbidden = () => { processes++; throw Error('DRY_RUN_SPAWN'); };
  const result = await runner.main(['--dry-run'], { print: s => { printed += s; }, child: forbidden, transport: forbidden, lock: forbidden });
  assert.equal(processes, 0); assert.equal(result.processes, 0); assert.equal(result.rows.length, 11);
  assert.deepEqual(result.restore, [['status', '<vm>'], ['stop', '<vm>'], ['start', '--disposable', '--hide', '<vm>']]);
  assert.deepEqual(JSON.parse(printed), result);
  assert.deepEqual(runner.rowPlan({ rows: ['checkpoint-cost'] }).rows, [{ id: 'checkpoint-cost', presence: 'away', measurementOnly: true }]);
  assert.equal(production.VM_LOCK, '/tmp/sleight-vm.lock');
});

test('strict options reject unknown, duplicate, present, empty and unsafe inputs', () => {
  for (const args of [['--dry-run', '--dry-run'], ['--unknown'], ['--rows'], ['--rows', 'person-idle,person-idle'],
    ['--rows', 'lock-refused'], ['--restore-mode', 'clone'], ['--snapshot', '../clean'], ['--vm-id', '-evil']])
    assert.throws(() => runner.parseArgs(args));
  assert.throws(() => runner.rowPlan({ rows: [] }), /INVALID_ROWS/);
  assert.throws(() => runner.lockVM('unused', 'linux'), /MAC_FLOCK_REQUIRED/);
});

test('restore modes admit only their exact utmctl verbs and arguments', t => {
  const { options } = setup(t), settings = { timeout: 60000 };
  for (const restoreMode of ['disposable', 'snapshot', 'save-state', 'cold']) {
    const o = { ...options, restoreMode }, plan = runner.rowPlan(o);
    for (const args of [...plan.restore, ['status', o.vmId]])
      assert.deepEqual(runner.commandPolicy(o, '192.168.64.2', production.UTMCTL, args, settings), args);
    for (const args of [['list'], ['delete', o.vmId], ['snapshot', 'delete', o.vmId, 'clean-signed-in'], ['exec', o.vmId, 'whoami'],
      ['start', '--disposable', o.vmId], ['snapshot', 'restore', 'foreign-vm', 'clean-signed-in'],
      ...restoreMode === 'disposable' ? [['start', o.vmId]] : [],
      ...restoreMode === 'snapshot' ? [['stop', o.vmId], ['start', o.vmId]] : [['snapshot', 'restore', o.vmId, 'clean-signed-in']]])
      assert.throws(() => runner.commandPolicy(o, '192.168.64.2', production.UTMCTL, args, settings), /MAC_COMMAND_REFUSED/);
  }
});

test('policy pins SSH and SCP, refuses other commands and bounds children', t => {
  const { options: o } = setup(t), s = { timeout: 60000 };
  const args = ['-F', o.sshConfig, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'vm', 'powershell -NoProfile -NonInteractive -Command -'];
  const admitted = runner.commandPolicy(o, '192.168.64.2', '/usr/bin/ssh', args, s);
  for (const value of ['HostName=192.168.64.2', 'ProxyCommand=none', 'ProxyJump=none', 'PermitLocalCommand=no', 'StrictHostKeyChecking=yes']) assert.ok(admitted.includes(value));
  assert.throws(() => runner.commandPolicy(o, '192.168.64.2', '/usr/bin/osascript', [], s), /MAC_COMMAND_REFUSED/);
  for (const timeout of [0, -1, Infinity, 60001]) assert.throws(() => runner.commandPolicy(o, '192.168.64.2', '/usr/bin/ssh', args, { timeout }), /MAC_COMMAND_REFUSED/);
  assert.throws(() => runner.commandPolicy(o, '192.168.64.2', '/usr/bin/ssh', [...args.slice(0, -2), 'foreign', args.at(-1)], s), /MAC_COMMAND_REFUSED/);
  assert.throws(() => runner.commandPolicy(o, '192.168.64.2', '/usr/bin/scp', ['-q', '-F', o.sshConfig, '-o', 'BatchMode=yes', '/fixture', 'person:/out'], s), /MAC_COMMAND_REFUSED/);
});

test('off-subnet HostName and changed config refuse before a child', async t => {
  const f = setup(t); let processes = 0;
  const child = async () => { processes++; return { status: 0, stdout: '' }; };
  writeFileSync(f.options.sshConfig, 'Host vm\nHostName 10.0.0.5\n');
  assert.throws(() => runner.createRowTransport(f.options, { child }), /NOT_VM_NETWORK/);
  assert.equal(processes, 0);
  writeFileSync(f.options.sshConfig, 'Host vm\nHostName 192.168.64.2\n');
  const transport = runner.createRowTransport(f.options, { child });
  writeFileSync(f.options.sshConfig, 'Host vm\nHostName 192.168.64.3\n');
  await assert.rejects(transport.restore(), /NOT_VM_NETWORK/); assert.equal(processes, 0);
});

test('missing owner-away file refuses before restore and lock is released', async t => {
  const f = setup(t), fake = fakeTransport(f); unlinkSync(f.options.ownerAwayFile);
  await assert.rejects(runner.runRows(f.options, fake), /OWNER_AWAY_REQUIRED/);
  assert.deepEqual(fake.events, []);
  if (process.platform === 'darwin') f.lock()();
});

test('a held flock prevents a row from starting', { skip: process.platform !== 'darwin' }, async t => {
  const f = setup(t), fake = fakeTransport(f), unlock = f.lock();
  try { await assert.rejects(runner.runRows(f.options, fake), /VM_LOCK_HELD/); assert.deepEqual(fake.events, []); }
  finally { unlock(); }
});

test('flock survives its file and the OS releases it on process exit', { skip: process.platform !== 'darwin' }, t => {
  const f = setup(t), path = join(f.dir, 'vm.lock');
  const script = `import {lockVM} from ${JSON.stringify(url.href)}; lockVM(${JSON.stringify(path)}); process.exit(23);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 60000, killSignal: 'SIGKILL', encoding: 'utf8', env: process.env });
  assert.equal(result.status, 23, result.stderr); assert.ok(existsSync(path));
  const unlock = f.lock(); assert.throws(f.lock, /VM_LOCK_HELD/); unlock(); f.lock()();
  const link = join(f.dir, 'link'); symlinkSync(path, link); assert.throws(() => runner.lockVM(link));
});

test('all twelve away rows collect raw archives and an attested UC3E bundle', async t => {
  const f = setup(t), fake = fakeTransport(f), result = await runner.runRows(f.options, fake);
  assert.equal(result.completed, true, result.stop); assert.equal(result.rows.length, 12);
  assert.deepEqual(fake.rows, runner.rowPlan(f.options).rows.map(r => r.id));
  assert.equal(fake.events.length, 72);
  assert.equal(result.rows.filter(r => r.status === 'finished').length, 12);
  for (let i = 0; i < 12; i++) assert.deepEqual(fake.events.slice(i * 6, i * 6 + 6), ['restore', 'ready', 'clock', 'kit', 'row', 'copy']);
  const bundle = JSON.parse(readFileSync(result.export.bundle));
  assert.equal(bundle.rows.length, 11);
  for (const row of bundle.rows) assert.equal(evaluateSafetyEvidence(row.id, row.evidence).status, row.id === 'checkpoint-cost' ? 'skip' : 'pass', row.id);
  assert.equal(summarizeExport(bundle).safetyRows.pass, 10);
  assert.ok(result.export.diagnostics.some(d => d.id === 'person-idle' && d.code === 'RAW_CASE_MISSING'));
  assert.equal(result.rows.flatMap(r => r.attempts).filter(a => existsSync(a.rawOut)).length, 12);
});

test('real transport runs twelve rows using only fake ssh, scp and utmctl', async t => {
  const f = setup(t), calls = []; let active, downloads;
  const child = async (command, args, settings) => {
    calls.push({ command, args, settings });
    assert.ok([production.UTMCTL, '/usr/bin/ssh', '/usr/bin/scp'].includes(command));
    if (command === '/usr/bin/ssh') {
      if (settings.input.includes('GetClipboardSequenceNumber')) return { status: 0, stdout: JSON.stringify({ whoami: 'Sleight',
        clipboard: { sessionId: 1, station: 'WinSta0', desktop: 'Default', sequence: 0, error: 0,
          lastInputOk: true, lastInputAgeMs: 300000, foregroundLockOk: true, foregroundLockMs: 200000, foregroundPid: 1000 } }) + '\nSLEIGHT_GUEST_OK\n' };
      let value = settings.input.includes('WTSQuerySessionInformation') ? JSON.stringify({ sessionId: 1, user: 'Sleight', state: 0, addresses: ['192.168.64.2'] }) : '';
      if (settings.input.includes('Register-ScheduledTask')) {
        const encoded = /WriteAllBytes\([^\n]+FromBase64String\('([^']+)'\)/.exec(settings.input)?.[1];
        assert.ok(encoded); active = JSON.parse(Buffer.from(encoded, 'base64'));
        assert.equal(active.expected.vmId, f.options.vmId);
        downloads = await rawFor(active.row.id, f.context);
      }
      if (settings.input.includes('row-result.json')) value = JSON.stringify({ recorded: true, row: active.row.id, code: 'RECORDED', status: 'recorded' });
      return { status: 0, stdout: value + '\nSLEIGHT_GUEST_OK\n' };
    }
    if (command === '/usr/bin/scp' && args.at(-2).startsWith('vm:')) {
      const from = args.at(-2), destination = args.at(-1);
      const bytes = from.endsWith('uc3f-row-raw.json') ? JSON.stringify(downloads.raw) :
        from.endsWith('uc3f-observations.attestation.json') ? JSON.stringify(downloads.attestation) : downloads.bytes;
      writeFileSync(destination, bytes);
    }
    return { status: 0, stdout: '' };
  };
  const result = await runner.runRows(f.options, { child, lock: process.platform === 'darwin' ? f.lock : () => () => {} });
  assert.equal(result.completed, true, result.stop);
  assert.equal(calls.filter(c => c.command === production.UTMCTL).length, 12);
  assert.equal(calls.filter(c => c.settings.input?.includes('Register-ScheduledTask') && !c.settings.input.includes('GetClipboardSequenceNumber')).length, 12);
  assert.equal(calls.filter(c => c.settings.input?.includes('GetClipboardSequenceNumber')).length, 3);
  assert.equal(calls.filter(c => c.command === '/usr/bin/scp' && c.args.at(-2).startsWith('vm:')).length, 36);
  assert.equal(calls.filter(c => c.command === '/usr/bin/scp' && c.args.includes('-r')).length, 12);
  assert.equal(result.rows[0].attempts[0].receipt.row, 'person-idle');
  for (const c of calls.filter(c => c.command !== production.UTMCTL)) assert.ok(c.args.includes('HostName=192.168.64.2'));
});

test('SSH readiness retries and row wait times out without stopping the guest', async t => {
  const f = setup(t), calls = []; let time = 0, probes = 0;
  const transport = runner.createRowTransport(f.options, { now: () => time, pause: async () => { time += 900001; }, child: async (command, args, settings) => {
    calls.push(settings.input ?? '');
    if (settings.input?.includes('WTSQuerySessionInformation') && probes++ === 0) return { status: 255 };
    return { status: 0, stdout: (settings.input?.includes('row-result.json') ? '{"pending":true}\n' : settings.input?.includes('WTSQuerySessionInformation') ? JSON.stringify({ sessionId: 1, user: 'Sleight', state: 0, addresses: ['192.168.64.2'] }) + '\n' : '') + 'SLEIGHT_GUEST_OK\n' };
  } });
  await transport.ready(); assert.equal(probes, 2);
  await assert.rejects(transport.row({ id: 'cancel-frame', presence: 'away' }, 'a'.repeat(16)), /VM_ROW_TIMEOUT/);
  assert.ok(calls.some(s => s.includes('Register-ScheduledTask')));
  assert.ok(calls.every(s => !/Stop-ScheduledTask|Stop-Process|taskkill|\.Kill\(/.test(s)));
});

test('resume retries the stopped row and never reruns a finished row', async t => {
  const f = setup(t, { rows: ['person-key-before', 'person-key-during', 'cancel-frame'] });
  let stopped = false;
  const fake = fakeTransport(f, { row: async row => { if (row.id === 'person-key-during' && !stopped) { stopped = true; throw Error('VM_ROW_TIMEOUT'); } } });
  const first = await runner.runRows(f.options, fake);
  assert.equal(first.completed, false); assert.equal(first.stop, 'VM_ROW_TIMEOUT');
  assert.deepEqual(first.rows.map(r => r.status), ['finished', 'running', 'pending']);
  const second = await runner.runRows(f.options, fake);
  assert.equal(second.completed, true, second.stop);
  assert.deepEqual(fake.rows, ['person-key-before', 'person-key-during', 'person-key-during', 'cancel-frame']);
  assert.deepEqual(second.rows.map(r => r.attempts.length), [1, 2, 1]);
  const before = [...fake.rows]; assert.equal((await runner.runRows(f.options, fake)).completed, true);
  assert.deepEqual(fake.rows, before);
  await assert.rejects(runner.runRows({ ...f.options, restoreMode: 'cold' }, fake), /STATE_IDENTITY_CHANGED/);
});

test('owner returning stops the block at its current row without guest signals', async t => {
  const f = setup(t), fake = fakeTransport(f, { clock: async () => { unlinkSync(f.options.ownerAwayFile); } });
  const first = await runner.runRows(f.options, fake);
  assert.equal(first.stop, 'OWNER_AWAY_REQUIRED'); assert.deepEqual(fake.events, ['restore', 'ready', 'clock']);
  assert.equal(first.rows[0].status, 'running');
});

test('a hold appearing during guest fixture preparation is honored before clock, kit or collection', async t => {
  const f = setup(t, { rows: ['person-key-before'] });
  const fake = fakeTransport(f, { clock: async () => assert.equal(existsSync(f.options.holdFile), false) });
  const original = fake.transport;
  fake.transport = () => ({ ...original(), settle: async () => { writeFileSync(f.options.holdFile, 'hold'); } });
  fake.pause = async () => { unlinkSync(f.options.holdFile); };
  const result = await runner.runRows(f.options, fake);
  assert.equal(result.completed, true, result.stop);
  assert.equal(result.waits.length, 1);
  assert.equal(result.waits[0].reason, 'hold');
});

test('tampered copied evidence remains unfinished and resumes at that row', async t => {
  const f = setup(t, { rows: ['cancel-frame'] }), fake = fakeTransport(f, { copy: async paths => { writeFileSync(paths.evidenceOut, '{}'); } });
  const result = await runner.runRows(f.options, fake);
  assert.equal(result.completed, false); assert.equal(result.rows[0].status, 'running');
});

test('a product failure keeps its raw log and advances to the next row', async t => {
  const f = setup(t, { rows: ['cancel-frame', 'person-key-before'] });
  const fake = fakeTransport(f, { copy: async paths => {
    if (!paths.rawOut.includes('cancel-frame')) return;
    const raw = JSON.parse(readFileSync(paths.rawOut));
    raw.logs = raw.logs.map(text => text.replace('"code":"RECORDED"', '"code":"IDENTITY_CHANGED"'));
    raw.sha256 = rawArchiveHash(raw);
    const { bundle } = exportRawLogs(raw.logs, revision);
    const bytes = Buffer.from(JSON.stringify(bundle) + '\n');
    writeFileSync(paths.rawOut, JSON.stringify(raw)); writeFileSync(paths.evidenceOut, bytes);
    writeFileSync(paths.attestationOut, JSON.stringify(createAttestation(bytes, f.context)));
  } });
  const result = await runner.runRows(f.options, fake);
  assert.equal(result.completed, true, result.stop);
  assert.deepEqual(fake.rows, ['cancel-frame', 'person-key-before']);
  assert.ok(readFileSync(result.rows[0].attempts[0].rawOut, 'utf8').includes('IDENTITY_CHANGED'));
  assert.ok(result.export.diagnostics.some(d => d.id === 'cancel-frame' && d.code === 'IDENTITY_CHANGED'));
});

test('zero-trial bootstrap refusals stop and legacy finished refusals resume without dropping their evidence', async t => {
  for (const legacyStatus of ['finished', 'evidence-lost']) {
    const f = setup(t, { rows: ['person-key-before', 'cancel-frame'] });
    let broken = true;
    const fake = fakeTransport(f, { copy: async paths => {
      if (!broken) return;
      const raw = JSON.parse(readFileSync(paths.rawOut));
      raw.logs = raw.logs.map(text => {
        const lines = text.trim().split('\n').map(JSON.parse);
        return JSON.stringify(lines[0]) + '\n' + JSON.stringify({ ...lines.at(-1), trials: 0, hookRemoved: false, code: 'HOST_CACHE_UNSAFE' }) + '\n';
      });
      raw.sha256 = rawArchiveHash(raw);
      const { bundle } = exportRawLogs(raw.logs, revision), bytes = Buffer.from(JSON.stringify(bundle) + '\n');
      writeFileSync(paths.rawOut, JSON.stringify(raw)); writeFileSync(paths.evidenceOut, bytes);
      writeFileSync(paths.attestationOut, JSON.stringify(createAttestation(bytes, f.context)));
    } });
    const original = fake.transport;
    fake.transport = () => {
      const base = original();
      return { ...base, row: async (...args) => {
        await base.row(...args);
        return { recorded: true, row: args[0].id, status: broken ? 'fail' : 'recorded', code: broken ? 'HOST_CACHE_UNSAFE' : 'RECORDED' };
      } };
    };
    const first = await runner.runRows(f.options, fake);
    assert.equal(first.completed, false);
    assert.equal(first.stop, 'VM_ROW_FAILED');
    assert.deepEqual(fake.rows, ['person-key-before']);
    assert.equal(first.rows[0].status, 'running');
    const attempt = first.rows[0].attempts[0], preserved = readFileSync(attempt.rawOut);
    // The older runner marked these zero-trial setup refusals as finished.
    first.rows[0].status = legacyStatus;
    if (legacyStatus === 'evidence-lost') first.rows[0].reason = 'VM_EVIDENCE_LOST_AFTER_STOP';
    writeFileSync(join(f.options.bank, 'state.json'), JSON.stringify(first));
    const legacy = join(f.options.bank, 'combined-2-observations.json'), legacyBytes = readFileSync(attempt.evidenceOut);
    writeFileSync(legacy, legacyBytes);
    writeFileSync(join(f.options.bank, 'combined-2-observations.attestation.json'), readFileSync(attempt.attestationOut));
    broken = false;
    const second = await runner.runRows(f.options, fake);
    assert.equal(second.completed, true, second.stop);
    assert.deepEqual(fake.rows, ['person-key-before', 'person-key-before', 'cancel-frame']);
    assert.deepEqual(second.rows.map(row => row.attempts.length), [2, 1]);
    assert.deepEqual(readFileSync(attempt.rawOut), preserved);
    assert.equal(second.export.rows, 2);
    assert.notEqual(second.export.bundle, legacy);
    assert.deepEqual(readFileSync(legacy), legacyBytes);
    await runner.runRows(f.options, fake);
    assert.deepEqual(fake.rows, ['person-key-before', 'person-key-before', 'cancel-frame']);
  }
});

test('production runner and task adapter contain no guest termination or Mac guards', () => {
  const task = readFileSync(new URL('../bench/windows/vm-row-task.ps1', import.meta.url), 'utf8');
  const guest = readFileSync(new URL('../bench/windows/vm-row-guest.mjs', import.meta.url), 'utf8');
  for (const text of [source, task, guest]) assert.doesNotMatch(text, /Stop-Process|Stop-ScheduledTask|taskkill|\.Kill\(|startGuard|sleight-live\.lock|osascript|screencapture|utmctl.*exec/);
  assert.match(source, /-LogonType Interactive -RunLevel Limited/);
  assert.match(task, /CreateNoWindow=\$true/);
});


test('disposable is the default eleven-row plan and its start flag is mode-specific', () => {
  const plan = runner.rowPlan({ vmId: 'test-vm' });
  assert.equal(plan.restoreMode, 'disposable');
  assert.equal(plan.rows.length, 11); assert.ok(plan.rows.every(r => r.id !== 'checkpoint-cost'));
  assert.deepEqual(plan.restore, [['status', 'test-vm'], ['stop', 'test-vm'], ['start', '--disposable', '--hide', 'test-vm']]);
  for (const restoreMode of ['snapshot', 'save-state', 'cold'])
    assert.throws(() => runner.commandPolicy({ restoreMode, vmId: 'test-vm' }, '192.168.64.2', production.UTMCTL,
      ['start', '--disposable', '--hide', 'test-vm'], { timeout: 60000 }), /MAC_COMMAND_REFUSED/);
});

test('disposable skips stop for an already stopped VM and stops only after evidence', async t => {
  for (const status of ['stopped', 'started', 'paused']) {
    const f = setup(t), calls = []; let current = status;
    const transport = runner.createRowTransport({ ...f.options, restoreMode: 'disposable' }, { child: async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'start') current = 'started';
      if (args[0] === 'stop') current = 'stopped';
      return { status: 0, stdout: args[0] === 'status' ? current : '' };
    } });
    await transport.restore();
    assert.deepEqual(calls, [['status', vm.vmId], ...status === 'stopped' ? [] : [['stop', vm.vmId]],
      ...status === 'stopped' ? [] : [['status', vm.vmId]],
      ['start', '--disposable', '--hide', vm.vmId]]);
    await transport.finish(); assert.deepEqual(calls.slice(-3), [['status', vm.vmId], ['stop', vm.vmId], ['status', vm.vmId]]);
    const before = calls.length; await transport.finish();
    assert.deepEqual(calls.slice(before), [['status', vm.vmId]]);
  }
});

test('readiness waits for Sleight session 1 Active and verifies the pinned IPv4', async t => {
  const f = setup(t); let time = 0, probes = 0;
  const transport = runner.createRowTransport(f.options, { now: () => time, pause: async () => { time += 2000; },
    child: async (_cmd, _args, settings) => {
      if (settings.input.includes('WTSQuerySessionInformation')) {
        probes++;
        return { status: 0, stdout: JSON.stringify({ sessionId: 1, user: 'Sleight', state: probes === 1 ? 4 : 0,
          addresses: ['192.168.64.2'] }) + '\nSLEIGHT_GUEST_OK\n' };
      }
      return { status: 0, stdout: 'SLEIGHT_GUEST_OK\n' };
    } });
  const ready = await transport.ready(); assert.equal(probes, 2); assert.equal(ready.sessionId, 1);
  for (const change of [{ user: 'Other' }, { sessionId: 2 }, { state: 4 }]) {
    const bad = runner.createRowTransport(f.options, { now: () => time, pause: async () => { time += 300001; },
      child: async () => ({ status: 0, stdout: JSON.stringify({ sessionId: 1, user: 'Sleight', state: 0,
        addresses: ['192.168.64.2'], ...change }) + '\nSLEIGHT_GUEST_OK\n' }) });
    await assert.rejects(bad.ready(), /VM_SESSION_NOT_READY/);
  }
  const moved = runner.createRowTransport(f.options, { child: async () => ({ status: 0,
    stdout: JSON.stringify({ sessionId: 1, user: 'Sleight', state: 0, addresses: ['192.168.64.3'] }) + '\nSLEIGHT_GUEST_OK\n' }) });
  await assert.rejects(moved.ready(), /VM_ADDRESS_CHANGED/);
});

test('hold is awaited before each unfinished row without guest work during the wait', async t => {
  const f = setup(t, { rows: ['cancel-frame', 'person-key-before'] }), events = [];
  writeFileSync(f.options.holdFile, '');
  const fake = fakeTransport(f, { finish: async () => { writeFileSync(f.options.holdFile, ''); } });
  const result = await runner.runRows(f.options, { ...fake, pause: async ms => {
    assert.equal(ms, 60000); events.push([...fake.rows]); unlinkSync(f.options.holdFile);
  } });
  assert.equal(result.completed, true, result.stop); assert.deepEqual(events, [[], ['cancel-frame']]);
  assert.equal(result.waits.length, 2);
});

for (const code of ['VM_ROW_TIMEOUT', 'VM_ROW_FAILED']) test(`${code} copies partial evidence before stopping and restoring`, async t => {
  const f = setup(t, { rows: ['cancel-frame'] }), events = [];
  let broken = true;
  const fake = fakeTransport(f, { row: async () => { events.push('row'); if (broken) { broken = false; throw Error(code); } },
    capture: async path => { events.push('capture'); assert.equal(readFileSync(join(path, 'partial.jsonl'), 'utf8'), 'partial evidence'); },
    finish: async () => { events.push('stop'); } });
  const first = await runner.runRows(f.options, fake);
  assert.equal(first.stop, code); assert.deepEqual(events, ['row', 'capture', 'stop']);
  assert.equal(first.rows[0].attempts[0].evidencePending, false);
  assert.ok(existsSync(first.rows[0].attempts[0].failureOut));
  assert.equal((await runner.runRows(f.options, fake)).completed, true);
});

test('failed salvage preserves the guest and resume copies evidence before another restore', async t => {
  const f = setup(t, { rows: ['cancel-frame'] }); let captureBroken = true;
  const events = [], fake = fakeTransport(f, { row: async () => { throw Error('VM_ROW_TIMEOUT'); },
    capture: async () => { events.push('capture'); if (captureBroken) throw Error('VM_TRANSPORT_FAILED'); },
    finish: async () => events.push('stop'), restore: async () => events.push('restore') });
  const first = await runner.runRows(f.options, fake); assert.equal(first.rows[0].attempts[0].evidencePending, true);
  assert.deepEqual(events, ['restore', 'capture']);
  captureBroken = false; events.length = 0;
  await runner.runRows(f.options, fake); assert.deepEqual(events.slice(0, 3), ['capture', 'stop', 'restore']);
});

test('resume drains a later pending capture before restoring an earlier unfinished row', async t => {
  const f = setup(t, { rows: ['person-key-before', 'cancel-frame'] }), events = [];
  const fake = fakeTransport(f, { capture: async () => events.push('capture'), restore: async () => events.push('restore') });
  const first = await runner.runRows(f.options, fake);
  first.rows[0].status = 'running';
  first.rows[1].status = 'running';
  Object.assign(first.rows[1].attempts[0], { evidencePending: true,
    receipt: { recorded: true, row: 'cancel-frame', status: 'fail', code: 'MEASUREMENT_UNAVAILABLE' } });
  writeFileSync(join(f.options.bank, 'state.json'), JSON.stringify(first));
  events.length = 0;
  const resumed = await runner.runRows(f.options, fake);
  assert.equal(resumed.completed, true);
  assert.deepEqual(events, ['capture', 'restore']);
  assert.equal(resumed.rows[1].attempts.length, 1);
});

for (const field of ['kit', 'sshConfig', 'vmRecord']) test(`resume refuses changed ${field} with zero row operations`, async t => {
  const f = setup(t, { rows: ['cancel-frame'] }), fake = fakeTransport(f);
  assert.equal((await runner.runRows(f.options, fake)).completed, true);
  if (field === 'kit') {
    writeFileSync(join(f.options.kit, 'bench/windows/vm-row-guest.mjs'), 'changed');
    unlinkSync(join(f.options.kit, 'guest-manifest.json'));
    writeFileSync(join(f.options.kit, 'guest-manifest.json'), JSON.stringify(createManifest(f.options.kit, revision)));
  } else writeFileSync(f.options[field], readFileSync(f.options[field], 'utf8') + '\n');
  const before = [...fake.events];
  await assert.rejects(runner.runRows(f.options, fake), /STATE_IDENTITY_CHANGED/);
  assert.deepEqual(fake.events, before);
});


test('resume retries a failed disposable stop without rerunning the finished row', async t => {
  const f = setup(t, { rows: ['cancel-frame'], restoreMode: 'disposable' }); let failed = false;
  const fake = fakeTransport(f, { finish: async () => { if (!failed) { failed = true; throw Error('VM_RESTORE_FAILED'); } } });
  const first = await runner.runRows(f.options, fake);
  assert.equal(first.completed, false); assert.equal(first.rows[0].status, 'finished');
  assert.equal(first.rows[0].attempts[0].disposePending, true);
  const second = await runner.runRows(f.options, fake);
  assert.equal(second.completed, true); assert.deepEqual(fake.rows, ['cancel-frame']);
  assert.equal(second.rows[0].attempts[0].disposePending, false);
});


test('failure evidence download uses a recursive pinned SCP before any stop', async t => {
  const f = setup(t), calls = [];
  const transport = runner.createRowTransport(f.options, { child: async (command, args) => {
    calls.push({ command, args }); return { status: 0, stdout: 'SLEIGHT_GUEST_OK\n' };
  } });
  const destination = join(f.dir, 'failed-guest');
  await transport.capture('a'.repeat(16), destination);
  assert.equal(calls.length, 2); assert.equal(calls[0].command, '/usr/bin/ssh');
  assert.equal(calls[1].command, '/usr/bin/scp');
  assert.ok(calls[1].args.includes('HostName=192.168.64.2')); assert.ok(calls[1].args.includes('-r'));
  assert.match(calls[1].args.at(-2), /^vm:C:\/sleight-setup\/uc3f-a{16}\/capture-[a-f0-9]{16}\/$/);
  assert.equal(dirname(calls[1].args.at(-1)), destination);
});

test('guest user defaults to the SSH User, validates names and permits a distinct interactive account', async t => {
  const f = setup(t);
  writeFileSync(f.options.sshConfig, 'Host vm\n HostName 192.168.64.2\n User SshAdmin\n');
  assert.equal(runner.rowPlan(f.options).guestUser, 'SshAdmin');
  for (const guestUser of ['', 'x'.repeat(65), 'bad name', "a';anything", 'DOMAIN\\name', 'a\nname', 12, null])
    assert.throws(() => runner.rowPlan({ guestUser }), /GUEST_USER_INVALID/);
  const parsed = runner.parseArgs(['--dry-run', '--guest-user', 'Local.Test-2_']);
  assert.equal(parsed.guestUser, 'Local.Test-2_');
  for (const guestUser of [undefined, 'Local.Test-2_']) {
    const user = guestUser ?? 'SshAdmin', scripts = []; let time = 0;
    const transport = runner.createRowTransport({ ...f.options, guestUser }, { now: () => time, pause: async () => { time += 300001; }, child: async (_cmd, _args, settings) => {
      const script = settings.input ?? ''; scripts.push(script);
      const value = script.includes('WTSQuerySessionInformation') ? { sessionId: 1, user: user.toUpperCase(), state: 0, addresses: ['192.168.64.2'] } :
        script.includes('GetClipboardSequenceNumber') ? { whoami: user, clipboard: { sessionId: 1, station: 'WinSta0', desktop: 'Default', sequence: 0, error: 0 } } :
        script.includes('row-result.json') ? { recorded: true, row: 'cancel-frame' } : '';
      return { status: 0, stdout: (value ? JSON.stringify(value) + '\n' : '') + 'SLEIGHT_GUEST_OK\n' };
    } });
    await transport.ready(); await transport.kit(); await transport.row({ id: 'cancel-frame' }, 'a'.repeat(16)); await transport.probe();
    assert.ok(scripts.some(s => s.includes(`'${user}:RX'`)));
    assert.ok(scripts.some(s => s.includes(`'${user}:(OI)(CI)M'`)));
    assert.ok(scripts.some(s => s.includes(`-UserId '${user}' -LogonType Interactive`)));
    const probe = scripts.find(s => s.includes('GetClipboardSequenceNumber'));
    assert.ok(probe.startsWith(`& {\n$ErrorActionPreference='Stop'\ntry {\n$guestUser='${user}'\n`));
    assert.match(probe, /-UserId \$guestUser/); assert.match(probe, /Environment.UserName/);
    assert.ok(probe.includes('"${guestUser}:(OI)(CI)M"'));
    assert.doesNotMatch(probe, /whoami\.exe|-UserId 'Sleight'/);
  }
  let time = 0;
  const wrong = runner.createRowTransport({ ...f.options, guestUser: 'Local.Test-2_' }, { now: () => time, pause: async () => { time += 300001; },
    child: async () => ({ status: 0, stdout: JSON.stringify({ sessionId: 1, user: 'SshAdmin', state: 0, addresses: ['192.168.64.2'] }) + '\nSLEIGHT_GUEST_OK\n' }) });
  await assert.rejects(wrong.ready(), /VM_SESSION_NOT_READY/);
});

test('resume pins the resolved interactive user and rejects a changed user before operations', async t => {
  const f = setup(t, { rows: ['cancel-frame'], guestUser: 'LocalUser' }), fake = fakeTransport(f);
  assert.equal((await runner.runRows(f.options, fake)).identity.guestUser, 'LocalUser');
  const before = [...fake.events];
  await assert.rejects(runner.runRows({ ...f.options, guestUser: 'OtherUser' }, fake), /STATE_IDENTITY_CHANGED/);
  assert.deepEqual(fake.events, before);
});

test('a failed ready inside runRows stops the disposable VM without a guest operation and retries readiness on resume', async t => {
  const f = setup(t, { rows: ['cancel-frame'], restoreMode: 'disposable' }), events = []; let broken = true;
  const fake = fakeTransport(f, { restore: async () => events.push('restore'), ready: async () => {
    events.push('ready'); if (broken) throw Error('VM_SESSION_NOT_READY');
  }, finish: async () => events.push('stop'), capture: async () => assert.fail('no guest evidence before ready') });
  const first = await runner.runRows(f.options, fake);
  assert.equal(first.stop, 'VM_SESSION_NOT_READY'); assert.deepEqual(events, ['restore', 'ready', 'stop']);
  assert.deepEqual(fake.events, ['restore', 'ready']); assert.deepEqual(fake.rows, []);
  broken = false; events.length = 0;
  const second = await runner.runRows(f.options, fake);
  assert.equal(second.completed, true, second.stop); assert.deepEqual(events, ['restore', 'ready', 'stop']);
  assert.equal(second.rows[0].attempts.length, 2);
});

test('resume excludes lost disposable evidence with its reason and never repeats that row or a finished row', async t => {
  const f = setup(t, { rows: ['person-key-before', 'cancel-frame', 'person-key-during'], restoreMode: 'disposable' });
  let lost = false;
  const fake = fakeTransport(f, { row: async row => { if (row.id === 'cancel-frame') { lost = true; throw Error('VM_ROW_TIMEOUT'); } },
    capture: async () => { throw Error('VM_TRANSPORT_FAILED'); }, status: async () => 'stopped' });
  const first = await runner.runRows(f.options, fake);
  assert.equal(first.stop, 'VM_ROW_TIMEOUT'); assert.equal(lost, true); assert.equal(first.rows[1].attempts[0].evidencePending, true);
  const second = await runner.runRows(f.options, fake);
  assert.equal(second.completed, true, second.stop);
  assert.deepEqual(second.rows.map(r => r.status), ['finished', 'evidence-lost', 'finished']);
  assert.equal(second.rows[1].reason, 'VM_EVIDENCE_LOST_AFTER_STOP');
  assert.equal(second.rows[1].attempts[0].copyFailure, 'VM_EVIDENCE_COPY_FAILED');
  assert.equal(second.rows[1].attempts[0].evidencePending, false);
  assert.deepEqual(fake.rows, ['person-key-before', 'cancel-frame', 'person-key-during']);
  assert.deepEqual(second.rows.map(r => r.attempts.length), [1, 1, 1]);
  assert.equal((await runner.runRows(f.options, fake)).completed, true);
  assert.deepEqual(fake.rows, ['person-key-before', 'cancel-frame', 'person-key-during']);
});

test('owner return during the real transport row still copies all evidence and confirms stopped before the next row', async t => {
  const f = setup(t, { rows: ['cancel-frame', 'person-key-before'], restoreMode: 'disposable' }), calls = [];
  let downloads, current = 'stopped';
  const result = await runner.runRows(f.options, { lock: process.platform === 'darwin' ? f.lock : () => () => {}, child: async (command, args, settings) => {
    calls.push({ command, args, script: settings.input });
    if (command === production.UTMCTL) {
      if (args[0] === 'start') current = 'started'; if (args[0] === 'stop') current = 'stopped';
      return { status: 0, stdout: args[0] === 'status' ? current : '' };
    }
    if (command === '/usr/bin/ssh') {
      let value = settings.input.includes('WTSQuerySessionInformation') ? { sessionId: 1, user: 'Sleight', state: 0, addresses: ['192.168.64.2'] } : null;
      if (settings.input.includes('row-result.json')) {
        downloads = await rawFor('cancel-frame', f.context); unlinkSync(f.options.ownerAwayFile);
        value = { recorded: true, row: 'cancel-frame' };
      }
      return { status: 0, stdout: (value ? JSON.stringify(value) + '\n' : '') + 'SLEIGHT_GUEST_OK\n' };
    }
    if (args.at(-2).startsWith('vm:')) {
      const name = args.at(-2), bytes = name.endsWith('uc3f-row-raw.json') ? JSON.stringify(downloads.raw) :
        name.endsWith('uc3f-observations.attestation.json') ? JSON.stringify(downloads.attestation) : downloads.bytes;
      writeFileSync(args.at(-1), bytes);
    }
    return { status: 0, stdout: '' };
  } });
  assert.equal(result.stop, 'OWNER_AWAY_REQUIRED'); assert.equal(result.rows[0].status, 'finished');
  assert.equal(result.rows[1].status, 'pending'); assert.equal(result.rows[0].attempts[0].evidencePending, false);
  assert.equal(calls.filter(c => c.command === '/usr/bin/scp' && c.args.at(-2).startsWith('vm:')).length, 3);
  assert.deepEqual(calls.slice(-3).map(c => c.args), [['status', vm.vmId], ['stop', vm.vmId], ['status', vm.vmId]]);
  assert.equal(current, 'stopped'); assert.equal(calls.filter(c => c.args[0] === 'start').length, 1);
});

test('a returned owner still permits partial evidence salvage and shutdown after a row error', async t => {
  const f = setup(t, { restoreMode: 'disposable' }), calls = []; let away = true, current = 'started';
  const transport = runner.createRowTransport(f.options, { check: () => { if (!away) throw Error('OWNER_AWAY_REQUIRED'); },
    child: async (command, args) => {
      calls.push({ command, args }); if (args[0] === 'stop') current = 'stopped';
      return { status: 0, stdout: args[0] === 'status' ? current : 'SLEIGHT_GUEST_OK\n' };
    } });
  away = false;
  await transport.capture('a'.repeat(16), join(f.dir, 'partial')); await transport.finish();
  assert.equal(calls[0].command, '/usr/bin/ssh'); assert.equal(calls[1].command, '/usr/bin/scp'); assert.equal(current, 'stopped');
  const before = calls.length;
  await assert.rejects(transport.restore(), /OWNER_AWAY_REQUIRED/);
  assert.ok(calls.slice(before).every(c => c.args[0] === 'status'));
});

test('owner return abandons an unavailable copy with a reason and still stops the VM', async t => {
  const f = setup(t, { rows: ['cancel-frame', 'person-key-before'], restoreMode: 'disposable' }), events = [];
  const fake = fakeTransport(f, { row: async () => { unlinkSync(f.options.ownerAwayFile); throw Error('OWNER_AWAY_REQUIRED'); },
    capture: async () => { events.push('capture'); throw Error('VM_TRANSPORT_FAILED'); }, finish: async () => events.push('stop') });
  const first = await runner.runRows(f.options, fake);
  assert.equal(first.stop, 'OWNER_AWAY_REQUIRED'); assert.deepEqual(events, ['capture', 'stop']);
  assert.equal(first.rows[0].status, 'evidence-lost'); assert.equal(first.rows[0].reason, 'VM_EVIDENCE_COPY_FAILED_ON_OWNER_RETURN');
  assert.equal(first.rows[0].attempts[0].copyFailure, 'VM_EVIDENCE_COPY_FAILED');
  assert.equal(first.rows[0].attempts[0].evidencePending, false); assert.equal(first.rows[1].status, 'pending');
});

test('stop accepts transitional states and polls to stopped before starting the next disposable VM', async t => {
  const f = setup(t); let time = 0;
  for (const initial of ['started', 'starting', 'paused', 'pausing', 'resuming', 'stopping']) {
    const statuses = [initial, 'stopping', 'stopping', 'stopped'], calls = [];
    const transport = runner.createRowTransport({ ...f.options, restoreMode: 'disposable' }, { now: () => time, pause: async ms => { assert.equal(ms, 1000); time += ms; },
      child: async (_cmd, args) => { calls.push(args); return { status: 0, stdout: args[0] === 'status' ? statuses.shift() : '' }; } });
    await transport.restore(); assert.equal(statuses.length, 0);
    assert.equal(calls.filter(a => a[0] === 'stop').length, initial === 'stopping' ? 0 : 1);
    assert.deepEqual(calls.at(-1), ['start', '--disposable', '--hide', vm.vmId]);
  }
  time = 0; const calls = [];
  const stuck = runner.createRowTransport({ ...f.options, restoreMode: 'disposable' }, { now: () => time, pause: async ms => { time += ms; },
    child: async (_cmd, args) => { calls.push(args); return { status: 0, stdout: args[0] === 'status' ? 'stopping' : '' }; } });
  await assert.rejects(stuck.restore(), /VM_STOP_TIMEOUT/); assert.equal(time, 30000);
  assert.ok(calls.every(a => a[0] === 'status'));
});
