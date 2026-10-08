// Where a benchmark run's time went. Claude Code's JSON result gives the total
// and the time in the model API; sleight's trace (SLEIGHT_TRACE) timestamps each
// tool call as it arrives from Claude, goes to the engine, comes back, and goes
// back to Claude. The rest is Claude Code itself: startup, MCP connect, hooks.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOOLS = new Set(['js', 'drag', 'hover', 'menu_bar', 'notifications', 'select_window', 'blocked_app', 'js_reset']);
// sleight's own tools run inside the relay process and never reach the engine.
const LOCAL = new Set(['drag', 'hover', 'menu_bar', 'notifications', 'select_window', 'blocked_app']);

// Tool-call timing from every trace-*.jsonl in dir. A local tool's time is its
// own (localMs). Any other call the relay answered itself (a refusal) has no
// engine time; all of it counts as relay time.
export function traceTiming(dir) {
  let files;
  try { files = readdirSync(dir).filter(f => /^trace-\d+\.jsonl$/.test(f)); } catch { return undefined; }
  if (!files.length) return undefined;
  const calls = new Map();
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const t = Date.parse(e.t), id = e.msg?.id;
      if (id === undefined) continue;
      const key = `${file}:${id}`;
      if (e.direction === 'call-received' && TOOLS.has(e.msg.params?.name) && !calls.has(key)) {
        calls.set(key, { tool: e.msg.params.name, received: t });
      }
      const call = calls.get(key);
      if (!call) continue;
      if (e.direction === 'to-server' && call.sent === undefined) call.sent = t;
      if (e.direction === 'from-server' && e.msg.method === undefined && call.sent !== undefined && call.engineDone === undefined) call.engineDone = t;
      if (e.direction === 'to-client' && e.msg.method === undefined) call.answered = t;
    }
  }
  const done = [...calls.values()].filter(c => c.answered !== undefined);
  const local = done.filter(c => LOCAL.has(c.tool)), relayed = done.filter(c => !LOCAL.has(c.tool));
  const sum = (list, f) => list.reduce((total, c) => total + f(c), 0);
  return {
    calls: done.length,
    refused: relayed.filter(c => c.sent === undefined).length,
    toolMs: sum(done, c => c.answered - c.received),
    engineMs: sum(relayed, c => c.sent !== undefined && c.engineDone !== undefined ? c.engineDone - c.sent : 0),
    relayMs: sum(relayed, c => c.sent === undefined || c.engineDone === undefined ? c.answered - c.received
      : (c.sent - c.received) + (c.answered - c.engineDone)),
    localMs: sum(local, c => c.answered - c.received),
  };
}

// One run's split: model, tools (engine and relay), and Claude Code's own time.
export function runTiming(out, trace) {
  if (!out?.duration_ms) return undefined;
  const timing = { totalMs: out.duration_ms, modelMs: out.duration_api_ms };
  if (trace) Object.assign(timing, trace, { otherMs: out.duration_ms - (out.duration_api_ms ?? 0) - trace.toolMs });
  return timing;
}
