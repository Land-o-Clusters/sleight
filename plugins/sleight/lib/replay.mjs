// Replay: a run Claude finished, turned into a script that runs again through sleight with no model.
//
//   sleight-mcp record <transcript.jsonl | session id> [out.json]
//   sleight-mcp replay <script.json> [--allow-positions]
//
// Recording reads the Claude Code transcript and keeps the sleight calls that succeeded, in order.
// An element number names an element only in the tree Claude saw, so each literal number becomes the
// element's AX ID or label from that tree, and the guard finds it again in the replay's own read (or
// stops when it can't find exactly one). Coordinates, drags and computed numbers depend on the
// window's layout, so a script with them replays only with --allow-positions.
// Replay starts a fresh sleight relay, the same one Claude Code runs, and stops at the first error.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasIdentifier, hasLabel } from './document-scope.mjs';

const PREFIX = 'mcp__plugin_sleight_computer__';
const REPLAYED = new Set(['js', 'drag']);
const ELEMENT_ACTIONS = 'click|setValue|performSecondaryAction|selectText|scroll';
const READ_ONLY = /^(?:\s*(?:await\s+)?(?:cua\.getState|cua\.listApps|[A-Za-z_$][\w$]*\.(?:getAXState|getScreenshot|getAXStateAndScreenshot))\([^;]*?\)\s*;?)+\s*$/;

// The line an element number had in the latest text Claude saw that lists it, with that text: a full
// tree line ("\t\t12 button Seven, ID: Seven") or an added line of a diff ("+ 12 button Seven").
// Removed diff lines carry old numbers and are skipped.
export function elementLine(texts, number) {
  const pattern = new RegExp(`^(?:\\+ ?)?\\t*${number} (.+)$`);
  for (let i = texts.length - 1; i >= 0; i--) {
    for (const line of texts[i].split('\n').reverse()) {
      if (line.startsWith('-')) continue;
      const m = pattern.exec(line);
      if (m) return { line: m[1], text: texts[i] };
    }
  }
  return undefined;
}

const lines = text => text.split('\n').map(l => /^(?:\+ ?)?\t*\d+ (.+)$/.exec(l)?.[1]).filter(Boolean);

// How the guard can find this element again: an ID or a label that only it has in the text it came
// from, or else its whole line.
export function elementSpec(found) {
  if (!found) return undefined;
  const { line, text } = found;
  const others = lines(text);
  const only = match => others.filter(match).length === 1;
  const id = /(?:^|, )ID: (.+?)(?=,|$)/.exec(line)?.[1];
  if (id && hasIdentifier(line, id) && only(l => hasIdentifier(l, id))) return { id };
  const described = /Description: (.+?)(?=,|$)/.exec(line)?.[1];
  const role = /^[a-z][a-z ]*/.exec(line)?.[0] ?? '';
  for (const label of [described, line.slice(role.length).split(',')[0]]) {
    if (label && hasLabel(line, label) && only(l => hasLabel(l, label))) return { label };
  }
  return only(l => l === line) ? { line } : undefined;
}

// Literal element numbers in action calls become specs; anything still tied to positions is listed.
export function portableCode(code, texts) {
  const unresolved = [];
  const rewritten = code.replace(new RegExp(`(\\.(?:${ELEMENT_ACTIONS})\\(\\s*)(\\d+)(\\s*[,)])`, 'g'), (whole, head, number, tail) => {
    const spec = elementSpec(elementLine(texts, Number(number)));
    if (!spec) { unresolved.push(Number(number)); return whole; }
    return head + JSON.stringify(spec) + tail;
  });
  const positions = [];
  if (unresolved.length) positions.push(`element ${unresolved.join(', ')} has no ID or label in the tree Claude saw`);
  if (new RegExp(`\\.(?:${ELEMENT_ACTIONS}|drag)\\(\\s*\\[`).test(rewritten)) positions.push('screen coordinates');
  if (new RegExp(`\\.(?:${ELEMENT_ACTIONS})\\(\\s*(?![\\[{"'\`\\d\\s])`).test(rewritten)) positions.push('a computed element number');
  return { code: rewritten, positions };
}

const textOf = content => Array.isArray(content)
  ? content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
  : typeof content === 'string' ? content : '';

// Steps from a transcript's parsed lines, in order: the sleight calls that succeeded.
export function recordSteps(entries) {
  const calls = new Map(), texts = [], steps = [], skipped = [];
  for (const entry of entries) {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith(PREFIX)) {
        calls.set(block.id, { tool: block.name.slice(PREFIX.length), input: block.input ?? {}, seen: texts.length });
      } else if (block?.type === 'tool_result' && calls.has(block.tool_use_id)) {
        const call = calls.get(block.tool_use_id);
        calls.delete(block.tool_use_id);
        const priorTexts = texts.slice(0, call.seen);
        texts.push(textOf(block.content));
        if (block.is_error) continue;
        if (!REPLAYED.has(call.tool)) { skipped.push(call.tool); continue; }
        if (call.tool === 'drag') {
          steps.push({ tool: 'drag', args: call.input, positions: ['drag points'] });
          continue;
        }
        const code = String(call.input.code ?? '');
        // Reads only show Claude the window; the guard reads for itself before each action.
        if (READ_ONLY.test(code) && !/getApp\(/.test(code)) continue;
        const portable = portableCode(code, priorTexts);
        steps.push({ tool: 'js', args: { code: portable.code, ...(call.input.title ? { title: call.input.title } : {}) }, positions: portable.positions });
      }
    }
  }
  return { steps, skipped };
}

// A session id resolves to its transcript under ~/.claude/projects.
export function transcriptPath(source, home = homedir()) {
  if (existsSync(source)) return source;
  const root = join(home, '.claude', 'projects');
  for (const project of existsSync(root) ? readdirSync(root) : []) {
    const candidate = join(root, project, `${source}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no transcript at ${source}, and no session ${source} under ~/.claude/projects`);
}

export function record(source) {
  const path = transcriptPath(source);
  const entries = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
  const { steps, skipped } = recordSteps(entries);
  return { sleightReplay: 1, recorded: new Date().toISOString(), steps, ...(skipped.length ? { skipped } : {}) };
}

// Runs a script's steps through a relay. `server` is { send, onMessage, close }; `ask` answers an
// approval prompt with true or false; `log` gets one line per step.
export async function replay(script, { server, ask, log = () => {}, allowPositions = false }) {
  const steps = script?.steps;
  if (script?.sleightReplay !== 1 || !Array.isArray(steps)) throw new Error('not a sleight replay script');
  const positional = steps.map((s, i) => [i + 1, s]).filter(([, s]) => s.positions?.length);
  if (positional.length && !allowPositions) {
    throw new Error(`these steps depend on the window's layout, so replay could act in the wrong place: ${positional.map(([i, s]) => `step ${i} (${s.positions.join('; ')})`).join(', ')}. Run with --allow-positions only if the windows are where they were when you recorded it`);
  }
  let nextId = 0;
  const pending = new Map();
  server.onMessage(async msg => {
    if (msg.method && msg.id !== undefined) {
      // Approvals go to the person running the replay. Anything else is declined.
      const isApproval = msg.method === 'elicitation/create' && !Object.keys(msg.params?.requestedSchema?.properties ?? {}).length ||
        msg.params?._meta?.connector_id === 'computer-use';
      const yes = isApproval && await ask(msg.params?.message ?? 'Allow Computer Use?');
      server.send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'elicitation/create' ? { action: yes ? 'accept' : 'decline', content: {} } : {} });
    } else if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const request = (method, params) => new Promise(resolve => { const id = nextId++; pending.set(id, resolve); server.send({ jsonrpc: '2.0', id, method, params }); });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-replay', version: '1' } });
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await request('tools/list', {});
  const meta = { 'x-codex-turn-metadata': JSON.stringify({ session_id: randomUUID(), turn_id: randomUUID() }) };
  try {
    for (const [index, step] of steps.entries()) {
      const started = Date.now();
      const reply = await request('tools/call', { name: step.tool, arguments: step.args, _meta: meta });
      const text = textOf(reply.result?.content);
      const failed = reply.error || reply.result?.isError;
      log(`step ${index + 1}/${steps.length} ${step.tool}${step.args?.title ? ` (${step.args.title})` : ''}: ${failed ? 'failed' : 'ok'} in ${Date.now() - started} ms`);
      if (failed) return { ok: false, step: index + 1, error: reply.error?.message ?? text };
    }
    return { ok: true, steps: steps.length };
  } finally { server.close(); }
}

// A relay process over stdio, as Claude Code starts it.
export function relayServer(bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sleight-mcp')) {
  const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SLEIGHT_APPROVAL_PROMPT: 'client' } });
  const output = createInterface({ input: child.stdout });
  // The relay notes each pre-approved call; once per line is enough here.
  const said = new Set();
  createInterface({ input: child.stderr }).on('line', line => { if (!said.has(line)) { said.add(line); process.stderr.write(line + '\n'); } });
  return {
    send: msg => child.stdin.write(JSON.stringify(msg) + '\n'),
    onMessage: handler => output.on('line', line => { let msg; try { msg = JSON.parse(line); } catch { return; } handler(msg); }),
    close: () => child.stdin.end(),
  };
}
