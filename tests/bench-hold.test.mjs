import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { waitForBenchmark, runTaskWithHold, benchmarkStopCode } from '../bench/hold.mjs';
import { runRealGate } from '../bench/fowl/real-gate.mjs';
import { prepareSafariBridge } from '../bench/fowl/safari-browser.mjs';
import { executeRealTask } from '../bench/real-run.mjs';

test('unrelated AbortErrors remain failures unless the boundary signal was aborted', () => {
  const controller = new AbortController();
  const error = Object.assign(Error('transport failed'), { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(benchmarkStopCode(error), undefined);
  assert.equal(benchmarkStopCode(error, controller.signal), undefined);
  controller.abort();
  assert.equal(benchmarkStopCode(error, controller.signal), 130);
  assert.equal(benchmarkStopCode({ code: 'BENCH_HOLD_LIMIT' }), 75);
});

test('invalid hold overrides name the variable that needs correction', async () => {
  for (const key of ['SLEIGHT_HOLD_WAIT_MAX_MS', 'SLEIGHT_HOLD_RETRIES']) {
    const prior = process.env[key];
    process.env[key] = 'invalid';
    try {
      const operation = key.endsWith('MAX_MS') ? () => waitForBenchmark() : () => runTaskWithHold(() => {});
      await assert.rejects(operation, error => error.message.includes(key));
    } finally { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; }
  }
});

test('boundary waits log the marker first line every five minutes and stop at the ceiling', async () => {
  let now = 0;
  const logs = [];
  await assert.rejects(waitForBenchmark({ held: () => true, now: () => now, interval: 60000,
    maxWaitMs: 660000, marker: () => 'Puddle census\nprivate second line', log: line => logs.push(line),
    wait: async ms => { now += ms; assert.ok(now <= 660000, 'wait exceeded ceiling'); } }), error => error.exitCode === 75 && /wait limit/.test(error.message));
  assert.equal(now, 660000);
  assert.equal(logs.length, 3);
  for (const [i, line] of logs.entries()) {
    assert.match(line, /Puddle census/);
    assert.ok(line.includes(`${i * 300000} ms`), line);
    assert.doesNotMatch(line, /private second line/);
  }
});

test('held retries are bounded, preserve the last excluded attempt and never start a seventh attempt', async () => {
  let held = false, attempts = 0;
  const excluded = [];
  await assert.rejects(runTaskWithHold(async attempt => { attempts++; assert.ok(attempt <= 6, 'too many attempts'); held = true; return attempt; }, {
    held: () => held, wait: async () => { held = false; }, log() {},
    onRetry: result => excluded.push(result),
  }), error => error.exitCode === 75 && /retry limit/.test(error.message));
  assert.equal(attempts, 6);
  assert.deepEqual(excluded, [1, 2, 3, 4, 5, 6]);
});

test('hold limits honor environment overrides and a cleared marker wins at the deadline', async () => {
  const previous = { max: process.env.SLEIGHT_HOLD_WAIT_MAX_MS, retries: process.env.SLEIGHT_HOLD_RETRIES };
  try {
    process.env.SLEIGHT_HOLD_WAIT_MAX_MS = '7'; process.env.SLEIGHT_HOLD_RETRIES = '0';
    let now = 0, held = true, attempts = 0;
    await assert.rejects(waitForBenchmark({ held: () => held, now: () => now, log() {},
      wait: async ms => { now += ms; assert.ok(now <= 7, 'wait exceeded environment ceiling'); } }), error => error.exitCode === 75);
    assert.equal(now, 7);
    await assert.rejects(runTaskWithHold(async () => { attempts++; held = true; }, {
      boundary: async () => {}, canRetry: () => true,
      held: () => held && attempts > 0, onRetry() {},
    }), error => error.exitCode === 75);
    assert.equal(attempts, 1);
    now = 0;
    assert.equal(await waitForBenchmark({ held: () => now < 7, now: () => now, log() {},
      wait: async ms => { now += ms; } }), true);
  } finally {
    for (const [key, value] of [['SLEIGHT_HOLD_WAIT_MAX_MS', previous.max], ['SLEIGHT_HOLD_RETRIES', previous.retries]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('the default hold ceiling is six hours without sleeping in real time', async () => {
  let now = 0;
  const previous = process.env.SLEIGHT_HOLD_WAIT_MAX_MS;
  delete process.env.SLEIGHT_HOLD_WAIT_MAX_MS;
  try {
    await assert.rejects(waitForBenchmark({ held: () => true, now: () => now, interval: 86400000,
      marker: () => 'fake hold', log() {}, wait: async ms => { now += ms; assert.ok(now <= 21600000); } }),
    error => error.exitCode === 75);
    assert.equal(now, 21600000);
  } finally { if (previous !== undefined) process.env.SLEIGHT_HOLD_WAIT_MAX_MS = previous; }
});

test('hold waits are outside the operation and an overlapped task reruns after collection', async () => {
  const calls = [], excluded = [];
  let held = true;
  const result = await runTaskWithHold(async attempt => {
    assert.equal(held, false);
    calls.push(`task-${attempt}`);
    if (attempt === 1) held = true;
    calls.push(`collected-${attempt}`);
    return attempt;
  }, { held: () => held, wait: async () => { calls.push('wait'); held = false; }, log() {},
    onRetry: value => excluded.push(value) });
  assert.equal(result, 2);
  assert.deepEqual(excluded, [1]);
  assert.deepEqual(calls, ['wait', 'task-1', 'collected-1', 'wait', 'task-2', 'collected-2']);
});

test('the task monitor remembers a hold that clears before the task ends', async () => {
  let active = false, sampled = false, attempts = 0, retries = 0;
  await runTaskWithHold(async attempt => {
    attempts++;
    active = attempt === 1;
    if (active) await new Promise(resolve => setTimeout(resolve, 20));
    active = false;
  }, { interval: 1, held: () => active && !sampled && (sampled = true), onRetry: () => { retries++; } });
  assert.equal(sampled, true);
  assert.equal(attempts, 2);
  assert.equal(retries, 1);
});

test('abort during a hold stops before the next task and clears the wait', async () => {
  const controller = new AbortController();
  await assert.rejects(runTaskWithHold(() => assert.fail('task'), { signal: controller.signal,
    held: () => true, wait: async () => controller.abort(Error('operator stop')), log() {} }), /operator stop/);
  await assert.rejects(waitForBenchmark({ signal: controller.signal, held: () => false }), /operator stop/);
});

test('a safety stop or unproven cleanup never becomes a hold retry', async () => {
  for (const abort of [true, false]) {
    let held = false, calls = 0;
    const controller = new AbortController();
    await runTaskWithHold(async () => {
      calls++; held = true;
      if (abort) controller.abort();
    }, { held: () => held, signal: controller.signal, canRetry: () => false,
      onRetry: () => assert.fail('unsafe retry') });
    assert.equal(calls, 1);
  }
});

function gate(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hb1-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const config = { args: { surface: 'codex', 'real-browser': 'chrome', out: join(dir, 'out') },
    tasks: ['one', 'two'].map(name => ({ name, browser: 'chrome', prompt: 'Fixture in {browser}', result: 'done' })),
    runner: { gradeOutcome: () => ({ problems: [] }), gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath: join(dir, 'lock'), hold: { held: () => false }, admit: async () => {},
      commits: () => ({}), readEngine: () => ({}),
      prepareArms: async () => ({ receipt: {}, release: async () => { calls.push('release'); } }),
      startSites: async () => ({ close: async () => { calls.push('sites'); } }), checkOwner: async () => ({ ok: true }),
      launchBrowser: async plan => ({ ...plan, pid: 50, stop: async () => { calls.push('browser'); return { browserClosed: true }; },
        dispose: async () => { calls.push('helper'); } }),
      resetBrowser: async () => ({}), observeBrowser: async () => ({}),
      runAgent: async arm => {
        mkdirSync(arm.dir, { recursive: true }); calls.push(arm.task.name);
        return { groupClean: true, exitCode: 0, result: { result: 'RESULT: done' }, started: 1, finished: 2 };
      }, ...overrides } };
  config.runtime.hold = { marker: () => 'fake hold', ...config.runtime.hold };
  return { dir, calls, config };
}

test('browser round reruns a held task, preserves its raw attempt, and scores only the new timing', async t => {
  let held = false, attempts = 0;
  const f = gate(t, { hold: { held: () => held, wait: async () => { f.calls.push('wait'); held = false; }, log() {} } });
  const run = f.config.runtime.runAgent;
  f.config.runtime.runAgent = async arm => {
    const result = await run(arm);
    if (++attempts === 1) held = true;
    return { ...result, finished: attempts === 1 ? 9001 : 3 };
  };
  const rows = await runRealGate(f.config);
  assert.equal(attempts, 3);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.wallMs === 2));
  assert.ok(f.calls.indexOf('wait') < f.calls.lastIndexOf('one'));
  const excluded = JSON.parse(readFileSync(join(f.config.args.out, 'held-attempts.jsonl'), 'utf8'));
  assert.equal(excluded.wallMs, 9000);
  const archive = join(f.config.args.out, 'held-attempts', 'one-1');
  assert.equal(JSON.parse(readFileSync(join(archive, 'run.json'))).wallMs, 9000);
  assert.equal(JSON.parse(readFileSync(join(archive, 'harness-failure.json'))).reason, 'benchmark hold overlapped task');
  assert.equal(JSON.parse(readFileSync(join(f.config.args.out, 'one', 'run.json'))).wallMs, 2);
  assert.equal(excluded.excluded, 'benchmark hold overlapped task');
  assert.equal(existsSync(f.config.runtime.lockPath), false);
  assert.deepEqual(f.calls.slice(-4), ['release', 'sites', 'browser', 'helper']);
});

test('stop during a boundary wait collects fixtures and releases the fake lock', async t => {
  t.after(() => { process.exitCode = 0; });
  let held = false;
  const f = gate(t, { hold: { held: () => held, wait: async () => process.emit('SIGINT'), log() {} } });
  const run = f.config.runtime.runAgent;
  f.config.runtime.runAgent = async arm => { const result = await run(arm); held = true; return result; };
  await runRealGate(f.config);
  assert.equal(process.exitCode, 130);
  assert.equal(f.calls.filter(call => call === 'one').length, 1);
  assert.ok(!f.calls.includes('two'));
  assert.ok(f.calls.includes('browser'));
  assert.ok(f.calls.includes('helper'));
  assert.equal(existsSync(f.config.runtime.lockPath), false);
});

test('a held retry limit archives evidence and releases only the collected fake round lock', async t => {
  t.after(() => { process.exitCode = 0; });
  let held = false;
  const f = gate(t, { hold: { held: () => held, retries: 0, log() {} } });
  const run = f.config.runtime.runAgent;
  f.config.runtime.runAgent = async arm => { const result = await run(arm); held = true; return result; };
  await runRealGate(f.config);
  assert.equal(process.exitCode, 75);
  assert.equal(existsSync(f.config.runtime.lockPath), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.config.args.out, 'results.json'))), []);
  assert.equal(f.calls.filter(call => call === 'one').length, 1);
  assert.ok(f.calls.includes('helper'));
});

test('a hold limit before admission acquires no lock or fixtures', async t => {
  t.after(() => { process.exitCode = 0; });
  let now = 0;
  const f = gate(t, { hold: { held: () => true, now: () => now, maxWaitMs: 1,
    wait: async ms => { now += ms; }, log() {} } });
  await runRealGate(f.config);
  assert.equal(process.exitCode, 75);
  assert.equal(existsSync(f.config.runtime.lockPath), false);
  assert.equal(existsSync(f.config.args.out), false);
  assert.deepEqual(f.calls, []);
});

test('a hold limit with uncertain round cleanup keeps the lock and exits one', async t => {
  t.after(() => { process.exitCode = 0; });
  let held = false;
  const f = gate(t, { hold: { held: () => held, retries: 0, log() {} },
    prepareArms: async () => ({ receipt: {}, release: async () => { throw Error('not collected'); } }) });
  const run = f.config.runtime.runAgent;
  f.config.runtime.runAgent = async arm => { const result = await run(arm); held = true; return result; };
  await runRealGate(f.config);
  assert.equal(process.exitCode, 1);
  assert.equal(existsSync(f.config.runtime.lockPath), true);
  assert.ok(f.calls.includes('helper'));
});

test('a resumed round preserves an existing held archive with the same task and attempt', async t => {
  let held = false, attempts = 0;
  const f = gate(t, { hold: { held: () => held, wait: async () => { held = false; }, log() {} } });
  const old = join(f.config.args.out, 'held-attempts', 'one-1');
  mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'previous'), 'keep');
  const run = f.config.runtime.runAgent;
  f.config.runtime.runAgent = async arm => { const result = await run(arm); if (++attempts === 1) held = true; return result; };
  await runRealGate(f.config);
  assert.equal(readFileSync(join(old, 'previous'), 'utf8'), 'keep');
  assert.equal(readdirSync(join(f.config.args.out, 'held-attempts')).length, 2);
  assert.equal(existsSync(f.config.runtime.lockPath), false);
});

test('cleanup failures still collect independent children and retain the fake lock', async t => {
  const f = gate(t, { prepareArms: async () => ({ receipt: {}, release: async () => { throw Error('release failed'); } }) });
  await runRealGate(f.config);
  assert.ok(f.calls.includes('sites'));
  assert.ok(f.calls.includes('helper'));
  assert.ok(f.calls.includes('browser'));
  assert.equal(existsSync(f.config.runtime.lockPath), true);
  // This expected cleanup failure belongs to the fake round, not the test runner.
  process.exitCode = 0;
});

test('Safari transport disposal bounds a stuck helper and confirms close after its owned signal', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hb1-helper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter(), signals = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_data, _encoding, callback) { callback(); } });
  child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') setImmediate(() => child.emit('close', 0)); return true; };
  const bridge = await prepareSafariBridge(root, { compile: async () => {}, spawnBrowser: () => child, timeoutMs: 10 });
  await bridge.close();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  await bridge.close();
  assert.equal(signals.length, 2);
});

test('permission stop collects a browser transport without unsafe app cleanup and keeps the fake lock', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hb1-stop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = { dir: join(root, 'fixture'), lockPath: join(root, 'lock') };
  let disposed = false;
  const result = await executeRealTask({ setup() {}, prompt: () => 'fixture', check() {},
    cleanup: () => assert.fail('permission blocks app cleanup') }, ctx, {
    permissionCheck: async () => true,
    drive: () => assert.fail('permission blocks model'),
  });
  // No fixture was launched above. Exercise a permission arriving after setup too.
  assert.equal(result.permissionPrompt, true);
  let reads = 0;
  const active = await executeRealTask({ setup(context) { context.disposeResources = async () => { disposed = true; }; },
    prompt: () => 'fixture', check: () => true, cleanup: () => assert.fail('permission blocks app cleanup') }, ctx, {
    permissionCheck: async () => ++reads > 1, drive: async () => ({ code: 0, groupClean: true }) });
  assert.equal(disposed, true);
  assert.equal(active.permissionPrompt, true);
  assert.equal(existsSync(ctx.lockPath), true);
});
