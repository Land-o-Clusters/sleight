#!/usr/bin/env node
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { linuxRunBudget, runLinuxPreflight, runOwnedCommand } from './linux-preflight.mjs';

// Recorded cold boot: 258 s (rehearsal 3). Reserve six minutes for startup in
// addition to the Linux budget, and eight more for shutdown and deletion.
export const runBudget = linuxRunBudget + 6 * 60_000, totalBudget = runBudget + 8 * 60_000;
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const digest = text => createHash('sha256').update(text).digest('hex');
const successful = result => result.status === 0 && result.collected === true;
const processAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

function ordinary(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || stat.uid !== process.getuid() || realpathSync(path) !== path) throw Error('Unowned or redirected path');
  return stat;
}

// Colima, Lima, Docker configuration and downloads stay in one short, private bank.
// Short paths also leave room for macOS's Unix socket path limit.
export async function runColimaPreflight({ worktree = fileURLToPath(new URL('..', import.meta.url)), commit,
  execute = runOwnedCommand, signal, log = text => process.stderr.write(text),
  makeBank = () => mkdtempSync(join(realpathSync('/tmp'), 'slvm-')), uuid = randomUUID, now = Date.now,
  pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms)), isAlive = processAlive,
} = {}) {
  const began = now(), controller = new AbortController(), hard = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, runBudget), hardTimer = setTimeout(() => hard.abort(), totalBudget);
  let bank, env, marker, rootStat, configs, usernetFile, usernetProcess, attempted = false, collected = true, linuxReceipt = null;
  const vm = { schemaVersion: 1, cleanupConfirmed: false, childCollected: true, stopped: false, deleted: false,
    usernetPids: [], usernetCollected: null, usernetStatus: 'not captured' };
  let exitCode = 1;
  const write = (name, value) => writeFileSync(join(bank, name), JSON.stringify(value) + '\n', { mode: 0o600 });
  const owner = () => {
    const stat = ordinary(bank, true);
    if (stat.dev !== rootStat.dev || stat.ino !== rootStat.ino || (stat.mode & 0o077)
      || readFileSync(join(bank, 'OWNER.json'), 'utf8') !== marker) throw Error('Control bank identity changed');
    for (const dir of [env.HOME, env.COLIMA_HOME, env.LIMA_HOME, env.DOCKER_CONFIG, env.COLIMA_CACHE_HOME]) ordinary(dir, true);
  };
  const command = async (program, args, options = {}, cleanup = false) => {
    if (!collected) throw Error('Prior owned child remains uncollected');
    const remaining = began + (cleanup ? totalBudget : runBudget) - now() - 8_000;
    if (remaining <= 0 || (cleanup ? hard.signal : controller.signal).aborted) throw Error('Colima deadline or cancellation');
    const timeout = Math.min(options.timeout ?? 30_000, remaining);
    // An explicit host wins over mutable context metadata for every engine request.
    const argv = program === 'docker' && args[0] !== 'context'
      ? ['--host', `unix://${join(env.COLIMA_HOME, vm.profile, 'docker.sock')}`, ...args] : args;
    const startedAt = now();
    const response = await execute(program, argv, { ...options, timeout,
      signal: cleanup ? hard.signal : controller.signal,
      ...(['colima', 'docker', 'limactl'].includes(program) ? { env: { ...env,
        ...(program === 'docker' ? { DOCKER_CONTEXT: vm.context } : {}) } } : {}) });
    if (response.collected !== true) collected = false;
    appendFileSync(join(bank, 'commands.jsonl'), JSON.stringify({ program,
      // The inline container program is large; the producer supplies its exact content.
      args: argv.map((arg, i) => argv[i - 1] === '-e' ? '<container program>' : arg),
      startedAt, finishedAt: now(), durationMs: now() - startedAt,
      status: response.status, signal: response.signal, cancelled: response.cancelled,
      collected: response.collected, stdout: response.stdout, stderr: response.stderr }) + '\n', { mode: 0o600 });
    if (response.collected !== true) throw Error('Uncollected owned child');
    return response;
  };
  const list = async cleanup => {
    owner();
    // Inventory is already isolated by LIMA_HOME. Avoid a missing-name selector after deletion.
    const response = await command('colima', ['list', '--json'], { timeout: 5_000 }, cleanup);
    if (!successful(response)) throw Error('Colima state unavailable');
    const rows = response.stdout.trim() ? response.stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
    if (rows.length > 1) throw Error('Ambiguous profile state');
    if (rows.length && (rows[0].name !== vm.profile || rows[0].runtime !== 'docker' || rows[0].arch !== 'aarch64'
      || rows[0].cpus !== 2 || rows[0].memory !== 4294967296 || rows[0].disk !== 10737418240
      || !['Running', 'Stopped'].includes(rows[0].status))) throw Error('Unexpected profile identity');
    return rows[0];
  };
  const snapshot = () => [join(env.COLIMA_HOME, vm.profile, 'colima.yaml'),
    join(env.LIMA_HOME, `colima-${vm.profile}`, 'lima.yaml')].map(path => {
    ordinary(dirname(path), true); const stat = ordinary(path);
    return { path, dev: stat.dev, ino: stat.ino, hash: digest(readFileSync(path)) };
  });
  const verifyConfigs = () => {
    const current = snapshot();
    if (configs && JSON.stringify(current) !== JSON.stringify(configs)) throw Error('Managed profile configuration changed');
    configs ??= current;
  };
  const captureUsernet = async (cleanup = false) => {
    owner();
    // Lima 2.2.1: pkg/networks/usernet/config.go, PIDFile("user-v2"). Only
    // this newly created LIMA_HOME can supply a helper identity. Inspect only
    // that PID, never a host-wide process inventory.
    const networks = join(env.LIMA_HOME, '_networks'), directory = join(networks, 'user-v2');
    for (const path of [networks, directory]) {
      if (!existsSync(path)) return;
      ordinary(path, true);
    }
    const path = join(directory, 'usernet_user-v2.pid');
    const present = existsSync(path);
    if (!present && !usernetFile) throw Error('Usernet PID not captured; network cleanup unconfirmed');
    let file = usernetFile;
    if (present) {
      const stat = ordinary(path);
      if (stat.size > 20) throw Error('Invalid usernet PID file');
      const text = readFileSync(path, 'utf8').trim(), pid = Number(text);
      if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw Error('Invalid usernet PID');
      file = { pid, dev: stat.dev, ino: stat.ino };
      if (usernetFile && JSON.stringify(file) !== JSON.stringify(usernetFile)) throw Error('Usernet helper identity changed');
    }
    const response = await command('/bin/ps', ['-p', String(file.pid), '-o', 'uid=,lstart=,command='],
      { timeout: 5_000, env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' } }, cleanup);
    // A missing PID file and an exited captured process are safe after stop.
    // A stale file still lets Lima signal a recycled PID, so refuse that case.
    if (response.status === 1 && !response.stdout.trim() && !present && usernetProcess) return;
    const row = successful(response) && /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(response.stdout);
    const args = row ? row[3].split(/\s+/) : [];
    // Match the exact private network path as an argument (or option value).
    const ownsNetwork = args.slice(2).some(arg => arg.split('=')
      .some(value => value === directory || value.startsWith(directory + '/')));
    if (!row || Number(row[1]) !== process.getuid() || basename(args[0]) !== 'limactl' || args[1] !== 'usernet'
      || args[args.indexOf('-p') + 1] !== path
      || !ownsNetwork || usernetProcess && response.stdout.trim() !== usernetProcess) throw Error('Usernet process identity changed or unavailable');
    usernetFile ??= file; usernetProcess ??= response.stdout.trim();
    if (!vm.usernetPids.length) vm.usernetPids.push(file.pid);
    vm.usernetCollected = false; vm.usernetStatus = 'captured';
  };
  const cleanupIdentity = async expected => {
    const current = await list(true);
    if (!current || current.status !== expected) throw Error('Managed instance identity or state changed before cleanup');
    verifyConfigs();
    await captureUsernet(true);
  };
  const waitFor = async (check, attempts, message) => {
    for (let i = 0; i < attempts; i++) {
      if (hard.signal.aborted) throw Error('Colima cleanup deadline');
      if (await check()) return;
      if (i + 1 < attempts) await pause(500);
    }
    throw Error(message);
  };
  try {
    if (!shaPattern.test(commit ?? '')) throw Error('An exact commit is required');
    const token = uuid();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)) throw Error('Invalid ownership token');
    bank = realpathSync(makeBank()); rootStat = ordinary(bank, true);
    if (rootStat.mode & 0o077) throw Error('Control bank must be private');
    vm.profile = `slvm-${token}`; vm.context = `colima-${vm.profile}`; vm.bank = bank;
    env = { PATH: process.env.PATH, HOME: join(bank, 'h'), LANG: 'C', TMPDIR: join(bank, 't'),
      COLIMA_HOME: join(bank, 'c'), LIMA_HOME: join(bank, 'l'), COLIMA_CACHE_HOME: join(bank, 'cache'),
      DOCKER_CONFIG: join(bank, 'd'), XDG_CACHE_HOME: join(bank, 'cache') };
    for (const dir of new Set(Object.values(env).filter(value => value.startsWith(bank + '/')))) mkdirSync(dir, { mode: 0o700 });
    marker = JSON.stringify({ token, profile: vm.profile, commit, worktree: realpathSync(worktree) }) + '\n';
    writeFileSync(join(bank, 'OWNER.json'), marker, { flag: 'wx', mode: 0o600 });
    // One empty auth entry prevents Docker's automatic discovery of the host credential helper.
    writeFileSync(join(env.DOCKER_CONFIG, 'config.json'), JSON.stringify({ auths: { 'https://index.docker.io/v1/': {} } }), { mode: 0o600 });
    const socket = `unix://${join(env.COLIMA_HOME, vm.profile, 'docker.sock')}`;
    let ready = false;
    const scoped = async (program, args, options = {}) => {
      if (program !== 'docker') return command(program, args, options);
      const cleanup = ['rm', 'container'].includes(args[0]);
      if (cleanup && !ready) throw Error('Docker cleanup endpoint was not verified');
      if (!ready && !cleanup) {
        if (args[0] !== 'create') throw Error('Expected first Docker create');
        const mounts = args.flatMap((arg, i) => arg === '--mount' ? [args[i + 1]] : []);
        const source = mounts.length === 1 ? /^type=bind,source=(.*),target=\/source,readonly$/.exec(mounts[0])?.[1] : null;
        const checkout = source && realpathSync(source);
        if (!checkout || basename(checkout) !== 'checkout'
          || realpathSync(options.cwd) !== dirname(checkout)
          || !/^sleight-linux-[A-Za-z0-9]+$/.test(basename(dirname(checkout)))
          || dirname(dirname(checkout)) !== realpathSync(tmpdir()) || /[:,\r\n\0]/.test(checkout)) throw Error('Invalid prepared checkout mount');
        ordinary(dirname(checkout), true); ordinary(checkout, true); ordinary(join(checkout, '.git'), true);
        if (existsSync(join(checkout, 'node_modules'))) throw Error('Prepared checkout includes host dependencies');
        if (await list(false) || existsSync(join(env.COLIMA_HOME, vm.profile))
          || existsSync(join(env.LIMA_HOME, `colima-${vm.profile}`))) throw Error('Profile already exists');
        attempted = true;
        const started = await command('colima', ['start', '--profile', vm.profile, '--activate=false', '--ssh-config=false',
          '--template=false', '--ssh-agent=false', '--runtime', 'docker', '--vm-type', 'vz', '--arch', 'aarch64',
          '--cpus', '2', '--memory', '4', '--disk', '10', '--root-disk', '20', '--mount', checkout],
        { timeout: 360_000, log: { stdout: log, stderr: log } });
        await captureUsernet();
        if (!successful(started)) throw Error('Colima startup failed');
        if ((await list(false))?.status !== 'Running') throw Error('Colima did not start');
        verifyConfigs();
        const context = await command('docker', ['context', 'inspect', vm.context], { timeout: 5_000 });
        const contexts = successful(context) ? JSON.parse(context.stdout) : [];
        if (contexts.length !== 1 || contexts[0].Name !== vm.context || contexts[0].Endpoints?.docker?.Host !== socket) throw Error('Unexpected Docker endpoint');
        const health = await command('docker', ['info', '--format', '{{.OSType}}'], { timeout: 5_000 });
        if (!successful(health) || health.stdout.trim() !== 'linux') throw Error('Linux Docker daemon unavailable');
        ready = true;
        // macOS's temporary root can use /var's system alias. The VM sees the canonical mount.
        args = args.map(arg => arg === mounts[0] ? `type=bind,source=${checkout},target=/source,readonly` : arg);
      }
      return command(program, args, options, cleanup);
    };
    linuxReceipt = await runLinuxPreflight({ worktree, commit, execute: scoped, signal: controller.signal,
      timeout: Math.max(1, runBudget - (now() - began)), log });
    write('linux-receipt.json', linuxReceipt);
    exitCode = linuxReceipt.exitCode;
  } catch (error) { vm.error = error.message; }
  finally {
    const runExpired = now() - began >= runBudget;
    // Cleanup has its own reserve. Finishing tests near the run deadline must
    // not cancel an otherwise successful stop while the hard timer is open.
    clearTimeout(timer);
    try {
      if (attempted && collected) {
        const before = await list(true);
        if (!before) throw Error('Managed profile disappeared');
        verifyConfigs();
        if (before.status === 'Running') {
          // Lima's graceful stop can wait 190 s for its agent, then 180 s for
          // shutdown. The former 30 s timeout killed Colima before reconciliation.
          await cleanupIdentity('Running');
          const stopped = await command('colima', ['stop', '--profile', vm.profile], { timeout: 390_000 }, true);
          vm.stopResult = { status: stopped.status, signal: stopped.signal ?? null, cancelled: stopped.cancelled === true };
          if (!successful(stopped)) {
            vm.stopFailure = 'Colima stop failed; checking shutdown independently';
            // A real nonzero exit remains a failed preflight even if cleanup recovers.
            if (stopped.status !== null || !stopped.cancelled) exitCode ||= 1;
          }
        }
        await waitFor(async () => (await list(true))?.status === 'Stopped', 60, 'Colima shutdown unconfirmed');
        vm.stopped = true; verifyConfigs();
        // A timed-out stop may have missed Lima's network reconciliation. This
        // targets only the verified stopped instance in our private LIMA_HOME.
        await cleanupIdentity('Stopped');
        const reconciled = await command('limactl', ['stop', '--force', `colima-${vm.profile}`], { timeout: 20_000 }, true);
        if (!successful(reconciled)) throw Error('Lima network cleanup failed');
        if (vm.usernetPids.length) {
          await waitFor(() => vm.usernetPids.every(pid => !isAlive(pid)), 30, 'Usernet helper remains running');
          vm.usernetCollected = true; vm.usernetStatus = 'collected';
        }
        if (linuxReceipt?.cleanupConfirmed && linuxReceipt?.childCollected) {
          await cleanupIdentity('Stopped');
          const deleted = await command('colima', ['delete', '--force', '--data', '--profile', vm.profile], { timeout: 60_000 }, true);
          if (!successful(deleted) || await list(true)
            || existsSync(join(env.COLIMA_HOME, vm.profile)) || existsSync(join(env.LIMA_HOME, `colima-${vm.profile}`))) throw Error('Colima deletion unconfirmed');
          vm.deleted = true; vm.cleanupConfirmed = true;
        }
      } else if (!attempted && collected) { vm.cleanupConfirmed = true; }
    } catch (error) { vm.error = `${error.message}; VM shutdown or deletion unconfirmed, bank retained at ${bank}`; }
    clearTimeout(timer); clearTimeout(hardTimer); signal?.removeEventListener('abort', cancel);
    vm.childCollected = collected;
    if (!vm.cleanupConfirmed || !collected || controller.signal.aborted || hard.signal.aborted || runExpired) exitCode ||= 1;
    if (bank && marker) {
      try {
        write('vm-cleanup.json', vm);
        owner();
        if (exitCode === 0 && vm.cleanupConfirmed && !vm.stopFailure) rmSync(bank, { recursive: true, force: false });
        else log(`Colima evidence retained: ${bank}\n`);
      } catch (error) { vm.cleanupConfirmed = false; vm.error = error.message; exitCode ||= 1; }
    }
    log(JSON.stringify({ colima: vm, exitCode }) + '\n');
  }
  return { linuxReceipt, vm, exitCode };
}

export async function main(args = process.argv.slice(2), { signals = process, log = text => process.stdout.write(text),
  error = text => process.stderr.write(text), ...dependencies } = {}) {
  const options = {}, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!['--run', '--json', '--commit', '--worktree'].includes(arg) || seen.has(arg)) return 2;
    seen.add(arg);
    if (['--commit', '--worktree'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) return 2;
      options[arg.slice(2)] = args[++i];
    }
  }
  if (!seen.has('--run') || !shaPattern.test(options.commit ?? '')) {
    error('Usage: node scripts/linux-preflight-colima.mjs --run --json --commit SHA [--worktree PATH]\n'); return 2;
  }
  const controller = new AbortController(), cancel = () => controller.abort();
  signals.on('SIGINT', cancel); signals.on('SIGTERM', cancel);
  try {
    const result = await runColimaPreflight({ ...dependencies, ...options, signal: controller.signal, log: error });
    if (result.linuxReceipt) log(JSON.stringify(result.linuxReceipt) + '\n');
    return result.exitCode;
  } finally { signals.removeListener('SIGINT', cancel); signals.removeListener('SIGTERM', cancel); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
