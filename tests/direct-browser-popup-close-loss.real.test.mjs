// A sign-in popup that closes itself must not cost turbo its connection (fowl loss study item 4, 2026-10-18).
// Real headless Chromium behind the production selected connection, filter, page registry and tool runtime.
// Only the process-proof providers are synthetic (the headless shell writes no SingletonLock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { createSelectedConnection } from '../plugins/sleight/lib/direct-browser/selected-connection.mjs';
import { createPageRegistry } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { createV3TurnRuntime } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';

const vendor = new URL('../plugins/sleight/vendor/playwright-core/', import.meta.url);
const spec = JSON.parse(readFileSync(new URL('browsers.json', vendor))).browsers.find(b => b.name === 'chromium-headless-shell');
const executable = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + spec.revision,
  'chrome-headless-shell-' + (process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64'), 'chrome-headless-shell');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'real Chromium qualification belongs to the host runner'
  : !existsSync(executable) ? 'the pinned headless Chromium is missing' : false;

async function fixture(t) {
  const { chromium } = await import(new URL('index.mjs', vendor));
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-popup-loss-')))), events = [], losses = [], sockets = new Set();
  let origin, context, selected, filter, listener, browser, registry, runtime, active = true;
  const server = createServer(async (request, response) => {
    const route = new URL(request.url, 'http://fixture.invalid').pathname;
    if (route === '/events') {
      let body = ''; for await (const chunk of request) body += chunk;
      events.push(body); response.end('ok'); return;
    }
    // The popup is cross-origin, as DemoID's is: another host spelling of this loopback server.
    const identity = origin.replace('127.0.0.1', 'localhost');
    const pages = {
      '/shop': `<button type="button" id="identity">Sign in with DemoID</button><p id="signed">Signed out</p><script>
        document.querySelector('#identity').onclick = () => window.open('${identity}/authorize', 'identity', 'popup,width=480,height=640');
        window.addEventListener('message', event => { if (event.origin === '${identity}' && event.data.name) document.querySelector('#signed').textContent = 'Signed in as ' + event.data.name; });</script>`,
      '/authorize': `<button type="button" onclick="navigator.sendBeacon('/events', 'continue'); window.opener.postMessage({name:'Robin Vale'}, '${origin}'); window.close()">Continue as Robin Vale</button>`,
    };
    response.writeHead(pages[route] ? 200 : 404, { 'content-type': 'text/html' });
    response.end(`<html><head><title>${route}</title></head><body>${pages[route] ?? 'missing'}</body></html>`);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => {
    active = false;
    try {
      await runtime?.end().catch(() => {}); await browser?.close().catch(() => {}); await filter?.dispose().catch(() => {});
      await listener?.close().catch(() => {}); await selected?.disconnect(selected.session).catch(() => {}); await context?.close().catch(() => {});
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(existsSync(root), false);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  context = await chromium.launchPersistentContext(root, { executablePath: executable, headless: true, args: ['--remote-debugging-port=0'], viewport: null });
  const port = readFileSync(join(root, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], pid = process.pid, start = Date.now() - 600000;
  symlinkSync(hostname() + '-' + pid, join(root, 'SingletonLock'));
  selected = await createSelectedConnection({ config: { profileRoot: root, executable }, testDependencies: {
    processMetadata: async () => ({ uid: process.getuid(), pid, start, incarnation: `p${pid}-s${start}-u1` }),
    execFile: async () => ({ stdout: `p${pid}\nu${process.getuid()}\nf12\nn127.0.0.1:${port}\n` }) } });
  selected.onConnectionLoss(reason => losses.push(reason));
  await selected.connect();
  filter = selected.createFilter(); listener = await filter.listen();
  browser = await chromium.connectOverCDP(listener.endpoint, { noDefaults: true, timeout: 10000 });
  const session = await browser.newBrowserCDPSession();
  registry = createPageRegistry({ browser, session, endpoint: selected.endpoint, endpointBlocked: filter.endpointBlocked, upstream: selected.session,
    ownTarget: filter.own, releaseTarget: filter.release, frames: filter.frames });
  const binding = createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'request', text: 'Sign in with DemoID and tell me who is signed in.' }, () => active);
  runtime = await createV3TurnRuntime({ binding, browser: selected.selectedBrowser, pages: registry, snapshot, ui: {}, endpoint: selected.endpoint,
    dependencies: { acknowledgeSnapshot } });
  const call = async (name, args) => { const result = await runtime.call({ name, arguments: args }); runtime.delivered(result); return result; };
  const ref = (text, label) => {
    const row = text.split('\n').find(line => line.includes('[ref=') && line.includes('"' + label + '"'));
    assert.ok(row, 'no ' + label + ' in:\n' + text);
    return /\[ref=((?:f\d+)?e\d+)\]/.exec(row)[1];
  };
  return { call, ref, origin, events, losses, selected, context, registry };
}

test('a sign-in popup that closes itself is released, its opener reads next, and the connection stays', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t);
  const opened = await f.call('browser_open', { url: f.origin + '/shop' });
  assert.equal(opened.isError, false, opened.text);
  const opener = /^t\w+/.exec(opened.text)?.[0]; assert.ok(opener, opened.text);
  const clicked = await f.call('browser_act', { tab: opener, steps: [{ do: 'click', ref: f.ref(opened.text, 'Sign in with DemoID') }], observe: 'none' });
  assert.equal(clicked.isError, false, clicked.text);
  const listing = (await f.call('browser_tabs', { do: 'list' })).text;
  const popup = listing.split('\n').map(line => /^(t\w+).*\(opener (t\w+)\)/.exec(line)).find(Boolean);
  assert.ok(popup, 'the popup is an owned tab:\n' + listing); assert.equal(popup[2], opener);
  const popupRead = await f.call('browser_read', { tab: popup[1] });
  assert.equal(popupRead.isError, false, popupRead.text);
  const confirmed = await f.call('browser_act', { tab: popup[1], steps: [{ do: 'click', ref: f.ref(popupRead.text, 'Continue as Robin Vale') }] });
  t.diagnostic('click on the self-closing popup: ' + JSON.stringify(confirmed.text.slice(0, 200)));
  assert.doesNotMatch(confirmed.text, /unavailable for this turn/);
  // The next read on the opener succeeds, and the sign-in input was sent once.
  const next = await f.call('browser_read', { tab: opener });
  assert.equal(next.isError, false, next.text);
  assert.match(next.text, /Signed in as Robin Vale/);
  assert.match((await f.call('browser_tabs', { do: 'list' })).text, new RegExp(opener));
  assert.deepEqual(f.events, ['continue']);
  assert.deepEqual(f.losses, [], 'a popup closing is not a connection loss');
  assert.equal(await f.selected.verifyConnection(f.selected.session), true);
});

test('a real browser disconnect is still a connection loss with a reason code', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t);
  const opened = await f.call('browser_open', { url: f.origin + '/shop' });
  assert.equal(opened.isError, false, opened.text);
  await f.context.close();
  const until = Date.now() + 10000;
  while (!f.losses.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.losses.length, 1); assert.match(f.losses[0], /^SOCKET_(?:ERROR|CLOSED)$/);
  assert.equal(await f.selected.verifyConnection(f.selected.session), false);
  await assert.rejects(f.selected.session.send('Target.getTargets'), /SELECTED_CONNECTION_CLOSED/);
});
