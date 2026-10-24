import { StringDecoder } from 'node:string_decoder';

// Scan once, parse complete objects, and discard oversized rows through the next newline.
export class AgentClock {
  constructor(startedAt, now = Date.now) {
    this.startedAt = startedAt; this.now = now; this.pending = ''; this.depth = 0;
    this.quoted = false; this.escaped = false; this.dropping = false; this.endedAt = null;
    this.start = 'spawn'; this.startupIncluded = true; this.decoder = new StringDecoder('utf8');
  }
  event(event) {
    if (this.endedAt !== null) return;
    if (this.startupIncluded && event?.type === 'system' && event.subtype === 'init') {
      this.startedAt = this.now(); this.start = 'system/init'; this.startupIncluded = false;
    }
    if (['result', 'turn.completed', 'turn.failed'].includes(event?.type)) this.endedAt = this.now();
  }
  append(data) {
    if (this.endedAt !== null) return;
    const text = typeof data === 'string' ? data : this.decoder.write(data), cap = 1024 * 1024;
    let start = this.depth ? 0 : -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (this.dropping) { if (c === '\n') this.dropping = false; continue; }
      if (!this.depth) { if (c !== '{') continue; this.depth = 1; start = i; }
      else if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') this.quoted = false;
      } else if (c === '"') this.quoted = true;
      else if (c === '{' || c === '[') this.depth++;
      else if (c === '}' || c === ']') this.depth--;
      if (this.pending.length + i - start + 1 > cap) {
        this.pending = ''; this.depth = 0; this.quoted = false; this.escaped = false;
        this.dropping = c !== '\n'; start = -1;
      } else if (!this.depth) {
        try { this.event(JSON.parse(this.pending + text.slice(start, i + 1))); } catch {}
        this.pending = ''; start = -1;
      }
    }
    if (this.depth && start >= 0) this.pending += text.slice(start);
  }
  seconds() { return this.endedAt === null ? null : Math.max(0, this.endedAt - this.startedAt) / 1000; }
  timing() { return { start: this.start, end: 'final-result-event', startupIncluded: this.startupIncluded }; }
}

export const hasAgentSeconds = row => Number.isFinite(row.agentSeconds) && row.agentSeconds >= 0;
export function comparisonSeconds(row, { agentSeconds = false } = {}) {
  return agentSeconds && hasAgentSeconds(row) ? row.agentSeconds : row.seconds;
}

export function timingSummary(rows) {
  const out = {};
  for (const row of rows) {
    const s = out[row.arm] ??= { agentSeconds: 0, secondsFallback: 0, startupIncluded: { yes: 0, no: 0, unknown: 0 }, starts: {} };
    const agent = hasAgentSeconds(row), timing = agent ? row.agentTiming : row.secondsTiming;
    s[agent ? 'agentSeconds' : 'secondsFallback']++;
    s.startupIncluded[timing?.startupIncluded === true ? 'yes' : timing?.startupIncluded === false ? 'no' : 'unknown']++;
    const start = timing?.start ?? (agent ? 'unknown' : 'seconds');
    s.starts[start] = (s.starts[start] ?? 0) + 1;
  }
  return out;
}
