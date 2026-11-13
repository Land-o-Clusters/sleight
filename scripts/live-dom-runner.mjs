// Host-side, reviewed-test runner. Start this outside lane sandboxes; never from a lane.
// Requests are data, not commands. Test code at the requested commit remains trusted code.
import { spawn } from 'node:child_process';
import { collectOwnedGroup } from '../plugins/sleight/lib/owned-group.mjs';
import { constants } from 'node:fs';
import { open, mkdir, mkdtemp, lstat, stat, readFile, writeFile, readdir, rename, rm, rmdir, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 512_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['branch', 'commit', 'tests', 'timeoutMs'].includes(key))) {
    throw new Error('request must contain only branch, commit, tests and timeoutMs');
  }
  const { branch, commit, tests, timeoutMs } = value;
  if (typeof branch !== 'string' || branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9_/-]*$/.test(branch)
    || branch.includes('//') || branch.endsWith('/')) throw new Error('branch must be a named branch');
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('commit must be an exact 40-character SHA');
  if (!Array.isArray(tests) || tests.length < 1 || tests.length > 30 || new Set(tests).size !== tests.length) {
    throw new Error('tests must contain 1 to 30 distinct test paths');
  }
  for (const path of tests) {
    if (typeof path !== 'string' || path.length > 300 || !/^[A-Za-z0-9_./-]+$/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..')
      || !/^(?:tests\/.+|bench\/[^/]+(?:\/[^/]+)*\/test\/.+)\.test\.mjs$/.test(path)) {
      throw new Error('only .test.mjs files under tests/ or bench/*/test/ are allowed');
    }
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) {
    throw new Error(`timeoutMs must be 1 to ${MAX_TIMEOUT}`);
  }
  return { branch, commit, tests: [...tests], timeoutMs };
}

export function testEnvironment(environment, config) {
  for (const [key, value] of Object.entries(environment)) {
    if (/HEADLESS/i.test(key) && !['', '1', 'true'].includes(String(value).toLowerCase())
      || /HEADED|PWDEBUG/i.test(key) && !['', '0', 'false'].includes(String(value).toLowerCase())) {
      throw new Error(`headed browser control is forbidden: ${key}`);
    }
  }
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PLAYWRIGHT_BROWSERS_PATH']) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }
  return { ...env, CLAUDE_CONFIG_DIR: config, SLEIGHT_LIVE_DOM_TEST: '1', SLEIGHT_TURBO_HEADED: '0' };
}

export function tapReport(text) {
  const summary = {}, skipReasons = [];
  const lines = text.trimEnd().split('\n');
  for (const line of lines) {
    const count = line.match(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/);
    if (count) summary[count[1]] = Number(count[2]);
    const skip = line.match(/^\s*(?:not )?ok\b.*?# SKIP\s*(.*)$/i);
    if (skip && skipReasons.length < 200) skipReasons.push(skip[1].slice(0, 2000));
  }
  return { summary, skipReasons, lastLines: lines.slice(-200).map(line => line.slice(0, 2000)) };
}

// Own only the detached group started here. Begin collection on leader exit,
// before pipe closure, because descendants can retain stdout or stderr.
export function runCommand(file, args, { cwd, env, timeoutMs = 30_000, signal,
  collect = collectOwnedGroup } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, aborted = false, collection, spawnError, settled = false;
    const append = (previous, data) => (previous + data.toString()).slice(-MAX_OUTPUT);
    child.stdout.on('data', data => { stdout = append(stdout, data); });
    child.stderr.on('data', data => { stderr = append(stderr, data); });
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const beginCollection = () => {
      collection ??= Promise.resolve().then(async () => {
        if (process.platform === 'win32') {
          if (child.pid) child.kill('SIGTERM');
          throw new Error('POSIX group collection requires a supported host');
        }
        if (await collect(child.pid, { graceMs: 250 }) === false) throw new Error('collection refused');
      });
      // Collection failure settles the caller even if inherited pipes remain
      // open. The queue retains the checkout and excludes another request.
      collection.catch(error => finish(Object.assign(new Error(`owned group cleanup unconfirmed: ${error?.message ?? 'collection refused'}`),
        { cleanupUnconfirmed: true, groupPid: child.pid })));
      return collection;
    };
    const abort = () => { aborted = true; beginCollection(); };
    const timer = setTimeout(() => { timedOut = true; beginCollection(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', error => {
      spawnError = error;
      beginCollection().then(() => finish(error), () => {});
    });
    child.once('exit', () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      beginCollection();
    });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      beginCollection().then(() => finish(spawnError, {
        exitCode: timedOut ? 124 : aborted ? 130 : (code ?? 1), signal: exitSignal,
        timedOut, aborted, groupCollected: true, stdout, stderr,
      }), () => {});
    });
  });
}

async function ordinary(path, directory = false) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`expected a regular ${directory ? 'directory' : 'file'}, never a symlink: ${path}`);
  }
}

async function readRequest(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64_000) throw new Error('request must be a regular JSON file under 64 KB');
    return validateRequest(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}

async function waitForHold(signal) {
  while (true) {
    try { await lstat('/tmp/sleight-hold'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (signal?.aborted) throw new Error('runner stopped while waiting for sleight-hold');
    await sleep(1000);
  }
}

export function createRunner({
  folder = join(homedir(), 'Projects/sleight-wt/ledger/live-dom'),
  repository = fileURLToPath(new URL('..', import.meta.url)),
  temporaryRoot = tmpdir(), command = runCommand, environment = process.env,
  waitForHold: hold = waitForHold,
} = {}) {
  folder = resolve(folder); repository = resolve(repository);
  const requests = join(folder, 'requests'), results = join(folder, 'results'), lock = join(folder, '.runner-lock');
  const controller = new AbortController();
  let owned = false, broken = false, stopping = false, chain = Promise.resolve();
  const gitEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(k => environment[k] !== undefined).map(k => [k, environment[k]]));
  const scrub = text => String(text).replaceAll(environment.HOME || homedir(), '~').replaceAll(homedir(), '~');
  const git = async (args, signal) => {
    const result = await command('/usr/bin/git', ['-C', repository, ...args], { env: gitEnv, timeoutMs: 30_000, signal });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  const initialize = async () => {
    testEnvironment(environment, '/unused'); // Refuse headed host controls before accepting requests.
    for (const path of [folder, requests, results]) {
      await mkdir(path, { recursive: true }); await ordinary(path, true);
    }
    await mkdir(lock); owned = true;
    await writeFile(join(lock, 'OWNER'), `pid ${process.pid}\n${new Date().toISOString()}\n`, { flag: 'wx' });
  };
  const execute = async id => {
    let request, bank, worktree, attemptedCheckout = false;
    const result = { id, exitCode: 1, summary: {}, skipReasons: [], lastLines: [], timedOut: false, cleanedUp: true };
    const retainOwnership = error => {
      result.exitCode = 1; result.groupCollected = false; result.cleanedUp = false; broken = true;
      result.cleanupError = scrub(error.message);
      if (Number.isSafeInteger(error.groupPid)) result.groupPid = error.groupPid;
      if (worktree) result.worktree = scrub(worktree);
      if (bank) result.bank = scrub(bank);
    };
    try {
      request = await readRequest(join(requests, `${id}.json`));
      Object.assign(result, request);
      const sha = await git(['rev-parse', '--verify', `${request.commit}^{commit}`], controller.signal);
      if (sha !== request.commit) throw new Error('commit resolution differed from request');
      let reachable = false;
      for (const ref of [`refs/remotes/private/${request.branch}`, `refs/heads/${request.branch}`]) {
        try { await git(['merge-base', '--is-ancestor', request.commit, ref], controller.signal); reachable = true; break; }
        catch (error) { if (error.cleanupUnconfirmed || controller.signal.aborted) throw error; }
      }
      if (!reachable) throw new Error('commit is not on the requested branch; owner must fetch private first');
      bank = await mkdtemp(join(temporaryRoot, 'sleight-live-dom-'));
      worktree = join(bank, 'worktree'); attemptedCheckout = true;
      await git(['worktree', 'add', '--detach', worktree, request.commit], controller.signal);
      for (const path of request.tests) {
        let current = worktree;
        const parts = path.split('/');
        for (let n = 0; n < parts.length; n++) {
          current = join(current, parts[n]); await ordinary(current, n < parts.length - 1);
        }
        const source = await readFile(current, 'utf8');
        if (/\bheadless\s*:\s*false\b|--headed\b/.test(source)) throw new Error(`headed launch in test: ${path}`);
      }
      // Link the primary checkout's dependency bank, even when this script is run from a linked worktree.
      const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], controller.signal);
      const modules = join(dirname(common), 'node_modules');
      if (!(await stat(modules)).isDirectory()) throw new Error('primary node_modules bank is missing');
      await symlink(modules, join(worktree, 'node_modules'));
      const config = join(bank, 'claude'); await mkdir(config);
      await hold(controller.signal);
      if (stopping) throw new Error('runner stopped before test launch');
      const run = await command(process.execPath, ['--test', '--test-reporter=tap', ...request.tests], {
        cwd: worktree, env: testEnvironment(environment, config), timeoutMs: request.timeoutMs, signal: controller.signal,
      });
      if (run.groupCollected !== true) throw Object.assign(new Error('owned test group collection unconfirmed'), { cleanupUnconfirmed: true });
      result.groupCollected = true;
      result.exitCode = run.exitCode;
      result.timedOut = Boolean(run.timedOut);
      Object.assign(result, tapReport(scrub(`${run.stdout}\n${run.stderr}`)));
    } catch (error) {
      result.error = scrub(error.message);
      if (error.cleanupUnconfirmed) retainOwnership(error);
    }
    finally {
      if (attemptedCheckout && result.cleanedUp) {
        try { await git(['worktree', 'remove', '--force', worktree]); }
        catch (error) {
          if (error.cleanupUnconfirmed) retainOwnership(error);
          result.cleanedUp = false; result.cleanupError = scrub(error.message);
          result.worktree = scrub(worktree); result.exitCode = 1; broken = true;
        }
      }
      if (bank && result.cleanedUp) {
        try { await rm(bank, { recursive: true, force: true }); }
        catch (error) {
          result.cleanedUp = false; result.cleanupError = scrub(error.message);
          result.exitCode = 1; broken = true;
        }
      }
    }
    const temporary = join(results, `.tmp-${id}-${process.pid}`);
    await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, join(results, `${id}.json`));
    return result;
  };
  const poll = () => {
    const next = chain.then(async () => {
      if (!owned) throw new Error('runner does not own the queue');
      if (broken) throw new Error('checkout cleanup unconfirmed; retaining runner lock');
      if (stopping) return null;
      const completed = new Set(await readdir(results));
      const pending = (await readdir(requests)).filter(name => name.endsWith('.json')
        && ID.test(name.slice(0, -5)) && !completed.has(name)).sort();
      return pending.length ? execute(pending[0].slice(0, -5)) : null;
    });
    chain = next.catch(() => {});
    return next;
  };
  const stop = () => { stopping = true; controller.abort(); };
  const close = async () => {
    stopping = true; await chain;
    if (broken) throw new Error('checkout cleanup unconfirmed; retaining runner lock');
    if (owned) { await rm(join(lock, 'OWNER')); await rmdir(lock); owned = false; }
  };
  return { initialize, poll, stop, close };
}

export async function main(argv = process.argv.slice(2)) {
  let folder, once = false;
  for (let n = 0; n < argv.length; n++) {
    if (argv[n] === '--folder' && argv[n + 1]) folder = argv[++n];
    else if (argv[n] === '--once') once = true;
    else throw new Error('usage: node scripts/live-dom-runner.mjs [--folder PATH] [--once]');
  }
  const runner = createRunner({ folder });
  await runner.initialize();
  let stopping = false;
  const stop = () => { stopping = true; runner.stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    do {
      const result = await runner.poll();
      if (result) process.stdout.write(`${result.id}: exit ${result.exitCode}, cleanup ${result.cleanedUp}\n`);
      if (!result && !once && !stopping) await sleep(1000);
    } while (!once && !stopping);
  } finally {
    await runner.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
