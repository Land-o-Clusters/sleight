import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
// Deliberately remain alive after stdin EOF and ignore graceful termination.
// The real launcher's owned-child deadline must collect this process.
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {});
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.params?.name === 'js' && msg.params.arguments.code.includes('typeText("hang")')) return;
  const result = msg.params?.name === 'js' ? { content: [{ type: 'text', text: `Window: "a.txt", App: TextEdit\nURL: ${pathToFileURL(process.env.SLEIGHT_TEST_DOCUMENT).href}` }],
    _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.TextEdit' } } } } : {};
  if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
});
