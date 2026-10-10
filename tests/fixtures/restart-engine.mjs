import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = event => appendFileSync(process.env.SLEIGHT_TEST_ENGINE_LOG, JSON.stringify({ event, pid: process.pid }) + '\n');
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
log('start');
let initialized = false, pending;
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    initialized = true; log('initialize');
    send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'restart-fixture', version: '1' } } });
  } else if (msg.method === 'notifications/initialized') log('initialized');
  else if (msg.method === 'tools/call' && msg.params.name === 'js') {
    if (!initialized) { send({ id: msg.id, error: { code: -32000, message: 'initialize required' } }); return; }
    pending = msg.id;
    send({ id: 'approval', method: 'elicitation/create', params: { message: 'Allow TextEdit?',
      _meta: { connector_id: 'computer-use', persist: ['session'], tool_params: { app: 'TextEdit' }, riskLevel: 'low' } } });
  } else if (msg.id === 'approval') {
    log(msg.result.action);
    send({ id: pending, result: { content: [{ type: 'text', text: 'Window: "Untitled", App: TextEdit.' }],
      _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.TextEdit' } } } } });
  } else if (msg.id !== undefined) send({ id: msg.id, result: { content: [] } });
});
