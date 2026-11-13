import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOLD, LIVE_LOCK, checkoutBlock, hubIsFresh, isHubPath, main, pendingChanges, refreshHub, skipReason } from '../bench/hub-refresh.mjs';
import { child } from '../bench/validation/validation-140.mjs';
import { workflowEnvironment } from '../bench/validation/workflow-docs-ab.mjs';
import { runStage } from '../bench/release-pass.mjs';
const MAC_TMP = ['', 'private', 'tmp'].join('/');

const ROOT = new URL('..', import.meta.url).pathname;
const read = file => readFileSync(join(ROOT, file), 'utf8');
const tmp = t => { const dir = mkdtempSync(join(tmpdir(), 'hub-refresh-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const none = () => false;

test('the hub is skipped for a failed pass, a dry run, --no-hub, SLEIGHT_NO_HUB, a missing results folder, a live lock or a hold', () => {
  assert.equal(skipReason({ checkout: null, exists: none }), null);
  assert.equal(skipReason({ checkout: null, exitCode: 0, saved: '/x', exists: path => path === '/x' }), null);
  assert.match(skipReason({ checkout: null, exitCode: 1, exists: none }), /did not succeed \(exit 1\)/);
  assert.match(skipReason({ checkout: null, exitCode: 130, exists: none }), /exit 130/);
  assert.match(skipReason({ checkout: null, dryRun: true, exists: none }), /dry run/);
  assert.match(skipReason({ checkout: null, noHub: true, exists: none }), /no-hub/);
  for (const value of ['1', 'true', 'YES']) assert.match(skipReason({ checkout: null, env: { SLEIGHT_NO_HUB: value }, exists: none }), /SLEIGHT_NO_HUB/);
  assert.equal(skipReason({ checkout: null, env: { SLEIGHT_NO_HUB: '0' }, exists: none }), null);
  assert.match(skipReason({ checkout: null, saved: '/missing', exists: none }), /saved no results/);
  assert.match(skipReason({ checkout: null, lock: '/l', hold: '/h', exists: path => path === '/l' }), /live round holds \/l/);
  assert.match(skipReason({ checkout: null, lock: '/l', hold: '/h', exists: path => path === '/h' }), /\/h marks another project/);
  assert.deepEqual([LIVE_LOCK, HOLD], ['/tmp/sleight-live.lock', '/tmp/sleight-hold']);
});

test('a refresh runs the hub once, in a child process, with the bank and folder arguments', () => {
  const calls = [];
  const run = (command, args, options) => { calls.push({ command, args, options }); return { status: 0, stdout: 'wrote 33 files to docs/results\n', stderr: '' }; };
  const result = refreshHub({ checkout: null, exists: none, run, hub: '/repo/bench/results-hub.mjs', hubArgs: ['--bank', '/out/bank'], timeoutMs: 5000 });
  assert.equal(result.status, 'refreshed');
  assert.match(result.line, /^hub: refreshed \(\d+\.\d s\): wrote 33 files to docs\/results$/);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].command, calls[0].args], [process.execPath, ['/repo/bench/results-hub.mjs', '--bank', '/out/bank']]);
  assert.equal(calls[0].options.timeout, 5000);
});

test('a hub error, crash, timeout or exception is one log line and never throws', () => {
  const failing = [
    [() => ({ status: 1, stdout: '', stderr: `Error: no raw folder in ${homedir()}/x\n    at stack\n` }), /refresh failed \(exit 1: Error: no raw folder in ~\/x\)/],
    [() => ({ status: null, signal: 'SIGSEGV', stdout: '', stderr: '' }), /refresh failed \(exit null, SIGSEGV: \)/],
    [() => ({ status: null, error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) }), /refresh failed \(timed out after 120000 ms\)/],
    [() => { throw new Error('boom'); }, /refresh failed \(boom\)/],
  ];
  for (const [run, pattern] of failing) {
    const result = refreshHub({ checkout: null, exists: none, run });
    assert.equal(result.status, 'failed');
    assert.match(result.line, pattern);
    assert.equal(result.line.includes('\n'), false);
    assert.equal(result.line.includes(homedir()), false);
  }
});

test('a skipped refresh never starts the hub', () => {
  let started = 0;
  const run = () => { started += 1; return { status: 0, stdout: '' }; };
  for (const decision of [{ noHub: true }, { dryRun: true }, { exitCode: 2 }, { lock: '/l', exists: () => true }]) {
    const result = refreshHub({ checkout: null, exists: none, ...decision, run });
    assert.equal(result.status, 'skipped');
    assert.match(result.line, /^hub: skipped, /);
  }
  assert.equal(started, 0);
});

test('the command line always exits 0, logs one line, and rejects nothing silently', t => {
  const lines = [];
  const log = line => lines.push(line);
  assert.equal(main(['--no-hub'], log), 0);
  assert.equal(main(['--exit', '3'], log, { checkout: null }), 0);
  assert.equal(main(['--exit', 'x'], log, { checkout: null }), 0);
  assert.equal(main(['--surprise'], log, { checkout: null }), 0);
  assert.equal(main(['--saved', join(tmp(t), 'nothing')], log, { checkout: null }), 0);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^hub: skipped, no-hub/);
  assert.match(lines[1], /^hub: skipped, the pass did not succeed \(exit 3\)/);
  assert.match(lines[2], /^hub: refresh failed \(--exit needs a number\)/);
  assert.match(lines[3], /^hub: refresh failed \(unknown option --surprise\)/);
  assert.match(lines[4], /^hub: skipped, the pass saved no results folder/);
});

test('the script prints its line and exits 0 when it skips', () => {
  const run = spawnSync(process.execPath, [join(ROOT, 'bench/hub-refresh.mjs'), '--exit', '1'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /^hub: skipped, (the pass did not succeed \(exit 1\)|the checkout is on a detached HEAD or has no Git branch)\n$/);
  const off = spawnSync(process.execPath, [join(ROOT, 'bench/hub-refresh.mjs')], { encoding: 'utf8', env: { ...process.env, SLEIGHT_NO_HUB: '1' } });
  assert.match(off.stdout, /^hub: skipped, no-hub flag or SLEIGHT_NO_HUB\n$/);
});

test('bench/run.mjs refreshes once after the results line, never on a dry run, setup, hygiene dry run or the private mail pass', () => {
  const source = read('bench/run.mjs');
  const end = source.slice(source.lastIndexOf('console.log(`\\nresults:'));
  assert.match(source, /^import \{ refreshHub \} from '\.\/hub-refresh\.mjs';$/m);
  assert.match(end, /if \(!isDryRun && !isSetupOnly && !hygieneDryRun && !privatePass\) \{\n  console\.log\(refreshHub\(/);
  assert.match(end, /refreshHub\(\{ exitCode: process\.exitCode \?\? 0, saved: file, noHub: process\.argv\.includes\('--no-hub'\) \}\)/);
  assert.equal(source.split('refreshHub(').length - 1, 1);
  // The bench-run harness runs the real body with refreshHub faked, so the guard conditions are also executed there (tests/bench-run.test.mjs).
});

test('the validation runners refresh once after a saved result, accept --no-hub, and keep their child runners from refreshing', async t => {
  const validation = read('bench/validation/validation-140.mjs'), remeasure = read('bench/validation/remeasure.mjs');
  assert.match(validation, /'--resume', '--no-hub'\]\.includes\(a\)/);
  assert.match(validation, /refreshHub\(\{ saved: plan\.out, noHub: !!o\['no-hub'\], hubArgs: \['--bank', plan\.out\] \}\)/);
  assert.match(remeasure, /\['--run', '--owner-away', '--no-hub'\]\.includes\(key\)/);
  assert.match(remeasure, /refreshHub\(\{ saved: plan\.out, noHub: !!o\['--no-hub'\], hubArgs: \['--bank', plan\.out\] \}\)/);
  // The refresh comes after the run, so a run that throws never refreshes.
  assert.ok(validation.indexOf('await execute(plan') < validation.indexOf('refreshHub('));
  assert.ok(remeasure.indexOf('await runRemeasure(plan)') < remeasure.indexOf('refreshHub('));
  // Every round the validation driver starts carries SLEIGHT_NO_HUB=1, so a round never refreshes the hub inside the pinned build.
  const dir = tmp(t), log = join(dir, 'env.log');
  writeFileSync(log, '');
  const exit = await child(process.execPath, ['-e', 'process.stdout.write(String(process.env.SLEIGHT_NO_HUB))'], dir, log);
  assert.equal(exit.code, 0);
  assert.equal(readFileSync(log, 'utf8'), '1');
  assert.equal(workflowEnvironment('default', {}).SLEIGHT_NO_HUB, '1');
  assert.equal(workflowEnvironment('docs0', {}).SLEIGHT_NO_HUB, '1');
});

test('a release pass stage and the A/B scripts run their rounds with SLEIGHT_NO_HUB=1', async t => {
  const dir = tmp(t);
  const stage = { command: process.execPath, commandArgs: ['-e', 'process.stdout.write(String(process.env.SLEIGHT_NO_HUB))'] };
  const result = await runStage(stage, { root: dir });
  assert.deepEqual([result.code, result.stdout], [0, '1']);
  assert.match(read('bench/ab-sleight.sh'), /env SLEIGHT_NO_HUB=1 \$flags node bench\/run\.mjs/);
  assert.match(read('bench/flag-ab.command'), /env DISABLE_AUTOUPDATER=1 SLEIGHT_NO_HUB=1 \$\{=flag\} node bench\/run\.mjs/);
});

// rounds.sh: the argument filter and the hub_refresh function are run from the real script text.
function snippet(from, to) {
  const script = read('bench/fowl/rounds.sh');
  const start = script.indexOf(from);
  assert.ok(start >= 0, from);
  return script.slice(start, script.indexOf(to, start) + to.length);
}

test('rounds.sh removes --no-hub from the runner arguments, keeps every other argument in order, and sets NOHUB', () => {
  const filter = snippet('NOHUB="${SLEIGHT_NO_HUB:-}"', 'done\n');
  const run = (env, ...args) => spawnSync('/bin/sh', ['-eu', '-c', `${filter}\nprintf '%s|' "$NOHUB"; for a in "$@"; do printf '[%s]' "$a"; done`, 'rounds', ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  assert.equal(run({}, '--surface', 'sleight', '--out', 'a b').stdout, '|[--surface][sleight][--out][a b]');
  assert.equal(run({}, '--surface', '--no-hub', '', 'x').stdout, '1|[--surface][][x]');
  assert.equal(run({ SLEIGHT_NO_HUB: '1' }, '--only', 'a').stdout, '1|[--only][a]');
  assert.equal(run({}).stdout, '|');
});

test('rounds.sh refreshes the hub after a round that saved to --out, skips without --out, and reports a missing exit status as a failure', t => {
  const repo = tmp(t);
  mkdirSync(join(repo, 'bench'));
  const record = join(repo, 'calls.log');
  writeFileSync(join(repo, 'bench/hub-refresh.mjs'), `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(record)}, process.argv.slice(2).join(' ') + '\\n'); process.exit(7);\n`);
  const fn = snippet('hub_refresh() {', '\n}\n');
  const run = (vars, tail = 'hub_refresh') => spawnSync('/bin/sh', ['-eu', '-c', `${fn}\n${tail}\necho survived`], { encoding: 'utf8', env: { PATH: process.env.PATH, REPO: repo, ...vars } });
  const lines = () => { try { return readFileSync(record, 'utf8').trim().split('\n'); } catch { return []; } };
  assert.equal(run({ OUT: '' }).stdout, 'survived\n');
  assert.deepEqual(lines(), []);
  assert.equal(run({ OUT: 'out/x', RC: '0' }).stdout, 'survived\n');
  assert.equal(run({ OUT: 'out/x', RC: '0', NOHUB: '1' }).stdout, 'survived\n');
  assert.equal(run({ OUT: 'out/x' }).stdout, 'survived\n');
  assert.deepEqual(lines(), ['--exit 0 --saved out/x', '--exit 0 --saved out/x --no-hub', '--exit 1 --saved out/x']);
});

test('rounds.sh calls hub_refresh in the real-browser branch and in the exit trap after the live lock is released, and nowhere else', () => {
  const script = read('bench/fowl/rounds.sh');
  const code = script.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.equal(code.split('hub_refresh').length - 1, 3, 'the definition and the two calls');
  const real = snippet('if [ -n "$REAL" ]; then', '\nfi\n');
  assert.match(real, /node tools\/rounds\.mjs "\$@" --model "\$MODEL" &\n {2}CHILD=\$!\n {2}wait "\$CHILD" && RC=0 \|\| RC=\$\?\n {2}hub_refresh\n {2}exit "\$RC"/);
  assert.equal(/exec env -i/.test(script), false);
  assert.match(script, /trap 'rmdir \/tmp\/sleight-live\.lock; [^\n]*add-spend\.mjs" "\$OUT" "\$SPEND"; hub_refresh' EXIT/);
  assert.ok(script.indexOf("'rmdir /tmp/sleight-live.lock; ") < script.indexOf('; hub_refresh\' EXIT'));
});

// ---------------------------------------------------------------------------------------------------------------------------
// The structural guard: a detached HEAD or a staging root is never rewritten, flags or not.

test('a checkout on a branch is allowed; a detached HEAD, no Git branch and the validation or A/B staging roots are refused', () => {
  const branch = () => ({ status: 0, stdout: 'refs/heads/claude/p141\n' });
  const detached = () => ({ status: 1, stdout: '' });
  assert.equal(checkoutBlock({ root: '/repo/p141', git: branch, real: p => p }), null);
  assert.match(checkoutBlock({ root: '/repo/p141', git: detached, real: p => p }), /detached HEAD/);
  assert.match(checkoutBlock({ root: '/repo/p141', git: () => ({ error: new Error('no git'), status: null }), real: p => p }), /detached HEAD or has no Git branch/);
  for (const root of ['/tmp/lane-vp1-AbC123/B', '/tmp/lane-vp1-x', MAC_TMP + '/lane-vp1-q/A', '/tmp/lane-ab-9z/old', '/home/x/sleight-wt/ab-old', '/home/x/sleight-wt/ab-new/']) {
    assert.match(checkoutBlock({ root, git: branch, real: p => p }), /staging checkout/, root);
  }
  for (const root of ['/home/x/sleight-wt/p141-hub1', '/tmp/lane-claude-AbC', '/home/x/sleight-wt/ab-newer', '/home/x/lane-vpn']) {
    assert.equal(checkoutBlock({ root, git: branch, real: p => p }), null, root);
  }
});

test('a refused checkout skips the refresh without starting the hub, even with no flag, and beats a missing results folder or a clear lock', () => {
  let started = 0;
  const run = () => { started += 1; return { status: 0, stdout: '' }; };
  const result = refreshHub({ checkout: 'the checkout is on a detached HEAD or has no Git branch', exists: none, run });
  assert.deepEqual([result.status, result.line], ['skipped', 'hub: skipped, the checkout is on a detached HEAD or has no Git branch']);
  assert.equal(started, 0);
});

test('the real checkout of this repository is judged by Git: a throwaway repository on a branch passes, then detached fails', t => {
  const dir = tmp(t);
  const git = (...args) => { const r = spawnSync('/usr/bin/git', ['-C', dir, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  git('init', '-q', '-b', 'main'); writeFileSync(join(dir, 'a'), 'a');
  git('add', 'a'); git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'a');
  assert.equal(checkoutBlock({ root: dir }), null);
  git('checkout', '-q', '--detach');
  assert.match(checkoutBlock({ root: dir }), /detached HEAD/);
});

test('the runners that start rounds for A/B and hand checks carry SLEIGHT_NO_HUB=1', () => {
  assert.match(read('bench/fowl/as3-ab.command'), /env DISABLE_AUTOUPDATER=1 SLEIGHT_NO_HUB=1 SLEIGHT_BROWSER_CORE=\$core/);
  assert.match(read('bench/hand/h8-hidden-tab.mjs'), /env: \{ DISABLE_AUTOUPDATER: '1', SLEIGHT_NO_HUB: '1',/);
});

test('hub output changes are tolerated by the pinned-build guards only while they match what the hub renders from its data', () => {
  const status = ' M README.md\n M docs/results/validation.md\n?? docs/results/data/x.json';
  let asked = 0;
  assert.deepEqual(pendingChanges(status, () => { asked += 1; return true; }), []);
  assert.equal(asked, 1);
  assert.deepEqual(pendingChanges(status, () => false), status.split('\n'));
  // A trimmed status (remeasure trims git's output) reads the same.
  assert.deepEqual(pendingChanges(status.trim(), () => true), []);
  // Anything outside README.md and docs/results always counts, and the freshness check isn't even asked for it.
  let unasked = 0;
  assert.deepEqual(pendingChanges(' M plugins/sleight/x.mjs\n M bench/run.mjs', () => { unasked += 1; return true; }), [' M plugins/sleight/x.mjs', ' M bench/run.mjs']);
  assert.equal(unasked, 0);
  assert.deepEqual(pendingChanges(' M README.md\n M bench/run.mjs', () => true), [' M bench/run.mjs']);
  assert.deepEqual(pendingChanges('R  docs/results/a.md -> docs/other.md', () => true), ['R  docs/results/a.md -> docs/other.md']);
  assert.deepEqual([isHubPath('README.md'), isHubPath('docs/results/a.md'), isHubPath('docs/README.md'), isHubPath('docs/results')], [true, true, false, false]);
});

test('the real hub check is the freshness test: this tree is fresh, and a hand edit of a page is not', t => {
  assert.equal(hubIsFresh(ROOT), true);
  assert.equal(hubIsFresh(ROOT, () => ({ status: 1 })), false);
  assert.equal(hubIsFresh(ROOT, () => ({ error: new Error('x'), status: null })), false);
});

test('the validation and re-measure guards use pendingChanges, so a hand edit of docs/results or the README still fails', () => {
  const validation = read('bench/validation/validation-140.mjs'), remeasure = read('bench/validation/remeasure.mjs');
  assert.match(validation, /pendingChanges\(git\('status', '--porcelain', '--untracked-files=no'\), \(\) => hubIsFresh\(ROOT\)\)\.length/);
  assert.match(remeasure, /pendingChanges\(git\(plan\.repository, 'status', '--porcelain', '--untracked-files=all', '--', '\.',\n\s+':\(exclude\)node_modules', ':\(exclude\)\.vale', ':\(exclude\)bench\/results'\), \(\) => hubIsFresh\(plan\.repository\)\)\.length/);
  assert.equal(/:\(exclude\)(docs\/results|README)/.test(validation + remeasure), false);
});

// ---------------------------------------------------------------------------------------------------------------------------
// rounds.sh signals: the real-browser branch is run from the script text with the runner replaced by a stand-in.

function realBranch(child) {
  const branch = snippet('if [ -n "$REAL" ]; then', '\nfi\n');
  const swapped = branch.replace(/env -i[\s\S]*?node tools\/rounds\.mjs "\$@" --model "\$MODEL"/, child);
  assert.notEqual(swapped, branch);
  return swapped;
}
const waitFor = async (ok, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (ok()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };

test('a TERM to the real-browser branch reaches a 3 s runner promptly, the shell exits 130 after its cleanup, and the hub is not refreshed', async t => {
  const dir = tmp(t), log = join(dir, 'child.log'), ready = join(dir, 'ready'), record = join(dir, 'refresh.log');
  const runner = join(dir, 'runner.mjs');
  writeFileSync(runner, `import { writeFileSync, appendFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ready)}, 'up');
process.on('SIGTERM', () => { setTimeout(() => { appendFileSync(${JSON.stringify(log)}, 'TERM cleaned up\\n'); process.exit(143); }, 200); });
setTimeout(() => { appendFileSync(${JSON.stringify(log)}, 'finished\\n'); }, 3000);\n`);
  const script = `hub_refresh() { echo "refresh RC=$RC" >> ${JSON.stringify(record)}; }\nREAL=1\n${realBranch(`${JSON.stringify(process.execPath)} ${JSON.stringify(runner)}`)}`;
  const { spawn } = await import('node:child_process');
  const sh = spawn('/bin/sh', ['-eu', '-c', script], { stdio: 'ignore', env: { PATH: process.env.PATH } });
  const closed = new Promise(done => sh.once('close', (code, signal) => done({ code, signal })));
  assert.ok(await waitFor(() => existsSync(ready)), 'the runner started');
  const sent = Date.now();
  sh.kill('SIGTERM');
  const exit = await closed;
  assert.ok(Date.now() - sent < 2000, `exited ${Date.now() - sent} ms after the TERM`);
  assert.equal(exit.code, 130);
  assert.equal(readFileSync(log, 'utf8'), 'TERM cleaned up\n');
  assert.equal(existsSync(record), false, 'a killed round must not refresh the hub');
});

test('a round killed while the runner exits 0 on its own still reads as a failure: no refresh, exit 130', async t => {
  const dir = tmp(t), record = join(dir, 'refresh.log');
  // The runner sends TERM to the shell, then exits 0 before the shell can handle it.
  const script = `hub_refresh() { echo "refresh RC=$RC" >> ${JSON.stringify(record)}; }\ntrap 'hub_refresh' EXIT\nREAL=1\n${realBranch(`sh -c 'kill -TERM $PPID; sleep 0.3; exit 0'`)}`;
  const run = spawnSync('/bin/sh', ['-eu', '-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 8000 });
  assert.equal(run.status, 130);
  assert.equal(existsSync(record) ? readFileSync(record, 'utf8') : '', existsSync(record) ? 'refresh RC=1\n' : '', 'the EXIT trap, if it ran hub_refresh, saw RC=1');
  assert.doesNotMatch(existsSync(record) ? readFileSync(record, 'utf8') : '', /RC=0/);
});

test('a finished real-browser round refreshes once with its own exit status: 0 for a pass, the runner status for a failure', t => {
  for (const [command, expected] of [['true', 0], ['sh -c "exit 5"', 5]]) {
    const dir = tmp(t), record = join(dir, 'refresh.log');
    const script = `hub_refresh() { echo "refresh RC=$RC" >> ${JSON.stringify(record)}; }\nREAL=1\n${realBranch(command)}`;
    const run = spawnSync('/bin/sh', ['-eu', '-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 8000 });
    assert.equal(run.status, expected);
    assert.equal(readFileSync(record, 'utf8'), `refresh RC=${expected}\n`);
  }
});

test('the FowlBrowser path starts with RC=1 and sets it to 0 only on success, so a round killed by the INT trap never reads as a pass', () => {
  const tail = snippet('RC=1\nenv -i HOME', '"$MODEL" && RC=0 || RC=$?');
  assert.match(tail, /^RC=1\n/);
  assert.equal(read('bench/fowl/rounds.sh').split('RC=0\n').length - 1, 0);
});
