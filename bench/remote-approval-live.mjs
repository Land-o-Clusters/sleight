#!/usr/bin/env node
// Import-safe RA1 owner-away check. The interactive PTY is shared with the benchmark; this file never imports run.mjs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir, loadavg } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLiveLock } from './live-lock.mjs';
import { launchPty, SessionTranscript, terminalGate } from './world/arms/claude-cu/interactive.mjs';
import { VirtualTerminal } from './world/arms/claude-cu/terminal.mjs';
import { openFixture, closeFixtures } from './real-fixture.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { assertLogin } from './preflight.mjs';
import { prepareHandHost } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { FIRST_NOTICE_MS, REMOTE_NOTICE, expectedNoticeResult, noticeTiming, scrubRemoteValue, transcriptRows, writeRemoteEvidence } from './remote-approval-evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// This dedicated benchmark profile keeps its keychain identity across runs without changing another arm.
export function remoteLoginPlan({ home = homedir(), env = process.env } = {}) {
  const clean = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'].filter(k => typeof env[k] === 'string').map(k => [k, env[k]]));
  return { command: 'claude', env: { ...clean, HOME: home,
    CLAUDE_CONFIG_DIR: join(home, 'Library', 'Caches', 'sleight-bench', 'remote-approval', 'claude') } };
}
export function assertRemoteLogin(plan = remoteLoginPlan(), options) {
  try { assertLogin(plan, options); }
  catch (error) {
    // Home paths are scrubbed from the report. A shell expansion keeps the recovery command runnable.
    if (/^Not logged in/.test(error.message)) error.message = error.message.replace(/\nFix: [\s\S]*$/,
      '\nFix: env CLAUDE_CONFIG_DIR="$HOME/Library/Caches/sleight-bench/remote-approval/claude" claude auth login');
    throw error;
  }
}
export function remotePlan() {
  return { app: 'TextEdit', bundle: 'com.apple.TextEdit', interactive: true,
    approvals: 'empty arm store; no persistent writes', engineAlwaysList: 'untouched; a bypass fails the notice check',
    args: ['--plugin-dir', join(root, 'plugins/sleight'), '--model', 'claude-haiku-5-5', '--effort', 'high',
      '--no-chrome', '--setting-sources', '', '--strict-mcp-config', '--tools', '',
      '--allowedTools', 'mcp__plugin_sleight_computer__js,mcp__plugin_sleight_computer__turn_ended', '--disable-slash-commands'],
    first: 'Use computer use to read the short note in the macOS plain text editor. Report its first line verbatim. Use var app for the app handle and nodeRepl.write(await app.getAXState({disableDiffing:true})) to read it. Do not edit anything. If a tool refuses approval, stop and report the exact notice.',
    upfront: 'write a note in TextEdit and email it to me' };
}
function hasModBegin(turn) {
  return turn.modTurnBegin?.direction === 'mod-turn-begin' && Number.isFinite(turn.modTurnBegin.t) &&
    Number.isFinite(turn.submitAt) && turn.modTurnBegin.t >= turn.submitAt;
}
function requireModBegin(turn, label) {
  if (hasModBegin(turn)) return;
  const p = turn.presence;
  // The mod skips ordinary composer text when turbo is off and the person is present.
  // This is a pre-submit sample, so report a possible skip, never a proved cause.
  const possibleSkip = label !== 'typed' && p?.locked === false && Number.isFinite(p.idleSeconds) &&
    p.idleSeconds >= 0 && p.idleSeconds < 120;
  throw Error(`mod did not reach the server for ${label} (${possibleSkip
    ? 'person-present skip possible with turbo off; HID idle below 120 s'
    : 'guard, connect or mod load; check for a presence change since submit'})`);
}
export function gradeRemote({ notice = {}, yes = {}, typed = {}, upfront = {}, mail }) {
  const elapsed = Number.isFinite(notice.noticeResult?.t) && Number.isFinite(notice.firstToolAt) ? notice.noticeResult.t - notice.firstToolAt : NaN;
  const checks = {
    mod: [notice, yes, typed].every(hasModBegin),
    notice: Number.isFinite(elapsed) && elapsed >= 0 && elapsed < FIRST_NOTICE_MS && notice.noticeResult.text?.includes(REMOTE_NOTICE) === true,
    yes: hasModBegin(yes) && Array.isArray(yes.grants) && yes.grants.length === 0 && yes.complete !== true,
    typed: hasModBegin(typed) && typed.complete === true && typed.grants?.includes('com.apple.TextEdit'),
    upfront: typeof mail === 'string' && mail.length > 0 && new RegExp(`allow TextEdit, ${mail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(upfront.text ?? ''),
  };
  return { passed: Object.values(checks).every(Boolean), checks, noticeMs: Number.isFinite(elapsed) ? elapsed : null };
}
export async function runRemoteApproval(options = {}, io) {
  const plan = remotePlan();
  if (options.dryRun) return { dryRun: true, plan };
  if (!options.ownerAway) throw Error('Live remote approval checks require --owner-away');
  io ??= realDependencies();
  const started = io.now().toISOString(), report = { started, plan, load: loadavg(), passed: false, live: true };
  let release, bank, session, collected = true, fixtureStarted = false, cleanup = false;
  try {
    await io.hold(); release = await io.lock(); await io.hold();
    await io.login();
    report.prewarm = await io.prewarm();
    if (report.prewarm?.status !== 'ready') throw Error('Consent host prewarm failed: ' + (report.prewarm?.code ?? 'unavailable'));
    bank = await io.prepare();
    await io.hold(); fixtureStarted = true; await io.fixture(bank);
    session = await io.session(bank);
    await io.hold(); report.notice = await session.submit(plan.first + ` The owned fixture is titled ${bank.windowTitle ?? bank.fixture}; read only that window.`);
    report.noticeMs = gradeRemote({ notice: report.notice }).noticeMs;
    // Fail before feeding any approval if the first engine request did not actually stop.
    if (!gradeRemote({ notice: report.notice }).checks.notice) throw Error('First unapproved call did not return the required notice within 45 s');
    requireModBegin(report.notice, 'notice');
    await io.hold(); report.yes = await session.submit('yes');
    requireModBegin(report.yes, 'yes');
    if (report.yes.grants.length || report.yes.complete) throw Error('Bare yes granted app access');
    await io.hold(); report.typed = await session.submit('allow TextEdit');
    requireModBegin(report.typed, 'typed');
    collected = (await session.close()).clean === true; session = undefined;
    if (!collected) throw Error('Interactive child collection unconfirmed');
    // The upfront request gets a new relay session, so TextEdit is unapproved again.
    session = await io.session(bank, { upfront: true });
    await io.hold(); report.upfront = await session.submit(plan.upfront);
    Object.assign(report, gradeRemote({ ...report, mail: bank.mail }));
  } catch (error) {
    report.error = error.message; report.collectionError = error.collectionError;
    if (error.collected === false) collected = false;
  }
  finally {
    if (session) try { collected = (await session.close()).clean === true; }
    catch (error) { collected = false; report.collectionError = error.message; }
    // Snapshot while the isolated bank and server diagnostics still exist, even on startup or collection failure.
    try { report.evidence = await io.evidence({ report, bank }); }
    catch (error) { report.passed = false; report.evidenceError = error.message; }
    if (bank && fixtureStarted && collected && report.evidence) try { await io.hold(); cleanup = await io.cleanup(bank) === true; } catch (error) { report.cleanupError = error.message; }
    else {
      cleanup = !fixtureStarted;
      if (bank && !fixtureStarted) removeTemp(bank.bank);
    }
    report.collected = collected; report.cleanup = cleanup;
    if (!collected || !cleanup) { report.passed = false; report.lockRetained = !!release; }
    else if (release) try { await release(); } catch (error) { report.passed = false; report.lockError = error.message; }
    report.bank = bank?.bank;
    const output = report.evidence && join(report.evidence, 'report.json');
    report.output = output;
    if (output) try { await io.write(output, scrubRemoteValue(report)); }
    catch (error) { report.passed = false; report.outputError = error.message; }
  }
  return report;
}

export async function prewarmConsentHost({ prepare = prepareHandHost, signal, now = Date.now } = {}) {
  const began = now(), progress = [];
  const built = await prepare({ signal, onProgress: row => progress.push(row) });
  return { status: built.status, code: built.code, detail: built.detail, ms: now() - began, progress };
}

export function realDependencies() {
  const execute = promisify(execFile), controller = new AbortController();
  const login = remoteLoginPlan();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => controller.abort());
  const hold = async () => { while (existsSync('/tmp/sleight-hold')) { controller.signal.throwIfAborted(); await sleep(1000); } controller.signal.throwIfAborted(); };
  const metadata = async operation => {
    const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'plugins/sleight/lib/remote-approvals.js'), JSON.stringify({ operation })],
      { timeout: 3000, signal: controller.signal, encoding: 'utf8' });
    return JSON.parse(stdout);
  };
  return {
    now: () => new Date(), hold,
    login: () => assertRemoteLogin(login),
    prewarm: () => prewarmConsentHost({ signal: controller.signal }),
    evidence: async ({ report, bank }) => writeRemoteEvidence({ started: report.started, report,
      sessions: (bank?.sessions ?? []).map(session => session.diagnostics()) }),
    lock: () => acquireLiveLock('/tmp/sleight-live.lock', { wait: true, interval: 1000, signal: controller.signal }),
    prepare: async () => {
      const presence = await metadata('presence');
      if (!(presence.idleSeconds >= 120) || presence.locked !== false) throw Error('Owner-away check needs an unlocked Mac with HID idle at least 120 s');
      const catalog = await metadata('catalog'), mailId = catalog.defaults?.['mailto:'];
      const mail = catalog.apps?.find(app => app.id === mailId)?.name;
      if (!mail) throw Error('No installed default mail app; upfront case cannot be graded');
      const bank = mkdtempSync(join(tmpdir(), 'sleight-remote-approval-')), token = 'RA1-' + randomUUID();
      const windowTitle = 'RA1-note-' + randomUUID() + '.txt', document = join(bank, windowTitle); writeFileSync(document, token + '\n', { mode: 0o600 });
      return { bank, mail, token, windowTitle, document, fixture: token, signal: controller.signal, dir: bank, nonce: token,
        ownerAway: true, stopOnAppDialog: true, onAppDialog: () => controller.abort() };
    },
    fixture: async bank => {
      const lease = await openFixture(bank, { app: 'TextEdit', bundle: 'com.apple.TextEdit', target: bank.document, token: basename(bank.document), mode: 'document' });
      if (lease.running !== false || lease.launched !== true) throw Error('The TextEdit fixture must own a cold launch; existing user windows are never read');
    },
    cleanup: async bank => {
      await closeFixtures(bank);
      if (bank.exitDisagreements?.length) return false;
      removeTemp(bank.bank); return true;
    },
    session: (bank, options) => realSession(bank, { hold, signal: controller.signal, login, presence: () => metadata('presence'), ...options }),
    write: (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }),
  };
}

export async function realSession(bank, { hold, signal, upfront = false, login = remoteLoginPlan(), launch = launchPty, presence, now = Date.now, wait = sleep }) {
  const id = randomUUID(), config = login.env.CLAUDE_CONFIG_DIR;
  mkdirSync(join(bank.bank, id), { recursive: true, mode: 0o700 });
  // Claude keys project trust by the folder's real path (/var/folders is /private/var/folders), as the claude-cu arm does.
  const dir = realpathSync(join(bank.bank, id));
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const mcp = join(dir, 'mcp.json'), settings = join(dir, 'settings.json'), turnFile = join(dir, 'turn-' + id + '.json');
  const nonce = randomUUID(), audit = join(dir, 'approvals.jsonl'), diagnosticsFile = join(dir, 'server-diagnostics.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { 'plugin:sleight:computer': { command: process.execPath,
    args: [fileURLToPath(new URL('./remote-approval-server.mjs', import.meta.url))],
    env: { SLEIGHT_TURBO: '0', SLEIGHT_HAND: '0', SLEIGHT_APPROVAL_PROMPT: 'dialog', RA1_AUDIT: audit, RA1_DIAGNOSTICS: diagnosticsFile } } } }), { mode: 0o600 });
  writeFileSync(settings, JSON.stringify({ autoMemoryEnabled: false, enabledPlugins: {}, claudeMdExcludes: ['**'],
    hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `"${process.execPath}" "${fileURLToPath(new URL('./remote-approval-guard.mjs', import.meta.url))}"`, timeout: 5 }] }], Stop: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${fileURLToPath(new URL('./world/arms/claude-cu/turn-ended.mjs', import.meta.url))}"`, timeout: 5 }] }] } }), { mode: 0o600 });
  const env = { ...login.env };
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, TERM: 'xterm-256color', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
    RA1_UPFRONT: upfront ? '1' : '0', BENCH_CU_SESSION: id, BENCH_CU_NONCE: nonce, BENCH_CU_TURN_DIR: dir, BENCH_CU_TURN_RECEIPT: turnFile });
  const plan = { command: login.command, cwd: dir, env,
    args: [...remotePlan().args, '--session-id', id, '--mcp-config', mcp, '--settings', settings] };
  const configFile = join(config, '.claude.json');
  const before = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
  let restored = false;
  const restoreTrust = () => {
    if (restored) return;
    restored = true;
    process.off('exit', restoreTrust);
    // Read again after child collection so account refreshes and other Claude metadata survive.
    const current = JSON.parse(readFileSync(configFile, 'utf8'));
    if (Object.hasOwn(before.projects ?? {}, dir)) current.projects[dir] = before.projects[dir];
    else if (current.projects) delete current.projects[dir];
    if (!Object.hasOwn(before, 'projects') && current.projects && !Object.keys(current.projects).length) delete current.projects;
    if (Object.hasOwn(before, 'hasCompletedOnboarding')) current.hasCompletedOnboarding = before.hasCompletedOnboarding;
    else delete current.hasCompletedOnboarding;
    writeFileSync(configFile, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
  };
  // An exit the finally blocks never reach (a signal that ends the process) still removes this run's trust.
  process.once('exit', restoreTrust);
  writeFileSync(configFile, JSON.stringify({ ...before, hasCompletedOnboarding: true,
    projects: { ...before.projects, [dir]: { hasTrustDialogAccepted: true, enabledMcpServers: ['plugin:sleight:computer'] } } }), { mode: 0o600 });
  // No print mode: the real terminal composer must raise prompt.submit with a trusted origin.
  const screen = new VirtualTerminal(), transcript = new SessionTranscript(id), events = [];
  transcript.onEvent = event => events.push(event);
  transcript.onText = event => events.push(event);
  const turns = [];
  const diagnostics = () => {
    let diagnosticError, server;
    try { refresh(); } catch (error) { diagnosticError = error.message; }
    try { if (existsSync(diagnosticsFile)) server = JSON.parse(readFileSync(diagnosticsFile, 'utf8')); }
    catch (error) { diagnosticError = error.message; }
    return { rows: events, turns: turns.map(turn => ({ ...turn, observedAt: now(), rows: events.slice(turn.start, turn.end) })), server, diagnosticError };
  };
  (bank.sessions ??= []).push({ diagnostics });
  const refresh = () => transcript.update({ env, sessionId: id });
  let pty;
  try { pty = launch(plan, data => screen.write(data)); }
  catch (error) { restoreTrust(); throw error; }
  let closed; pty.closed.then(value => { closed = value; });
  const readyAt = now();
  try {
  while (!terminalGate(screen).ready) {
    await hold(); signal.throwIfAborted();
    if (closed || now() - readyAt > 30000 || terminalGate(screen).blocked) throw Error('Interactive Claude startup is not ready; inspect the isolated arm');
    await wait(100);
  }
  await wait(1000);
  } catch (error) {
    try { await pty.stop(); error.collected = (await pty.closed).clean === true; }
    catch (stopError) { error.collected = false; error.collectionError = stopError.message; }
    finally { restoreTrust(); }
    throw error;
  }
  return {
    diagnostics,
    async submit(text) {
      await hold(); signal.throwIfAborted(); refresh();
      const start = events.length, turn = { start };
      turns.push(turn);
      try { turn.presence = await presence?.(); }
      catch (error) { turn.presenceError = error.message; throw error; }
      const grantsBefore = existsSync(audit) ? readFileSync(audit, 'utf8').split('\n').filter(Boolean).length : 0;
      if (existsSync(turnFile)) unlinkSync(turnFile);
      const began = now(); turn.submitAt = began;
      pty.write('\x1b[200~' + text + '\x1b[201~\r');
      let timeout = 120000;
      while (!existsSync(turnFile)) {
        await hold(); signal.throwIfAborted(); refresh();
        if (closed) throw Error('Interactive Claude exited during the fixture task');
        const current = events.slice(start), first = current.find(e => e.type === 'assistant' && e.message?.content?.some(b => b.type === 'tool_use'));
        const gotNotice = expectedNoticeResult(current) !== null;
        if (first && text.startsWith(remotePlan().first)) {
          const noticeDeadline = first.t - began + FIRST_NOTICE_MS;
          timeout = gotNotice ? Math.max(120000, noticeDeadline) : noticeDeadline;
        } else timeout = 120000;
        if (now() - began >= timeout) throw Error('Interactive turn deadline exceeded');
        await wait(100);
      }
      const stop = JSON.parse(readFileSync(turnFile, 'utf8'));
      if (stop.sessionId !== id || stop.nonce !== nonce) throw Error('Interactive Stop receipt differs');
      refresh();
      turn.end = events.length;
      const rows = events.slice(start), tools = rows.flatMap(e => e.message?.content ?? []);
      for (const tool of tools.filter(b => b.type === 'tool_use')) if (tool.name !== 'mcp__plugin_sleight_computer__js') throw Error('Unexpected tool outside the TextEdit fixture');
      const plain = b => typeof b.content === 'string' ? b.content : (b.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const output = tools.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const results = tools.filter(b => b.type === 'tool_result').map(plain).join('\n');
      const grants = existsSync(audit) ? readFileSync(audit, 'utf8').split('\n').filter(Boolean).slice(grantsBefore).map(line => JSON.parse(line).app) : [];
      const trace = diagnostics().server?.trace ?? [], observedAt = now();
      const timing = noticeTiming(rows, trace, began, observedAt);
      const modTurnBegin = trace.find(row => row.direction === 'mod-turn-begin' && row.t >= began && row.t <= observedAt) ?? null;
      return { text: transcriptRows(rows).filter(row => row.type !== 'tool_use').map(row => row.text).join('\n'), ...timing, modTurnBegin, presence: turn.presence, grants,
        complete: output.includes(bank.token) && results.includes(bank.token) };
    },
    async close() { try { await pty.stop(); return await pty.closed; } finally { restoreTrust(); } },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(a => !['--dry-run', '--owner-away'].includes(a))) throw Error('Use --dry-run or --owner-away');
  runRemoteApproval({ dryRun: args.includes('--dry-run'), ownerAway: args.includes('--owner-away') })
    .then(result => { console.log(JSON.stringify(scrubRemoteValue(result), null, 2)); if (!result.dryRun && !result.passed) process.exitCode = 1; })
    .catch(error => { console.error(scrubRemoteValue(error.message)); process.exitCode = 1; });
}
