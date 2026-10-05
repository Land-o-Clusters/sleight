// Read-only discovery through the installed engine, not browser profile files.
// Own and collect the short-lived engine; no browser actions or accepted prompts.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export async function discoverExtensions(server, { timeoutMs = 4000 } = {}) {
  const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...server.env, CUA_REPL_ENABLED_SURFACES: 'browser', BROWSER_USE_AVAILABLE_BACKENDS: 'chrome' } });
  const stopped = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  const marker = 'sleight-browser-discovery:';
  let finish, timer;
  const answer = new Promise(resolve => { finish = resolve; timer = setTimeout(() => resolve([]), timeoutMs); });
  const send = msg => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };
  child.on('error', () => finish([]));
  child.stdin.on('error', () => finish([]));
  child.once('close', () => finish([]));
  lines.on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) {
      send({ id: msg.id, ...(msg.method === 'elicitation/create' ? { result: { action: 'decline' } } : { error: { code: -32601, message: 'Method not found' } }) });
    } else if (msg.id === 1) {
      if (msg.error) return finish([]);
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/call', params: { name: 'js', arguments: {
        code: `nodeRepl.write(${JSON.stringify(marker)} + JSON.stringify(await cua.listBrowsers({emit: false})))`,
      }, _meta: { 'x-codex-turn-metadata': JSON.stringify({ session_id: randomUUID(), turn_id: randomUUID() }) } } });
    } else if (msg.id === 2) {
      if (msg.error || msg.result?.isError || !Array.isArray(msg.result?.content)) return finish([]);
      for (const block of msg.result.content) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue;
        const at = block.text.lastIndexOf(marker);
        if (at < 0) continue;
        try {
          const result = JSON.parse(block.text.slice(at + marker.length).trim());
          return finish(Array.isArray(result) ? result.filter(b => b?.type === 'extension' && b.metadata?.extensionInstanceId) : []);
        } catch { /* Failed or changed output: keep the surface off. */ }
      }
      finish([]);
    }
  });
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-browser-discovery', version: '1' } } });
  try { return await answer; }
  finally {
    clearTimeout(timer); child.stdin.end();
    // cua-repl propagates these signals to its owned node_repl child.
    const gentle = setTimeout(() => child.kill('SIGTERM'), 500);
    const force = setTimeout(() => child.kill('SIGKILL'), 2500);
    await stopped; clearTimeout(gentle); clearTimeout(force); lines.close();
  }
}
