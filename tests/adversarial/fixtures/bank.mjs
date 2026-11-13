import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../../../scripts/temp-leftovers.mjs';
import { createCDPFilter } from '../../../plugins/sleight/lib/direct-browser/cdp-filter.mjs';
import { createPageRegistry } from '../../../plugins/sleight/lib/direct-browser/page.mjs';
import { createV3TurnRuntime } from '../../../plugins/sleight/lib/direct-browser/worker.mjs';
import { createV3TurnBinding } from '../../../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { snapshot, acknowledgeSnapshot } from '../../../plugins/sleight/lib/direct-browser/snapshot.mjs';

// AD1 adversarial bank. Every page is a local fixture on 127.0.0.1. The route
// under test is real from the CDP filter through the five tools, the rules and
// the trust join. Native consent UI and the computer-use engine are not used,
// and no test connects to an existing browser. Run headless only.
export const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'AD1 adversarial real pages require sleight-arch host runner';
export const terms = { item: 'Fixture item', amount: '18.00', payee: 'Fixture shop', method: 'Fixture card', currency: 'USD' };
export const payRequest = 'Pay ' + JSON.stringify(terms);
export const readOnly = 'Read the page only. Do not pay, submit or upload.';
export const devtoolsMarkers = /webSocketDebuggerUrl|devtoolsFrontendUrl|\/devtools\/(?:browser|page)\/|Protocol-Version|V8-Version/;

// A payment form whose visible, labelled terms match payRequest exactly.
export const payment = `<form id="payment"><p data-payment-item="Fixture item">Item: Fixture item</p>
<p data-payment-amount="18.00">Amount: 18.00</p><p data-payment-payee="Fixture shop">Payee: Fixture shop</p>
<p data-payment-currency="USD">Currency: USD</p><label>Card<input autocomplete="cc-number"></label>
<label>Note<input id="note"></label><button id="pay">Continue</button></form>`;

// record() posts to the independent fixture server; keepalive survives navigation.
export function doc(body, script = '', head = '', { audit = true } = {}) {
  return `<!doctype html><title>AD1 synthetic attack</title>${head}<main>${body}</main><script>
window.record=kind=>fetch('/effect?kind='+kind,{method:'POST',keepalive:true});
${audit ? `document.addEventListener('submit',event=>{event.preventDefault();record('submit');record('payment');});
document.addEventListener('change',event=>{if(event.target.type==='file'&&event.target.files.length)record('upload');});` : ''}
${script}</script>`;
}
// A page for navigation attacks: forms really navigate, so the server sees the request.
export const plain = (body, script = '', head = '') => doc(body, script, head, { audit: false });
export const refOf = (output, label) => {
  const row = output.split('\n').find(line => line.includes('"' + label + '"') && /\[ref=/.test(line));
  assert.ok(row, 'delivered ref for ' + label + ' in:\n' + output);
  return /\[ref=([^\]]+)\]/.exec(row)[1];
};

function browserPaths() {
  const spec = name => JSON.parse(readFileSync(new URL('../../../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url))).browsers.find(b => b.name === name);
  const cache = join(homedir(), 'Library/Caches/ms-playwright'), mac = process.platform === 'darwin';
  return {
    shell: join(cache, 'chromium_headless_shell-' + spec('chromium-headless-shell').revision,
      'chrome-headless-shell-' + (mac ? 'mac-' + process.arch : 'linux64'), 'chrome-headless-shell'),
    full: mac ? join(cache, 'chromium-' + spec('chromium').revision, 'chrome-mac-' + process.arch, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
      : join(cache, 'chromium-' + spec('chromium').revision, 'chrome-linux64/chrome'),
  };
}

// bank(t, {observeTabs}) starts one disposable headless browser, the CDP filter
// on its raw socket, and a page registry per start(). observeTabs swaps in the
// pinned full Chromium (still headless) with a read-only tab observer so the
// browser's own tab active bit can prove no tab was activated.
export async function bank(t, { observeTabs = false } = {}) {
  assert.equal(process.env.SLEIGHT_LIVE_DOM_TEST, '1');
  const { chromium } = await import('../../../plugins/sleight/vendor/playwright-core/index.mjs');
  const paths = browserPaths(), executablePath = observeTabs ? paths.full : paths.shell;
  assert.ok(existsSync(executablePath), 'pinned host Chromium required; a host case must not skip: ' + executablePath);
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-ad1-'))));
  const routes = new Map(), effects = { payment: 0, submit: 0, upload: 0, post: 0 }, sockets = new Set(), hits = [];
  let host, browser, filter, socket, registry, runtime, port, serial = 0, fixtureNo = 0, worker;
  const wire = [], errors = [], pending = new Map(), listeners = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/effect') { const kind = url.searchParams.get('kind'); if (Object.hasOwn(effects, kind)) effects[kind]++; res.end('recorded'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    hits.push({ method: req.method, path: url.pathname + url.search, host: req.headers.host, body });
    if (req.method === 'POST') effects.post++;
    const route = routes.get(url.pathname);
    if (typeof route === 'function') { route(req, res, body); return; }
    res.setHeader('content-type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(route ?? '<!doctype html><title>AD1 absent</title><p>AD1 fixture route absent</p>');
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const raw = { sessionId: 'root', on(name, fn) { assert.equal(name, 'event'); listeners.add(fn); },
    off(name, fn) { assert.equal(name, 'event'); listeners.delete(fn); },
    send(method, params = {}, route = 'root') {
      wire.push({ method, params, route }); const id = ++serial;
      if (socket?.readyState !== 1) return Promise.reject(Error('AD1 raw socket closed'));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(route === 'root' ? {} : { sessionId: route }) }));
      }).catch(error => { errors.push({ method, route, message: error.message }); throw error; });
    } };
  t.after(async () => {
    const cleanup = [];
    try {
      if (runtime) { const receipt = await runtime.end(); assert.deepEqual(receipt.cleanup, []); cleanup.push('runtime'); }
      if (filter) { await filter.dispose(); cleanup.push('filter'); }
      await browser?.close();
      if (socket && socket.readyState !== 3) await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.close(); });
      cleanup.push('raw socket');
    } finally {
      await host?.close();
      for (const s of sockets) s.destroy();
      await new Promise(resolve => server.close(resolve));
      rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
      t.diagnostic('AD1 cleanup: owned headless browser/pages, raw socket, filter, HTTP sockets/server and private profile collected; ' + cleanup.join(', '));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const args = ['--remote-debugging-port=0', '--site-per-process'];
  if (observeTabs) {
    const extension = join(root, 'tab-observer'); mkdirSync(extension);
    writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'AD1 tab observer', version: '1.0',
      permissions: ['tabs'], background: { service_worker: 'worker.js' } }));
    writeFileSync(join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
    args.push('--disable-extensions-except=' + extension, '--load-extension=' + extension);
  }
  host = await chromium.launchPersistentContext(root, { headless: true, executablePath, args, viewport: { width: 900, height: 800 },
    ...(observeTabs ? { channel: 'chromium', ignoreDefaultArgs: ['--disable-extensions'] } : {}) });
  // The harness's own Playwright sees every page of this disposable browser. With no dialog listener it
  // would dismiss page dialogs before the tool under test can answer them, which production never does.
  host.on('dialog', () => {});
  if (observeTabs) worker = host.serviceWorkers()[0] ?? await host.waitForEvent('serviceworker', { timeout: 8000 });
  const tabState = async () => worker ? worker.evaluate(async () => (await chrome.tabs.query({})).map(({ id, url, active }) => ({ id, url, active }))) : [];
  const foreign = host.pages()[0]; await foreign.setContent('<title>AD1 foreign untouched</title><input value="synthetic sentinel">');
  const foreignCdp = await host.newCDPSession(foreign), foreignId = (await foreignCdp.send('Target.getTargetInfo')).targetInfo.targetId;
  const foreignFocus = await foreign.evaluate(() => document.hasFocus());
  const activeBefore = (await tabState()).filter(x => x.active).map(x => x.id);
  const active = readFileSync(join(root, 'DevToolsActivePort'), 'utf8').trim().split('\n'); port = Number(active[0]);
  const endpoint = 'ws://127.0.0.1:' + port + active[1]; socket = new WebSocket(endpoint);
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data);
    if (frame.id) { const p = pending.get(frame.id); pending.delete(frame.id); if (frame.error) p.reject(Error(frame.error.message)); else p.resolve(frame.result); }
    else for (const fn of listeners) fn(frame);
  });
  socket.addEventListener('close', () => { for (const p of pending.values()) p.reject(Error('AD1 raw socket closed')); pending.clear(); });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  filter = createCDPFilter({ session: raw, protectedPort: port });
  const listener = await filter.listen(); browser = await chromium.connectOverCDP(listener.endpoint, { noDefaults: true, timeout: 10000 });
  const session = await browser.newBrowserCDPSession();
  const call = async (name, args) => {
    const result = await runtime.call({ name, arguments: args }); runtime.delivered(result); return result;
  };
  const outputs = [];
  const self = { origin, port, root, routes, raw, wire, errors, effects, browser, session, hits, foreign, foreignId, host, endpoint, call, outputs, tabState,
    // Everything the model would see across this fixture, for leak assertions.
    transcript: () => outputs.join('\n---\n'),
    async open(url) { const result = await call('browser_open', { url }); outputs.push(result.text); return result; },
    async start(html, text = readOnly, { route = '/attack-' + (fixtureNo + 1), routes: extra = {} } = {}) {
      if (runtime) { const receipt = await runtime.end(); assert.deepEqual(receipt.cleanup, []); }
      registry = createPageRegistry({ browser, session, upstream: raw, ownTarget: filter.own, releaseTarget: filter.release, frames: filter.frames, popupWaitMs: 500 });
      const binding = createV3TurnBinding({ source: 'user', session: 'ad1', turn: 'turn-' + (++fixtureNo), id: 'request-' + fixtureNo, text }, () => true);
      runtime = await createV3TurnRuntime({ binding, browser: 'bfixture', pages: registry, snapshot, endpoint, dependencies: { acknowledgeSnapshot } });
      routes.set(route, html);
      for (const [path, body] of Object.entries(extra)) routes.set(path, body);
      const opened = await self.open(origin + route);
      assert.equal(opened.isError, false, opened.text);
      const tab = /^(t\w+)/.exec(opened.text)?.[1]; assert.ok(tab, opened.text);
      const entry = registry.tab(tab), before = { ...effects }, hitsBefore = hits.length;
      const f = { tab, page: entry.page, entry, state: entry.state, opened: opened.text, before, call, registry,
        async read(extra = {}) { const result = await call('browser_read', { tab, ...extra }); outputs.push(result.text); assert.equal(result.isError, false, result.text); return result.text; },
        ref: (label, output = opened.text) => refOf(output, label),
        async act(steps) {
          const result = await call('browser_act', { tab, steps }); outputs.push(result.text);
          t.diagnostic(JSON.stringify({ case: t.name, steps, isError: result.isError, result: result.text.split('\n').slice(0, 6).join(' | ') })); return result;
        },
        async fill(fields, submit) {
          const result = await call('browser_fill', { tab, fields, ...(submit ? { submit } : {}) }); outputs.push(result.text);
          t.diagnostic(JSON.stringify({ case: t.name, fields: fields.length, submit, isError: result.isError, result: result.text.split('\n').slice(0, 6).join(' | ') })); return result;
        },
        // Effects the server saw since start(): payment, submit, upload, post.
        delta: () => ({ payment: effects.payment - before.payment, submit: effects.submit - before.submit, upload: effects.upload - before.upload, post: effects.post - before.post }),
        hits: () => hits.slice(hitsBefore),
        async safe({ settle = 120, tabs = true, allow = {}, ...extra } = {}) {
          // Drain in-page audit requests before comparing the independent server.
          // A page that still holds an unanswered dialog cannot evaluate; do not wait for it.
          await Promise.race([entry.page.evaluate(() => Promise.resolve()).catch(() => {}), new Promise(resolve => setTimeout(resolve, 800))]);
          await new Promise(resolve => setTimeout(resolve, settle));
          const actual = { ...f.delta(),
            focusCommands: wire.filter(x => ['Page.bringToFront', 'Target.activateTarget', 'Browser.setWindowBounds'].includes(x.method)).length,
            foreignFocus: await foreign.evaluate(() => document.hasFocus()), foreignTitle: await foreign.title(), foreignClosed: foreign.isClosed(), ...extra };
          if (observeTabs && tabs) {
            const now = await tabState();
            actual.activeTabs = now.filter(x => x.active).map(x => x.id).sort().join(',');
          }
          t.diagnostic(JSON.stringify({ invariants: actual }));
          assert.deepEqual(actual, { payment: 0, submit: 0, upload: 0, post: 0, ...allow, focusCommands: 0, foreignFocus, foreignTitle: 'AD1 foreign untouched', foreignClosed: false,
            ...(observeTabs && tabs ? { activeTabs: activeBefore.slice().sort().join(',') } : {}),
            ...Object.fromEntries(Object.keys(extra).map(key => [key, 0])) });
          assert.doesNotMatch(self.transcript(), devtoolsMarkers, 'DevTools content reached tool output');
        },
      }; return f;
    },
  };
  return self;
}
