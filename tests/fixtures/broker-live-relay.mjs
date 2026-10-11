import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

if (process.argv[2] === 'engine') {
  createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    if (process.argv[4] === 'hang' && /\.typeText\(/.test(msg.params?.arguments?.code || '')) return;
    const result = msg.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } }
      : { content: [{ type: 'text', text: 'Window: "fixture.txt", App: TextEdit\nURL: ' + pathToFileURL(join(process.argv[3], 'fixture.txt')).href }],
        _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.TextEdit' } } } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  });
} else {
  const { relayServer } = await import('../../bench/broker-live.mjs');
  await relayServer('fake sleight', { directory: process.argv[2],
    server: { command: process.execPath, args: [fileURLToPath(import.meta.url), 'engine', process.argv[2], process.argv[3]], env: {} },
    approve: async () => 'accept', hold: '/private/tmp/nonexistent-broker-test-hold', renewMs: 50 });
}
