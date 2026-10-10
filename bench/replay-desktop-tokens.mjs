// Read-only Claude context probe. The fixture lists replay but never runs a script or an engine.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLAY_TOOL } from '../plugins/sleight/lib/replay.mjs';

if (process.argv[2] === '--server') {
  const alwaysLoad = process.argv[3] === 'always';
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const result = msg.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'replay-token-probe', version: '1' } }
      : msg.method === 'tools/list'
        ? { tools: [{ ...REPLAY_TOOL, _meta: { 'anthropic/alwaysLoad': alwaysLoad } }] }
        : { isError: true, content: [{ type: 'text', text: 'This token probe never executes tools.' }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  }
} else {
  const cwd = await mkdtemp(join(tmpdir(), 'sleight-replay-tokens-'));
  const results = [];
  try {
    for (const arm of ['always', 'deferred']) {
      const serverName = 'plugin:sleight:computer';
      const config = { mcpServers: { [serverName]: { command: process.execPath, args: [fileURLToPath(import.meta.url), '--server', arm] } } };
      const child = spawn('claude', [
        '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--model', 'sonnet', '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
        '--strict-mcp-config', '--mcp-config', JSON.stringify(config), '--setting-sources', '',
        '--settings', JSON.stringify({ disableAllHooks: true }), '--no-session-persistence', '--no-chrome',
      ], { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 45000,
        env: { ...process.env, ENABLE_TOOL_SEARCH: 'true', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
      const closed = once(child, 'close');
      const pending = new Map();
      let sequence = 0;
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      const reader = (async () => {
        for await (const line of lines) {
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type !== 'control_response') continue;
          const response = msg.response;
          const done = pending.get(response.request_id);
          if (done) { pending.delete(response.request_id); done(response); }
        }
      })();
      const request = request => new Promise((resolve, reject) => {
        const request_id = String(++sequence);
        const timer = setTimeout(() => { pending.delete(request_id); reject(new Error(`Timed out on ${request.subtype}`)); }, 20000);
        pending.set(request_id, response => {
          clearTimeout(timer);
          response.subtype === 'success' ? resolve(response.response) : reject(new Error(response.error ?? 'Control request failed'));
        });
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id, request }) + '\n');
      });
      try {
        await request({ subtype: 'initialize' });
        let status;
        for (let i = 0; i < 40; i++) {
          status = await request({ subtype: 'mcp_status' });
          if (status.mcpServers?.some(server => server.name === serverName && server.status === 'connected')) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        results.push({ arm, servers: status.mcpServers?.map(server => ({ name: server.name, status: server.status })) });
        const usage = await request({ subtype: 'get_context_usage', detail: 'full' });
        const tool = usage.mcpTools?.find(tool => tool.name?.includes('replay'));
        results.push({ arm, model: usage.model, replay: tool, totalTokens: usage.totalTokens });
        if (!tool) throw new Error('The context breakdown did not include replay');
      } catch (error) {
        results.push({ arm, error: error.message.replaceAll(process.env.HOME, '~') });
        process.exitCode = 1;
      } finally {
        child.stdin.end();
        await closed;
        await reader;
      }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
  console.log(JSON.stringify({ probe: 'Claude context full breakdown, no model prompts or tool executions', results }, null, 2));
}
