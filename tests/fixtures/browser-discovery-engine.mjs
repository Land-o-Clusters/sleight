import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  appendFileSync(process.env.SLEIGHT_TEST_REQUESTS, line + '\n');
  if (msg.method === 'initialize') send({ id: msg.id, result: {} });
  if (msg.method === 'tools/call') {
    if (process.env.SLEIGHT_TEST_HUNG) return;
    if (process.env.SLEIGHT_TEST_ASK) { send({ id: 'ask', method: 'elicitation/create', params: { message: 'Unexpected approval' } }); return; }
    send({ id: msg.id, result: { isError: Boolean(process.env.SLEIGHT_TEST_ERROR), content: [{ type: 'text', text: 'sleight-browser-discovery:' + process.env.SLEIGHT_TEST_BROWSERS }] } });
  }
});
