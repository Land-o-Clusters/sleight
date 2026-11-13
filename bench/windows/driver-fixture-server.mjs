// Owner-started VM-only server for the one static fixture page.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { isMain } from './kit.mjs';

export function startFixtureServer({ platform = process.platform } = {}) {
  if (platform !== 'win32') throw Error('The fixture server requires the Windows guest');
  const page = readFileSync(new URL('./fixtures/driver-page.html', import.meta.url));
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'" }).end(page);
  });
  server.listen(9167, '127.0.0.1', () => process.stdout.write('WDR7 fixture: http://127.0.0.1:9167/ (Ctrl+C to stop)\n'));
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  server.once('close', () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
  server.once('error', () => { stop(); process.stderr.write('WDR7 fixture server could not bind loopback port 9167.\n'); process.exitCode = 1; });
  return server;
}
if (isMain(import.meta.url)) {
  try { startFixtureServer(); }
  catch { process.stderr.write('The fixture server requires the Windows guest.\n'); process.exitCode = 1; }
}
