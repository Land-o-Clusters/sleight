// Fake engine behind the real relay. No macOS calls, native dialogs or skill file.
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { createRelay } from '../../plugins/sleight/lib/relay.mjs';
import { approvalOptions } from '../../plugins/sleight/lib/launch.mjs';

const mode = process.argv[2];
if (mode === 'hang') {
  process.stdin.resume();
  process.stdin.on('end', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'unsupported') {
  const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } });
    if (msg.method === 'tools/list') send({ id: 'optional', method: 'elicitation/create', params: {} });
    if (msg.id === 'optional') send({ id: 1, error: { code: -32000, message: 'optional request refused' } });
  });
} else {
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const turnEnds = [], approvals = new Map();
  let engineCapabilities, dialogs = 0;
  const relay = createRelay({ clientIn: process.stdin, clientOut: process.stdout, serverIn, serverOut,
    changeReview: false, idleTurnEndMs: 30,
    ...approvalOptions({}, async () => { dialogs++; return 'accept'; }),
  });
  const send = msg => serverOut.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const result = (msg, allowed = true) => send({ id: msg.id, result: {
    ...(allowed ? {} : { isError: true }),
    content: [{ type: 'text', text: allowed ? 'Window: "Calculator", App: Calculator\n0 standard window Calculator' : 'not approved' }],
    _meta: { fixture: { ...JSON.parse(msg.params._meta['x-codex-turn-metadata']), engineCapabilities, dialogs, turnEnds } },
  } });
  createInterface({ input: serverIn }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      engineCapabilities = msg.params.capabilities;
      send({ id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
    } else if (msg.method === 'tools/list') {
      send({ id: msg.id, result: { tools: ['js', 'turn_ended'].map(name => ({ name, inputSchema: { type: 'object' } })), _meta: { fixture: { turnEnds } } } });
    } else if (msg.params?.name === 'turn_ended') {
      turnEnds.push(msg.params.arguments); send({ id: msg.id, result: { content: [] } });
    } else if (msg.params?.name === 'js') {
      const id = `app-${msg.id}`; approvals.set(id, msg);
      send({ id, method: 'elicitation/create', params: {
        message: 'Allow Computer Use to use "Calculator"?', mode: 'form', requestedSchema: { type: 'object', properties: {} },
        _meta: { connector_id: 'computer-use', persist: ['session', 'always'], riskLevel: 'low', tool_params: { app: 'Calculator' } },
      } });
    } else if (approvals.has(msg.id)) {
      const call = approvals.get(msg.id); approvals.delete(msg.id); result(call, msg.result?.action === 'accept');
    }
  });
  process.stdin.on('end', async () => { await relay.shutdown(); serverIn.end(); serverOut.end(); });
}
