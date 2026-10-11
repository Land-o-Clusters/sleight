// TextEdit save-lock experiment: after an Accessibility text write, does a PID-local event or an
// Apple Event keep TextEdit's next Cmd+S from hanging? No engine, pointer, clipboard or activation.
//   node bench/textedit-save-lock.mjs [--dry-run]
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireLiveLock } from './live-lock.mjs';
import { cleanupFailedTextEditLaunch } from './textedit-save-lock-cleanup-run.mjs';

export const VARIANTS = ['none', 'shift-pair', 'escape', 'keyup-only', 'applescript-read'];
export const GATE_RUNS = 5, GATE_MIN_HANGS = 3, VARIANT_RUNS = Number(process.env.SAVE_LOCK_VARIANT_RUNS) || 5;
export const SAVE_WAIT_MS = 10000, HANG_KEEP_MS = 20000, LOG_LINES = 400;
// The two serialization defaults make AppKit log document work that blocks for 3 s or more.
// ApplePersistenceIgnoreState keeps the new instance from restoring windows, which stopped the
// 2026-10-10 05:40Z attempt.
// SAVE_LOCK_NO_DEBUG=1 drops AppKit's serialization logging, a control for whether it changes the save's timing.
export const LAUNCH_ARGS = [...(process.env.SAVE_LOCK_NO_DEBUG === '1' ? [] : ['-NSDocumentDebugSerialization', 'YES', '-NSDocumentSerializationLoggingDelay', '3']), '-ApplePersistenceIgnoreState', 'YES'];
export const launchCommand = path => ['/usr/bin/open', ['-n', '-g', '-b', 'com.apple.TextEdit', path, '--args', ...LAUNCH_ARGS]];

// Gate runs first, all without an event; then the variants interleaved, one of each per cycle.
export function buildPlan({ gateRuns = GATE_RUNS, variantRuns = VARIANT_RUNS, variants = VARIANTS } = {}) {
  const steps = [];
  for (let cycle = 1; cycle <= gateRuns; cycle++) steps.push({ phase: 'gate', variant: 'none', cycle });
  for (let cycle = 1; cycle <= variantRuns; cycle++) for (const variant of variants) steps.push({ phase: 'variants', variant, cycle });
  return steps.map((step, i) => ({ index: i + 1, ...step }));
}

// A run counts only when its save was requested after the variant reached TextEdit.
export function countByVariant(runs) {
  const counts = {};
  for (const run of runs) {
    const c = counts[run.variant] ??= { runs: 0, completed: 0, hangs: 0, saved: 0, skipped: 0, notDelivered: 0, msToSave: [] };
    c.runs++;
    if (run.delivered === false) c.notDelivered++;
    else if (run.hang === true) { c.completed++; c.hangs++; }
    else if (run.hang === false) { c.completed++; c.saved++; c.msToSave.push(run.msToSave); }
    else c.skipped++;
  }
  return counts;
}

export function gateDecision(gateRuns, planned = GATE_RUNS, minimum = GATE_MIN_HANGS) {
  const hangs = gateRuns.filter(r => r.hang === true).length;
  const completed = gateRuns.filter(r => typeof r.hang === 'boolean').length;
  if (hangs >= minimum) return { proceed: true, hangs, completed, planned, conclusion: 'open -g reproduces the hang' };
  // Runs that were skipped or never ran could have hung, so fewer hangs then proves nothing.
  const conclusion = hangs + planned - completed >= minimum
    ? `inconclusive: ${completed} of ${planned} gate runs completed`
    : 'open -g does not reproduce the hang';
  return { proceed: false, hangs, completed, planned, conclusion };
}

// Runs every planned step in order, records each run whatever happens to it, and stops before the
// variants when the gate fails. `runOne` fills in the run and returns { stop } to end early.
export async function runExperiment({ plan, runOne, report }) {
  report.runs = [];
  const gatePlanned = plan.filter(s => s.phase === 'gate').length;
  const gateRuns = () => report.runs.filter(r => r.phase === 'gate');
  for (const step of plan) {
    if (step.phase !== 'gate' && !report.gate) {
      report.gate = gateDecision(gateRuns(), gatePlanned);
      if (!report.gate.proceed) break;
    }
    const run = { ...step };
    report.runs.push(run);
    const outcome = await runOne(run);
    if (outcome?.stop) { report.stopped = outcome.stop; break; }
  }
  report.gate ??= gateDecision(gateRuns(), gatePlanned);
  report.counts = { gate: countByVariant(gateRuns()), variants: countByVariant(report.runs.filter(r => r.phase !== 'gate')) };
  return report;
}

export function scrub(text, { home = homedir(), names = [] } = {}) {
  let out = String(text).replaceAll(home, '~');
  for (const name of names) if (name && name.length > 2) out = out.replaceAll(name, '[owner]');
  return out;
}

// Stop the whole experiment on these; anything else is recorded on its run and the next run starts.
const FATAL = /Live hold|Cancelled|Foreground changed|channel uncertain|Fixture helper closed|Accessibility unavailable|TextEdit is foreground/;
const RETRY = /^Retry: |-25204$/;

function printPlan(plan) {
  console.log('Dry run: nothing launched, no lock taken, no file written.');
  console.log(`Launch per run: ${launchCommand('/private/tmp/sleight-save-lock-XXXXXX/trial.txt').flat().join(' ')}`);
  console.log(`Gate: ${GATE_RUNS} runs without an event, ${SAVE_WAIT_MS / 1000} s after Cmd+S; variants run only if at least ${GATE_MIN_HANGS} hang.`);
  for (const s of plan) console.log(`${String(s.index).padStart(2)}  ${s.phase.padEnd(8)}  cycle ${s.cycle}  ${s.variant}`);
  console.log(`A hang keeps its instance ${HANG_KEEP_MS / 1000} s, then captures log show --last 30s for that TextEdit PID.`);
  console.log('Results: docs/benchmarks/2026-10-10-save-lock-experiment-<stamp>.json');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--dry-run')) throw new Error('Only --dry-run is supported');
  const plan = buildPlan();
  if (args.includes('--dry-run')) return printPlan(plan);

  const root = fileURLToPath(new URL('../', import.meta.url));
  const execute = promisify(execFile);
  const names = [userInfo().username];
  try { names.unshift((await execute('/usr/bin/id', ['-F'])).stdout.trim()); } catch {}
  const report = { started: new Date().toISOString(), opening: 'open -n -g (owned isolated instance per run)', launchArgs: LAUNCH_ARGS,
    saveWaitMs: SAVE_WAIT_MS, hangKeepMs: HANG_KEEP_MS, engineUsed: false, pointerUsed: false };
  let release, child, closed, input, request, cancelled = false, ended = false, channelUncertain = false, unconfirmed;
  process.once('SIGINT', () => { cancelled = true; });
  const free = async () => {
    if (cancelled) throw new Error('Cancelled');
    try { await access('/tmp/sleight-hold'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    throw new Error('Live hold exists; no app action sent');
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Polls the file until `until`; with `full` it keeps waiting after a match. Returns the first match time.
  const watchFile = async (path, expected, until, full = false) => {
    let matched = null;
    for (;;) {
      if (matched === null && await readFile(path, 'utf8') === expected) { matched = Date.now(); if (!full) return matched; }
      if (Date.now() >= until) return matched;
      await sleep(100); await free();
    }
  };
  let current;
  try {
    await free(); release = await acquireLiveLock(); report.lockTaken = true; await free();
    child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'bench/textedit-save-lock.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let id = 0, stderr = ''; const pending = new Map();
    child.stderr.on('data', b => { stderr += b; });
    closed = new Promise(resolve => child.once('close', (code, signal) => {
      ended = true; report.helperExit = { code, signal };
      for (const p of pending.values()) p.reject(new Error(stderr || 'Fixture helper closed')); pending.clear(); resolve();
    }));
    input = createInterface({ input: child.stdout });
    input.on('line', line => {
      let r; try { r = JSON.parse(line); } catch { return; }
      const p = pending.get(r.id); if (!p) return; pending.delete(r.id);
      if (r.ok) p.resolve(r);
      else { if (current) current.failedOperation = r; p.reject(new Error(r.error)); }
    });
    request = async (payload, timeout = 6000) => {
      if (channelUncertain) throw new Error('Fixture channel uncertain; no further app operation sent');
      if (ended) throw new Error('Fixture helper closed');
      await free();
      return new Promise((resolve, reject) => {
        const key = id++, timer = setTimeout(() => { channelUncertain = true; pending.delete(key); reject(new Error('Fixture operation timed out; channel uncertain')); }, timeout);
        pending.set(key, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } });
        child.stdin.write(JSON.stringify({ id: key, ...payload }) + '\n');
      });
    };
    const strip = ({ id: _, ok: __, ...rest }) => rest;

    const runOne = async run => {
      current = run;
      let launched = false, fatal;
      // The body returns early on a skip; cleanup and the stop decision below still run.
      try { await (async () => {
        const bank = await mkdtemp('/private/tmp/sleight-save-lock-'), path = join(bank, 'trial.txt');
        run.bank = bank;
        run.preflight = strip(await request({ op: 'preflight', path }));
        await writeFile(path, 'seed\n'); await free();
        run.launchRequestedAt = Date.now(); launched = true;
        const [command, argv] = launchCommand(path);
        await execute(command, argv);
        const earliest = run.launchRequestedAt - 1000;
        run.attachAttempts = [];
        for (const deadline = Date.now() + 8000; ;) {
          try { run.attach = strip(await request({ op: 'attach', earliest })); break; }
          catch (error) {
            run.attachAttempts.push(error.message);
            if (FATAL.test(error.message)) throw error;
            if (!RETRY.test(error.message) || Date.now() > deadline) { run.skipped = `Attach refused: ${error.message}`; return; }
            await sleep(250);
          }
        }
        const expected = `probe-${run.index}\n`;
        run.edit = strip(await request({ op: 'edit', text: expected }));
        if (run.edit.edited !== true) { run.skipped = 'Accessibility write not confirmed'; return; }
        run.event = strip(await request({ op: 'event', variant: run.variant }, 10000));
        run.delivered = run.event.delivered;
        const { postedAt } = await request({ op: 'save' });
        run.savePostedAt = postedAt;
        const savedAt = await watchFile(path, expected, postedAt + SAVE_WAIT_MS);
        run.hang = savedAt === null; run.msToSave = savedAt === null ? null : savedAt - postedAt;
        if (run.hang) {
          // Keep the hung instance alive so AppKit's delayed serialization log has time to appear.
          const late = await watchFile(path, expected, Date.now() + HANG_KEEP_MS, true);
          run.lateSaveMs = late === null ? null : late - postedAt;
          try {
            const { stdout } = await execute('/usr/bin/log', ['show', '--last', '30s', '--predicate', `process == "TextEdit" AND processIdentifier == ${run.attach.pid}`],
              { timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
            const lines = scrub(stdout, { names }).split('\n');
            run.logLines = lines.length; run.log = lines.slice(-LOG_LINES).join('\n');
          } catch (error) { run.logError = scrub(error.message, { names }); }
        }
      })(); } catch (error) {
        run.error = error.message;
        if (FATAL.test(error.message)) fatal = error.message;
      } finally {
        if (launched && !/Live hold|Cancelled/.test(fatal ?? '') && !channelUncertain && !ended) {
          try {
            run.cleanup = strip(await request({ op: 'end-owned', earliest: run.launchRequestedAt - 1000 }, 15000));
            launched = false;
            if (run.cleanup.ownedFront || !run.cleanup.foregroundSame) fatal ??= 'Foreground changed during the run';
          } catch (error) { run.cleanupError = error.message; }
        }
        if (launched) { unconfirmed = run; fatal ??= `Owned instance not confirmed gone: ${run.cleanupError ?? run.error}`; }
      }
      console.log(JSON.stringify({ index: run.index, phase: run.phase, variant: run.variant, hang: run.hang, msToSave: run.msToSave,
        skipped: run.skipped, error: run.error, cleanup: run.cleanup?.method ?? run.cleanupError }));
      return fatal ? { stop: fatal } : undefined;
    };
    await runExperiment({ plan, runOne, report });
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => { if (!ended) child.kill('SIGTERM'); }, 3000);
      await closed; clearTimeout(timer); input.close();
    }
    // A dead helper can't quit an unedited launch, so the recorded-launch cleanup takes over.
    // It releases the lock itself when it confirms the quit.
    if (release && unconfirmed && !unconfirmed.edit && !cancelled) {
      const trial = { ...unconfirmed, failedOperation: { ...unconfirmed.failedOperation, pid: unconfirmed.attach?.pid ?? unconfirmed.failedOperation?.pid } };
      if (await cleanupFailedTextEditLaunch({ report, trial, bank: unconfirmed.bank })) {
        unconfirmed.cleanup = { method: 'recorded-launch-cleanup', gone: true }; unconfirmed = undefined; release = undefined; report.lockReleased = true;
      }
    }
    if (release && !unconfirmed) { await release(); report.lockReleased = true; }
    else if (release) report.lockRetained = `Run ${unconfirmed.index}: owned TextEdit instance not confirmed gone; operator inspection required`;
    if (report.stopped || report.error) process.exitCode = 1;
    report.instanceMayRemain = Boolean(unconfirmed);
    report.finished = new Date().toISOString();
    const published = scrub(JSON.stringify(report, null, 2), { names });
    const output = join(root, 'docs/benchmarks', `2026-10-10-save-lock-experiment-${Date.now()}.json`);
    await writeFile(output, published + '\n');
    console.log(`Gate: ${report.gate?.conclusion ?? 'not reached'}${report.stopped ? `; stopped: ${report.stopped}` : ''}`);
    for (const [variant, c] of Object.entries(report.counts?.variants ?? {})) console.log(`${variant}: ${c.hangs}/${c.completed} hung, ${c.skipped} skipped, ${c.notDelivered} not delivered`);
    console.log(`Published ${scrub(output)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
