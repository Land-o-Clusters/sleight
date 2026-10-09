// Direct MCP client for the two-engine typing probe. Never used by the plugin.
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';

const approveHook = fileURLToPath(new URL('./approve.mjs', import.meta.url));
export const probeReadCode = app => `var app = await cua.getApp(${JSON.stringify(app)})`;
export const probeInputCode = (text, keysOnly = false) => keysOnly
  ? [...text, 'Escape'].map(key => `await app.pressKey(${JSON.stringify(key)})`).join('; ')
  : `await app.typeText(${JSON.stringify(text)})`;
export function probeCleanupPath(path) {
  if (!/^\/private\/tmp\/sleight-double-keys-[A-Za-z0-9]+\/double-keys\.txt$/.test(path ?? '')) {
    throw new Error('Expected an owned temporary probe document');
  }
  return path;
}

// Invoke the existing benchmark allowlist, rather than creating another policy.
export async function benchmarkApproval(params) {
  const child = spawn(process.execPath, [approveHook], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BENCH_HOOK_LOG: '' } });
  let output = '', stderr = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr || `approval hook exit ${code}`)));
  });
  child.stdin.end(JSON.stringify({ mcp_server_name: 'plugin:sleight:computer',
    message: params.message, requested_schema: params.requestedSchema }));
  await done;
  const answer = output.trim() ? JSON.parse(output).hookSpecificOutput : undefined;
  return answer?.action === 'accept' ? { action: 'accept', content: answer.content ?? {} } : { action: 'decline' };
}

export async function probeClient(server, { relay: throughRelay, record, timeoutMs = 60000,
  relayOptions = {},
  approve = benchmarkApproval,
  label = throughRelay ? 'sleight' : 'direct' } = {}) {
  const sessionId = randomUUID();
  let turnId = randomUUID();
  const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...server.env } });
  let ended = false, closing;
  const stopped = new Promise(resolve => child.once('close', (code, signal) => {
    ended = true;
    record({ client: label, event: 'engine-close', code, signal });
    resolve();
  }));
  child.stderr.on('data', chunk => record({ client: label, event: 'stderr', text: chunk.toString() }));
  const clientIn = throughRelay ? new PassThrough() : child.stdin;
  const clientOut = throughRelay ? new PassThrough() : child.stdout;
  const pending = new Map();
  let nextId = 0;
  const fail = error => {
    for (const reply of pending.values()) reply.reject(error);
    pending.clear();
  };
  child.once('error', fail);
  child.once('exit', (code, signal) => fail(new Error(`owned ${label} engine exited (${signal ?? code})`)));
  child.stdin.on('error', fail);
  const relay = throughRelay ? createRelay({ clientIn, clientOut, serverIn: child.stdin, serverOut: child.stdout,
    ...relayOptions,
    sessionId, inputLease: new InputLease({ holder: `double-keys probe ${sessionId}` }),
    idleTurnEndMs: 30000,
    onLeaseFault: error => { record({ client: label, event: 'lease-fault', error: error.message }); void close(); },
    trace: (direction, msg) => record({ client: label, direction, msg }) }) : undefined;
  const send = msg => {
    record({ client: label, direction: 'submitted', msg });
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${label} request ${id} (${method}) timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
    send({ id, method, params });
  });
  const input = createInterface({ input: clientOut });
  input.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); }
    catch { fail(new Error(`${label} returned invalid JSON`)); return; }
    record({ client: label, direction: 'received', msg });
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'elicitation/create') {
        approve(msg.params).then(result => send({ id: msg.id, result }), fail);
      } else send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
    } else if (!msg.method && pending.has(msg.id)) {
      const reply = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reply.reject(new Error(msg.error.message)) : reply.resolve(msg.result);
    }
  });
  const call = async (name, args) => {
    const result = await request('tools/call', { name,
      arguments: !throughRelay && name === 'turn_ended' ? { ...args, hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId } : args,
      ...(throughRelay ? {} : { _meta: { 'x-codex-turn-metadata': JSON.stringify({ session_id: sessionId, turn_id: turnId }) } }) });
    if (!throughRelay && name === 'turn_ended') turnId = randomUUID();
    return result;
  };
  const close = () => closing ||= (async () => {
    // Stop only this client's owned server, never the helper or ChatGPT.
    const gentle = setTimeout(() => { if (!ended) child.kill('SIGTERM'); }, 5000);
    const force = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 8000);
    try {
      if (!ended) {
        if (relay) await Promise.race([relay.shutdown(), stopped]);
        else await Promise.race([call('turn_ended', { session_id: sessionId, turn_id: turnId }), stopped]).catch(error =>
          record({ client: label, event: 'turn-end-error', error: error.message }));
        child.stdin.end();
      }
      await stopped;
    } finally {
      clearTimeout(gentle); clearTimeout(force);
      relay?.close(); input.close(); fail(new Error('client closed'));
    }
  })();
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } },
      clientInfo: { name: `double-keys-${label}`, version: '1' } });
    send({ method: 'notifications/initialized' });
    return { call, close };
  } catch (error) { await close(); throw error; }
}
