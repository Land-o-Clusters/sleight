import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';

export async function reliabilityClient(record, options = {}) {
  const server = resolveServer();
  if (server.error) throw new Error(server.error);
  const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...server.env } });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const pending = new Map(); let nextId = 0;
  const relay = createRelay({ clientIn, clientOut, serverIn: child.stdin, serverOut: child.stdout,
    diagnoseRead: options.diagnoseRead,
    ask: async message => {
      const accepted = /(?:"(?:Chess|Calculator|Sleight Reliability Fixture)"|drag in Chess)/.test(message);
      record({ approval: message, accepted });
      if (!accepted) throw new Error('Unexpected approval; live work stopped');
      return 'accept';
    }, changeReview: false, ...options,
    trace: (direction, msg) => record({ direction, msg }),
  });
  child.stderr.setEncoding('utf8').on('data', value => record({ stderr: value }));
  const lines = createInterface({ input: clientOut });
  lines.on('line', line => {
    const msg = JSON.parse(line);
    if (!msg.method && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
      p.resolve(msg.error ? { isError: true, content: [{ type: 'text', text: msg.error.message }] } : msg.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Live engine response deadline')); }, 90000);
    pending.set(id, { resolve, reject, timer });
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  async function close() {
      await relay.shutdown(); child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
      const exit = await closed; clearTimeout(timer); lines.close();
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Live client closed')); }
      pending.clear();
      record({ engineCollected: true, exit });
  }
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-reliability', version: '1' } });
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  } catch (error) { await close(); throw error; }
  return {
    version: server.version,
    js: code => request('tools/call', { name: 'js', arguments: { code, timeout_ms: 6000 } }),
    tool: (name, args) => request('tools/call', { name, arguments: args }),
    close,
  };
}
