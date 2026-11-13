// Where a benchmark run's time went. Claude Code's JSON result gives its own duration
// and the time in the model API; sleight's trace (SLEIGHT_TRACE) timestamps each
// tool call as it arrives from Claude, goes to the engine, comes back, and goes
// back to Claude.
//
// Three parts add up to the run's elapsed time: tool time (wall time with at least
// one call open, overlapping calls counted once), the rest of Claude Code's duration
// (model streaming, startup, MCP connect, hooks) and the harness outside Claude Code
// (spawning it, the check). API time overlaps the second part and parts of the
// others, so it is reported beside them and never subtracted.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = new Set(['js', 'drag', 'hover', 'menu_bar', 'notifications', 'select_window', 'js_reset', 'open_file']);
// sleight's own tools run inside the relay process and never reach the engine. open_file then reads
// the opened window through the engine, which counts as its engine time.
const LOCAL = new Set(['drag', 'hover', 'menu_bar', 'notifications', 'select_window', 'open_file']);

// Total length of a list of [start, end] intervals, overlaps counted once.
export function intervalUnion(intervals) {
  let total = 0, start, end;
  for (const [a, b] of intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).sort((x, y) => x[0] - y[0])) {
    if (start === undefined) [start, end] = [a, b];
    else if (a <= end) end = Math.max(end, b);
    else { total += end - start; [start, end] = [a, b]; }
  }
  return start === undefined ? total : total + end - start;
}

// Tool-call timing from every trace-*.jsonl in dir. toolMs adds each call's time
// (engine + relay + local); toolWallMs counts calls that overlap once. A local
// tool's time is its own (localMs). Any other call the relay answered itself (a
// refusal) has no engine time; all of it counts as relay time.
export function traceTiming(dir) {
  let files;
  try { files = readdirSync(dir).filter(f => /^trace-\d+\.jsonl$/.test(f)); } catch { return undefined; }
  if (!files.length) return undefined;
  const calls = new Map();
  // An acquisition the relay sends ahead of the call's actions travels under its own id
  // (`acquisition-split`). Its engine round trip belongs to the call, as engine time.
  const acquisitions = new Map();
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const t = Date.parse(e.t), id = e.msg?.id;
      if (id === undefined) continue;
      const key = `${file}:${id}`;
      if (e.direction === 'acquisition-split') { acquisitions.set(`${file}:${e.msg.acquisition}`, key); continue; }
      // Traces from before open_file logged its read: the read goes to the engine while that call waits.
      if (e.direction === 'to-server' && /^sleight-open-file-/.test(id) && !acquisitions.has(key)) {
        const waiting = [...calls.entries()].filter(([k, c]) => k.startsWith(`${file}:`) && c.tool === 'open_file' &&
          c.answered === undefined && ![...acquisitions.values()].includes(k));
        if (waiting.length === 1) acquisitions.set(key, waiting[0][0]);
      }
      const owner = calls.get(acquisitions.get(key));
      if (owner) {
        if (e.direction === 'to-server' && owner.acquireSent === undefined) owner.acquireSent = t;
        if (e.direction === 'from-server' && e.msg.method === undefined && owner.acquireSent !== undefined && owner.acquireDone === undefined) owner.acquireDone = t;
        continue;
      }
      if (e.direction === 'call-received' && TOOLS.has(e.msg.params?.name) && !calls.has(key)) {
        calls.set(key, { tool: e.msg.params.name, received: t });
      }
      const call = calls.get(key);
      if (!call) continue;
      if (e.direction === 'guard-read' && Number.isFinite(e.msg.ms) && e.msg.ms >= 0) {
        (call.guardReads ??= []).push(e.msg);
      }
      if (e.direction === 'to-server' && call.sent === undefined) call.sent = t;
      if (e.direction === 'from-server' && e.msg.method === undefined && call.sent !== undefined && call.engineDone === undefined) call.engineDone = t;
      if (e.direction === 'to-client' && e.msg.method === undefined) call.answered = t;
    }
  }
  const done = [...calls.values()].filter(c => c.answered !== undefined);
  const local = done.filter(c => LOCAL.has(c.tool)), relayed = done.filter(c => !LOCAL.has(c.tool));
  const sum = (list, f) => list.reduce((total, c) => total + f(c), 0);
  const guardReads = done.flatMap(c => c.guardReads ?? []);
  const acquired = c => c.acquireSent !== undefined && c.acquireDone !== undefined;
  const acquireMs = c => acquired(c) ? c.acquireDone - c.acquireSent : 0;
  return {
    calls: done.length,
    refused: relayed.filter(c => c.sent === undefined).length,
    toolMs: sum(done, c => c.answered - c.received),
    toolWallMs: intervalUnion(done.map(c => [c.received, c.answered])),
    engineMs: sum(relayed, c => (c.sent !== undefined && c.engineDone !== undefined ? c.engineDone - c.sent : 0) + acquireMs(c)) +
      sum(local, acquireMs),
    relayMs: sum(relayed, c => (c.sent === undefined || c.engineDone === undefined ? c.answered - c.received
      : (c.sent - c.received) + (c.answered - c.engineDone)) - acquireMs(c)) +
      sum(local, c => acquired(c) ? c.answered - c.acquireDone : 0),
    localMs: sum(local, c => (acquired(c) ? c.acquireSent : c.answered) - c.received),
    ...(guardReads.length ? { guardReads: guardReads.length,
      guardReadMs: sum(guardReads, r => r.ms), guardReadFailures: guardReads.filter(r => r.failed).length } : {}),
  };
}

// One run's split. elapsedMs is the harness's own clock around the run (what the
// score counts). Additive: toolWallMs + outsideToolsMs = totalMs, and
// totalMs + harnessMs = elapsedMs. modelMs is API time and overlaps them.
// The parts can only go below zero on a clock error; they stop at zero.
export function runTiming(out, trace, elapsedMs) {
  if (!out?.duration_ms) return undefined;
  const timing = { totalMs: out.duration_ms, modelMs: out.duration_api_ms };
  if (trace) Object.assign(timing, trace, { outsideToolsMs: Math.max(0, out.duration_ms - trace.toolWallMs) });
  return withElapsed(timing, elapsedMs);
}

// Where the harness tail goes, in ms from the run's start (the clock elapsedMs counts from): the driver's last
// output, its exit, its pipes closing, its process group gone. No effect on the figures above.
export function withStamps(timing, stamps, started) {
  if (!timing || !stamps || !Number.isFinite(started)) return timing;
  const at = key => (Number.isFinite(stamps[key]) ? stamps[key] - started : undefined);
  timing.tailStamps = { stdoutMs: at('stdoutAt'), exitMs: at('exitAt'), closeMs: at('closeAt'), groupGoneMs: at('groupGoneAt') };
  return timing;
}

export function withElapsed(timing, elapsedMs) {
  if (timing?.totalMs && Number.isFinite(elapsedMs)) Object.assign(timing, { elapsedMs, harnessMs: Math.max(0, elapsedMs - timing.totalMs) });
  return timing;
}

// The additive split of a saved row, for rows written before toolWallMs and
// elapsedMs existed too: trace (a fresh traceTiming of the run's evidence) wins
// over the row's saved figures, and an old row's elapsed time is its rounded seconds (never
// below totalMs).
// Old rows without a trace fall back to toolMs, which counts overlapping calls twice.
export function runSplit(row, trace) {
  const t = row?.timing;
  if (!t?.totalMs || !Number.isFinite(row.seconds)) return undefined;
  const elapsedMs = t.elapsedMs ?? Math.max(Math.round(row.seconds * 1000), t.totalMs);
  const toolMs = Math.min(t.totalMs, trace?.toolWallMs ?? t.toolWallMs ?? t.toolMs ?? 0);
  return { elapsedMs, toolMs, outsideToolsMs: t.totalMs - toolMs, harnessMs: elapsedMs - t.totalMs, apiMs: t.modelMs ?? null,
    calls: trace?.calls ?? t.calls ?? null, overlapUnknown: !trace && t.toolWallMs === undefined };
}

// node bench/timing.mjs results.json [evidence-dir] [arm]: per-task medians of the split.
// The evidence dir holds <arm>-<task>-<run>/trace-*.jsonl; without it, saved figures.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, evidence, arm = 'sleight'] = process.argv.slice(2);
  const rows = JSON.parse(readFileSync(file, 'utf8')).results.filter(r => r.arm === arm && !r.skipped);
  const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const sec = ms => Number.isFinite(ms) ? (ms / 1000).toFixed(1) : '–';
  console.log('| Task | Runs | Elapsed s | Tools s | Outside tools s | Harness s | API s (overlaps) | Calls |');
  console.log('|---|---|---|---|---|---|---|---|');
  const splits = rows.map(r => ({ task: r.task, ...runSplit(r, evidence ? traceTiming(join(evidence, `${arm}-${r.task}-${r.run}`)) : undefined) }));
  for (const task of [...new Set(rows.map(r => r.task))]) {
    const ss = splits.filter(s => s.task === task && Number.isFinite(s.elapsedMs));
    const m = key => median(ss.map(s => s[key]));
    console.log(`| ${task} | ${ss.length} | ${sec(m('elapsedMs'))} | ${sec(m('toolMs'))} | ${sec(m('outsideToolsMs'))} | ${sec(m('harnessMs'))} | ${sec(m('apiMs'))} | ${m('calls')} |`);
  }
  const bad = splits.filter(s => [s.toolMs, s.outsideToolsMs, s.harnessMs].some(x => x < 0) || s.toolMs + s.outsideToolsMs + s.harnessMs !== s.elapsedMs);
  console.log(`\n${splits.length} runs; ${bad.length} with a negative part or parts not adding to elapsed; ${splits.filter(s => s.overlapUnknown).length} without overlap data.`);
}
