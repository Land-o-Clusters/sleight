// Offline counterfactual accounting, not action replay or a latency prediction.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const textOf = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n');
const toolName = name => name.split('__').at(-1);

export function projectTurns(events) {
  const messages = new Map(), calls = new Map();
  for (const event of events) {
    const message = event.message;
    if (event.type === 'assistant') {
      if (!messages.has(message.id)) messages.set(message.id, { id: message.id, calls: [] });
      for (const block of message.content ?? []) if (block.type === 'tool_use' && !calls.has(block.id)) {
        const call = { id: block.id, message: message.id, tool: toolName(block.name), input: block.input };
        calls.set(block.id, call); messages.get(message.id).calls.push(call);
      }
    }
    if (event.type === 'user') for (const block of message?.content ?? []) if (block.type === 'tool_result' && calls.has(block.tool_use_id)) {
      const call = calls.get(block.tool_use_id);
      call.result = textOf(block.content); call.error = block.is_error === true;
    }
  }
  const rows = [...calls.values()];
  const candidates = { urlRefusal: [], handleRefusal: [], cookieTurn: [] };
  for (const call of rows) {
    if (call.tool === 'browser_act' && call.input.steps?.some(step => step.do === 'navigate' && step.url !== undefined) &&
        /navigate with url is only for a stuck tab/.test(call.result ?? '')) candidates.urlRefusal.push(call.id);
    if (/^unknown or releasing owned tab\b/i.test(call.result ?? '')) candidates.handleRefusal.push(call.id);
    // Keep every image read. The installed relay delivers its image to Claude;
    // old benchmark transcripts that dropped images cannot justify omitting it.
    // A consent call must remain. Only move a standalone decline into the next action's message,
    // on the same tab. The message still sends separate tools if that action is browser_fill.
    if (/Decline confirmed/.test(call.result ?? '') && messages.get(call.message).calls.length === 1) {
      const next = rows[rows.indexOf(call) + 1];
      if (next && next.message !== call.message && next.input.tab === call.input.tab &&
          ['browser_fill', 'browser_act'].includes(next.tool)) candidates.cookieTurn.push(call.message);
    }
  }
  // Fixing a bad call in place does not save a call by itself. Count a refusal only
  // when a later successful retry supplies the same requested operation.
  const removableRefusals = [...candidates.urlRefusal, ...candidates.handleRefusal].filter(id => {
    const call = calls.get(id), later = rows.slice(rows.indexOf(call) + 1);
    if (candidates.urlRefusal.includes(id)) return call.input.steps.length === 1 && later.some(next =>
      next.tool === 'browser_open' && next.input.url === call.input.steps[0].url && !next.error && /^(?:tab )?t[\w-]+ https?:\/\//m.test(next.result ?? ''));
    const { tab, ...args } = call.input;
    return later.some(next => {
      const { tab: nextTab, ...nextArgs } = next.input;
      return next.tool === call.tool && tab === 't' + nextTab && isDeepStrictEqual(args, nextArgs) &&
        next.result && !next.error && !/unknown or releasing|Nothing was sent|not run|unconfirmed/i.test(next.result);
    });
  });
  const removed = new Set(removableRefusals);
  const empty = new Set([...messages.values()].filter(message => message.calls.length && message.calls.every(call => removed.has(call.id))).map(message => message.id));
  for (const id of candidates.cookieTurn) empty.add(id);
  return {
    messages: messages.size, calls: calls.size, candidates, removableRefusals,
    // Conditional: all selected refusals are avoided and the decline can share
    // the next action's message. No image read or sign-in handoff is removed.
    projectedMessages: messages.size - empty.size, projectedCalls: calls.size - removed.size,
    removedMessages: [...empty], removedCalls: [...removed],
    handoffAndKeepCallsRetained: rows.filter(call => call.tool === 'browser_tabs' && ['keep', 'handoff'].includes(call.input.do)).length,
    viewportScreenshotsKept: rows.filter(call => call.tool === 'browser_act' && call.input.observe === 'screenshot').length,
    cookieDeclinesKept: rows.filter(call => /Decline confirmed/.test(call.result ?? '')).length,
  };
}

export function studyBank(bank) {
  const rows = [];
  for (const round of readdirSync(bank).filter(name => /^rerun-chrome-haiku-[AB]-r\d+$/.test(name)).sort()) {
    for (const task of readdirSync(join(bank, round), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
      const file = join(bank, round, task, 'events.jsonl'), raw = readFileSync(file, 'utf8');
      rows.push({ round, task, sha256: createHash('sha256').update(raw).digest('hex'), ...projectTurns(raw.trim().split('\n').map(JSON.parse)) });
    }
  }
  return { bank: resolve(bank), assumptions: 'Conditional transcript edits only. Avoid refusals with matching successful retries and move standalone declines alongside the next same-tab action. Keep every image read, sign-in handoff and cookie decline. Screenshot, autocomplete and sign-in text have no deterministic turn reduction.', rows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('Usage: node scripts/tx1-turn-study.mjs BANK');
  console.log(JSON.stringify(studyBank(process.argv[2]), null, 2));
}
