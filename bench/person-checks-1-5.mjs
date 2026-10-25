#!/usr/bin/env node
// Fixture-only owner checks. Importing this module does nothing; --dry-run has no side effects.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { createUiChannel, consentEnvironment, appleToolsPresent } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { createHandoffWaiter } from '../plugins/sleight/lib/direct-browser/handoff.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { scrubText } from './release-pass.mjs';

const hostSource = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
const posterSource = new URL('./person-checks-1-5-poster.swift', import.meta.url);
const resultsRoot = fileURLToPath(new URL('../docs/benchmarks/', import.meta.url));
const HOLD = '/tmp/sleight-hold';
const WAIT_MS = 300000, PERSON_MS = 120000;
export const checks = Object.freeze([
  { id: 'physical-typing', mode: 'typed', expected: 'accepted', instruction: 'Focus the confirmation field with your mouse. Type the word shown for Allow once and press Return. Do not click Allow once.' },
  { id: 'posted-key', mode: 'key', expected: 'refused', instruction: 'Click the confirmation field with your mouse, then keep your hands off the keyboard. The script posts one keystroke to this fixture card only.' },
  { id: 'voiceover-typing', mode: 'typed', voiceOver: true, expected: 'accepted', instruction: 'Turn VoiceOver on with Cmd+F5, then use VoiceOver to focus the confirmation field. Type the word shown for Allow once and press Return. Do not click Allow once. Turn VoiceOver off yourself when prompted.' },
  ...['native', 'browser'].flatMap(target => [
    { id: `${target}-continue`, mode: 'click', target, expected: 'accepted', instruction: 'This is a fixture sign-in wait card. Do not sign in anywhere. Wait for the click prompt, then click Continue with your mouse. Do not type a word.' },
    { id: `${target}-posted-click`, mode: 'posted-click', target, expected: 'refused', instruction: 'Keep your hands off the card. The script posts a click to this fixture card only. It must stay paused.' },
  ]),
]);

export function parseArgs(args) {
  const flags = new Set(args);
  if (flags.size !== args.length || args.some(arg => !['--dry-run', '--owner-present', '--compile-only'].includes(arg)) ||
      flags.has('--compile-only') && flags.size !== 1 || flags.has('--dry-run') && flags.has('--owner-present') ||
      !flags.has('--dry-run') && !flags.has('--compile-only') && !flags.has('--owner-present')) {
    throw Error('usage: node bench/person-checks-1-5.mjs --dry-run | --compile-only | --owner-present');
  }
  return { dryRun: flags.has('--dry-run'), compileOnly: flags.has('--compile-only') };
}
export function plan() {
  return { fixtureOnly: true, estimatedOwnerMinutes: 10, waitCapMs: WAIT_MS,
    output: 'docs/benchmarks/<date>-person-checks-1-5-<stamp>.json',
    prerequisites: ['macOS with Apple command-line tools', 'existing post-event permission (never requested)',
      'physical keyboard and mouse; owner controls VoiceOver; sleight-arch watches terminal output'], checks };
}

// Receipt-only additions to a private build, as in consent-guard-probe. Keep the entire production entry point,
// receive parser, AskCardPanel, provenance checks and dispatch intact. No test authority or event seam is added.
export function instrumentHost(source = readFileSync(hostSource, 'utf8')) {
  const insert = (needle, replacement) => {
    if (source.split(needle).length !== 2) throw Error('PERSON_CHECK_SOURCE_DRIFT');
    source = source.replace(needle, replacement);
  };
  insert('// BEGIN PERSON INPUT', `func pc1Receipt(_ event: String, _ data: [String: Any] = [:]) {
    let row = data.merging(["event": event, "voiceOver": NSWorkspace.shared.isVoiceOverEnabled]) { $1 }
    if let bytes = try? JSONSerialization.data(withJSONObject: row) {
        FileHandle.standardError.write(Data("PC1 ".utf8) + bytes + Data([10]))
    }
}
// BEGIN PERSON INPUT`);
  insert('func refuseConsentInput(_ button: NSButton? = nil) {', 'func refuseConsentInput(_ button: NSButton? = nil) {\n    pc1Receipt("refused", ["code": "PERSON_INPUT_REQUIRED"])');
  insert('return sender.sendAction(originalAction, to: originalTarget)', `pc1Receipt("dispatch", ["typed": typed, "keyCode": event.type == .keyDown ? Int(event.keyCode) : -1, "mouse": [.leftMouseDown, .leftMouseUp].contains(event.type)])
        return sender.sendAction(originalAction, to: originalTarget)`);
  insert('_ = focusForTyping()', 'if focusForTyping() { pc1Receipt("focused") }');
  insert('NSSound(named: "Glass")?.play()', `NSSound(named: "Glass")?.play()
        var data: [String: Any] = ["pid": Int(getpid())]
        if let button = buttons.first(where: { $0.title == "Continue" }) {
            let rect = panel.convertToScreen(button.convert(button.bounds, to: nil))
            data["x"] = rect.midX
            data["y"] = (NSScreen.screens.first?.frame.maxY ?? 0) - rect.midY
        }
        pc1Receipt("ready", data)`);
  return source;
}

export function compileOnly(directory, run = spawnSync) {
  const source = instrumentHost(), swift = join(directory, 'main.swift');
  writeFileSync(swift, source, { flag: 'wx', mode: 0o600 });
  const binaries = { host: join(directory, 'consent-host'), poster: join(directory, 'poster'),
    sourceSha256: createHash('sha256').update(readFileSync(hostSource)).digest('hex'),
    instrumentedSha256: createHash('sha256').update(source).digest('hex') };
  for (const [input, output] of [[swift, binaries.host], [fileURLToPath(posterSource), binaries.poster]]) {
    const result = run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(directory, 'cache'), input, '-o', output],
      { encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw Error(`PERSON_CHECK_COMPILE_FAILED: ${result.error?.message ?? result.stderr}`);
  }
  return binaries;
}

export function held(path = HOLD) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function waitForHold({ isHeld = held, signal, pause = sleep, now = Date.now, capMs = WAIT_MS } = {}) {
  const start = now();
  while (isHeld()) {
    signal?.throwIfAborted();
    if (now() - start >= capMs) throw Error('PERSON_CHECK_HOLD_TIMEOUT');
    await pause(Math.min(500, capMs - (now() - start)), undefined, { signal });
  }
  signal?.throwIfAborted();
}

export function openHost({ binaries, directory, spawnProcess = spawn }) {
  const child = spawnProcess(binaries.host, [], { cwd: directory, env: consentEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const receipts = [];
  let closed = false, failure;
  const collected = new Promise(resolve => child.once('close', code => { closed = true; resolve(code); }));
  child.on('error', error => { failure = error; });
  const lines = createInterface({ input: child.stderr });
  lines.on('line', line => {
    if (!line.startsWith('PC1 ')) return;
    try { receipts.push(JSON.parse(line.slice(4))); } catch { failure = Error('PERSON_CHECK_BAD_RECEIPT'); }
  });
  const ui = createUiChannel({ read: child.stdout, write: child.stdin, onLoss: () => { failure ??= Error('PERSON_CHECK_CHANNEL_LOST'); } });
  return { ui, receipts, pid: child.pid,
    check() { if (failure) throw failure; if (closed) throw Error('PERSON_CHECK_HOST_CLOSED'); },
    async close() {
      ui.close();
      let timer;
      try {
        const code = await Promise.race([collected, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('PERSON_CHECK_CLEANUP_UNPROVED')), 5000); })]);
        if (code !== 0) throw Error('PERSON_CHECK_HOST_EXIT_FAILED');
      } finally { clearTimeout(timer); lines.close(); }
    } };
}

const actionFixture = () => ({ view: { clientSession: 'Grok Bot' }, operation: {},
  presentation: { style: 'ask', question: 'Fixture: confirm a person-only check',
    detail: 'Allow once records this check only. It approves no app, payment or sign-in.',
    host: 'Grok Bot', icon: fileURLToPath(new URL('../plugins/sleight/assets/icon.png', import.meta.url)), kind: 'action' } });

export async function runCheck(check, { open, post, signal, say = console.error, now = Date.now, pause = sleep,
  personMs = PERSON_MS, observeMs = 800 } = {}) {
  signal?.throwIfAborted();
  const start = now(), host = open(), id = randomUUID();
  let answer, resumed = false, freshReads = 0, waiter, pending, cleanupConfirmed = false, posting;
  const until = async (predicate, timeout = personMs) => {
    const deadline = now() + timeout;
    while (!predicate()) {
      signal?.throwIfAborted(); host.check();
      if (now() >= deadline) throw Error('PERSON_CHECK_TIMEOUT');
      await pause(40, undefined, { signal });
    }
    signal?.throwIfAborted(); host.check();
  };
  say(`${check.id}: ${check.instruction}`);
  let row;
  try {
    signal?.throwIfAborted();
    if (check.target) {
      waiter = createHandoffWaiter({ ui: host.ui, current: () => !signal?.aborted,
        session: 'person-check-fixture', turn: check.id, timeoutMs: personMs });
      pending = waiter.wait(check.target === 'native' ? { app: 'com.sleight.fixture.personcheck' } : 'tPersonCheck',
        async () => { freshReads++; return true; }).then(value => { resumed = value; answer = value ? 'continue' : 'cancel'; });
    } else {
      host.ui.present(id, actionFixture(), ['once', 'cancel'], event => {
        if (host.ui.authenticate(event)) answer = event.choice;
      }, { deadline: Date.now() + personMs });
    }
    await until(() => host.receipts.some(r => r.event === 'ready'), 10000);
    const ready = host.receipts.find(r => r.event === 'ready');
    if (ready.pid !== host.pid) throw Error('PERSON_CHECK_PID_MISMATCH');
    if (check.mode === 'key') {
      await until(() => host.receipts.some(r => r.event === 'focused'));
    }
    if (['key', 'posted-click'].includes(check.mode)) {
      if (check.mode === 'posted-click' && ![ready.x, ready.y].every(Number.isFinite)) throw Error('PERSON_CHECK_BUTTON_UNPROVED');
      const at = host.receipts.length;
      posting = await post({ mode: check.mode === 'key' ? 'key' : 'click', pid: host.pid, x: ready.x ?? 0, y: ready.y ?? 0 });
      if (posting.status !== 0) throw Error('PERSON_CHECK_POST_FAILED');
      await until(() => answer !== undefined || host.receipts.slice(at).some(r => r.event === 'refused'), 5000);
      // A refusal alone is insufficient: the card must remain pending after the full posted sequence.
      await pause(observeMs, undefined, { signal }); host.check(); signal?.throwIfAborted();
      const refused = host.receipts.slice(at).some(r => r.event === 'refused' && r.code === 'PERSON_INPUT_REQUIRED');
      const accepted = answer !== undefined || host.receipts.some(r => r.event === 'dispatch');
      row = { outcome: accepted ? 'accepted' : refused ? 'refused' : 'no-receipt',
        passed: refused && !accepted && freshReads === 0, refusalCode: refused ? 'PERSON_INPUT_REQUIRED' : null,
        pendingAfterPost: answer === undefined, observedPendingMs: observeMs };
    } else {
      if (check.mode === 'click') {
        await pause(observeMs, undefined, { signal }); host.check();
        if (answer !== undefined || freshReads !== 0) throw Error('PERSON_CHECK_PREMATURE_RESUME');
        say(`${check.id}: Still paused. Click Continue now.`);
      }
      await until(() => answer !== undefined);
      // stderr and stdout are separate pipes; wait for the dispatch receipt as well as the authenticated reply.
      if (['once', 'continue'].includes(answer)) await until(() => host.receipts.some(r => r.event === 'dispatch'), 2000);
      const dispatch = host.receipts.find(r => r.event === 'dispatch');
      const typed = dispatch?.typed === true && [36, 76].includes(dispatch.keyCode) && dispatch.mouse === false;
      const click = dispatch?.mouse === true && dispatch.typed === false;
      row = { outcome: ['once', 'continue'].includes(answer) ? 'accepted' : 'refused',
        passed: check.mode === 'typed' ? answer === 'once' && typed && dispatch.voiceOver === Boolean(check.voiceOver)
          : answer === 'continue' && click && resumed && freshReads === 1,
        inputRoute: typed ? 'typed-return' : click ? 'mouse' : 'unproved', voiceOver: dispatch?.voiceOver ?? null };
    }
  } catch (error) { row = { outcome: 'error', passed: false, error: (signal?.aborted ? signal.reason : error)?.message ?? error.message }; }
  finally {
    waiter?.dispose();
    if (pending) await pending;
    try { await host.close(); cleanupConfirmed = true; }
    catch (error) { row = { ...row, passed: false, cleanupError: error.message }; }
  }
  const result = { id: check.id, target: check.target ?? 'protected-action', expected: check.expected,
    startedAt: new Date(start).toISOString(), endedAt: new Date(now()).toISOString(), durationMs: now() - start,
    ...row, resumed, freshReads, cleanupConfirmed, ...(posting ? { postExitCode: posting.status } : {}) };
  say(JSON.stringify(result)); return result;
}

export async function runLive({ compile, open, post, voiceOver, save, cleanup, signal, say = console.error,
  isHeld = held, lock = acquireLiveLock, now = Date.now, pause = sleep, capMs = WAIT_MS, checkOptions = {} } = {}) {
  const start = now(), rows = [];
  let release, binaries, error, cleanupConfirmed = true;
  const budget = AbortSignal.timeout(capMs), preflight = AbortSignal.any([budget, ...signal ? [signal] : []]);
  try {
    await waitForHold({ isHeld, signal: preflight, now, pause, capMs });
    release = await lock(undefined, { wait: true, signal: preflight, interval: 500 });
    await waitForHold({ isHeld, signal: preflight, now, pause, capMs });
    binaries = await compile();
    const checkSignal = AbortSignal.any([...signal ? [signal] : [], AbortSignal.timeout(20 * 60000)]);
    for (const check of checks) {
      await waitForHold({ isHeld, signal: checkSignal, now, pause, capMs });
      if (check.id === 'physical-typing' || check.id === 'native-continue') {
        say('Turn VoiceOver off yourself if it is on. Waiting for VoiceOver to be off.');
        const deadline = now() + PERSON_MS;
        while (await voiceOver()) {
          checkSignal.throwIfAborted(); if (now() >= deadline) throw Error('PERSON_CHECK_VOICEOVER_OFF_TIMEOUT');
          await pause(500, undefined, { signal: checkSignal });
        }
      }
      const controller = new AbortController();
      const monitor = setInterval(() => {
        try { if (isHeld()) controller.abort(Error('PERSON_CHECK_HOLD_APPEARED')); }
        catch (failure) { controller.abort(failure); }
      }, 100);
      let row;
      try {
        if (isHeld()) controller.abort(Error('PERSON_CHECK_HOLD_APPEARED'));
        row = await runCheck(check, { ...checkOptions, open: () => open(binaries), post, say, now, pause,
          signal: AbortSignal.any([checkSignal, controller.signal]) });
      } finally { clearInterval(monitor); }
      rows.push(row);
      if (!row.cleanupConfirmed) { cleanupConfirmed = false; break; }
      if (!row.passed) break;
    }
  } catch (failure) { error = signal?.aborted ? signal.reason?.message ?? failure.message
    : budget.aborted && !binaries ? 'PERSON_CHECK_LOCK_HOLD_WAIT_TIMEOUT' : failure.message; }
  finally {
    if (rows.some(row => row.id === 'voiceover-typing')) say('If you enabled VoiceOver for this pass, turn it off yourself with Cmd+F5 when finished.');
    if (cleanupConfirmed) {
      try { await cleanup(); } catch (failure) { cleanupConfirmed = false; error ??= failure.message; }
      if (release && cleanupConfirmed) {
        try { await release(); } catch (failure) { cleanupConfirmed = false; error ??= failure.message; }
      }
    }
  }
  const result = { schemaVersion: 1, suite: 'person-checks-1-5', fixtureOnly: true, ownerPresent: true,
    startedAt: new Date(start).toISOString(), endedAt: new Date(now()).toISOString(), durationMs: now() - start,
    sourceSha256: binaries?.sourceSha256 ?? null, instrumentedSha256: binaries?.instrumentedSha256 ?? null,
    passed: rows.length === checks.length && rows.every(row => row.passed) && cleanupConfirmed && !error,
    cleanupConfirmed, lockRetained: Boolean(release) && !cleanupConfirmed,
    checks: rows, notRun: checks.slice(rows.length).map(check => check.id), ...(error ? { error } : {}) };
  await save(result); return result;
}

export function writeResult(result, root = resultsRoot) {
  mkdirSync(root, { recursive: true });
  const stamp = result.startedAt.replace(/[:.]/g, '-');
  const path = join(root, `${result.startedAt.slice(0, 10)}-person-checks-1-5-${stamp}.json`);
  writeFileSync(path, scrubText(JSON.stringify(result, null, 2)) + '\n', { flag: 'wx', mode: 0o600 });
  return path;
}
export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.dryRun) { console.log(JSON.stringify(plan(), null, 2)); return 0; }
  if (process.platform !== 'darwin' || !await appleToolsPresent()) throw Error('PERSON_CHECK_APPLE_TOOLS_REQUIRED');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-person-checks-')));
  const controller = new AbortController();
  const abort = () => controller.abort(Error('PERSON_CHECK_INTERRUPTED'));
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  let binaries, retain = false;
  const compile = () => {
    binaries = compileOnly(directory);
    // Review pc1: check post-event access before the first card, not after the person finished check 1.
    const access = invoke(['access']);
    if (access.status !== 0 || access.stdout.trim() !== 'true') throw Error('POST_EVENT_ACCESS_REQUIRED: the posted-input checks need post-event access for the process running this script. No permission was requested and no card was shown.');
    return binaries;
  };
  const invoke = args => spawnSync(binaries.poster, args, { encoding: 'utf8', timeout: 10000 });
  try {
    if (options.compileOnly) { binaries = compileOnly(directory); console.log('production host with receipts and poster compiled; neither launched'); return 0; }
    console.error('Fixture cards only. Allow about 10 minutes. No real sign-in, app approval or payment. Ctrl-C stops the pass.');
    const result = await runLive({ compile, signal: controller.signal,
      open: () => openHost({ binaries, directory }),
      post: ({ mode, pid, x, y }) => invoke([mode, String(pid), String(x), String(y)]),
      voiceOver: () => { const r = invoke(['voiceover']); if (r.status !== 0 || !/^(true|false)\n$/.test(r.stdout)) throw Error('PERSON_CHECK_VOICEOVER_UNPROVED'); return r.stdout.trim() === 'true'; },
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
      save: result => { retain = !result.cleanupConfirmed; console.log(JSON.stringify({ result: writeResult(result), passed: result.passed })); } });
    return result.passed ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    if (!retain) rmSync(directory, { recursive: true, force: true });
    else console.error(`Cleanup unproved; fixture bank retained: ${directory}`);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(scrubText(error.message)); process.exitCode = 1; }
}
