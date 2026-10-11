// TextEdit save-lock experiment: after an Accessibility text write, does a
// PID-local event keep the engine's pressKey("super+s") from hanging when the
// file was opened through the Open panel? PID-posted Cmd+S never saved.
//   node bench/textedit-save-lock.mjs [--dry-run] [--delivery-check]
// --delivery-check opens a file, types through the engine (no AX write), saves
// with pressKey("super+s"), and confirms the file changed or AXEdited cleared
// within 2 s.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeClient } from './double-keys-client.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { createAppHealthHelper } from '../plugins/sleight/lib/read-failure.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

export const VARIANTS = ['none', 'shift-pair', 'escape', 'keyup-only', 'applescript-read'];
export const GATE_RUNS = 5, GATE_MIN_HANGS = 3, VARIANT_RUNS = Number(process.env.SAVE_LOCK_VARIANT_RUNS) || 5;
export const SAVE_WAIT_MS = 10000, HANG_KEEP_MS = 20000, LOG_LINES = 400, DELIVERY_WAIT_MS = 2000;
const OPEN_PANEL = /^(Open|Go to the folder:|Go to Folder)$/i;
const OWNED_PATH = /^\/private\/tmp\/sleight-save-lock-[A-Za-z0-9]+\/trial\.txt$/;

export function ownedTrialPath(path) {
  if (!OWNED_PATH.test(path ?? '')) throw new Error('Expected an owned temporary trial document');
  return path;
}

export function probeClientOptions(spaceProbe) {
  return { relay: true, relayOptions: { changeReview: false, spaceProbe } };
}

export function mayCapture(stage) {
  return !['open', 'go-to-folder', 'open-panel'].includes(stage);
}

export function trialSteps({ path, marker, variant = 'none', deliveryCheck = false, index = 1 } = {}) {
  ownedTrialPath(path);
  const open = [
    { source: 'engine', code: 'await app.pressKey("super+o")' },
    { source: 'engine', code: 'await app.pressKey("super+shift+g")' },
    { source: 'engine', code: `await app.typeText(${JSON.stringify(path)})` },
    { source: 'engine', code: 'await app.pressKey("Return")' },
  ];
  const text = marker ?? (deliveryCheck ? 'typed' : `probe-${index}\n`);
  if (deliveryCheck) {
    return {
      capture: false,
      open,
      edit: [...text].map(ch => ({ source: 'engine', code: `await app.pressKey(${JSON.stringify(ch)})` })),
      settle: [],
      save: { source: 'engine', code: 'await app.pressKey("super+s")' },
      saveWithinMs: DELIVERY_WAIT_MS,
    };
  }
  return {
    capture: false,
    open,
    edit: [{ source: 'fixture', op: 'edit', text }],
    settle: variant === 'none' ? [] : [{ source: 'fixture', op: 'event', variant }],
    save: { source: 'engine', code: 'await app.pressKey("super+s")' },
    hangTimeoutMs: SAVE_WAIT_MS,
  };
}

export function dryRunPlan({ deliveryCheck = false } = {}) {
  const path = '/private/tmp/sleight-save-lock-dry/trial.txt';
  return {
    dryRun: true,
    deliveryCheck,
    lock: false,
    captureOpenPanel: false,
    probeClient: { relay: true, relayOptions: { changeReview: false, spaceProbe: true } },
    cleanup: 'pid-lookup',
    gate: { runs: GATE_RUNS, variantsIfHangs: GATE_MIN_HANGS, interleaved: true },
    steps: trialSteps({ path, deliveryCheck, marker: deliveryCheck ? 'typed' : 'probe-1\n' }),
    schedule: deliveryCheck ? null : { gate: buildPlan().filter(s => s.phase === 'gate'), reason: 'run gate first' },
  };
}

export function buildPlan({ gateRuns = GATE_RUNS, variantRuns = VARIANT_RUNS, variants = VARIANTS } = {}) {
  const steps = [];
  for (let cycle = 1; cycle <= gateRuns; cycle++) steps.push({ phase: 'gate', variant: 'none', cycle });
  for (let cycle = 1; cycle <= variantRuns; cycle++) for (const variant of variants) steps.push({ phase: 'variants', variant, cycle });
  return steps.map((step, i) => ({ index: i + 1, ...step }));
}

export function buildDeliveryCheckPlan() {
  return [{ index: 1, phase: 'delivery-check', variant: 'none', cycle: 1 }];
}

export function parseArgs(args) {
  const allowed = new Set(['--dry-run', '--delivery-check']);
  for (const a of args) if (!allowed.has(a)) throw new Error('Only --dry-run and --delivery-check are supported');
  return { dryRun: args.includes('--dry-run'), deliveryCheck: args.includes('--delivery-check') };
}

export async function watchSaveStart({ readBytes, readState, until, seed, now = Date.now, sleep, editedBefore = true }) {
  for (;;) {
    const bytes = await readBytes();
    const state = await readState();
    const fileChanged = bytes !== seed;
    const editedCleared = editedBefore && state.edited === false;
    if (fileChanged || editedCleared) return { at: now(), fileChanged, editedCleared, bytes, edited: state.edited };
    if (now() >= until) return null;
    await sleep(100);
  }
}

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
  if (hangs >= minimum) return { proceed: true, hangs, completed, planned, conclusion: 'Open panel reproduces the hang' };
  const conclusion = hangs + planned - completed >= minimum
    ? `inconclusive: ${completed} of ${planned} gate runs completed`
    : 'Open panel does not reproduce the hang';
  return { proceed: false, hangs, completed, planned, conclusion };
}

export async function runExperiment({ plan, runOne, report }) {
  report.runs = [];
  const gatePlanned = plan.filter(s => s.phase === 'gate').length;
  const gateRuns = () => report.runs.filter(r => r.phase === 'gate');
  for (const step of plan) {
    if (step.phase !== 'gate' && !report.gate) {
      report.gate = gatePlanned === 0
        ? { proceed: true, hangs: 0, completed: 0, planned: 0, conclusion: 'no gate' }
        : gateDecision(gateRuns(), gatePlanned);
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

export function scrubEvidence(value, { home = homedir(), names = [] } = {}, stage) {
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (item && typeof item === 'object' && (item.type === 'image' || OPEN_PANEL.test(item.title ?? '')
        || !mayCapture(item.stage ?? stage))) return [];
      const next = scrubEvidence(item, { home, names }, item?.stage ?? stage);
      return next === undefined ? [] : [next];
    });
  }
  if (value && typeof value === 'object') {
    if (value.type === 'image' || OPEN_PANEL.test(value.title ?? '') || (value.stage && !mayCapture(value.stage))) {
      return undefined;
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const next = scrubEvidence(item, { home, names }, value.stage ?? stage);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  if (typeof value !== 'string') return value;
  return scrub(value, { home, names });
}

const FATAL = /Live hold|Cancelled|Foreground changed|channel uncertain|Fixture helper closed|Accessibility unavailable|TextEdit is foreground/;
const RETRY = /^Retry: |-25204$/;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = args.deliveryCheck ? buildDeliveryCheckPlan() : buildPlan();
  if (args.dryRun) {
    process.stdout.write(JSON.stringify(dryRunPlan(args), null, 2) + '\n');
    return;
  }

  const root = fileURLToPath(new URL('../', import.meta.url));
  const execute = promisify(execFile);
  const names = [userInfo().username];
  try { names.unshift((await execute('/usr/bin/id', ['-F'])).stdout.trim()); } catch {}
  const report = { started: new Date().toISOString(), opening: 'Open panel (engine Cmd+O, Cmd+Shift+G)',
    saveWaitMs: args.deliveryCheck ? DELIVERY_WAIT_MS : SAVE_WAIT_MS, hangKeepMs: args.deliveryCheck ? 0 : HANG_KEEP_MS,
    engineUsed: true, pointerUsed: false, axWrite: !args.deliveryCheck, deliveryCheck: args.deliveryCheck,
    captureOpenPanel: false, cleanup: 'pid-lookup', records: [] };
  let release, child, closed, input, request, client, health, cancelled = false, ended = false, channelUncertain = false, unconfirmed;
  process.once('SIGINT', () => { cancelled = true; });
  const free = async () => {
    if (cancelled) throw new Error('Cancelled');
    try { await access('/tmp/sleight-hold'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    throw new Error('Live hold exists; no app action sent');
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const watchFile = async (path, expected, until, full = false) => {
    let matched = null;
    for (;;) {
      if (matched === null && await readFile(path, 'utf8') === expected) { matched = Date.now(); if (!full) return matched; }
      if (Date.now() >= until) return matched;
      await sleep(100); await free();
    }
  };
  const strip = ({ id: _, ok: __, ...rest }) => rest;
  const connect = async () => {
    await free();
    const server = resolveServer();
    if (server.error) throw new Error(server.error);
    report.engineVersion = server.version;
    return probeClient(server, {
      ...probeClientOptions(health.probe),
      label: 'save-lock',
      record: entry => {
        if (entry.event) report.records.push({ event: entry.event, code: entry.code, signal: entry.signal, error: entry.error });
      },
    });
  };
  const callEngine = async (code, stage) => {
    await free();
    const captured = mayCapture(stage);
    const reply = await client.call('js', { code });
    report.records.push({ stage, captured, isError: reply?.isError ?? false, ...(captured ? {} : { responseBodyOmitted: true }) });
    if (reply?.isError) throw new Error('Engine returned an error; Open panel and unrelated document text omitted');
    return reply;
  };
  const openOwned = async path => {
    const steps = trialSteps({ path, deliveryCheck: false });
    for (const step of steps.open) {
      const stage = step.code.includes('super+o') ? 'open'
        : step.code.includes('Return') ? 'open'
          : 'go-to-folder';
      await callEngine(step.code, stage);
    }
  };
  const engineSave = async timeoutMs => {
    await free();
    let settled = false;
    const pending = client.call('js', { code: 'await app.pressKey("super+s")' })
      .then(reply => {
        report.records.push({ stage: 'save', captured: false, isError: reply?.isError ?? false });
        if (reply?.isError) throw new Error('Engine save returned an error; window text omitted');
        return reply;
      })
      .finally(() => { settled = true; });
    const hung = await Promise.race([pending.then(() => false), sleep(timeoutMs).then(() => !settled)]);
    return { hung, pending };
  };
  const reopenEngine = async () => {
    try { await client?.close(); } catch (error) { report.engineReopenError = error.message; }
    client = await connect();
    await callEngine('var app = await cua.getApp("TextEdit")', 'document');
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
    health = createAppHealthHelper();
    client = await connect();
    await callEngine('var app = await cua.getApp("TextEdit")', 'document');

    const runOne = async run => {
      current = run;
      let opened = false, attached = false, fatal;
      try { await (async () => {
        const bank = trackTemp(await mkdtemp('/private/tmp/sleight-save-lock-')), path = join(bank, 'trial.txt');
        ownedTrialPath(path);
        run.bank = bank;
        run.preflight = strip(await request({ op: 'preflight', path }));
        await writeFile(path, 'seed\n'); await free();
        const steps = trialSteps({ path, variant: run.variant, deliveryCheck: run.phase === 'delivery-check', index: run.index });
        await openOwned(path);
        opened = true;
        run.openRequestedAt = Date.now();
        run.attachAttempts = [];
        for (const deadline = Date.now() + 8000; ;) {
          try { run.attach = strip(await request({ op: 'attach' })); attached = true; break; }
          catch (error) {
            run.attachAttempts.push(error.message);
            if (FATAL.test(error.message)) throw error;
            if (!RETRY.test(error.message) || Date.now() > deadline) { run.skipped = `Attach refused: ${error.message}`; return; }
            await sleep(250);
          }
        }
        if (run.phase === 'delivery-check') {
          const seed = await readFile(path, 'utf8');
          for (const step of steps.edit) await callEngine(step.code, 'document');
          run.dirty = strip(await request({ op: 'state' }));
          if (run.dirty.text === seed) { run.skipped = 'Keyboard did not edit'; return; }
          const postedAt = Date.now();
          const save = await engineSave(DELIVERY_WAIT_MS);
          run.savePostedAt = postedAt;
          const hit = await watchSaveStart({
            seed, until: postedAt + DELIVERY_WAIT_MS, sleep, editedBefore: run.dirty.edited === true,
            readBytes: () => readFile(path, 'utf8'),
            readState: async () => strip(await request({ op: 'state' })),
          });
          run.saveStarted = hit !== null;
          run.fileChanged = Boolean(hit?.fileChanged);
          run.editedCleared = Boolean(hit?.editedCleared);
          run.hang = hit === null;
          run.msToSave = hit === null ? null : hit.at - postedAt;
          if (save.hung) { run.engineSaveHung = true; await reopenEngine(); }
          return;
        }
        const expected = `probe-${run.index}\n`;
        run.edit = strip(await request({ op: 'edit', text: expected }));
        if (run.edit.edited !== true) { run.skipped = 'Accessibility write not confirmed'; return; }
        run.event = strip(await request({ op: 'event', variant: run.variant }, 10000));
        run.delivered = run.event.delivered;
        const postedAt = Date.now();
        const save = await engineSave(SAVE_WAIT_MS);
        run.savePostedAt = postedAt;
        const savedAt = await watchFile(path, expected, postedAt + SAVE_WAIT_MS);
        run.hang = savedAt === null; run.msToSave = savedAt === null ? null : savedAt - postedAt;
        if (save.hung) run.engineSaveHung = true;
        if (run.hang) {
          const late = await watchFile(path, expected, Date.now() + HANG_KEEP_MS, true);
          run.lateSaveMs = late === null ? null : late - postedAt;
          try {
            const pid = (await request({ op: 'lookup-pid' })).pid;
            run.cleanupPid = pid;
            const { stdout } = await execute('/usr/bin/log', ['show', '--last', '30s', '--predicate', `process == "TextEdit" AND processIdentifier == ${pid}`],
              { timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
            const lines = scrub(stdout, { names }).split('\n');
            run.logLines = lines.length; run.log = lines.slice(-LOG_LINES).join('\n');
          } catch (error) { run.logError = scrub(error.message, { names }); }
          await reopenEngine();
        }
      })(); } catch (error) {
        run.error = error.message;
        if (FATAL.test(error.message)) fatal = error.message;
      } finally {
        if (attached && !run.hang && !/Live hold|Cancelled/.test(fatal ?? '') && !channelUncertain && !ended) {
          try {
            run.cleanup = strip(await request({ op: 'close-owned', earliest: run.openRequestedAt }, 15000));
            run.cleanupPid = run.cleanup.pid;
            attached = false; opened = false;
            if (run.cleanup.ownedFront || !run.cleanup.foregroundSame) fatal ??= 'Foreground changed during the run';
          } catch (error) { run.cleanupError = error.message; }
        }
        if (opened || attached) { unconfirmed = run; fatal ??= `Owned document not confirmed closed: ${run.cleanupError ?? run.error}`; }
      }
      console.log(JSON.stringify({ index: run.index, phase: run.phase, variant: run.variant, hang: run.hang, msToSave: run.msToSave,
        skipped: run.skipped, error: run.error, cleanup: run.cleanup?.method ?? run.cleanupError }));
      return fatal ? { stop: fatal } : undefined;
    };
    await runExperiment({ plan, runOne, report });
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    if (client) {
      try { await client.close(); report.engineCollected = true; }
      catch (error) { report.engineCleanupError = error.message; process.exitCode = 1; }
    }
    if (health) {
      try { await health.close(); report.healthClosed = true; }
      catch (error) { report.healthCleanupError = error.message; }
    }
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => { if (!ended) child.kill('SIGTERM'); }, 3000);
      await closed; clearTimeout(timer); input.close();
    }
    if (release && !unconfirmed) { await release(); report.lockReleased = true; }
    else if (release) report.lockRetained = `Run ${unconfirmed.index}: owned TextEdit document not confirmed closed; operator inspection required`;
    if (report.stopped || report.error) process.exitCode = 1;
    if (args.deliveryCheck && report.runs?.some(r => r.saveStarted !== true && !r.skipped && !r.error)) process.exitCode = 1;
    report.instanceMayRemain = Boolean(unconfirmed);
    report.finished = new Date().toISOString();
    const published = JSON.stringify(scrubEvidence(report, { names }), null, 2);
    const output = join(root, 'docs/benchmarks', `2026-10-10-save-lock-${args.deliveryCheck ? 'delivery' : 'experiment'}-${Date.now()}.json`);
    await writeFile(output, published + '\n');
    console.log(`Gate: ${report.gate?.conclusion ?? 'not reached'}${report.stopped ? `; stopped: ${report.stopped}` : ''}`);
    if (args.deliveryCheck) {
      const run = report.runs?.[0];
      console.log(`Delivery: saveStarted=${run?.saveStarted ?? false} fileChanged=${run?.fileChanged ?? false} editedCleared=${run?.editedCleared ?? false} msToSave=${run?.msToSave ?? null}`);
    } else {
      for (const [variant, c] of Object.entries(report.counts?.variants ?? {})) console.log(`${variant}: ${c.hangs}/${c.completed} hung, ${c.skipped} skipped, ${c.notDelivered} not delivered`);
    }
    console.log(`Published ${scrub(output)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
