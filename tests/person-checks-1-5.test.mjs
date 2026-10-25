import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLiveLock } from '../bench/live-lock.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import { checks, parseArgs, plan, instrumentHost, compileOnly, openHost, runCheck, waitForHold, runLive, writeResult } from '../bench/person-checks-1-5.mjs';

const runner = fileURLToPath(new URL('../bench/person-checks-1-5.mjs', import.meta.url));
const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quiet = () => {};

// Real production nonce channel and handoff waiter, fake child pipes only. No native binary executes.
function fixture(check, options = {}) {
  let child, frame, host, closed = false, reads = 0;
  const timers = [];
  const receipt = row => child.stderr.write(`PC1 ${JSON.stringify(row)}\n`);
  const accept = () => {
    const typed = options.typed ?? check.mode === 'typed';
    receipt({ event: 'dispatch', typed, keyCode: typed ? 36 : -1, mouse: !typed,
      voiceOver: options.voiceOver ?? Boolean(check.voiceOver) });
    child.stdout.write(JSON.stringify({ id: frame.id, nonce: frame.nonce,
      choice: check.target ? 'continue' : 'once' }) + '\n');
  };
  const open = () => {
    host = openHost({ binaries: { host: 'FAKE-NO-EXEC' }, directory: tmpdir(), spawnProcess(command, args) {
      assert.equal(command, 'FAKE-NO-EXEC'); assert.deepEqual(args, []);
      child = new EventEmitter(); child.pid = 4321;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.on('data', data => {
        const message = JSON.parse(String(data));
        if (message.dismiss) return;
        frame = message; reads++;
        receipt({ event: 'ready', pid: options.wrongPid ? 9999 : child.pid, x: 20, y: 40 });
        if (check.mode === 'key') receipt({ event: 'focused' });
        if (['typed', 'click'].includes(check.mode) && !options.silent) {
          timers.push(setTimeout(accept, options.early ? 0 : 100));
        }
      });
      child.stdin.on('end', () => {
        for (const timer of timers) clearTimeout(timer);
        closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', options.closeCode ?? 0);
      });
      // A PassThrough's readable side needs draining to observe its writable end.
      return child;
    } });
    return host;
  };
  const post = async attempt => {
    assert.equal(attempt.pid, child.pid);
    assert.equal(attempt.mode, check.mode === 'key' ? 'key' : 'click');
    if (check.mode === 'posted-click') assert.deepEqual([attempt.x, attempt.y], [20, 40]);
    if (options.postFail) return { status: 1 };
    if (!options.noRefusal) receipt({ event: 'refused', code: 'PERSON_INPUT_REQUIRED' });
    if (options.unexpectedAccept) accept();
    return { status: 0 };
  };
  return { open, post, closed: () => closed, reads: () => reads };
}
const runFixture = async (check, options = {}) => {
  const f = fixture(check, options);
  const row = await runCheck(check, { ...f, say: quiet, personMs: 1000, observeMs: 40, ...options.run });
  assert.equal(f.closed(), true); assert.equal(f.reads(), 1);
  return row;
};

test('strict arguments require owner presence and reject accidental benchmark/unknown modes', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, compileOnly: false });
  assert.deepEqual(parseArgs(['--owner-present']), { dryRun: false, compileOnly: false });
  assert.deepEqual(parseArgs(['--compile-only']), { dryRun: false, compileOnly: true });
  for (const args of [[], ['--owner-away'], ['--run'], ['--dry-run', '--owner-present'],
    ['--owner-present', '--compile-only'], ['--owner-present', '--owner-present'], ['--dry-run', '--out', 'elsewhere']]) {
    assert.throws(() => parseArgs(args), /usage/);
  }
});

test('dry plan is inert even with Node denying subprocesses, writes and network', () => {
  const result = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', runner, '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const p = JSON.parse(result.stdout);
  assert.deepEqual(p, plan());
  assert.equal(p.checks.length, 7);
  assert.deepEqual(p.checks.filter(c => c.target).map(c => [c.target, c.expected]),
    [['native', 'accepted'], ['native', 'refused'], ['browser', 'accepted'], ['browser', 'refused']]);
  assert.equal(p.estimatedOwnerMinutes, 10);
});

test('private instrumentation retains production entry and guards, and fails closed on source drift', () => {
  const privateSource = instrumentHost(source);
  assert.ok(privateSource.endsWith(source.slice(source.indexOf('// No arguments: the consent host.'))));
  for (const line of source.split('\n').filter(line => /guard|personInput\(event.cgEvent\)|window.firstResponder|event.window/.test(line))) {
    assert.ok(privateSource.includes(line), line);
  }
  assert.match(privateSource, /pc1Receipt\("dispatch"/);
  assert.match(privateSource, /pc1Receipt\("focused"/);
  assert.match(privateSource, /pc1Receipt\("ready"/);
  assert.throws(() => instrumentHost('drift'), /SOURCE_DRIFT/);
  assert.throws(() => instrumentHost(source.replace('return sender.sendAction', 'return dispatchChanged')), /SOURCE_DRIFT/);
});

test('host and fixture poster compile only; no native window or poster runs', { skip: macCommandSkip('xcrun'), timeout: 660000 }, t => {
  const bank = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-person-check-build-'))));
  const binaries = compileOnly(bank);
  assert.ok(existsSync(binaries.host)); assert.ok(existsSync(binaries.poster));
  assert.match(binaries.sourceSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(binaries.sourceSha256, binaries.instrumentedSha256);
});

test('all seven checks use authenticated fixture replies and collect the owned host', async () => {
  for (const check of checks) {
    const row = await runFixture(check);
    assert.equal(row.passed, true, JSON.stringify(row));
    assert.equal(row.outcome, check.expected);
    assert.equal(row.cleanupConfirmed, true);
    assert.equal(row.resumed, check.target && check.expected === 'accepted' ? true : false);
    assert.equal(row.freshReads, row.resumed ? 1 : 0);
    assert.ok(row.durationMs >= 0);
    assert.ok(Date.parse(row.endedAt) >= Date.parse(row.startedAt));
    if (check.expected === 'refused') {
      assert.equal(row.refusalCode, 'PERSON_INPUT_REQUIRED');
      assert.equal(row.pendingAfterPost, true);
    }
  }
});

test('wrong input route, VoiceOver state, PID, early resume and failed post cannot pass', async () => {
  for (const [index, options] of [[0, { typed: false }], [2, { voiceOver: false }], [0, { wrongPid: true }],
    [3, { typed: true }], [3, { early: true }], [4, { postFail: true }], [4, { unexpectedAccept: true }],
    [1, { unexpectedAccept: true }], [0, { silent: true, run: { personMs: 80 } }]]) {
    assert.equal((await runFixture(checks[index], options)).passed, false);
  }
});

test('no refusal receipt is an error, and a nonzero host close leaves cleanup unproved', async () => {
  const missing = await runFixture(checks[1], { noRefusal: true, run: {
    now: (() => { let n = Date.now(); return () => (n += 1000); })(), pause: async () => {} } });
  assert.equal(missing.passed, false);
  assert.equal(missing.outcome, 'error');
  const failed = await runFixture(checks[0], { closeCode: 65 });
  assert.equal(failed.cleanupConfirmed, false); assert.equal(failed.passed, false);
});

test('hold waits are bounded, abortable and never remove a hold', async () => {
  let n = 0, heldReads = 0;
  await waitForHold({ now: () => n, pause: async ms => { n += ms; }, isHeld: () => ++heldReads < 3, capMs: 2000 });
  assert.equal(n, 1000);
  await assert.rejects(waitForHold({ now: () => n, pause: async ms => { n += ms; }, isHeld: () => true, capMs: 700 }), /HOLD_TIMEOUT/);
  await assert.rejects(waitForHold({ isHeld: () => true, signal: AbortSignal.abort(Error('cancelled')) }), /cancelled/);
  await assert.rejects(waitForHold({ isHeld: () => { throw Error('unreadable'); } }), /unreadable/);
});

function liveOptions(overrides = {}) {
  let index = 0, saved, cleaned = 0, released = 0, locked = 0;
  const options = { compile: async () => ({ sourceSha256: 'a'.repeat(64), instrumentedSha256: 'b'.repeat(64) }),
    open: () => fixture(checks[index++]).open(), post: async () => { throw Error('no poster in this failure fixture'); },
    voiceOver: async () => false, isHeld: () => false, say: quiet,
    lock: async (_path, args) => { locked++; assert.equal(args.wait, true); return async () => { released++; }; },
    cleanup: async () => { cleaned++; }, save: async result => { saved = result; }, ...overrides };
  return { options, state: () => ({ saved, cleaned, released, locked }) };
}

test('live lock wait has a cap and starts no compiler/card before ownership', async () => {
  let built = false;
  const f = liveOptions({ capMs: 20, compile: () => { built = true; }, lock: async (_path, { signal }) => {
    await delay(40); signal.throwIfAborted();
  } });
  const result = await runLive(f.options);
  assert.equal(built, false); assert.equal(result.passed, false);
  assert.equal(result.error, 'PERSON_CHECK_LOCK_HOLD_WAIT_TIMEOUT');
  assert.equal(result.checks.length, 0); assert.equal(result.notRun.length, 7);
  assert.equal(f.state().cleaned, 1); assert.equal(f.state().saved, result);
});

test('complete live pass saves seven timed rows and releases only after child and bank cleanup', async () => {
  let current, index = 0, voiceReads = 0;
  const order = [], h = liveOptions({ checkOptions: { observeMs: 40, personMs: 1000 },
    open: () => { current = fixture(checks[index++]); return current.open(); },
    post: attempt => current.post(attempt), voiceOver: async () => { voiceReads++; return false; },
    cleanup: async () => { assert.equal(current.closed(), true); order.push('clean'); },
    lock: async () => async () => { order.push('release'); },
    save: async () => { order.push('save'); } });
  const result = await runLive(h.options);
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.schemaVersion, 1); assert.equal(result.ownerPresent, true); assert.equal(result.fixtureOnly, true);
  assert.equal(result.sourceSha256, 'a'.repeat(64)); assert.equal(result.instrumentedSha256, 'b'.repeat(64));
  assert.equal(result.checks.length, 7); assert.deepEqual(result.notRun, []);
  assert.deepEqual(order, ['clean', 'release', 'save']); assert.equal(voiceReads, 2);
});

test('already aborted work never launches or presents a card', async () => {
  let opened = false;
  await assert.rejects(runCheck(checks[0], { signal: AbortSignal.abort(Error('stop first')),
    open: () => { opened = true; } }), /stop first/);
  assert.equal(opened, false);
});

test('real cooperative lock uses only an injected temporary path and releases its own directory', async t => {
  const bank = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-person-lock-'))), path = join(bank, 'lock');
  const release = await acquireLiveLock(path);
  const f = liveOptions({ capMs: 20, lock: (_unused, args) => acquireLiveLock(path, { ...args, interval: 5 }) });
  assert.equal((await runLive(f.options)).passed, false);
  assert.equal(existsSync(path), true);
  await release(); assert.equal(existsSync(path), false);
});

test('interruption closes a pending host before releasing lock and saving failure', async () => {
  const controller = new AbortController(), f = fixture(checks[0], { silent: true });
  let closedBeforeRelease = false;
  const h = liveOptions({ open: f.open, signal: controller.signal,
    lock: async () => async () => { closedBeforeRelease = f.closed(); } });
  const pending = runLive(h.options); setTimeout(() => controller.abort(Error('operator interrupted')), 20);
  const result = await pending;
  assert.equal(closedBeforeRelease, true); assert.equal(result.passed, false);
  assert.equal(result.checks[0].cleanupConfirmed, true);
});

test('a hold arriving during a card cancels and collects it before lock release', async () => {
  const f = fixture(checks[0], { silent: true }); let hold = false;
  const h = liveOptions({ open: f.open, isHeld: () => hold });
  const pending = runLive(h.options); setTimeout(() => { hold = true; }, 20);
  const result = await pending;
  assert.match(result.checks[0].error, /HOLD_APPEARED/);
  assert.equal(f.closed(), true); assert.equal(h.state().released, 1);
});

test('unproved child cleanup retains bank and live lock and stops later checks', async () => {
  const f = fixture(checks[0], { closeCode: 65 }), h = liveOptions({ open: f.open });
  const result = await runLive(h.options);
  assert.equal(result.lockRetained, true); assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.checks.length, 1); assert.equal(result.notRun.length, 6);
  assert.equal(h.state().cleaned, 0); assert.equal(h.state().released, 0);
});

test('result writer scrubs private paths and credentials and refuses overwriting a receipt', t => {
  const bank = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-person-result-')));
  const result = { startedAt: '2026-10-25T10:20:30.000Z', error: '/home/fixture/private sk-ant-secret123' };
  const path = writeResult(result, bank), saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.match(path, /2026-10-25-person-checks-1-5-2026-10-25T10-20-30-000Z\.json$/);
  assert.equal(saved.error, '~/private <redacted>');
  assert.throws(() => writeResult(result, bank), /EEXIST/);
});

test('runner and poster never toggle VoiceOver, send Apple events, or import the benchmark runner', () => {
  const js = readFileSync(runner, 'utf8'), swift = readFileSync(new URL('../bench/person-checks-1-5-poster.swift', import.meta.url), 'utf8');
  for (const text of [js, swift]) {
    assert.doesNotMatch(text, /osascript|System Events|NSAppleScript|AESend|AppleEvent|setVoiceOver|voiceOverEnabled\s*=|\.post\(tap:|bench\/run\.mjs/);
  }
  assert.equal((swift.match(/postToPid\(pid\)/g) ?? []).length, 2, 'key or mouse-down plus mouse-up, always PID scoped');
  assert.match(swift, /CGPreflightPostEventAccess/);
  assert.doesNotMatch(swift, /CGRequestPostEventAccess|AXIsProcessTrustedWithOptions/);
});
