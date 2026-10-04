// Doctor uses inventory, never actions or an unattended app approval.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export async function probeHelper(server, { timeoutMs = 5000, startupTimeoutMs = 10000, cleanupGraceMs = 2000, cleanupForceMs = 5000 } = {}) {
  const child = spawn(server.command, server.args, {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...server.env },
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  const input = createInterface({ input: child.stdout });
  let nextId = 0;
  let pending;
  let stderr = '';
  let reading = false;
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
  const fail = err => { if (pending) { clearTimeout(pending.timer); pending.reject(err); pending = undefined; } };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.once('exit', (code, signal) => fail(new Error(`computer-use server exited (${signal || code}): ${stderr.trim()}`)));
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const request = (method, params, ms, timeoutMessage) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending = { id, resolve, reject, timer: setTimeout(() => fail(new Error(timeoutMessage)), ms) };
    send({ id, method, params });
  });
  input.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { fail(new Error('computer-use server returned invalid JSON')); return; }
    if (msg.method && msg.id !== undefined) {
      send({ id: msg.id, ...(msg.method === 'elicitation/create' ? { result: { action: 'decline' } }
        : { error: { code: -32601, message: 'Method not found' } }) });
    } else if (!msg.method && pending?.id === msg.id) {
      const reply = pending; pending = undefined; clearTimeout(reply.timer);
      msg.error ? reply.reject(new Error(msg.error.message)) : reply.resolve(msg.result);
    }
  });
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } },
      clientInfo: { name: 'sleight-doctor', version: '1' } }, startupTimeoutMs, 'computer-use server startup timed out');
    send({ method: 'notifications/initialized' });
    reading = true;
    const result = await request('tools/call', { name: 'js', arguments: { code: 'await cua.getState()', timeout_ms: timeoutMs },
      _meta: { 'x-codex-turn-metadata': JSON.stringify({ session_id: randomUUID(), turn_id: randomUUID() }) } },
    timeoutMs + 500, 'helper live read timed out');
    const text = (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (result?.isError) throw new Error(text || 'helper live read failed');
    if (!text.trim()) throw new Error('helper live read returned no state');
    return { ok: true };
  } catch (err) {
    const stuck = reading && /timeoutReached|timed out|timeout/i.test(err.message);
    return { ok: false, stuck, error: err.message };
  } finally {
    child.stdin.end();
    const signalOwned = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (err) { if (err.code !== 'ESRCH') fail(err); }
    };
    const gentle = setTimeout(() => signalOwned('SIGTERM'), cleanupGraceMs);
    const force = setTimeout(() => signalOwned('SIGKILL'), cleanupForceMs);
    let deadline;
    const collected = await Promise.race([closed.then(() => true), new Promise(resolve => {
      deadline = setTimeout(() => resolve(false), cleanupForceMs + 1000);
    })]);
    clearTimeout(gentle); clearTimeout(force); clearTimeout(deadline); input.close();
    if (!collected) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      throw new Error('doctor could not collect its owned engine process group');
    }
  }
}
