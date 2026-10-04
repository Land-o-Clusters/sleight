import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const mode = process.argv[2];
if (mode === 'orphan') spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2000); process.on("SIGTERM", () => {});'], { stdio: 'inherit' });
const input = createInterface({ input: process.stdin });
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
let read;
input.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (mode !== 'startup-hang') send({ id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === 'tools/call' && msg.params.name === 'js') {
    assert.equal(msg.params.arguments.code, 'await cua.getState()');
    assert.ok(msg.params.arguments.timeout_ms > 0 && msg.params.arguments.timeout_ms <= 5000);
    assert.ok(JSON.parse(msg.params._meta['x-codex-turn-metadata']).session_id);
    read = msg.id;
    if (mode === 'read-hang' || mode === 'orphan') return;
    if (mode === 'timeout') return send({ id: read, result: { isError: true, content: [{ type: 'text', text: '-10005 timeoutReached' }] } });
    if (mode === 'js-timeout') return send({ id: read, result: { isError: true, content: [{ type: 'text', text: 'js execution timed out; kernel reset' }] } });
    if (mode === 'rpc-error') return send({ id: read, error: { code: -32000, message: 'helper unavailable' } });
    if (mode === 'approval') return send({ id: 'approval', method: 'elicitation/create', params: { message: 'Allow?' } });
    send({ id: read, result: { content: [{ type: 'text', text: 'Apps: Calculator' }] } });
  } else if (msg.id === 'approval') {
    assert.deepEqual(msg.result, { action: 'decline' });
    send({ id: read, result: { isError: true, content: [{ type: 'text', text: 'approval declined' }] } });
  }
});
input.on('close', () => process.exit(0));
