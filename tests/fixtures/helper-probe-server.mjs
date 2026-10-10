import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const mode = process.argv[2];
if (mode === 'orphan') spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2000); process.on("SIGTERM", () => {});'], { stdio: 'inherit' });
const input = createInterface({ input: process.stdin });
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
let read;
let session;
let phase;
input.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (mode !== 'startup-hang') send({ id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === 'tools/call' && msg.params.name === 'js') {
    const code = msg.params.arguments.code;
    phase = code === 'await cua.getState()' ? 'inventory' : 'app';
    if (phase === 'app') assert.equal(code, 'await cua.getApp("com.apple.calculator")');
    assert.ok(msg.params.arguments.timeout_ms > 0 && msg.params.arguments.timeout_ms <= 5000);
    assert.ok(JSON.parse(msg.params._meta['x-codex-turn-metadata']).session_id);
    const nextSession = JSON.parse(msg.params._meta['x-codex-turn-metadata']).session_id;
    if (session) assert.equal(nextSession, session);
    session = nextSession;
    read = msg.id;
    if (mode.startsWith('app-')) {
      if (phase === 'inventory') return send({ id: read, result: { content: [{ type: 'text', text: JSON.stringify({
        apps: [{ id: 'com.apple.calculator', displayName: 'Calculator', isRunning: mode === 'app-not-running' ? false : mode === 'app-running-unknown' ? undefined : true },
          ...(mode === 'app-ambiguous' ? [{ id: 'example.calculator', displayName: 'Calculator', isRunning: true }] : [])],
        browsers: [], errors: [],
      }) }] } });
      if (mode === 'app-approval') return send({ id: 'approval', method: 'elicitation/create', params: { message: 'Allow Calculator?' } });
      if (mode === 'app-timeout') return send({ id: read, result: { isError: true, content: [{ type: 'text', text: '-10005 timeoutReached' }] } });
      if (mode === 'app-partial-error') return send({ id: read, result: { isError: true, content: [{ type: 'text', text: 'Window: "PRIVATE WINDOW TITLE", App: Calculator.\n1 text PRIVATE CONTENT\nError: read failed' }] } });
      if (mode === 'app-rpc-private') return send({ id: read, error: { code: -32000, message: 'PRIVATE CONTENT: read failed' } });
      return send({ id: read, result: { content: [{ type: 'text', text: mode === 'app-no-header' ? 'No windows available'
        : 'Window: "PRIVATE WINDOW TITLE", App: Calculator.\n0 standard window Calculator\n1 button Seven' }] } });
    }
    assert.equal(phase, 'inventory');
    if (mode === 'read-hang' || mode === 'orphan') return;
    if (mode === 'timeout') return send({ id: read, result: { isError: true, content: [{ type: 'text', text: '-10005 timeoutReached' }] } });
    if (mode === 'js-timeout') return send({ id: read, result: { isError: true, content: [{ type: 'text', text: 'js execution timed out; kernel reset' }] } });
    if (mode === 'rpc-error') return send({ id: read, error: { code: -32000, message: 'helper unavailable' } });
    if (mode === 'approval') return send({ id: 'approval', method: 'elicitation/create', params: { message: 'Allow?' } });
    if (mode === 'launch-failed') return send({ id: read, result: { content: [{ type: 'text', text: '## Computer Use' },
      { type: 'text', text: '{"apps":[],"browsers":[],"errors":["Native apps: Error: Sky Computer Use service startup request failed"]}' }] } });
    send({ id: read, result: { content: [{ type: 'text', text: 'Apps: Calculator' }] } });
  } else if (msg.id === 'approval') {
    assert.deepEqual(msg.result, { action: 'decline' });
    send({ id: read, result: { isError: true, content: [{ type: 'text', text: 'approval declined' }] } });
  }
});
input.on('close', () => process.exit(0));
