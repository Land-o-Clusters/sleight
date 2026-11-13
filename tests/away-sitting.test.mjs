// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const url = new URL('../bench/away-sitting.mjs', import.meta.url);
const load = async () => {
  const module = await import(url.href).catch(() => undefined);
  assert.ok(module, 'away-sitting runner is absent from the old code');
  return module;
};
const ids = ['h2h-clean', 'h2h-normal', 'textedit-drag', 'chess-points', 'simulator-form',
  'save-delivery', 'save-lock', 'select-all', 'stale-number', 'menu-bar', 'shop-smoke', 'best-buy', 'quiet-cpu'];

test('dry run prints the STATE order, commands, sources and estimates without live imports', async () => {
  await load();
  // Node denies writes, child processes and network access inside this dry-run process.
  const result = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${new URL('../', import.meta.url).pathname}`,
    url.pathname, '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.steps.map(s => s.id), ids);
  assert.equal(plan.drives, false);
  assert.equal(plan.lock, false);
  assert.equal(plan.stateSource, 'docs/status/STATE.md');
  assert.ok(plan.steps.every(s => s.estimateSource && (s.estimatedMinutes === null || s.estimatedMinutes > 0)));
  assert.equal(plan.steps[0].blocked, undefined, 'the head-to-head runs: the owner approved its approval-list swap (2026-10-09)');
  assert.match(plan.steps[0].command.join(' '), /--arm sleight,codex .*--clean-arms/);
  assert.equal(plan.steps.at(-1).command, null);
  assert.match(plan.steps.at(-1).blocked, /h2h-clean/);
  assert.ok(!result.stdout.includes(`${MAC_USERS}`));
  assert.ok(plan.watchers.includes('bench/front-watch.sh'));
  assert.ok(!plan.watchers.some(w => w.includes('.dev/passes/front-watch.sh')));
});

test('selection preserves STATE order and rejects unknown or conflicting selectors', async () => {
  const { buildPlan, parseArgs } = await load();
  assert.deepEqual(buildPlan(parseArgs(['--dry-run', '--only', 'best-buy,textedit-drag'])).steps.map(s => s.id),
    ['textedit-drag', 'best-buy']);
  assert.deepEqual(buildPlan(parseArgs(['--dry-run', '--from', 'shop-smoke'])).steps.map(s => s.id), ids.slice(-3));
  for (const args of [['--only', 'missing'], ['--from', 'missing'], ['--only', 'best-buy', '--from', 'best-buy'],
    ['--only'], ['--only', 'best-buy,'], ['--only', 'best-buy,best-buy'], ['--wat']]) {
    assert.throws(() => buildPlan(parseArgs(args)));
  }
});

test('a changed or missing STATE away list fails instead of silently using an old order', async () => {
  const { buildPlan } = await load();
  const state = readFileSync(new URL('../docs/status/STATE.md', import.meta.url), 'utf8');
  assert.throws(() => buildPlan({}, state.replace('textedit-drag, Chess', 'unknown-step, Chess')), /STATE/);
  assert.throws(() => buildPlan({}, state.replace('Next, in order:', 'Next:')), /STATE/);
  assert.throws(() => buildPlan({}, state.replace('textedit-drag, Chess', 'textedit-drag, surprise-task, Chess')), /STATE/);
});

function harness() {
  const rows = [], launched = [];
  let check = () => undefined;
  return {
    rows, launched,
    setCheck: fn => { check = fn; },
    deps: { check: async () => check(), now: () => '2026-10-11T12:00:00.000Z',
      results: async step => [`docs/benchmarks/${step.id}.json`], log: row => rows.push(row),
      run: async step => { launched.push(step.id); return { code: step.id === 'first' ? 7 : 0 }; } },
  };
}
const steps = [{ id: 'first', command: ['node', 'first'] }, { id: 'second', command: ['node', 'second'] }];

test('a failed step advances and each completion has start, end, exit code and results', async () => {
  const { runSteps } = await load(), h = harness();
  assert.equal(await runSteps(steps, h.deps), 1);
  assert.deepEqual(h.launched, ['first', 'second']);
  assert.equal(h.rows.length, 2);
  assert.deepEqual(h.rows[0], { step: 'first', start: '2026-10-11T12:00:00.000Z',
    end: '2026-10-11T12:00:00.000Z', exitCode: 7, results: ['docs/benchmarks/first.json'] });
});

test('hold, front changes, tap reports and retained locks stop before the next step', async () => {
  const { runSteps } = await load();
  for (const reason of ['hold exists', 'foreground changed', 'keyboard tap reported', 'live lock retained']) {
    const h = harness();
    h.setCheck(() => h.launched.length ? reason : undefined);
    assert.equal(await runSteps(steps, h.deps), 2);
    assert.deepEqual(h.launched, ['first']);
    assert.equal(h.rows[1].exitCode, 125);
    assert.equal(h.rows[1].stop, reason);
  }
});

test('a watcher abort during a step is logged and prevents subsequent launches', async () => {
  const { runSteps, runHarness } = await load(), h = harness();
  h.deps.run = async step => { h.launched.push(step.id); return { code: 130, stop: 'foreground changed' }; };
  assert.equal(await runSteps(steps, h.deps), 2);
  assert.deepEqual(h.launched, ['first']);
  assert.equal(h.rows[0].stop, 'foreground changed');
  // Exercise the actual cancellation adapter with an inert child driver, never an app.
  for (const mode of ['graceful', 'forced', 'signal']) {
    const controller = new AbortController(), calls = [];
    let scheduled;
    const result = await runHarness(steps[0], controller.signal, {
      interrupt: pid => calls.push(['SIGINT', pid]),
      schedule: fn => { scheduled = fn; return 1; }, unschedule: timer => calls.push(['clear', timer]),
      drive: async (_command, _args, options) => {
        options.onSpawn(42);
        controller.abort('keyboard tap reported');
        assert.equal(options.signal.aborted, false, 'cooperative cleanup gets its own grace period');
        if (mode === 'forced') scheduled();
        return { exit: { code: mode === 'graceful' ? 130 : null, signal: mode === 'signal' ? 'SIGINT' : null },
          groupClean: true, stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(calls, [['SIGINT', 42], ['clear', 1]]);
    assert.match(result.stop, mode === 'graceful' ? /keyboard tap/ : /cleanup unconfirmed/);
  }
});

test('unavailable commands are recorded as failures and do not execute', async () => {
  const { runSteps } = await load(), h = harness();
  assert.equal(await runSteps([{ id: 'blocked', command: ['node'], blocked: 'approval list writes' }, steps[1]], h.deps), 1);
  assert.deepEqual(h.launched, ['second']);
  assert.equal(h.rows[0].exitCode, 126);
});

test('codex-no-write is parsed and attached only to Codex arm commands', async () => {
  const { buildPlan, parseArgs } = await load();
  const withFlag = buildPlan(parseArgs(['--dry-run', '--codex-no-write']));
  assert.equal(withFlag.codexNoWrite, true);
  const codex = withFlag.steps.filter(s => s.command?.includes('codex') || s.command?.join(' ').includes('sleight,codex'));
  assert.ok(codex.length >= 2);
  for (const step of codex) assert.ok(step.command.includes('--codex-no-write'), step.id);
  const sleightOnly = withFlag.steps.find(s => s.id === 'textedit-drag');
  assert.ok(!sleightOnly.command.includes('--codex-no-write'));
  const without = buildPlan(parseArgs(['--dry-run']));
  assert.equal(without.codexNoWrite, undefined);
  assert.ok(!without.steps[0].command.includes('--codex-no-write'));
});

test('watcher parsers reject malformed reports, retain baseline and stop on a tap added after the start', async () => {
  const { frontReport, tapReport, tapBaseline } = await load();
  assert.deepEqual(frontReport('12:00:00.123 Editor', undefined), { baseline: 'Editor' });
  assert.deepEqual(frontReport('12:00:01.123 Editor', 'Editor'), { baseline: 'Editor' });
  assert.match(frontReport('12:00:01.123 Chess', 'Editor').stop, /foreground/);
  assert.match(frontReport('', 'Editor').stop, /watcher/);
  assert.equal(tapReport('[]'), undefined);
  assert.match(tapReport('[{"pid":42,"app":"Device Hub"}]'), /keyboard tap reported \(Device Hub\)/);
  const standing = '[{"pid":7,"app":"Window Manager"},{"pid":7,"app":"Window Manager"},{"pid":9,"app":"Siri"}]';
  const before = tapBaseline(standing);
  assert.equal(tapReport(standing, before), undefined);
  assert.match(tapReport('[{"pid":7,"app":"Window Manager"},{"pid":42,"app":"Device Hub"}]', before), /\(Device Hub\)/);
  assert.equal(tapReport('[{"pid":7,"app":"Window Manager"},{"pid":51,"app":"ChatGPT Computer Use"}]', before, new Set([51])), undefined);
  const { ENGINE_HELPER } = await load();
  assert.ok(ENGINE_HELPER.test(`${MAC_USERS}someone/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService`));
  assert.ok(ENGINE_HELPER.test('"CFBundleIdentifier"="com.openai.sky.CUAService"'));
  assert.ok(!ENGINE_HELPER.test('/Applications/Device Hub.app/Contents/MacOS/Device Hub'));
  assert.match(tapReport('[{"pid":42,"app":"Device Hub"}]', before, new Set(), new Map([[42, '/Applications/Device Hub.app']])), /Device Hub at \/Applications/);
  for (const value of ['broken', '{}', '[null]']) assert.match(tapReport(value), /watcher/);
});

test('a recorded watcher log stops on a window id or title change of the same app', async () => {
  const { frontReport } = await load();
  const log = [
    '12:00:00.100 TextEdit\t240864\tUntitled',
    '12:00:00.600 TextEdit\t240864\tUntitled',
    '12:00:01.100 TextEdit\t240865\tUntitled',
    '12:00:01.600 TextEdit\t240865\tNotes',
    '12:00:02.100 Chess\t99\tGame',
  ];
  let state = frontReport(log[0], undefined);
  assert.equal(state.stop, undefined);
  state = frontReport(log[1], state.baseline);
  assert.equal(state.stop, undefined);
  state = frontReport(log[2], state.baseline);
  assert.match(state.stop, /foreground window changed/);
  state = frontReport(log[3], 'TextEdit\t240865\tUntitled');
  assert.match(state.stop, /foreground window changed/);
  state = frontReport(log[4], 'TextEdit\t240864\tUntitled');
  assert.match(state.stop, /foreground/);
});

test('the tracked front watcher records window ids and titles without being executed', () => {
  const path = new URL('../bench/front-watch.sh', import.meta.url);
  assert.equal(existsSync(path), true, 'bench/front-watch.sh is missing');
  const source = readFileSync(path, 'utf8');
  assert.match(source, /kCGWindowNumber/);
  assert.match(source, /kCGWindowName/);
  assert.doesNotMatch(source, /osascript -e 'tell /);
});
