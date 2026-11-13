// The live Electron runner for sleight-arch (1.3.1 validation, ledger p130 g4). One command, owner away, three phases:
//   qualify   the 22 EPV3-8 cells (electron-qualification.mjs) on the benchmark VS Code instance: a temporary profile and the
//             fixture folder, launched by sleight's resident host through the installed worker's app path.
//   arm       a Claude Code arm (Haiku 5.5, high effort) doing three fixture tasks through the five production turbo tools,
//             served by electron-arm-server.mjs over the same worker path, on its own benchmark instance.
//   relaunch  the relaunch cells (RELAUNCH_CELLS) on a clone of the installed VS Code with its own portable profile
//             (electron-relaunch-live.mjs). Skipped while the owner's own VS Code runs: the runner never quits it.
// Cards: sleight's consent cards are the only human steps. The runner never clicks them. Each card is announced on stdout
// and in <out>/CARD.json (what to click, where, and by when), and every card's latency lands in summary.json.
// Cleanup ends only what this run launched. A cleanup it cannot confirm keeps the live lock and stops the run.
import { execFile } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { APPS, HOLD, LOCK, RELAUNCH_CELLS, relaunchCellsFor, runQualification, scrubReceipt, waitForHold } from './electron-qualification.mjs';
import { createRunReaper, resolveRunPython } from './electron-run-cleanup.mjs';
import { withQualificationDiagnostics } from './electron-diagnostics.mjs';
import { createRunRoot, listProcesses, turboAcceptance } from './electron-qualification-live.mjs';
import { cancellableDriver, checkRunSignal, installRunCancellation, settleRunOperation } from './electron-run-cancellation.mjs';

const execute = promisify(execFile);
const ARM_SERVER = fileURLToPath(new URL('./electron-arm-server.mjs', import.meta.url));
export const PHASES = Object.freeze(['qualify', 'arm', 'relaunch']);
// The consent card's own deadline (electron-consent ttlMs). A later click is refused by the card itself.
export const CARD_WINDOW_MS = 120000;
// The live order runs host-loss on the app the relaunch reopened, before the stand-in for the owner's Quit, so one
// relaunch card covers every cell. The fake order in RELAUNCH_CELLS reopens the app for host-loss instead.
export const LIVE_RELAUNCH_ORDER = Object.freeze(['relaunch-card', 'relaunch-quit', 'relaunch-unsaved', 'relaunch-pipe', 'relaunch-background',
  'relaunch-restore', 'relaunch-reuse', 'relaunch-host-loss', 'relaunch-user-quit']);
export const liveRelaunchCells = app => LIVE_RELAUNCH_ORDER.map(id => relaunchCellsFor(app).find(cell => cell.id === id)).filter(Boolean);
// Expected wall time per phase, without card waits (estimates; summary.json records the measured ones).
export const EXPECTED_MS = Object.freeze({ qualify: 15 * 60000, arm: 5 * 60000, relaunch: 5 * 60000 });
// The cards each phase shows, from the worker's consent rules: a new worker or process asks, a reconnect in the same worker
// reuses its session grant, and an Always record (persistent profiles only) answers later debugger cards by itself.
export const EXPECTED_CARDS = Object.freeze({
  qualify: ['Allow this session (first launch)', 'Allow this session (after Disconnect)', 'Allow this session (new worker after the kill)', 'Allow this session (host-kill instance)'],
  arm: ['Allow this session (the arm\'s worker)'],
  relaunch: ['Always allow (debugger, the delegated click)', 'Quit and reopen (relaunch)'],
});

export function parseRunnerArgs(argv) {
  const out = { phases: [...PHASES], out: undefined, consentWaitMs: CARD_WINDOW_MS, model: 'claude-haiku-5-5', effort: 'high', samples: 20, trials: 10,
    aliveWaitMs: 60000, armTimeoutMs: 15 * 60000, mode: undefined };
  const numbers = { '--consent-wait-ms': 'consentWaitMs', '--samples': 'samples', '--trials': 'trials', '--alive-wait-ms': 'aliveWaitMs', '--arm-timeout-ms': 'armTimeoutMs' };
  let dry = false, away = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = argv[i + 1];
    if (arg === '--dry-run') { dry = true; continue; }
    if (arg === '--owner-away') { away = true; continue; }
    if (!(arg in numbers) && !['--phases', '--out', '--model', '--effort'].includes(arg) || value === undefined || value.startsWith('--')) throw Error('INVALID_OPTIONS');
    i++;
    if (arg === '--phases') {
      out.phases = value.split(',');
      if (!out.phases.length || out.phases.some(p => !PHASES.includes(p))) throw Error('UNKNOWN_PHASE');
      out.phases = PHASES.filter(p => out.phases.includes(p));
    } else if (arg === '--out') out.out = value;
    else if (arg === '--model') { if (!/^claude-[a-z0-9-]+$/.test(value)) throw Error('INVALID_OPTIONS'); out.model = value; }
    else if (arg === '--effort') { if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw Error('INVALID_OPTIONS'); out.effort = value; }
    else { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw Error('INVALID_OPTIONS'); out[numbers[arg]] = n; }
  }
  if (dry && away) throw Error('CONFLICTING_MODE');
  if (!dry && !away) throw Error('OWNER_AWAY_REQUIRED: the run shows VS Code windows and sleight\'s cards; pass --owner-away in the away window, or --dry-run');
  if (out.consentWaitMs > CARD_WINDOW_MS) throw Error('CONSENT_WAIT_TOO_LONG: the card refuses a click after 120 s');
  out.mode = dry ? 'dry-run' : 'live';
  return out;
}

// ---- preflight: every check reads only. A problem stops the run before anything launches; a skip drops one phase.
export async function preflight({ phases, io }) {
  const problems = [], skips = {}, app = APPS.vscode;
  if (io.platform !== 'darwin') problems.push('MACOS_REQUIRED');
  if (!io.exists(app.path)) problems.push(`APP_MISSING: ${app.path}`);
  try {
    if (!await io.turboInstalled()) problems.push('TURBO_NOT_INSTALLED: sleight-mcp turbo on first (the worker builds its native helpers from it)');
  } catch (error) { problems.push(`TURBO_PREFLIGHT: ${error.message}`); }
  if (!io.exists(io.inspector)) problems.push('PERMISSION_OBSERVER_MISSING: codex-macos-inspect');
  if (phases.includes('arm') && !io.exists(io.armClaude)) problems.push(`ARM_MISSING: ${io.armClaude}`);
  if (phases.includes('relaunch')) {
    const running = await io.ownerCopies(app.bundleId);
    if (running.length) skips.relaunch = `OWNER_APP_RUNNING: ${running.length} VS Code process(es) of the owner; the relaunch cells need it closed, and the runner never quits it`;
    else if (await io.quarantined(app.path)) skips.relaunch = 'SOURCE_QUARANTINED: the installed VS Code carries a quarantine flag';
  }
  return { ok: problems.length === 0, problems, skips };
}

// ---- cards
export function parseCardLog(text) {
  return String(text).split('\n').flatMap(line => { try { const e = JSON.parse(line); return e && typeof e.id === 'string' && ['requested', 'shown', 'answered'].includes(e.event) ? [e] : []; } catch { return []; } });
}
/** The owner delegated these Sleight cards on benchmark VS Code copies (LAWS 2026-10-19). */
export function cardInstruction(event) {
  const note = 'The owner delegated this Sleight card on benchmark VS Code copies to sleight-arch (LAWS, 2026-10-19).';
  return { click: event.kind === 'relaunch' ? 'Quit and reopen' : event.temporary ? 'Allow this session' : 'Always allow', delegated: true, note };
}
const center = r => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
/** Existing host-window and AX-button observations, including the styled modal panel. Menu locations are fallback only. */
export function locateCard(geometry, click) {
  const windows = (geometry?.windows ?? []).filter(w => w.onScreen && w.width > 0 && w.height > 0), buttons = geometry?.buttons ?? [];
  const glove = windows.filter(w => w.layer === 25).sort((a, b) => b.x - a.x)[0];
  const menu = windows.find(w => w.layer === 101);
  const matches = buttons.filter(b => b.title === click), button = matches.length === 1 ? matches[0] : null;
  const contains = w => button && (button.pid === undefined || w.pid === undefined || button.pid === w.pid) &&
    button.x >= w.x && button.y >= w.y && button.x + button.width <= w.x + w.width && button.y + button.height <= w.y + w.height;
  const candidates = windows.filter(w => w.layer >= 0 && w.layer < 25 && w.width >= 200);
  const alert = candidates.sort((a, b) => Number(!!contains(b)) - Number(!!contains(a)) ||
    Number(b.layer === 8) - Number(a.layer === 8) || a.width * a.height - b.width * b.height)[0];
  const review = buttons.find(b => b.title === 'Review sleight request');
  return { glove: glove ? center(glove) : null, menu: menu ? { x: menu.x, y: menu.y, width: menu.width, height: menu.height } : null,
    review: review ? center(review) : null, alert: alert ? { x: alert.x, y: alert.y, width: alert.width, height: alert.height } : null,
    button: button && alert && contains(alert) && geometry?.ax === true ? center(button) : null, ax: geometry?.ax === true };
}
/** The consent hosts under this run: processes named consent-host whose parent chain reaches rootPid. */
export function consentHostPids(rows, rootPid) {
  const parent = new Map(rows.map(r => [r.pid, r.ppid]));
  const under = pid => { for (let p = pid, n = 0; p && n < 64; p = parent.get(p), n++) if (p === rootPid) return true; return false; };
  return rows.filter(r => /(^|\/)consent-host$/.test(r.args.split(' ')[0]) && under(r.pid)).map(r => r.pid);
}
export function parseTree(stdout) {
  return String(stdout).split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(([, pid, ppid, args]) => ({ pid: +pid, ppid: +ppid, args: args.trim() }));
}
const iso = ms => new Date(ms).toISOString();
const where = (loc, click) => loc.button ? `Click "${click}" in the automatic card at (${loc.button.x}, ${loc.button.y}).` :
  'The card opens automatically. Request waiting; visibility is not confirmed. As a fallback, open ' + [
  loc.glove ? `the sleight glove in the menu bar at (${loc.glove.x}, ${loc.glove.y})` : 'the sleight glove in the menu bar (not located yet)',
  loc.review ? `"Review sleight request" at (${loc.review.x}, ${loc.review.y})` : '"Review sleight request" (the first row of its menu)',
  loc.button ? `"${click}" at (${loc.button.x}, ${loc.button.y})` : `"${click}" in the card that opens${loc.alert ? ` (card window at ${loc.alert.x}, ${loc.alert.y}, ${loc.alert.width} x ${loc.alert.height})` : ''}`,
].join(', then ');

export function createCardWatcher({ cardLog, outDir, read = path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } }, locate = async () => null,
  write = (path, text) => writeFileSync(path, text), remove = path => rmSync(path, { force: true }), log = console.log, now = Date.now }) {
  const cards = [], pending = new Map(), matchingObservations = [];
  let previousMatches = new Set();
  let consumed = 0;
  const cardFile = join(outDir, 'CARD.json');
  function refresh(card, geometry, seen) {
    const loc = locateCard(geometry, card.click);
    if (loc.ax && loc.alert && loc.button) {
      const key = JSON.stringify({ label: card.click, location: loc });
      if (!seen.has(key) && !previousMatches.has(key)) {
        matchingObservations.push({ observedAt: iso(now()), matchingButton: card.click, location: loc, correlation: 'uncorrelated' });
        log(`MATCHING CARD (uncorrelated request): ${where(loc, card.click)}`);
      }
      seen.add(key);
    }
    const left = Math.max(0, Math.round((card.deadlineAt - now()) / 1000));
    write(cardFile, JSON.stringify({ n: card.n, kind: card.kind, app: card.app, requestedAt: iso(card.requestedAt),
      answerBy: iso(card.deadlineAt), secondsLeft: left,
      click: card.click, delegated: card.delegated, note: card.note, steps: where(loc, card.click),
      location: loc, locationCorrelation: 'uncorrelated' }, null, 2) + '\n');
    return loc;
  }
  async function poll() {
    const events = parseCardLog(read(cardLog));
    for (const e of events.slice(consumed)) {
      // Legacy 'shown' was emitted before requesting native UI. Preserve the original event without upgrading its evidence.
      if (e.event === 'requested' || e.event === 'shown') {
        if (cards.some(card => card.id === e.id)) continue;
        const card = { n: cards.length + 1, id: e.id, kind: e.kind, app: e.app, temporary: e.temporary === true,
          sourceEvent: e.event, ...(e.event === 'shown' && { legacyShownAt: e.at }), requestedAt: e.requestedAt ?? e.at,
          deadlineAt: e.deadlineAt ?? e.at + CARD_WINDOW_MS,
          ...cardInstruction(e), status: 'pending' };
        cards.push(card); pending.set(e.id, card);
        log(`CARD ${card.n} (${card.kind}, ${card.app}) requested ${iso(card.requestedAt)}; answer by ${iso(card.deadlineAt)}. ${where(locateCard(null, card.click), card.click)} ${card.note}`);
      } else {
        const card = pending.get(e.id);
        if (!card) continue;
        pending.delete(e.id);
        Object.assign(card, { status: e.status, scope: e.scope ?? null, answeredAt: e.at, latencyMs: e.at - card.requestedAt,
          inTime: e.status === 'granted' && e.at <= card.deadlineAt });
        if (!pending.size) remove(cardFile);
        log(`CARD ${card.n} answered: ${e.status}${e.scope ? ` (${e.scope})` : ''} after ${(card.latencyMs / 1000).toFixed(1)} s`);
      }
    }
    consumed = events.length;
    // Process the complete log batch before observing current UI. A current panel cannot identify a historical request.
    let geometry = null;
    if (pending.size) { try { geometry = await locate(); } catch {} }
    const seen = new Set();
    for (const card of pending.values()) refresh(card, geometry, seen);
    previousMatches = seen;
  }
  const summary = () => cards.map(({ lastKey, announced, ...card }) => ({ ...card, requestedAt: iso(card.requestedAt),
    ...(card.legacyShownAt !== undefined && { legacyShownAt: iso(card.legacyShownAt) }), deadlineAt: iso(card.deadlineAt),
    ...(card.answeredAt ? { answeredAt: iso(card.answeredAt) } : {}) }));
  return { poll, cards, summary, observations: () => structuredClone(matchingObservations), pending: () => pending.size };
}

// ---- the arm
export const ARM_ALLOWED = ['browser_open', 'browser_read', 'browser_act', 'browser_fill', 'browser_tabs'].map(name => 'mcp__sleight-electron__' + name);
export function armPrompt({ marker, skill = '' }) {
  return `${skill ? skill + '\n\n' : ''}Visual Studio Code is open with a folder of fixture files. Use only the browser_* tools: browser_tabs list shows its ` +
    `window as a tab labelled Visual Studio Code. Do these three tasks in order:\n` +
    `1. Open b-big.txt and report its last line.\n` +
    `2. Open a-scratch.txt, type exactly ${marker} into it, and save it.\n` +
    `3. Open a-notes.md and report its top-level heading.\n` +
    `End your answer with three lines: "RESULT1: <last line of b-big.txt>", "RESULT2: done", "RESULT3: <heading>".`;
}
export function parseStream(stdout) {
  let result, tools = {};
  for (const line of String(stdout).split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === 'assistant') for (const block of e.message?.content ?? []) if (block?.type === 'tool_use') tools[block.name] = (tools[block.name] ?? 0) + 1;
    if (e?.type === 'result') result = e;
  }
  return { text: typeof result?.result === 'string' ? result.result : '', isError: result ? result.is_error === true : true, durationMs: result?.duration_ms ?? null,
    turns: result?.num_turns ?? null, toolCalls: tools, model: result?.modelUsage ? Object.keys(result.modelUsage) : null };
}
export function gradeArm({ text, scratch, marker }) {
  const line = n => new RegExp(`^RESULT${n}:\\s*(.*)$`, 'mi').exec(text)?.[1]?.trim() ?? '';
  const tasks = [
    { id: 'read-last-line', pass: /\bline 1500\b/i.test(line(1)), got: line(1).slice(0, 80) },
    { id: 'type-and-save', pass: String(scratch).includes(marker), got: String(scratch).slice(0, 80) },
    { id: 'read-heading', pass: /^#?\s*notes\b/i.test(line(3)), got: line(3).slice(0, 80) },
  ];
  return { tasks, passed: tasks.filter(t => t.pass).length, pass: tasks.every(t => t.pass) };
}

// ---- phases
const phaseRecord = (id, started, now, rest) => ({ id, startedAt: iso(started), ms: now() - started, ...rest });
function receiptPath(dir, receipt, key) { return join(dir, `${key}-${receipt.kind === 'electron-relaunch' ? 'relaunch-' : ''}${receipt.mode}-${receipt.at.replace(/[:.]/g, '-')}.json`); }
export function writeReceipt(dir, receipt, key) {
  mkdirSync(dir, { recursive: true });
  const path = receiptPath(dir, receipt, key);
  writeFileSync(path, JSON.stringify(scrubReceipt(receipt), null, 2) + '\n');
  return path;
}

/** Runs the chosen phases in order under one lock. deps supplies each phase (live or fake) and the run's io. */
export async function runPhases({ options, deps }) {
  const { log, now, sleep, io } = deps, app = APPS.vscode, phases = [], started = now();
  const signal = deps.signal, lifecycle = deps.lifecycle ?? { cleanupAllowed: true };
  const watcher = deps.watcher;
  const pump = deps.pump ?? (async work => {
    let done = false;
    const loop = (async () => { while (!done) { await watcher.poll().catch(() => {}); await sleep(500); } })();
    try { return await work; } finally { done = true; await loop; await watcher.poll().catch(() => {}); }
  });
  let check, held = 0, release, keep = false, cleanup, interrupted = false;
  try {
    checkRunSignal(signal);
    check = await deps.preflight({ phases: options.phases, io }); checkRunSignal(signal);
    for (const p of check.problems) log(`preflight: ${p}`);
    if (!check.ok) return { code: 2, summary: { version: 1, kind: 'electron-live-run', mode: options.mode, at: iso(started), preflight: check, phases: [], cards: [] } };
    const expected = options.phases.filter(id => !check.skips[id]).flatMap(id => EXPECTED_CARDS[id].map(card => `${id}: ${card}`));
    log(`cards to click, in order (each within 120 s of its CARD line): ${expected.join('; ')}`);
    held += await waitForHold(io, { now, sleep }, 30000, signal); checkRunSignal(signal);
    release = await deps.lock(signal); checkRunSignal(signal);
    for (const id of options.phases) {
      checkRunSignal(signal);
      if (check.skips[id]) { log(`${id}: skipped, ${check.skips[id]}`); phases.push({ id, status: 'skipped', reason: check.skips[id] }); continue; }
      held += await waitForHold(io, { now, sleep }, 30000, signal); checkRunSignal(signal);
      const t = now();
      log(`${id}: started ${iso(t)} (expected about ${Math.round(EXPECTED_MS[id] / 60000)} min plus card waits)`);
      let record;
      try {
        const r = await pump(settleRunOperation(Promise.resolve().then(() => { checkRunSignal(signal); return deps[id]({ app, options, signal, lifecycle }); }),
          { signal, lifecycle, graceMs: deps.cancelWaitMs ?? 60_000 }));
        record = phaseRecord(id, t, now, r);
        if (signal?.aborted) { interrupted = true; record.interrupted = true; record.status = 'interrupted'; }
      } catch (error) { record = phaseRecord(id, t, now, { status: 'fail', error: String(error?.message ?? error).slice(0, 300), cleanup: { confirmed: false } }); }
      phases.push(record);
      record.error ??= record.failed?.[0];
      log(`${id}: ${record.status} in ${(record.ms / 60000).toFixed(1)} min${record.error ? `, ${record.error}` : ''}${record.receipt ? ` (${record.receipt})` : ''}`);
      if (record.cleanup?.confirmed !== true) { keep = true; log(`${id}: cleanup unconfirmed; the run stops and keeps ${LOCK}`); break; }
      if (record.status === 'fail') { log(`${id}: failed; later phases do not run`); break; }
      if (record.stopped) { log(`${id}: stopped (${record.stopped}); later phases do not run`); break; }
      if (signal?.aborted) { interrupted = true; break; }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
    interrupted = true;
  } finally {
    interrupted ||= signal?.aborted === true;
    if (release && !keep && lifecycle.cleanupAllowed && deps.cleanup) {
      try { cleanup = await settleRunOperation(deps.cleanup(), { signal, lifecycle, graceMs: deps.cancelWaitMs ?? 60_000 }); }
      catch { cleanup = { confirmed: false, errors: ['RUN_PROCESS_CENSUS_FAILED'] }; }
      if (cleanup.confirmed !== true) keep = true;
    }
    if (!lifecycle.cleanupAllowed) keep = true;
  }
  interrupted ||= signal?.aborted === true;
  const cards = watcher.summary();
  const matchingCardObservations = watcher.observations?.() ?? [];
  const summary = { version: 1, kind: 'electron-live-run', mode: options.mode, at: iso(started), ms: now() - started, heldMs: held, build: deps.build?.() ?? null,
    model: { id: options.model, effort: options.effort }, preflight: check, phases, cards, matchingCardObservations,
    ...(interrupted ? { interrupted: true, qualified: false } : {}), ...(lifecycle.unsettled ? { unsettled: true } : {}), ...(cleanup ? { cleanup } : {}),
    ownership: { lock: release ? keep ? 'retained' : 'release-after-terminal-save' : 'not-acquired',
      ...(lifecycle.effectUnknown ? { effectUnknown: true } : {}), ...(lifecycle.modelGroup ? { modelGroup: lifecycle.modelGroup } : {}) },
    clicks: { total: cards.length, requested: cards.length, matchingCardObservations: matchingCardObservations.length,
      accepted: cards.filter(c => c.status === 'granted').length,
      delegated: cards.filter(c => c.delegated).length, late: cards.filter(c => c.status !== 'pending' && !c.inTime).length,
      unanswered: cards.filter(c => c.status === 'pending' || c.status === 'timeout').length } };
  await deps.publish?.(summary);
  if (release && !keep && lifecycle.cleanupAllowed) await release();
  const pass = phases.length > 0 && phases.every(p => p.status === 'pass' || p.status === 'skipped') && !keep;
  return { code: interrupted ? 130 : pass ? 0 : 1, summary, keep, ...(lifecycle.unsettled ? { unsettled: true } : {}) };
}

// ---- live phases
async function livePhases({ options, root, out, cardLog, exec, python, qualificationDiagnosticPath, signal, lifecycle, qualificationCells }) {
  const { liveRuntime, liveDriver } = await import('./electron-qualification-live.mjs');
  const { observePermission } = await import('./real-permission.mjs');
  const permission = () => observePermission({ stopOnLiveHold: false });
  const io = { exists: existsSync, permission };
  const clock = { now: Date.now, sleep: ms => delay(ms) };
  const runOptions = { trials: options.trials, samples: options.samples, aliveWaitMs: options.aliveWaitMs, consentWaitMs: options.consentWaitMs, mode: 'live', signal, lifecycle };
  return {
    async qualify({ app }) {
      const runtime = await liveRuntime(options, { io, clock, root, python, lifecycle, signal });
      try {
        const driver = runtime.driverFor(app, { cardLog, qualificationDiagnosticPath, lifecycle, signal });
        const receipt = await runQualification({ app, driver, observer: runtime.observer, io, clock, cells: qualificationCells, options: runOptions });
        if (qualificationCells) {
          receipt.diagnosticOnly = true;
          receipt.qualified = false;
          receipt.validation.unqualified.push('DIAGNOSTIC_SUBSET');
        }
        return { status: receipt.qualified ? 'pass' : 'fail', receipt: writeReceipt(out, receipt, app.key), qualified: receipt.qualified,
          cells: `${receipt.cells.filter(c => c.status === 'pass').length}/${receipt.cells.length}`, failed: receipt.cells.filter(c => c.status === 'fail').map(c => `${c.id}: ${c.error}`),
          cleanup: receipt.cleanup, ...(receipt.stopped ? { stopped: receipt.stopped.reason } : {}) };
      } finally { if (lifecycle.cleanupAllowed) await runtime.close(); }
    },
    async arm({ app }) {
      const { worldAgentSetup } = await import('./world/arms/browser.mjs');
      const { runOwned } = await import('./preapproved-process.mjs');
      const { randomBytes } = await import('node:crypto');
      const { createArmCancellation, runArmWithCancellation } = await import('./electron-arm-cancellation.mjs');
      const base = mkdtempSync(join(root, 'arm-')), armDir = join(base, 'claude');
      mkdirSync(armDir);
      const driver = cancellableDriver(liveDriver(app, { root: base, exec, observer: null, cardLog, python, qualificationDiagnosticPath, lifecycle, signal }), signal);
      let result, grade, cleanup, failure;
      try {
        await driver.prepare();
        const config = { ...driver.armConfig(), cancelNonce: randomBytes(32).toString('hex') }, configPath = join(config.stateDir, 'arm.json');
        const control = createArmCancellation(config);
        writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
        const marker = 'arm' + Math.random().toString(36).slice(2, 8);
        const skill = readFileSync(new URL('../plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md', import.meta.url), 'utf8').trimEnd()
          .replace('{browser}', 'bbench').replace('{application}', ` (${app.name})`);
        const prompt = armPrompt({ marker, skill });
        const setup = worldAgentSetup({ surface: 'sleight', dir: armDir });
        const mcpPath = join(armDir, 'mcp.json'), settingsPath = join(armDir, 'settings.json');
        writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'sleight-electron': { command: process.execPath, args: [ARM_SERVER],
          env: { SLEIGHT_EQ_ARM_CONFIG: configPath, SLEIGHT_EQ_ARM_TASK: prompt.split('\n').slice(-5).join('\n') } } } }));
        writeFileSync(settingsPath, JSON.stringify(setup.settings));
        const args = [...setup.args, '-p', '--model', options.model, '--effort', options.effort, '--permission-mode', 'default', '--output-format', 'stream-json', '--verbose',
          '--strict-mcp-config', '--mcp-config', mcpPath, '--settings', settingsPath, '--allowedTools', ARM_ALLOWED.join(','), '--tools', '', '--no-chrome', prompt];
        const t = Date.now();
        // The first tool call waits on the card and the launch, so Claude Code's tool timeout must outlast both.
        const run = await runArmWithCancellation(modelSignal => runOwned(setup.command, args, { cwd: armDir, env: { ...setup.env, ANTHROPIC_SMALL_FAST_MODEL: options.model, MCP_TOOL_TIMEOUT: '600000' },
          timeoutMs: options.armTimeoutMs, signal: modelSignal }), { control, signal, lifecycle });
        result = { ...parseStream(run.stdout), wallMs: Date.now() - t, exit: run.exit, timedOut: run.timedOut };
        const startupPath = join(config.stateDir, 'startup.jsonl');
        if (existsSync(startupPath)) result.startup = readFileSync(startupPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        writeFileSync(join(out, `arm-${iso(t).replace(/[:.]/g, '-')}.jsonl`), String(scrubReceipt(run.stdout)));
        grade = gradeArm({ text: result.text, scratch: driver.readFile('a-scratch.txt'), marker });
      } catch (error) { failure = /^[A-Z][A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'ARM_FAILED'; }
      finally {
        if (lifecycle.cleanupAllowed) {
          cleanup = await driver.cleanup().catch(error => ({ confirmed: false, error: error.message }));
          if (cleanup.confirmed && lifecycle.cleanupAllowed) rmSync(base, { recursive: true, force: true });
        } else cleanup = { confirmed: false, error: 'RUN_CANCELLATION_UNSETTLED' };
      }
      return { status: grade?.pass && !result?.isError ? 'pass' : 'fail', model: options.model, effort: options.effort, result: scrubReceipt({ ...result, text: result?.text?.slice(-600) }),
        ...(failure ? { error: failure } : {}),
        ...(result?.startup?.length ? { error: `arm startup (${result.startup[0].stage}): ${result.startup[0].code}` } : {}), grade, cleanup: scrubReceipt(cleanup) };
    },
    async relaunch({ app }) {
      const { liveRelaunchDriver } = await import('./electron-relaunch-live.mjs');
      const observerRuntime = await liveRuntime(options, { io, clock, root, python, lifecycle, signal });
      try {
        const driver = liveRelaunchDriver(app, { root, io, cardLog, python, qualificationDiagnosticPath, signal, lifecycle });
        const receipt = await runQualification({ app, driver, observer: observerRuntime.observer, io, clock, cells: liveRelaunchCells(app), options: { ...runOptions, relaunch: true } });
        // Honest labels: the relaunch ran on the runner's clone with its own portable profile, never the owner's app or profile.
        receipt.profile = { ...receipt.profile, copy: 'benchmark clone with its own portable profile', owners: false };
        return { status: receipt.qualified ? 'pass' : 'fail', receipt: writeReceipt(out, receipt, app.key), qualified: receipt.qualified,
          cells: `${receipt.cells.filter(c => c.status === 'pass').length}/${receipt.cells.length}`, failed: receipt.cells.filter(c => c.status === 'fail').map(c => `${c.id}: ${c.error}`),
          cleanup: receipt.cleanup, ...(receipt.stopped ? { stopped: receipt.stopped.reason } : {}) };
      } finally { if (lifecycle.cleanupAllowed) await observerRuntime.close(); }
    },
  };
}

async function liveIo(exec) {
  const { homedir } = await import('node:os');
  return {
    platform: process.platform, exists: existsSync, inspector: join(homedir(), '.codex/bin/codex-macos-inspect'),
    armClaude: join(homedir(), '.config/sleight-bench/world/arms/sleight/node_modules/.bin/claude'),
    turboInstalled: () => turboAcceptance(),
    async ownerCopies(bundle) { const { helper } = await import('./electron-qualification-live.mjs'); return (await helper({ mode: 'pids', bundle }, exec)).pids; },
    quarantined: path => exec('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path], { timeout: 5000 }).then(() => true, () => false),
    permission: async () => (await import('./real-permission.mjs')).observePermission({ stopOnLiveHold: false }),
  };
}

export async function runMain(argv, deps = {}, qualificationDiagnosticPath) {
  const options = parseRunnerArgs(argv), log = deps.log ?? console.log, exec = deps.exec ?? execute;
  const signal = deps.signal, lifecycle = deps.lifecycle ?? { cleanupAllowed: true }, started = Date.now();
  const out = resolve(options.out ?? fileURLToPath(new URL(`./results/electron/${new Date().toISOString().slice(0, 10)}/`, import.meta.url)));
  mkdirSync(out, { recursive: true });
  const root = (deps.createRoot ?? createRunRoot)('elr-'), cardLog = join(root, 'cards.jsonl');
  writeFileSync(cardLog, '', { mode: 0o600 });
  let result, savedPath;
  const publish = async summary => {
    const path = join(out, `live-run-${summary.at.replace(/[:.]/g, '-')}.json`), row = scrubReceipt(summary);
    if (deps.writeSummary) await deps.writeSummary(path, row);
    else {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(row, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      const directory = openSync(out, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    savedPath = path;
  };
  try {
    if (options.mode === 'dry-run') {
      const { fakeRunnerDeps } = await import('./electron-live-runner-fakes.mjs');
      result = await runPhases({ options, deps: { ...fakeRunnerDeps({ cardLog, out, qualificationCells: deps.qualificationCells }), log, signal, lifecycle, publish } });
    } else {
      checkRunSignal(signal);
      const python = await (deps.resolvePython ?? resolveRunPython)('python3', { exec }); checkRunSignal(signal);
      const io = { ...await liveIo(exec), ...deps.io };
      const watcher = createCardWatcher({ cardLog, outDir: out, log, locate: async () => {
        const { helper } = await import('./electron-qualification-live.mjs');
        const pids = consentHostPids(parseTree((await exec('/bin/ps', ['-axww', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='], { timeout: 10000, maxBuffer: 32 << 20 })).stdout), process.pid);
        return pids.length ? helper({ mode: 'card', pids }, exec) : null;
      } });
      const { acquireLiveLock } = await import('./live-lock.mjs');
      const commit = await exec('/usr/bin/git', ['-C', fileURLToPath(new URL('..', import.meta.url)), 'rev-parse', 'HEAD'], { timeout: 5000 }).then(r => r.stdout.trim(), () => null);
      result = await runPhases({ options, deps: { log, now: Date.now, sleep: ms => delay(ms), io, watcher, preflight, build: () => ({ commit }), signal, lifecycle, publish,
        lock: signal => acquireLiveLock(LOCK, { wait: true, interval: 15000, signal }),
        cleanup: () => createRunReaper(root, { python, list: () => listProcesses(exec), lifecycle }).reap(), ...await livePhases({ options, root, out, cardLog, exec, python, qualificationDiagnosticPath, signal, lifecycle, qualificationCells: deps.qualificationCells }), ...deps.phases } });
    }
  } catch {
    result = { code: signal?.aborted ? 130 : 1, keep: true, ...(lifecycle.unsettled ? { unsettled: true } : {}),
      summary: { version: 1, kind: 'electron-live-run', mode: options.mode, at: iso(started), phases: [], cards: [],
        ...(signal?.aborted ? { interrupted: true, qualified: false } : {}), error: signal?.aborted ? 'RUN_INTERRUPTED' : 'RUN_FAILED',
        cleanup: { confirmed: false }, retainedRoot: root } };
  }
  try {
    if (!savedPath) await publish(result.summary);
    log(`summary: ${savedPath}`);
    for (const p of result.summary.phases) log(`  ${p.id}: ${p.status}${p.cells ? ` (${p.cells} cells)` : ''}${p.grade ? ` (${p.grade.passed}/3 arm tasks)` : ''}`);
    const c = result.summary.clicks;
    if (c) log(`  cards: ${c.requested} requested, ${c.matchingCardObservations} uncorrelated matching-card observations, ${c.accepted} accepted, ${c.late} answered late or refused, ${c.unanswered} unanswered`);
  } finally {
    if (result && savedPath && !result.keep && lifecycle.cleanupAllowed) rmSync(root, { recursive: true, force: true });
    else log(`run folder kept for the leftovers: ${root}`);
  }
  return result;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseRunnerArgs(argv);
  const cancellation = installRunCancellation({ events: deps.signals ?? process });
  const lifecycle = deps.lifecycle ?? { cleanupAllowed: true };
  const scoped = { ...deps, lifecycle, signal: deps.signal ?? cancellation.signal }; let result;
  try {
    if (options.mode === 'dry-run') result = await runMain(argv, scoped);
    else {
      const out = resolve(options.out ?? fileURLToPath(new URL(`./results/electron/${new Date().toISOString().slice(0, 10)}/`, import.meta.url)));
      result = await withQualificationDiagnostics(out, path => runMain(argv, scoped, path));
    }
    return result.code;
  } finally {
    // An unsettled worker/IPC operation may still own handles; returning a summary is not an exit proof.
    if (result && !result.unsettled && lifecycle.cleanupAllowed) cancellation.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
export { HOLD, RELAUNCH_CELLS };
