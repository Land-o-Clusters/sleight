// A stdio MCP client with no elicitation, mod, skill registration or host metadata.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export async function baseClient(server, { record = () => {}, timeoutMs = 60000, closeGraceMs = 10000, signal } = {}) {
  const child = spawn(server.command, server.args ?? [], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...server.env },
  });
  const pending = new Map();
  let nextId = 0, closed = false, closing;
  const fail = error => {
    for (const reply of pending.values()) reply.reject(error);
    pending.clear();
  };
  const stopped = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true;
    fail(new Error(`sleight server exited (${signal ?? code})`));
    record({ event: 'server-close', code, signal });
    resolve({ code, signal });
  }));
  child.once('error', fail);
  child.stdin.on('error', fail);
  child.stderr.on('data', chunk => record({ event: 'stderr', text: chunk.toString() }));
  const send = msg => {
    if (closed || child.stdin.destroyed || child.stdin.writableEnded) throw new Error('sleight server is closed');
    const rpc = { jsonrpc: '2.0', ...msg };
    record({ direction: 'submitted', msg: rpc });
    child.stdin.write(JSON.stringify(rpc) + '\n');
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    try { send({ id, method, params }); }
    catch (error) { pending.get(id).reject(error); pending.delete(id); }
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const msg = JSON.parse(line);
      record({ direction: 'received', msg });
      if (msg.method && msg.id !== undefined) {
        send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
      } else if (!msg.method && pending.has(msg.id)) {
        const reply = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? reply.reject(new Error(msg.error.message)) : reply.resolve(msg.result);
      }
    } catch (error) { fail(error); }
  });
  const close = () => closing ||= (async () => {
    // EOF lets the launcher end the turn. Signals collect only this owned child.
    const gentle = setTimeout(() => { if (!closed) child.kill('SIGTERM'); }, closeGraceMs);
    const force = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, closeGraceMs + 2000);
    try {
      child.stdin.end();
      return await stopped;
    } finally {
      signal?.removeEventListener('abort', abort);
      clearTimeout(gentle); clearTimeout(force); lines.close(); fail(new Error('client closed'));
    }
  })();
  const abort = () => { fail(new Error('client interrupted')); void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'sleight-base-client', version: '1' },
    });
    send({ method: 'notifications/initialized' });
    return { initialized, request, call: (name, args) => request('tools/call', { name, arguments: args }), close };
  } catch (error) { await close(); throw error; }
}

// No app is acquired by this probe, so it cannot raise an app approval or move input.
// The trace records the launcher's idle cleanup; stdout contains the base-client receipts.
export async function plainProbe(server, { idleMs = 30000, record, signal } = {}) {
  const client = await baseClient(server, { record, signal });
  try {
    const tools = await client.request('tools/list', {});
    if (!tools.tools.some(tool => tool.name === 'js')) throw new Error('js tool is missing');
    const first = await client.call('js', { code: 'nodeRepl.write(6 * 7)', title: 'Base MCP protocol check' });
    if (first.isError) throw new Error(first.content?.filter(c => c.type === 'text').map(c => c.text).join('\n'));
    await new Promise(resolve => {
      const timer = setTimeout(done, idleMs + 500);
      function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted) done();
    });
    const second = await client.call('js', { code: 'nodeRepl.write(7 * 6)', title: 'Base MCP after idle cleanup' });
    if (second.isError) throw new Error(second.content?.filter(c => c.type === 'text').map(c => c.text).join('\n'));
    return { protocolVersion: client.initialized.protocolVersion, tools: tools.tools.map(tool => tool.name), first, second };
  } finally { await client.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = { command: fileURLToPath(new URL('../plugins/sleight/bin/sleight-mcp', import.meta.url)) };
  try {
    const result = await plainProbe(server);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) { process.stderr.write(`plain MCP probe: ${error.message}\n`); process.exitCode = 1; }
}
