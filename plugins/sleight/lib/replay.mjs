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
import { PassThrough } from 'node:stream';
import { documentKey, hasIdentifier, hasLabel, windowFromText } from './document-scope.mjs';

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

const ACTIONS = new Set(['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText']);

// A deliberately small grammar: awaited app calls with JSON arguments, separated by semicolons.
// Anything else may have sent input that a missing-element error doesn't account for. Do not guess.
function literalCalls(code = '') {
  const calls = [], pattern = /\s*await\s+([A-Za-z_$][\w$]*)\.(click|drag|scroll|selectText|setValue|performSecondaryAction|paste|pressKey|typeText|getAXState|getScreenshot|getAXStateAndScreenshot)\(\s*(.*?)\s*\)\s*(?:;|$)/sy;
  let at = 0;
  while (code.slice(at).trim()) {
    pattern.lastIndex = at;
    const found = pattern.exec(code);
    if (!found) return;
    let args;
    try { args = JSON.parse('[' + found[3] + ']'); } catch { return; }
    calls.push({ handle: found[1], method: found[2], args });
    at = pattern.lastIndex;
  }
  return calls;
}

function missingPrefix(call) {
  const spec = call?.args[0];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return;
  const key = ['id', 'label', 'line'].find(key => typeof spec[key] === 'string');
  if (!key || !['click', 'scroll', 'selectText', 'setValue', 'performSecondaryAction'].includes(call.method)) return;
  return `sleight stopped before ${call.method}: no element with ${key === 'id' ? 'ID' : key} ${JSON.stringify(spec[key])} in this window. Use an element number or another ID from the window below.`;
}

function retryPrefix(step) {
  if (step.tool !== 'js') return;
  const inputs = literalCalls(step.args.code)?.filter(c => ACTIONS.has(c.method));
  const prefix = missingPrefix(inputs?.[0]);
  // A later action with the same selector could be the one that stopped after earlier input.
  return prefix && !inputs.slice(1).some(c => missingPrefix(c) === prefix) ? prefix : undefined;
}

function validateReplay(script, allowPositions, waitMs) {
  const steps = script?.steps;
  if (script?.sleightReplay !== 1 || !Array.isArray(steps)) throw new Error('not a sleight replay script');
  if (typeof allowPositions !== 'boolean') throw new Error('allowPositions must be a boolean');
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw new Error('waitMs must be an integer from 0 to 60000');
  if (steps.some(s => !s || !REPLAYED.has(s.tool) || !s.args || (s.tool === 'js' && typeof s.args.code !== 'string'))) throw new Error('replay steps must be js or drag calls with arguments');
  const positional = steps.map((s, i) => [i + 1, { ...s, positions: [...new Set([
    ...(s.positions ?? []), ...(s.tool === 'drag' ? ['drag points'] : portableCode(s.args.code, []).positions),
  ])] }]).filter(([, s]) => s.positions.length);
  if (positional.length && !allowPositions) {
    throw new Error(`these steps depend on the window's layout, so replay could act in the wrong place: ${positional.map(([i, s]) => `step ${i} (${s.positions.join('; ')})`).join(', ')}. Run with --allow-positions only if the windows are where they were when you recorded it`);
  }
  return steps;
}

const realClock = { now: () => performance.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };

// Shared by the CLI and Claude's tool. `call` reaches the ordinary relay; it never bypasses guards.
export async function replaySteps(script, { call, log = () => {}, allowPositions = false, waitMs = 5000, clock = realClock, cancelled = () => false, window }) {
  const steps = validateReplay(script, allowPositions, waitMs), waits = [];
  let expectedWindow = window;
  let handle;
  for (const [index, step] of steps.entries()) {
    const acquisition = step.tool === 'js' && /^\s*(?:let|const|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.getApp\([^;]*\)\s*;?\s*$/.exec(step.args.code);
    const calls = step.tool === 'js' ? literalCalls(step.args.code) : undefined;
    handle = acquisition?.[1];
    const prefix = retryPrefix(step), started = clock.now();
    let reply, waitingAt, waitedMs = 0;
    while (true) {
      try {
        reply = cancelled() ? { error: { message: 'Replay stopped by the client. Read the window before acting.' } } : await call(step.tool, step.args);
      } catch (error) { reply = { error: { message: error.message } }; }
      if (waitingAt !== undefined) waitedMs = Math.round(clock.now() - waitingAt);
      const message = textOf(reply.result?.content);
      const missing = prefix && !reply.error && reply.result?.isError && (message === prefix || message.startsWith(prefix + '\n'));
      // The first refused input can supply its own window. Do not insert a read that could
      // consume the relay's one-call flow exception before an approved identical retry.
      if (index === 0 && expectedWindow === undefined && missing) expectedWindow = windowFromText(message);
      if (!waitMs || !missing || !expectedWindow ||
          documentKey(windowFromText(message)) !== documentKey(expectedWindow) || cancelled()) break;
      waitingAt ??= clock.now();
      const remaining = waitMs - (clock.now() - waitingAt);
      if (remaining <= 0) break;
      await clock.sleep(Math.min(250, remaining));
      waitedMs = Math.round(clock.now() - waitingAt);
      if (clock.now() - waitingAt >= waitMs) break;
    }
    const failed = reply.error || reply.result?.isError;
    waits.push({ step: index + 1, waitedMs });
    log(`step ${index + 1}/${steps.length} ${step.tool}${step.args?.title ? ` (${step.args.title})` : ''}: ${failed ? 'failed' : 'ok'} in ${Math.round(clock.now() - started)} ms (waited ${waitedMs} ms)`);
    if (failed) {
      const error = reply.error?.message ?? textOf(reply.result?.content);
      const stopped = calls?.filter(c => { const prefix = missingPrefix(c); return prefix && error.startsWith(prefix); });
      const candidates = stopped?.length ? stopped : calls?.filter(c => ACTIONS.has(c.method));
      const handles = [...new Set((candidates?.length ? candidates : calls)?.map(c => c.handle) ?? [])];
      if (!acquisition && handles.length === 1) handle = handles[0];
      let window = null, windowError = 'No app handle could be determined. Read the intended window with js.';
      // Any intervening js call clears the relay's pending one-call flow exception.
      const flowRefusal = /^Flow rules:/m.test(error);
      if (flowRefusal) windowError = 'Use flow_exception before another js call; a snapshot would discard the pending user decision.';
      if (handle && !acquisition && !cancelled() && !flowRefusal) {
        try {
          const snapshot = await call('js', { code: `await ${handle}.getAXState({ disableDiffing: true });`, title: 'Read the window where replay stopped' });
          if (snapshot.error || snapshot.result?.isError) windowError = snapshot.error?.message ?? textOf(snapshot.result?.content);
          else { window = textOf(snapshot.result?.content); windowError = undefined; }
        } catch (error) { windowError = error.message; }
      }
      return { ok: false, step: index + 1, error, remaining: steps.slice(index), waits, window, ...(windowError ? { windowError } : {}) };
    }
    expectedWindow = windowFromText(textOf(reply.result?.content));
  }
  return { ok: true, steps: steps.length, waits };
}

// Runs through a fresh stdio relay for the CLI. Claude's tool uses replaySteps in its own session.
export async function replay(script, { server, ask = async () => false, ...options }) {
  validateReplay(script, options.allowPositions ?? false, options.waitMs ?? 5000);
  if (typeof server === 'function') server = server();
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
  const meta = { 'x-codex-turn-metadata': JSON.stringify({ session_id: randomUUID(), turn_id: randomUUID() }) };
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-replay', version: '1' } });
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await request('tools/list', {});
    return await replaySteps(script, { ...options, call: (name, args) => request('tools/call', { name, arguments: args, _meta: meta }) });
  } finally { server.close(); }
}

export const REPLAY_TOOL = {
  name: 'replay',
  _meta: { 'anthropic/alwaysLoad': true },
  description: 'Run a recorded sleight script in this session. Pass the JSON script made by sleight-mcp record. ' +
    'On a stop, returns the 1-based step, error, remaining steps (including the stopped step), each step\'s wait and a fresh full window read when available. ' +
    'Finish from that window using js and the existing app handles; a stopped batch may have sent some input, so inspect it before continuing. ' +
    'The user approves apps as for js. Positions require allowPositions. Missing first elements wait up to waitMs (default 5000, 0 disables); ' +
    'calls that may have sent input stop without retrying.',
  inputSchema: {
    type: 'object',
    properties: {
      script: { type: 'object', properties: { sleightReplay: { const: 1 }, steps: { type: 'array', items: { type: 'object' } } }, required: ['sleightReplay', 'steps'] },
      waitMs: { type: 'integer', minimum: 0, maximum: 60000 },
      allowPositions: { type: 'boolean' },
    },
    required: ['script'], additionalProperties: false,
  },
};

// Multiplex the tool's calls into the current relay, preserving its session, guards and prompts.
// Internal replies return here; elicitation and every other server request still reach Claude.
// Keep delimiters too: readline would replace CRLF with LF in an otherwise untouched message.
function messageLines(input, receive) {
  let pending = '';
  input.setEncoding('utf8');
  input.on('data', chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
      receive(line);
    }
  });
  input.once('end', () => { if (pending) receive(pending); });
}

export function replayBridge({ input, output, clock = realClock }) {
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const internal = new Map(), lists = new Map();
  const prefix = `sleight-replay-${randomUUID()}-`;
  let sequence = 0, active, ended = false;
  const write = msg => output.write(JSON.stringify(msg) + '\n');
  const refuse = (id, message) => write({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: message }] } });
  const request = params => new Promise(resolve => {
    if (ended) return resolve({ error: { message: 'The replay connection closed. Read the window before acting.' } });
    const id = prefix + sequence++;
    if (active) active.inFlight = id;
    internal.set(id, resolve);
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }) + '\n');
  });
  messageLines(clientOut, line => {
    // With no replay or tool-list reply pending, even image payloads pass without inspection.
    if ((!internal.size && !lists.size) || (!line.includes('\\u') && !line.includes('\\/') &&
        !(internal.size && line.includes(prefix)) && ![...lists.values()].some(matches => matches.test(line)))) {
      output.write(line); return;
    }
    let msg;
    try { msg = JSON.parse(line); } catch { output.write(line); return; }
    if (!msg.method && internal.has(msg.id)) {
      if (active?.inFlight === msg.id) active.inFlight = undefined;
      const resolve = internal.get(msg.id); internal.delete(msg.id); resolve(msg); return;
    }
    if (!msg.method && lists.delete(msg.id) && Array.isArray(msg.result?.tools)) {
      msg.result.tools.push(REPLAY_TOOL);
      write(msg); return;
    }
    output.write(line);
  });
  messageLines(input, line => {
    const toolCall = line.includes('"tools/call"');
    // Escaped envelope fields are uncommon, but may spell the same methods, names and IDs.
    if (!line.includes('\\u') && !line.includes('\\/') && !line.includes('"tools/list"') && !(toolCall && (active || line.includes('"replay"'))) &&
        !(active && line.includes('"notifications/cancelled"'))) {
      clientIn.write(line); return;
    }
    let msg;
    try { msg = JSON.parse(line); } catch { clientIn.write(line); return; }
    if (active && msg.method === 'notifications/cancelled' && msg.params?.requestId === active.id) {
      active.cancelled = true;
      if (!active.inFlight) return;
      msg = { ...msg, params: { ...msg.params, requestId: active.inFlight } };
      clientIn.write(JSON.stringify(msg) + '\n'); return;
    }
    if (msg.method === 'tools/call' && msg.params?.name === 'turn_ended' && active) active.cancelled = true;
    if (msg.method === 'tools/call' && msg.params?.name !== 'turn_ended') {
      if (active) { refuse(msg.id, 'A replay is running. Wait for it to stop before sending another tool call.'); return; }
      if (msg.params?.name === 'replay') {
        if (msg.id === undefined) return;
        const state = active = { id: msg.id, cancelled: false };
        const args = msg.params.arguments ?? {};
        replaySteps(args.script, {
          allowPositions: args.allowPositions, waitMs: args.waitMs, clock,
          cancelled: () => state.cancelled,
          call: (name, arguments_) => request({ name, arguments: arguments_, _meta: msg.params._meta }),
        }).then(result => {
          write({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
        }, error => refuse(msg.id, error.message)).finally(() => { active = undefined; });
        return;
      }
    }
    if (msg.method === 'tools/list' && msg.id !== undefined) {
      const id = JSON.stringify(msg.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      lists.set(msg.id, new RegExp(`"id"\\s*:\\s*${id}(?=\\s*[,}])`));
    }
    clientIn.write(line);
  });
  const close = () => {
    if (ended) return;
    ended = true;
    if (active) active.cancelled = true;
    for (const resolve of internal.values()) resolve({ error: { message: 'The replay connection closed. Read the window before acting.' } });
    internal.clear();
    clientIn.end();
  };
  input.once('end', close).once('close', close);
  return { clientIn, clientOut };
}

export function replayOptions(args) {
  const options = { allowPositions: false, waitMs: 5000 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow-positions') options.allowPositions = true;
    else if (args[i] === '--wait-ms' && /^\d+$/.test(args[i + 1] ?? '')) options.waitMs = Number(args[++i]);
    else throw new Error(`unknown replay option or missing value: ${args[i]}`);
  }
  return options;
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
