// Offline C10 coverage. These tests never start the live fixture or a hand window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const root = new URL('../', import.meta.url).pathname;
const modulePath = new URL('../bench/hand/c10-night.mjs', import.meta.url);
const temp = () => trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'c10-test-'))));
async function api() {
  assert.ok(existsSync(modulePath), 'C10 runner exists');
  return import(modulePath);
}

test('the plan covers all seven features and makes hardware and audio limits visible', async () => {
  const { steps, dryRunPlan } = await api();
  assert.deepEqual(steps.map(s => s.id), ['pause', 'narration', 'voice', 'picker', 'perch', 'lines', 'replay']);
  const plan = dryRunPlan({ root, night: '<night>' }).join('\n');
  for (const text of ['--owner-away', 'hardware', '80 pt', '600', '3 s', '8 s', 'withheld', 'off by default', 'summary.md', 'screenshot', 'respawn']) assert.ok(plan.includes(text), text);
  for (const mode of ['--narration-voices', '--narration-selftest', '--cursor-menu-dump', '--perch-dump', '--ring-plan-dump', '/usr/bin/sips']) assert.ok(plan.includes(mode), mode);
  assert.ok(steps.every(s => s.estimateSeconds > 0));
});

test('CLI dry-run and missing owner flag do not create an output bank or invoke a compiler', async () => {
  await api(); const dir = temp();
  for (const args of [['--dry-run'], [], ['--surprise']]) {
    const p = spawnSync(process.execPath, ['bench/hand/c10-night.mjs', '--night', dir, ...args], { cwd: root, encoding: 'utf8', timeout: 5000 });
    assert.equal(p.status, args.includes('--dry-run') ? 0 : 2, p.stderr);
    assert.deepEqual(readdirSync(dir), []);
    assert.doesNotMatch(p.stderr, /spawn|compiler|swiftc.*error/);
  }
});

test('result validation requires finite counts, real evidence and an explicit reason for skipped checks', async () => {
  const { validateResult, totals } = await api(); const dir = temp();
  // A PNG signature alone is insufficient evidence.
  writeFileSync(join(dir, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const r = { id: 'pause', checks: [{ name: 'restore', status: 'pass', numbers: { acknowledgments: 2 }, screenshot: 'shot.png' }] };
  assert.throws(() => validateResult(r, dir), /PNG/);
  const { encodePng } = await import('../bench/hand/synthetic-character.mjs');
  writeFileSync(join(dir, 'shot.png'), encodePng(2, 2, new Uint8Array(16).fill(255)));
  assert.doesNotThrow(() => validateResult(r, dir));
  for (const check of [ { ...r.checks[0], numbers: { n: NaN } }, { ...r.checks[0], numbers: {} },
    { ...r.checks[0], screenshot: '../escape.png' }, { ...r.checks[0], status: 'skip' }, { ...r.checks[0], screenshot: 'absent.png' } ])
    assert.throws(() => validateResult({ ...r, checks: [check] }, dir));
  assert.deepEqual(totals([{ ...r, checks: [...r.checks, { name: 'hardware', status: 'skip', required: true, reason: 'needs hardware', numbers: { clicks: 0 }, screenshot: null }] }]),
    { pass: 1, fail: 0, skip: 1, requiredSkipped: 1 });
});

test('resume refuses a changed checkout and only reuses passed checks with intact evidence', async () => {
  const { assertIdentity, reusable, evidenceDigest } = await api(); const dir = temp();
  const identity = { root: '/checkout', head: 'a'.repeat(40) };
  assert.doesNotThrow(() => assertIdentity(identity, identity));
  assert.throws(() => assertIdentity(identity, { ...identity, head: 'b'.repeat(40) }), /checkout/);
  writeFileSync(join(dir, 'result.json'), '{}');
  const marker = { status: 'pass', directory: dir, digest: evidenceDigest(dir) };
  assert.equal(reusable(marker), true);
  writeFileSync(join(dir, 'result.json'), '{"changed":true}');
  assert.equal(reusable(marker), false);
  assert.equal(reusable({ ...marker, status: 'fail' }), false);
  assert.equal(reusable({ ...marker, status: 'incomplete' }), false);
});

test('step execution continues after a measured failure, saves each marker, and stops on owner return', async () => {
  const { executeSteps } = await api(); const saved = [], called = [];
  const result = status => ({ checks: [{ name: 'probe', status, numbers: { samples: 1 }, screenshot: 'shot.png' }] });
  const run = async step => { called.push(step.id); if (step.id === 'third') throw Object.assign(Error('owner returned'), { code: 'OWNER' }); return result(step.id === 'first' ? 'fail' : 'pass'); };
  const state = { markers: {} };
  const outcome = await executeSteps([{ id: 'first' }, { id: 'second' }, { id: 'third' }, { id: 'fourth' }], state,
    { run, save: () => saved.push(structuredClone(state)), canReuse: () => false });
  assert.deepEqual(called, ['first', 'second', 'third']);
  assert.deepEqual(saved.map(s => Object.keys(s.markers).length), [1, 2, 3]);
  assert.equal(state.markers.first.status, 'fail'); assert.equal(state.markers.second.status, 'pass');
  assert.equal(state.markers.third.status, 'interrupted'); assert.equal(outcome.stopped, 'OWNER');
});

test('summary counts failures and labels required skips attended, includes evidence paths and numbers', async () => {
  const { summaryMarkdown } = await api();
  const text = summaryMarkdown({ root, head: 'a'.repeat(40), startedAt: '2026-10-26', markers: {
    pause: { status: 'incomplete', directory: '/bank/pause', checks: [{ name: 'hardware', status: 'skip', required: true, reason: 'fresh hardware input required', numbers: { clicks: 0 }, screenshot: null }] },
    narration: { status: 'fail', directory: '/bank/narration', checks: [{ name: 'clear', status: 'fail', numbers: { pixels: 30 }, screenshot: 'clear.png' }] }
  } });
  for (const part of ['0 passed', '1 failed', '1 skipped', '1 required', 'clear.png', 'pixels=30', 'fresh hardware']) assert.ok(text.includes(part), part);
  assert.match(text, /attended/);
});

async function checksApi() {
  const path = new URL('../bench/hand/c10-checks.mjs', import.meta.url);
  assert.ok(existsSync(path), 'C10 checks exist'); return import(path);
}
test('narration fixture binds preceding prose, rejects future prose and redacts the fake card', async () => {
  const { narrationFixture } = await checksApi(); const n = narrationFixture();
  assert.equal(n.line, 'I will inspect the menu first.');
  assert.equal(n.future, undefined); assert.equal(n.redacted, 'Checking now.');
  assert.equal(n.fakeCard.replace(/ /g, '').length, 16);
});

test('replay records only delivered pixels through the real relay and recording stays off initially', async () => {
  const { replayProbe } = await checksApi(); const dir = temp();
  const result = await replayProbe({ root: join(dir, 'runs'), lease: join(dir, 'leases'), image: { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    encode: async () => ({ mimeType: 'image/jpeg', data: '/9j/2Q==', width: 200, height: 100 }) });
  assert.equal(result.offWriters, 0);
  assert.equal(result.withheldDelivered, 0); assert.equal(result.withheldRecorded, 0);
  assert.equal(result.delivered, 1); assert.equal(result.shots, 1);
  assert.equal(result.replies, 4);
  assert.deepEqual(result.records.filter(r => r.type === 'action').map(r => r.phase), ['aim', 'act', 'done']);
  assert.ok(result.pointPositions > 0);
  assert.equal(result.positions, result.records.length);
});

let nativeBins;
async function binaries() {
  if (nativeBins) return nativeBins;
  const dir = temp(), { swiftModuleCache } = await import('../bench/swift-cache.mjs');
  const bins = { host: join(dir, 'consent-host'), fixture: join(dir, 'c10-fixture') };
  for (const [source, out] of [['plugins/sleight/lib/direct-browser/native/consent-host.swift', bins.host], ['bench/hand/c10-fixture.swift', bins.fixture]]) {
    assert.ok(existsSync(join(root, source)), source);
    const p = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), join(root, source), '-o', out], { encoding: 'utf8', timeout: 300000 });
    assert.equal(p.status, 0, p.stderr);
  }
  return nativeBins = bins;
}
const native = { skip: process.platform !== 'darwin' && 'macOS compiler only' };
test('fixture selftest and invalid args construct no application or window', native, async t => {
  const { fixture } = await binaries();
  const p = spawnSync(fixture, ['--selftest'], { encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr);
  const data = JSON.parse(p.stdout); assert.equal(data.windowsCreated, 0); assert.equal(data.margin, 80);
  assert.equal(spawnSync(fixture, ['--unknown']).status, 64);
  t.diagnostic(`fixtureBytes=${(await import('node:fs')).statSync(fixture).size}`);
});

test('voice-bar pixel counter distinguishes three bars, merged blue ink and absence without a window', native, async () => {
  const { fixture } = await binaries();
  const width = 30, height = 20;
  for (const [positions, expected] of [[[9,12,15], 3], [[9,10,11], 1], [[], 0]]) {
    const pixels = Buffer.alloc(width * height * 4);
    for (const x of positions) for (let y = 4; y < 12; y++) for (let dx = 0; dx < 2; dx++) pixels.set([91,141,255,255], ((y * width) + x + dx) * 4);
    const p = spawnSync(fixture, ['--voice-pixels-selftest'], { input: JSON.stringify({ width, height, rgba: pixels.toString('base64') }), encoding: 'utf8', timeout: 5000 });
    assert.equal(p.status, 0, p.stderr); assert.equal(JSON.parse(p.stdout).voiceBars, expected);
    assert.equal(JSON.parse(p.stdout).windowsCreated, 0);
  }
});

test('display preflight reasons cover sleep, lock and missing session without reading the display', native, async () => {
  const { fixture } = await binaries();
  for (const [state, expected] of [[{ asleep: false, locked: false }, null], [{ asleep: true, locked: false }, 'display-asleep'],
    [{ asleep: false, locked: true }, 'screen-locked'], [{ asleep: true, locked: true }, 'screen-locked'], [{ asleep: false }, 'screen-lock-state-unknown']]) {
    const p = spawnSync(fixture, ['--display-selftest'], { input: JSON.stringify(state), encoding: 'utf8', timeout: 5000 });
    assert.equal(p.status, 0, p.stderr); assert.deepEqual(JSON.parse(p.stdout), { reason: expected, windowsCreated: 0 });
  }
});

test('native dump recipes verify narration geometry, perch cover and sleep, and 3/8 second line boundaries', native, async t => {
  const { buildCharacter, dumpScenarios, evaluateDump, runDump } = await checksApi(); const { host } = await binaries();
  const { Children } = await api(); const children = new Children(process.env, new AbortController().signal);
  const base = trackTemp(realpathSync(mkdtempSync(join('/private', 'tmp', 'c10-fixture-test-'))));
  const character = buildCharacter(base);
  const target = { pid: 42, id: 7, frame: [200, 200, 800, 500], displays: [{ frame: [0, 0, 1440, 900], top: 25 }] };
  const scenarios = dumpScenarios(target, character.frame);
  try { for (const s of scenarios) {
    const rows = await runDump({ children, binary: host, character, directory: base }, s);
    const answer = evaluateDump(s.id, rows);
    assert.equal(answer.pass, true, `${s.id}: ${JSON.stringify(answer)}`);
    t.diagnostic(`${s.id}: ${JSON.stringify(answer.numbers)}`);
  } } finally { await children.close(); }
});

test('capture text matching joins at most two rows and does not accept missing text', async () => {
  const { textMatches } = await checksApi();
  assert.equal(textMatches(['I will inspect', 'the menu first.'], 'I will inspect the menu first.'), true);
  assert.equal(textMatches(['Unrelated', 'text'], 'Checking now.'), false);
  assert.equal(textMatches(undefined, 'All done.'), false);
  assert.equal(textMatches(['anything'], ''), false);
});

test('child channel waits for fresh acknowledgments and closes through EOF', async () => {
  const { Children } = await api(); const dir = temp(), script = join(dir, 'child.mjs');
  writeFileSync(script, "import {createInterface} from 'node:readline';\nconst lines=createInterface({input:process.stdin});\nlines.on('line', text=>process.stdout.write(text+'\\n'));\n");
  const children = new Children(process.env, new AbortController().signal);
  try {
    const channel = children.start(process.execPath, [script]);
    channel.send({ ack: true, serial: 1 }); await channel.wait(r => r.ack);
    const after = channel.rows.length; channel.send({ ack: true, serial: 2 });
    assert.equal((await channel.wait(r => r.ack, 1000, after)).serial, 2);
    assert.equal((await channel.close()).code, 0);
    assert.equal(children.live.size, 0);
  } finally { await children.close(); }
});

test('dump uses Children.run to deliver the private decoder environment to the process', async () => {
  const { Children } = await api(), { runDump } = await checksApi();
  const directory = temp(), script = join(directory, 'env.mjs');
  writeFileSync(script, "process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({test:process.env.SLEIGHT_CURSOR_TEST,root:process.env.SLEIGHT_CURSOR_CHARACTERS_ROOT})));\n");
  const children = new Children({ ...process.env, SLEIGHT_CURSOR_TEST: 'wrong' }, new AbortController().signal);
  try {
    const rows = await runDump({ children, binary: process.execPath, directory,
      character: { env: { SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: directory } } },
      { id: 'environment', args: [script], frames: [] });
    assert.deepEqual(rows, [{ test: '1', root: directory }]);
    assert.equal(children.live.size, 0);
  } finally { await children.close(); }
});

test('awake assertion spans the body and is released on success and every stop reason', async () => {
  const { withAwake } = await api();
  for (const code of [null, 'OWNER', 'HOLD', 'TELEMETRY', 'SIGNAL', 'CLEANUP']) {
    const seen = [];
    const children = { start(command, args) {
      seen.push([command, ...args]);
      return { close: async () => { seen.push('released'); } };
    } };
    const body = async () => { seen.push('body'); if (code) throw Object.assign(Error(code), { code }); return 0; };
    if (code) await assert.rejects(withAwake(children, body), { code });
    else assert.equal(await withAwake(children, body), 0);
    assert.deepEqual(seen, [['/usr/bin/caffeinate', '-dims', '-w', String(process.pid)], 'body', 'released']);
  }
});

test('hold and lock waits log every 30 seconds, obey the cap and abort without touching either path', async () => {
  const { waitClear, parseArgs } = await api(); let now = 0; const logs = [], waits = [];
  const opts = { paths: ['hold', 'lock'], capMs: 180000, now: () => now, log: s => logs.push(s),
    exists: path => path === 'hold' ? now < 60000 : now < 90000,
    wait: async ms => { waits.push(ms); now += ms; } };
  await waitClear(opts);
  assert.deepEqual(waits, [30000, 30000, 30000]); assert.equal(logs.length, 3);
  assert.match(logs[0], /hold/); assert.match(logs[2], /lock/);
  now = 0;
  await assert.rejects(waitClear({ ...opts, capMs: 45000, exists: () => true }), { code: 'HOLD' });
  assert.equal(now, 45000);
  const controller = new AbortController(); controller.abort(Object.assign(Error('SIGNAL'), { code: 'SIGNAL' }));
  await assert.rejects(waitClear({ ...opts, signal: controller.signal }), { code: 'SIGNAL' });
  assert.equal(parseArgs(['--wait-cap-ms', '1000']).waitCapMs, 1000);
  assert.throws(() => parseArgs(['--wait-cap-ms', 'NaN']), /wait/);
});

test('a hold interrupts compile work, collects it, waits, and reruns the same work', async () => {
  const { runPhase, retryHeld } = await api(); let held = true, runs = 0, waits = 0, closed = 0;
  const answer = await retryHeld(() => runPhase(async signal => {
    runs++;
    if (!held) return 'compiled';
    try { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    finally { closed++; }
  }, { held: () => held, pollMs: 1 }), {
    wait: async () => { assert.equal(closed, 1); waits++; held = false; },
  });
  assert.equal(answer, 'compiled'); assert.equal(runs, 2); assert.equal(waits, 1);
});

test('stop reasons always map to numeric exit codes, including individual POSIX signals', async () => {
  const { exitStatus } = await api();
  for (const [reason, code] of [[undefined, 0], ['OWNER', 4], ['HOLD', 5], ['TELEMETRY', 6], ['CLEANUP', 1],
    ['SIGNAL', 130], ['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['unexpected', 1]])
    assert.equal(exitStatus(reason), code);
});

test('an abort inside hold waits or quiet sleeps retains its reason, summary and exit status', async () => {
  const { waitWithReason, waitClear, exitStatus, summaryMarkdown, executeSteps } = await api();
  for (const [code, status] of [['OWNER', 4], ['TELEMETRY', 6], ['SIGTERM', 143]]) {
    for (const wait of [signal => waitWithReason(10000, signal), signal => waitClear({ paths: ['fixture-hold'], exists: () => true, signal, log() {} })]) {
      const controller = new AbortController(), reason = Object.assign(Error(code), { code });
      const pending = wait(controller.signal); controller.abort(reason);
      await assert.rejects(pending, error => {
        assert.equal(error, reason); assert.equal(exitStatus(error.code), status);
        const summary = summaryMarkdown({ root, head: 'a'.repeat(40), markers: {} }, error.code);
        assert.match(summary, new RegExp(`Stopped: ${code}`)); assert.doesNotMatch(summary, /ABORT_ERR/); return true;
      });
    }
    const signal = new AbortController();
    const state = { markers: {} };
    const result = await executeSteps([{ id: 'quiet' }, { id: 'later' }], state, { signal: signal.signal, save() {}, canReuse: () => false,
      run: async step => {
        assert.equal(step.id, 'quiet'); const waiting = waitWithReason(10000, signal.signal);
        signal.abort(Object.assign(Error(code), { code })); return waiting;
      } });
    assert.equal(result.stopped, code); assert.equal(exitStatus(result.stopped), status);
    assert.equal(state.markers.later, undefined);
  }
});

test('a hold releases the owned fixture lock before waiting and reacquires after the quiet gap', async () => {
  const { releaseForHold } = await api(), { acquireLiveLock } = await import('../bench/live-lock.mjs');
  const path = join(temp(), 'fixture-lock'), order = [], lock = { unlock: await acquireLiveLock(path) };
  await releaseForHold(lock, {
    wait: async () => { assert.equal(lock.unlock, undefined); assert.equal(existsSync(path), false); order.push('wait');
      const filmUnlock = await acquireLiveLock(path); await filmUnlock(); },
    quiet: async () => { assert.equal(existsSync(path), false); order.push('quiet'); },
    acquire: async () => { order.push('acquire'); return acquireLiveLock(path); },
  });
  assert.deepEqual(order, ['wait', 'quiet', 'acquire']); assert.equal(existsSync(path), true); await lock.unlock();
  const stopped = { unlock: await acquireLiveLock(path) };
  await assert.rejects(releaseForHold(stopped, { wait: async () => { throw Object.assign(Error('OWNER'), { code: 'OWNER' }); },
    quiet: () => assert.fail('quiet after stop'), acquire: () => assert.fail('acquire after stop') }), { code: 'OWNER' });
  assert.equal(stopped.unlock, undefined); assert.equal(existsSync(path), false);
});

test('voice polling samples at 100 ms, catches a delayed start and stops at 3 seconds', async () => {
  const { waitForVoice } = await checksApi();
  for (const start of [0, 1700, 3000, 3100]) {
    let now = 0; const times = [];
    const result = await waitForVoice({ now: () => now, sleep: async ms => { now += ms; },
      sample: async () => { times.push(now); return { voiceBars: now >= start ? 3 : 0, screenshot: 'fixture.png' }; } });
    assert.deepEqual(times, Array.from({ length: Math.min(start, 3000) / 100 + 1 }, (_, i) => i * 100));
    assert.equal(result.firstSeenMs, start <= 3000 ? start : -1); assert.equal(result.samples, times.length);
  }
  const controller = new AbortController();
  const pending = waitForVoice({ signal: controller.signal, sleep: async () => {}, sample: () => new Promise(() => {}) });
  controller.abort(Object.assign(Error('OWNER'), { code: 'OWNER' })); await assert.rejects(pending, { code: 'OWNER' });
  let now = 0;
  const late = await waitForVoice({ now: () => now, sleep: async ms => { now += ms; },
    sample: async () => { now += 3001; return { voiceBars: 3 }; } });
  assert.equal(late.firstSeenMs, -1, 'bars observed after 3 seconds cannot pass');
});

test('captures retry only the failed shot once, preserving the reason when both attempts fail', async () => {
  const { captureWithRetry } = await checksApi(); const calls = [];
  const shot = async name => { calls.push(name); if (calls.length === 1) throw Error('capture-failed'); return { screenshot: name }; };
  const recovered = await captureWithRetry('one', shot);
  assert.deepEqual(calls, ['one.png', 'one-retry.png']); assert.equal(recovered.captureRetries, 1);
  assert.equal(recovered.screenshot, 'one-retry.png'); assert.deepEqual(recovered.captureErrors, ['capture-failed']);
  const failed = await captureWithRetry('two', async () => { throw Error('display-unavailable'); });
  assert.equal(failed.screenshot, null); assert.match(failed.error, /display-unavailable/);
  assert.equal(failed.captureAttempts, 2); assert.equal(failed.captureErrors.length, 2);
  const controller = new AbortController(); controller.abort(Object.assign(Error('OWNER'), { code: 'OWNER' }));
  await assert.rejects(captureWithRetry('stop', shot, controller.signal), { code: 'OWNER' });
});

test('failed capture evidence is valid only with an explicit failure reason', async () => {
  const { validateResult } = await api(), dir = temp();
  const row = { name: 'capture', status: 'fail', numbers: { captureAttempts: 2 }, screenshot: null, reason: 'capture-failed twice' };
  assert.doesNotThrow(() => validateResult({ id: 'lines', checks: [row] }, dir));
  assert.throws(() => validateResult({ id: 'lines', checks: [{ ...row, reason: undefined }] }, dir));
  assert.throws(() => validateResult({ id: 'lines', checks: [{ ...row, status: 'pass' }] }, dir));
});

test('sprite checks require 20 pixels or 2 percent of baseline, and clearing permits four pixels of noise', async () => {
  const { spriteDrew, spriteCleared, waitForSprite } = await checksApi();
  assert.equal(spriteDrew({ spritePixels: 0 }, { spritePixels: 0 }), false);
  for (const [baseline, margin] of [[0, 20], [100, 20], [2000, 40]]) {
    assert.equal(spriteDrew({ spritePixels: baseline }, { spritePixels: baseline + 1 }), false);
    assert.equal(spriteDrew({ spritePixels: baseline }, { spritePixels: baseline + margin - 1 }), false);
    assert.equal(spriteDrew({ spritePixels: baseline }, { spritePixels: baseline + margin }), true);
  }
  assert.equal(spriteCleared({ spritePixels: 0 }, { spritePixels: 0 }, { spritePixels: 0 }), false);
  assert.equal(spriteCleared({ spritePixels: 1 }, { spritePixels: 100 }, { spritePixels: 4 }), true);
  assert.equal(spriteCleared({ spritePixels: 1 }, { spritePixels: 100 }, { spritePixels: 8 }), false);
  let now = 0, samples = 0;
  const result = await waitForSprite({ baseline: { spritePixels: 1 }, now: () => now,
    shot: async () => ({ spritePixels: ++samples >= 3 ? 40 : 2 }), sleep: async ms => { now += ms; }, deadlineMs: 1000 });
  assert.equal(result.changed, true); assert.equal(result.latencyMs, 100); assert.equal(result.samples, 3);
  const late = await waitForSprite({ baseline: { spritePixels: 0 }, now: () => now, sleep: async () => {}, deadlineMs: 1000,
    shot: async () => { now += 1001; return { spritePixels: 40 }; } });
  assert.equal(late.changed, false, 'a slow capture must not qualify a frame observed after the deadline');
  let cancelled = false;
  const timed = await waitForSprite({ baseline: { spritePixels: 0 }, sleep: async () => {}, deadlineMs: 10,
    shot: (_i, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true })) });
  assert.equal(timed.changed, false); assert.equal(cancelled, true);
});

test('replay observes abort even while its encoder is waiting', async () => {
  const { replayProbe } = await checksApi(), dir = temp(), controller = new AbortController();
  let encoding;
  const began = new Promise(resolve => { encoding = resolve; });
  const pending = replayProbe({ root: join(dir, 'runs'), lease: join(dir, 'leases'), signal: controller.signal,
    image: { type: 'image', mimeType: 'image/png', data: 'AAAA' }, encode: () => { encoding(); return new Promise(() => {}); } });
  await began; controller.abort(Object.assign(Error('TELEMETRY'), { code: 'TELEMETRY' }));
  await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(Error('abort missed')), 1000))]), { code: 'TELEMETRY' });
});

test('deadline telemetry fails only its step, while other interruptions retry once and retain partial checks', async () => {
  const { executeSteps, runPhase } = await api(); const state = { markers: {} }, seen = [];
  const outcome = await executeSteps([{ id: 'slow' }, { id: 'flaky' }, { id: 'last' }], state, { canReuse: () => false, save() {},
    run: async (step, attempt) => {
      seen.push(`${step.id}:${attempt}`);
      if (step.id === 'slow') return runPhase(signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))), { deadlineMs: 1, held: () => false });
      if (step.id === 'flaky' && attempt === 1) throw Object.assign(Error('fixture disconnected'), {
        result: { checks: [{ name: 'first', status: 'pass', numbers: { samples: 1 }, screenshot: 'first.png' }] },
      });
      return { checks: [{ name: 'finished', status: 'pass', numbers: { samples: 1 }, screenshot: 'last.png' }] };
    } });
  assert.deepEqual(outcome, {}); assert.deepEqual(seen, ['slow:1', 'flaky:1', 'flaky:2', 'last:1']);
  assert.equal(state.markers.slow.reason, 'TELEMETRY'); assert.equal(state.markers.slow.status, 'fail');
  assert.equal(state.markers.flaky.history[0].checks[0].name, 'first');
});

test('mid-step hold waits after cleanup, then reruns that step in the same launch', async () => {
  const { executeSteps } = await api(); const seen = [], state = { markers: {} };
  const outcome = await executeSteps([{ id: 'first' }, { id: 'second' }], state, { canReuse: () => false, save() {},
    waitForHold: async () => { seen.push('wait'); }, run: async (step, attempt) => {
      seen.push(`${step.id}:${attempt}`);
      if (attempt === 1 && step.id === 'first') { seen.push('cleaned'); throw Object.assign(Error('hold'), { code: 'HOLD' }); }
      return { checks: [{ name: 'ok', status: 'pass', numbers: { acks: 1 }, screenshot: 'one.png' }] };
    } });
  assert.deepEqual(outcome, {}); assert.deepEqual(seen, ['first:1', 'cleaned', 'wait', 'first:2', 'second:1']);
});

test('unmarked hard-kill attempt is moved aside and the requested attempt runs', async () => {
  const { attemptDirectory } = await api(), dir = temp();
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'lines-1'), { mode: 0o700 }); writeFileSync(join(dir, 'lines-1', 'partial.json'), '{}');
  const path = attemptDirectory(dir, 'lines', 1);
  assert.equal(path, join(dir, 'lines-1')); assert.deepEqual(readdirSync(path), []);
  const aside = readdirSync(dir).find(n => n.startsWith('lines-1.abandoned-'));
  assert.ok(aside); assert.equal(readFileSync(join(dir, aside, 'partial.json'), 'utf8'), '{}');
});

test('attended checks exit successfully and intact incomplete attended markers are reused on resume', async () => {
  const { executeSteps, summaryMarkdown, evidenceDigest, reusable, runStatus } = await api(), dir = temp();
  writeFileSync(join(dir, 'result.json'), '{}');
  const checks = [{ name: 'hardware', status: 'skip', required: true, reason: 'physical input', numbers: { clicks: 0 }, screenshot: null }];
  const marker = { status: 'incomplete', checks, directory: dir, digest: evidenceDigest(dir) };
  assert.equal(reusable(marker), true);
  const state = { root, head: 'a'.repeat(40), markers: { pause: marker } };
  await executeSteps([{ id: 'pause' }], state, { run() { assert.fail('attended marker reran'); }, save() {} });
  assert.equal(state.markers.pause.status, 'attended');
  assert.match(summaryMarkdown(state), /attended/);
  assert.equal(runStatus(state, [{ id: 'pause' }]), 0);
  const fresh = { markers: {} };
  await executeSteps([{ id: 'pause' }], fresh, { run: async () => ({ ...marker }), save() {} });
  assert.equal(fresh.markers.pause.status, 'attended');
});

test('priority service transports stdin, output, environment and owned cleanup without nicing child commands', async () => {
  const { PrioritySpawner, priorityPlan } = await import('../bench/hand/c10-priority.mjs'), { Children } = await api();
  assert.deepEqual(priorityPlan(0), { servicePriority: 0, runnerPriority: 19 });
  // A real setPriority call with the planned value must be accepted (20 threw ERR_OUT_OF_RANGE live, 2026-10-27).
  assert.ok(priorityPlan(0).runnerPriority >= -20 && priorityPlan(0).runnerPriority <= 19);
  assert.throws(() => priorityPlan(20), /normal-priority launcher/);
  const spawner = new PrioritySpawner(process.env); await spawner.ready;
  const children = new Children(process.env, new AbortController().signal, spawner.spawn.bind(spawner));
  const dir = temp(), script = join(dir, 'echo.mjs');
  writeFileSync(script, "import {getPriority} from 'node:os'; let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>console.log(JSON.stringify({input,priority:getPriority(),env:process.env.C10_TEST})));\n");
  try {
    const value = JSON.parse(await children.run(process.execPath, [script], { input: 'private input', env: { ...process.env, C10_TEST: 'forwarded' } }));
    assert.equal(value.input, 'private input'); assert.equal(value.env, 'forwarded');
    assert.equal(value.priority, (await spawner.ready).priority);
    await assert.rejects(children.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 20 }), /timed out/);
    assert.equal(children.live.size, 0);
    await assert.rejects(children.run(join(dir, 'missing'), []), /exited/);
  } finally { await children.close(); await spawner.close(); }
});

test('priority service forwards a stop signal and stays available until the controller collects its child', async () => {
  const { PrioritySpawner } = await import('../bench/hand/c10-priority.mjs'), { Children } = await api();
  const spawner = new PrioritySpawner(process.env), controller = new AbortController(); await spawner.ready;
  spawner.onSignal = code => controller.abort(Object.assign(Error(code), { code }));
  const children = new Children(process.env, controller.signal, spawner.spawn.bind(spawner));
  try {
    const run = children.run(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    const rejected = assert.rejects(run, { code: 'SIGTERM' });
    spawner.service.kill('SIGTERM');
    await rejected; assert.equal(children.live.size, 0); assert.equal(spawner.service.exitCode, null);
  } finally { await children.close(); await spawner.close(); }
});

test('a timeout collects an owned child that ignores SIGTERM', async () => {
  const { Children } = await api(); const dir = temp(), script = join(dir, 'hang.mjs');
  writeFileSync(script, "process.on('SIGTERM',()=>{});\nsetInterval(()=>{},100);\n");
  const children = new Children(process.env, new AbortController().signal);
  try {
    await assert.rejects(Promise.race([children.run(process.execPath, [script], { timeout: 100 }),
      new Promise((_, reject) => setTimeout(() => reject(Error('uncollected child')), 3500))]), /timed out/);
    assert.equal(children.live.size, 0);
  } finally { await children.close(); }
});

test('evidence banks reject a foreign or linked destination', async () => {
  const { assertBank } = await api(); const dir = temp(), bank = join(dir, 'c10-bank');
  const { mkdirSync, symlinkSync } = await import('node:fs'); mkdirSync(bank, { mode: 0o700 });
  assert.doesNotThrow(() => assertBank(bank, dir));
  assert.throws(() => assertBank(dir, bank));
  const alias = join(dir, 'alias'); symlinkSync(bank, alias);
  assert.throws(() => assertBank(alias, dir));
});

test('synthetic character validates through the live dump child path without showing a panel', native, async t => {
  const { buildCharacter, runDump } = await checksApi(), { host } = await binaries(), { Children } = await api();
  const base = trackTemp(realpathSync(mkdtempSync(join('/private', 'tmp', 'c10-decode-test-')))), c = buildCharacter(base);
  const children = new Children(process.env, new AbortController().signal);
  try {
    const rows = await runDump({ children, binary: host, character: c, directory: base }, { id: 'decode', args: ['--check-character'], frames: [c.frame] });
    assert.equal(rows[0].loaded, true);
  } finally { await children.close(); }
  t.diagnostic(`hostBytes=${(await import('node:fs')).statSync(host).size}`);
});

test('all seven check drivers emit frames accepted by the native validator through simulated GUI boundaries', native, async t => {
  const { runCheck } = await checksApi(), { host: binary } = await binaries();
  const { Children, steps, validateResult } = await api();
  const { encodePng } = await import('../bench/hand/synthetic-character.mjs');
  const work = trackTemp(realpathSync(mkdtempSync(join('/private', 'tmp', 'c10-driver-test-'))));
  const real = new Children(process.env, new AbortController().signal);
  let traces = 0;
  try {
    for (const scenario of ['normal', 'capture-errors', 'no-sprite', 'weak-seat', 'muted-voice', 'silent-voice', 'delayed-voice', 'interrupted-lines']) {
    const plan = scenario === 'normal' ? steps : steps.filter(s => scenario.endsWith('voice') ? s.id === 'voice' : scenario === 'weak-seat' ? s.id === 'perch' : scenario === 'no-sprite' ? ['perch', 'narration'].includes(s.id) : s.id === 'lines');
    for (const step of plan) {
      const directory = join(work, `${step.id}-${scenario}`); (await import('node:fs')).mkdirSync(directory, { mode: 0o700 });
      const sessions = [];
      let shown = false, style = 'sprite', covered = false, active, now = 0, voiceRequestedAt, pausedAt, clearedAt;
      const ready = { pid: 42, id: 7, frame: [200, 200, 800, 500], displays: [{ frame: [0, 0, 1440, 900], top: 25 }, { frame: [1440, 0, 1440, 900], top: 25 }], clusterRightPt: 68 };
      const children = { env: process.env,
        run: (command, args, options) => {
          if (scenario === 'interrupted-lines' && args[0] === '--perch-dump') throw Error('dump process disconnected');
          return args[0] === '--narration-voices' ? Promise.resolve('[{"id":"fixture","name":"Fixture","language":"en"}]') : real.run(binary, args, options);
        },
        start: (_command, _args, options) => {
          const input = [], rows = []; sessions.push({ input, env: options.env });
          let cleared = false;
          const channel = { child: { pid: 100 + sessions.length }, rows,
            send(frame) {
              input.push(frame);
              if (frame.hand === 'act' && frame.say && step.id === 'voice') voiceRequestedAt = now;
              if (frame.hand === 'character') { rows.push({ hand: 'character', id: frame.id, loaded: true }); input.push({ dumpAwait: 'character' }); }
              if (frame.hand === 'pause-ack') rows.push({ hand: 'pause', token: frame.token, phase: 'restored', paused: frame.paused });
              if (frame.hand === 'clear') { cleared = true; clearedAt = now; shown = false; rows.push({ hand: 'clear-ready', token: frame.token }); }
              if (frame.hand === 'picker' && frame.op === 'style') style = frame.style;
              if (frame.hand === 'status' && ['done', 'error'].includes(frame.state)) cleared = false;
              if (frame.hand === 'status' && frame.state === 'paused') pausedAt = now;
              if (!cleared && ['aim', 'act', 'status'].includes(frame.hand)) shown = true;
            },
            wait(predicate, _ms, after = 0) { const row = rows.slice(after).find(predicate); assert.ok(row, 'ack emitted'); return Promise.resolve(row); },
            close: async () => ({ code: 0 }),
          }; active = channel; return channel;
        },
      };
      const fixture = {
        send(row) {
          if (row.op === 'cover') covered = row.covered;
          this.reply = { ...ready, token: row.token };
          if (row.op === 'audio') this.reply = { ...this.reply, muted: scenario === 'muted-voice', zeroVolume: false };
          if (row.op === 'shot') {
            if (row.name === 'second-display-baseline.png') assert.ok(now - clearedAt >= 250, 'clear settles before the baseline');
            if (row.name === 'voice-paused.png') assert.ok(now - pausedAt >= 150, 'pause settles before capture');
            if (scenario === 'capture-errors' && ['error.png', 'error-retry.png', 'done.png', 'done-retry.png'].includes(row.name)) {
              this.reply.error = 'capture-failed'; return;
            }
            if (row.name.startsWith('voice-')) { assert.equal(row.bubble?.length, 4, 'voice glyph region comes from the native bubble plan'); assert.equal(row.ocr, false); }
            writeFileSync(join(directory, row.name), encodePng(2, 2, new Uint8Array(16).fill(255)));
            const speaking = row.name.startsWith('voice-requested') && (scenario === 'normal' || scenario === 'delayed-voice' && now - voiceRequestedAt >= 1700);
            this.reply = { ...this.reply, screenshot: row.name, captureFrame: [0,0,2,2], spritePixels: scenario !== 'no-sprite' && shown && style === 'sprite' && !covered ? scenario === 'weak-seat' ? 1 : 100 : 0,
              voiceBars: speaking ? 3 : 0, voicePixels: speaking ? 80 : 0,
              hostWindows: shown ? 1 : 0, texts: ['I will inspect the menu first.', 'Checking now.', 'Ready to begin.', 'First step done.', 'That needs a look.', 'All done.'] };
          }
          if (row.op === 'replay') {
            const html = readFileSync(join(directory, 'replay.html'), 'utf8');
            const data = JSON.parse(html.match(/<script[^>]*id="run-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
            this.reply = { ...this.reply, positions: data.length, imageShown: true };
          }
        },
        wait(predicate) { assert.ok(predicate(this.reply)); return Promise.resolve(this.reply); },
      };
      const promise = runCheck(step.id, { children, fixture, ready, directory, bin: work, work, now: () => now, sleep: async ms => { now += ms; }, signal: new AbortController().signal });
      let result;
      if (scenario === 'interrupted-lines') {
        await assert.rejects(promise, /dump process disconnected/);
        result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
        assert.equal(result.checks.length, 4); assert.ok(result.checks.every(c => c.status === 'pass'));
      } else result = await promise;
      validateResult(result, directory);
      assert.ok(result.checks.length > 0);
      for (const session of sessions) {
        real.env = session.env;
        const dump = await real.run(binary, ['--ring-plan-dump', '--cursor-style=sprite'], { input: session.input.map(r => JSON.stringify(r)).join('\n') + '\n' }).catch(e => { throw Error(`${step.id}: ${e.message}`); });
        assert.ok(dump.includes('"effect":"end"'));
        assert.ok(dump.includes('"loaded":true'), `${step.id}: synthetic sheet decoded`);
        traces++;
      }
      if (['pause', 'picker'].includes(step.id)) assert.ok(result.checks.some(c => c.required && c.status === 'skip'));
      const failed = result.checks.filter(c => c.status === 'fail');
      if (scenario === 'capture-errors') {
        assert.deepEqual(failed.map(c => c.name), ['live error text', 'live done text']);
        assert.equal(result.checks.filter(c => c.status === 'pass').length, 7);
        assert.equal(failed[0].numbers.captureAttempts, 2);
        assert.equal(JSON.parse(readFileSync(join(directory, 'result.json'))).checks.length, result.checks.length);
      } else if (scenario === 'no-sprite') {
        assert.ok(failed.some(c => c.name === (step.id === 'perch' ? 'cover by another fixture window' : 'nothing shown during clear')));
      } else if (scenario === 'weak-seat') {
        for (const name of ['seat and traffic-light margin', 'uncover restores seat', 'second display seat']) assert.ok(failed.some(c => c.name === name), name);
      } else if (scenario === 'silent-voice') {
        assert.equal(failed.length, 2); assert.equal(JSON.parse(readFileSync(join(directory, 'audio-output.json'))).muted, false);
      } else {
        assert.deepEqual(failed, [], `${step.id}/${scenario}: all authored observations qualify`);
        if (step.id === 'picker' && scenario === 'normal') {
          assert.equal(result.checks.find(c => c.name === 'built-in character list').numbers.bundled, 6);
        }
        if (scenario === 'muted-voice') assert.ok(result.checks.some(c => c.required && c.status === 'skip' && c.numbers.muted === 1));
        if (scenario === 'delayed-voice') {
          const voice = result.checks.find(c => c.name === 'voice line started (three blue bars)');
          assert.equal(voice.numbers.firstSeenMs, 1700); assert.equal(voice.numbers.samples, 18);
        }
      }
      assert.ok(active);
    } }
    t.diagnostic(`validatedDriverSessions=${traces}; GUI observations are simulated, no windows opened`);
  } finally { await real.close(); }
});
