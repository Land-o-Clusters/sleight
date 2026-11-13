#!/usr/bin/env node
// Bounded GLC1 information sitting. run.mjs is launched, never imported.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armCommand, sourceIdentity } from '../bench/runtime-arm.mjs';
import { observePermission } from '../bench/real-permission.mjs';
import { prepareGlide, glidePreparationSummary, glideBuildCheck, glideBuildSummary } from '../bench/glide-preflight.mjs';
import { loadReceipt, loadWarnings, loadSummary } from '../bench/load.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function proofPlan({ popupSmoke = false } = {}) {
  if (popupSmoke) return [{ task: 'calculator-popup-smoke', run: 1, runtime: 'own', popupSmoke: true,
    runNonce: 'gls2d-popup-smoke' }];
  return Array.from({ length: 3 }, (_, i) => ['calculator-click', 'calculator-menu'].flatMap(task =>
    (i % 2 ? ['own', 'engine'] : ['engine', 'own']).map(runtime => ({ task, run: i + 1, runtime,
      runNonce: `glc1-r${i + 1}-${runtime}-${task}` })))).flat();
}
export function proofCommand(row, options = {}) {
  return armCommand(row, { ...options, env: { ...(options.env ?? process.env),
    SLEIGHT_CALCULATOR_POPUP_SMOKE: row.popupSmoke ? '1' : '0' } });
}
// Hygiene lists every window that appeared during the pass, the person's own apps included
// (on 2026-11-08 Chrome, Passwords and Helium each opened a 66x20 window mid-run and were kept).
// Only windows the run owns stop the sitting: a quit or dialog failure (it carries a reason or
// dialog flag) or a window of an app the attempt launched as its fixture.
export function ownLeftWindows(result, rows = []) {
  const fixtures = new Set(rows.flatMap(row => (row.fixtureDiagnostics ?? []).map(item => item.bundle).filter(Boolean)));
  return (result?.leftWindows ?? []).filter(window => window.reason || window.dialog || fixtures.has(window.bundle));
}
export function proofExitCode(report) {
  return report.stopped || report.results.some(attempt => attempt.code !== 0 ||
    attempt.result?.results?.some(row => row.passed === false)) ? 1 : 0;
}
export async function proofPreflight(ownerAwayFile, { exists = existsSync, observe = observePermission } = {}) {
  if (!ownerAwayFile || !exists(ownerAwayFile)) throw Error('OWNER_AWAY_REQUIRED');
  if (exists('/tmp/sleight-hold')) throw Error('LIVE_HOLD');
  if (exists('/tmp/sleight-live.lock')) throw Error('LIVE_LOCK_RETAINED');
  const dialog = await observe({ stopOnLiveHold: true });
  if (dialog) throw Error(`SYSTEM_DIALOG: ${dialog.process} ${dialog.title}`);
}
async function attempt(row, out, ownerAwayFile) {
  const name = `r${row.run}-${row.runtime}-${row.task}`, dir = join(out, name);
  mkdirSync(dir, { mode: 0o700 });
  const log = join(dir, 'command.log'), fd = openSync(log, 'wx', 0o600);
  const command = proofCommand(row, { root, env: { ...process.env,
    CLAUDE_CONFIG_DIR: mkdtempSync('/tmp/lane-claude-'),
  } });
  let cancelled = false, child, monitor;
  // The child shares this terminal's process group and receives its Ctrl-C.
  // Keep the parent alive to collect that same child and preserve the receipt.
  const interrupt = () => { cancelled = true; };
  process.on('SIGINT', interrupt);
  let status;
  try {
    status = await new Promise((accept, reject) => {
      child = spawn('/usr/bin/nice', ['-n', '20', command.command, ...command.args], {
        cwd: root, env: command.env, stdio: ['ignore', fd, fd],
      });
      monitor = setInterval(() => {
        if (!cancelled && (!existsSync(ownerAwayFile) || existsSync('/tmp/sleight-hold'))) {
          cancelled = true; child.kill('SIGINT');
        }
      }, 250);
      child.once('error', reject);
      child.once('close', (code, signal) => accept({ code, signal, pid: child.pid }));
    });
  } finally { clearInterval(monitor); closeSync(fd); process.off('SIGINT', interrupt); }
  const output = readFileSync(log, 'utf8'), saved = /^results: (.+\.json)$/m.exec(output)?.[1];
  let result;
  if (saved && dirname(resolve(saved)) === join(root, 'bench/results')) {
    result = JSON.parse(readFileSync(saved, 'utf8')); copyFileSync(saved, join(dir, 'result.json'));
  }
  const record = { ...row, ...status, cancelled, log, resultFile: saved, result };
  writeFileSync(join(dir, 'attempt.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  return record;
}
export async function runProof({ ownerAwayFile, out, popupSmoke = false }, { preflight = proofPreflight, prepare = prepareGlide, execute = attempt } = {}) {
  const report = { kind: 'information-only', plan: proofPlan({ popupSmoke }), results: [] };
  const controller = new AbortController(), interrupt = () => controller.abort(Error('CANCELLED'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    for (const row of report.plan) {
      try {
        controller.signal.throwIfAborted();
        await preflight(ownerAwayFile);
        if (!report.glidePreparation) {
          report.glidePreparation = await prepare({ signal: controller.signal });
          for (const line of glidePreparationSummary(report.glidePreparation)) console.log(line);
          if (report.glidePreparation.status !== 'ready') throw Error('GLIDE_PREPARATION_UNAVAILABLE');
          // Preparation may take minutes. Refresh the owner and permission gates.
          controller.signal.throwIfAborted();
          await preflight(ownerAwayFile);
        }
        const result = await execute(row, out, ownerAwayFile); report.results.push(result);
        const savedRows = result.result?.results;
        const rows = Array.isArray(savedRows) && savedRows.every(r => r && typeof r === 'object' && !Array.isArray(r)) ? savedRows : [];
        const safety = [result, result.result ?? {}, ...rows];
        for (const recorded of rows) {
          Object.assign(recorded, loadReceipt(recorded));
          if (row.runtime === 'own') recorded.glideBuildCheck = glideBuildCheck(report.glidePreparation,
            { ...recorded, runtimeReceipt: recorded.runtimeReceipt ?? result.result?.runtimeReceipt });
        }
        const summaryRows = rows.map(recorded => ({ ...recorded, runtime: row.runtime, run: row.run, task: row.task }));
        console.log(`${row.run} ${row.runtime} ${row.task}: exit ${result.code}; ` +
          [...loadSummary(summaryRows), ...glideBuildSummary(summaryRows)].join(' '));
        const cause = result.signal || controller.signal.aborted || safety.some(r => r.cancelled) ? 'CANCELLED'
          : safety.some(r => r.permissionPrompt || r.permissionRefusal || r.approvalStop) ? 'PERMISSION_PROMPT'
          : safety.some(r => r.observerError) ? 'OBSERVER_STOP'
          : safety.some(r => r.appDialog) ? 'APP_DIALOG'
          : safety.some(r => r.cleanupError || r.cleanupUnconfirmed || r.liveLockKept || r.fixtureLockUnconfirmed) || result.result?.passCleanupErrors?.length ||
            result.result?.cleanupDeferred || ownLeftWindows(result.result, rows).length || result.result?.heldAttempts?.length ? 'CLEANUP_ERROR'
          : safety.some(r => r.groupClean === false) ? 'GROUP_UNCLEAN'
          : ![0, 1].includes(result.code) ? 'CHILD_EXIT_UNEXPECTED'
          : rows.some(r => r.skipped) ? 'TASK_RESULT_UNVERIFIED'
          : rows.some(r => r.glideBuildCheck?.status === 'mismatch') ? 'GLIDE_BUILD_MISMATCH' : undefined;
        // Missing build evidence (the child receipt names no serving build yet) stays on the row as
        // glideBuildCheck.status 'unverified' and in the summary; it is information, not a stop.
        if (rows.some(r => r.glideBuildCheck?.status === 'unverified')) report.buildUnverified = true;
        if (cause) { report.stopped = cause; break; }
        if (result.result?.auth !== 'login' || rows.length !== 1) {
          report.stopped = 'Account-login attempt receipt unverified'; break;
        }
        // A nonzero exit is safe to continue only for an ordinary failed task.
        if (result.code === 1 || rows[0].passed === false) {
          if (rows[0].passed !== false) { report.stopped = 'TASK_RESULT_UNVERIFIED'; break; }
          if (rows[0].groupClean !== true) { report.stopped = 'GROUP_CLEANUP_UNVERIFIED'; break; }
        }
      } catch (error) {
        if (error.preparation) report.glidePreparation = error.preparation;
        report.stopped = controller.signal.aborted ? 'CANCELLED' : error.message; break;
      }
    }
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  report.loadWarnings = loadWarnings(report.results.flatMap(attempt =>
    (Array.isArray(attempt.result?.results) ? attempt.result.results : []).filter(row => row && typeof row === 'object')
      .map(row => ({ ...row, arm: attempt.runtime, run: attempt.run }))), { halfCores: true });
  return report;
}
async function main(args) {
  const popupSmoke = args.includes('--popup-smoke');
  args = args.filter(arg => arg !== '--popup-smoke');
  if (args.length === 1 && args[0] === '--dry-run') { console.log(JSON.stringify(proofPlan({ popupSmoke }), null, 2)); return; }
  if (args.length === 3 && args[0] === '--preflight' && args[1] === '--owner-away-file') {
    await proofPreflight(resolve(args[2])); console.log('LIVE_PREFLIGHT_CLEAR'); return;
  }
  if (args.length !== 4 || args[0] !== '--owner-away-file' || args[2] !== '--out') throw Error('Use [--popup-smoke] --dry-run or --owner-away-file FILE --out NEW_DIRECTORY');
  const ownerAwayFile = resolve(args[1]), out = resolve(args[3]);
  const source = sourceIdentity(root);
  if (source.sleightDirty) throw Error('CLEAN_COMMIT_REQUIRED');
  mkdirSync(out, { mode: 0o700 });
  const report = await runProof({ ownerAwayFile, out, popupSmoke });
  report.commit = source.sleightCommit;
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  for (const warning of report.loadWarnings) console.log(warning);
  console.log(JSON.stringify({ recorded: report.results.length, planned: report.plan.length, stopped: report.stopped, report: join(out, 'report.json') }));
  process.exitCode = proofExitCode(report);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
