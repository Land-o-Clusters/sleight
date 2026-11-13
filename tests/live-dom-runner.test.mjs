import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { validateRequest, testEnvironment, tapReport, createRunner, runCommand } from '../scripts/live-dom-runner.mjs';

const commit = 'a'.repeat(40);
const request = { branch: 'codex/forms', commit, tests: ['tests/fill-form.test.mjs', 'bench/direct-native/test/controls.test.mjs'], timeoutMs: 1000 };
async function fixture(t, options = {}) {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-dom-runner-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  await mkdir(join(root, 'repository', 'node_modules'), { recursive: true });
  let active = 0, peak = 0;
  const command = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (file === '/usr/bin/git') {
      const phase = args.includes('--git-common-dir') ? 'common' : args.includes('rev-parse') ? 'resolve'
        : args.includes('merge-base') ? 'reachability' : args.includes('add') ? 'checkout' : 'remove';
      if (options.gitFault === phase && !calls.some(c => c.fault)) {
        calls.at(-1).fault = true;
        throw Object.assign(Error('synthetic owned Git group collection unconfirmed'), { cleanupUnconfirmed: true, groupPid: 12345 });
      }
      if (args.includes('merge-base') && options.remoteUnreachable && args.at(-1).startsWith('refs/remotes/')) {
        return { exitCode: 1, stdout: '', stderr: 'remote ref not reachable' };
      }
      if (args.includes('--git-common-dir')) return { exitCode: 0, stdout: join(root, 'repository', '.git') + '\n', stderr: '' };
      if (args.includes('rev-parse')) return { exitCode: 0, stdout: (options.wrongCommit ? 'b'.repeat(40) : commit) + '\n', stderr: '' };
      if (args.includes('merge-base') && options.wrongBranch) return { exitCode: 1, stdout: '', stderr: 'not reachable' };
      if (args.includes('add')) {
        const worktree = args.at(-2);
        for (const path of request.tests) {
          await mkdir(join(worktree, path, '..'), { recursive: true });
          await writeFile(join(worktree, path), options.headedSource ? 'chromium.launch({ headless: false });' : 'import { test } from "node:test"; test("fixture", () => {});');
        }
        if (options.symlinkTest) {
          await rm(join(worktree, request.tests[0]));
          await symlink(join(root, 'outside.mjs'), join(worktree, request.tests[0]));
        }
      }
      if (args.includes('remove') && options.cleanupFail) return { exitCode: 1, stdout: '', stderr: 'cleanup refused' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    if (options.testThrows) throw new Error('test spawn failed');
    if (options.collectionThrows) throw Object.assign(Error('owned group cleanup unconfirmed'), { cleanupUnconfirmed: true });
    return { groupCollected: !options.collectionFalse, exitCode: options.exitCode ?? 0, stdout: 'TAP version 13\nok 1 - fixture\nok 2 - optional # SKIP missing playwright\n1..2\n# tests 2\n# pass 1\n# fail 0\n# skipped 1\n', stderr: '', timedOut: options.timedOut ?? false };
  };
  const folder = join(root, 'queue');
  const runner = createRunner({ folder, repository: join(root, 'repository'), temporaryRoot: root, command, environment: { PATH: '/usr/bin', HOME: root }, waitForHold: options.hold ?? (async () => {}) });
  return { root, folder, calls, runner, peak: () => peak };
}

test('request accepts only exact commits, named branches, test files and bounded timeouts', () => {
  assert.deepEqual(validateRequest(request), request);
  for (const patch of [
    { commit: 'HEAD' }, { branch: '--upload-pack=evil' }, { tests: ['../tests/a.test.mjs'] },
    { tests: ['tests/../scripts/a.test.mjs'] }, { tests: ['/tests/a.test.mjs'] },
    { tests: ['tests/-r'] }, { tests: ['bench/run.mjs'] }, { tests: ['bench/test/a.test.mjs'] },
    { tests: [] }, { tests: [...request.tests, request.tests[0]] }, { timeoutMs: 0 },
    { timeoutMs: 600001 }, { timeoutMs: 1.5 }, { command: 'open' },
  ]) assert.throws(() => validateRequest({ ...request, ...patch }));
});

test('test environment refuses headed switches and drops host Claude, Node and engine controls', () => {
  for (const env of [{ SLEIGHT_TURBO_HEADED: '1' }, { PWDEBUG: '1' }, { PLAYWRIGHT_HEADLESS: 'false' }, { SLEIGHT_HEADLESS: '0' }]) {
    assert.throws(() => testEnvironment(env, '/tmp/config'), /headed/i);
  }
  const env = testEnvironment({ PATH: '/usr/bin', HOME: '/home/fixture', CLAUDE_CODE_SESSION_ID: 'secret', NODE_OPTIONS: '--require evil', CUA_PATH: 'engine', SLEIGHT_TURBO_HEADED: '0' }, '/tmp/config');
  assert.equal(env.SLEIGHT_LIVE_DOM_TEST, '1');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/config');
  assert.equal(env.SLEIGHT_TURBO_HEADED, '0');
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'NODE_OPTIONS', 'CUA_PATH']) assert.equal(env[name], undefined);
});

test('TAP receipt keeps summaries, skip reasons and only the final 200 bounded lines', () => {
  const tap = Array.from({ length: 250 }, (_, n) => `# log ${n}`).join('\n') + '\nok 1 - optional # SKIP no chromium\n# tests 1\n# pass 0\n# fail 0\n# skipped 1\n';
  const report = tapReport(tap);
  assert.deepEqual(report.summary, { tests: 1, pass: 0, fail: 0, skipped: 1 });
  assert.deepEqual(report.skipReasons, ['no chromium']);
  assert.equal(report.lastLines.length, 200);
  assert.ok(!report.lastLines.includes('# log 0'));
  assert.ok(tapReport('x'.repeat(100000)).lastLines[0].length <= 2000);
});

test('queue checks out the exact commit, links dependencies, executes a fixed argv, publishes and cleans up', async t => {
  const f = await fixture(t);
  await f.runner.initialize();
  await writeFile(join(f.folder, 'requests', 'one.json'), JSON.stringify(request));
  const result = await f.runner.poll();
  assert.equal(result.id, 'one');
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanedUp, true);
  assert.equal(result.summary.pass, 1);
  assert.deepEqual(result.skipReasons, ['missing playwright']);
  assert.equal(JSON.parse(await readFile(join(f.folder, 'results', 'one.json'))).commit, commit);
  const checkout = f.calls.find(c => c.args.includes('add'));
  assert.deepEqual(checkout.args.slice(-4), ['add', '--detach', checkout.args.at(-2), commit]);
  const run = f.calls.find(c => c.file === process.execPath);
  assert.deepEqual(run.args, ['--test', '--test-reporter=tap', ...request.tests]);
  assert.equal(run.opts.env.SLEIGHT_LIVE_DOM_TEST, '1');
  assert.equal(run.opts.timeoutMs, request.timeoutMs);
  assert.equal(await readFile(join(f.folder, 'results', 'one.json'), 'utf8').then(text => text.includes(f.root)), false);
  assert.ok(f.calls.some(c => c.args.includes('remove')));
  assert.equal(await f.runner.poll(), null, 'result is not executed twice');
  await f.runner.close();
  assert.deepEqual((await readdir(f.root)).sort(), ['queue', 'repository']);
});

test('concurrent polls serialize requests and a second host cannot own the same queue', async t => {
  const f = await fixture(t);
  await f.runner.initialize();
  const second = createRunner({ folder: f.folder });
  await assert.rejects(second.initialize(), /owned|EEXIST/);
  for (const id of ['a', 'b']) await writeFile(join(f.folder, 'requests', `${id}.json`), JSON.stringify(request));
  const results = await Promise.all([f.runner.poll(), f.runner.poll()]);
  assert.deepEqual(results.map(r => r.id), ['a', 'b']);
  assert.equal(f.peak(), 1);
  await f.runner.close();
});

test('malformed requests and symlink tests produce failures without executing a test command', async t => {
  const f = await fixture(t, { symlinkTest: true });
  await f.runner.initialize();
  await writeFile(join(f.folder, 'requests', 'bad.json'), '{');
  assert.equal((await f.runner.poll()).exitCode, 1);
  await writeFile(join(f.folder, 'requests', 'link.json'), JSON.stringify(request));
  assert.match((await f.runner.poll()).error, /symlink|regular/i);
  assert.ok(!f.calls.some(c => c.file === process.execPath));
  await f.runner.close();
});

for (const [name, options] of [['test error', { testThrows: true }], ['timeout', { timedOut: true, exitCode: 124 }], ['failed test', { exitCode: 1 }]]) {
  test(`${name} still publishes a failure and removes the checkout`, async t => {
    const f = await fixture(t, options);
    await f.runner.initialize();
    await writeFile(join(f.folder, 'requests', 'failure.json'), JSON.stringify(request));
    const result = await f.runner.poll();
    assert.ok(result.exitCode !== 0);
    assert.equal(result.cleanedUp, true);
    if (options.timedOut) assert.equal(result.timedOut, true);
    await f.runner.close();
  });
}

test('unconfirmed checkout cleanup keeps the runner lock and stops the queue', async t => {
  const f = await fixture(t, { cleanupFail: true });
  await f.runner.initialize();
  await writeFile(join(f.folder, 'requests', 'one.json'), JSON.stringify(request));
  const result = await f.runner.poll();
  assert.equal(result.cleanedUp, false);
  assert.ok(result.exitCode !== 0);
  await assert.rejects(f.runner.poll(), /cleanup/i);
  await assert.rejects(f.runner.close(), /cleanup/i);
});

for (const phase of ['resolve', 'reachability', 'checkout', 'common', 'remove'])
  test('unproved Git group collection stops the queue at ' + phase, async t => {
    const f = await fixture(t, { gitFault: phase });
    await f.runner.initialize();
    await writeFile(join(f.folder, 'requests', 'fault.json'), JSON.stringify(request));
    const result = await f.runner.poll();
    assert.equal(result.exitCode, 1); assert.equal(result.groupCollected, false); assert.equal(result.cleanedUp, false);
    assert.equal(result.groupPid, 12345);
    const fault = f.calls.findIndex(c => c.fault);
    assert.equal(f.calls.length, fault + 1, 'nothing runs after collection is unproved');
    const hasBank = ['checkout', 'common', 'remove'].includes(phase);
    assert.equal(typeof result.worktree === 'string', hasBank);
    assert.equal(typeof result.bank === 'string', hasBank);
    assert.equal((await readdir(f.root)).some(name => name.startsWith('sleight-live-dom-')), hasBank);
    assert.deepEqual(JSON.parse(await readFile(join(f.folder, 'results', 'fault.json'))), result);
    await access(join(f.folder, '.runner-lock'));
    await assert.rejects(f.runner.poll(), /cleanup/); await assert.rejects(f.runner.close(), /cleanup/);
    assert.equal(f.calls.length, fault + 1, 'poll and close cannot start another owned command');
  });

test('an ordinary unreachable remote ref falls back to the reachable local branch', async t => {
  const f = await fixture(t, { remoteUnreachable: true });
  await f.runner.initialize();
  await writeFile(join(f.folder, 'requests', 'local.json'), JSON.stringify(request));
  const result = await f.runner.poll();
  assert.equal(result.exitCode, 0); assert.equal(result.cleanedUp, true); assert.equal(result.groupCollected, true);
  assert.deepEqual(f.calls.filter(c => c.args.includes('merge-base')).map(c => c.args.at(-1)),
    ['refs/remotes/private/codex/forms', 'refs/heads/codex/forms']);
  await f.runner.close();
});

for (const [name, options, message] of [
  ['wrong commit', { wrongCommit: true }, /resolution differed/],
  ['unreachable branch', { wrongBranch: true }, /not on the requested branch/],
  ['headed source', { headedSource: true }, /headed launch/],
]) {
  test(`${name} is rejected before the test command`, async t => {
    const f = await fixture(t, options);
    await f.runner.initialize();
    await writeFile(join(f.folder, 'requests', 'rejected.json'), JSON.stringify(request));
    const result = await f.runner.poll();
    assert.match(result.error, message);
    assert.equal(result.exitCode, 1);
    assert.ok(!f.calls.some(c => c.file === process.execPath));
    await f.runner.close();
  });
}

test('hold finishes before test launch and stop while held cleans up without launching', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const hold = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const f = await fixture(t, { hold });
  await f.runner.initialize();
  await writeFile(join(f.folder, 'requests', 'hold.json'), JSON.stringify(request));
  const pending = f.runner.poll();
  await started;
  assert.ok(!f.calls.some(c => c.file === process.execPath));
  f.runner.stop(); release();
  const result = await pending;
  assert.match(result.error, /stopped/);
  assert.equal(result.cleanedUp, true);
  assert.ok(!f.calls.some(c => c.file === process.execPath));
  await f.runner.close();
});

test('owned fake test process is capped and its TAP output is collected before return', { timeout: 5000 }, async () => {
  const result = await runCommand(process.execPath, ['-e', 'console.log("TAP version 13"); setInterval(() => {}, 1000)'], { timeoutMs: 100, env: { PATH: process.env.PATH } });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.match(result.stdout, /TAP version 13/);
});


for (const mode of ['ordinary', 'ignores TERM', 'inherits pipes']) {
  test(`natural test exit collects its same-group descendant: ${mode}`, { skip: process.platform === 'win32' ? 'POSIX process groups required' : false, timeout: 5000 }, async t => {
    const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-dom-runner-child-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const marker = join(root, 'descendant-ran-after-return');
    const source = (mode === 'ignores TERM' ? "process.on('SIGTERM', () => {});" : '') +
      `console.log('ready'); setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'synthetic'); }, 800);`;
    const parent = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(source)}],
      {stdio:['ignore','pipe',${JSON.stringify(mode === 'inherits pipes' ? 'inherit' : 'ignore')}]});
      child.stdout.once('data', () => { child.stdout.destroy(); child.unref(); process.exit(0); });`;
    const result = await runCommand(process.execPath, ['-e', parent], { timeoutMs: 2000, env: { PATH: process.env.PATH } });
    assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false);
    await new Promise(resolve => setTimeout(resolve, 900));
    await assert.rejects(access(marker), { code: 'ENOENT' });
  });
}

for (const cause of ['collectionThrows', 'collectionFalse']) {
  test(`unproved test-group collection retains the checkout, bank and queue lock: ${cause}`, async t => {
    const f = await fixture(t, { [cause]: true });
    await f.runner.initialize();
    await writeFile(join(f.folder, 'requests', 'retained.json'), JSON.stringify(request));
    const result = await f.runner.poll();
    assert.equal(result.cleanedUp, false); assert.equal(result.exitCode, 1);
    assert.ok(!f.calls.some(c => c.args.includes('remove')));
    assert.ok((await readdir(f.root)).some(name => name.startsWith('sleight-live-dom-')));
    await assert.rejects(f.runner.poll(), /cleanup/); await assert.rejects(f.runner.close(), /cleanup/);
    await access(join(f.folder, '.runner-lock'));
  });
}

for (const cause of ['throw', 'false']) {
  test(`command collection refusal cannot become a success receipt: ${cause}`, async () => {
    await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 2000,
      collect: async () => { if (cause === 'throw') throw Error('synthetic collection refusal'); return false; },
    }), error => error.cleanupUnconfirmed === true && Number.isSafeInteger(error.groupPid));
  });
}
