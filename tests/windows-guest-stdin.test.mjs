import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guestTransport } from '../bench/windows/rt31-sitting.mjs';
import { uc3fTransport } from '../bench/windows/uc3f-transport.mjs';
import { createUC3FBackend } from '../bench/windows/uc3f-sitting.mjs';
import { UC3F_PROTOCOL, VM_RECORD_PROVENANCE } from '../bench/windows/uc3f-rows.mjs';

const options = { host: 'vm', sshConfig: '/fixture/config', guestRoot: 'C:\\sleight', guestUser: 'Sleight',
  vmId: 'fixture-vm', presence: 'away' };
const marker = 'SLEIGHT_GUEST_OK\n';
const transports = [
  ['RT31', guestTransport, new URL('../bench/windows/rt31-sitting.mjs', import.meta.url)],
  ['UC3F', uc3fTransport, new URL('../bench/windows/uc3f-transport.mjs', import.meta.url)],
];
async function mutant(url, before, after) {
  const source = readFileSync(url, 'utf8');
  assert.equal(source.split(before).length, 2, 'mutation has exactly one target');
  const changed = source.replace(before, after).replace(/from '(\.\.?\/[^']+)'/g,
    (_all, path) => `from '${new URL(path, url).href}'`).replaceAll('import.meta.url', JSON.stringify(url.href));
  return import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}
async function setup(make, kind, runChild) {
  const transport = await make(options, { runChild, noHold() {}, check: async () => {} });
  const call = () => transport.call(kind === 'RT31' ? 'setup' : 'preflight', { expected: {} });
  return { transport, call };
}
function replies(kind, inspect = () => {}) {
  let request;
  return async (command, args, settings) => {
    if (command === '/usr/bin/scp') return { status: 0, stdout: '' };
    inspect(settings.input, args);
    let payload = '';
    if (kind === 'RT31' && settings.input.includes('Register-ScheduledTask')) payload = '{"fixture":true,"driverRead":true}\n';
    if (kind === 'UC3F') {
      // The task host is compiled before any scheduled task. An empty build reply is not a guest result.
      if (settings.input.includes('transport-host.json')) payload = JSON.stringify({ sha256: 'b'.repeat(64), sourceSha256: 'a'.repeat(64) }) + '\n';
      if (settings.input.includes('Register-ScheduledTask -TaskName')) {
        request = JSON.parse(Buffer.from(/FromBase64String\('([^']+)'\)/.exec(settings.input)[1], 'base64'));
      }
      if (settings.input.includes('$rc=Join-Path')) payload = JSON.stringify({ rc: '0', result: { ...request, value: { confirmed: true } } }) + '\n';
    }
    return { status: 0, stdout: payload + marker };
  };
}
async function auditBlankLine(make, kind) {
  let scripts = 0;
  const { call } = await setup(make, kind, replies(kind, (input, args) => {
    scripts++;
    assert.equal(args.at(-1), 'powershell -NoProfile -NonInteractive -Command -');
    assert.ok(input.endsWith('\n\n'), 'PowerShell stdin needs a final blank line');
    assert.match(input, /\n\[Console\]::Out\.WriteLine\('SLEIGHT_GUEST_OK'\)\n} catch/);
  }));
  await call();
  assert.equal(scripts, kind === 'RT31' ? 2 : 4);
}
async function auditSilent(make, kind) {
  const calls = [];
  const { call } = await setup(make, kind, async command => {
    calls.push(command); return { status: 0, stdout: '' };
  });
  await assert.rejects(call(), /^Error: GUEST_COMMAND_NOT_RUN$/);
  assert.deepEqual(calls, ['/usr/bin/ssh']);
}
for (const [kind, make, url] of transports) {
  test(`${kind} rejects the missing-blank-line broken variant`, async t => {
    await auditBlankLine(make, kind);
    const needle = kind === 'RT31' ? '\\n}\\n\\n`' : "WriteLine('UC3F_GUEST_REFUSED'); exit 1 }\\n}\\n\\n`";
    const broken = await mutant(url, needle, needle.replace('\\n\\n`', '\\n`'));
    await assert.rejects(auditBlankLine(broken[kind === 'RT31' ? 'guestTransport' : 'uc3fTransport'], kind), assert.AssertionError);
    t.diagnostic(`${kind}: missing final blank line fails the stdin framing assertion.`);
  });
  test(`${kind} rejects the missing-completion-check broken variant`, async t => {
    await auditSilent(make, kind);
    const broken = await mutant(url, 'return guestCommandOutput(r.stdout);', 'return r.stdout.trim();');
    await assert.rejects(auditSilent(broken[kind === 'RT31' ? 'guestTransport' : 'uc3fTransport'], kind), assert.AssertionError);
    t.diagnostic(`${kind}: missing completion check fails the zero-exit silent SSH refusal assertion.`);
  });
  test(`${kind} requires a complete final marker line and preserves transport failures`, async () => {
    for (const stdout of ['{}\n', 'prefixSLEIGHT_GUEST_OK\n', 'SLEIGHT_GUEST_OKsuffix\n', 'SLEIGHT_GUEST_OK\ntrailing\n']) {
      const { call } = await setup(make, kind, async () => ({ status: 0, stdout }));
      await assert.rejects(call(), /^Error: GUEST_COMMAND_NOT_RUN$/);
    }
    for (const failure of [{ status: 1 }, { status: 0, signal: 'SIGTERM' }, { status: 0, reason: 'CHILD_TIMEOUT' }]) {
      const { call } = await setup(make, kind, async () => ({ stdout: marker, ...failure }));
      await assert.rejects(call(), /^Error: GUEST_TRANSPORT_FAILED$/);
    }
  });
  test(`${kind} detects silent non-execution after the guest bank was staged`, async () => {
    const child = replies(kind);
    const { call, transport } = await setup(make, kind, async (command, args, settings) => {
      if (settings.input?.includes('Register-ScheduledTask -TaskName')) return { status: 0, stdout: '' };
      return child(command, args, settings);
    });
    await assert.rejects(call(), /^Error: GUEST_COMMAND_NOT_RUN$/);
    if (kind === 'RT31') assert.equal(transport.cleanupConfirmed, false);
  });
}

test('UC3F sitting SSH argv guard accepts the framed stdin call and preserves network pins', async () => {
  const identity = { schema: 'sleight.uc3f-vm-record/1', hostName: '192.168.64.8', provenance: VM_RECORD_PROVENANCE,
    vmId: options.vmId, manufacturer: 'QEMU', model: 'Virtual Machine', build: 26200,
    hostnameSha256: 'a'.repeat(64), machineGuidSha256: 'b'.repeat(64) };
  let calls = 0;
  await assert.rejects(createUC3FBackend({ ...options, ownerAway: true, ownerAwayFile: '/fixture/owner-away', vmRecord: '/fixture/vm.json' }, {
    platform: 'darwin', env: { CLAUDE_CONFIG_DIR: '/fixture' }, exists: () => true,
    readFile: path => path === options.sshConfig ? 'Host vm\n HostName 192.168.64.8\n' : JSON.stringify(identity),
    guestTransport: async (o, deps) => {
      await (await uc3fTransport(o, deps)).call('preflight', { expected: identity });
      throw Error('UNEXPECTED_COMPLETION');
    },
    runChild: async (command, args, settings) => {
      calls++;
      assert.equal(command, '/usr/bin/ssh');
      assert.deepEqual(args.slice(-2), ['vm', 'powershell -NoProfile -NonInteractive -Command -']);
      for (const value of ['HostName=192.168.64.8', 'ProxyCommand=none', 'ProxyJump=none', 'StrictHostKeyChecking=yes']) assert.ok(args.includes(value));
      assert.ok(settings.input.endsWith('\n\n'));
      return { status: 0, stdout: '' };
    },
  }), /^Error: GUEST_COMMAND_NOT_RUN$/);
  assert.equal(calls, 1);
});
