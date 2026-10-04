import { windowFromText, documentKey } from './document-scope.mjs';
import { isLeaseRead } from './input-lease.mjs';

// Describes returned AX evidence only. No engine calls, permissions or guards.
function snapshot(text) {
  // The engine sometimes joins its diff's last value directly to our guard's header.
  const headers = [...text.matchAll(/Window: "(?:[^"\\]|\\.)*", App: [^\r\n]+\r?\n(?=\d+ )/g)];
  if (!headers.length) {
    const window = windowFromText(text);
    return window ? { window } : {};
  }
  const sections = headers.map((h, i) => text.slice(h.index, headers[i + 1]?.index));
  const windows = sections.map(windowFromText);
  if (!windows.length || windows.some(w => !w)) return {};
  if (new Set(windows.map(documentKey)).size !== 1) return { ambiguous: true };
  const section = sections.at(-1);
  // Diff fragments do not prove that an absent role closed or a tree stayed equal.
  const rows = section.split(/\r?\n/).filter(line => /^\s*\d+ /.test(line));
  const full = /^\d+ (?:standard window|dialog|sheet)\b/.test(rows[0] ?? '');
  const modal = rows.map(line => /^\s*\d+ (sheet|dialog)\b/.exec(line)?.[1]).find(Boolean);
  return { window: windows.at(-1), full, tree: section.slice(section.search(/^\d+ /m)).trimEnd(), modal };
}

const label = w => w ? `${JSON.stringify(w.title.slice(0, 100))} in ${w.app.slice(0, 80)}` : 'unknown';

export class ActionNotes {
  windows = new Map();
  last;
  pending = new Map();

  start(id, code) {
    const concurrent = this.pending.size > 0;
    if (concurrent) for (const call of this.pending.values()) call.concurrent = true;
    this.pending.set(id, { action: !isLeaseRead(code), before: new Map(this.windows), last: this.last, concurrent });
  }

  clear() { this.windows.clear(); this.last = undefined; this.pending.clear(); }

  finish(id, msg) {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    const text = (msg.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const observed = snapshot(text);
    const before = call.before.get(observed.window?.app);
    const failed = !!(msg.error || msg.result?.isError);
    let change = 'unknown (no comparable AX baseline)';
    let modal = 'unknown';
    if (failed) change = 'unknown (engine or guard error; action may have occurred)';
    else if (call.concurrent) change = 'unknown (overlapping calls)';
    else if (observed.ambiguous) change = 'unknown (multiple windows returned)';
    else if (observed.full && before?.full) change = documentKey(observed.window) === documentKey(before.window) && observed.tree === before.tree ? 'unchanged (AX)' : 'changed (AX)';
    else if (!observed.full && /^There has been no change in the accessibility tree\.?\s*$/m.test(text)) change = 'unchanged (engine AX report)';
    if (!failed && !call.concurrent && observed.full) {
      modal = observed.modal
        ? `${observed.modal} ${before?.full ? before.modal === observed.modal ? 'present' : 'opened' : 'present (opening unknown)'}`
        : before?.modal ? 'closed' : 'none';
    }
    if (failed || call.concurrent || observed.ambiguous || (call.action && !observed.full)) this.windows.clear();
    if (!failed && !call.concurrent && observed.full) {
      this.windows.set(observed.window.app, observed);
      this.last = observed.window;
    }
    if (!call.action) return;
    const window = observed.window ? label(observed.window)
      : `unknown${call.last ? ` (last observed: ${label(call.last)})` : ''}`;
    return `Action result: UI ${change}; window: ${window}; dialog/sheet: ${modal}.`;
  }
}
