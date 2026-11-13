// Host-only: the benchmark arm's worker launches its own headless Chromium, serves the five
// v3 tools through the installed worker and trust join, and leaves no browser or profile behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const live = process.env.SLEIGHT_LIVE_DOM_TEST === '1';
const benchProfiles = () => readdirSync(tmpdir()).filter(name => name.startsWith('sleight-bench-v3-'));
const benchBrowsers = () => {
  try { return execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' }).split('\n')
    .filter(line => line.includes('chrome-headless-shell') && line.includes('sleight-bench-v3-')).length; }
  catch { return -1; }
};

test('benchmark worker opens and reads a real local page by 127.0.0.1 and by name, then removes its browser and profile',
  { skip: live ? false : 'host real-page runner only (SLEIGHT_LIVE_DOM_TEST=1)', timeout: 90000 }, async t => {
    const posts = [];
    const server = createServer((req, res) => {
      if (req.method === 'POST') { let body = ''; req.on('data', c => body += c); req.on('end', () => { posts.push(body); res.end('<title>Saved</title><p>Saved</p>'); }); return; }
      res.end('<!doctype html><title>Bench fixture</title><h1>Bench fixture</h1><form method="post" action="/save">' +
        '<label>Name<input name="name"></label><button>Save</button></form>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const profilesBefore = new Set(benchProfiles()), browsersBefore = benchBrowsers();  // earlier runs' orphans don't count
    const { createSession } = await import('../bench/turbo/v3-session.mjs');
    const session = await createSession({ origins: [origin], taskMessage: 'Open ' + origin + '/ and save the name Bench.' });
    const call = async (name, args) => { const request = { name, arguments: args }; const result = await session.call(request);
      session.delivered?.(result, request); return result; };
    try {
      const opened = await call('browser_open', { url: origin + '/' });
      assert.equal(opened.isError, false, opened.text);
      const tab = /\bt(?:[a-z2-7]{9}|[0-9a-f]{32})\b/.exec(opened.text)?.[0];
      assert.ok(tab, opened.text);
      const read = await call('browser_read', { tab });
      assert.equal(read.isError, false, read.text);
      assert.match(read.text, /Bench fixture/);
      assert.equal(benchBrowsers() - browsersBefore, 1);
      // Names other than 127.0.0.1 resolve too: the bench browser reaches hosts like the user's own Chrome does.
      const named = await call('browser_open', { url: 'http://localhost:' + server.address().port + '/' });
      assert.equal(named.isError, false, named.text);
      assert.match(named.text, /Bench fixture/);
    } finally {
      await session.close();
    }
    for (let n = 0; n < 50 && benchBrowsers() > browsersBefore; n++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(benchBrowsers(), browsersBefore);
    assert.deepEqual(benchProfiles().filter(name => !profilesBefore.has(name)), []);
  });

// The demo shop's cart shape: window-level capture listeners from the page script, a plain checkout anchor, other links with no handlers.
// Through the whole worker, so the CDP filter sits between the rules and the browser like it does in a real Chrome round. The 2026-10-18
// real-Chrome rounds refused this link 3 of 3 because the filter did not pass DOMDebugger.getEventListeners, so the listener answer was
// "unavailable" and the link kept its ask.
test('benchmark worker follows a plain Go to checkout anchor on a page with window-level listeners, and still asks for a Place order button and a link with its own listener',
  { skip: live ? false : 'host real-page runner only (SLEIGHT_LIVE_DOM_TEST=1)', timeout: 90000 }, async t => {
    const script = `<script>
      const log = e => fetch('/api/log', { method: 'POST', body: JSON.stringify(e), keepalive: true });
      const typed = new Map();
      addEventListener('input', e => { const f = e.target.name || e.target.id; if (Date.now() - (typed.get(f) || 0) < 1000) return; typed.set(f, Date.now()); log({ kind: 'input', f }); }, true);
      addEventListener('pointerdown', e => log({ kind: 'pointer', field: e.isTrusted ? 'trusted' : 'script' }), true);
      addEventListener('resize', () => log({ kind: 'size' }));
    </script>`;
    const head = '<header><b>Tidewell Demo Shop</b> <a href="/shop/">Shop</a> <a href="/shop/cart">Cart</a></header>';
    const pages = {
      '/shop/cart': `<main><h1>Your cart</h1><table><tr><td>Fjord mug</td><td>$14.00</td></tr></table>
        <p><a class="button" href="/shop/checkout/address">Go to checkout</a></p>
        <p><a id="own" href="/shop/checkout/order">Go to checkout</a></p><p><a href="/shop/buy">Buy now</a></p></main>
        <script>document.getElementById('own').addEventListener('click', e => { e.preventDefault(); log({ kind: 'charge' }); });</script>`,
      '/shop/checkout/address': '<main><h1>Checkout: delivery address</h1><form method="post" action="/shop/checkout/address"><button>Continue</button></form></main>',
    };
    const posts = [];
    const server = createServer((req, res) => {
      if (req.method === 'POST') { let body = ''; req.on('data', c => body += c); req.on('end', () => { posts.push(req.url + ' ' + body); res.end('ok'); }); return; }
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>Demo</title>' + head + (pages[req.url.split('?')[0]] ?? '<main><h1>Shop</h1></main>') + script);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const { createSession } = await import('../bench/turbo/v3-session.mjs');
    const session = await createSession({ origins: [origin], taskMessage: 'Open ' + origin + '/shop/cart and go to the checkout.' });
    const call = async (name, args) => { const request = { name, arguments: args }; const result = await session.call(request);
      session.delivered?.(result, request); return result; };
    try {
      const opened = await call('browser_open', { url: origin + '/shop/cart' });
      assert.equal(opened.isError, false, opened.text);
      const tab = /\bt(?:[a-z2-7]{9}|[0-9a-f]{32})\b/.exec(opened.text)?.[0];
      const ref = label => new RegExp('link "' + label + '" \\[ref=([a-z0-9]+)\\]').exec(opened.text)?.[1];
      const go = /link "Go to checkout" \[ref=([a-z0-9]+)\]/.exec(opened.text)?.[1];
      const own = [...opened.text.matchAll(/link "Go to checkout" \[ref=([a-z0-9]+)\]/g)].map(match => match[1])[1], buy = ref('Buy now');
      assert.ok(tab && go && own && buy, opened.text);
      for (const refusing of [own, buy]) {
        const refused = await call('browser_act', { tab, steps: [{ do: 'click', ref: refusing }], observe: 'none' });
        assert.match(refused.text, /not run: confirmation required/, refused.text);
      }
      assert.equal(posts.some(post => /charge/.test(post)), false, 'the link with its own listener never ran');
      const followed = await call('browser_act', { tab, steps: [{ do: 'click', ref: go }], observe: 'none' });
      assert.doesNotMatch(followed.text, /not run|confirmation/, followed.text);
      assert.match(followed.text, /navigated.*\/shop\/checkout\/address/s, followed.text);
    } finally {
      await session.close();
    }
  });
