#!/usr/bin/env node
// VC7 check 2, the engine's own cursor (R4-engine-cursor.md section 5): does the engine draw a cursor window during sleight's
// calls, which would double up with the agent cursor? capture-helper watch-engine samples the window list every 50 ms for
// windows owned by "Computer Use" or "Codex Computer Use" (owner names ending in "Computer Use"; no other app's window is
// named) while a sleight session (SLEIGHT_HAND=0, so any cursor seen is the engine's) runs a read, an AX click by element
// number, a coordinate click, type and scroll on a TextEdit fixture: once with TextEdit in the background, then in front.
// Then it times 10 identical coordinate clicks with the sampler running and 10 without, in alternating blocks of 5.
//
//   node bench/hand/engine-cursor.mjs --owner-away [--out DIR] [--helper PATH] [--receipt PATH] [--dry-run]
//
// Exit 0: measured. 1: a call failed. 2: setup refused. 3: busy (hold or live lock).
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ROOT, TEXTEDIT, tilde, stamp, logsRoot, commonArgs, liveRefusal } from './vc7-live.mjs';

const execute = promisify(execFile);
export const SAMPLE_MS = 50;
export const GAP_MS = 2000;
export const TIMED_CALLS = 10;
export const COORDINATE = [200, 150]; // inside the text area of a TextEdit window at least 400 by 300 pt, in either frame

/** One watch-engine line per sample: [{ t, windows }]. The final { ok, done } line and anything unparsable are dropped. */
export function parseWatch(text) {
  const samples = [];
  for (const line of String(text).split('\n')) {
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (Number.isFinite(value?.t) && Array.isArray(value.windows)) samples.push(value);
  }
  return samples;
}

const drawn = w => w.onScreen === true && w.alpha > 0 && w.bounds?.width > 0 && w.bounds?.height > 0;

/** The drawn engine windows in the samples before baselineMs (before any engine call): evidence on their own. */
export function baselineWindows(samples, baselineMs) {
  const seen = new Map();
  for (const s of samples.filter(s => s.t < baselineMs)) for (const w of s.windows.filter(drawn)) seen.set(w.id, { id: w.id, owner: w.owner, name: w.name, layer: w.layer, sharing: w.sharing, bounds: w.bounds });
  return [...seen.values()];
}

/** Per call ({ label, start, end } in ms): whether a drawn engine window that wasn't up before baselineMs (taken before any
 *  engine call; default the first call's start) appeared between the call's start and 500 ms after its end, how long after
 *  the start it first showed, how long it stayed, and what it was. coverage: the samples seen over the samples a 50 ms
 *  sampler should have taken in that span. */
export function callSightings(samples, calls, { afterMs = 500, baselineMs } = {}) {
  const first = baselineMs ?? (calls.length ? Math.min(...calls.map(c => c.start)) : Infinity);
  const baseline = new Set(samples.filter(s => s.t < first).flatMap(s => s.windows.filter(drawn).map(w => w.id)));
  return calls.map(call => {
    const inside = samples.filter(s => s.t >= call.start && s.t <= call.end + afterMs);
    const seen = new Map();
    for (const s of inside) for (const w of s.windows.filter(drawn)) {
      if (baseline.has(w.id)) continue;
      const entry = seen.get(w.id) ?? { id: w.id, owner: w.owner, name: w.name, layer: w.layer, sharing: w.sharing, bounds: w.bounds, firstT: s.t, lastT: s.t, samples: 0 };
      entry.lastT = s.t; entry.samples++;
      seen.set(w.id, entry);
    }
    const windows = [...seen.values()].map(({ firstT, lastT, ...w }) => ({ ...w, delayMs: firstT - call.start, visibleMs: lastT - firstT + SAMPLE_MS }));
    const expected = Math.max(1, Math.floor((call.end - call.start + afterMs) / SAMPLE_MS));
    return { label: call.label, placement: call.placement, ms: call.end - call.start, samples: inside.length,
      coverage: Math.round(inside.length / expected * 100) / 100, appeared: windows.length > 0, windows, ...(call.error ? { error: call.error } : {}) };
  });
}

const median = values => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** The 10 identical calls with and without the sampler: medians and the difference, in ms. */
export function timingStats(withMs, withoutMs) {
  const a = median(withMs), b = median(withoutMs);
  return { withSampler: { calls: withMs.length, medianMs: a, minMs: withMs.length ? Math.min(...withMs) : null, maxMs: withMs.length ? Math.max(...withMs) : null },
    withoutSampler: { calls: withoutMs.length, medianMs: b, minMs: withoutMs.length ? Math.min(...withoutMs) : null, maxMs: withoutMs.length ? Math.max(...withoutMs) : null },
    deltaMs: a === null || b === null ? null : Math.round(a - b) };
}

export const MIN_SAMPLES = 100, MIN_COVERAGE = 0.5;
const OPEN = "whether the engine's own screenshots include it is still open (not tested here)";
/** R4's decision table, as far as this run can tell. no-cursor needs at least MIN_SAMPLES samples and every call sampled for
 *  at least half its span; a window up before the first engine call counts as evidence, never as absence. */
export function engineDecision(sightings, { baseline = [], samples = sightings.reduce((n, s) => n + s.samples, 0) } = {}) {
  if (!sightings.length) return { row: 'no-data', words: 'no calls ran' };
  const named = list => [...new Set(list.map(w => `${w.owner}/${w.name || 'unnamed'}`))].join(', ');
  const seen = sightings.filter(s => s.appeared);
  if (seen.length) return { row: 'cursor-window', words: `an engine window appeared during ${seen.length} of ${sightings.length} calls (${named(seen.flatMap(s => s.windows))}); ${OPEN}` };
  if (baseline.length) return { row: 'cursor-window', words: `engine windows were up before the first engine call (${named(baseline)}) and stayed; ${OPEN}` };
  if (samples < MIN_SAMPLES) return { row: 'no-data', words: `only ${samples} window-list samples (needs ${MIN_SAMPLES}): the sampler did not run long enough to say` };
  const thin = sightings.filter(s => s.coverage < MIN_COVERAGE);
  if (thin.length) return { row: 'no-data', words: `the sampler missed most of ${thin.map(s => `${s.placement} ${s.label}`).join(', ')}` };
  return { row: 'no-cursor', words: `no engine window appeared during ${sightings.length} calls (${samples} samples): the agent cursor is the only cursor on this Mac (the flag may differ on other Macs)` };
}

/** The element numbers the sequence uses, from getApp's tree text: a button that can't close or quit anything, and the text
 *  area. Either may be missing. */
export function pickElements(tree) {
  let button, text;
  for (const line of String(tree).split('\n')) {
    const m = /^\t*(\d+) (.+)$/.exec(line);
    if (!m) continue;
    const [n, rest] = [Number(m[1]), m[2]];
    if (text === undefined && /^(text area|text view|text entry area|AXTextArea)\b/i.test(rest)) text = n;
    if (button === undefined && /^(button|checkbox|pop up button|menu button)\b/i.test(rest) &&
      !/close|minimi[sz]e|zoom|full ?screen|delete|quit|remove|revert|save|discard|don.t/i.test(rest)) button = n;
  }
  return { button, text };
}

/** The calls, in order, for one placement: [{ label, code }]. */
export function sequenceCalls({ button, text }) {
  const target = button ?? text;
  return [
    { label: 'read', code: `var app = await cua.getApp(${JSON.stringify(TEXTEDIT)})` },
    ...(target === undefined ? [] : [{ label: button !== undefined ? 'ax-click' : 'ax-click-text-area', code: `await app.click(${target})` }]),
    { label: 'coordinate-click', code: `await app.click(${JSON.stringify(COORDINATE)})` },
    { label: 'type', code: 'await app.typeText("vc7 ")' },
    { label: 'scroll', code: text !== undefined ? `await app.scroll(${text}, "down", 2)` : `await app.scroll(${JSON.stringify(COORDINATE)}, "down", 2)` },
  ];
}

export function summary(report) {
  const lines = [`VC7 engine cursor check: ${report.decision.words}`];
  for (const s of report.sightings) lines.push(`  ${s.placement.padEnd(10)} ${s.label.padEnd(20)} ${String(s.ms).padStart(5)} ms  ${s.appeared ? `window ${s.windows.map(w => `${w.owner}/${w.name || 'unnamed'} +${w.delayMs} ms for ${w.visibleMs} ms`).join('; ')}` : 'no engine window'}${s.error ? `  error: ${s.error}` : ''}`);
  const t = report.timing;
  lines.push(`  ${TIMED_CALLS} coordinate clicks: median ${t.withSampler.medianMs} ms with the sampler, ${t.withoutSampler.medianMs} ms without (difference ${t.deltaMs} ms)`);
  return lines.join('\n');
}

export function dryRunPlan(opts, { out }) {
  const helper = opts.helper ?? '<work>/capture-helper';
  return [
    'VC7 engine cursor check (dry run: nothing opened)',
    '1. refuse with /tmp/sleight-hold present, take /tmp/sleight-live.lock (no wait); refuse when TextEdit runs',
    ...(opts.helper ? [] : [`2. build: xcrun swiftc -module-cache-path <cache> ${tilde(join(ROOT, 'bench/hand/capture.swift'))} -o ${helper}`]),
    `3. /usr/bin/open -g -a TextEdit <work>/sleight-vc7-engine.txt --args -ApplePersistenceIgnoreState YES ...${opts.receipt ? `   (receipt ${tilde(opts.receipt)})` : ''}`,
    '4. sleight-mcp session: SLEIGHT_HAND=0 SLEIGHT_SURFACES=computer SLEIGHT_APPROVAL_PROMPT=client (TextEdit approvals only)',
    `5. ${helper} watch-engine ${SAMPLE_MS} 600 starts 1.5 s before the first engine call (the baseline) and stops 1.5 s after the last action`,
    `   acquire, then the background pass (TextEdit not activated), calls ${GAP_MS} ms apart:`,
    ...sequenceCalls({ button: '<button>', text: '<text area>' }).map(c => `     ${c.label}: ${c.code}`),
    `6. /usr/bin/open -b ${TEXTEDIT} (front), then the same calls; "no cursor" needs ${MIN_SAMPLES} samples and half of every call's span sampled`,
    `7. ${TIMED_CALLS} x await app.click(${JSON.stringify(COORDINATE)}) with the sampler and ${TIMED_CALLS} without, blocks of 5`,
    '8. quit the TextEdit this run started; release the lock',
    `9. report: ${tilde(join(out, 'engine-cursor.json'))}`,
  ];
}

async function main(argv) {
  let opts;
  try { opts = commonArgs(argv); } catch (error) { console.error(error.message); return 2; }
  const out = resolve(opts.out ?? join(logsRoot(), `vc7-engine-cursor-${stamp()}`));
  if (opts.dryRun) { console.log(dryRunPlan(opts, { out }).join('\n')); return 0; }
  const refusal = liveRefusal(opts, 'The engine cursor check');
  if (refusal) { console.error(refusal.message); return refusal.code; }
  const { acquireLiveLock } = await import('../live-lock.mjs');
  const { underLiveLock, textEditApproval } = await import('./h5-capture.mjs');
  return underLiveLock({ acquire: () => acquireLiveLock('/tmp/sleight-live.lock', { wait: false }) }, async ({ cleanups }) => {
    mkdirSync(out, { recursive: true });
    const work = mkdtempSync(join(tmpdir(), 'sleight-vc7-engine-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const live = await import('../compat/live.mjs');
    const { compileSwift, helperClient, openTextEditFixture } = await import('./vc7-live.mjs');
    const helperBin = opts.helper ?? await compileSwift(join(ROOT, 'bench/hand/capture.swift'), join(work, 'capture-helper'));
    const helper = helperClient(helperBin);
    const { target } = await openTextEditFixture({ helper, live, work, cleanups, receipt: opts.receipt, name: 'sleight-vc7-engine.txt' });
    const { openClient, textOf } = await import('../compat/client.mjs');
    const client = await openClient({ command: join(ROOT, 'plugins/sleight/bin/sleight-mcp'), approve: textEditApproval, timeoutMs: 60000, name: 'sleight-vc7-engine',
      env: { ...process.env, SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_SURFACES: 'computer', SLEIGHT_HAND: '0' } });
    cleanups.push(() => client.close());
    const call = async code => {
      const start = Date.now();
      try {
        const result = await client.call('js', { code, timeout_ms: 60000 });
        return { start, end: Date.now(), text: textOf(result), ...(result?.isError ? { error: textOf(result).split('\n')[0].slice(0, 200) } : {}) };
      } catch (error) { return { start, end: Date.now(), error: String(error.message).slice(0, 200) }; }
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const watchers = new Set();
    cleanups.push(() => { for (const w of watchers) w.kill('SIGKILL'); });
    const watch = seconds => {
      const child = spawn(helperBin, ['watch-engine', String(SAMPLE_MS), String(seconds)], { stdio: ['ignore', 'pipe', 'ignore'] });
      watchers.add(child);
      let text = '';
      child.stdout.on('data', c => { text += c; });
      const done = new Promise(r => child.once('close', () => { watchers.delete(child); r(parseWatch(text)); }));
      return { stop: () => { child.kill('SIGTERM'); return done; }, done };
    };

    // One sampler from before the first engine call until after the last action: its first samples are the baseline, and a
    // window already up then is evidence. watch(600) runs until stop(), however slow a call is.
    const main = watch(600);
    await sleep(1500);
    const baselineMs = Date.now();
    const calls = [];
    const first = await call(`var app = await cua.getApp(${JSON.stringify(TEXTEDIT)})`);
    calls.push({ label: 'acquire', placement: 'background', start: first.start, end: first.end, ...(first.error ? { error: first.error } : {}) });
    if (first.error) { await main.stop(); throw new Error(`the engine could not acquire TextEdit: ${first.error}`); }
    const elements = pickElements(first.text);
    for (const placement of ['background', 'front']) {
      if (placement === 'front') { await execute('/usr/bin/open', ['-b', TEXTEDIT], { timeout: 15000 }); await sleep(1000); }
      for (const step of sequenceCalls(elements)) {
        await sleep(GAP_MS);
        const timed = await call(step.code);
        calls.push({ label: step.label, placement, start: timed.start, end: timed.end, ...(timed.error ? { error: timed.error } : {}) });
      }
    }
    await sleep(1500);
    const samples = await main.stop();
    const front = (await helper(['windows'])).front;
    // The timing pass: blocks of 5 with the sampler, then 5 without, twice.
    const withMs = [], withoutMs = [], timingSightings = [];
    for (let block = 0; block < 4; block++) {
      const sampled = block % 2 === 0;
      const sampler = sampled ? watch(600) : undefined;
      if (sampled) await sleep(500);
      const blockCalls = [];
      for (let i = 0; i < 5; i++) {
        const timed = await call(`await app.click(${JSON.stringify(COORDINATE)})`);
        (sampled ? withMs : withoutMs).push(timed.end - timed.start);
        blockCalls.push({ label: `timed-${block * 5 + i + 1}`, placement: 'timing', start: timed.start, end: timed.end, ...(timed.error ? { error: timed.error } : {}) });
        await sleep(300);
      }
      if (sampler) timingSightings.push(...callSightings(await sampler.stop(), blockCalls)); // each block's own 500 ms baseline
    }
    const sightings = callSightings(samples, calls, { baselineMs });
    const baseline = baselineWindows(samples, baselineMs);
    const report = { target: { pid: target.pid, id: target.id }, elements, frontPidAfter: front, sampleMs: SAMPLE_MS,
      samples: samples.length, baselineSamples: samples.filter(s => s.t < baselineMs).length, baselineWindows: baseline, sightings,
      timing: timingStats(withMs, withoutMs), timingSightings: timingSightings.filter(s => s.appeared),
      decision: engineDecision([...sightings, ...timingSightings.filter(s => s.appeared)], { baseline, samples: samples.length }) };
    writeFileSync(join(out, 'engine-cursor.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(summary(report));
    console.log(`Report: ${tilde(join(out, 'engine-cursor.json'))}`);
    const failed = [...sightings, ...timingSightings].filter(s => s.error);
    // A failed call leaves the check unmeasured: no result line, so the runner reruns it.
    if (failed.length) { console.log(`VC7 INCOMPLETE: ${failed.length} engine call(s) failed`); return 1; }
    console.log(`VC7 RESULT: engine cursor ${report.decision.row}; timed clicks ${report.timing.withSampler.medianMs} vs ${report.timing.withoutSampler.medianMs} ms`);
    return 0;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
