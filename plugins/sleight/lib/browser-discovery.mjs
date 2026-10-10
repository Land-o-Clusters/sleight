// Read-only discovery through the installed engine, not browser profile files.
// Own and collect the short-lived engine; no browser actions or accepted prompts.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export async function discoverExtensions(server, { timeoutMs = 4000, signal, strict = false } = {}) {
  if (signal?.aborted) { if (strict) throw new Error('Browser discovery cancelled'); return []; }
  const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...server.env, CUA_REPL_ENABLED_SURFACES: 'browser', BROWSER_USE_AVAILABLE_BACKENDS: 'chrome' } });
  const stopped = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  const marker = 'sleight-browser-discovery:';
  let finish, timer;
  const fail = reason => finish(strict ? new Error(`Browser discovery ${reason}`) : []);
  const answer = new Promise(resolve => { finish = resolve; timer = setTimeout(() => fail('timed out'), timeoutMs); });
  const abort = () => fail('cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  const send = msg => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };
  child.on('error', () => fail('engine failed to start'));
  child.stdin.on('error', () => fail('engine input failed'));
  child.once('close', () => fail('engine closed without an inventory'));
  lines.on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) {
      send({ id: msg.id, ...(msg.method === 'elicitation/create' ? { result: { action: 'decline' } } : { error: { code: -32601, message: 'Method not found' } }) });
    } else if (msg.id === 1) {
      if (msg.error) return fail('initialization failed');
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/call', params: { name: 'js', arguments: {
        code: `nodeRepl.write(${JSON.stringify(marker)} + JSON.stringify(await cua.listBrowsers({emit: false})))`,
      }, _meta: { 'x-codex-turn-metadata': JSON.stringify({ session_id: randomUUID(), turn_id: randomUUID() }) } } });
    } else if (msg.id === 2) {
      if (msg.error || msg.result?.isError || !Array.isArray(msg.result?.content)) return fail('inventory call failed');
      for (const block of msg.result.content) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue;
        const at = block.text.lastIndexOf(marker);
        if (at < 0) continue;
        try {
          const result = JSON.parse(block.text.slice(at + marker.length).trim());
          return Array.isArray(result) ? finish(result.filter(b => b?.type === 'extension' && b.metadata?.extensionInstanceId)) : fail('returned a malformed inventory');
        } catch { /* Failed or changed output: keep the surface off. */ }
      }
      fail('returned no inventory');
    }
  });
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-browser-discovery', version: '1' } } });
  try { const result = await answer; if (result instanceof Error) throw result; return result; }
  finally {
    signal?.removeEventListener('abort', abort);
    clearTimeout(timer); child.stdin.end();
    // cua-repl propagates these signals to its owned node_repl child.
    const gentle = setTimeout(() => child.kill('SIGTERM'), 500);
    const force = setTimeout(() => child.kill('SIGKILL'), 2500);
    await stopped; clearTimeout(gentle); clearTimeout(force); lines.close();
  }
}
