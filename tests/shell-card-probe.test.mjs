import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync, rmdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { shellCardSource, compileShellCard, attemptVerdict, acquireAdmission, runShellCard } from '../bench/shell-card-probe.mjs';

const production = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
const block = (source, name) => source.split(`// BEGIN ${name}\n`)[1].split(`// END ${name}`)[0];
test('shell fixture keeps production panel and person guard, with receipt-only instrumentation', () => {
  const source = shellCardSource(production);
  assert.equal(block(source, 'ASK CARD'), block(production, 'ASK CARD'));
  assert.equal(block(source, 'PERSON INPUT').replace('    shellReceipt(tooSoon ? "too-soon" : "refused")\n', ''), block(production, 'PERSON INPUT'));
  assert.equal(source.split('// GB18Q FIXTURE')[0].replace('    shellReceipt(tooSoon ? "too-soon" : "refused")\n', '')
    .replace('        shellReceipt(choice == "once" ? "accepted" : "cancelled", ["id": id])\n', ''),
    production.slice(0, production.indexOf('// No arguments: the consent host.')));
  assert.match(source, /host\.receive\(frame\)/);
  assert.match(source, /host\.review\(row\)/);
  assert.match(source, /host\.channelClosed\(\)/);
  assert.match(source, /consent-reset/);
  assert.match(source, /Fake request/);
  assert.match(source, /cannot approve any app, pay, persist grants or send a real action/);
  assert.match(source, /let shellPhase = CommandLine\.arguments\[2\], shellFixture = CommandLine\.arguments\[3\]/);
  assert.match(source, /record\["pgid"\] = getpgrp\(\)/);
  assert.match(source, /shellTargets\[active\.id\].*"window".*"button"/);
  assert.doesNotMatch(source.slice(source.indexOf('// GB18Q FIXTURE')), /personModal|runModal|keyEquivalent\s*=(?!=)|\.press\(/);
  assert.throws(() => shellCardSource('drift'), /SOURCE_DRIFT/);
});

test('compile-only builds two visible sources without spawning a running fixture', () => {
  const calls = [];
  compileShellCard('/fake/bank', { write: (...args) => calls.push(['write', ...args]),
    compile: (...args) => { calls.push(['compile', ...args]); return { status: 0 }; } });
  assert.equal(calls.filter(c => c[0] === 'compile').length, 2);
  assert.ok(calls.filter(c => c[0] === 'compile').every(c => c[1] === '/usr/bin/xcrun' && c[2][0] === 'swiftc'));
});

test('absence of permission never counts as refusal, and acceptance takes priority', () => {
  assert.equal(attemptVerdict([], { outcome: 'permission-absent' }), 'permission-absent');
  assert.equal(attemptVerdict([{ outcome: 'refused' }], { outcome: 'permission-absent' }), 'permission-absent');
  assert.equal(attemptVerdict([], { outcome: 'attempted' }), 'no-receipt');
  assert.equal(attemptVerdict([{ outcome: 'refused' }], { outcome: 'attempted' }), 'refused');
  assert.equal(attemptVerdict([{ outcome: 'refused' }, { outcome: 'accepted' }], { outcome: 'attempted' }), 'accepted');
  assert.equal(attemptVerdict([{ outcome: 'refused' }], null), 'poster-failed');
});

test('admission never removes foreign locks and rejects holds, using private fake paths', async t => {
  const bank = mkdtempSync(join(tmpdir(), 'gb18q-admission-'));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const lock = join(bank, 'lock'), hold = join(bank, 'hold');
  mkdirSync(lock);
  await assert.rejects(acquireAdmission({ lock, hold }), /EEXIST/);
  assert.ok(existsSync(lock));
  rmdirSync(lock); mkdirSync(hold);
  await assert.rejects(acquireAdmission({ lock, hold }), /HOLD/);
  assert.equal(existsSync(lock), false);
  rmdirSync(hold);
  const admission = await acquireAdmission({ lock, hold });
  await admission.check();
  mkdirSync(hold);
  await assert.rejects(admission.check(), /HOLD/);
  rmdirSync(hold);
  renameSync(lock, join(bank, 'original-lock')); mkdirSync(lock);
  await assert.rejects(admission.release(), /LOCK_IDENTITY/);
  assert.ok(existsSync(lock));
});

function fakeRun({ permissionAbsent = false, acceptSynthetic = false, missing = false, interrupt = false,
  eof = false, cleanupMissing = false, wrongPid = false, lifecycleBad = false, lateAcceptance = false,
  cleanupHang = false, posterFailed = false, holdDuringAttempt = false, personMissing = false, hostExit = 0,
  crossPhaseAcceptance = false, acceptanceOnCleanup = false, staleAnswer = false,
  answerFields = {}, cleanupFields = {}, posterHang = false, protocolOnCleanup = false,
  acceptanceAfterCleanup = false, holdAfterCleanup = false, personCleanupFields = {}, personCleanupHang = false,
  inspectionFields = {} } = {}) {
  const signal = new EventEmitter(), input = new PassThrough(), receipts = [], children = [];
  let host, emit, firstIdentity, released = false, ended = false;
  const hosts = [], launches = [];
  const launch = (file, args, options) => {
    launches.push({ file, args });
    assert.equal(options.detached, true);
    const child = new EventEmitter();
    child.pid = 12345 + children.length;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    children.push(child);
    if (file === 'host') {
      if (hosts.length) {
        assert.ok(children.slice(0, -1).every(c => c.closed));
        assert.ok(receipts.some(r => r.fixtureCleanup?.phase === 'synthetic' && r.fixtureCleanup.confirmed));
      }
      host = child;
      hosts.push(child);
      const identity = { pid: child.pid, pgid: child.pid, phase: args[1], fixture: args[2] };
      firstIdentity ??= identity;
      let buffer = '', step = 'setup';
      const output = record => child.stdout.write(JSON.stringify({ ...identity, step,
        ...(['accepted', 'refused'].includes(record.outcome) ? { id: 'gb18q-0004', window: 42, button: 'Allow once' } : {}),
        ...record }) + '\n');
      emit = output;
      child.stdin.on('data', bytes => {
        buffer += bytes;
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n'), command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          step = command.step;
          if (command.op === 'show') {
            output({ outcome: 'ready', pid: wrongPid ? 9 : child.pid, id: 'gb18q-0004', window: 42, x: 20, y: 30,
              visible: true, cards: 1, protected: true, returnDefault: false });
            if (interrupt) setImmediate(() => signal.emit('SIGINT'));
            if (eof) setImmediate(() => input.end());
          } else if (command.op === 'visibility-hide' || command.op === 'visibility-show') {
            output({ outcome: 'visibility-ready', accessibility: { hidesOnDeactivate: command.op === 'visibility-hide' } });
          } else if (command.op === 'lifecycle') output({ outcome: 'lifecycle', ok: !lifecycleBad });
          else if (command.op === 'arm') {
            output({ outcome: 'armed' });
            if (step === 'person-click') void child.deliverLate?.();
            if (step === 'person-click' && (!personMissing || staleAnswer)) setImmediate(() => output({
              outcome: 'accepted', ...(staleAnswer ? firstIdentity : {}), ...answerFields }));
          }
        }
      });
      child.stdin.on('finish', () => setImmediate(() => {
        const finish = () => {
          if (cleanupHang || (identity.phase === 'person' && personCleanupHang)) return;
          ended = true;
          if (acceptanceOnCleanup) output({ outcome: 'accepted', step: 'person-click' });
          if (protocolOnCleanup) output({ id: 'gb18q-0004', choice: 'once' });
          if (!cleanupMissing) output({ outcome: 'cleanup', visible: 0, pending: 0, reason: 'stdin-eof', ...cleanupFields,
            ...(identity.phase === 'person' ? personCleanupFields : {}) });
          if (acceptanceAfterCleanup) output({ outcome: 'accepted', step: 'person-click' });
          if (holdAfterCleanup) holdDuringAttempt = 'held';
          child.stdout.end(); child.stderr.end(); child.closed = true; child.emit('close', hostExit, null);
        };
        // Let a queued event finish after the phase boundary, including when timers run late under load.
        if (child.deliverLate) void child.deliverLate().then(finish); else finish();
      }));
      setImmediate(() => output({ outcome: 'boot' }));
    } else {
      const targetEmit = emit;
      setImmediate(() => {
        assert.equal(args[1], '12345'); assert.equal(args[2], '42');
        if (args[0] === 'inspect') {
          child.stdout.write(JSON.stringify({ outcome: permissionAbsent ? 'permission-absent' : 'inspection',
            mode: 'inspect', pid: host.pid, window: 42, axStatus: 0, axWindows: 0, cgOnscreen: false,
            ...inspectionFields }) + '\n');
          child.stdout.end(); child.stderr.end(); child.closed = true; child.emit('close', permissionAbsent ? 77 : 0, null);
          return;
        }
        if (!permissionAbsent && !missing && !posterFailed) targetEmit({ outcome: acceptSynthetic ? 'accepted' : 'refused' });
        if (lateAcceptance) setTimeout(() => targetEmit({ outcome: 'accepted' }), 2);
        // The old runner dispatches this in its person phase. The repaired runner sees it during EOF collection.
        if (crossPhaseAcceptance && args[0] === 'hid') {
          const ready = new Promise(resolve => setTimeout(resolve, 550));
          let delivered = false;
          host.deliverLate = async () => {
            await ready;
            if (!delivered) { delivered = true; targetEmit({ outcome: 'accepted', step: 'person-click' }); }
          };
        }
        if (holdDuringAttempt) holdDuringAttempt = 'held';
        child.stdout.write(JSON.stringify({ outcome: posterFailed ? 'poster-failed' : permissionAbsent ? 'permission-absent' : 'attempted',
          mode: args[0], pid: host.pid, window: 42 }) + '\n');
        if (posterHang) return;
        child.stdout.end(); child.stderr.end(); child.closed = true; child.emit('close', posterFailed ? 1 : permissionAbsent ? 77 : 0, null);
      });
    }
    return child;
  };
  return { receipts, children, hosts, launches, input, signal, get ended() { return ended; }, get released() { return released; },
    options: { directory: '/fake/bank', binaries: { host: 'host', poster: 'poster' }, launch,
      signals: signal, input, say: r => receipts.push(r), prompt: () => {},
      admission: { check: async () => { if (holdDuringAttempt === 'held') throw Error('HOLD'); }, release: async () => { released = true; } },
      // Keep the production observation window for the delayed-acceptance regression.
      // A five-millisecond substitute can expire before Node delivers its timer under load.
      timing: { ready: 100, attempt: 20, settle: lateAcceptance || crossPhaseAcceptance ? 500 : 5,
        person: crossPhaseAcceptance ? 1000 : 100, cleanup: crossPhaseAcceptance ? 1000 : 100, poll: 1 } } };
}

test('synthetic-only run ends after owned cleanup without asking for a physical click', async () => {
  const fake = fakeRun();
  const result = await runShellCard({ ...fake.options, syntheticOnly: true });
  assert.equal(result.passed, false);
  assert.equal(result.synthetic?.complete, true);
  assert.deepEqual(result.steps.map(s => s.step), ['ax', 'pid', 'hid']);
  assert.ok(result.steps.every(s => s.verdict === 'refused'));
  assert.equal(fake.hosts.length, 1);
  assert.equal(fake.receipts.some(r => r.outcome === 'waiting-for-person'), false);
  assert.equal(result.cleanup.confirmed, true);
  assert.equal(fake.released, true);
});

for (const options of [{ missing: true }, { acceptSynthetic: true }, { cleanupMissing: true }]) {
  test(`synthetic-only run cannot complete without refusals and cleanup: ${JSON.stringify(options)}`, async () => {
    const fake = fakeRun(options);
    const result = await runShellCard({ ...fake.options, syntheticOnly: true });
    assert.equal(result.passed, false);
    assert.equal(result.synthetic?.complete, false);
    assert.equal(fake.hosts.length, 1);
    assert.equal(fake.receipts.some(r => r.outcome === 'waiting-for-person'), false);
  });
}

test('visibility study compares true false true without action or person phases and never qualifies consent', async () => {
  const fake = fakeRun();
  const result = await runShellCard({ ...fake.options, visibilityStudy: true });
  assert.equal(result.passed, false);
  assert.equal(result.study?.complete, true);
  assert.deepEqual(result.study.samples.map(s => s.native.hidesOnDeactivate), [true, false, true]);
  assert.deepEqual(fake.launches.filter(l => l.file === 'poster').map(l => l.args[0]), ['inspect', 'inspect', 'inspect']);
  assert.equal(fake.hosts.length, 1);
  assert.deepEqual(result.steps, []);
  assert.equal(fake.receipts.some(r => r.outcome === 'waiting-for-person'), false);
  assert.equal(result.cleanup.confirmed, true);
  assert.equal(fake.released, true);
});

for (const options of [{ permissionAbsent: true }, { inspectionFields: { pid: 999 } }, { inspectionFields: { window: 999 } }]) {
  test(`visibility study stops on missing permission or foreign inspection: ${JSON.stringify(options)}`, async () => {
    const fake = fakeRun(options);
    const result = await runShellCard({ ...fake.options, visibilityStudy: true });
    assert.equal(result.passed, false);
    assert.equal(result.study?.complete, false);
    assert.equal(fake.hosts.length, 1);
    assert.equal(fake.launches.filter(l => l.file === 'poster').length, 1);
    assert.equal(result.cleanup.confirmed, true);
    assert.equal(fake.released, true);
  });
}

test('visibility study retains the lock and reports incomplete when fixture cleanup is uncertain', async () => {
  const fake = fakeRun({ cleanupMissing: true });
  const result = await runShellCard({ ...fake.options, visibilityStudy: true });
  assert.equal(result.passed, false);
  assert.equal(result.study?.complete, false);
  assert.equal(result.cleanup.confirmed, false);
  assert.equal(fake.released, false);
});

test('final synthetic acceptance beyond settle cannot substitute for a physical answer', async () => {
  const fake = fakeRun({ crossPhaseAcceptance: true, personMissing: true });
  const result = await runShellCard(fake.options);
  assert.equal(result.passed, false);
  assert.equal(result.error, 'SHELL_CARD_SYNTHETIC_ACCEPTANCE');
  assert.equal(fake.hosts.length, 1);
  assert.equal(result.cleanup.confirmed, true);
  assert.ok(fake.receipts.some(r => r.card?.outcome === 'accepted' && r.card.step === 'person-click'));
  assert.ok(fake.receipts.findIndex(r => r.card?.outcome === 'accepted') >
    fake.receipts.findIndex(r => r.step === 'hid' && r.verdict === 'refused'));
});

test('fake run checks lifecycle, all refusal receipts, physical click and exact cleanup', async () => {
  const fake = fakeRun(); const result = await runShellCard(fake.options);
  assert.equal(result.passed, true);
  assert.deepEqual(result.steps.map(r => r.verdict), ['refused', 'refused', 'refused', 'accepted']);
  assert.equal(result.cleanup.confirmed, true); assert.equal(fake.ended, true); assert.equal(fake.released, true);
  assert.equal(fake.hosts.length, 2);
  assert.notEqual(fake.hosts[0].pid, fake.hosts[1].pid);
  assert.deepEqual(result.cleanup.fixtures.map(r => r.phase), ['synthetic', 'person']);
  assert.notEqual(result.cleanup.fixtures[0].fixture, result.cleanup.fixtures[1].fixture);
});

for (const [name, options, expected] of [
  ['permission absence', { permissionAbsent: true }, 'permission-absent'],
  ['missing receipt', { missing: true }, 'no-receipt'],
  ['synthetic acceptance', { acceptSynthetic: true }, 'accepted'],
  ['late acceptance after refusal', { lateAcceptance: true }, 'accepted'],
]) test(`fake ${name} cannot qualify the guard`, async () => {
  const fake = fakeRun(options); const result = await runShellCard(fake.options);
  assert.equal(result.passed, false); assert.equal(result.steps[0].verdict, expected);
  assert.equal(result.cleanup.confirmed, true); assert.equal(fake.released, true);
});

for (const [name, options] of [['Ctrl-C', { interrupt: true }], ['operator EOF', { eof: true }],
  ['wrong PID', { wrongPid: true }], ['failed lifecycle', { lifecycleBad: true }]]) {
  test(`fake ${name} stops and proves child cleanup`, async () => {
    const fake = fakeRun(options); const result = await runShellCard(fake.options);
    assert.equal(result.passed, false); assert.equal(result.cleanup.confirmed, true);
    assert.equal(fake.released, true); assert.equal(fake.ended, true);
    assert.equal(fake.children.length, 1);
  });
}

test('missing cleanup receipt retains admission even after exit zero', async () => {
  const fake = fakeRun({ cleanupMissing: true }); const result = await runShellCard(fake.options);
  assert.equal(result.passed, false); assert.equal(result.cleanup.confirmed, false); assert.equal(fake.released, false);
});

test('poster failure is separate from refusal and still permits proven cleanup', async () => {
  const fake = fakeRun({ posterFailed: true }); const result = await runShellCard(fake.options);
  assert.equal(result.steps[0].verdict, 'poster-failed'); assert.equal(result.passed, false);
  assert.equal(result.cleanup.confirmed, true); assert.equal(fake.released, true);
});

test('hold appearing during an attempt stops later inputs and cleans the owned fixture', async () => {
  const fake = fakeRun({ holdDuringAttempt: true }); const result = await runShellCard(fake.options);
  assert.equal(result.passed, false); assert.equal(result.error, 'HOLD');
  assert.equal(fake.children.length, 2); assert.equal(result.cleanup.confirmed, true);
});

test('bounded physical-click deadline reports no receipt without acceptance', async () => {
  const fake = fakeRun({ personMissing: true }); const result = await runShellCard(fake.options);
  assert.equal(result.steps.at(-1).verdict, 'no-receipt'); assert.equal(result.passed, false);
  assert.equal(result.cleanup.confirmed, true);
  assert.equal(fake.hosts.length, 2);
});

for (const options of [{ acceptanceOnCleanup: true }, { protocolOnCleanup: true }, { acceptanceAfterCleanup: true }]) {
  test('synthetic acceptance anywhere through pipe close prevents the positive fixture', async () => {
    const fake = fakeRun(options); const result = await runShellCard(fake.options);
    assert.equal(result.passed, false); assert.equal(result.error, 'SHELL_CARD_SYNTHETIC_ACCEPTANCE');
    assert.equal(fake.hosts.length, 1); assert.equal(result.cleanup.confirmed, true);
  });
}

test('old process receipt cannot answer the fresh process even with the same card and window IDs', async () => {
  const fake = fakeRun({ staleAnswer: true, personMissing: true }); const result = await runShellCard(fake.options);
  assert.equal(fake.hosts.length, 2); assert.equal(result.passed, false);
  assert.equal(result.error, 'SHELL_CARD_RECEIPT_IDENTITY');
  assert.equal(result.steps.some(r => r.step === 'person-click' && r.ok), false);
});

for (const answerFields of [{ pid: 9 }, { pgid: 9 }, { phase: 'synthetic' }, { fixture: 'old-fixture' },
  { id: 'gb18q-9999' }, { window: 99 }, { button: 'Other' }]) {
  test(`fresh answer must match ${Object.keys(answerFields)[0]} receipt identity`, async () => {
    const fake = fakeRun({ answerFields }); const result = await runShellCard(fake.options);
    assert.equal(fake.hosts.length, 2); assert.equal(result.passed, false);
    assert.match(result.error, /IDENTITY/);
  });
}

for (const options of [{ cleanupMissing: true }, { cleanupHang: true }, { hostExit: 9 }, { posterHang: true },
  ...[{ pid: 9 }, { pgid: 9 }, { fixture: 'old-fixture' }, { phase: 'person' },
    { visible: 1 }, { pending: 1 }, { reason: 'watchdog' }].map(cleanupFields => ({ cleanupFields }))]) {
  test(`uncertain synthetic cleanup blocks a fresh fixture: ${JSON.stringify(options)}`, async () => {
    const fake = fakeRun(options); const result = await runShellCard(fake.options);
    assert.equal(result.passed, false); assert.equal(result.cleanup.confirmed, false);
    assert.equal(fake.hosts.length, 1); assert.equal(fake.released, false);
    assert.ok(fake.receipts.some(r => r.outcome === 'lock-retained'));
  });
}

test('hold between fixtures stops the positive launch after proven synthetic cleanup', async () => {
  const fake = fakeRun({ holdAfterCleanup: true }); const result = await runShellCard(fake.options);
  assert.equal(result.passed, false); assert.equal(result.error, 'HOLD');
  assert.equal(fake.hosts.length, 1); assert.equal(result.cleanup.confirmed, true);
});

for (const options of [{ personCleanupHang: true }, ...[{ pid: 12345 }, { visible: 1 }, { pending: 1 }]
  .map(personCleanupFields => ({ personCleanupFields }))]) {
  test(`synthetic cleanup cannot substitute for fresh fixture cleanup: ${JSON.stringify(options)}`, async () => {
    const fake = fakeRun(options); const result = await runShellCard(fake.options);
    assert.equal(fake.hosts.length, 2); assert.equal(result.passed, false);
    assert.equal(result.cleanup.fixtures[0].confirmed, true);
    assert.equal(result.cleanup.fixtures[1].confirmed, false); assert.equal(fake.released, false);
  });
}

for (const options of [{ cleanupHang: true }, { hostExit: 9 }]) test('unproved child exit keeps lock and bank', async () => {
  const fake = fakeRun(options); const result = await runShellCard(fake.options);
  assert.equal(result.passed, false); assert.equal(result.cleanup.confirmed, false); assert.equal(fake.released, false);
});

for (const stop of ['SIGINT', 'EOF']) test(`real Node fake child exits with cleanup receipt on ${stop}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gb18q-node-fake-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = new PassThrough(), signals = new EventEmitter(), receipts = [];
  let owned, released = false;
  const result = await runShellCard({ directory, binaries: { host: 'host' }, input, signals,
    launch: (_file, args, options) => {
      owned = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/shell-card-fake.mjs', import.meta.url)), ...args.slice(1)], options);
      owned.stdout.once('data', () => { if (stop === 'EOF') input.end(); else signals.emit(stop); });
      return owned;
    },
    admission: { check: async () => {}, release: async () => { released = true; } },
    say: r => receipts.push(r), prompt: () => {}, timing: { poll: 1, ready: 1000, cleanup: 1000 },
  });
  assert.equal(result.passed, false); assert.equal(result.cleanup.confirmed, true);
  assert.equal(result.cleanup.hostExit, 0); assert.equal(released, true);
  assert.equal(owned.exitCode, 0); assert.equal(result.cleanup.children[0].pid, owned.pid);
  assert.ok(receipts.some(r => r.card?.outcome === 'cleanup'));
});

test('shell poster uses exact protected button, no-prompt preflights and PID-only posting', () => {
  const source = readFileSync(new URL('../bench/shell-card-poster.swift', import.meta.url), 'utf8');
  assert.match(source, /AXIsProcessTrusted\(\)/); assert.match(source, /CGPreflightPostEventAccess\(\)/);
  assert.match(source, /"Allow once"/); assert.match(source, /CGWindowListCreateDescriptionFromArray/);
  assert.match(source, /proc_pidpath/);
  assert.match(source, /appendingPathComponent\("shell-card"\)/);
  assert.match(source, /event\.postToPid\(pid\)/);
  assert.doesNotMatch(source, /Always allow|CGRequest|AXIsProcessTrustedWithOptions|event\.post\(tap:/);
});
