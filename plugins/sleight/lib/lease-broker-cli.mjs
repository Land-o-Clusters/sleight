import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { brokerRequest } from './lease-broker.mjs';

export async function runBrokerCLI({ input = process.stdin, output = process.stdout, directory, now } = {}) {
  let reply, status = 0;
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 16384) throw new Error('Lease broker: invalid request, maximum size is 16 KiB.');
      chunks.push(buffer);
    }
    let request;
    try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Lease broker: invalid JSON request.'); }
    reply = brokerRequest(request, { directory, now });
  } catch (error) {
    status = 1;
    reply = { ok: false, error: error.message };
  }
  output.write(JSON.stringify(reply) + '\n');
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'Lease broker: pass one JSON request on stdin, with no arguments.' }) + '\n');
    process.exitCode = 1;
  } else process.exitCode = await runBrokerCLI();
}
