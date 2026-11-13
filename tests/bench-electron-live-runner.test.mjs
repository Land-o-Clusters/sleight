const MAC_TMP = '/' + 'private/tmp';
// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  ARM_ALLOWED, CARD_WINDOW_MS, EXPECTED_CARDS, LIVE_RELAUNCH_ORDER, armPrompt, cardInstruction, consentHostPids, createCardWatcher, gradeArm, liveRelaunchCells, locateCard,
  main, parseCardLog, parseRunnerArgs, parseStream, parseTree, preflight, runPhases,
} from '../bench/electron-live-runner.mjs';
import { fakeIo, fakeRunnerDeps } from '../bench/electron-live-runner-fakes.mjs';
import { CARD_TTL_MS, cardLine } from '../bench/electron-cards.mjs';
import { APPS, RELAUNCH_CELLS, runQualification } from '../bench/electron-qualification.mjs';
import { fakeObserver } from '../bench/electron-qualification-fakes.mjs';
import { SEED_SETTINGS, codeOf, helperReason, liveRelaunchDriver, portableName, quitOutcome, restartOutcome } from '../bench/electron-relaunch-live.mjs';
import { createArmSession, readArmConfig } from '../bench/electron-arm-server.mjs';
import { createRunReaper } from '../bench/electron-run-cleanup.mjs';

const temp = t => { const dir = realpathSync(mkdtempSync(join('/tmp', 'elr-'))); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const tickSleep = () => new Promise(resolve => setImmediate(resolve));

test('the runner reaper actually removes same-uid host and orphan adapter rows', async () => {
  const root = `${MAC_TMP}/eq1k-run`, uid = process.getuid(), python = '/custom/python3';
  let rows = [
    { pid: 450, ppid: 1, uid, startedAtMs: 2, args: `${process.execPath} electron-host-run.mjs --state-dir ${root}/state` },
    { pid: 451, ppid: 1, uid, startedAtMs: 3, args: `${python} launch.py --temp-root ${root}/profiles` },
    { pid: 452, ppid: 1, uid: uid + 1, startedAtMs: 4, args: `${python} launch.py --temp-root ${root}/profiles` },
  ];
  const signals = [];
  const reaper = createRunReaper(root, { python, list: async () => rows, sleep: tickSleep,
    signal(pid, kind) { signals.push([pid, kind]); rows = rows.filter(row => row.pid !== pid); } });
  assert.deepEqual((await reaper.scan()).map(row => row.pid), [450, 451]);
  assert.equal((await reaper.reap()).confirmed, true);
  assert.deepEqual(signals, [[450, 'SIGTERM'], [451, 'SIGTERM']]);
  assert.deepEqual(rows.map(row => row.pid), [452]);
});

test('run process cleanup finishes before lock release and a leftover keeps the lock', async () => {
  for (const confirmed of [true, false]) {
    const events = [];
    const deps = phaseDeps({ phases: { qualify: async () => ({ status: 'pass', cleanup: { confirmed: true } }) } });
    deps.lock = async () => { events.push('lock'); return async () => events.push('release'); };
    deps.cleanup = async () => { events.push('reap'); return { confirmed, left: confirmed ? [] : [801] }; };
    const r = await runPhases({ options: { phases: ['qualify'], mode: 'live' }, deps });
    assert.deepEqual(events, confirmed ? ['lock', 'reap', 'release'] : ['lock', 'reap']);
    assert.equal(r.keep, !confirmed);
    assert.equal(r.code, confirmed ? 0 : 1);
    assert.equal(r.summary.cleanup.confirmed, confirmed);
  }
});

test('live runs need --owner-away, the card wait cannot pass the card\'s own 120 s, and phases keep their order', () => {
  assert.throws(() => parseRunnerArgs([]), /OWNER_AWAY_REQUIRED/);
  assert.throws(() => parseRunnerArgs(['--dry-run', '--owner-away']), /CONFLICTING_MODE/);
  assert.throws(() => parseRunnerArgs(['--owner-away', '--phases', 'qualify,cursor']), /UNKNOWN_PHASE/);
  assert.throws(() => parseRunnerArgs(['--owner-away', '--consent-wait-ms', '180000']), /CONSENT_WAIT_TOO_LONG/);
  assert.throws(() => parseRunnerArgs(['--owner-away', '--model', 'gpt-6.1-sol']), /INVALID_OPTIONS/);
  const live = parseRunnerArgs(['--owner-away', '--phases', 'relaunch,qualify']);
  assert.deepEqual(live.phases, ['qualify', 'relaunch']);
  assert.equal(live.mode, 'live');
  assert.equal(live.model, 'claude-haiku-5-5');
  assert.equal(live.effort, 'high');
  assert.equal(CARD_TTL_MS, CARD_WINDOW_MS);
});

test('preflight stops on a missing piece, and skips the relaunch phase while the owner\'s VS Code runs, reading only', async () => {
  const asked = [];
  const io = fakeIo({ ownerCopies: async bundle => { asked.push(bundle); return [812]; } });
  const r = await preflight({ phases: ['qualify', 'arm', 'relaunch'], io });
  assert.equal(r.ok, true);
  assert.match(r.skips.relaunch, /OWNER_APP_RUNNING: 1 .*never quits it/);
  assert.deepEqual(asked, ['com.microsoft.VSCode']);
  assert.match((await preflight({ phases: ['relaunch'], io: fakeIo({ quarantined: async () => true }) })).skips.relaunch, /SOURCE_QUARANTINED/);
  const bad = await preflight({ phases: ['arm'], io: fakeIo({ platform: 'linux', turboInstalled: async () => false, exists: () => false }) });
  assert.equal(bad.ok, false);
  for (const code of ['MACOS_REQUIRED', 'APP_MISSING', 'TURBO_NOT_INSTALLED', 'PERMISSION_OBSERVER_MISSING', 'ARM_MISSING']) assert.ok(bad.problems.some(p => p.startsWith(code)), code);
});

test('each card names the choice and whether the owner\'s delegation covers it', () => {
  assert.deepEqual([cardInstruction({ kind: 'debugger', temporary: false }), cardInstruction({ kind: 'debugger', temporary: true }), cardInstruction({ kind: 'relaunch', temporary: false })]
    .map(c => [c.click, c.delegated]), [['Always allow', true], ['Allow this session', true], ['Quit and reopen', true]]);
  assert.match(cardInstruction({ kind: 'debugger', temporary: true }).note, /benchmark VS Code/);
  assert.match(cardInstruction({ kind: 'relaunch' }).note, /benchmark VS Code/);
});

test('qualify and relaunch omit the Claude arm and its executable preflight', async () => {
  const options = parseRunnerArgs(['--owner-away', '--phases', 'qualify,relaunch']);
  const io = fakeIo({ armClaude: '/absent/claude', exists: path => path !== '/absent/claude' && path !== '/tmp/sleight-hold' });
  assert.equal((await preflight({ phases: options.phases, io })).ok, true);
  const calls = [], deps = phaseDeps({ io, phases: {
    qualify: async () => { calls.push('qualify'); return { status: 'pass', cleanup: { confirmed: true } }; },
    relaunch: async () => { calls.push('relaunch'); return { status: 'pass', cleanup: { confirmed: true } }; },
    arm: async () => assert.fail('model-free phases must not enter the arm'),
  } });
  assert.equal((await runPhases({ options, deps })).code, 0);
  assert.deepEqual(calls, ['qualify', 'relaunch']);
});

test('the card is located from the consent host\'s own windows: glove, menu, card window and its button', () => {
  const geometry = { ax: true, windows: [
    { pid: 9, layer: 25, onScreen: true, x: 1200, y: 0, width: 30, height: 24 },
    { pid: 9, layer: 25, onScreen: false, x: 1100, y: 0, width: 30, height: 24 },
    { pid: 9, layer: 101, onScreen: true, x: 1180, y: 24, width: 220, height: 40 },
    { pid: 9, layer: 8, onScreen: true, x: 500, y: 300, width: 420, height: 260 },
  ], buttons: [{ pid: 9, title: 'Always allow', x: 700, y: 500, width: 100, height: 30 }, { pid: 9, title: 'Review sleight request', x: 1190, y: 30, width: 200, height: 20 }] };
  const loc = locateCard(geometry, 'Always allow');
  assert.deepEqual(loc.glove, { x: 1215, y: 12 });
  assert.deepEqual(loc.review, { x: 1290, y: 40 });
  assert.deepEqual(loc.alert, { x: 500, y: 300, width: 420, height: 260 });
  assert.deepEqual(loc.button, { x: 750, y: 515 });
  assert.equal(locateCard(geometry, 'Allow this session').button, null, 'a button the card does not show is never guessed');
  assert.deepEqual(locateCard(null, 'Always allow'), { glove: null, menu: null, review: null, alert: null, button: null, ax: false });
});

test('only consent hosts under this run count, never the owner\'s own sleight session\'s host', () => {
  const rows = parseTree([
    '  100     1 node bench/electron-live-runner.mjs --owner-away',
    '  110   100 node bench/electron-qualification-worker.mjs',
    `  111   110 ${MAC_USERS}x/Library/Caches/sleight/turbo-host/abc/consent-host`,
    '  200     1 claude',
    `  211   200 ${MAC_USERS}x/Library/Caches/sleight/turbo-host/abc/consent-host --shared`,
    '  120   100 claude -p',
    '  121   120 node bench/electron-arm-server.mjs',
    '  122   121 node bench/electron-qualification-worker.mjs',
    `  123   122 ${MAC_USERS}x/Library/Caches/sleight/turbo-host/abc/consent-host`,
  ].join('\n'));
  assert.deepEqual(consentHostPids(rows, 100), [111, 123]);
});

test('the card watcher announces a card with its deadline, follows the card window, and records the click\'s latency', async t => {
  const dir = temp(t), cardLog = join(dir, 'cards.jsonl'), logs = [], files = new Map();
  let t0 = 1_000_000, geometry = null;
  const w = createCardWatcher({ cardLog, outDir: dir, log: line => logs.push(line), now: () => t0, locate: async () => geometry,
    write: (path, text) => files.set(path, JSON.parse(text)), remove: path => files.delete(path) });
  cardLine(cardLog, { event: 'shown', id: 'a', kind: 'debugger', at: t0, deadlineAt: t0 + CARD_TTL_MS, temporary: false, app: 'Visual Studio Code' });
  cardLine('relative.jsonl', { event: 'shown', id: 'x' }); // ignored: not an absolute card log
  await w.poll();
  assert.equal(w.pending(), 1);
  assert.match(logs[0], /^CARD 1 \(debugger, Visual Studio Code\) requested .*answer by .*card opens automatically.*fallback.*sleight glove in the menu bar \(not located yet\).*"Always allow"/);
  const card = files.get(join(dir, 'CARD.json'));
  assert.equal(card.secondsLeft, 120);
  assert.equal(card.delegated, true);
  t0 += 30000;
  geometry = { ax: true, windows: [{ layer: 25, onScreen: true, x: 1200, y: 0, width: 30, height: 24 },
    { layer: 8, onScreen: true, x: 500, y: 300, width: 420, height: 260 }], buttons: [{ title: 'Always allow', x: 700, y: 500, width: 100, height: 30 }] };
  await w.poll();
  assert.match(logs.at(-1), /^MATCHING CARD \(uncorrelated request\): Click "Always allow" in the automatic card at \(750, 515\)/);
  assert.equal(files.get(join(dir, 'CARD.json')).secondsLeft, 90);
  cardLine(cardLog, { event: 'answered', id: 'a', kind: 'debugger', at: t0 + 1500, status: 'granted', scope: 'always' });
  await w.poll();
  assert.equal(files.has(join(dir, 'CARD.json')), false, 'the card file goes once nothing waits');
  assert.match(logs.at(-1), /CARD 1 answered: granted \(always\) after 31\.5 s/);
  assert.deepEqual(w.summary().map(c => [c.status, c.latencyMs, c.inTime]), [['granted', 31500, true]]);
  cardLine(cardLog, { event: 'shown', id: 'b', kind: 'debugger', at: t0, deadlineAt: t0 + CARD_TTL_MS, temporary: true, app: 'Visual Studio Code' });
  cardLine(cardLog, { event: 'answered', id: 'b', kind: 'debugger', at: t0 + CARD_TTL_MS + 1000, status: 'timeout', scope: null });
  cardLine(cardLog, { event: 'shown', id: 'c', kind: 'relaunch', at: t0, deadlineAt: t0 + CARD_TTL_MS, temporary: false, app: 'Visual Studio Code' });
  cardLine(cardLog, { event: 'answered', id: 'c', kind: 'relaunch', at: t0 + CARD_TTL_MS + 1, status: 'granted', scope: null });
  await w.poll();
  assert.deepEqual(w.summary().slice(-2).map(c => c.inTime), [false, false], 'a timeout and a click after the deadline are both late');
  assert.equal(parseCardLog('not json\n{"event":"shown"}\n').length, 0);
});

test('the arm prompt, the stream parser and the grade agree with the fixture', () => {
  const prompt = armPrompt({ marker: 'armq1' });
  for (const part of ['b-big.txt', 'a-scratch.txt', 'armq1', 'a-notes.md', 'RESULT1', 'RESULT3']) assert.ok(prompt.includes(part), part);
  assert.deepEqual(ARM_ALLOWED.length, 5);
  const stream = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__sleight-electron__browser_read' }, { type: 'text', text: 'x' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__sleight-electron__browser_read' }] } }), 'garbage',
    JSON.stringify({ type: 'result', is_error: false, duration_ms: 61000, num_turns: 9, result: 'Done.\nRESULT1: line 1500\nRESULT2: done\nRESULT3: # Notes' })].join('\n');
  const parsed = parseStream(stream);
  assert.equal(parsed.isError, false);
  assert.equal(parsed.toolCalls['mcp__sleight-electron__browser_read'], 2);
  assert.deepEqual(gradeArm({ text: parsed.text, scratch: 'armq1\n', marker: 'armq1' }).passed, 3);
  const miss = gradeArm({ text: 'RESULT1: line 44\nRESULT3: One', scratch: '', marker: 'armq1' });
  assert.deepEqual(miss.tasks.map(t => t.pass), [false, false, false]);
  assert.equal(parseStream('').isError, true, 'no result line is an error');
});

function phaseDeps({ phases, lock = [], log = [], io = fakeIo(), check } = {}) {
  let now = 0;
  const watcher = { poll: async () => {}, summary: () => [] };
  return { log: line => log.push(line), now: () => (now += 1000), sleep: tickSleep, io, watcher, preflight: check ?? preflight,
    lock: async () => { lock.push('taken'); return async () => { lock.push('released'); }; }, ...phases };
}
const ok = { status: 'pass', cleanup: { confirmed: true } };

test('a failed phase logs its first cause, releases a confirmed cleanup and launches no later phase', async () => {
  const ran = [], log = [], lock = [];
  const r = await runPhases({ options: { phases: ['qualify', 'arm', 'relaunch'], mode: 'live' }, deps: phaseDeps({ log, lock, phases: {
    qualify: async () => { ran.push('qualify'); return { status: 'fail', failed: ['consent-card: STATE_DIR_TOO_LONG'], cleanup: { confirmed: true } }; },
    arm: async () => { ran.push('arm'); return ok; }, relaunch: async () => { ran.push('relaunch'); return ok; },
  } }) });
  assert.deepEqual(ran, ['qualify']);
  assert.ok(log.some(line => line.includes('consent-card: STATE_DIR_TOO_LONG')));
  assert.deepEqual(lock, ['taken', 'released']);
  assert.equal(r.code, 1);
});

test('preflight reports receipt rejection rather than calling it an absent installation', async () => {
  const r = await preflight({ phases: ['qualify'], io: fakeIo({ turboInstalled: async () => { throw Error('INSTALLED_CONFIG_UNSAFE: Node v26, receipt v24'); } }) });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(problem => /INSTALLED_CONFIG_UNSAFE.*Node v26/.test(problem)));
});

test('phases run in order under one lock; a skipped phase is recorded; a hold waits before each phase', async () => {
  const ran = [], lock = [], held = { n: 0 };
  const io = fakeIo({ ownerCopies: async () => [5], exists: path => path === '/tmp/sleight-hold' ? held.n++ < 2 : true });
  const r = await runPhases({ options: { phases: ['qualify', 'arm', 'relaunch'], mode: 'live', model: 'm', effort: 'high' },
    deps: phaseDeps({ io, lock, phases: { qualify: async () => { ran.push('qualify'); return ok; }, arm: async () => { ran.push('arm'); return ok; },
      relaunch: async () => { ran.push('relaunch'); return ok; } } }) });
  assert.deepEqual(ran, ['qualify', 'arm']);
  assert.deepEqual(lock, ['taken', 'released']);
  assert.deepEqual(r.summary.phases.map(p => p.status), ['pass', 'pass', 'skipped']);
  assert.equal(r.summary.heldMs, 60000, 'two 30 s hold checks');
  assert.equal(r.code, 0);
});

test('an unconfirmed cleanup stops the run and keeps the lock; a preflight problem takes no lock at all', async () => {
  const lock = [], ran = [];
  const r = await runPhases({ options: { phases: ['qualify', 'arm'], mode: 'live' }, deps: phaseDeps({ lock, phases: {
    qualify: async () => { ran.push('qualify'); return { status: 'pass', cleanup: { confirmed: false, left: [4242] } }; }, arm: async () => { ran.push('arm'); return ok; } } }) });
  assert.deepEqual(ran, ['qualify']);
  assert.deepEqual(lock, ['taken'], 'kept');
  assert.equal(r.keep, true);
  assert.equal(r.code, 1);
  const thrown = await runPhases({ options: { phases: ['qualify'], mode: 'live' }, deps: phaseDeps({ phases: { qualify: async () => { throw Error('ELECTRON_RUNTIME_MISSING: x'); } } }) });
  assert.match(thrown.summary.phases[0].error, /ELECTRON_RUNTIME_MISSING/);
  assert.equal(thrown.keep, true, 'a phase that threw proved no cleanup');
  const none = [];
  const blocked = await runPhases({ options: { phases: ['qualify'], mode: 'live' }, deps: phaseDeps({ lock: none, io: fakeIo({ platform: 'linux' }), phases: { qualify: async () => ok } }) });
  assert.equal(blocked.code, 2);
  assert.deepEqual(none, []);
});

test('the dry run passes every phase on fakes, models seven cards, and qualifies nothing', async t => {
  const dir = temp(t), logs = [];
  const code = await main(['--dry-run', '--out', dir], { log: line => logs.push(line) });
  assert.equal(code, 0, logs.join('\n'));
  const summary = JSON.parse(readFileSync(join(dir, logs.find(l => l.startsWith('summary: ')).slice(9).split('/').at(-1)), 'utf8'));
  assert.deepEqual(summary.phases.map(p => [p.id, p.status]), [['qualify', 'pass'], ['arm', 'pass'], ['relaunch', 'pass']]);
  assert.deepEqual(summary.cards.map(c => c.click), [...Array(5).fill('Allow this session'), 'Always allow', 'Quit and reopen']);
  assert.deepEqual(Object.values(EXPECTED_CARDS).flat().map(card => card.split(' (')[0]), summary.cards.map(c => c.click), 'the announced plan matches the model');
  assert.match(logs.find(l => l.startsWith('cards to click')), /qualify: Allow this session \(first launch\).*relaunch: Quit and reopen/);
  assert.deepEqual(summary.clicks, { total: 7, requested: 7, matchingCardObservations: 0, accepted: 7, delegated: 7, late: 0, unanswered: 0 });
  for (const p of summary.phases.filter(p => p.receipt)) assert.equal(JSON.parse(readFileSync(p.receipt, 'utf8')).qualified, false);
});

test('the live relaunch order runs host-loss before the stand-in for the owner\'s Quit, with every relaunch cell once', () => {
  assert.deepEqual([...LIVE_RELAUNCH_ORDER].sort(), RELAUNCH_CELLS.map(c => c.id).sort());
  assert.ok(LIVE_RELAUNCH_ORDER.indexOf('relaunch-host-loss') < LIVE_RELAUNCH_ORDER.indexOf('relaunch-user-quit'));
  assert.deepEqual(liveRelaunchCells(APPS.vscode).map(c => c.id), LIVE_RELAUNCH_ORDER);
});

test('the portable folder name follows the build, and a build with a target is refused', () => {
  assert.equal(portableName({ applicationName: 'code' }), 'code-portable-data');
  assert.equal(portableName({ applicationName: 'cursor', portable: 'cursor-data' }), 'cursor-data');
  assert.throws(() => portableName({ applicationName: 'code', target: 'user' }), /PORTABLE_UNSUPPORTED/);
  assert.throws(() => portableName({ applicationName: '../x' }), /PRODUCT_UNREADABLE/);
  assert.equal(quitOutcome('ELECTRON_RELAUNCH_QUIT_PENDING: Visual Studio Code is still open'), 'running');
  assert.equal(quitOutcome('ELECTRON_DEBUGGER_REQUIRED'), 'unknown');
  assert.equal(helperReason('Error: Launched editor identity changed; quit refused (pid 5727, bundle ) (-2700)'), 'identity-changed', 'the pre-fix message');
  assert.equal(helperReason('Error: Launched editor identity changed before readiness (path)'), 'ready-identity-path');
  assert.equal(helperReason('Error: Launched editor not registered; quit refused (pid 9, no bundle id after 5 seconds)'), 'not-registered');
  assert.equal(helperReason('something else entirely'), 'other');
  assert.equal(codeOf('ELECTRON_OWNERSHIP_UNRESOLVED: held'), 'ELECTRON_OWNERSHIP_UNRESOLVED');
  assert.equal(codeOf('ref x1 is not on the page now'), null);
  const before = { pid: 4, pidBirth: 'b' };
  assert.equal(restartOutcome({ ok: true, identity: { pid: 4, pidBirth: 'b' } }, before, true), 'reattached');
  assert.equal(restartOutcome({ ok: false, error: 'ELECTRON_OWNERSHIP_UNRESOLVED' }, before, true), 'released');
  assert.equal(restartOutcome({ ok: false, error: 'ELECTRON_OWNERSHIP_UNRESOLVED' }, before, false), 'failed');
});

// A fake Mac for the relaunch driver: the installed bundle, the owner's processes, the copy, the host and one worker.
function relaunchWorld(t, { ownerRunning = false, quarantined = false } = {}) {
  const dir = temp(t), src = join(dir, 'Applications', 'Visual Studio Code.app');
  mkdirSync(join(src, 'Contents', 'MacOS'), { recursive: true }); mkdirSync(join(src, 'Contents', 'Resources', 'app'), { recursive: true });
  writeFileSync(join(src, 'Contents', 'MacOS', 'Code'), 'electron main');
  writeFileSync(join(src, 'Contents', 'Resources', 'app', 'product.json'), JSON.stringify({ applicationName: 'code' }));
  const app = { ...APPS.vscode, path: src }, root = join(dir, 'run');
  mkdirSync(root);
  const w = { cp: [], electron: [], kills: [], quits: [], starts: [], typed: '', procs: [{ pid: 77, ppid: 1, uid: process.getuid(), startedAtMs: 1, args: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' }] };
  const exec = async (file, args) => {
    if (file === '/usr/bin/plutil') return { stdout: args[1] === 'CFBundleIdentifier' ? 'com.microsoft.VSCode\n' : 'Code\n', stderr: '' };
    if (file === '/usr/bin/xattr') { if (quarantined) return { stdout: '', stderr: '' }; throw Object.assign(Error('no attr'), { code: 1 }); }
    if (file === '/bin/cp') { w.cp.push(args); cpSync(args[1], join(args[2], basename(args[1])), { recursive: true }); return { stdout: '', stderr: '' }; }
    if (file === '/usr/bin/codesign') return { stdout: '', stderr: 'Authority=Developer ID Application: Fake\nTeamIdentifier=T\nCDHash=' + 'c'.repeat(40) + '\n' };
    if (file === '/usr/sbin/lsof') throw Object.assign(Error('none'), { code: 1 });
    throw Error('unexpected ' + file);
  };
  let stateDir;
  // w.afterRehostTabs: the tab list once the host restarted (a different window, or parked).
  const tabs = () => (w.rehosted && w.afterRehostTabs) || 't' + '0'.repeat(31) + '1 Visual Studio Code window 7 joined join 1';
  // VS Code 1.141.0 as the 2026-10-22 live reads showed it: a row click opens a preview tab and leaves focus in the tree;
  // the tab click focuses the zero-area editor, whose only actionable ref is the keyboard-only one a find read lists.
  // A plain read stops at the 8000-character cut, before any editor line.
  const editor = 'a-scratch.txt, preview';
  const rows = () => [`- treeitem "a-scratch.txt"${w.scratchOpen ? ' [selected]' : ''} [level=1] [ref=e2]:`,
    ...(w.scratchOpen ? [`- tab "${editor}" [selected] [ref=e5]:`] : [])];
  const editorRows = () => [...(w.scratchOpen ? [`- textbox "${editor}"${w.editorActive ? ' [active]' : ''}`] : []),
    ...(w.typed && !w.hideTyped ? [`- generic [ref=e9] [partly offscreen]: ${JSON.stringify(w.typed)}`] : []),
    ...(w.editorActive && !w.keyboardRefWithheld ? [`- textbox "${editor}" [active] [keyboard-only] [ref=x1]: "[redacted]"`] : [])];
  const read = find => {
    const head = '# Visual Studio Code 1.141.0 (pid 400) window 7 epoch 1, join 1 joined';
    if (find === undefined) return [head, ...rows(), '# Cut: more rows omitted. Continue with ref="c1".'].join('\n');
    const terms = String(find).toLowerCase().split('|'), hits = [...rows(), ...editorRows()].filter(line => terms.some(term => line.toLowerCase().includes(term)));
    return [head, ...(hits.length ? hits : ['# No matching content.'])].join('\n');
  };
  const act = steps => {
    for (const s of steps) {
      if (s.do === 'click' && s.ref === 'e2') w.scratchOpen = true;
      else if (s.do === 'click' && s.ref === 'e5' && w.scratchOpen) w.editorActive = true;
      else if (s.do === 'type' && s.ref === 'x1' && w.editorActive && !w.keyboardRefWithheld) { if (!w.typingLost) w.typed += s.text; }
      // w.saveWrites: Meta+S writes the buffer to the fixture file, as VS Code's save does.
      else if (s.do === 'press' && s.key === 'Meta+S' && w.saveWrites) writeFileSync(join(w.base, 'workspace', 'a-scratch.txt'), w.typed);
      else if (s.do !== 'press') return { text: `ref ${s.ref} is not on the page now`, isError: true };
    }
    return { text: '1 ok', isError: false };
  };
  const worker = { async send(op, extra = {}) {
    if (op === 'start') {
      w.starts.push({ profile: extra.profile, home: extra.home, rehost: !!extra.rehost, cardLog: extra.cardLog,
        python: extra.python, qualificationDiagnosticPath: extra.qualificationDiagnosticPath });
      stateDir = extra.stateDir; w.base = join(extra.registryPath, '..');
      // w.dropOnRehost: the editor loses its unsaved buffer when the host restarts.
      if (extra.rehost) { w.rehosted = true; if (w.dropOnRehost) w.typed = ''; }
      if (!w.procs.some(p => p.pid === 450)) w.procs.push({ pid: 450, ppid: 1, uid: process.getuid(), startedAtMs: 2, args: `${process.execPath} electron-host-run.mjs --state-dir ${stateDir} --temp-root x` });
      if (!w.procs.some(p => p.pid === 400)) { w.procs = w.procs.filter(p => p.pid !== 300); w.procs.push({ pid: 400, ppid: 1, uid: process.getuid(), startedAtMs: 3, args: `${extra.registryPath.replace('recipes.json', 'apps')}/Visual Studio Code.app/Contents/MacOS/Code` }); }
      const first = w.starts.length === 1;
      return { ok: true, identity: { pid: 400, pidBirth: 'b400', instance: 'i1', epoch: 1 }, hostPid: 450,
        card: first ? { shown: true, status: 'granted', scope: 'always', by: 'user' } : { shown: false, existing: true, status: 'granted', scope: 'always', by: 'existing' },
        relaunchCard: first ? { shown: true, status: 'granted', by: 'user' } : { shown: false }, relaunch: first ? { quitMs: 800, launchMs: 1200, wasFront: false, activated: false } : null,
        ...(extra.rehost && w.rehostReceipt ? { receipt: w.rehostReceipt } : {}) };
    }
    if (op === 'call') {
      const { name, arguments: a } = extra.request;
      if (name === 'browser_tabs') return { ok: true, result: { text: tabs(), isError: false } };
      if (name === 'browser_read') return { ok: true, result: { text: read(a.find), isError: false } };
      if (name === 'browser_act') return { ok: true, result: act(a.steps) };
    }
    if (op === 'status') return { ok: true, status: { hostPid: 450 } };
    if (op === 'collect') return { ok: true, status: { ownership: 'free', broker: 'collected' } };
    if (op === 'end') return { ok: true, ended: true, cleanup: [] };
    return { ok: true };
  }, kill() {} };
  const deps = {
    exec, forkWorker: async () => worker, exited: async () => true, sleep: tickSleep, now: (() => { let n = 0; return () => (n += 10); })(),
    list: async () => w.procs.map(p => ({ ...p })),
    helper: async request => request.mode === 'pids' ? { pids: ownerRunning ? [77] : [] } : request.mode === 'front' ? { front: 90, bundle: 'com.apple.Terminal' }
      : request.mode === 'windows' ? { windows: 1 } : {},
    electron: async request => {
      w.electron.push(request);
      if (request.mode === 'launch') {
        mkdirSync(join(request.appPath, '..', 'code-portable-data', 'user-data', 'logs'), { recursive: true });
        // VS Code 1.141.0's configuration migration at startup, seen in the 2026-10-22 02:32Z run's retained profile.
        const settings = join(request.appPath, '..', 'code-portable-data', 'user-data', 'User', 'settings.json');
        if (existsSync(settings)) writeFileSync(settings, readFileSync(settings, 'utf8').replace('"extensions.autoUpdate": false', '"extensions.autoUpdate": "off"'));
        w.procs.push({ pid: 300, ppid: 1, uid: process.getuid(), startedAtMs: 4, args: request.appPath + '/Contents/MacOS/Code ' + request.target });
        return { stage: 'launch', process: { pid: 300, bundle: request.bundle, path: request.appPath, launchedAtMs: 1000 } };
      }
      if (request.mode === 'quit') { w.quits.push(request.pid); w.procs = w.procs.filter(p => p.pid !== request.pid); return { stage: 'quit', reason: 'exited', presses: 0, forced: false }; }
      return { stage: request.mode };
    },
    derive: async p => ({ version: '1.141.0', signer: 'T', cdhash: 'c'.repeat(40), runtime: 'electron/43.7.7', bundleId: 'com.microsoft.VSCode', profile: p.profile }),
    secret: async () => 's'.repeat(43),
    kill: (pid, signal) => { w.kills.push([pid, signal]); w.procs = w.procs.filter(p => p.pid !== pid); },
  };
  return { app, root, deps, w };
}

test('cancellation after cloning cannot launch a relaunch fixture', async t => {
  const { app, root, deps, w } = relaunchWorld(t), controller = new AbortController(), exec = deps.exec;
  deps.exec = async (...args) => { const r = await exec(...args); if (args[0] === '/bin/cp') controller.abort(); return r; };
  const driver = liveRelaunchDriver(app, { root, deps, signal: controller.signal });
  await assert.rejects(driver.relaunch(), /RUN_INTERRUPTED/);
  assert.deepEqual(w.electron, []);
});

test('an unconfirmed relaunch app Quit retains its pipe owners and clone', async t => {
  const { app, root, deps, w } = relaunchWorld(t), electron = deps.electron;
  deps.electron = async request => {
    if (request.mode === 'quit') { assert.equal(request.allowForce, false); return { reason: 'deadline' }; }
    return electron(request);
  };
  const driver = liveRelaunchDriver(app, { root, deps }); await driver.relaunch();
  const result = await driver.cleanup();
  assert.equal(result.confirmed, false); assert.equal(existsSync(driver.paths().base), true);
  assert.deepEqual(w.kills, []);
});

test('a grace deadline reached during relaunch Quit prevents later signals and clone removal', async t => {
  const { app, root, deps, w } = relaunchWorld(t), lifecycle = { cleanupAllowed: true }, electron = deps.electron;
  deps.electron = async request => { const r = await electron(request); if (request.mode === 'quit') lifecycle.cleanupAllowed = false; return r; };
  const driver = liveRelaunchDriver(app, { root, deps, lifecycle }); await driver.relaunch();
  const result = await driver.cleanup();
  assert.equal(result.confirmed, false); assert.equal(existsSync(driver.paths().base), true); assert.deepEqual(w.kills, []);
});
test('a relaunch copy that fails readiness is quit at once by its launch birth, and cleanup confirms', async t => {
  const { app, root, deps, w } = relaunchWorld(t), electron = deps.electron;
  deps.electron = async request => {
    if (request.mode === 'ready') { w.electron.push(request); throw Error('ELECTRON_HELPER_FAILED: Launched editor identity changed before readiness (path)'); }
    const r = await electron(request);
    return request.mode === 'launch' ? { ...r, process: { ...r.process, pidBirth: '1000.000123' } } : r;
  };
  const driver = liveRelaunchDriver(app, { root, deps });
  await assert.rejects(driver.relaunch(), /identity changed before readiness \(path\)/);
  const ready = w.electron.find(r => r.mode === 'ready'), quit = w.electron.find(r => r.mode === 'quit');
  assert.equal(ready.pidBirth, '1000.000123');
  assert.deepEqual([quit.pid, quit.pidBirth, quit.appPath, 'allowForce' in quit], [300, '1000.000123', ready.appPath, false]);
  assert.ok(!w.procs.some(p => p.pid === 300), 'the failed launch was collected before cleanup');
  const result = await driver.cleanup();
  assert.equal(result.confirmed, true, JSON.stringify(result));
  assert.equal(existsSync(driver.paths().base), false);
  assert.deepEqual(w.kills, []);
});
test('cancellation inside relaunch host-loss stops its next internal tool and host signal', async t => {
  const { app, root, deps, w } = relaunchWorld(t), controller = new AbortController(), create = deps.forkWorker;
  let armed = false, calls = 0;
  deps.forkWorker = async options => { const worker = await create(options), send = worker.send;
    worker.send = async (...args) => { const result = await send(...args); if (armed && args[0] === 'call') { calls++; controller.abort(); } return result; }; return worker; };
  const driver = liveRelaunchDriver(app, { root, deps, signal: controller.signal }); await driver.relaunch(); armed = true;
  await assert.rejects(driver.hostLoss(), /RUN_INTERRUPTED/);
  assert.equal(calls, 1); assert.deepEqual(w.kills, []);
});
test('reparented relaunch app descendants keep the clone and host infrastructure', async t => {
  const { app, root, deps, w } = relaunchWorld(t), driver = liveRelaunchDriver(app, { root, deps, python: '/run/python3' });
  await driver.relaunch();
  w.procs.push({ pid: 401, ppid: 400, uid: process.getuid(), startedAtMs: 5, args: '/fixture/renderer' });
  const result = await driver.cleanup();
  assert.equal(result.confirmed, false); assert.ok(result.left.includes(401));
  assert.equal(existsSync(driver.paths().base), true); assert.deepEqual(w.kills, []);
});

test('the live relaunch driver runs every relaunch cell on its own clone, and never touches the owner\'s process', async t => {
  const { app, root, deps, w } = relaunchWorld(t);
  const cardLog = join(root, 'cards.jsonl');
  const driver = liveRelaunchDriver(app, { root, io: { permission: async () => false }, cardLog, python: '/run/python3', qualificationDiagnosticPath: '/run/diagnostic', deps });
  let n = 0;
  const clock = { now: () => (n += 5), sleep: async ms => { n += ms; } };
  const receipt = await runQualification({ app, driver, observer: fakeObserver({ now: clock.now, fixturePid: () => 400 }), io: { exists: () => false, permission: async () => false },
    clock, cells: liveRelaunchCells(app), options: { relaunch: true, mode: 'live', consentWaitMs: 120000 } });
  assert.deepEqual(receipt.cells.map(c => [c.id, c.status, c.error ?? '']), LIVE_RELAUNCH_ORDER.map(id => [id, 'pass', '']));
  assert.equal(receipt.qualified, true, receipt.validation.errors.concat(receipt.validation.unqualified).join(' '));
  const { base } = driver.paths();
  assert.equal(w.cp.length, 1);
  assert.equal(w.cp[0][1], app.path, 'cloned from the installed bundle');
  for (const r of w.electron) assert.ok(r.appPath.startsWith(base + '/'), `${r.mode} addressed the copy only`);
  assert.ok(!w.quits.includes(77) && !w.kills.some(([pid]) => pid === 77), 'the owner\'s process is never quit or signalled');
  assert.deepEqual(w.kills.filter(([pid]) => pid === 450).map(k => k[1])[0], 'SIGKILL', 'host-loss kills the run\'s own host');
  assert.deepEqual(w.starts.map(s => [s.profile, s.rehost]), [['user', false], ['user', false], ['user', true]]);
  assert.ok(w.starts.every(s => s.home.startsWith(base + '/') && s.cardLog === cardLog), 'the profile identity lives in the run folder');
  assert.ok(w.starts.every(s => s.python === '/run/python3' && s.qualificationDiagnosticPath === '/run/diagnostic'));
  assert.ok(!w.procs.some(row => row.pid === 450), 'cleanup removed the fake host');
  assert.equal(receipt.cells.find(c => c.id === 'relaunch-host-loss').detail.unsaved, 'kept');
  assert.equal(receipt.cells.find(c => c.id === 'relaunch-unsaved').detail.outcome, 'none');
  assert.equal(receipt.cleanup.confirmed, true);
  assert.equal(existsSync(base), false, 'the clone, its portable profile and the state are gone');
  assert.equal(SEED_SETTINGS['security.workspace.trust.enabled'], false, 'the restored window shows no trust prompt');
});

const relaunchRun = async (t, setup) => {
  const world = relaunchWorld(t); setup?.(world);
  const driver = liveRelaunchDriver(world.app, { root: world.root, io: { permission: async () => false }, deps: world.deps });
  let n = 0;
  const clock = { now: () => (n += 5), sleep: async ms => { n += ms; } };
  const receipt = await runQualification({ app: world.app, driver, observer: fakeObserver({ now: clock.now, fixturePid: () => 400 }), io: { exists: () => false, permission: async () => false },
    clock, cells: liveRelaunchCells(world.app), options: { relaunch: true, mode: 'live', consentWaitMs: 120000 } });
  return { ...world, driver, receipt, byId: Object.fromEntries(receipt.cells.map(cell => [cell.id, cell])) };
};

test('relaunch host-loss reaches the 1.141 editor through its tab and a find read, and seeds the migrated autoUpdate form', async t => {
  const { w, byId } = await relaunchRun(t);
  assert.equal(byId['relaunch-host-loss'].status, 'pass', JSON.stringify(byId['relaunch-host-loss']));
  assert.ok(w.scratchOpen && w.editorActive && /^hl[a-z0-9]+$/.test(w.typed), 'the marker went to the keyboard-only editor ref after the tab click');
  assert.equal(byId['relaunch-user-quit'].status, 'pass', JSON.stringify(byId['relaunch-user-quit']));
  assert.equal(SEED_SETTINGS['extensions.autoUpdate'], 'off', 'the form VS Code 1.141.0 writes back, so its startup migration leaves the seed alone');
});

test('relaunch host-loss without an actionable editor fails EDITOR_NOT_FOUND with closed detail', async t => {
  const { byId, driver } = await relaunchRun(t, ({ w }) => { w.keyboardRefWithheld = true; });
  const cell = byId['relaunch-host-loss'];
  assert.equal(cell.error, 'EDITOR_NOT_FOUND');
  assert.equal(cell.detail.stage, 'host-loss-editor');
  assert.match(cell.detail.expected, /selected a-scratch\.txt tab and one actionable editor textbox/);
  assert.deepEqual({ ...cell.detail.seen, reads: cell.detail.seen.reads > 2 }, { tabOpen: true, tabSelected: true, rowClicked: true, tabClicked: true,
    textboxes: 1, actionable: 0, active: 1, keyboardOnly: 0, reads: true, cut: false });
  const text = JSON.stringify(cell.detail);
  assert.ok(!text.includes(driver.paths().base) && !text.includes('/') && !text.includes('Visual Studio Code'), 'no path or window title');
});

// The 2026-10-22 03:00Z failure left UNSAVED_WORK_LOST with no detail. Each host-loss outcome now carries closed facts:
// counts, booleans and fixed reasons, never the marker, a path or a window title.
const closedHostLoss = (cell, driver) => {
  const text = JSON.stringify(cell.detail);
  assert.ok(!text.includes(driver.paths().base) && !text.includes('/') && !text.includes('Visual Studio Code') && !/"hl[a-z0-9]{6}"/.test(text), text);
  assert.equal(cell.detail.typed.length, 8, 'the marker length only');
};

test('relaunch host-loss that loses the buffer on the restart fails UNSAVED_WORK_LOST with closed detail of every step', async t => {
  const { byId, driver } = await relaunchRun(t, ({ w }) => { w.dropOnRehost = true; });
  const cell = byId['relaunch-host-loss'];
  assert.equal(cell.error, 'UNSAVED_WORK_LOST');
  closedHostLoss(cell, driver);
  const d = cell.detail;
  assert.equal(d.stage, 'host-loss-verify');
  assert.deepEqual([d.typed.ok, d.typed.keyboardOnlyRef, d.window.known], [true, true, true]);
  assert.deepEqual([d.beforeKill.seen, d.beforeKill.onDisk, d.beforeKill.cut, d.beforeKill.tabSelected], [true, false, false, true]);
  assert.deepEqual(d.host, { appSurvived: true, restarted: 'reattached', replyOk: true, code: null, replyStage: null, samePid: true, sameBirth: true, relaunchRequested: false, qualify: null });
  assert.deepEqual([d.after.tabFound, d.after.sameWindow, d.after.seen, d.after.cut, d.after.tabSelected, d.after.textboxes, d.after.editorRef],
    [true, true, false, false, true, 2, true]);
  assert.ok(d.after.reads > 1, 'the find read after the restart is retried before the verdict');
  assert.deepEqual(d.save, { ok: true, code: null, onDisk: false });
  assert.deepEqual([d.keptBy, d.reason], [null, null]);
});

test('relaunch host-loss whose typing never landed is unmeasured, not lost, and says so', async t => {
  const { byId, driver } = await relaunchRun(t, ({ w }) => { w.typingLost = true; });
  const cell = byId['relaunch-host-loss'];
  assert.equal(cell.error, 'HOST_LOSS_UNMEASURED');
  closedHostLoss(cell, driver);
  assert.deepEqual([cell.detail.typed.ok, cell.detail.beforeKill.seen, cell.detail.after.seen, cell.detail.reason], [true, false, false, 'typed-text-not-seen']);
});

test('relaunch host-loss never verifies through another window or a parked tab after the restart', async t => {
  for (const [tabs, sameWindow] of [['t' + '0'.repeat(31) + '2 Visual Studio Code window 8 joined join 1', false],
    ['t' + '0'.repeat(31) + '1 Visual Studio Code window 7 parked join 2', false]]) {
    const { byId, driver } = await relaunchRun(t, ({ w }) => { w.afterRehostTabs = tabs; });
    const cell = byId['relaunch-host-loss'];
    assert.equal(cell.error, 'HOST_LOSS_UNMEASURED', tabs);
    closedHostLoss(cell, driver);
    assert.deepEqual([cell.detail.after.tabFound, cell.detail.after.sameWindow, cell.detail.save, cell.detail.reason], [false, sameWindow, null, 'no-joined-tab-after-restart']);
  }
});

test('relaunch host-loss with zero tabs after the restart names the restarted turn\'s dry-run step, codes and counts only', async t => {
  // The 2026-10-22 03:14Z live shape: the host reattached the same process, and the list after it was empty.
  const { byId, driver } = await relaunchRun(t, ({ w }) => { w.afterRehostTabs = 'No app windows are joined.';
    w.rehostReceipt = { qualified: false, failed: 'ELECTRON_QUALIFY_NO_JOIN', failedStage: 'join', cells: { targets: 1, joined: 0, parked: [] }, instance: { pid: 400 } }; });
  const cell = byId['relaunch-host-loss'];
  assert.equal(cell.error, 'HOST_LOSS_UNMEASURED');
  closedHostLoss(cell, driver);
  assert.deepEqual(cell.detail.host.qualify, { qualified: false, failed: 'ELECTRON_QUALIFY_NO_JOIN', stage: 'join', targets: 1, joined: 0 });
  assert.deepEqual([cell.detail.after.joinedTabs, cell.detail.after.windows, cell.detail.reason], [0, 0, 'no-joined-tab-after-restart']);
});

test('relaunch host-loss counts the marker the save wrote after the restart as kept when no find row shows it', async t => {
  const { byId } = await relaunchRun(t, ({ w }) => { w.hideTyped = true; w.saveWrites = true; });
  const cell = byId['relaunch-host-loss'];
  assert.equal(cell.status, 'pass', JSON.stringify(cell));
  assert.equal(cell.detail.keptBy, 'disk');
  // A buffer the editor dropped saves nothing new, so the same setup with the drop fails as before.
  const lost = (await relaunchRun(t, ({ w }) => { w.hideTyped = true; w.saveWrites = true; w.dropOnRehost = true; })).byId['relaunch-host-loss'];
  assert.equal(lost.error, 'HOST_LOSS_UNMEASURED');
  assert.deepEqual([lost.detail.save.onDisk, lost.detail.reason], [false, 'typed-text-not-seen']);
});

test('relaunch user-quit names the connected birth to the helper and a helper refusal carries closed detail', async t => {
  const birth = '1792638040.154823';
  const withBirth = ({ deps }) => {
    const create = deps.forkWorker;
    deps.forkWorker = async options => {
      const worker = await create(options), send = worker.send.bind(worker);
      return { ...worker, send: async (op, extra = {}) => {
        const reply = await send(op, extra);
        return op === 'start' && reply.ok ? { ...reply, identity: { ...reply.identity, pidBirth: birth } } : reply;
      } };
    };
  };
  const passed = await relaunchRun(t, withBirth);
  assert.equal(passed.byId['relaunch-user-quit'].status, 'pass', JSON.stringify(passed.byId['relaunch-user-quit']));
  const quit = passed.w.electron.filter(r => r.mode === 'quit' && r.pid === 400)[0];
  assert.equal(quit.pidBirth, birth);
  const { byId, driver } = await relaunchRun(t, world => {
    withBirth(world);
    const electron = world.deps.electron;
    world.deps.electron = async request => {
      if (request.mode === 'quit' && request.pid === 400 && !request.allowForce && request.allowForce !== false)
        throw Error('ELECTRON_HELPER_FAILED: ' + driverPathFree + ': execution error: Error: Error: Launched editor identity changed; quit refused (pid 400, bundle) (-2700)');
      return electron(request);
    };
  });
  const cell = byId['relaunch-user-quit'];
  assert.match(cell.error, /^ELECTRON_HELPER_FAILED/);
  assert.deepEqual(cell.detail, { stage: 'user-quit-helper', expected: 'the relaunched app quit by its pid, bundle, path and birth', reason: 'quit-identity-bundle',
    birthPinned: true, turnEnded: true, appAliveAfter: true });
  assert.ok(!JSON.stringify(cell.detail).includes(driver.paths().base));
});
const driverPathFree = 'real-electron.js';

test('a settings change during host-loss fails relaunch-user-quit PROFILE_CHANGED with when and which seed keys changed, closed', async t => {
  const { byId, driver } = await relaunchRun(t, ({ deps }) => {
    const create = deps.forkWorker;
    deps.forkWorker = async options => {
      const worker = await create(options), send = worker.send.bind(worker);
      return { ...worker, send: async (op, extra = {}) => {
        if (op === 'start' && extra.rehost) {
          const settings = join(extra.registryPath, '..', 'apps', 'code-portable-data', 'user-data', 'User', 'settings.json');
          const value = JSON.parse(readFileSync(settings, 'utf8'));
          writeFileSync(settings, JSON.stringify({ ...value, 'workbench.tips.enabled': true, 'update.mode': [MAC_USERS + 'someone', 'x'].join(''),
            'files.hotExit': undefined, 'window.title': 'private' }, null, 2) + '\n');
        }
        return send(op, extra);
      } };
    };
  });
  assert.equal(byId['relaunch-host-loss'].status, 'pass');
  const cell = byId['relaunch-user-quit'];
  assert.equal(cell.error, 'PROFILE_CHANGED');
  assert.deepEqual(cell.detail, { stage: 'user-quit-profile', expected: 'the seeded settings file, byte for byte', userData: true, settings: true, parsed: true,
    changedBeforeQuit: true, changedByQuit: false,
    changed: [{ key: 'update.mode', expected: 'none', seen: 'string' }, { key: 'workbench.tips.enabled', expected: false, seen: true },
      { key: 'files.hotExit', expected: 'onExitAndWindowClose', missing: true }],
    added: 1, matchesSeedAt: { engaged: true, relaunched: true, hostLossStart: true, hostLossEnd: false, userQuitStart: false, userQuitEnd: false } });
  assert.ok(!JSON.stringify(cell.detail).includes(MAC_USERS) && !JSON.stringify(cell.detail).includes(driver.paths().base));
});

test('with the owner\'s VS Code running or a quarantined source, the relaunch driver clones nothing and quits nothing', async t => {
  for (const world of [{ ownerRunning: true }, { quarantined: true }]) {
    const { app, root, deps, w } = relaunchWorld(t, world);
    const driver = liveRelaunchDriver(app, { root, io: {}, deps });
    await assert.rejects(driver.relaunch(), world.ownerRunning ? /OWNER_APP_RUNNING/ : /SOURCE_QUARANTINED/);
    assert.deepEqual(w.cp, []);
    assert.deepEqual(w.electron, []);
    const cleanup = await driver.cleanup();
    assert.equal(cleanup.confirmed, true);
    assert.deepEqual(w.kills, []);
    assert.deepEqual(w.quits, []);
  }
});

test('clone launch accepts a canonical path alias and rejects a different app with the returned identity in its error', async t => {
  for (const mismatch of [false, true]) {
    const { app, root, deps, w } = relaunchWorld(t);
    const electron = deps.electron;
    deps.electron = async request => {
      const result = await electron(request);
      if (request.mode === 'launch') result.process.path = mismatch ? app.path : result.process.path.replace(/^\/private\//, '/');
      return result;
    };
    const driver = liveRelaunchDriver(app, { root, io: {}, deps });
    if (mismatch) await assert.rejects(driver.relaunch(), error => error.message.includes('COPY_LAUNCH_IDENTITY_MISMATCH') &&
      error.detail.pid === 300 && error.detail.actual === app.path && error.detail.expected === driver.paths().copy);
    else assert.equal((await driver.relaunch()).pipe, true);
    await driver.cleanup();
    assert.ok(!w.quits.includes(77), 'no owner process addressed');
  }
});

test('an incomplete LaunchServices reply has its own code and preserves the launch stage', async t => {
  const { app, root, deps } = relaunchWorld(t);
  deps.electron = async () => ({ stage: 'launch', process: { pid: -1, path: '' } });
  const driver = liveRelaunchDriver(app, { root, io: {}, deps });
  await assert.rejects(driver.relaunch(), error => /COPY_LAUNCH_PID_INVALID/.test(error.message) && error.detail.stage === 'copy-launch' && error.detail.pid === -1);
  await driver.cleanup();
});

test('a partial LaunchServices reply is resolved from the exact clone census without launching twice', async t => {
  const { app, root, deps, w } = relaunchWorld(t);
  const electron = deps.electron;
  let clone, scans = 0;
  deps.electron = async request => {
    if (request.mode === 'table') return { stage: 'table', processes: ++scans > 1 ? [clone] : [] };
    const result = await electron(request);
    if (request.mode === 'launch') { clone = result.process; return { stage: 'launch', process: { pid: -1, path: '', bundle: request.bundle } }; }
    return result;
  };
  const driver = liveRelaunchDriver(app, { root, io: {}, deps });
  assert.equal((await driver.relaunch()).pipe, true);
  assert.equal(scans, 2);
  assert.equal(w.electron.filter(r => r.mode === 'launch').length, 1);
  await driver.cleanup();
});

test('the arm server reads only a private config, and forwards each tool call to its one worker', async t => {
  const dir = temp(t), path = join(dir, 'arm.json');
  const config = { bundleId: 'com.microsoft.VSCode', session: 'v3' + 'a'.repeat(32), registryPath: '/r', stateDir: '/s', tempRoot: '/t', appSecret: 'x' };
  writeFileSync(path, JSON.stringify(config), { mode: 0o644 });
  assert.throws(() => readArmConfig(path), /ARM_CONFIG_UNSAFE/);
  writeFileSync(path, JSON.stringify({ ...config, extra: 1 }), { mode: 0o600 });
  (await import('node:fs')).chmodSync(path, 0o600);
  assert.throws(() => readArmConfig(path), /ARM_CONFIG_INVALID/);
  writeFileSync(path, JSON.stringify(config));
  assert.deepEqual(readArmConfig(path), config);
  const sent = [];
  const worker = { async send(op, extra) { sent.push([op, extra?.request?.name ?? extra?.text]); return op === 'start' ? { ok: true, identity: { pid: 1 } }
    : op === 'call' ? { ok: true, result: { text: 'tab list', isError: false } } : { ok: true, ended: true, cleanup: [] }; }, kill() { sent.push(['kill']); } };
  const session = await createArmSession({ config, text: 'task', worker });
  assert.deepEqual(await session.call({ name: 'browser_tabs', arguments: { do: 'list' } }), { text: 'tab list', isError: false });
  await session.close();
  assert.deepEqual(sent, [['start', 'task'], ['call', 'browser_tabs'], ['end', undefined], ['kill']]);
  const refused = { async send() { return { ok: false, error: 'ELECTRON_DEBUGGER_REQUIRED' }; }, kill() {} };
  await assert.rejects(createArmSession({ config, text: 't', worker: refused }), error => error.message === 'ELECTRON_DEBUGGER_REQUIRED' && error.stage === 'app-start');
  const hostRefused = { async send() { return { ok: false, error: 'STATE_DIR_TOO_LONG', stage: 'app-host' }; }, kill() {} };
  await assert.rejects(createArmSession({ config, text: 't', worker: hostRefused }), error => error.message === 'STATE_DIR_TOO_LONG' && error.stage === 'app-host');
});

test('the worker logs each card request and its answer, and the card helper only reads', () => {
  const worker = readFileSync(new URL('../bench/electron-qualification-worker.mjs', import.meta.url), 'utf8');
  for (const part of ["watched('debugger'", "watched('relaunch'", "event: 'requested'", "event: 'answered'", 'deadlineAt: at + CARD_TTL_MS']) assert.ok(worker.includes(part), part);
  const helper = readFileSync(new URL('../bench/electron-qualification.js', import.meta.url), 'utf8');
  const card = helper.slice(helper.indexOf('card: function'), helper.indexOf('pressInSheet: function'));
  assert.doesNotMatch(card, /AXPress|PerformAction|activate|CGEventPost/);
  for (const file of ['electron-live-runner.mjs', 'electron-relaunch-live.mjs', 'electron-arm-server.mjs', 'electron-cards.mjs', 'electron-live-runner-fakes.mjs']) {
    const text = readFileSync(new URL('../bench/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /tell application|Application\(['"]|System Events|osascript', \['-e'|AXPress/, file);
  }
  const sandbox = {};
  runInNewContext(helper + '\nthis.cardRows = cardRows;', sandbox);
  const rows = sandbox.cardRows([{ kCGWindowOwnerPID: 9, kCGWindowNumber: 3, kCGWindowLayer: 25, kCGWindowIsOnscreen: 1, kCGWindowName: 'secret', kCGWindowBounds: { X: 1, Y: 0, Width: 30, Height: 24 } },
    { kCGWindowOwnerPID: 10, kCGWindowNumber: 4, kCGWindowLayer: 0, kCGWindowBounds: {} }], [9]);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ pid: 9, id: 3, layer: 25, onScreen: true, x: 1, y: 0, width: 30, height: 24 }], 'no titles, only this run\'s pids');
});

test('fake runner deps never take a real lock and write cards the watcher reads', async t => {
  const dir = temp(t), cardLog = join(dir, 'cards.jsonl');
  const deps = fakeRunnerDeps({ cardLog, out: dir, write: false });
  const release = await deps.lock();
  await release();
  await deps.arm({ app: APPS.vscode });
  await deps.watcher.poll();
  assert.deepEqual(deps.watcher.summary().map(c => [c.kind, c.click, c.inTime]), [['debugger', 'Allow this session', true]]);
});
