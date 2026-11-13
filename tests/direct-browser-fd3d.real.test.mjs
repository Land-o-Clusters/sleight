import { trackTemp } from '../scripts/temp-leftovers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTLSServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { inspectElement, check } from '../plugins/sleight/lib/direct-browser/rules.mjs';
import { inspectTarget } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { trustedLocatorRead } from '../plugins/sleight/lib/direct-browser/trusted-dom.mjs';
import { recoverPage, probePage } from '../plugins/sleight/lib/direct-browser/page-health.mjs';
const content = '<h1>Fixture with enough visible text to avoid the thin document delay</h1>';
test('FD3D real label activation resolves associated submit controls before input', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<form id="form" action="mailto:fixture@example.invalid"><button id="submit">Open</button>' +
    '<input id="image" type="image" formaction="zoommtg://fixture.invalid" alt="Open"></form>' +
    '<label for="submit" id="label"><span id="nested">Open app</span><a id="safe" href="/landed">Web</a></label>' +
    '<label for="image" id="imageLabel">Open image</label><label id="wrapped"><button form="form">Open</button></label>' +
    '<form id="web" action="/landed"><button id="websubmit">Open</button></form><label for="websubmit" id="webLabel">Open web</label>' +
    '<script>Object.defineProperty(document.querySelector("#label"),"control",{get(){return document.querySelector("#websubmit")}});' +
    'Object.defineProperty(document.querySelector("#submit"),"form",{get(){return document.querySelector("#web")}});</script>');
  for (const inspector of [inspectElement, inspectTarget]) for (const id of ['label', 'nested', 'imageLabel', 'wrapped', 'safe', 'webLabel']) {
    const value = await trustedLocatorRead(f.entry.page.locator('#' + id), inspector);
    const native = !['safe', 'webLabel'].includes(id);
    assert.equal(value.appLink, native, inspector.name + ':' + id);
    if (native) assert.match(check({}, 'click', { element: value }).message, /native app/);
  }
});
test('FD3D real checkbox, radio and range Enter are blocked before page handlers while clicks remain usable', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<form action="mailto:fixture@example.invalid">' +
    ['checkbox', 'radio', 'range'].map(type => `<input id="${type}" type="${type}">`).join('') + '<button>Open</button></form>');
  for (const inspector of [inspectElement, inspectTarget]) for (const id of ['checkbox', 'radio', 'range']) {
    const value = await trustedLocatorRead(f.entry.page.locator('#' + id), inspector);
    assert.equal(value.appLink, false); assert.equal(value.nativeFormEnter, true, inspector.name + ':' + id);
  }
  assert.deepEqual(await f.entry.page.evaluate(() => {
    const seen = [], allowed = [], clicks = [];
    for (const el of document.querySelectorAll('input')) {
      el.addEventListener('keydown', () => seen.push(el.id));
      allowed.push(el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
      el.addEventListener('click', event => { clicks.push(el.id); event.preventDefault(); });
      el.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    }
    return { seen, allowed, clicks };
  }), { seen: [], allowed: [false, false, false], clicks: ['checkbox', 'radio', 'range'] });
});
test('FD3D real named recovery allows a fragment and same-origin redirect paths', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), page = f.entry.page, origin = new URL(page.url()).origin;
  const named = origin.replace('127.0.0.1', 'localhost') + '/named#section';
  const landed = origin.replace('127.0.0.1', 'localhost') + '/landed';
  await page.route('**/named', route => route.fulfill({ status: 302, headers: { location: landed } }));
  f.entry.state.stuck = true;
  await recoverPage(f.entry, named, { allowCrossOrigin: true });
  assert.equal(page.url(), landed + '#section'); assert.equal(f.entry.state.stuck, false);
});
test('FD3D real named recovery allows HTTP upgrade and www variants without external requests', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), page = f.entry.page;
  const certDir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-fd3d-tls-')));
  t.after(() => rmSync(certDir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const sockets = new Set(), served = [];
  const tls = createTLSServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, (request, response) => {
    served.push(request.url); response.end(content);
  });
  tls.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (tls.listening) await new Promise(resolve => tls.close(resolve));
    t.diagnostic('cleanup: loopback TLS server and sockets closed, temporary test certificate removed');
  });
  await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
  // Certificate bypass applies only to this harness's disposable target.
  await f.entry.cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });
  const named = new URL(`http://localhost:${tls.address().port}/named#section`);
  const landed = new URL('/landed#section', named); landed.protocol = 'https:'; landed.hostname = 'www.localhost';
  await page.route('**/named', route => route.fulfill({ status: 302, headers: { location: landed.href } }));
  f.entry.state.stuck = true;
  await recoverPage(f.entry, named.href, { allowCrossOrigin: true });
  assert.equal(page.url(), landed.href);
  assert.ok(served.includes('/landed'));
  assert.equal(f.entry.state.stuck, false);
});
test('FD3D real custom-scheme redirects never pause in Fetch', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), page = f.entry.page, paused = [], notices = [];
  f.entry.cdp.on('Fetch.requestPaused', event => paused.push(event.request.url));
  f.entry.cdp.on('Page.frameRequestedNavigation', event => notices.push(event.url));
  await page.route('**/native-redirect', route => route.fulfill({ status: 302, headers: { location: 'mailto:fixture@example.invalid' } }));
  f.entry.state.stuck = true;
  await assert.rejects(recoverPage(f.entry, new URL('/native-redirect', page.url()).href));
  assert.ok(paused.some(url => url.endsWith('/native-redirect')));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(paused.some(url => url.startsWith('mailto:')), false);
  t.diagnostic(JSON.stringify({ notices, nativeNavigationNo: f.entry.state.nativeNavigationNo ?? 0 }));
});
test('FD3D real Fetch disable timeout retries on a non-navigation request', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), entry = f.entry, send = entry.cdp.send.bind(entry.cdp);
  let disables = 0;
  entry.cdp.send = (method, params) => method === 'Fetch.disable' && ++disables === 1 ? new Promise(() => {}) : send(method, params);
  entry.state.stuck = true;
  await recoverPage(entry, new URL('/landed', entry.page.url()).href);
  assert.equal(entry.state.recoveryFetchDisablePending, true);
  await entry.page.evaluate(async () => { await fetch('/follow-up'); });
  assert.ok(disables >= 2); assert.equal(entry.state.recoveryFetchDisablePending, false);
  assert.ok(f.requests.some(row => row.url === '/follow-up'));
});
test('FD3D real closed page probes unhealthy', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content);
  await f.entry.page.close();
  assert.equal(await probePage(f.entry, 100), false);
});
