import test from 'node:test';
import assert from 'node:assert/strict';
import { guestTransport } from '../bench/windows/rt31-sitting.mjs';
import { readGuestFixture, discoverGuestFixture } from '../bench/windows/rt31-guest-read.mjs';
import { sessionApproval, WITNESS } from '../bench/runtime-owner-away.mjs';
import { benchmarkDecision } from '../bench/approve.mjs';
import { sittingCommand, checkJSONOutput } from '../bench/sitting-process.mjs';
import { mkdtempSync, realpathSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const guestOptions = { sshConfig: '/fixture/ssh_config', host: 'vm', guestRoot: 'C:\\sleight', guestUser: 'Sleight' };
test('RT31 PowerShell stdin ends with a blank line and a completion marker', async () => {
  let calls = 0;
  const g = await guestTransport(guestOptions, { runChild: async (command, args, options) => {
    if (command === '/usr/bin/scp') return { status: 0, stdout: '' };
    calls++;
    assert.equal(args.at(-1), 'powershell -NoProfile -NonInteractive -Command -');
    assert.ok(options.input.endsWith('\n\n'), 'PowerShell stdin needs a final blank line');
    assert.match(options.input, /\[Console\]::Out\.WriteLine\('SLEIGHT_GUEST_OK'\)/);
    const payload = options.input.includes('Register-ScheduledTask') ? '{"fixture":true,"driverRead":true}\r\n' : '';
    return { status: 0, stdout: '\uFEFF' + payload + 'SLEIGHT_GUEST_OK\r\n' };
  } });
  assert.deepEqual(await g.call('setup'), { fixture: true, driverRead: true });
  assert.equal(calls, 2);
});
test('RT31 refuses a zero-exit ssh child without a completion marker before copying', async () => {
  const calls = [];
  const g = await guestTransport(guestOptions, { runChild: async command => {
    calls.push(command); return { status: 0, stdout: '' };
  } });
  await assert.rejects(g.call('setup'), /^Error: GUEST_COMMAND_NOT_RUN$/);
  assert.deepEqual(calls, ['/usr/bin/ssh']);
});

test('guest operations use unique interactive limited scheduled tasks without replay or live transport', async () => {
  const calls = [];
  const g = await guestTransport({ sshConfig: '/fixture/ssh_config', host: 'vm', guestRoot: 'C:\\sleight', guestUser: 'Sleight' }, {
    runChild: async (command, args, options) => { calls.push({ command, args, options }); return {
      status: 0, stdout: options.input ? (options.input.includes('Register-ScheduledTask') ? JSON.stringify({ fixture: true, driverRead: true }) + '\n' : '') + 'SLEIGHT_GUEST_OK\n' : '',
    }; },
  });
  for (const operation of ['setup', 'read', 'read', 'restore', 'close']) await g.call(operation);
  const tasks = calls.filter(c => c.options.input?.includes('Register-ScheduledTask'));
  assert.equal(tasks.length, 5);
  const mkdir = calls.find(c => c.options.input?.includes('New-Item -ItemType Directory'));
  const bank = /-Path '([^']+)'/.exec(mkdir.options.input)[1];
  assert.match(bank, /^C:\\sleight-setup\\rt31-[a-f0-9]{16}$/);
  assert.equal(new Set(tasks.map(c => /\$task='([^']+)'/.exec(c.options.input)[1])).size, 5);
  for (const { command, args, options } of tasks) {
    assert.equal(command, '/usr/bin/ssh'); assert.ok(args.includes('BatchMode=yes'));
    assert.match(options.input, /-LogonType Interactive -RunLevel Limited/);
    assert.match(options.input, /Unregister-ScheduledTask/);
    assert.ok(options.input.indexOf('Unregister-ScheduledTask') < options.input.indexOf('Write-Output $payload'));
    assert.match(options.input, /exit 1/);
    assert.match(options.input, /GUEST_TASK_CLEANUP_UNCONFIRMED/);
    assert.doesNotMatch(options.input, /-Force|SendInput|Set-ItemProperty/);
  }
  assert.equal(calls.filter(c => c.command === '/usr/bin/scp').length, 2);
  assert.equal(g.cleanupConfirmed, true);
});
test('uncertain scheduled-task collection stays unconfirmed', async () => {
  const g = await guestTransport({ sshConfig: '/fixture/config', host: 'vm', guestRoot: 'C:\\sleight', guestUser: 'Sleight' }, {
    runChild: async (_c, _a, o) => ({ status: o.input?.includes('Register-ScheduledTask') ? 1 : 0, stdout: 'SLEIGHT_GUEST_OK\n' }),
  });
  await assert.rejects(g.call('setup'), /GUEST_TRANSPORT_FAILED/);
  assert.equal(g.cleanupConfirmed, false);
  await assert.rejects(g.call('close'), /GUEST_TASK_CLEANUP_UNCONFIRMED/);
});
test('scheduled fixture failures preserve a fixed reason after task collection', async () => {
  const g = await guestTransport({ sshConfig: '/fixture/config', host: 'vm', guestRoot: 'C:\\sleight', guestUser: 'Sleight' }, {
    runChild: async (_c, _a, o) => ({ status: 0, stdout: (o.input?.includes('Register-ScheduledTask') ? JSON.stringify({ fixture: false, error: 'GUEST_NOTEPAD_NOT_FRONTMOST' }) + '\n' : '') + 'SLEIGHT_GUEST_OK\n' }),
  });
  await assert.rejects(g.call('setup'), /GUEST_NOTEPAD_NOT_FRONTMOST/);
  assert.equal(g.cleanupConfirmed, true);
});
function driver(patch = {}) {
  const calls = [], w = { windowId: '42', processStart: 'start', image: 'C:\\Windows\\notepad.exe', title: 'SIT1-fixed.txt' };
  return { calls, createClient: () => ({ async request(method, params) {
    calls.push({ method, params });
    if (method === 'getState') return { windows: [{ ...w, ...patch }] };
    return { window: w, text: 'Window: SIT1-fixed.txt\n1 text entry area 0123456789', readId: 1, truncated: false };
  }, async close() { calls.push({ method: 'close' }); } }) };
}
test('existing guest driver discovers and reads one fixture without input or screenshots', async () => {
  const d = driver();
  const state = await discoverGuestFixture({ token: 'SIT1-fixed', createClient: d.createClient });
  const r = await readGuestFixture({ state, createClient: d.createClient });
  assert.equal(r.driverRead, true);
  assert.deepEqual(d.calls.map(c => c.method), ['getState', 'close', 'getState', 'getAXState', 'close']);
  assert.deepEqual(d.calls[3].params, { windowId: '42', processStart: 'start' });
  for (const patch of [{ processStart: 'reused' }, { windowId: '43' }, { image: 'other.exe' }]) {
    const bad = driver(patch);
    await assert.rejects(readGuestFixture({ state, createClient: bad.createClient }), /NOTEPAD_NOT_FIXTURE/);
    assert.equal(bad.calls.at(-1).method, 'close');
  }
});
test('benchmark approval accepts exact RT25 identity and never the persistent choice', () => {
  for (const app of [WITNESS.name, WITNESS.bundle]) {
    const params = { message: `Allow Computer Use to use "${app}"?`, requestedSchema: { properties: { choice: { enum: ['once', 'session', 'always'] } } } };
    const actual = benchmarkDecision({ ...params, mcp_server_name: 'plugin:sleight:computer', requested_schema: params.requestedSchema }, { BENCH_SUITE: 'real' });
    assert.deepEqual(actual.hookSpecificOutput.content, { choice: 'session' });
    assert.deepEqual(sessionApproval(params).content, { choice: 'session' });
  }
});
test('printed live command preserves actual arguments and quotes shell metacharacters', () => {
  assert.equal(sittingCommand('bench/windows/rt31-sitting.mjs', ['--owner-away', '--dry-run', '--out', '/tmp/a b$(x).json']),
    "CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/windows/rt31-sitting.mjs --owner-away --out '/tmp/a b$(x).json'");
});
test('output preflight refuses existing files and symlinked parents before a sitting', () => {
  const bank = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sitting-output-test-'))));
  try {
    const out = join(bank, 'out.json'); assert.equal(checkJSONOutput(out), out);
    writeFileSync(out, 'fixture'); assert.throws(() => checkJSONOutput(out), /OUTPUT_EXISTS/);
    symlinkSync(bank, join(bank, 'linked')); assert.throws(() => checkJSONOutput(join(bank, 'linked', 'fresh.json')), /OUTPUT_UNSAFE/);
  } finally { rmSync(bank, { recursive: true, force: true }); }
});
