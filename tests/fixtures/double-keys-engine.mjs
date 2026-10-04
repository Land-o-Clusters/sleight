// Protocol fixture only. Echo submitted parameters, with no native helper.
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
    result: { content: [{ type: 'text', text: JSON.stringify(msg.params ?? {}) }] } }) + '\n');
});
