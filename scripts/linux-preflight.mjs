#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, opendirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const containerPattern = /^[a-f0-9]{64}$/;

// Own the ChildProcess until close, including cancellation. Never infer collection from kill().
export function runOwnedCommand(command, args, { signal, timeout = 120_000, log, ...options } = {}) {
  return new Promise(resolveResult => {
    let child, stdout = '', stderr = '', stopped = false, settled = false, escalation, collection;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(escalation); clearTimeout(collection);
      signal?.removeEventListener('abort', stop);
      resolveResult({ stdout, stderr, ...result });
    };
    const stop = () => {
      if (stopped || settled) return;
      stopped = true;
      child?.kill('SIGTERM');
      escalation = setTimeout(() => child?.kill('SIGKILL'), 2_000);
      collection = setTimeout(() => finish({ status: null, collected: false, cancelled: true }), 7_000);
    };
    const timer = setTimeout(stop, timeout);
    if (signal?.aborted) { finish({ status: null, collected: true, cancelled: true }); return; }
    try {
      child = spawn(command, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', data => {
        stdout = (stdout + data.toString()).slice(-1024 * 1024);
        if (log?.stdout) log.stdout(data.toString());
      });
      child.stderr.on('data', data => {
        stderr = (stderr + data.toString()).slice(-64 * 1024);
        if (log?.stderr) log.stderr(data.toString());
      });
      child.once('error', error => {
        if (!child.pid) finish({ status: null, collected: true,
          errorCode: ['ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE'].includes(error?.code) ? error.code : 'other' });
        else stop();
      });
      child.once('close', (status, childSignal) => finish({ status: stopped ? null : status,
        signal: childSignal, cancelled: stopped, collected: true }));
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    } catch (error) { finish({ status: null, collected: true,
      errorCode: ['ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE'].includes(error?.code) ? error.code : 'other' }); }
  });
}

export function testCounts(output) {
  const counts = {};
  for (const match of output.matchAll(/^(?:# |ℹ )(tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) {
    if (Object.hasOwn(counts, match[1])) return null;
    counts[match[1]] = Number(match[2]);
  }
  if (!['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].every(key => Number.isSafeInteger(counts[key]))) return null;
  if (counts.tests < 1 || counts.pass < 1 || counts.tests !== counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo) return null;
  return counts;
}

function validExecution(receipt, { commit, runId } = {}) {
  return receipt?.schemaVersion === 1 && receipt.platform === 'linux' && receipt.executed === true
    && !Object.hasOwn(receipt, 'failure')
    && receipt.commit === commit && (!runId || receipt.runId === runId)
    && receipt.command?.length === 2 && receipt.command[0] === 'npm' && receipt.command[1] === 'test'
    && receipt.exitCode === 0 && receipt.dependencyMode === 'checkout-only' && Number.isSafeInteger(receipt.trackedFiles)
    && receipt.trackedFiles > 0 && receipt.counts?.tests > 0 && receipt.counts?.pass > 0
    && ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].every(key => Number.isSafeInteger(receipt.counts?.[key]) && receipt.counts[key] >= 0)
    && receipt.counts.tests === receipt.counts.pass + receipt.counts.skipped
    && receipt.counts.fail === 0 && receipt.counts.cancelled === 0 && receipt.counts.todo === 0;
}

// The host accepts only these closed diagnostics, never container error text or extra fields.
function closedFailure(value) {
  if (!value || typeof value !== 'object' || typeof value.stage !== 'string' || typeof value.code !== 'string') return null;
  const stages = {
    prepare: ['exception'], 'config-create': ['exception'], 'config-cleanup': ['exception'],
    'git-head': ['exception', 'child-failed', 'identity-mismatch'],
    'git-tracked': ['exception', 'child-failed', 'invalid-tracked', 'empty-tracked'],
    dependencies: ['present', 'exception'], test: ['exception', 'child-failed'], counts: ['invalid-counts'],
  };
  const errors = ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EINVAL', 'ENOSPC', 'EROFS',
    'EMFILE', 'ENFILE', 'ERR_FS_CP_EEXIST', 'ERR_FS_CP_DIR_TO_NON_DIR', 'ERR_FS_CP_NON_DIR_TO_DIR',
    'ERR_FS_CP_SOCKET', 'ERR_FS_CP_FIFO_PIPE', 'ERR_FS_CP_UNKNOWN', 'other'];
  if (!Object.hasOwn(stages, value.stage) || !stages[value.stage].includes(value.code)) return null;
  const result = { stage: value.stage, code: value.code };
  if (value.code === 'child-failed') {
    if (!(value.childExitCode === null || Number.isInteger(value.childExitCode) && value.childExitCode >= 0 && value.childExitCode <= 255)
      || !['uncollected-child', 'unsafe-repository', 'not-repository', 'permission-denied', 'missing-object', 'other-stderr', 'no-stderr'].includes(value.reason)) return null;
    result.childExitCode = value.childExitCode; result.reason = value.reason;
  }
  if (value.code === 'exception' && !errors.includes(value.errorCode)) return null;
  for (const key of ['errorCode', 'cleanupErrorCode']) {
    if (Object.hasOwn(value, key)) {
      if (!errors.includes(value[key])) return null;
      result[key] = value[key];
    }
  }
  if (Object.hasOwn(value, 'copy')) {
    if (value.stage !== 'prepare' || value.code !== 'exception' || value.errorCode !== 'ERR_FS_CP_EEXIST') return null;
    const copy = value.copy, destination = copy?.destination, collision = copy?.collision;
    if (!(copy?.nodeVersion === 'unavailable' || typeof copy?.nodeVersion === 'string' && /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(copy.nodeVersion))
      || !['absent', 'empty', 'nonempty', 'unsafe', 'unavailable'].includes(destination?.state)
      || !['destination-root', 'descendant', 'unavailable'].includes(collision?.location)) return null;
    const closedDestination = { state: destination.state }, closedCollision = { location: collision.location };
    if (['empty', 'nonempty'].includes(destination.state)) {
      if (!Number.isInteger(destination.count) || destination.count < (destination.state === 'empty' ? 0 : 1)
        || destination.count > (destination.state === 'empty' ? 0 : 256)) return null;
      closedDestination.count = destination.count;
    } else if (Object.hasOwn(destination, 'count')) return null;
    if (collision.location === 'descendant') {
      if (!['.git', 'tracked', 'other'].includes(collision.area) || typeof collision.pathSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(collision.pathSha256)) return null;
      closedCollision.area = collision.area; closedCollision.pathSha256 = collision.pathSha256;
    }
    result.copy = { nodeVersion: copy.nodeVersion, destination: closedDestination, collision: closedCollision };
  }
  return result;
}

// Inspect only the owned copy root, with a bounded directory read and no symlink traversal.
function copyDestinationState(root) {
  let directory;
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { state: 'unsafe' };
    directory = opendirSync(root);
    let count = 0;
    while (count < 256 && directory.readSync() !== null) count++;
    return { state: count ? 'nonempty' : 'empty', count };
  } catch (error) { return { state: error?.code === 'ENOENT' ? 'absent' : 'unavailable' }; }
  finally { try { directory?.closeSync(); } catch {} }
}

// Native Node 24 puts the collision path only in this fixed message. Never return that text.
function copyFailureDiagnostic(error, root, destination, nodeVersion) {
  const result = { nodeVersion: typeof nodeVersion === 'string' && /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(nodeVersion) ? nodeVersion : 'unavailable',
    destination, collision: { location: 'unavailable' } };
  try {
    let path = typeof error?.path === 'string' ? error.path : error?.info?.path;
    if (typeof path !== 'string') path = /^\[ERR_FS_CP_EEXIST\]: Target already exists: cp returned EEXIST \((.+) already exists\)$/.exec(error?.message ?? '')?.[1];
    if (typeof path !== 'string' || /[\x00-\x1f\x7f]/.test(path) || !posix.isAbsolute(root) || root === '/'
      || posix.normalize(root) !== root || !posix.isAbsolute(path) || posix.normalize(path) !== path) return result;
    if (path === root) result.collision = { location: 'destination-root' };
    else if (path.startsWith(`${root}/`)) {
      const relative = path.slice(root.length + 1);
      if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) return result;
      result.collision = { location: 'descendant', area: relative === '.git' || relative.startsWith('.git/') ? '.git' : 'other',
        pathSha256: createHash('sha256').update(relative).digest('hex') };
    }
  } catch {}
  return result;
}

// Shared consumer: both A6 and the CLI require the real producer's complete success contract.
export function parseLinuxReceipt(text, { commit, worktree } = {}) {
  const receipt = JSON.parse(text);
  if (!shaPattern.test(commit ?? '') || !validExecution(receipt, { commit }) || receipt.worktree !== worktree
    || receipt.cleanupConfirmed !== true || receipt.childCollected !== true
    || !/^sleight-linux-[a-f0-9-]{36}$/.test(receipt.runId ?? '')
    || !containerPattern.test(receipt.containerId ?? '') || !imagePattern.test(receipt.imageId ?? '')) {
    throw Error('Invalid Linux execution receipt');
  }
  return receipt;
}

// Serialized below and executed inside Linux. Every command uses the copied exact-commit checkout.
export async function runContainerChecks({ execute = runOwnedCommand, platform = process.platform,
  env = process.env, commit, runId, source = '/source', root = '/w', nodeVersion = process.version,
  dependenciesPresent = () => {
    try { lstatSync(join(root, 'node_modules')); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  },
  prepare = () => cpSync(source, root, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false }),
  makeConfig = () => mkdtempSync(join(tmpdir(), 'lane-claude-')),
  removeConfig = directory => rmSync(directory, { recursive: true, force: true }),
  log = text => process.stderr.write(text),
} = {}) {
  const receipt = { schemaVersion: 1, platform, command: ['npm', 'test'], commit, runId,
    executed: false, exitCode: 1, dependencyMode: 'checkout-only', counts: null, trackedFiles: 0 };
  if (platform !== 'linux' || !shaPattern.test(commit ?? '')) return receipt;
  let config, destination, stage = 'prepare';
  const errorCode = error => ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EINVAL', 'ENOSPC', 'EROFS',
    'EMFILE', 'ENFILE', 'ERR_FS_CP_EEXIST', 'ERR_FS_CP_DIR_TO_NON_DIR', 'ERR_FS_CP_NON_DIR_TO_DIR',
    'ERR_FS_CP_SOCKET', 'ERR_FS_CP_FIFO_PIPE', 'ERR_FS_CP_UNKNOWN'].includes(error?.code) ? error.code : 'other';
  const fail = (code, child, error) => {
    receipt.exitCode ||= 1;
    receipt.failure = { stage, code };
    if (child) {
      receipt.failure.childExitCode = Number.isInteger(child.status) ? child.status : null;
      const text = typeof child.stderr === 'string' ? child.stderr : '';
      receipt.failure.reason = child.collected === false ? 'uncollected-child'
        : /detected dubious ownership|unsafe repository/i.test(text) ? 'unsafe-repository'
        : /not a git repository/i.test(text) ? 'not-repository'
        : /permission denied|operation not permitted/i.test(text) ? 'permission-denied'
        : /bad object|invalid object name|unknown revision|ambiguous argument|needed a single revision|bad revision/i.test(text) ? 'missing-object'
        : text.trim() ? 'other-stderr' : 'no-stderr';
      if (child.errorCode) receipt.failure.errorCode = errorCode({ code: child.errorCode });
    }
    if (code === 'exception') {
      receipt.failure.errorCode = errorCode(error);
      if (stage === 'prepare' && error?.code === 'ERR_FS_CP_EEXIST') {
        receipt.failure.copy = copyFailureDiagnostic(error, root, destination, nodeVersion);
      }
    }
    return receipt;
  };
  try {
    destination = copyDestinationState(root);
    prepare();
    stage = 'config-create';
    config = makeConfig();
    const options = { cwd: root, env: { ...env, HOME: config, CLAUDE_CONFIG_DIR: config, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } };
    stage = 'git-head';
    const head = await execute('/usr/bin/git', ['rev-parse', '--verify', 'HEAD^{commit}'], options);
    if (head.status !== 0 || head.collected === false) return fail('child-failed', head);
    if (head.stdout.trim() !== commit) return fail('identity-mismatch');
    stage = 'git-tracked';
    const tracked = await execute('/usr/bin/git', ['ls-files', '-z'], options);
    if (tracked.status !== 0 || tracked.collected === false) return fail('child-failed', tracked);
    if (!tracked.stdout.endsWith('\0')) return fail('invalid-tracked');
    receipt.trackedFiles = tracked.stdout.split('\0').filter(Boolean).length;
    if (!receipt.trackedFiles) return fail('empty-tracked');
    const npmOptions = { ...options, timeout: 1_200_000, log: { stdout: log, stderr: log } };
    // Public CI runs npm test from the checkout without npm install or npm ci.
    stage = 'dependencies';
    if (dependenciesPresent()) return fail('present');
    stage = 'test';
    const result = await execute('npm', ['test'], npmOptions);
    receipt.executed = true;
    receipt.exitCode = Number.isInteger(result.status) ? result.status : 1;
    receipt.counts = testCounts(result.stdout ?? '');
    if (result.status !== 0 || result.collected === false) fail('child-failed', result);
    if (!receipt.counts || receipt.counts.fail || receipt.counts.cancelled || receipt.counts.todo) {
      stage = 'counts';
      if (!receipt.failure) fail('invalid-counts');
    }
  } catch (error) { receipt.exitCode = 1; fail('exception', null, error); }
  finally {
    if (config) {
      try { removeConfig(config); }
      catch (error) {
        receipt.exitCode ||= 1;
        if (receipt.failure) receipt.failure.cleanupErrorCode = errorCode(error);
        else { stage = 'config-cleanup'; fail('exception', null, error); }
      }
    }
  }
  return receipt;
}

export const containerProgram = `
import { spawn } from 'node:child_process';
import { cpSync, lstatSync, mkdtempSync, opendirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';
const shaPattern = ${shaPattern};
const runOwnedCommand = ${runOwnedCommand.toString()};
const testCounts = ${testCounts.toString()};
const copyDestinationState = ${copyDestinationState.toString()};
const copyFailureDiagnostic = ${copyFailureDiagnostic.toString()};
const runContainerChecks = ${runContainerChecks.toString()};
const receipt = await runContainerChecks({ commit: process.argv[1], runId: process.argv[2] });
process.stdout.write(JSON.stringify(receipt) + '\\n');
process.exitCode = receipt.exitCode;
`;

export function linuxPreflightPlan({ checkout, runId, commit } = {}) {
  const root = resolve(checkout);
  if (/[:,\r\n\0]/.test(root) || !/^sleight-linux-[a-f0-9-]{36}$/.test(runId ?? '') || !shaPattern.test(commit ?? '')) {
    throw Error('Invalid container plan input');
  }
  return { command: 'docker', args: ['create', '--name', runId, '--label', `sleight.preflight=${runId}`,
    '--init', '--mount', `type=bind,source=${root},target=/source,readonly`, '--workdir', '/',
    'node:24', 'node', '--input-type=module', '-e', containerProgram, commit, runId] };
}

// Local Git only. Never copy the host .git, config, hooks, dependency symlink or credentials.
export async function prepareCheckout({ worktree, commit, stage, execute, signal }) {
  const checkout = join(stage, 'checkout');
  const env = { PATH: process.env.PATH, HOME: stage, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = async (cwd, args) => {
    const result = await execute('/usr/bin/git', args, { cwd, env, signal });
    if (result.status !== 0 || result.collected === false) throw Error('Exact checkout failed');
    return result.stdout;
  };
  const top = (await git(worktree, ['rev-parse', '--show-toplevel'])).trim();
  if (realpathSync(top) !== worktree || (await git(worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !== commit) throw Error('Source identity changed');
  await git(stage, ['init', '--quiet', checkout]);
  await git(checkout, ['-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-tags', '--depth=1', '--', worktree, commit]);
  await git(checkout, ['checkout', '--quiet', '--detach', commit]);
  rmSync(join(checkout, '.git', 'FETCH_HEAD'), { force: true });
  if ((await git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !== commit
    || !(await git(checkout, ['ls-files', '-z'])).endsWith('\0') || existsSync(join(checkout, 'node_modules'))) throw Error('Invalid prepared checkout');
  return checkout;
}

export async function runLinuxPreflight({ worktree = fileURLToPath(new URL('..', import.meta.url)), commit,
  execute = runOwnedCommand, signal, timeout = 1_200_000, log = text => process.stderr.write(text),
} = {}) {
  const result = { schemaVersion: 1, platform: 'linux', command: ['npm', 'test'], commit,
    executed: false, exitCode: 1, cleanupConfirmed: false, childCollected: true };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeout);
  let stage, attempted = false;
  const runId = `sleight-linux-${randomUUID()}`;
  result.runId = runId;
  const run = async (command, args, options = {}) => {
    const response = await execute(command, args, { ...options, signal: controller.signal });
    if (response.collected === false) result.childCollected = false;
    if (controller.signal.aborted || response.collected === false) throw Error('Cancelled or uncollected child');
    return response;
  };
  try {
    if (!shaPattern.test(commit ?? '')) throw Error('An exact commit is required');
    result.worktree = realpathSync(worktree);
    stage = mkdtempSync(join(tmpdir(), 'sleight-linux-'));
    const checkout = await prepareCheckout({ worktree: result.worktree, commit, stage, execute: run, signal: controller.signal });
    const plan = linuxPreflightPlan({ checkout, runId, commit });
    attempted = true;
    const created = await run(plan.command, plan.args, { cwd: stage, timeout: 120_000 });
    if (Number.isInteger(created.status) && created.status > 0) result.exitCode = created.status;
    const id = created.stdout?.trim();
    if (created.status !== 0 || !containerPattern.test(id ?? '')) throw Error('Container creation failed');
    result.containerId = id;
    const image = await run('docker', ['inspect', '--format', '{{.Image}}', id], { cwd: stage });
    if (Number.isInteger(image.status) && image.status > 0) result.exitCode = image.status;
    if (image.status !== 0 || !imagePattern.test(image.stdout?.trim() ?? '')) throw Error('Container image identity unavailable');
    result.imageId = image.stdout.trim();
    const tested = await run('docker', ['start', '--attach', id], { cwd: stage, timeout,
      log: { stderr: log } });
    if (Number.isInteger(tested.status) && tested.status > 0) result.exitCode = tested.status;
    const receipt = JSON.parse(tested.stdout);
    if (receipt?.schemaVersion === 1 && receipt.commit === commit && receipt.runId === runId) {
      for (const key of ['executed', 'dependencyMode', 'counts', 'trackedFiles']) result[key] = receipt[key];
      const failure = closedFailure(receipt.failure);
      if (failure) result.failure = failure;
    }
    if (!validExecution(receipt, { commit, runId }) || tested.status !== 0) {
      result.exitCode = Number.isInteger(tested.status) && tested.status > 0 ? tested.status
        : Number.isInteger(receipt?.exitCode) && receipt.exitCode > 0 ? receipt.exitCode : 1;
      throw Error('Linux tests failed');
    }
    Object.assign(result, receipt);
  } catch { result.exitCode ||= 1; }
  finally {
    if (attempted) {
      try {
        // Wait for the attach/create client before addressing only this unique owned name.
        const removed = await execute('docker', ['rm', '--force', '--volumes', runId], { timeout: 30_000 });
        const remaining = await execute('docker', ['container', 'ls', '-aq', '--no-trunc', '--filter', `name=^/${runId}$`], { timeout: 30_000 });
        result.cleanupConfirmed = result.childCollected && removed.collected !== false && remaining.collected !== false
          && remaining.status === 0 && remaining.stdout.trim() === '';
      } catch { result.cleanupConfirmed = false; }
    } else result.cleanupConfirmed = result.childCollected;
    if (!result.cleanupConfirmed || controller.signal.aborted) result.exitCode ||= 1;
    if (stage && result.cleanupConfirmed) {
      try { rmSync(stage, { recursive: true, force: true }); }
      catch { result.cleanupConfirmed = false; result.exitCode ||= 1; }
    } else if (stage) { result.stagingRetained = true; log(`Linux cleanup unconfirmed; private staging retained: ${stage}\n`); }
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (controller.signal.aborted) result.exitCode ||= 1;
  }
  return result;
}

export async function main(args = process.argv.slice(2), { log = text => process.stdout.write(text + '\n'),
  error = text => process.stderr.write(text + '\n'), signals = process, ...dependencies } = {}) {
  const options = {}, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!['--run', '--json', '--worktree', '--commit'].includes(arg) || seen.has(arg)) return 2;
    seen.add(arg);
    if (arg === '--worktree' || arg === '--commit') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) return 2;
      options[arg.slice(2)] = args[++i];
    }
  }
  if (!seen.has('--run') || !shaPattern.test(options.commit ?? '')) {
    error('Usage: node scripts/linux-preflight.mjs --run --json --commit SHA [--worktree PATH]');
    return 2;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signals.on('SIGINT', cancel); signals.on('SIGTERM', cancel);
  try {
    const receipt = await runLinuxPreflight({ ...dependencies, ...options, signal: controller.signal });
    log(JSON.stringify(receipt));
    return receipt.exitCode;
  } finally { signals.removeListener('SIGINT', cancel); signals.removeListener('SIGTERM', cancel); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
