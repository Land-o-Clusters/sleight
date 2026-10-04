// Print the engine's first-call text without granting any app approval.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../plugins/sleight/bin/sleight-mcp', import.meta.url));

export async function captureEngineDocs({
  command = SERVER, args = [], env = process.env, timeoutMs = 60000,
} = {}) {
  // Force MCP prompts even when launched from the desktop app or a shell
  // configured to use sleight's approval dialog.
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, SLEIGHT_APPROVAL_PROMPT: 'client' },
  });
  const input = createInterface({ input: child.stdout });
  let nextId = 0;
  let pending;
  let stderr = '';
  let closed = false;
  const stopped = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const fail = err => { pending?.reject(err); pending = undefined; };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', (code, signal) => fail(new Error(`engine docs server exited (${signal || code})${stderr ? `: ${stderr.trim()}` : ''}`)));
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending = { id, resolve, reject };
    send({ id, method, params });
  });
  input.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch { return fail(new Error('engine docs server returned invalid JSON')); }
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'elicitation/create') {
        send({ id: msg.id, result: { action: 'decline' } });
      } else {
        send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
      }
    } else if (!msg.method && pending?.id === msg.id) {
      const reply = pending;
      pending = undefined;
      if (msg.error) reply.reject(new Error(msg.error.message || 'MCP request failed'));
      else reply.resolve(msg.result);
    }
  });
  const timer = setTimeout(() => fail(new Error('engine docs capture timed out')), timeoutMs);
  try {
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { elicitation: { form: {} } },
      clientInfo: { name: 'sleight-engine-docs', version: '1' },
    });
    send({ method: 'notifications/initialized' });
    const result = await request('tools/call', {
      name: 'js', arguments: { code: 'let app = await cua.getApp("Calculator")' },
    });
    // A declined getApp can set isError while still returning the API docs.
    const text = result?.content?.filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n\n');
    if (!text?.trim()) throw new Error('engine docs call returned no text');
    if (!/^#{1,6} .*\bAPI\b/im.test(text)) {
      throw new Error(`engine docs call returned no API docs: ${text.slice(0, 500)}`);
    }
    return text.endsWith('\n') ? text : text + '\n';
  } finally {
    clearTimeout(timer);
    child.stdin.end(); // The launcher ends the turn and stops its engine child.
    const terminate = setTimeout(() => { if (!closed) child.kill('SIGTERM'); }, 6000);
    const force = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 9000);
    await stopped;
    clearTimeout(terminate);
    clearTimeout(force);
    input.close();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(await captureEngineDocs()); }
  catch (err) { console.error(`sleight engine docs: ${err.message}`); process.exitCode = 1; }
}
