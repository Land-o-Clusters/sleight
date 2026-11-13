import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { guestTransport } from '../bench/windows/rt31-sitting.mjs';
import {
  main, parseArgs, vmPlan, verifyNetwork, verifyGuest, runUC3FSitting, createUC3FBackend, promptOwner,
} from '../bench/windows/uc3f-sitting.mjs';
import { VM_RECORD_PROVENANCE } from '../bench/windows/uc3f-rows.mjs';

const sourceURL = new URL('../bench/windows/uc3f-sitting.mjs', import.meta.url);
for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) {
  test(`owner prompt refuses ${key} before touching the terminal`, async () => {
    const stdin = { get isTTY() { throw Error('AGENT_REACHED_TTY_CHECK'); } };
    await assert.rejects(promptOwner({ id: 'present-block' }, {
      env: { [key]: '1' }, stdin, stdout: { isTTY: true },
    }), /LOCAL_OWNER_TTY_REQUIRED/);
  });
}

const identity = {
  schema: 'sleight.uc3f-vm-record/1', hostName: '192.168.64.8', provenance: VM_RECORD_PROVENANCE,
  vmId: 'fixture-vm', manufacturer: 'QEMU', model: 'Virtual Machine', build: 26200,
  hostnameSha256: 'a'.repeat(64), machineGuidSha256: 'b'.repeat(64),
};
const config = 'Host vm\n  HostName 192.168.64.8\n  User Sleight\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n';
const options = {
  ownerAway: true, ownerAwayFile: '/fixture/owner-away', rows: ['person-key-before'], host: 'vm', sshConfig: '/fixture/config',
  tools: '/fixture/tools', vmId: 'fixture-vm', vmRecord: '/fixture/vm.json',
  out: '/fixture/report.json', evidenceOut: '/fixture/evidence.json', attestationOut: '/fixture/attestation.json',
};

test('the console account can differ from the SSH account and rejects shell syntax', async () => {
  assert.equal(parseArgs(['--owner-present', '--guest-user', 'sleight-test']).guestUser, 'sleight-test');
  assert.equal(parseArgs(['--owner-present']).guestUser, 'Sleight');
  for (const user of ['', "Sleight';exit", 'space user', '../Sleight', 'x'.repeat(65)])
    assert.throws(() => parseArgs(['--owner-present', '--guest-user', user]));
  let received;
  const r = rig();
  const factory = r.dependencies.guestTransport;
  r.dependencies.guestTransport = (o, deps) => { received = o.guestUser; return factory(o, deps); };
  await runUC3FSitting({ ...options, guestUser: 'sleight-test' }, r.dependencies);
  assert.equal(received, 'sleight-test');
});

async function mutant(before, after) {
  let source = readFileSync(sourceURL, 'utf8');
  assert.ok(source.includes(before), 'mutation site exists');
  source = source.replace(before, after).replace(/from '(\.\.?\/[^']+)'/g, (_all, path) => `from '${new URL(path, sourceURL).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(sourceURL.href));
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

async function childBoundary(create = createUC3FBackend) {
  const children = []; let child, text = config;
  const backend = await create(options, {
    platform: 'darwin', env: { CLAUDE_CONFIG_DIR: '/fixture/isolated' }, exists: () => true,
    readFile: path => path === options.sshConfig ? text : JSON.stringify(identity),
    // Wrap the real dispatcher, without replacing its transport implementation.
    guestTransport: (o, helpers) => { child = helpers.runChild; return guestTransport(o, helpers); },
    runChild: async (command, args, settings) => { children.push({ command, args, settings }); return { status: 0, stdout: '' }; },
  });
  return { child, children, backend, setConfig(value) { text = value; } };
}

const ssh = ['-F', options.sshConfig, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'vm', 'powershell -NoProfile -NonInteractive -Command -'];
const scp = ['-q', '-F', options.sshConfig, '-o', 'BatchMode=yes', 'vm:fixed', '/fixture/evidence.json'];
async function argvAudit(create) {
  const r = await childBoundary(create);
  try {
    await r.child('/usr/bin/ssh', ssh, { timeout: 1000 });
    await r.child('/usr/bin/scp', scp, { timeout: 1000 });
    await r.child('/usr/bin/scp', [...scp.slice(0, -2), ...scp.slice(-2).reverse()], { timeout: 1000 });
    for (const extra of [['-o', 'Hostname=10.0.0.5'], ['-o', 'ProxyCommand=anything'], ['-L', '1234:localhost:1234']])
      await assert.rejects(r.child('/usr/bin/ssh', [...ssh.slice(0, -2), ...extra, ...ssh.slice(-2)], { timeout: 1000 }), /MAC_COMMAND_REFUSED/);
    await assert.rejects(r.child('/usr/bin/ssh', [...ssh, '-o', 'ProxyCommand=anything'], { timeout: 1000 }), /MAC_COMMAND_REFUSED/);
    for (const remote of ['vm:$(anything)', 'other:fixed', 'vm:with space', 'vm:with\nnewline'])
      await assert.rejects(r.child('/usr/bin/scp', [...scp.slice(0, -2), remote, scp.at(-1)], { timeout: 1000 }), /MAC_COMMAND_REFUSED/);
    await assert.rejects(r.child('/usr/bin/open', scp, { timeout: 1000 }), /MAC_COMMAND_REFUSED/);
    for (const timeout of [undefined, 0, -1, 60001, 1.5])
      await assert.rejects(r.child('/usr/bin/ssh', ssh, { timeout }), /MAC_COMMAND_REFUSED/);
    assert.equal(r.children.length, 3);
    for (const { args } of r.children)
      for (const pin of ['HostName=192.168.64.8', 'ProxyCommand=none', 'ProxyJump=none', 'PermitLocalCommand=no',
        'ClearAllForwardings=yes', 'RemoteCommand=none', 'StrictHostKeyChecking=yes']) assert.ok(args.includes(pin), pin);
  } finally { await r.backend.close(); }
}
test('real child path pins ssh/scp argv and rejects redirection before a child starts', async () => {
  await argvAudit(createUC3FBackend);
  for (const [before, after] of [
    ["if (!['/usr/bin/ssh', '/usr/bin/scp'].includes(command))", 'if (false)'],
    ['args.length !== prefix.length + 2', 'false'],
    ["/^vm:[A-Za-z0-9/:._-]+$/.test(arg)", 'arg.startsWith("vm:")'],
    ["'ProxyCommand=none'", "'ProxyCommand=anything'"],
  ]) {
    const broken = await mutant(before, after);
    await assert.rejects(argvAudit(broken.createUC3FBackend), assert.AssertionError);
  }
});
test('real child path rechecks the pinned VM endpoint after construction', async () => {
  const audit = async create => {
    const r = await childBoundary(create);
    try {
      r.setConfig(config.replace('192.168.64.8', '192.168.64.9'));
      await assert.rejects(r.child('/usr/bin/ssh', ssh, { timeout: 1000 }), /NOT_VM_NETWORK/);
      r.setConfig(config.replace('192.168.64.8', '10.0.0.8'));
      await assert.rejects(r.child('/usr/bin/scp', scp, { timeout: 1000 }), /NOT_VM_NETWORK/);
      assert.equal(r.children.length, 0);
    } finally { await r.backend.close(); }
  };
  await audit(createUC3FBackend);
  const broken = await mutant("if (verifyNetwork(read(options.sshConfig), options.host) !== hostName)", 'if (false)');
  await assert.rejects(audit(broken.createUC3FBackend), assert.AssertionError);
});

function rig() {
  const calls = [];
  let away = true;
  const dependencies = {
    platform: 'darwin', env: { CLAUDE_CONFIG_DIR: '/fixture/isolated' }, exists: () => away,
    readFile: path => path.endsWith('.json') ? JSON.stringify(identity) : config,
    prompt: async row => { calls.push('prompt:' + row.id); return 'go'; },
    guestTransport: async (_o, helpers) => ({
      protocol: 'sleight.uc3f-transport/1',
      async call(op, payload) {
        await helpers.check(); calls.push(op);
        if (op === 'preflight') return { ...identity, sessionId: 1, elevated: false };
        if (op === 'row') return { row: payload.row.id, collected: true, hookRemoved: true };
        if (op === 'export') return { exported: true };
        assert.fail(op);
      },
      async copyEvidence() { calls.push('copy'); return { confirmed: true }; },
    }),
  };
  return { dependencies, calls, returnOwner() { away = false; } };
}

test('away sitting has no Mac guard, shared lock, wall-clock preflight or lease calls', async () => {
  const r = rig(), result = await runUC3FSitting(options, r.dependencies);
  assert.equal(result.completed, true);
  assert.deepEqual(r.calls, ['preflight', 'row', 'export', 'copy']);
  const source = readFileSync(sourceURL, 'utf8');
  assert.doesNotMatch(source, /startGuard|acquireLiveLock|liveLockRetained|GUEST_CLOCK_SKEW|lease.json/);
});
test('away check is mandatory and repeated before work', async () => {
  const r = rig(), backend = await createUC3FBackend(options, r.dependencies);
  await backend.start(); r.returnOwner();
  await assert.rejects(backend.row({ id: 'person-key-before', presence: 'away' }), /OWNER_AWAY_ENDED/);
  assert.deepEqual(r.calls, ['preflight']);
  await assert.rejects(createUC3FBackend({ ...options, ownerAwayFile: undefined }, r.dependencies), /OWNER_AWAY_ENDED/);
});
test('present sitting keeps the owner block and row prompts', async () => {
  const r = rig();
  const result = await runUC3FSitting({ ...options, ownerAway: false, ownerPresent: true, rows: ['lock-during-type'] }, r.dependencies);
  assert.equal(result.completed, true);
  assert.deepEqual(r.calls, ['prompt:present-block', 'preflight', 'prompt:lock-during-type', 'row', 'export', 'copy']);
});
test('plan retains 19 rows and splits person-idle between away and present', () => {
  const away = vmPlan({ ownerAway: true }), present = vmPlan({ ownerPresent: true });
  assert.equal(new Set([...away.rows, ...present.rows].map(r => r.id)).size, 19);
  assert.deepEqual(away.rows[0].cases, ['notepad', 'wpf', 'calculator-refused']);
  assert.deepEqual(present.rows[0].cases, ['background-word']);
  assert.equal(away.rows.find(r => r.id === 'checkpoint-cost').skip, 'NO_NOISE_CONSTANT');
  assert.throws(() => vmPlan({ ownerAway: true, rows: ['lock-refused'] }), /OWNER_PRESENT_REQUIRED/);
});
test('SSH validator keeps subnet, exact alias, strict keys and no executable config directives', () => {
  assert.equal(verifyNetwork(config), '192.168.64.8');
  for (const text of [config.replace('192.168.64.8', '10.0.0.8'), config.replace('Host vm', 'Host *'),
    config + 'ProxyCommand true\n', config + 'Include other\n', config.replace('yes', 'accept-new')]) assert.throws(() => verifyNetwork(text));
  assert.throws(() => verifyNetwork(config, 'other'), /VM_ALIAS_REQUIRED/);
});
test('guest identity binds all pinned fields and refuses elevated or session-zero replies', () => {
  const current = { ...identity, sessionId: 1, elevated: false };
  assert.doesNotThrow(() => verifyGuest(current, identity, identity.vmId));
  for (const patch of [{ hostnameSha256: 'c'.repeat(64) }, { machineGuidSha256: 'c'.repeat(64) }, { build: 1 }, { elevated: true }, { sessionId: 0 }])
    assert.throws(() => verifyGuest({ ...current, ...patch }, identity, identity.vmId));
});
test('dry run writes no files and starts no processes', async () => {
  let printed = '';
  const result = await main(['--dry-run', '--owner-away'], { print: s => { printed += s; }, runChild() { assert.fail(); } });
  assert.equal(result.dryRun, true); assert.equal(JSON.parse(printed).rows.length, 12);
  assert.throws(() => parseArgs(['--owner-away', '--install-kit', 'old']), /INVALID_OPTION/);
});
test('interruptions stop before a row and remove all signal handlers', async () => {
  const r = rig(), signals = new EventEmitter(), original = r.dependencies.guestTransport;
  r.dependencies.guestTransport = async (...args) => {
    const t = await original(...args), call = t.call;
    t.call = async (...args) => { const value = await call(...args); if (args[0] === 'preflight') signals.emit('SIGINT'); return value; };
    return t;
  };
  const report = await runUC3FSitting(options, { ...r.dependencies, signals });
  assert.equal(report.completed, false); assert.equal(report.stop, 'SIGINT');
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(signal), 0);
});
