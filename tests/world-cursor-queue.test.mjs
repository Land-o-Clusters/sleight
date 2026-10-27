import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NATIVE, CHROME, readSteps, invocation, cleanEnv, completed, runQueue, execute, admission } from '../bench/world/arms/cursor-cu/queue.mjs';
import { parseOptions, nativePlan } from '../bench/world/arms/cursor-cu/suite.mjs';
import { probePlan, runProbe } from '../bench/world/arms/cursor-cu/probe.mjs';

const temp = () => realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-cq1-test-'))));
const save = (file, value) => writeFileSync(file, JSON.stringify(value));
const stepsText = () => '# ID KIND TASKS\nprobe probe -\n' + [1, 2, 3].map(i => `native-r${i} native ${NATIVE}\nchrome-r${i} chrome ${CHROME}\n`).join('');
function fixture() {
  const dir = temp(), script = join(dir, 'queue.sh'), file = join(dir, 'main.steps');
  writeFileSync(script, '# fixture\n'); writeFileSync(file, stepsText());
  return { dir, script, steps: readSteps(file), out: join(dir, 'output'), root: process.cwd(), ownerSaysCursorFree: true };
}
function nativeResult(tasks, passed = true) {
  return { groupClean: true, results: tasks.map(task => ({ task, arm: 'cursor-cu', run: 1, groupClean: true, passed, seconds: 2 })) };
}
function chromeResult(folder, tasks, passed = true) {
  mkdirSync(folder, { recursive: true });
  save(join(folder, 'results.json'), tasks.map(name => ({ task: { name }, surface: 'cursor-cu', status: 'ran',
    run: { groupClean: true }, outcome: { ok: passed } })));
  save(join(folder, 'cleanup.json'), { browserClosed: true, profileDeleted: true });
  writeFileSync(join(folder, 'report.md'), 'Fixture report\n');
}
function evidence(step, call, passed = true) {
  if (step.kind === 'native') save(call.result, nativeResult(step.tasks, passed));
  else if (step.kind === 'chrome') chromeResult(call.result, step.tasks, passed);
  else {
    save(call.result, { failed: !passed, results: [{ failed: !passed, groupClean: true }, { failed: !passed }] });
    save(call.result + '.native.json', nativeResult(['textedit-edit'], passed));
    chromeResult(call.result + '.chrome', ['mdn'], passed);
  }
}
function fake(f, extra = {}) {
  const calls = [], runtime = { identify: () => ({ build: 'fixture-source' }), held: () => false, locked: () => false,
    execute: async (call, logFile) => {
      writeFileSync(logFile, 'fixture command\n', { flag: 'a' });
      const preflight = call.args.includes('--preflight'); calls.push(preflight ? 'admit' : call.result);
      if (!preflight) { const step = f.steps.find(s => invocation(s, f).result === call.result); evidence(step, call); }
      return { code: 0, signal: null };
    }, ...extra };
  return { calls, runtime };
}

test('queue has probe then 3 exact native/Chrome rounds, and native flags reach the Cursor parser', () => {
  const f = fixture();
  try {
    assert.equal(f.steps.length, 7); assert.equal(NATIVE.split(',').length, 21); assert.equal(CHROME.split(',').length, 13);
    const call = invocation(f.steps[1], f), plan = nativePlan(parseOptions(call.args.slice(1)));
    assert.equal(plan.runs.length, 21); assert.ok(plan.runs.every(r => r.run === 1));
    for (const task of ['word-memo', 'word-brief', 'textedit-notes-table', 'cc-list-native']) assert.ok(plan.runs.some(r => r.task === task));
    assert.equal(plan.composer.modelLabel, 'Grok 4.7 High'); assert.equal(plan.composer.speed, 'normal');
    const chrome = invocation(f.steps[2], f); assert.equal(parseOptions(chrome.args.slice(1)).only, CHROME);
    writeFileSync(join(f.dir, 'main.steps'), stepsText().replace('probe probe -', 'native-r1 probe -'));
    assert.throws(() => readSteps(join(f.dir, 'main.steps')), /unique/);
    writeFileSync(join(f.dir, 'main.steps'), stepsText().replace(CHROME, 'mdn'));
    assert.throws(() => readSteps(join(f.dir, 'main.steps')), /exact chrome/);
  } finally { rmSync(f.dir, { recursive: true }); }
});

test('queue dry-run cannot write, spawn, inspect host processes or touch control paths', () => {
  const f = fixture();
  try {
    const r = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', 'bench/world/arms/cursor-cu/queue.mjs', f.script, '--dry-run'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.equal((r.stdout.match(/^# .* kind=/gm) ?? []).length, 7);
    assert.match(r.stdout, /no runners executed/); assert.match(r.stdout, /probe.mjs.*--owner-away/);
    assert.equal(existsSync(f.out), false);
  } finally { rmSync(f.dir, { recursive: true }); }
});

test('every host CLAUDE variable is removed and a fresh config replaces it', async () => {
  assert.deepEqual(cleanEnv('/tmp/new', { CLAUDE_CONFIG_DIR: 'old', CLAUDECODE: 'yes', CLAUDE_SECRET: 'fake', PATH: '/bin' }),
    { PATH: '/bin', CLAUDE_CONFIG_DIR: '/tmp/new', DISABLE_AUTOUPDATER: '1', SLEIGHT_NO_HUB: '1' });
  const dir = temp(), log = join(dir, 'env.log');
  try {
    const r = await execute({ root: dir, command: process.execPath, args: ['-e', 'console.log(JSON.stringify({cfg:process.env.CLAUDE_CONFIG_DIR,exists:require("fs").existsSync(process.env.CLAUDE_CONFIG_DIR)}))'] }, log);
    assert.equal(r.code, 0);
    const result = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1));
    assert.match(result.cfg, /^\/tmp\/lane-claude-/); assert.equal(result.exists, true); assert.equal(existsSync(result.cfg), false);
    assert.equal((await execute({ root: dir, command: '/nonexistent-cq1-command', args: [] }, log)).code, 127);
  } finally { rmSync(dir, { recursive: true }); }
});

test('completed failed tasks remain complete, while missing, stopped or unclean rows refuse', () => {
  const f = fixture(); mkdirSync(f.out);
  try {
    for (const step of f.steps.slice(1, 3)) {
      const call = invocation(step, f); evidence(step, call, false);
      assert.equal(completed(step, call, 1).failedTasks, step.tasks.length);
      assert.throws(() => completed(step, call, 130), /crashed/);
      assert.throws(() => completed(step, call, 0, 'Cleanup unproved; retained fixture'), /stopped/);
    }
    const step = f.steps[1], call = invocation(step, f), result = nativeResult(step.tasks);
    result.results[0].safetyStop = 'foreign Cursor'; save(call.result, result);
    assert.throws(() => completed(step, call, 0), /stopped/);
    result.results[0].safetyStop = undefined; result.results.pop(); save(call.result, result);
    assert.throws(() => completed(step, call, 0), /incomplete/);
    const chrome = invocation(f.steps[2], f); save(join(chrome.result, 'cleanup.json'), { browserClosed: true });
    assert.throws(() => completed(f.steps[2], chrome, 0), /cleanup/);
  } finally { rmSync(f.dir, { recursive: true }); }
});

test('failed probe never qualifies, even with clean children and a zero runner status', () => {
  const f = fixture(); mkdirSync(f.out);
  try {
    const call = invocation(f.steps[0], f); evidence(f.steps[0], call, false);
    assert.throws(() => completed(f.steps[0], call, 0), /Probe/);
    assert.throws(() => completed(f.steps[0], call, 1), /Probe/);
  } finally { rmSync(f.dir, { recursive: true }); }
});

test('successful queue resumes without repeating any ID and rejects changed evidence', async () => {
  const f = fixture(), a = fake(f);
  try {
    assert.equal(await runQueue({ ...f, runtime: a.runtime }), 0); assert.equal(a.calls.length, 14);
    const b = fake(f); assert.equal(await runQueue({ ...f, runtime: b.runtime }), 0); assert.equal(b.calls.length, 0);
    writeFileSync(join(f.out, 'native-r1.json'), '{}');
    await assert.rejects(runQueue({ ...f, runtime: b.runtime }), /Native round/);
    assert.equal(existsSync(join(f.out, '.queue-owner')), false);
  } finally { rmSync(f.dir, { recursive: true }); }
});

test('probe failure stops qualification; resume archives that attempt before retrying', async () => {
  const f = fixture(); let failed = true, qualification = 0;
  const a = fake(f), original = a.runtime.execute;
  a.runtime.execute = async (call, log, options) => {
    const exit = await original(call, log, options);
    if (failed && call.result) { evidence(f.steps[0], call, false); return { code: 1, signal: null }; }
    if (call.result && !call.result.endsWith('/probe.json')) qualification++;
    return exit;
  };
  try {
    assert.equal(await runQueue({ ...f, runtime: a.runtime }), 1); assert.equal(qualification, 0);
    assert.equal(readFileSync(join(f.out, 'probe.rc'), 'utf8'), '1\n'); failed = false;
    assert.equal(await runQueue({ ...f, runtime: a.runtime }), 0); assert.equal(qualification, 6);
    const archived = join(f.out, 'aborted', readdirSync(join(f.out, 'aborted'))[0]);
    assert.ok(existsSync(join(archived, 'probe.json.native.json'))); assert.ok(existsSync(join(archived, 'probe.json.chrome')));
    assert.equal(JSON.parse(readFileSync(join(archived, 'probe.receipt.json'))).runnerRc, 1);
  } finally { rmSync(f.dir, { recursive: true }); }
});

test('owner Cursor admission refusal is logged and starts no runner', async () => {
  const f = fixture(), a = fake(f, { execute: async (call, log) => {
    assert.ok(call.args.includes('--preflight')); writeFileSync(log, 'Cursor benchmark requires installed running owner Cursor\n'); return { code: 1, signal: null };
  } });
  try {
    assert.equal(await runQueue({ ...f, runtime: a.runtime }), 1);
    assert.match(readFileSync(join(f.out, 'probe.log'), 'utf8'), /installed running owner Cursor/);
    assert.equal(JSON.parse(readFileSync(join(f.out, 'probe.receipt.json'))).runnerRc, null);
  } finally { rmSync(f.dir, { recursive: true }); }
});

test('hold waits before admission; a hold during admission prevents the runner', async () => {
  const f = fixture(); let held = true, waits = 0;
  const a = fake(f, { held: () => held, pause: async () => { waits++; held = false; } });
  const original = a.runtime.execute;
  a.runtime.execute = async (...args) => { const r = await original(...args); held = true; return r; };
  try {
    assert.equal(await runQueue({ ...f, runtime: a.runtime }), 1); assert.equal(waits, 1); assert.equal(a.calls.length, 1);
    assert.match(readFileSync(join(f.out, 'queue.log'), 'utf8'), /sleight-hold is active/);
  } finally { rmSync(f.dir, { recursive: true }); }
});

test('held live lock and concurrent owner refuse without releasing another owner', async () => {
  const f = fixture(), a = fake(f, { locked: () => true });
  try {
    await assert.rejects(runQueue({ ...f, runtime: a.runtime }), /live lock/); assert.equal(a.calls.length, 0);
    mkdirSync(join(f.out, '.queue-owner')); writeFileSync(join(f.out, '.queue-owner/pid'), 'other');
    await assert.rejects(runQueue({ ...f, runtime: a.runtime }), /EEXIST/);
    assert.equal(readFileSync(join(f.out, '.queue-owner/pid'), 'utf8'), 'other');
  } finally { rmSync(f.dir, { recursive: true }); }
});

test('changed source refuses resume before any new admission', async () => {
  const f = fixture(), a = fake(f);
  try {
    await runQueue({ ...f, runtime: a.runtime }); a.runtime.identify = () => ({ build: 'changed-source' });
    await assert.rejects(runQueue({ ...f, runtime: a.runtime }), /source changed/);
    assert.equal(a.calls.length, 14);
  } finally { rmSync(f.dir, { recursive: true }); }
});

test('a completed failed qualification round keeps runnerRc 1 and resumes without rerun', async () => {
  const f = fixture(), a = fake(f), original = a.runtime.execute;
  a.runtime.execute = async (...args) => {
    const exit = await original(...args), call = args[0];
    if (call.result === invocation(f.steps[1], f).result) { evidence(f.steps[1], call, false); return { code: 1, signal: null }; }
    return exit;
  };
  try {
    assert.equal(await runQueue({ ...f, runtime: a.runtime }), 0);
    const receipt = JSON.parse(readFileSync(join(f.out, 'native-r1.receipt.json')));
    assert.equal(receipt.rc, 0); assert.equal(receipt.runnerRc, 1); assert.equal(receipt.completion.failedTasks, 21);
    const b = fake(f); assert.equal(await runQueue({ ...f, runtime: b.runtime }), 0); assert.equal(b.calls.length, 0);
  } finally { rmSync(f.dir, { recursive: true }); }
});

test('a permission stop or retained lock after a runner prevents the next round', async () => {
  for (const retainedLock of [false, true]) {
    const f = fixture(); let locked = false;
    const a = fake(f, { locked: () => locked }), original = a.runtime.execute;
    a.runtime.execute = async (...args) => {
      const exit = await original(...args), call = args[0];
      if (call.result === invocation(f.steps[1], f).result) {
        if (retainedLock) locked = true;
        else { const data = nativeResult(f.steps[1].tasks); data.results[0].permissionPrompt = true; save(call.result, data); }
      }
      return exit;
    };
    try {
      assert.equal(await runQueue({ ...f, runtime: a.runtime }), 1); assert.equal(a.calls.length, 4);
      assert.equal(readFileSync(join(f.out, 'native-r1.rc'), 'utf8'), '1\n');
      assert.equal(existsSync(join(f.out, 'chrome-r1.rc')), false);
    } finally { rmSync(f.dir, { recursive: true }); }
  }
});

test('SIGHUP is ignored; repeated interruption forwards one SIGINT and waits for collection', async () => {
  const f = fixture(); let signals = 0, collected = false;
  const a = fake(f, { execute: async (_call, log, { onChild }) => {
    writeFileSync(log, 'fixture interruption\n');
    onChild({ kill: signal => { assert.equal(signal, 'SIGINT'); signals++; } });
    process.emit('SIGHUP'); process.emit('SIGINT'); process.emit('SIGTERM');
    await new Promise(r => setTimeout(r, 20)); collected = true; onChild(undefined);
    return { code: 130, signal: null };
  } });
  try {
    assert.equal(await runQueue({ ...f, runtime: a.runtime }), 130); assert.equal(signals, 1); assert.equal(collected, true);
    assert.match(readFileSync(join(f.out, 'queue.log'), 'utf8'), /ignored SIGHUP/);
    assert.equal(existsSync(join(f.out, '.queue-owner')), false);
  } finally { rmSync(f.dir, { recursive: true }); }
});

test('interrupted admission waits for its bounded host child instead of orphaning it', async () => {
  let collect, finished = false;
  const running = admission(() => new Promise(resolve => { collect = resolve; })).then(rc => { finished = true; return rc; });
  process.emit('SIGHUP'); process.emit('SIGINT');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  collect(); assert.equal(await running, 130);
  assert.equal(await admission(async () => {}), 0);
});

test('probe --out plans attributable child banks; dry mode never inspects or writes', async () => {
  const f = fixture(), out = join(f.dir, 'probe.json');
  try {
    const p = probePlan({ out }); assert.equal(p.runs[0].command.at(-1), out + '.native.json');
    assert.equal(p.runs[1].command.at(-1), out + '.chrome');
    await runProbe({ out, dryRun: true }, { exists: () => assert.fail('dry inspected host'), preflight: () => assert.fail('dry admission') });
    assert.equal(existsSync(out), false);
    const exit = process.exitCode;
    try {
      const r = await runProbe({ out, ownerAway: true, ownerSaysCursorFree: true }, { exists: () => false, preflight: async () => {},
        run: async () => ({ failed: true, groupClean: true }) });
      assert.equal(r.results.length, 1); assert.equal(r.failed, true); assert.equal(process.exitCode, 1);
      assert.equal(JSON.parse(readFileSync(out)).failed, true);
    } finally { process.exitCode = exit; }
    await assert.rejects(runProbe({ out, ownerAway: true, ownerSaysCursorFree: true }, { preflight: () => assert.fail('must refuse existing output first') }), /output already exists/);
  } finally { rmSync(f.dir, { recursive: true }); }
});
