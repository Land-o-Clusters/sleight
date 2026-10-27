// FowlBrowser's pinned forms, assets and gradeToken are reused unchanged. Only
// checkout and settings get server-side evidence; task HTML stays identical.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf' };
export async function startGateForms(root, { ports = [5413, 5414], gradeToken } = {}) {
  gradeToken ??= (await import(pathToFileURL(join(root, 'server.mjs')))).gradeToken;
  const submissions = new Map(), lines = [];
  let serial = 0;
  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    const submit = /^\/submit\/(\w+)$/.exec(url.pathname);
    if (req.method === 'POST' && submit) {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 16384) return json(413, {}); }
      let payload; try { payload = JSON.parse(body); } catch { return json(400, {}); }
      const token = String(payload.reference || '').trim().toLowerCase();
      const id = `SUB-${++serial}`;
      if (!submissions.has(token)) submissions.set(token, []);
      submissions.get(token).push({ id, form: submit[1], at: Date.now(), data: payload });
      lines.push(`action /submit/${submit[1]} ${token}`);
      return json(200, { id });
    }
    const grade = /^\/grade\/(\w+)$/.exec(url.pathname);
    if (grade) return json(200, gradeToken(grade[1], submissions));
    if (url.pathname === '/gate-log/p04') return json(200, { lines });
    if (/^\/gate-log\/p0[78]$/.test(url.pathname)) {
      const after = Number(url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0 || after > serial) return json(400, { error: 'invalid submission cursor' });
      const records = [...submissions.values()].flat().filter(record => Number(record.id.slice(4)) > after);
      return json(200, { cursor: serial, submissions: records });
    }
    let name = decodeURIComponent(url.pathname);
    if (name === '/') name = '/index.html';
    if (!extname(name)) name += '.html';
    const base = resolve(root, name.startsWith('/files/') ? 'files' : 'site');
    const file = resolve(base, '.' + name.replace(/^\/files\//, '/'));
    if (!file.startsWith(base + sep)) return json(403, {});
    let content;
    try { content = await readFile(file); } catch { return json(404, {}); }
    if (name === '/checkout.html') lines.push('view /checkout');
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(content);
  }
  const servers = [];
  const close = () => Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  try {
    for (const port of ports) {
      const server = createServer((req, res) => handle(req, res).catch(() => res.writeHead(500).end()));
      servers.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    }
    return { close, ports: servers.map(server => server.address().port) };
  } catch (error) { await close(); throw error; }
}
