import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';

export const browserKinds = ['local-wikipedia', 'local-mdn', 'table-scrape', 'file-upload', 'tab-switching', 'multi-page-search', 'form-controls'];
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function createBrowserFixture(kind, { nonce, seed = randomBytes(24).toString('hex') }) {
  if (!browserKinds.includes(kind) || !/^[a-zA-Z0-9_-]{1,80}$/.test(nonce)) throw new Error('invalid world browser fixture');
  const token = createHash('sha256').update(seed).digest('hex').slice(0, 12);
  const number = parseInt(token.slice(0, 6), 16);
  const expected = {
    'local-wikipedia': { metres: 1000 + number % 8000 },
    'local-mdn': { code: 100 + number % 900 },
    'table-scrape': { rows: ['Alpha', 'Beta', 'Gamma'].map((name, index) => ({ name, hours: 1 + (number >> index * 3) % 40 })) },
    'file-upload': { uploadText: `Private upload ${token}\n` },
    'tab-switching': { value: `Tab ${token}` },
    'multi-page-search': { reference: `Reference ${token}` },
    'form-controls': { option: token, checked: true, text: `Entry ${token}` },
  }[kind];
  return { kind, nonce, token, expected, views: [], posted: undefined, optionLabel: `Choice ${token.slice(0, 4)}` };
}

function page(fixture, path) {
  const base = `/${fixture.nonce}/`, esc = escape, { kind, expected } = fixture;
  const form = body => `<form id="task">${body}<button>Submit</button></form><p id="status"></p>`;
  const post = code => `<script>document.getElementById('task').onsubmit=async event=>{event.preventDefault();${code}
    const response=await fetch('${base}state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
    document.getElementById('status').textContent=response.ok?'Saved':'Failed';};</script>`;
  let body;
  if (kind === 'local-wikipedia') body = `<h1>Local elevation reference</h1><p>Station Cedar is ${expected.metres} metres above sea level.</p>`;
  if (kind === 'local-mdn') body = `<h1>Local protocol reference</h1><p>The code for a ceramic request is ${expected.code}.</p>`;
  if (kind === 'table-scrape') body = '<h1>Work log</h1><table><thead><tr><th>Name</th><th>Hours</th></tr></thead><tbody>' +
    expected.rows.map(row => `<tr><td>${row.name}</td><td>${row.hours}</td></tr>`).join('') + '</tbody></table>';
  if (kind === 'file-upload') body = '<h1>Upload the fixture</h1>' + form('<label>File <input id="file" type="file" accept="text/plain" required></label>') +
    post("const file=document.getElementById('file').files[0]; if(!file)return;const value={uploadText:await file.text()};");
  if (kind === 'tab-switching') body = path === 'second' ? `<h1>Second tab</h1><p>Copy this value: ${esc(expected.value)}</p>`
    : '<h1>First tab</h1>' + `<a target="_blank" href="${base}second">Open second tab</a>` + form('<label>Value <input id="value" required></label>') +
      post("const value={value:document.getElementById('value').value};");
  if (kind === 'multi-page-search') body = path.startsWith('record/') ? `<h1>Record ${esc(path.slice(7))}</h1><p>Project ${path === 'record/2' ? 'Cedar' : 'Other'}</p><p>${path === 'record/2' ? esc(expected.reference) : 'No matching reference'}</p>`
    : '<h1>Directory</h1>' + [1, 2, 3].map(n => `<p><a href="${base}record/${n}">Open record ${n}</a></p>`).join('');
  if (kind === 'form-controls') body = '<h1>Entry form</h1>' + form(`<label>Choice <select id="option"><option value="none">Choose</option><option value="${expected.option}">${esc(fixture.optionLabel)}</option></select></label>` +
    `<label>Enabled <input id="checked" type="checkbox"></label><label>Text <input id="text"></label><p>Entry text: ${esc(expected.text)}</p>`) +
    post("const value={option:document.getElementById('option').value,checked:document.getElementById('checked').checked,text:document.getElementById('text').value};");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>World ${esc(kind)}</title><style>body{font:18px system-ui;margin:32px}label{display:block;margin:16px}td,th{padding:12px}</style>${body}</html>`;
}

export function browserHandler(fixture, origin) {
  return async (req, res) => {
    const send = (code, type, body = '') => res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    const prefix = `/${fixture.nonce}/`, route = new URL(req.url, origin).pathname;
    if (req.headers.host !== new URL(origin).host || !route.startsWith(prefix)) return send(404, 'text/plain');
    if (req.headers.origin && req.headers.origin !== origin) return send(403, 'text/plain');
    const path = route.slice(prefix.length);
    if (req.method === 'POST' && path === 'state') {
      if (req.headers['content-type'] !== 'application/json') return send(400, 'text/plain');
      let body = '', size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 32768) { req.resume?.(); return send(413, 'text/plain'); }
        body += chunk;
      }
      try { fixture.posted = JSON.parse(body); } catch { return send(400, 'text/plain'); }
      return send(204, 'text/plain');
    }
    if (req.method !== 'GET' || (path !== '' && !(fixture.kind === 'tab-switching' && path === 'second')
      && !(fixture.kind === 'multi-page-search' && /^record\/[123]$/.test(path)))) return send(404, 'text/plain');
    fixture.views.push(path);
    return send(200, 'text/html; charset=utf-8', page(fixture, path));
  };
}

export function checkBrowserFixture(fixture, answer) {
  if (!fixture.views.includes('')) return 'WORLD_PAGE_NOT_READ';
  if (fixture.kind === 'multi-page-search' && !fixture.views.includes('record/2')) return 'WORLD_RECORD_NOT_READ';
  if (fixture.kind === 'tab-switching' && !fixture.views.includes('second')) return 'WORLD_SECOND_TAB_NOT_READ';
  let actual = fixture.posted;
  if (!['file-upload', 'tab-switching', 'form-controls'].includes(fixture.kind)) {
    try { actual = JSON.parse(answer.trim()); } catch { return 'WORLD_ANSWER_NOT_JSON'; }
  }
  return isDeepStrictEqual(actual, fixture.expected) || 'WORLD_FIXTURE_MISMATCH';
}

export async function serveWorldPage(ctx, kind) {
  if (ctx.closeServer) throw new Error('world page server already exists');
  ctx.worldPage = createBrowserFixture(kind, ctx);
  let origin;
  const server = createServer((req, res) => browserHandler(ctx.worldPage, origin)(req, res).catch(() => res.writeHead(500).end()));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  ctx.url = `${origin}/${ctx.nonce}/`;
  ctx.closeServer = () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}
