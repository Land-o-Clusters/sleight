// Local pages for the three hand-off tasks. Each task lives under /t/<name>/ so its views, downloads
// and clicks land in GET /t/<name>/api/log, the same shape FowlBrowser's demo shop uses.
import { createServer } from 'node:http';
import { INVOICE_ID, INVOICE_TOTAL, NOTE, ROSTER, SITE_PORT } from '../data.mjs';
import { ccBase, ccHandler, ccKinds, createCCFixture } from './cc-held-out.mjs';
import { wholeHandler } from './whole-thread.mjs';
import { wholeRaceFixtures, wholeRaceLog, wholeRaceKinds } from '../whole-thread.mjs';

export { INVOICE_TOTAL, NOTE, ROSTER, SITE_PORT };

export function invoicePdf() {
  const stream = `BT
/F1 18 Tf
72 720 Td
(Northbound Supply) Tj
0 -24 Td
(Invoice ${INVOICE_ID}) Tj
0 -24 Td
(Total: $${INVOICE_TOTAL}) Tj
ET
`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  return `${body}${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = `<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1d1d1f;background:#fff}
main{max-width:720px;margin:0 auto;padding:24px}
table{border-collapse:collapse}td,th{padding:6px 12px;border-bottom:1px solid #ddd;text-align:left}
a.button{display:inline-block;padding:8px 16px;border:1px solid #888;border-radius:8px;background:#f2f2f2;color:inherit;text-decoration:none}
</style>`;

function page(title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(title)}</title>${STYLE}<main>${body}</main></html>`;
}

function invoicePage(base) {
  return page('Invoice INV-4419', `<h1>Invoice ${esc(INVOICE_ID)}</h1>
<p>Northbound Supply · due on receipt</p>
<p>Total due: <strong>$${esc(INVOICE_TOTAL)}</strong></p>
<p><a class="button" href="${base}/invoice.pdf" download>Download PDF</a></p>`);
}

function tablePage() {
  const rows = ROSTER.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.role)}</td><td>${esc(r.hours)}</td></tr>`).join('');
  return page('Roster', `<h1>Production roster</h1>
<table><thead><tr><th>Name</th><th>Role</th><th>Hours</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function notePage() {
  return page(NOTE.title, `<h1>${esc(NOTE.title)}</h1><p>${esc(NOTE.body)}</p>`);
}

export function logLines(events) {
  return events.map((e) => [e.kind, e.path, e.kind === 'pointer' || e.kind === 'input' ? e.field : e.detail]
    .filter((x) => x !== undefined && x !== '').join(' '));
}

export function createHandler({ downloadName = 'invoice.pdf', ccFixtures, wholeFixtures = wholeRaceFixtures() } = {}) {
  if (!/^invoice(?:-[a-zA-Z0-9-]+)?\.pdf$/.test(downloadName)) throw new Error('invalid download name');
  const tags = new Map();
  const stateOf = (tag) => {
    if (!tags.has(tag)) tags.set(tag, { events: [] });
    return tags.get(tag);
  };
  const pdf = invoicePdf();
  const heldOut = ccFixtures ?? ccKinds.map(kind => createCCFixture(kind, { nonce: 'held-out' }));
  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/whole/') || url.pathname.startsWith('/whole-race/')) {
      if (!/^127\.0\.0\.1:\d{1,5}$/.test(req.headers.host ?? '') || req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.writeHead(403).end();
      const race = /^\/whole-race\/([-\w]+)\/api\/log$/.exec(url.pathname);
      if (race && wholeRaceKinds[race[1]] && req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(wholeRaceLog(wholeFixtures, race[1])));
      const fixture = wholeFixtures.find(f => url.pathname.startsWith('/whole/' + f.nonce + '/'));
      if (!fixture) return res.writeHead(404).end();
      return wholeHandler(fixture, req, res);
    }
    if (url.pathname.startsWith('/held-out/')) {
      const fixture = heldOut.find(row => url.pathname.startsWith(ccBase(row)));
      if (!fixture || !/^127\.0\.0\.1:\d{1,5}$/.test(req.headers.host ?? '')) return res.writeHead(404).end();
      return ccHandler(fixture, `http://${req.headers.host}`)(req, res);
    }
    const send = (code, type, body) => res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    const html = (body) => send(body ? 200 : 404, 'text/html; charset=utf-8', body || 'not found');
    const json = (body) => send(200, 'application/json', JSON.stringify(body));
    const m = /^\/t\/([\w-]+)\/?(.*)$/.exec(url.pathname);
    if (!m) return html(null);
    const [, tag, rest] = m;
    const state = stateOf(tag);
    const base = `/t/${tag}`;
    let body = '';
    if (req.method === 'POST') for await (const chunk of req) body += chunk;
    if (rest === 'api/log') {
      if (req.method === 'POST') {
        let e; try { e = JSON.parse(body); } catch { return json({ ok: false }); }
        state.events.push({ at: Date.now(), kind: String(e.kind), path: String(e.path || '/'), field: e.field, detail: e.detail });
        return json({ ok: true });
      }
      return json({ events: state.events, lines: logLines(state.events) });
    }
    if (tag === 'invoice-preview' && rest === 'invoice.pdf') {
      state.events.push({ at: Date.now(), kind: 'download', path: '/invoice.pdf' });
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${downloadName}"`,
        'cache-control': 'no-store',
      }).end(pdf);
      return;
    }
    const pages = { 'invoice-preview': () => invoicePage(base), 'table-textedit': tablePage, 'note-textedit': notePage };
    const render = pages[tag];
    if (render && rest === '') {
      state.events.push({ at: Date.now(), kind: 'view', path: '/' });
      return html(render());
    }
    return html(null);
  }
  return handle;
}

export function startServer({ port = SITE_PORT, downloadName, ccFixtures, wholeFixtures } = {}) {
  const handle = createHandler({ downloadName, ccFixtures, wholeFixtures });
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => handle(req, res).catch(() => res.writeHead(500).end()));
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => { server.close(done); server.closeAllConnections(); }),
      });
    });
    server.once('error', reject);
  });
}

if (import.meta.main) {
  const downloadName = process.argv[process.argv.indexOf('--download-name') + 1];
  const server = await startServer({ port: SITE_PORT, downloadName: process.argv.includes('--download-name') ? downloadName : undefined });
  console.log(`handoff site on http://127.0.0.1:${server.port}`);
}
