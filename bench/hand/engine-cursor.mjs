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

/** Per call ({ label, start, end } in ms): whether a drawn engine window that the baseline (samples before the first call)
 *  didn't have appeared between the call's start and 500 ms after its end, how long after the start it first showed, how long
 *  it stayed, and what it was (owner, name, layer, sharing, bounds). */
export function callSightings(samples, calls, { afterMs = 500 } = {}) {
  const first = calls.length ? Math.min(...calls.map(c => c.start)) : Infinity;
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
    return { label: call.label, placement: call.placement, ms: call.end - call.start, samples: inside.length, appeared: windows.length > 0, windows,
      ...(call.error ? { error: call.error } : {}) };
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

/** R4's decision table, as far as this run can tell. Whether a window shows in the engine's own screenshots is not tested here. */
export function engineDecision(sightings) {
  const seen = sightings.filter(s => s.appeared);
  if (!sightings.length) return { row: 'no-data', words: 'no calls ran' };
  if (!seen.length) return { row: 'no-cursor', words: `no engine window appeared during ${sightings.length} calls: the agent cursor is the only cursor on this Mac (the flag may differ on other Macs)` };
  const names = [...new Set(seen.flatMap(s => s.windows.map(w => `${w.owner}/${w.name || 'unnamed'}`)))];
  return { row: 'cursor-window', words: `an engine window appeared during ${seen.length} of ${sightings.length} calls (${names.join(', ')}): check whether the engine's screenshots include it before choosing the ring's look` };
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
    `5. background pass (TextEdit not activated): ${helper} watch-engine ${SAMPLE_MS} <s> while these run ${GAP_MS} ms apart:`,
    ...sequenceCalls({ button: '<button>', text: '<text area>' }).map(c => `     ${c.label}: ${c.code}`),
    `6. /usr/bin/open -b ${TEXTEDIT} (front), then the same calls with the sampler`,
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

    const first = await call(`var app = await cua.getApp(${JSON.stringify(TEXTEDIT)})`);
    if (first.error) throw new Error(`the engine could not acquire TextEdit: ${first.error}`);
    const elements = pickElements(first.text);
    const calls = [], samples = [];
    for (const placement of ['background', 'front']) {
      if (placement === 'front') { await execute('/usr/bin/open', ['-b', TEXTEDIT], { timeout: 15000 }); await sleep(1000); }
      const sequence = sequenceCalls(elements);
      const sampler = watch(Math.ceil((sequence.length * (GAP_MS + 4000) + 4000) / 1000));
      await sleep(1000); // baseline samples before the first call
      for (const step of sequence) {
        const timed = await call(step.code);
        calls.push({ label: step.label, placement, start: timed.start, end: timed.end, ...(timed.error ? { error: timed.error } : {}) });
        await sleep(GAP_MS);
      }
      samples.push(...await sampler.stop());
    }
    const front = (await helper(['windows'])).front;
    // The timing pass: blocks of 5 with the sampler, then 5 without, twice.
    const withMs = [], withoutMs = [], timingSightings = [];
    for (let block = 0; block < 4; block++) {
      const sampled = block % 2 === 0;
      const sampler = sampled ? watch(60) : undefined;
      if (sampled) await sleep(500);
      const blockCalls = [];
      for (let i = 0; i < 5; i++) {
        const timed = await call(`await app.click(${JSON.stringify(COORDINATE)})`);
        (sampled ? withMs : withoutMs).push(timed.end - timed.start);
        blockCalls.push({ label: `timed-${block * 5 + i + 1}`, placement: 'timing', start: timed.start, end: timed.end, ...(timed.error ? { error: timed.error } : {}) });
        await sleep(300);
      }
      if (sampler) timingSightings.push(...callSightings(await sampler.stop(), blockCalls));
    }
    const sightings = callSightings(samples, calls);
    const report = { target: { pid: target.pid, id: target.id }, elements, frontPidAfter: front, sampleMs: SAMPLE_MS,
      samples: samples.length, sightings, timing: timingStats(withMs, withoutMs), timingSightings: timingSightings.filter(s => s.appeared),
      decision: engineDecision([...sightings, ...timingSightings]) };
    writeFileSync(join(out, 'engine-cursor.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(summary(report));
    console.log(`VC7 RESULT: engine cursor ${report.decision.row}; timed clicks ${report.timing.withSampler.medianMs} vs ${report.timing.withoutSampler.medianMs} ms`);
    console.log(`Report: ${tilde(join(out, 'engine-cursor.json'))}`);
    return [...sightings, ...timingSightings].some(s => s.error) ? 1 : 0;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
