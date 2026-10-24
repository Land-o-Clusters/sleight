// Numeric turn counters. Reuse the opt-in log's action receipts without enabling its writer or guard instrumentation.
import { ActionLog, browserActionCount } from './action-outcomes.mjs';
import { summarize } from './action-stats.mjs';
import { isLeaseRead } from './input-lease.mjs';

const paths = () => Object.fromEntries(['native', 'turbo', 'engine'].map(name => [name, { actions: 0, estimatedActions: 0, estimatedCalls: 0, actionMs: 0, timedActions: 0 }]));
const readCall = (name, args) => name === 'browser_read' || name === 'js' && isLeaseRead(args.code ?? '') ||
  name === 'browser_tabs' && args.do === 'list' || name === 'menu_bar' && args.op === 'apps' ||
  ['notifications', 'review_changes'].includes(name) && args.op === 'list';

// Private mod transport, just like frame() below. It never enters ordinary tool results.
export const unavailableStatsFrame = () => ({ stats: null,
  content: { type: 'text', text: 'sleight-turn-stats: {"unavailable":true}' } });

// Same heading-based split as the benchmark's anatomy report, with turbo trees and exact newline accounting.
export function textKinds(text) {
  const counts = { docs: 0, tree: 0, other: 0 }, lines = text.split('\n');
  let kind = 'other';
  for (const [i, line] of lines.entries()) {
    if (/^(?:## Computer Use|# Other Browser APIs|# API Reference|# Computer Use Confirmations Policy|# Browser Interaction Troubleshooting|<app_specific_instructions>|## Browser Computer Use)/.test(line)) kind = 'docs';
    else if (/^(?:Browser tab: |Window: |# Snapshot \d+|# Changes since snapshot \d+)/.test(line)) kind = 'tree';
    else if (kind === 'tree' && line === '') kind = 'other';
    counts[kind] += line.length + (i < lines.length - 1 ? 1 : 0);
  }
  return counts;
}

export class TurnStats extends ActionLog {
  constructor({ clock = () => performance.now(), limit = 2000 } = {}) {
    super({ clock, names: [], home: '/__sleight_stats_no_owner__' });
    this.limit = limit;
    this.reset();
  }
  reset() {
    this.total = { calls: 0, reads: 0, characters: 0, text: { docs: 0, tree: 0, other: 0 }, errors: 0, pending: 0, omitted: 0, unclassified: 0, toolMs: 0, paths: paths() };
    this.intervals = [];
    this.calls.clear(); this.waits.clear(); this.origins.clear();
  }
  // No disk, owner-name lookup, or retained result text.
  scrub() { return ''; }
  write() {}
  request(msg, { internal = false } = {}) {
    const name = msg?.params?.name, args = msg?.params?.arguments ?? {};
    if (msg?.method !== 'tools/call' || msg.id === undefined || typeof name !== 'string' ||
        internal || ['turn_ended', 'js_reset'].includes(name) || this.calls.has(msg.id)) return;
    if (this.total.calls >= this.limit || this.calls.size >= 200) { this.total.omitted++; return; }
    // Forwarding later replaces arguments.code with guard code. Estimates use only the caller's code.
    super.request({ ...msg, params: { ...msg.params, arguments: { ...args } } });
    this.total.calls++;
    if (readCall(name, args)) this.total.reads++;
  }
  reply(msg) {
    const call = msg?.method === undefined && this.calls.get(msg?.id);
    if (!call) return;
    const end = this.clock(), path = call.name.startsWith('browser_') ? 'turbo' :
      msg.result?._meta?.['codex/toolSurface']?.kind === 'browserUse' ? 'engine' : 'native';
    const { rows } = super.reply(msg);
    const error = !!msg.error || !!msg.result?.isError;
    if (error) this.total.errors++;
    const content = msg.error && typeof msg.error.message === 'string' ? [{ type: 'text', text: msg.error.message }] : msg.result?.content ?? [];
    for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') {
      this.total.characters += block.text.length;
      for (const [kind, size] of Object.entries(textKinds(block.text))) this.total.text[kind] += size;
    }
    if (Number.isFinite(call.start) && Number.isFinite(end) && end >= call.start) this.intervals.push([call.start, end]);
    // ActionLog's ms measures a whole call, including acquisitions and reads. It is never an action span.
    const summary = summarize(rows.map(row => ({ ...row, time: '1970-01-01T00:00:00.000Z' })), { now: 0 });
    let actions = summary.actions;
    const estimated = call.name === 'js' && !call.outcomes.length && !error;
    if (estimated && !actions) actions = browserActionCount(call.args.code);
    const part = this.total.paths[path];
    part.actions += actions;
    if (estimated && actions > 0) { part.estimatedActions += actions; part.estimatedCalls++; }
    for (const rec of call.outcomes) if (rec && rec.x !== 'refused' && Number.isFinite(rec.ms) && rec.ms >= 0 && rec.ms <= 86400000) {
      part.actionMs += rec.ms;
      part.timedActions++;
    }
  }
  finish() {
    let reach = -Infinity;
    for (const [a, b] of this.intervals.sort((x, y) => x[0] - y[0])) {
      if (b > reach) this.total.toolMs += b - Math.max(a, reach);
      reach = Math.max(reach, b);
    }
    this.total.toolMs = Math.round(this.total.toolMs);
    this.total.pending = this.calls.size;
    const result = this.total;
    this.reset();
    return result;
  }
  frame() {
    const stats = this.finish();
    return { stats, content: { type: 'text', text: 'sleight-turn-stats: ' + JSON.stringify(stats) } };
  }
}
