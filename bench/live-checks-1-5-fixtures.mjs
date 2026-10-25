import { createServer } from 'node:http';
import { type3Pdf } from '../tests/fixtures/pdf-type3.mjs';
import { phrases } from '../tests/fixtures/consent-g11f.mjs';
import { depthPage } from './web-pages/depth.mjs';
import { createWholeFixture, wholeHandler } from './fowl/site/whole-thread.mjs';

export const pdfBytes = type3Pdf();
export function fixtureHTML(path) {
  if (path === '/motion') return depthPage('hover', 'lc1', '/depth/', undefined) + `<style>
    @keyframes lc1-motion { from { background-color: rgb(255,0,0); transform: translateX(0); }
      to { background-color: rgb(0,0,255); transform: translateX(80px); } }
    #actions-Orchid:hover #menu-Orchid { display: inline-block; animation: lc1-motion 1s linear infinite alternate; }
    </style>`;
  const metrics = `<p id="metrics"></p><script>
    const metrics=()=>{const value='Metrics width='+innerWidth+' height='+innerHeight+' dpr='+devicePixelRatio+
      ' dark='+matchMedia('(prefers-color-scheme: dark)').matches+' reduced='+matchMedia('(prefers-reduced-motion: reduce)').matches+' touch='+navigator.maxTouchPoints;
      const node=document.getElementById('metrics');if(node.textContent!==value)node.textContent=value;};
    metrics();addEventListener('resize',metrics);setInterval(metrics,200);
    const report=value=>fetch('/state'+location.pathname,{method:'POST',body:JSON.stringify(value)});
    </script>`;
  const body = path === '/protected' ? '<label>Secret <input type="password" value="fixture-only"></label>'
    : path === '/points' ? `<style>body{margin:0}button{position:absolute;left:20px;width:160px;height:40px}#plain{top:80px}#pay{top:160px}#metrics{position:absolute;top:300px}</style>
      <button id="plain" onclick="document.getElementById('out').textContent='Plain clicked';report({plain:1,pay:0})">Plain button</button>
      <button id="pay" onclick="report({plain:1,pay:1})">Pay $10</button><p id="out" style="position:absolute;top:240px">Waiting</p>`
    : path === '/mailto' ? '<a href="/http-to-mailto">Open fixture mail link</a>'
    : path === '/download' ? '<a href="/document.pdf" download="sleight-lc1.pdf">Download fixture PDF</a>'
    : path === '/paste' ? `<label>Note<textarea id="note" oninput="report({note:this.value})"></textarea></label>
      <table role="grid" aria-label="Sheet"><tr><td role="gridcell" tabindex="0" contenteditable="true" aria-label="Paste grid" id="grid"></td></tr></table><p id="grid-result"></p>
      <script>document.getElementById('grid').addEventListener('paste',e=>{e.preventDefault();const value=e.clipboardData.getData('text/plain');
      const cells=value.split('\\n').map(r=>r.split('\\t'));document.getElementById('grid-result').textContent=JSON.stringify(cells);report({grid:cells});});</script>`
    : path === '/cookie' ? `<section role="dialog" aria-label="Cookie consent"><h2>${phrases[0]}</h2><p>Choose whether to allow optional analytics cookies.</p>
      <button onclick="report({accepted:true});document.getElementById('out').textContent='Accepted'">Accept all cookies</button>
      <button onclick="report({rejected:true});this.parentElement.remove();document.getElementById('out').textContent='Rejected'">Reject all</button></section><p id="out">Waiting</p>`
    : path === '/developer' ? `<button onclick="console.log('fixture ready');fetch('/probe').then(()=>document.getElementById('out').textContent='Probe done')">Log fixture</button><p id="out">Waiting</p>`
    : (path === '/record' ? '<label>Name<input id="name"></label>' : '')
      + '<button onclick="document.getElementById(\'out\').textContent=\'Clicked one\'">First action</button><button onclick="document.getElementById(\'out\').textContent=\'Clicked two\'">Second action</button><p id="out">Ready</p>';
  // Fixtures may request only this server. No externally loaded fonts, images, scripts or navigations.
  return '<!doctype html><html><meta charset="utf-8"><title>LC1 public fixture</title><style>body{font:16px system-ui}button,textarea,input,td{min-width:80px;min-height:30px}td{border:1px solid}</style>'
    + '<h1>LC1 public fixture</h1>' + body + metrics + '</html>';
}

export async function serveFixtures() {
  const state = new Map(), sockets = new Set();
  const whole = createWholeFixture('a', { nonce: 'lc1-chat' });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/whole/')) return await wholeHandler(whole, request, response);
      if (url.pathname.startsWith('/state/') && request.method === 'POST') {
        let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 10000) throw Error('fixture state too large'); }
        state.set(url.pathname.slice('/state'.length), { ...state.get(url.pathname.slice('/state'.length)), ...JSON.parse(body) });
        response.writeHead(204); response.end(); return;
      }
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
      if (url.pathname === '/http-to-mailto') { response.writeHead(302, { location: 'mailto:fixture@example.invalid?subject=LC1' }); response.end(); return; }
      if (url.pathname === '/document.pdf') {
        response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdfBytes.length, 'cache-control': 'no-store' }); response.end(pdfBytes); return;
      }
      if (url.pathname === '/probe') { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('ready'); return; }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'" });
      response.end(fixtureHTML(url.pathname));
    } catch { response.writeHead(500); response.end('Fixture failure'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: 'http://127.0.0.1:' + server.address().port, state: path => state.get(path) ?? {}, whole,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
