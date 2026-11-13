import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { runOwnedCommand, parseLinuxReceipt } from '../scripts/linux-preflight.mjs';

const modulePath = new URL('../scripts/linux-preflight-colima.mjs', import.meta.url);
const api = existsSync(modulePath) ? await import(modulePath) : {};
const ok = stdout => ({ status: 0, stdout, collected: true });
const uuid = '12345678-1234-4234-8234-123456789012';
const counts = { tests: 3, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 1, todo: 0 };
const operation = call => call.command === 'docker' && call.args[0] === '--host' ? call.args[2] : call.args[0];

async function fixture(t, overrides = {}) {
  assert.equal(typeof api.runColimaPreflight, 'function', 'Colima lifecycle wrapper is required');
  const bank = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'slvm-test-'))));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const worktree = join(bank, 'source'), control = join(bank, 'control');
  mkdirSync(worktree); mkdirSync(control, { mode: 0o700 });
  const git = async args => {
    const result = await runOwnedCommand('/usr/bin/git', args, { cwd: worktree,
      env: { PATH: process.env.PATH, HOME: bank, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  await git(['init', '--quiet']);
  writeFileSync(join(worktree, 'README.md'), 'fixture\n');
  await git(['add', '--', 'README.md']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture', '--', 'README.md']);
  const commit = await git(['rev-parse', 'HEAD']);
  const calls = [], stages = new Set(); let state, runId, checkout, now = 0, dockerConfig, changedContext = false;
  const destinations = []; let networkStopped = false, processReads = 0;
  const execute = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    const explicitHost = command === 'docker' && args[0] === '--host' ? args[1] : null;
    if (explicitHost) args = args.slice(2);
    if (command === '/usr/bin/git') {
      if (/^sleight-linux-/.test(basename(options.cwd)) && !stages.has(options.cwd)) {
        stages.add(trackTemp(options.cwd));
        t.after(() => rmSync(options.cwd, { recursive: true, force: true }));
      }
      return runOwnedCommand(command, args, options);
    }
    if (command === 'colima') {
      const op = args[0], profile = op === 'list' ? `slvm-${uuid}` : args[args.indexOf('--profile') + 1];
      if (op === 'list') {
        if (state === 'Stopping' && !overrides.stillRunning) state = 'Stopped';
        return ok(state ? JSON.stringify({ name: profile, status: state === 'Stopping' ? 'Running' : state,
        arch: 'aarch64', cpus: 2, memory: 4294967296, disk: 10737418240, runtime: 'docker', ...overrides.identity }) : '');
      }
      if (op === 'start') {
        state = 'Running';
        dockerConfig = JSON.parse(readFileSync(join(options.env.DOCKER_CONFIG, 'config.json')));
        for (const path of [join(options.env.COLIMA_HOME, profile), join(options.env.LIMA_HOME, `colima-${profile}`)]) {
          mkdirSync(path, { recursive: true }); writeFileSync(join(path, path.includes('colima-') ? 'lima.yaml' : 'colima.yaml'), 'owned config\n');
        }
        if (overrides.usernet !== false) {
          const network = join(options.env.LIMA_HOME, '_networks', 'user-v2');
          mkdirSync(network, { recursive: true });
          writeFileSync(join(network, 'usernet.user-v2.stdout.log'), '');
          if (!overrides.missingPid) writeFileSync(join(network, 'usernet_user-v2.pid'), '43210\n');
        }
        if (overrides.start) return overrides.start({ options, advance: amount => { now += amount; } });
        return ok('');
      }
      if (op === 'stop') {
        state = overrides.stillRunning ? 'Running' : 'Stopped';
        now += overrides.stopDuration ?? 0;
        return overrides.stopResult ?? ok('');
      }
      if (op === 'delete') {
        state = undefined;
        rmSync(join(options.env.COLIMA_HOME, profile), { recursive: true, force: true });
        rmSync(join(options.env.LIMA_HOME, `colima-${profile}`), { recursive: true, force: true });
        return ok('');
      }
    }
    if (command === 'limactl') {
      assert.equal(state, 'Stopped');
      assert.deepEqual(args, ['stop', '--force', `colima-slvm-${uuid}`]);
      assert.equal(options.env.LIMA_HOME, join(control, 'l'));
      if (overrides.networkResult) return overrides.networkResult;
      networkStopped = true;
      rmSync(join(control, 'l', '_networks', 'user-v2', 'usernet_user-v2.pid'), { force: true });
      return ok('');
    }
    if (command === '/bin/ps') {
      assert.deepEqual(args, ['-p', '43210', '-o', 'uid=,lstart=,command=']);
      assert.equal(options.env.LANG, 'C');
      assert.equal(options.env.LC_ALL, 'C');
      if (networkStopped) return { status: 1, stdout: '', collected: true };
      // Synthetic process identity. The private socket argument follows Lima
      // 2.2.1 usernet.Start; PID and start time are test data, not a live receipt.
      const network = join(control, 'l', '_networks', 'user-v2');
      const row = `${process.getuid()} Thu Nov 12 10:00:00 2026 /opt/homebrew/bin/limactl usernet -p ${join(network, 'usernet_user-v2.pid')} --listen ${join(network, 'usernet_fd.sock')}\n`;
      return overrides.process ? overrides.process({ row, read: ++processReads, state }) : ok(row);
    }
    if (command === 'docker') {
      const ownedSocket = `unix://${join(options.env.COLIMA_HOME, `slvm-${uuid}`, 'docker.sock')}`;
      if (args[0] !== 'context') destinations.push(explicitHost ?? (changedContext ? 'unix:///unexpected-daemon.sock' : ownedSocket));
      if (args[0] === 'context') {
        const context = `colima-slvm-${uuid}`;
        return ok(JSON.stringify([{ Name: context, Endpoints: { docker: { Host: overrides.endpoint ?? `unix://${join(options.env.COLIMA_HOME, `slvm-${uuid}`, 'docker.sock')}` } } }]));
      }
      if (args[0] === 'info') return ok('linux');
      if (args[0] === 'create') {
        runId = args[args.indexOf('--name') + 1];
        checkout = args[args.indexOf('--mount') + 1].match(/source=(.*),target=/)[1];
        return ok('d'.repeat(64));
      }
      if (args[0] === 'inspect') return ok(`sha256:${'e'.repeat(64)}`);
      if (args[0] === 'start') {
        changedContext = overrides.changeContextAfterAttach === true;
        now += overrides.attachDuration ?? 0;
        if (overrides.attach) return overrides.attach(options);
        if (overrides.tamper) overrides.tamper(options);
        return ok(JSON.stringify({ schemaVersion: 1, platform: 'linux', command: ['npm', 'test'],
          commit, runId, executed: true, exitCode: 0, dependencyMode: 'checkout-only', trackedFiles: 1, counts }));
      }
      if (args[0] === 'rm') return ok('');
      if (args[0] === 'container') return overrides.remaining ? overrides.remaining(options) : ok('');
    }
    throw Error(`Unexpected command ${command} ${args[0]}`);
  };
  const dependencies = { worktree, commit, execute, makeBank: () => control, uuid: () => uuid, now: () => now,
    pause: async ms => { now += ms; }, isAlive: pid => { assert.equal(pid, 43210); return overrides.helperAlive === true; }, log() {} };
  return { bank, control, worktree, commit, calls, dependencies, destinations, checkout: () => checkout, dockerConfig: () => dockerConfig,
    run: options => api.runColimaPreflight({ ...dependencies, ...options }) };
}

test('Colima runs the real producer with one readonly checkout mount and private Docker context through cleanup', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.vm.cleanupConfirmed, true);
  assert.equal(parseLinuxReceipt(JSON.stringify(result.linuxReceipt), f).commit, f.commit);
  assert.deepEqual(Object.keys(result.linuxReceipt).sort(), ['childCollected', 'cleanupConfirmed', 'command', 'commit',
    'containerId', 'counts', 'executed', 'exitCode', 'imageId', 'dependencyMode', 'platform', 'runId', 'schemaVersion', 'trackedFiles', 'worktree'].sort());
  const start = f.calls.find(c => c.command === 'colima' && c.args[0] === 'start');
  assert.equal(start.args.filter(v => v === '--mount').length, 1);
  assert.equal(start.args[start.args.indexOf('--mount') + 1], f.checkout());
  for (const flag of ['--activate=false', '--ssh-config=false', '--template=false', '--ssh-agent=false']) assert.ok(start.args.includes(flag));
  for (const c of f.calls.filter(c => ['docker', 'colima', 'limactl'].includes(c.command))) {
    assert.ok(c.options.env.DOCKER_CONFIG.startsWith(f.control + '/'));
    assert.ok(c.options.env.COLIMA_HOME.startsWith(f.control + '/'));
    assert.ok(c.options.env.LIMA_HOME.startsWith(f.control + '/'));
    assert.equal(c.options.env.SSH_AUTH_SOCK, undefined);
    assert.equal(c.options.env.DOCKER_HOST, undefined);
    assert.equal(c.options.env.DOCKER_AUTH_CONFIG, undefined);
    if (c.command === 'docker') assert.equal(c.options.env.DOCKER_CONTEXT, `colima-slvm-${uuid}`);
  }
  assert.ok(f.calls.findIndex(c => operation(c) === 'rm') < f.calls.findIndex(c => operation(c) === 'stop'));
  assert.equal(existsSync(f.control), false);
  assert.deepEqual(f.dockerConfig(), { auths: { 'https://index.docker.io/v1/': {} } });
});

test('failed startup stops its identified VM and retains uncertain container state', async t => {
  const f = await fixture(t, { start: () => ({ status: 1, stdout: '', collected: true }) });
  const result = await f.run();
  assert.notEqual(result.exitCode, 0);
  assert.ok(f.calls.some(c => c.command === 'colima' && c.args[0] === 'stop'));
  assert.equal(f.calls.some(c => c.command === 'colima' && c.args[0] === 'delete'), false);
});

test('cancellation lets container cleanup complete before stopping the VM', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { attach: options => { controller.abort(); assert.equal(options.signal.aborted, true);
    return { status: null, stdout: '', collected: true, cancelled: true }; } });
  const result = await f.run({ signal: controller.signal });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.linuxReceipt.cleanupConfirmed, true);
  assert.equal(result.vm.cleanupConfirmed, true);
  assert.equal(f.calls.find(c => operation(c) === 'rm').options.signal.aborted, false);
});

test('unconfirmed container cleanup retains private state even after the VM stops', async t => {
  const f = await fixture(t, { remaining: () => ok('d'.repeat(64)) });
  const result = await f.run();
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.vm.cleanupConfirmed, false);
  assert.equal(existsSync(f.control), true);
  assert.equal(f.calls.some(c => c.args[0] === 'delete'), false);
});

test('a running VM after stop is retained and never deleted', async t => {
  const f = await fixture(t, { stillRunning: true }), result = await f.run();
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.linuxReceipt.exitCode, 0);
  assert.equal(result.vm.cleanupConfirmed, false);
  assert.equal(f.calls.some(c => c.args[0] === 'delete'), false);
  assert.equal(existsSync(join(f.control, 'vm-cleanup.json')), true);
});

test('unexpected managed profile identity prevents tests and destructive cleanup', async t => {
  const f = await fixture(t, { identity: { runtime: 'containerd' } }), result = await f.run();
  assert.notEqual(result.exitCode, 0);
  assert.equal(f.calls.some(c => c.command === 'docker' && operation(c) === 'create'), false);
  assert.equal(f.calls.some(c => ['stop', 'delete'].includes(c.args[0])), false);
  assert.equal(existsSync(f.control), true);
});

test('startup consumes the producer budget and cannot start tests after its deadline', async t => {
  const f = await fixture(t, { start: ({ advance }) => { advance(api.runBudget + 1); return ok(''); } });
  const result = await f.run();
  assert.notEqual(result.exitCode, 0);
  assert.equal(f.calls.some(c => c.command === 'docker' && operation(c) === 'create'), false);
  assert.ok(f.calls.every(c => Number.isFinite(c.options.timeout)));
});

test('a context pointing outside the owned VM never receives container commands', async t => {
  const f = await fixture(t, { endpoint: 'unix:///unexpected-daemon.sock' }), result = await f.run();
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.linuxReceipt.cleanupConfirmed, false);
  assert.deepEqual(f.calls.filter(c => c.command === 'docker').map(c => c.args[0]), ['context']);
  assert.equal(result.vm.stopped, true);
  assert.equal(result.vm.deleted, false);
});

test('configuration replacement prevents VM shutdown and deletion', async t => {
  const f = await fixture(t, { tamper: options => writeFileSync(join(options.env.COLIMA_HOME, `slvm-${uuid}`, 'colima.yaml'), 'replaced config\n') });
  const result = await f.run();
  assert.notEqual(result.exitCode, 0);
  assert.equal(f.calls.some(c => ['stop', 'delete'].includes(c.args[0])), false);
  assert.equal(result.vm.cleanupConfirmed, false);
});

test('an uncollected Docker child prevents every later process and retains VM evidence', async t => {
  const f = await fixture(t, { attach: () => ({ status: null, stdout: '', collected: false }) });
  const result = await f.run();
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.vm.childCollected, false);
  const index = f.calls.findIndex(c => c.command === 'docker' && operation(c) === 'start');
  assert.equal(f.calls.length, index + 1);
  assert.equal(existsSync(join(f.control, 'vm-cleanup.json')), true);
});

test('CLI refuses a missing execution flag or non-exact commit before allocating or launching', async () => {
  const signals = new EventEmitter();
  for (const args of [[], ['--commit', 'a'.repeat(40)], ['--run', '--commit', 'HEAD'], ['--run', '--commit', 'a'.repeat(40), '--profile', 'default']]) {
    assert.equal(await api.main(args, { signals, error() {}, makeBank() { assert.fail('must not allocate'); },
      execute() { assert.fail('must not launch'); } }), 2);
  }
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('CLI keeps the producer receipt alone on stdout and reports VM shutdown failure separately', async t => {
  const f = await fixture(t, { stillRunning: true }), signals = new EventEmitter();
  let stdout = '', stderr = '';
  const status = await api.main(['--run', '--json', '--commit', f.commit, '--worktree', f.worktree], {
    ...f.dependencies, signals, log: text => { stdout += text; }, error: text => { stderr += text; } });
  assert.equal(status, 1);
  const receipt = parseLinuxReceipt(stdout, f);
  assert.equal(receipt.exitCode, 0);
  assert.equal(Object.hasOwn(receipt, 'colima'), false);
  assert.ok(stderr.includes('"cleanupConfirmed":false'));
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('context mutation after attach cannot redirect cleanup to another daemon', async t => {
  const f = await fixture(t, { changeContextAfterAttach: true }), result = await f.run();
  assert.equal(result.exitCode, 0);
  assert.ok(f.destinations.length >= 6);
  assert.ok(f.destinations.every(host => host === `unix://${join(f.control, 'c', `slvm-${uuid}`, 'docker.sock')}`));
});

// Stop shape from rel160-dry3.log and its commands.jsonl: the command was
// collected after timeout, with no exit status; inventory later read Stopped.
// usernet_user-v2.pid is Lima 2.2.1's recorded network directory layout.
const recordedStop = { status: null, collected: true, cancelled: true, signal: 'SIGTERM',
  stdout: "Stopping 'docker.service', but its triggering units are still active:\ndocker.socket\n",
  stderr: 'Waiting for the host agent and the driver processes to shut down\n' };

test('recorded null stop status recovers only after Stopped and collection of the owned usernet helper', async t => {
  const f = await fixture(t, { stopResult: recordedStop, usernet: true });
  let polls = 0;
  const result = await f.run({ isAlive: pid => { assert.equal(pid, 43210); return polls++ < 2; } });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.vm.stopped, true);
  assert.equal(result.vm.deleted, true);
  assert.equal(result.vm.usernetCollected, true);
  assert.deepEqual(result.vm.usernetPids, [43210]);
  assert.deepEqual(result.vm.stopResult, { status: null, signal: 'SIGTERM', cancelled: true });
  assert.match(result.vm.stopFailure, /Colima stop failed/);
  assert.equal(existsSync(f.control), true, 'retain the failed command and its recovered cleanup evidence');
  const commands = readFileSync(join(f.control, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const stop = commands.find(c => c.program === 'colima' && c.args[0] === 'stop');
  assert.equal(stop.cancelled, true);
  assert.equal(stop.status, null);
  assert.ok(commands.every(c => c.durationMs >= 0 && c.finishedAt >= c.startedAt));
  assert.ok(f.calls.findIndex(c => c.command === 'limactl') < f.calls.findIndex(c => c.args[0] === 'delete'));
});

test('shutdown polling waits for Stopped even after a successful stop command', async t => {
  const f = await fixture(t); let reads = 0;
  const result = await f.run({ execute: async (command, args, options) => {
    const response = await f.dependencies.execute(command, args, options);
    if (command === 'colima' && args[0] === 'list' && response.stdout.includes('Stopped') && reads++ < 2) {
      return ok(response.stdout.replace('Stopped', 'Running'));
    }
    return response;
  } });
  assert.equal(result.exitCode, 0);
  assert.ok(reads >= 3, 'poll through both stale Running readings before reconciliation');
});

test('a lingering usernet helper prevents deletion and retains a cleanup failure', async t => {
  const f = await fixture(t, { usernet: true, helperAlive: true }), result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.vm.stopped, true);
  assert.equal(result.vm.deleted, false);
  assert.equal(result.vm.usernetCollected, false);
  assert.equal(result.vm.cleanupConfirmed, false);
  assert.match(result.vm.error, /Usernet helper remains running/);
  assert.equal(f.calls.some(c => c.args[0] === 'delete'), false);
});

test('network reconciliation failure cannot become a passing Linux preflight', async t => {
  const f = await fixture(t, { networkResult: { status: 1, collected: true, stdout: '' } }), result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.linuxReceipt.exitCode, 0);
  assert.equal(result.vm.cleanupConfirmed, false);
  assert.match(result.vm.error, /Lima network cleanup failed/);
});

test('nonzero stop status stays a failed preflight even when all cleanup recovers', async t => {
  const f = await fixture(t, { stopResult: { status: 7, collected: true, stdout: '' } }), result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.vm.cleanupConfirmed, true);
  assert.equal(result.vm.deleted, true);
  assert.equal(result.vm.stopResult.status, 7);
  assert.equal(existsSync(f.control), true);
});

test('deletion failure stays visible after successful VM and network shutdown', async t => {
  const f = await fixture(t);
  const result = await f.run({ execute: (command, args, options) => command === 'colima' && args[0] === 'delete'
    ? { status: 1, collected: true, stdout: '' } : f.dependencies.execute(command, args, options) });
  assert.equal(result.exitCode, 1);
  assert.equal(result.vm.stopped, true);
  assert.equal(result.vm.usernetCollected, true);
  assert.equal(result.vm.cleanupConfirmed, false);
  assert.match(result.vm.error, /Colima deletion unconfirmed/);
});

test('a slow cold boot leaves a full Linux budget and a separate cleanup reserve', async t => {
  const f = await fixture(t, { start: ({ advance }) => { advance(258_000); return ok(''); } });
  const result = await f.run();
  assert.equal(result.exitCode, 0);
  const start = f.calls.find(c => c.command === 'colima' && c.args[0] === 'start');
  const attach = f.calls.find(c => c.command === 'docker' && operation(c) === 'start');
  const stop = f.calls.find(c => c.command === 'colima' && c.args[0] === 'stop');
  assert.equal(start.options.timeout, 360_000);
  assert.ok(attach.options.timeout > 32 * 60_000, 'boot cannot consume npm time');
  assert.equal(stop.options.timeout, 390_000);
  assert.equal(api.runBudget, 38 * 60_000);
  assert.equal(api.totalBudget, 46 * 60_000);
});

test('successful Linux execution near its deadline can spend the separate cleanup reserve', async t => {
  const f = await fixture(t, { attachDuration: api.runBudget - 60_000, stopDuration: 120_000 });
  const result = await f.run();
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.vm.cleanupConfirmed, true);
  assert.equal(result.vm.deleted, true);
});

test('a replacement usernet PID never receives cleanup commands', async t => {
  const f = await fixture(t, { usernet: true, tamper: options => {
    writeFileSync(join(options.env.LIMA_HOME, '_networks', 'user-v2', 'usernet_user-v2.pid'), '43211\n');
  } });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.match(result.vm.error, /Usernet helper identity changed/);
  assert.equal(result.vm.cleanupConfirmed, false);
  assert.equal(f.calls.some(c => c.command === 'limactl' || ['stop', 'delete'].includes(c.args[0])), false);
});

for (const phase of ['before stop', 'before force stop']) {
  for (const [name, replace] of [
    ['recycled PID', row => row.replace(/\/opt\/homebrew\/bin\/limactl .*/, '/usr/bin/unrelated-worker')],
    ['restarted helper', row => row.replace('10:00:00', '10:30:00')],
    ['wrong owner', row => row.replace(/^\d+/, String(process.getuid() + 1))],
    ['other bank', row => row.replaceAll('/_networks/', '-other/_networks/')],
  ]) test(`${name} ${phase} prevents Lima from signalling an unverified PID`, async t => {
    const f = await fixture(t, { process: ({ row, read, state }) => ok(
      (phase === 'before stop' ? read > 1 : state === 'Stopped') ? replace(row) : row) });
    const result = await f.run();
    assert.equal(result.exitCode, 1);
    assert.match(result.vm.error, /Usernet process identity changed or unavailable/);
    assert.equal(result.vm.cleanupConfirmed, false);
    assert.equal(f.calls.some(c => c.command === 'limactl' || c.args[0] === 'delete'), false);
    assert.equal(f.calls.some(c => c.command === 'colima' && c.args[0] === 'stop'), phase !== 'before stop');
    assert.equal(existsSync(join(f.control, 'vm-cleanup.json')), true);
  });
}

test('a changed instance immediately before force stop prevents reconciliation', async t => {
  const f = await fixture(t); let stoppedReads = 0;
  const result = await f.run({ execute: async (command, args, options) => {
    const response = await f.dependencies.execute(command, args, options);
    if (command === 'colima' && args[0] === 'list' && response.stdout.includes('Stopped') && ++stoppedReads === 2) {
      return ok(response.stdout.replace(`slvm-${uuid}`, 'another-instance'));
    }
    return response;
  } });
  assert.equal(result.exitCode, 1);
  assert.match(result.vm.error, /Unexpected profile identity/);
  assert.equal(f.calls.some(c => c.command === 'limactl' || c.args[0] === 'delete'), false);
});

test('recorded network logs without a captured PID never report helper collection', async t => {
  // slvm-9Uq9sc retained usernet stdout/stderr logs with no PID file.
  const f = await fixture(t, { missingPid: true }), result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.vm.usernetPids, []);
  assert.equal(result.vm.usernetCollected, null);
  assert.equal(result.vm.usernetStatus, 'not captured');
  assert.match(result.vm.error, /Usernet PID not captured/);
  assert.equal(f.calls.some(c => c.command === 'limactl' || ['stop', 'delete'].includes(c.args[0])), false);
});

test('a run with no usernet directory reports not captured even after cleanup', async t => {
  const f = await fixture(t, { usernet: false }), result = await f.run();
  assert.equal(result.exitCode, 0);
  assert.equal(result.vm.usernetCollected, null);
  assert.equal(result.vm.usernetStatus, 'not captured');
});
