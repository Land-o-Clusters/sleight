// TextEdit save-lock probe. Opens through the engine Open panel, writes through
// Accessibility, and saves with pressKey("super+s"). PID-posted Cmd+S never saved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { createAppHealthHelper } from '../plugins/sleight/lib/read-failure.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { probeClient } from './double-keys-client.mjs';
import { acquireLiveLock } from './live-lock.mjs';

export const CONTROL = 'ax-write';
export const SHIFT_VARIANT = 'ax-write-shift';
export const GATE_RUNS = 5;
export const VARIANT_IF_HANGS = 3;
export const VARIANT_RUNS = 5;
export const DELIVERY_TIMEOUT_MS = 2000;
export const HANG_TIMEOUT_MS = 15000;
const root = fileURLToPath(new URL('../', import.meta.url));
const fixturePath = fileURLToPath(new URL('./textedit-save-lock.js', import.meta.url));

export function ownedTrialPath(path) {
  if (!/^\/private\/tmp\/sleight-save-lock-[A-Za-z0-9]+\/trial\.txt$/.test(path ?? '')) {
    throw new Error('Expected an owned temporary trial document');
  }
  return path;
}

export function probeClientOptions(spaceProbe) {
  return { relay: true, relayOptions: { changeReview: false, spaceProbe } };
}

export function mayCapture(stage) {
  return !['open', 'go-to-folder', 'open-panel'].includes(stage);
}

export function trialSteps({ path, marker = 'ax-lock', variant = CONTROL, deliveryCheck = false } = {}) {
  ownedTrialPath(path);
  const open = [
    { source: 'engine', code: 'await app.pressKey("super+o")' },
    { source: 'engine', code: 'await app.pressKey("super+shift+g")' },
    { source: 'engine', code: `await app.typeText(${JSON.stringify(path)})` },
    { source: 'engine', code: 'await app.pressKey("Return")' },
  ];
  if (deliveryCheck) {
    return {
      capture: false,
      open,
      edit: [...marker].map(ch => ({ source: 'engine', code: `await app.pressKey(${JSON.stringify(ch)})` })),
      settle: [],
      save: { source: 'engine', code: 'await app.pressKey("super+s")' },
      saveWithinMs: DELIVERY_TIMEOUT_MS,
    };
  }
  return {
    capture: false,
    open,
    edit: [{ source: 'fixture', op: 'write', text: marker }],
    settle: variant === SHIFT_VARIANT ? [{ source: 'fixture', op: 'settle-shift' }] : [],
    save: { source: 'engine', code: 'await app.pressKey("super+s")' },
    hangTimeoutMs: HANG_TIMEOUT_MS,
  };
}

export function scheduleTrials({ gateRuns = GATE_RUNS, variantIfHangs = VARIANT_IF_HANGS,
  variantRuns = VARIANT_RUNS, controlHangs } = {}) {
  const gate = Array.from({ length: gateRuns }, (_, i) => ({ index: i + 1, variant: CONTROL, phase: 'gate' }));
  if (controlHangs === undefined) return { gate, variants: null, reason: 'run gate first' };
  if (controlHangs < variantIfHangs) {
    return { gate, variants: [], reason: `gate hung ${controlHangs}/${gateRuns}; variants skipped` };
  }
  const variants = [];
  for (let i = 0; i < variantRuns; i++) {
    variants.push({ index: i + 1, variant: CONTROL, phase: 'interleaved' });
    variants.push({ index: i + 1, variant: SHIFT_VARIANT, phase: 'interleaved' });
  }
  return { gate, variants, reason: `gate hung ${controlHangs}/${gateRuns}; interleaved variants` };
}

export function countHangs(trials) {
  const counts = { total: 0, [CONTROL]: 0 };
  for (const trial of trials) {
    counts[trial.variant] ??= 0;
    if (!trial.hung) continue;
    counts.total++;
    counts[trial.variant]++;
  }
  return counts;
}

export async function runTrials({ gateRuns = GATE_RUNS, variantIfHangs = VARIANT_IF_HANGS,
  variantRuns = VARIANT_RUNS, trial } = {}) {
  const trials = [];
  for (const step of scheduleTrials({ gateRuns, variantIfHangs, variantRuns }).gate) {
    trials.push({ ...step, ...await trial(step.variant) });
  }
  const hangs = trials.filter(t => t.hung).length;
  const next = scheduleTrials({ gateRuns, variantIfHangs, variantRuns, controlHangs: hangs });
  for (const step of next.variants) trials.push({ ...step, ...await trial(step.variant) });
  return { trials, hangs: countHangs(trials), variantsRan: next.variants.length > 0 };
}

export async function runDeliveryCheck({ edit, save, now, savedAt, timeoutMs = DELIVERY_TIMEOUT_MS }) {
  await edit();
  const start = now();
  await save();
  const delayMs = savedAt() - start;
  return { saved: delayMs <= timeoutMs, delayMs, timeoutMs };
}

const OPEN_PANEL = /^(Open|Go to the folder:|Go to Folder)$/i;

export function scrubEvidence(value, { home = '', username = '' } = {}, stage) {
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (item && typeof item === 'object' && (item.type === 'image' || OPEN_PANEL.test(item.title ?? '')
        || !mayCapture(item.stage ?? stage))) return [];
      const next = scrubEvidence(item, { home, username }, item?.stage ?? stage);
      return next === undefined ? [] : [next];
    });
  }
  if (value && typeof value === 'object') {
    if (value.type === 'image' || OPEN_PANEL.test(value.title ?? '') || (value.stage && !mayCapture(value.stage))) {
      return undefined;
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const next = scrubEvidence(item, { home, username }, value.stage ?? stage);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  if (typeof value !== 'string') return value;
  let text = value;
  if (home) text = text.replaceAll(home, '~');
  if (username) text = text.replaceAll(username, '<home-folder>');
  return text;
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
    gate: { runs: GATE_RUNS, variantsIfHangs: VARIANT_IF_HANGS, interleaved: true },
    steps: trialSteps({ path, deliveryCheck, marker: deliveryCheck ? 'typed' : 'ax-lock' }),
    schedule: deliveryCheck ? null : scheduleTrials(),
  };
}

const textOf = reply => (reply?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');

function startFixture(path, report) {
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', fixturePath, path], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let id = 0, ended = false, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const collected = new Promise(resolve => child.once('close', (code, signal) => {
    ended = true; report.fixtureExit = { code, signal };
    for (const reply of pending.values()) reply.reject(new Error(stderr || 'Fixture helper closed'));
    pending.clear(); resolve();
  }));
  child.on('error', error => { for (const reply of pending.values()) reply.reject(error); });
  const input = createInterface({ input: child.stdout });
  input.on('line', line => {
    let parsed; try { parsed = JSON.parse(line); } catch { return; }
    const reply = pending.get(parsed.id) ?? [...pending.values()][0];
    if (!reply) return;
    pending.delete(reply.id); parsed.ok ? reply.resolve(parsed) : reply.reject(new Error(parsed.error));
  });
  return {
    request: op => new Promise((resolve, reject) => {
      const key = id++, body = typeof op === 'string' ? { op } : op;
      const timer = setTimeout(() => reject(new Error('Fixture helper timeout')), 15000);
      pending.set(key, { id: key, resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ id: key, ...body }) + '\n');
    }),
    close: async () => {
      child.stdin.end();
      const timer = setTimeout(() => { if (!ended) child.kill('SIGTERM'); }, 10000);
      try { await collected; } finally { clearTimeout(timer); input.close(); }
    },
  };
}

async function callEngine(client, code, { stage = 'document', report } = {}) {
  const reply = await client.call('js', { code });
  const captured = mayCapture(stage);
  report.records.push({ stage, captured, isError: reply?.isError ?? false,
    ...(captured ? { window: windowFromText(textOf(reply)) ?? null } : { responseBodyOmitted: true }) });
  assert.ok(!reply?.isError, 'Engine returned an error; Open panel and unrelated document text omitted');
  return reply;
}

async function openOwnedDocument(client, path, report) {
  for (const step of trialSteps({ path }).open) {
    const stage = step.code.includes('super+o') ? 'open'
      : step.code.includes('super+shift+g') || step.code.includes('typeText') ? 'go-to-folder'
        : 'open';
    await callEngine(client, step.code, { stage, report });
  }
}

async function engineSave(client, report, timeoutMs) {
  let settled = false;
  const pending = client.call('js', { code: 'await app.pressKey("super+s")' })
    .then(reply => { report.records.push({ stage: 'save', captured: false, isError: reply?.isError ?? false }); return reply; })
    .finally(() => { settled = true; });
  const hung = await Promise.race([pending.then(() => false), sleep(timeoutMs).then(() => true)]);
  return { hung, pending, settled };
}

async function connect(server, report, health) {
  return probeClient(server, {
    ...probeClientOptions(health.probe),
    label: 'save-lock',
    record: entry => {
      if (entry.event) report.records.push({ event: entry.event, code: entry.code, signal: entry.signal, error: entry.error });
    },
  });
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const deliveryCheck = argv.includes('--delivery-check');
  if (dryRun) {
    process.stdout.write(JSON.stringify(dryRunPlan({ deliveryCheck }), null, 2) + '\n');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('Live save-lock runs on macOS only. Use --dry-run.');
  const report = { started: new Date().toISOString(), deliveryCheck, trials: [], records: [],
    captureOpenPanel: false, cleanup: 'pid-lookup' };
  report.source = Object.fromEntries(await Promise.all(
    ['bench/textedit-save-lock.mjs', 'bench/textedit-save-lock.js'].map(async name =>
      [name, createHash('sha256').update(await readFile(join(root, name))).digest('hex')])));
  let release, fixture, client, health, opened = false, attached = false, cancelled = false;
  process.once('SIGINT', () => { cancelled = true; });
  const bank = await mkdtemp('/private/tmp/sleight-save-lock-');
  const path = join(bank, 'trial.txt');
  ownedTrialPath(path);
  try {
    release = await acquireLiveLock();
    await writeFile(path, 'seed\n');
    fixture = startFixture(path, report);
    const preflight = await fixture.request('preflight');
    report.preflight = preflight;
    assert.ok(preflight.running && !preflight.foregroundTextEdit,
      'Requires already-running TextEdit in the background; no activation attempted');
    const server = resolveServer();
    assert.ok(!server.error, server.error);
    report.engineVersion = server.version;
    health = createAppHealthHelper();
    client = await connect(server, report, health);
    await callEngine(client, 'var app = await cua.getApp("TextEdit")', { stage: 'document', report });
    await openOwnedDocument(client, path, report);
    opened = true;
    await fixture.request('attach');
    attached = true;
    report.pid = (await fixture.request('lookup-pid')).pid;
    if (deliveryCheck) {
      const steps = trialSteps({ path, deliveryCheck: true, marker: 'typed' });
      const seed = await readFile(path);
      const started = Date.now();
      for (const step of steps.edit) await callEngine(client, step.code, { stage: 'document', report });
      const save = await engineSave(client, report, DELIVERY_TIMEOUT_MS);
      let saved = false, delayMs = Date.now() - started;
      if (!save.hung) {
        while (Date.now() - started <= DELIVERY_TIMEOUT_MS) {
          const now = await readFile(path);
          if (now !== seed) { saved = true; delayMs = Date.now() - started; break; }
          await sleep(50);
        }
        delayMs = Date.now() - started;
      }
      report.delivery = { hung: save.hung, saved, delayMs, timeoutMs: DELIVERY_TIMEOUT_MS };
      if (!saved || save.hung) process.exitCode = 1;
      console.log(JSON.stringify(report.delivery));
    } else {
      let trialIndex = 0;
      const run = await runTrials({ trial: async variant => {
        if (cancelled) throw new Error('Cancelled');
        trialIndex++;
        const marker = `ax-lock-${trialIndex}`;
        const steps = trialSteps({ path, marker, variant });
        await fixture.request({ op: 'write', text: marker });
        for (const step of steps.settle) await fixture.request(step.op);
        const before = await readFile(path, 'utf8');
        const save = await engineSave(client, report, HANG_TIMEOUT_MS);
        let saved = false;
        if (save.hung) {
          try { await client.close(); } catch (error) { report.engineReopenError = error.message; }
          client = await connect(server, report, health);
          await callEngine(client, 'var app = await cua.getApp("TextEdit")', { stage: 'document', report });
        } else {
          saved = await readFile(path, 'utf8') !== before;
        }
        const entry = { variant, hung: save.hung, saved, marker };
        report.trials.push(entry);
        console.log(JSON.stringify(entry));
        return entry;
      } });
      report.hangs = run.hangs;
      report.variantsRan = run.variantsRan;
    }
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
    if (fixture && attached) {
      try {
        report.cleanupPid = (await fixture.request('lookup-pid')).pid;
        await fixture.request('close');
        report.documentClosed = true;
      } catch (error) { report.documentCleanupError = error.message; process.exitCode = 1; }
    }
    if (fixture) {
      try { await fixture.close(); report.fixtureCollected = true; }
      catch (error) { report.fixtureCleanupError = error.message; process.exitCode = 1; }
    }
    report.attached = attached;
    report.opened = opened;
    report.finished = new Date().toISOString();
    const published = JSON.stringify(scrubEvidence(report, { home: homedir(), username: userInfo().username }), null, 2);
    await writeFile(join(bank, 'results.json'), published + '\n');
    console.log(`Private evidence: ${join(bank, 'results.json').replaceAll(homedir(), '~')}`);
    if (release && report.documentClosed && !report.engineCleanupError && !report.fixtureCleanupError) {
      try { await release(); report.lockReleased = true; }
      catch (error) { report.lockCleanupError = error.message; process.exitCode = 1; }
    } else if (release) report.lockRetained = 'Owned document or process cleanup is unconfirmed; operator inspection required';
    const outputPath = join(root, 'docs/benchmarks', `${report.started.slice(0, 10)}-save-lock-${Date.now()}.json`);
    await writeFile(outputPath, published + '\n');
    console.log(`Published ${outputPath.replaceAll(homedir(), '~')}`);
  }
}

function invokedAsMain() {
  try { return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? ''); }
  catch { return false; }
}

if (invokedAsMain()) await main();
