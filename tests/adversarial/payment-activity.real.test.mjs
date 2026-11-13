import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { bank, doc, skip, payRequest } from './fixtures/bank.mjs';
import { trackPage, observeActivity, openRequestCount } from '../../plugins/sleight/lib/direct-browser/activity.mjs';

// Round 7, F1 to F4 (the round 6 reviewer's repros). A script-driven control that the page names like a closed-list verb ("Apply")
// spends the request's one payment activation and gets it back only when nothing left the browser until the next payment check.
// Every handler below charges the fixture server from somewhere the round 6 watch did not look. The user named the 18.00 payment, so
// at most one of the two clicks may charge, and Pay must ask.
const meta = '<p data-payment-item="Fixture item">Item: Fixture item</p><p data-payment-payee="Fixture shop">Payee: Fixture shop</p><p data-payment-currency="USD">Currency: USD</p>';
const amt = '<span data-payment-amount="18.00">18.00</span>';
const page = (name, handler, extra = '', boot = '') => `<form id=payment>${meta}<p>Total: $${amt}</p><label>Card number<input autocomplete="cc-number"></label>
<button type=button id=ctl>${name}</button><button id=pay>Pay now</button></form>${extra}<script>${boot}
document.getElementById('ctl').addEventListener('click', ()=>{ ${handler} });</script>`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const frames = { n: 0 };
const wss = createServer().on('upgrade', (req, sock) => {
  const key = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + key + '\r\n\r\n');
  sock.on('data', () => { frames.n++; }); sock.on('error', () => {});
});
await new Promise(resolve => wss.listen(0, '127.0.0.1', resolve));
test.after(() => { wss.close(); wss.closeAllConnections?.(); });

// F1. Turns that end with a deferred refund and no later payment check must not keep listeners on the browser context.
test('F1: 14 turns that each end after a quiet "Show order summary" leave no extra listeners on the context', { skip, timeout: 280000 }, async t => {
  const html = `<form id=payment>${meta}<p>Total: $${amt}</p><label>Card number<input autocomplete="cc-number"></label><button type=button id=ctl>Show order summary</button><button id=pay>Pay now</button></form>`;
  const events = ['request', 'requestfailed', 'requestfinished', 'serviceworker', 'weberror', 'page'];
  const b = await bank(t);
  const count = f => { const c = b.browser.contexts()[0]; return { ...Object.fromEntries(events.map(e => [e, c.listenerCount(e)])), websocket: f.page.listenerCount('websocket'), worker: f.page.listenerCount('worker') }; };
  let baseline, midTurn;
  for (let turn = 1; turn <= 14; turn++) {
    const f = await b.start(doc(html), payRequest);
    if (turn === 1) baseline = count(f); else assert.deepEqual(count(f), baseline, 'turn ' + turn + ' starts with the listeners of turn 1');
    let out = f.opened; if (/Snapshot unavailable/.test(f.opened)) out = await f.read();
    await f.act([{ do: 'click', ref: f.ref('Show order summary', out) }]);
    if (turn === 1) { midTurn = count(f); assert.ok(midTurn.request > baseline.request, 'the deferred watch is attached while the turn runs'); }
  }
  t.diagnostic('listeners at each turn start: ' + JSON.stringify(baseline) + '; during a turn: ' + JSON.stringify(midTurn));
});

// F2 to F4 and the earlier blind-spot hunt.
const handlers = {
  'noopener popup to the charge url': { handler: 'window.open("/effect?kind=payment","_blank","noopener")' },
  'a[ping] anchor click': { handler: 'const a=document.createElement("a");a.href="#x";a.ping="/effect?kind=payment";document.body.appendChild(a);a.click()' },
  'link rel=prefetch': { handler: 'const l=document.createElement("link");l.rel="prefetch";l.href="/effect?kind=payment";document.head.appendChild(l)' },
  'speculation rules prerender': { handler: 'const s=document.createElement("script");s.type="speculationrules";s.textContent=JSON.stringify({prerender:[{source:"list",urls:["/effect?kind=payment"]}]});document.head.appendChild(s)' },
  'CSP violation report (report-uri)': { handler: 'new Image().src="https://example.invalid/x.png"', csp: "img-src 'self'; report-uri /effect?kind=payment" },
  'cross-origin frame inserted now, beacons on load': { handler: 'const f=document.createElement("iframe");f.style.cssText="width:1px;height:1px";f.src=location.origin.replace("127.0.0.1","localhost")+"/xf";document.body.appendChild(f)', routes: ob => ({ '/xf': `<script>navigator.sendBeacon("${ob}/effect?kind=payment")</script>` }) },
  'cross-origin frame inserted 6.5 s later, beacons on load': { handler: 'setTimeout(()=>{const f=document.createElement("iframe");f.style.cssText="width:1px;height:1px";f.src=location.origin.replace("127.0.0.1","localhost")+"/xf";document.body.appendChild(f)},6500)', routes: ob => ({ '/xf': `<script>navigator.sendBeacon("${ob}/effect?kind=payment")</script>` }), settle: 3500 },
  // F2: a tab of the page's own origin that sleight does not own. It listens on a channel the page can reach and sends the charge itself.
  'F2 BroadcastChannel to an unowned same-origin tab': { handler: 'new BroadcastChannel("pay").postMessage("go")', other: 'new BroadcastChannel("pay").onmessage=()=>fetch("/effect?kind=payment",{method:"POST"})' },
  'F2 localStorage event to an unowned same-origin tab': { handler: 'localStorage.setItem("go", String(Math.random()))', other: 'addEventListener("storage",()=>fetch("/effect?kind=payment",{method:"POST"}))' },
};
async function twoClicks(t, name, spec) {
  const b = await bank(t), routes = spec.routes ? spec.routes(b.origin) : {};
  if (spec.other) routes['/otab'] = `<!doctype html><title>other tab</title><script>${spec.other}</script>`;
  const html = page(name, spec.handler, spec.extra ?? '', spec.boot ?? '');
  if (spec.csp) routes['/attack-1'] = (req, res) => { res.setHeader('content-type', 'text/html'); res.setHeader('content-security-policy', spec.csp); res.end(doc(html)); };
  const f = await b.start(spec.csp ? '' : doc(html), payRequest, { routes });
  if (spec.other) { await b.foreign.goto(b.origin + '/otab'); await wait(400); }
  let out = f.opened; if (/Snapshot unavailable/.test(f.opened)) out = await f.read();
  const first = await f.act([{ do: 'click', ref: f.ref(name, out) }]);
  await wait(spec.settle ?? 600);
  const afterFirst = f.delta().payment;
  let second = { text: 'Pay unreachable' };
  try { out = await f.read(); second = await f.act([{ do: 'click', ref: f.ref('Pay now', out) }]); } catch { /* a cross-origin frame makes the read fail: Pay cannot be reached */ }
  await wait(1200);
  return { afterFirst, total: f.delta().payment, first: first.text.split('\n')[0], second: second.text.split('\n')[0] };
}
for (const [label, spec] of Object.entries(handlers)) {
  test('"Apply" + ' + label + ': at most one charge, and Pay asks or cannot be reached', { skip, timeout: 120000 }, async t => {
    const r = await twoClicks(t, 'Apply', spec);
    assert.ok(r.total <= 1, label + ' charged ' + r.total + ' times: ' + r.first + ' | ' + r.second);
    assert.match(r.second, /confirmation required|Submit unconfirmed|Pay unreachable/);
  });
}
test('"Apply" that does nothing at all (control for the table above): Pay is allowed once', { skip, timeout: 120000 }, async t => {
  const r = await twoClicks(t, 'Apply', { handler: '/* nothing */' });
  assert.equal(r.afterFirst, 0);
  assert.equal(r.total, 1, r.second);
});

// A service worker registered earlier that wakes on a message, running or stopped.
const sw = 'self.addEventListener("message",e=>{e.waitUntil(fetch("/effect?kind=payment",{method:"POST"}))});self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",e=>e.waitUntil(clients.claim()));';
for (const stop of [false, true]) test('"Apply" + service worker that wakes on postMessage and fetches (stopped=' + stop + '): at most one charge, Pay asks', { skip, timeout: 120000 }, async t => {
  const b = await bank(t);
  const html = page('Apply', 'navigator.serviceWorker.ready.then(r=>r.active.postMessage("go"))', '', 'navigator.serviceWorker.register("/sw.js");');
  const f = await b.start(doc(html), payRequest, { routes: { '/sw.js': sw } });
  await wait(2000);
  if (stop) {
    const hp = b.host.pages().find(p => p.url().includes('/attack-1')), cdp = await b.host.newCDPSession(hp);
    await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers'); await wait(1000);
  }
  let out = f.opened; if (/Snapshot unavailable/.test(f.opened)) out = await f.read();
  await f.act([{ do: 'click', ref: f.ref('Apply', out) }]);
  await wait(500);
  out = await f.read();
  const second = await f.act([{ do: 'click', ref: f.ref('Pay now', out) }]);
  await wait(1200);
  assert.ok(f.delta().payment <= 1, 'charged ' + f.delta().payment + ' times');
  assert.match(second.text.split('\n')[0], /confirmation required/);
});

// F3. An owned second tab holds an open WebSocket and a BroadcastChannel listener; "Apply" in tab 1 broadcasts, tab 2 sends the frame.
test('F3: "Apply" that makes another owned tab send a WebSocket frame: one charge in total, Pay asks', { skip, timeout: 120000 }, async t => {
  const b = await bank(t);
  const page1 = page('Apply', 'new BroadcastChannel("p").postMessage("go")');
  const tab2 = `<!doctype html><title>tab2</title><script>const ws=new WebSocket('ws://127.0.0.1:${wss.address().port}/c');new BroadcastChannel('p').onmessage=()=>ws.send('CHARGE')</script>`;
  const f = await b.start(doc(page1), payRequest, { routes: { '/tab2': tab2 } });
  await b.open(b.origin + '/tab2');
  await wait(800);
  const base = frames.n;
  let out = await f.read();
  await f.act([{ do: 'click', ref: f.ref('Apply', out) }]);
  await wait(500);
  const afterFirst = frames.n - base;
  out = await f.read();
  const second = await f.act([{ do: 'click', ref: f.ref('Pay now', out) }]);
  await wait(800);
  assert.equal(afterFirst, 1, 'the frame was sent');
  assert.equal(f.delta().payment, 0, 'the page itself did not charge');
  assert.match(second.text.split('\n')[0], /confirmation required/);
});

// F4. A request still open when the click happens (a streaming upload over HTTP/2) carries the charge after the click with no new event.
function certificate() {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-h2-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
  } catch { return undefined; } finally { rmSync(dir, { recursive: true, force: true }); }
}
function chromiumPath() {
  const spec = JSON.parse(readFileSync(new URL('../../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url))).browsers.find(x => x.name === 'chromium-headless-shell');
  return join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + spec.revision, 'chrome-headless-shell-' + (process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64'), 'chrome-headless-shell');
}
test('F4: a streaming request opened before the watch ends the refund: quiet false, verify false (a request that finished does not)', { skip, timeout: 60000 }, async t => {
  const tls = certificate();
  if (!tls) return t.skip('openssl is not available');
  const { chromium } = await import('../../plugins/sleight/vendor/playwright-core/index.mjs');
  const chunks = [];
  const server = http2.createSecureServer(tls, (req, res) => {
    res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', '*'); res.setHeader('access-control-allow-methods', '*');
    if (req.method === 'GET') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>x</title>'); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    req.on('data', d => chunks.push(String(d))); req.on('end', () => res.end('ok'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });
  t.after(async () => { await browser.close(); server.close(); server.closeAllConnections?.(); });
  const context = await browser.newContext({ ignoreHTTPSErrors: true }), tab = await context.newPage(), cdp = await context.newCDPSession(tab);
  trackPage(tab, { targets: () => cdp.send('Target.getTargets') });
  await tab.goto('https://localhost:' + server.address().port + '/');
  const quietWatch = observeActivity(tab);
  assert.equal(await quietWatch.verify(), true, 'a page with nothing in flight verifies'); quietWatch.stop();
  await tab.evaluate(() => {
    const ts = new TransformStream(); window.w = ts.writable.getWriter();
    window.p = fetch('/up', { method: 'POST', body: ts.readable, duplex: 'half' }).catch(() => {});
    setTimeout(() => window.w.write(new TextEncoder().encode('first')), 100);
  });
  await wait(800);
  const watch = observeActivity(tab);
  await tab.evaluate(() => { window.w.write(new TextEncoder().encode('CHARGE-AFTER-CLICK')); });
  await wait(800);
  assert.ok(chunks.includes('CHARGE-AFTER-CLICK'), 'the charge went out on the old request: ' + chunks);
  assert.equal(await watch.verify(), false);
  assert.equal(watch.quiet(), false);
  watch.stop();
});

// ---------------------------------------------------------------- Round 8
// F-B. A request still open when its page closes or its frame loads a new document is never reported as ended; it must stop counting,
// or every later refund on the browser context fails and the Request objects pile up. A same-document change drops nothing.
const stuckCheckout = doc(`<form id=payment>${meta}<p>Total: $${amt}</p><label>Card number<input autocomplete="cc-number"></label><button type=button id=ctl>Show order summary</button><button id=pay>Pay now</button></form><script>document.getElementById('ctl').addEventListener('click',()=>{document.title='x'})</script>`);
for (const [name, boot] of [['nothing pending', ''], ['a fetch the server never answers, still open when the link is clicked', 'fetch("/silent").catch(()=>{});'], ['an image whose body never ends', 'document.write("<img src=/slowimg>")']]) {
  test('F-B end to end: cart page with ' + name + ', link to the checkout, quiet "Show order summary" is refunded, Pay is allowed, nothing stays open', { skip, timeout: 120000 }, async t => {
    const b = await bank(t);
    const f = await b.start(doc(`<a href="/checkout">Open cart details</a><script>${boot}</script>`, '', ''), payRequest, { routes: { '/checkout': stuckCheckout, '/silent': () => {}, '/slowimg': (req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.write(Buffer.from('89504e470d0a1a0a', 'hex')); } } });
    let out = f.opened; if (/Snapshot unavailable/.test(f.opened)) out = await f.read();
    await f.act([{ do: 'click', ref: f.ref('Open cart details', out) }]);
    await wait(1500);
    out = await f.read();
    assert.equal(openRequestCount(f.page), 0, 'the old document\'s requests are gone from the in-flight set');
    await f.act([{ do: 'click', ref: f.ref('Show order summary', out) }]);
    out = await f.read();
    const pay = await f.act([{ do: 'click', ref: f.ref('Pay now', out) }]);
    await wait(800);
    assert.equal(f.delta().payment, 1, pay.text.split('\n')[0]);
  });
}
test('F-B: the in-flight set drops what a closed page, a navigated frame, a detached frame and a new document left open, and keeps what a same-document change or a navigation that never commits left open', { skip, timeout: 120000 }, async t => {
  const { chromium } = await import('../../plugins/sleight/vendor/playwright-core/index.mjs');
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url.startsWith('/silent')) return;
    if (req.url.startsWith('/img')) { res.writeHead(200, { 'content-type': 'image/png' }); res.write(Buffer.from('89504e470d0a1a0a', 'hex')); return; }
    if (req.url.startsWith('/204')) { res.writeHead(204); res.end(); return; }
    if (req.url.startsWith('/dl')) { res.writeHead(200, { 'content-disposition': 'attachment; filename=x.bin', 'content-type': 'application/octet-stream' }); res.end('abc'); return; }
    if (req.url.startsWith('/slow204')) { setTimeout(() => { res.writeHead(204); res.end(); }, 1500); return; }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>x</title>hello');
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath() });
  t.after(async () => { for (const s of sockets) s.destroy(); await browser.close(); server.close(); });
  const results = {};
  async function scenario(label, expectedCount, run) {
    const context = await browser.newContext(), cdp = await context.newCDPSession(await context.newPage());
    const open = async () => { const tab = await context.newPage(); trackPage(tab, { targets: () => cdp.send('Target.getTargets') }); await tab.goto(origin + '/'); return tab; };
    const first = context.pages()[0]; trackPage(first, { targets: () => cdp.send('Target.getTargets') }); await first.goto(origin + '/');
    const tab = await open();
    await run(tab, open);
    await wait(700);
    const watch = observeActivity(tab), count = openRequestCount(tab), quiet = watch.quiet(), verified = await watch.verify();
    watch.stop();
    results[label] = { count, quiet, verified };
    await context.close();
    assert.equal(count, expectedCount, label + ': open requests ' + count);
    assert.equal(quiet, expectedCount === 0, label + ': quiet');
  }
  const fetchOpen = tab => tab.evaluate(url => { fetch(url + '/silent' + Math.random()); }, origin);
  await scenario('fetch open, new document in the tab', 0, async tab => { await fetchOpen(tab); await wait(300); await tab.goto(origin + '/second'); });
  await scenario('XHR open, new document', 0, async tab => { await tab.evaluate(() => { const x = new XMLHttpRequest(); x.open('GET', '/silent2'); x.send(); }); await wait(300); await tab.goto(origin + '/second'); });
  await scenario('slow image, new document', 0, async tab => { await tab.evaluate(() => { const i = new Image(); i.src = '/img1'; document.body.appendChild(i); }); await wait(300); await tab.goto(origin + '/second'); });
  await scenario('slow script tag, new document', 0, async tab => { await tab.evaluate(() => { const s = document.createElement('script'); s.src = '/img3'; document.head.appendChild(s); }); await wait(300); await tab.goto(origin + '/second'); });
  await scenario('fetch open, reload', 0, async tab => { await fetchOpen(tab); await wait(300); await tab.reload(); });
  await scenario('fetch open, navigation by script', 0, async tab => { await fetchOpen(tab); await wait(300); await tab.evaluate(() => { location.href = '/second'; }); await tab.waitForURL('**/second'); });
  await scenario('fetch open, about:blank (no request at all)', 0, async tab => { await fetchOpen(tab); await wait(300); await tab.evaluate(() => { location.href = 'about:blank'; }); await tab.waitForURL('about:blank'); });
  await scenario('image open, tab closed', 0, async (tab, open) => { await tab.evaluate(() => { const i = new Image(); i.src = '/img2'; document.body.appendChild(i); }); await wait(300); await tab.close(); });
  await scenario('request open in an iframe, iframe removed', 0, async tab => {
    await tab.evaluate(url => { const f = document.createElement('iframe'); f.srcdoc = '<script>fetch("' + url + '/silent9")</script>'; document.body.appendChild(f); }, origin);
    await wait(500); await tab.evaluate(() => document.querySelector('iframe').remove());
  });
  await scenario('request open in an iframe, iframe navigates', 0, async tab => {
    await tab.evaluate(url => { const f = document.createElement('iframe'); f.srcdoc = '<script>fetch("' + url + '/silent8")</script>'; document.body.appendChild(f); }, origin);
    await wait(500); await tab.evaluate(() => { const f = document.querySelector('iframe'); f.removeAttribute('srcdoc'); f.src = '/second'; }); await wait(500);
  });
  await scenario('600 hanging fetches (past the cap), new document', 0, async tab => { await tab.evaluate(url => { for (let i = 0; i < 600; i++) fetch(url + '/silent' + i).catch(() => {}); }, origin); await wait(1500); await tab.goto(origin.replace('127.0.0.1', 'localhost') + '/second'); });
  // Nothing may drop a request whose document is still there.
  await scenario('fetch open, pushState', 1, async tab => { await fetchOpen(tab); await wait(300); await tab.evaluate(() => history.pushState({}, '', '/pushed')); });
  await scenario('fetch open, hash change', 1, async tab => { await fetchOpen(tab); await wait(300); await tab.evaluate(() => { location.hash = 'x'; }); });
  await scenario('fetch open, a 204 navigation, then pushState', 1, async tab => {
    await fetchOpen(tab); await wait(300);
    await tab.evaluate(() => { location.href = '/204'; }); await wait(500);
    await tab.evaluate(() => history.pushState({}, '', '/pushed'));
  });
  await scenario('fetch open, a download navigation, then pushState', 1, async tab => {
    await fetchOpen(tab); await wait(300);
    await tab.evaluate(() => { location.href = '/dl'; }); await wait(500);
    await tab.evaluate(() => history.pushState({}, '', '/pushed'));
  });
  await scenario('fetch open, a slow 204 navigation that ends after a pushState', 1, async tab => {
    await fetchOpen(tab); await wait(300);
    await tab.evaluate(() => { location.href = '/slow204'; }); await wait(300);
    await tab.evaluate(() => history.pushState({}, '', '/pushed')); await wait(1800);
  });
  await scenario('fetch open in another tab, this tab navigates', 1, async (tab, open) => { const other = await open(); await fetchOpen(other); await wait(300); await tab.goto(origin + '/second'); });
  t.diagnostic(JSON.stringify(results));
});

// F-C. A dedicated worker of an owned cross-origin popup fetches the charge without a report to the context.
const popupPage = (handler, boot = '', outside = '') => `${outside}<form id=payment>${meta}<p>Total: $${amt}</p><label>Card number<input autocomplete="cc-number"></label>
<button type=button id=ctl>Apply</button><button id=pay>Pay now</button></form><script>${boot}
document.getElementById('ctl').addEventListener('click', ()=>{ ${handler} });</script>`;
const popups = {
  'cross-origin owned popup with a dedicated worker': (o, x) => ({
    html: popupPage('window.__w.postMessage("go","*")', 'window.openHelp=()=>{window.__w=window.open("' + x + '/help","help")}', '<button id=help onclick="openHelp()">Help</button>'),
    routes: { '/help': `<!doctype html><title>help</title><script>const b=new Blob(['onmessage=()=>fetch("${o}/effect?kind=payment",{method:"POST",mode:"no-cors"})']);const w=new Worker(URL.createObjectURL(b));onmessage=()=>w.postMessage("go")</script>` } }),
  'cross-origin owned popup with a plain fetch': (o, x) => ({
    html: popupPage('window.__w.postMessage("go","*")', 'window.openHelp=()=>{window.__w=window.open("' + x + '/help","help")}', '<button id=help onclick="openHelp()">Help</button>'),
    routes: { '/help': `<!doctype html><title>help</title><script>onmessage=()=>fetch("${o}/effect?kind=payment",{method:"POST",mode:"no-cors"})</script>` } }),
  'same-origin owned popup with a plain fetch': (o, x) => ({
    html: popupPage('window.__w.postMessage("go","*")', 'window.openHelp=()=>{window.__w=window.open("/help","help")}', '<button id=help onclick="openHelp()">Help</button>'),
    routes: { '/help': '<!doctype html><title>help</title><script>onmessage=()=>fetch("/effect?kind=payment",{method:"POST"})</script>' } }),
};
for (const [name, make] of Object.entries(popups)) test('F-C: ' + name + ': one charge in total, Pay asks', { skip, timeout: 120000 }, async t => {
  const b = await bank(t), o = b.origin, x = o.replace('127.0.0.1', 'localhost'), spec = make(o, x);
  const f = await b.start(doc(spec.html), payRequest, { routes: spec.routes });
  let out = f.opened; if (/Snapshot unavailable/.test(f.opened)) out = await f.read();
  await f.act([{ do: 'click', ref: f.ref('Help', out) }]);
  await wait(1200);
  out = await f.read();
  await f.act([{ do: 'click', ref: f.ref('Apply', out) }]);
  await wait(800);
  out = await f.read();
  const pay = await f.act([{ do: 'click', ref: f.ref('Pay now', out) }]);
  await wait(1200);
  assert.equal(f.delta().payment, 1, 'charges in total; Pay: ' + pay.text.split('\n')[0]);
  assert.match(pay.text, /confirmation required|not run/i, pay.text.split('\n')[0]);
});
