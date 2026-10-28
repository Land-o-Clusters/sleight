#!/usr/bin/env node
// Offline replay of captured Claude tool results. Reads files and never starts an engine or app.
import fs from 'node:fs';
import path from 'node:path';
import { browserCall, browserReply, nativeBindings } from '../plugins/sleight/lib/browser-call.mjs';
import { createResultBudget } from '../plugins/sleight/lib/result-budget.mjs';

const chars = content => content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0);
const section = (text, heading) => {
  const at = text.indexOf(heading);
  if (at < 0) return;
  const rest = text.slice(at + heading.length), end = rest.search(/\n# /);
  return heading + (end < 0 ? rest : rest.slice(0, end));
};

// `budget` passes options to both budgets, such as a test's declared documentation trust. By default the
// installed engine's bundled docs decide which items are canonical, as in production.
export function replayNativeDocs(events, budget = {}) {
  const before = createResultBudget({ platform: 'darwin', fullDocs: false, leanDocs: false, minDocs: false, ...budget });
  const after = createResultBudget({ platform: 'darwin', fullDocs: false, leanDocs: false, minDocs: false, ...budget });
  const pending = new Map(), seen = new Set(), browsers = new Set(), natives = new Set();
  const result = { calls: 0, nativeBlocks: 0, beforeChars: 0, afterChars: 0, policyChecks: 0, browserSafetyChecks: 0,
    policyPreserved: true, browserSafetyPreserved: true, firstBrowser: null };
  for (const event of events) {
    for (const block of event.message?.content || []) {
      if (event.type === 'assistant' && block.type === 'tool_use' && /(?:^|__)(?:js|js_reset)$/.test(block.name) && !seen.has(block.id)) {
        seen.add(block.id);
        const code = block.input?.code || '', reset = /js_reset$/.test(block.name);
        for (const name of nativeBindings(code, natives)) { natives.add(name); browsers.delete(name); }
        const plan = browserCall(code, browsers, natives);
        if (!reset) {
          result.firstBrowser ??= !!plan;
          after.request(block.id, { browser: !!plan, code });
        }
        pending.set(block.id, plan); result.calls++;
      }
      if (event.type !== 'user' || block.type !== 'tool_result' || !pending.has(block.tool_use_id)) continue;
      const id = block.tool_use_id, plan = pending.get(id);
      const content = Array.isArray(block.content) ? block.content : [{ type: 'text', text: String(block.content ?? '') }];
      const native = !!event.tool_use_result?._meta?.['codex/toolSurface']?.app?.appId;
      if (plan && browserReply({ result: event.tool_use_result })) for (const name of plan.handles) browsers.add(name);
      const baseline = before.apply(content), changed = after.apply(content, { id, native });
      const text = changed.filter(c => c.type === 'text').map(c => c.text).join('\n');
      for (const part of content.filter(c => c.type === 'text')) {
        if (/^## Computer Use\n/.test(part.text)) result.nativeBlocks++;
        const policy = part.text.indexOf('# Computer Use Confirmations Policy');
        if (policy >= 0) { result.policyChecks++; result.policyPreserved &&= text.includes(part.text.slice(policy)); }
        const safety = section(part.text, '# Browser Safety');
        if (safety) { result.browserSafetyChecks++; result.browserSafetyPreserved &&= text.includes(safety); }
      }
      result.beforeChars += chars(baseline); result.afterChars += chars(changed);
      after.finish(id); pending.delete(id);
    }
  }
  return { ...result, savedChars: result.beforeChars - result.afterChars };
}

if (import.meta.main) {
  const rows = [];
  for (const round of process.argv.slice(2)) {
    for (const entry of fs.readdirSync(round, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(round, entry.name, 'events.jsonl');
      if (!fs.existsSync(file)) continue;
      const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      rows.push({ round: path.basename(round), run: entry.name, ...replayNativeDocs(events) });
    }
  }
  console.log(JSON.stringify(rows, null, 2));
}
