// The same boundary for CLI arms: spawn to the final result event, before collection.
export class AgentClock {
  constructor(startedAt, now = Date.now) { this.startedAt = startedAt; this.now = now; this.pending = ''; this.whole = ''; this.lines = false; this.endedAt = null; }
  event(event) {
    if (!['result', 'turn.completed', 'turn.failed'].includes(event?.type)) return;
    this.endedAt = this.now();
  }
  append(data) {
    this.pending += String(data);
    if (!this.lines && this.whole.length < 32000000) this.whole += String(data);
    let end;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (typeof event?.type === 'string') { this.lines = true; this.whole = ''; }
        this.event(event);
      } catch {}
    }
    // --output-format json can be one object without a trailing newline.
    if (this.endedAt === null && !this.lines && this.whole.trimEnd().endsWith('}')) { try { this.event(JSON.parse(this.whole)); } catch {} }
  }
  seconds() { return this.endedAt === null ? null : Math.max(0, this.endedAt - this.startedAt) / 1000; }
}

export function comparisonSeconds(row, { agentSeconds = false } = {}) {
  return agentSeconds && Number.isFinite(row.agentSeconds) && row.agentSeconds >= 0 ? row.agentSeconds : row.seconds;
}
