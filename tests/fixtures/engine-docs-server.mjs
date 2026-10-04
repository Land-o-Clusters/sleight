// A stdio MCP server for the docs client's protocol and failure tests.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2] || 'docs';
const input = createInterface({ input: process.stdin });
let initialized = false;
let call;
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
input.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    assert.equal(process.env.SLEIGHT_APPROVAL_PROMPT, 'client');
    assert.deepEqual(msg.params.capabilities.elicitation, { form: {} });
    send({ id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } });
  } else if (msg.method === 'notifications/initialized') {
    initialized = true;
  } else if (msg.method === 'tools/call') {
    assert.ok(initialized);
    assert.equal(call, undefined, 'only one tool call');
    assert.equal(msg.params.name, 'js');
    assert.equal(msg.params.arguments.code, 'let app = await cua.getApp("Calculator")');
    call = msg;
    if (process.env.SLEIGHT_TEST_CAPTURE_LOG) appendFileSync(process.env.SLEIGHT_TEST_CAPTURE_LOG, 'capture\n');
    if (mode === 'exit') return process.exit(3);
    if (mode === 'hang') return;
    if (mode === 'malformed') return process.stdout.write('not JSON\n');
    if (mode === 'rpc-error') return send({ id: msg.id, error: { code: -32603, message: 'engine unavailable' } });
    if (mode === 'tool-error') return send({ id: msg.id, result: { isError: true, content: [
      { type: 'text', text: 'trusted Node process exited unexpectedly; kernel reset, rerun your request' },
    ] } });
    send({ method: 'notifications/message', params: { level: 'info', data: 'ignore me' } });
    // Request and response ids live in separate namespaces.
    send({ id: msg.id, method: 'elicitation/create', params: { mode: 'form', message: 'Allow Calculator?', requestedSchema: { type: 'object', properties: {} } } });
  } else if (msg.id === call?.id) {
    assert.deepEqual(msg.result, { action: 'decline' });
    const content = mode === 'empty' ? [] : [
      { type: 'text', text: '# Runtime API\n\ncua.getApp(name) → app' + (process.env.SLEIGHT_TEST_VERSION ? `\nVersion ${process.env.SLEIGHT_TEST_VERSION}` : '') },
      { type: 'image', mimeType: 'image/png', data: 'unused' },
      { type: 'text', text: 'Calculator approval declined.' },
    ];
    // Split a JSON line across writes, including a UTF-8 character.
    const reply = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { isError: true, content } }) + '\n');
    const cut = reply.indexOf(Buffer.from('→')) + 1;
    process.stdout.write(reply.subarray(0, cut));
    setTimeout(() => process.stdout.write(reply.subarray(cut)), 5);
  } else {
    assert.fail(`unexpected message: ${line}`);
  }
});
input.on('close', () => process.exit(0));
