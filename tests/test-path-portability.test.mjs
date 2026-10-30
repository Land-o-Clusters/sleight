import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { containerProgram, linuxPreflightPlan, runContainerChecks, runLinuxPreflight, parseLinuxReceipt,
  runOwnedCommand, testCounts, main } from '../scripts/linux-preflight.mjs';

const forbidden = [['', 'private', 'tmp'].join('/'), ['', 'Users', ''].join('/')];
const testsRoot = fileURLToPath(new URL('.', import.meta.url));

function pathViolations(root) {
  const hits = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`test path guard refuses symlink: ${relative(root, file)}`);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile()) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        for (const prefix of forbidden) {
          if (line.includes(prefix)) hits.push(`${relative(root, file)}:${index + 1}: ${prefix}`);
        }
      });
    }
  }
  walk(root);
  return hits;
}

test('path guard scans nested tests, fixtures, comments and every matching prefix without exemptions', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-path-guard-')));
  mkdirSync(join(root, 'fixtures'));
  writeFileSync(join(root, 'case.test.mjs'), `// ${forbidden[0]}/fixture\nconst x = '${forbidden[1]}fixture';\n`);
  writeFileSync(join(root, 'fixtures', 'case.json'), JSON.stringify({ path: forbidden.join(' and ') }));
  writeFileSync(join(root, 'portable.test.mjs'), "const dir = mkdtempSync(join(tmpdir(), 'case-'));\n");
  assert.deepEqual(pathViolations(root), [
    `case.test.mjs:1: ${forbidden[0]}`, `case.test.mjs:2: ${forbidden[1]}`,
    `fixtures/case.json:1: ${forbidden[0]}`, `fixtures/case.json:1: ${forbidden[1]}`,
  ]);
  symlinkSync(join(root, 'portable.test.mjs'), join(root, 'linked.test.mjs'));
  assert.throws(() => pathViolations(root), /refuses symlink: linked.test.mjs/);
});


const tap = '# tests 3\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n';
const commit = 'a'.repeat(40), id = 'd'.repeat(64), image = `sha256:${'e'.repeat(64)}`;
const ok = stdout => ({ status: 0, stdout, collected: true });
function containerOptions(overrides = {}) {
  const expected = overrides.commit ?? commit;
  return { platform: 'linux', commit, runId: 'sleight-linux-00000000-0000-0000-0000-000000000000',
    prepare() {}, makeConfig: () => '/container/config', removeConfig() {}, log() {},
    execute: async (command, args) => ok(command === 'npm' ? (args[0] === 'test' ? tap : '')
      : args[0] === 'rev-parse' ? expected : 'README.md\0'), ...overrides };
}

function sourceFixture(t) {
  const bank = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-linux-contract-'))));
  const primary = join(bank, 'primary'), worktree = join(bank, 'linked worktree $(never)');
  mkdirSync(primary);
  const git = (cwd, args) => {
    const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: bank, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(primary, ['init', '--quiet']);
  writeFileSync(join(primary, 'README.md'), 'fixture\n');
  writeFileSync(join(primary, 'package.json'), '{"name":"fixture","private":true}\n');
  git(primary, ['add', '--', 'README.md', 'package.json']);
  git(primary, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet',
    '-m', 'Fixture\n\nCo-Authored-By: GPT-6.1-sol (Codex lane) <noreply@openai.com>', '--', 'README.md', 'package.json']);
  const head = git(primary, ['rev-parse', 'HEAD']);
  git(primary, ['worktree', 'add', '--quiet', '--detach', worktree, head]);
  mkdirSync(join(bank, 'host-dependencies'));
  symlinkSync(join(bank, 'host-dependencies'), join(worktree, 'node_modules'));
  return { bank, primary, worktree, head, git };
}

// Real checkout producer and real container receipt producer; replace only Docker/npm process boundaries.
function dockerBoundary(fixture, overrides = {}) {
  const calls = [];
  let checkout, runId;
  const execute = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/git') return runOwnedCommand(command, args, options);
    assert.equal(command, 'docker');
    if (args[0] === 'create') {
      assert.equal(args[args.indexOf('--workdir') + 1], '/', 'Docker must not create the copy destination');
      runId = args[args.indexOf('--name') + 1];
      checkout = args[args.indexOf('--mount') + 1].match(/source=(.*),target=/)[1];
      assert.equal(existsSync(join(checkout, '.git', 'objects')), true);
      assert.equal(existsSync(join(checkout, '.git', 'FETCH_HEAD')), false);
      assert.equal(existsSync(join(checkout, 'node_modules')), false);
      assert.equal(fixture.git(checkout, ['rev-parse', 'HEAD']), fixture.head);
      assert.equal(fixture.git(checkout, ['ls-files']), 'README.md\npackage.json');
      assert.equal(fixture.git(checkout, ['remote']), '');
      assert.equal(readFileSync(join(checkout, 'README.md'), 'utf8'), 'fixture\n');
      assert.equal(existsSync(join(checkout, 'untracked-secret')), false);
      assert.equal(fixture.git(checkout, ['config', '--local', '--list']).includes('private-sentinel'), false);
      return overrides.create ? overrides.create(options) : ok(id + '\n');
    }
    if (args[0] === 'inspect') return ok(image);
    if (args[0] === 'start') {
      if (overrides.start) return overrides.start(options);
      // Exercise the container's real copy, Git reads and config cleanup on the host.
      // Only the platform observation and Docker/npm boundaries are simulated.
      const root = join(fixture.bank, 'container-workspace');
      assert.equal(existsSync(root), false);
      let config;
      const receipt = await runContainerChecks({ platform: 'linux', commit: fixture.head, runId,
        source: checkout, root, log() {}, execute: async (command, args, options) => {
          assert.equal(options.cwd, root);
          config = options.env.CLAUDE_CONFIG_DIR;
          assert.equal(existsSync(config), true);
          if (command === '/usr/bin/git') return runOwnedCommand(command, args, options);
          assert.equal(command, 'npm');
          return ok(args[0] === 'test' ? tap : '');
        } });
      assert.equal(existsSync(config), false);
      assert.equal(fixture.git(root, ['rev-parse', 'HEAD']), fixture.head);
      assert.equal(fixture.git(root, ['ls-files']), 'README.md\npackage.json');
      return { ...ok(JSON.stringify(receipt)), status: receipt.exitCode };
    }
    if (args[0] === 'rm') return overrides.remove ? overrides.remove(options) : ok(runId);
    if (args[0] === 'container') return overrides.remaining ? overrides.remaining(options) : ok('');
    throw Error('Unexpected process boundary');
  };
  return { execute, calls, checkout: () => checkout };
}

test('Linux exact checkout ignores dirty/untracked files and host dependencies, keeps Git metadata and source unchanged', async t => {
  const f = sourceFixture(t), h = dockerBoundary(f);
  writeFileSync(join(f.worktree, 'README.md'), 'uncommitted change\n');
  writeFileSync(join(f.worktree, 'untracked-secret'), 'not exported');
  f.git(f.worktree, ['config', '--local', 'fixture.private-sentinel', 'not exported']);
  const before = f.git(f.worktree, ['status', '--porcelain=v1']);
  const receipt = await runLinuxPreflight({ worktree: f.worktree, commit: f.head, execute: h.execute });
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.cleanupConfirmed, true);
  assert.equal(parseLinuxReceipt(JSON.stringify(receipt), { commit: f.head, worktree: f.worktree }).commit, f.head);
  assert.equal(f.git(f.worktree, ['status', '--porcelain=v1']), before);
  assert.equal(existsSync(h.checkout()), false);
  const create = h.calls.find(call => call.args[0] === 'create');
  assert.ok(create.args.includes(`type=bind,source=${h.checkout()},target=/source,readonly`));
  assert.deepEqual(h.calls.filter(c => c.command === 'docker').map(c => c.args[0]), ['create', 'inspect', 'start', 'rm', 'container']);
});

test('plan uses a readonly prepared checkout with fixed image, no host dependency mount or credentials', () => {
  const plan = linuxPreflightPlan({ checkout: resolve(tmpdir(), 'worktree with spaces $(never)'),
    runId: containerOptions().runId, commit });
  assert.equal(plan.command, 'docker');
  assert.equal(plan.args.filter(arg => arg === '--init').length, 1, 'Docker must provide the container init reaper');
  assert.ok(plan.args.indexOf('--init') < plan.args.indexOf('node:24'));
  assert.equal(plan.args[plan.args.indexOf('--workdir') + 1], '/', 'Docker must leave /w absent for the guarded copy');
  assert.ok(plan.args.includes('node:24'));
  assert.ok(plan.args.includes(containerProgram));
  assert.ok(plan.args.includes(`type=bind,source=${resolve(tmpdir(), 'worktree with spaces $(never)')},target=/source,readonly`));
  assert.equal(plan.args.includes('-v'), false);
  for (const checkout of [join(tmpdir(), 'bad:path'), join(tmpdir(), 'bad,path'), join(tmpdir(), 'bad\npath')]) {
    assert.throws(() => linuxPreflightPlan({ checkout, runId: containerOptions().runId, commit }));
  }
});

test('container producer verifies platform and Git, runs actual npm argv, captures counts and replaces Claude config', async () => {
  const calls = [], removed = [];
  const options = containerOptions({ env: { HOME: '/root', CLAUDE_CONFIG_DIR: '/inherited' }, removeConfig: dir => removed.push(dir) });
  const execute = options.execute;
  options.execute = async (...args) => { calls.push(args); return execute(...args); };
  const receipt = await runContainerChecks(options);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.executed, true);
  assert.deepEqual(receipt.counts, { tests: 3, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 1, todo: 0 });
  assert.deepEqual(calls.map(([command, args]) => [command, args]), [
    ['/usr/bin/git', ['rev-parse', '--verify', 'HEAD^{commit}']], ['/usr/bin/git', ['ls-files', '-z']],
    ['npm', ['test']],
  ]);
  for (const [, , options] of calls) {
    assert.equal(options.cwd, '/w');
    assert.equal(options.env.CLAUDE_CONFIG_DIR, '/container/config');
    assert.equal(options.env.HOME, '/container/config', 'the runtime home must be the owned disposable directory');
  }
  assert.deepEqual(removed, ['/container/config']);
});

test('public CI mode refuses installed dependencies and receipts from the old install leg', async t => {
  let npmCalls = 0;
  const options = containerOptions({ dependenciesPresent: () => true });
  const execute = options.execute;
  options.execute = async (command, ...args) => { if (command === 'npm') npmCalls++; return execute(command, ...args); };
  const refused = await runContainerChecks(options);
  assert.deepEqual(refused.failure, { stage: 'dependencies', code: 'present' });
  assert.equal(refused.executed, false);
  assert.equal(npmCalls, 0);
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-checkout-only-')));
  symlinkSync('absent', join(root, 'node_modules'));
  const linked = await runContainerChecks(containerOptions({ root }));
  assert.deepEqual(linked.failure, { stage: 'dependencies', code: 'present' });
  assert.equal(linked.executed, false);
  const receipt = { ...await runContainerChecks(containerOptions()), worktree: '/fixture',
    cleanupConfirmed: true, childCollected: true, containerId: id, imageId: image };
  assert.equal(parseLinuxReceipt(JSON.stringify(receipt), { commit, worktree: '/fixture' }).dependencyMode, 'checkout-only');
  delete receipt.dependencyMode;
  receipt.installExitCode = 0;
  assert.throws(() => parseLinuxReceipt(JSON.stringify(receipt), { commit, worktree: '/fixture' }), /Invalid Linux execution receipt/);
});

test('container rejects Mac, wrong Git commit, no tracked files, test failure, absent counts and thrown boundary', async () => {
  for (const override of [{ platform: 'darwin' }, { execute: async () => ok('wrong commit') },
    { execute: async (_c, args) => ok(args[0] === 'rev-parse' ? commit : '') },
    { execute: async (c, args) => c === 'npm' ? { status: 7 } : ok(args[0] === 'rev-parse' ? commit : 'README.md\0') },
    { execute: async (c, args) => c === 'npm' && args[0] === 'test' ? { status: 9, stdout: tap } : containerOptions().execute(c, args) },
    { execute: async (c, args) => c === 'npm' && args[0] === 'test' ? ok('') : containerOptions().execute(c, args) },
    { execute: async () => { throw Error('injected'); } }, { removeConfig() { throw Error('cleanup failed'); } }]) {
    assert.notEqual((await runContainerChecks(containerOptions(override))).exitCode, 0);
  }
  for (const text of ['', tap + '# pass 2\n', tap.replace('# tests 3', '# tests 4')]) assert.equal(testCounts(text), null);
});

test('serialized container program runs the same receipt producer with injected process boundary and stderr logs', async () => {
  const calls = [], logs = [], output = [], process = { env: { HOME: '/inherited-home' }, platform: 'linux', argv: ['node', commit, containerOptions().runId],
    stdout: { write: text => output.push(text) }, stderr: { write: text => logs.push(text) } };
  const source = containerProgram.replace(/^import .*;\n/gm, '');
  const spawn = (command, args, options) => {
    assert.equal(options.env.HOME, '/config', 'serialized Git/npm children must not inherit the image home');
    assert.equal(options.env.CLAUDE_CONFIG_DIR, '/config');
    calls.push([command, [...args]]);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', command === 'npm' ? (args[0] === 'test' ? tap : 'install log\n')
      : args[0] === 'rev-parse' ? commit : 'README.md\0'); child.emit('close', 0, null); });
    return child;
  };
  await runInNewContext(`(async () => {${source}})()`, { process, spawn, cpSync() {},
    lstatSync() { throw Object.assign(Error('absent'), { code: 'ENOENT' }); }, mkdtempSync: () => '/config', rmSync() {},
    tmpdir: () => '/temp', join, setTimeout, clearTimeout, queueMicrotask });
  const receipt = JSON.parse(output.join(''));
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.counts.tests, 3);
  assert.equal(calls.filter(([c]) => c === 'npm').length, 1);
  assert.doesNotMatch(logs.join(''), /install log/);
  assert.match(logs.join(''), /# tests 3/);
  assert.equal(output.length, 1);
});

test('parent cancellation waits for Docker client completion, removes only owned container, then confirms absence', async t => {
  const f = sourceFixture(t), controller = new AbortController();
  let collected = false;
  const h = dockerBoundary(f, { start: options => new Promise(resolveResult => {
    options.signal.addEventListener('abort', () => setTimeout(() => { collected = true; resolveResult({ status: null, collected: true }); }, 10), { once: true });
    controller.abort();
  }), remove: () => { assert.equal(collected, true); return ok(''); } });
  const receipt = await runLinuxPreflight({ worktree: f.worktree, commit: f.head, execute: h.execute, signal: controller.signal });
  assert.notEqual(receipt.exitCode, 0);
  assert.equal(receipt.cleanupConfirmed, true);
  assert.equal(existsSync(h.checkout()), false);
  const remove = h.calls.find(c => c.args[0] === 'rm');
  assert.deepEqual(remove.args, ['rm', '--force', '--volumes', receipt.runId]);
  assert.equal(h.calls.at(-1).args.at(-1), `name=^/${receipt.runId}$`);
});

test('Linux failures preserve actual test statuses and counts after confirmed cleanup', async t => {
  for (const [testStatus, output] of [[9, tap], [0, ''],
    [0, tap.replace('# pass 2', '# pass 1').replace('# fail 0', '# fail 1')]]) {
    const f = sourceFixture(t);
    const h = dockerBoundary(f, { start: async () => {
      const producer = await runContainerChecks(containerOptions({ commit: f.head,
        runId: h.calls.find(c => c.args[0] === 'create').args[2],
        execute: async (c, args) => c === 'npm' ? { status: testStatus, stdout: output }
          : ok(args[0] === 'rev-parse' ? f.head : 'README.md\0') }));
      return { ...ok(JSON.stringify(producer)), status: producer.exitCode };
    } });
    const receipt = await runLinuxPreflight({ worktree: f.worktree, commit: f.head, execute: h.execute });
    assert.notEqual(receipt.exitCode, 0);
    assert.equal(receipt.cleanupConfirmed, true);
    assert.equal(receipt.dependencyMode, 'checkout-only');
    assert.equal(receipt.executed, true);
    if (testStatus) assert.equal(receipt.exitCode, testStatus);
    if (output === '') assert.equal(receipt.counts, null);
  }
});

test('Linux preserves Docker startup status even when no JSON receipt was produced', async t => {
  for (const [operation, status] of [['create', 125], ['start', 23]]) {
    const f = sourceFixture(t), h = dockerBoundary(f, { [operation]: () => ({ status, stdout: '', collected: true }) });
    const receipt = await runLinuxPreflight({ worktree: f.worktree, commit: f.head, execute: h.execute });
    assert.equal(receipt.exitCode, status);
    assert.equal(receipt.cleanupConfirmed, true);
  }
});

test('helper timeout cancels the Docker attach and awaits owned cleanup', async t => {
  const f = sourceFixture(t), h = dockerBoundary(f, { start: options => new Promise(resolveResult => {
    options.signal.addEventListener('abort', () => resolveResult({ status: null, collected: true }), { once: true });
  }) });
  const receipt = await runLinuxPreflight({ worktree: f.worktree, commit: f.head, execute: h.execute, timeout: 700 });
  assert.notEqual(receipt.exitCode, 0);
  assert.equal(receipt.cleanupConfirmed, true);
  assert.deepEqual(h.calls.filter(c => c.command === 'docker').slice(-3).map(c => c.args[0]), ['start', 'rm', 'container']);
});

test('cancellation during container creation still collects by unique name', async t => {
  const f = sourceFixture(t), controller = new AbortController();
  const h = dockerBoundary(f, { create: () => { controller.abort(); return ok(id); } });
  const receipt = await runLinuxPreflight({ worktree: f.worktree, commit: f.head, execute: h.execute, signal: controller.signal });
  assert.notEqual(receipt.exitCode, 0);
  assert.equal(receipt.cleanupConfirmed, true);
  assert.equal(h.calls.some(c => c.args[0] === 'start'), false);
  assert.equal(h.calls.at(-2).args[0], 'rm');
});

test('unconfirmed cleanup or uncollected client fails and retains staging', async t => {
  for (const overrides of [{ remaining: () => ok(id) }, { remaining: () => ({ status: 1, stdout: '' }) },
    { start: () => ({ status: null, collected: false }) }]) {
    const f = sourceFixture(t), h = dockerBoundary(f, overrides), logs = [];
    const receipt = await runLinuxPreflight({ worktree: f.worktree, commit: f.head, execute: h.execute, log: text => logs.push(text) });
    assert.notEqual(receipt.exitCode, 0);
    assert.equal(receipt.cleanupConfirmed, false);
    assert.equal(receipt.stagingRetained, true);
    assert.equal(existsSync(h.checkout()), true);
    assert.match(logs.join(''), /staging retained/);
    // The fake Docker boundary has no process/container. Register its retained fixture for test cleanup.
    registerTemp(t, resolve(h.checkout(), '..'));
  }
});

test('CLI requires execution and exact commit, emits one real producer receipt, and forwards parent signal', async t => {
  for (const args of [[], ['--json'], ['--run'], ['--run', '--commit', 'HEAD'], ['--plan'], ['--run', '--run']]) {
    assert.notEqual(await main(args, { error() {} }), 0);
  }
  const f = sourceFixture(t), signals = new EventEmitter(), output = [];
  const h = dockerBoundary(f, { start: options => new Promise(resolveResult => {
    options.signal.addEventListener('abort', () => resolveResult({ status: null, collected: true }), { once: true });
    signals.emit('SIGTERM');
  }) });
  const status = await main(['--run', '--json', '--commit', f.head, '--worktree', f.worktree],
    { execute: h.execute, signals, log: text => output.push(text) });
  assert.notEqual(status, 0);
  assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0]).cleanupConfirmed, true);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('Linux CLI success emits one complete commit-bound producer receipt', async t => {
  const f = sourceFixture(t), h = dockerBoundary(f), output = [], signals = new EventEmitter();
  assert.equal(await main(['--run', '--json', '--commit', f.head, '--worktree', f.worktree],
    { execute: h.execute, signals, log: text => output.push(text) }), 0);
  assert.equal(output.length, 1);
  assert.equal(parseLinuxReceipt(output[0], { commit: f.head, worktree: f.worktree }).cleanupConfirmed, true);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('owned process boundary collects a harmless child after abort and reports startup failure', async () => {
  const controller = new AbortController();
  const pending = runOwnedCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.collected, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.status, null);
  assert.equal((await runOwnedCommand('/no-such-executable', [])).status, null);
});

test('tests contain no hardcoded macOS temporary or home paths', () => {
  const hits = pathViolations(testsRoot);
  assert.equal(hits.length, 0, `Use os.tmpdir() for real filesystem paths. Construct platform-specific adversarial data explicitly.\n${hits.join('\n')}`);
});
