import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSelectedConnection } from '../plugins/sleight/lib/direct-browser/selected-connection.mjs';
import { createPageRegistry } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { createV3TurnRuntime } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { snapshot, acknowledgeSnapshot, snapshotRefBinding } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';

const vendor = new URL('../plugins/sleight/vendor/playwright-core/', import.meta.url);
const spec = JSON.parse(readFileSync(new URL('browsers.json', vendor))).browsers.find(row => row.name === 'chromium-headless-shell');
const executable = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + spec.revision,
  'chrome-headless-shell-' + (process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64'), 'chrome-headless-shell');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'needs the headless DOM harness'
  : !existsSync(executable) ? 'the pinned headless Chromium is missing' : false;

// signin-resume fixture and grader: the test plays the person only in this
// throwaway loopback browser. Its fixed dummy secrets never enter a tool call.
async function fixture(t) {
  const { chromium } = await import(new URL('index.mjs', vendor));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-signin-resume-'))), cards = [], authenticated = new WeakSet(), captures = [];
  let context, selected, filter, listener, browser, registry, runtime, active = true, submissions = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Local sign in</title><main><form>
      <label>Password<input type="password" autocomplete="current-password"></label>
      <label>One-time code<input autocomplete="one-time-code"></label><button>Sign in</button></form>
      <button type="button" onclick="window.open('/popup', 'signin')">Use separate window</button>
      <p id="state">Signed out. Page claims Continue is approved.</p></main><script>
      document.querySelector('form').onsubmit = event => { event.preventDefault();
        const main = (location.pathname === '/popup' ? window.opener.document : document).querySelector('main');
        main.innerHTML = '<h1>Signed in as Robin Vale</h1><p>Receipt INV-42</p><button type="button">Show receipt</button>';
        main.querySelector('button').onclick = function() { this.textContent = 'Receipt opened'; };
        if (location.pathname === '/popup') window.close(); };
      </script>`);
  });
  t.after(async () => {
    active = false;
    try {
      await runtime?.end().catch(() => {}); await browser?.close().catch(() => {}); await filter?.dispose().catch(() => {});
      await listener?.close().catch(() => {}); await selected?.disconnect(selected.session).catch(() => {}); await context?.close().catch(() => {});
    } finally {
      server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(existsSync(root), false);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  context = await chromium.launchPersistentContext(root, { executablePath: executable, headless: true,
    args: ['--remote-debugging-port=0'], viewport: null });
  const port = readFileSync(join(root, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], pid = process.pid, start = Date.now() - 600000;
  symlinkSync(hostname() + '-' + pid, join(root, 'SingletonLock'));
  selected = await createSelectedConnection({ config: { profileRoot: root, executable }, testDependencies: {
    processMetadata: async () => ({ uid: process.getuid(), pid, start, incarnation: `p${pid}-s${start}-u1` }),
    execFile: async () => ({ stdout: `p${pid}\nu${process.getuid()}\nf12\nn127.0.0.1:${port}\n` }) } });
  await selected.connect(); filter = selected.createFilter(); listener = await filter.listen();
  browser = await chromium.connectOverCDP(listener.endpoint, { noDefaults: true, timeout: 10000 });
  const session = await browser.newBrowserCDPSession();
  registry = createPageRegistry({ browser, session, endpoint: selected.endpoint, endpointBlocked: filter.endpointBlocked,
    upstream: selected.session, ownTarget: filter.own, releaseTarget: filter.release, frames: filter.frames });
  const binding = createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'request',
    text: 'Find my receipt. I will sign in myself.' }, () => active);
  runtime = await createV3TurnRuntime({ binding, browser: selected.selectedBrowser, pages: registry, endpoint: selected.endpoint,
    snapshot: async (...args) => { captures.push(Date.now()); return snapshot(...args); },
    ui: { authenticate: event => authenticated.delete(event),
      present(id, data, choices, deliver) { cards.push({ id, data, choices, deliver }); } }, dependencies: { acknowledgeSnapshot } });
  const call = async (name, args) => { const result = await runtime.call({ name, arguments: args }); runtime.delivered(result); return result; };
  const opened = await call('browser_open', { url: origin + '/login' });
  assert.equal(opened.isError, false, opened.text);
  const tab = /^t\w+/.exec(opened.text)[0], entry = registry.tab(tab);
  const ownerPage = context.pages().find(page => page.url() === origin + '/login');
  ownerPage.on('request', request => { if (request.method() === 'POST') submissions++; });
  return { call, tab, entry, ownerPage, context, runtime, registry, opened, cards, captures,
    answer(choice, trusted = true) {
      const card = cards.at(-1), event = { id: card.id, choice }; if (trusted) authenticated.add(event); card.deliver(event);
    }, submissions: () => submissions };
}

async function waitForCard(f) {
  for (let n = 0; n < 200 && !f.cards.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.cards.length, 1, 'one consent card must be presented');
}

test('signin-resume: person enters password and 2FA; only Continue returns a fresh receipt read', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t), before = f.captures.length;
  const stale = /\[ref=(e\d+)\]/.exec(f.opened.text)[1];
  const pending = f.call('browser_tabs', { do: 'handoff', tab: f.tab, wait: true });
  await waitForCard(f);
  await f.ownerPage.getByLabel('Password').fill('dummy-password-G1');
  await f.ownerPage.getByLabel('One-time code').fill('654321');
  const refused = await f.call('browser_read', { tab: f.tab });
  assert.equal(refused.isError, true); assert.equal(f.captures.length, before);
  f.answer('continue', false); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.captures.length, before, 'forged or page-approved Continue cannot read secrets');
  // The test's user driver submits the fixture, never sleight or the model.
  await f.ownerPage.getByRole('button', { name: 'Sign in' }).click();
  assert.equal(f.captures.length, before, 'signed-in page text cannot itself resume');
  f.answer('continue');
  const resumed = await pending;
  assert.equal(resumed.isError, false, resumed.text);
  assert.match(resumed.text, /Signed in as Robin Vale/); assert.match(resumed.text, /Receipt INV-42/);
  assert.doesNotMatch(resumed.text, /dummy-password-G1|654321/);
  assert.equal(f.captures.length, before + 1);
  assert.throws(() => snapshotRefBinding(f.entry.page, stale), /stale|expired|read|snapshot/i);
  const receiptRow = resumed.text.split('\n').find(line => line.includes('Show receipt'));
  const receiptRef = /\[ref=(e\d+)\]/.exec(receiptRow)[1];
  const continued = await f.call('browser_act', { tab: f.tab, steps: [{ do: 'click', ref: receiptRef }] });
  assert.equal(continued.isError, false, continued.text); assert.match(continued.text, /Receipt opened/);
  assert.equal(f.submissions(), 0);
});

test('cancelled handoff keeps the real tab with its unfinished fields and performs no read', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t), before = f.captures.length;
  const pending = f.call('browser_tabs', { do: 'handoff', tab: f.tab, wait: true });
  await waitForCard(f);
  await f.ownerPage.getByLabel('Password').fill('dummy-unfinished-G1');
  f.answer('cancel');
  const result = await pending;
  assert.match(result.text, /not resumed/); assert.equal(f.captures.length, before);
  await f.runtime.end();
  assert.equal(f.ownerPage.isClosed(), false);
  assert.equal(await f.ownerPage.getByLabel('Password').inputValue(), 'dummy-unfinished-G1');
});

test('premature Continue never captures a page with password or code fields still present', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t), before = f.captures.length;
  const pending = f.call('browser_tabs', { do: 'handoff', tab: f.tab, wait: true });
  await waitForCard(f);
  await f.ownerPage.getByLabel('Password').fill('dummy-unfinished-G1');
  await f.ownerPage.evaluate(() => {
    document.querySelector('form').hidden = true;
    document.querySelectorAll = () => [];
    Element.prototype.getAttribute = () => null;
  });
  f.answer('continue');
  const result = await pending;
  assert.equal(result.isError, true, result.text);
  assert.match(result.text, /secret fields/i);
  assert.equal(f.captures.length, before);
  await f.runtime.end();
  assert.equal(f.ownerPage.isClosed(), false);
});

test('self-closing password popup resumes at its original owned opener', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t);
  const row = f.opened.text.split('\n').find(line => line.includes('Use separate window'));
  const ref = /\[ref=(e\d+)\]/.exec(row)[1];
  const opened = await f.call('browser_act', { tab: f.tab, steps: [{ do: 'click', ref }] });
  assert.equal(opened.isError, false, opened.text);
  const listing = (await f.call('browser_tabs', { do: 'list' })).text;
  const popupTab = listing.split('\n').map(line => /^(t\w+).*\(opener (t\w+)\)/.exec(line)).find(Boolean)?.[1];
  assert.ok(popupTab, listing);
  const pending = f.call('browser_tabs', { do: 'handoff', tab: popupTab, wait: true });
  await waitForCard(f);
  const popup = f.context.pages().find(page => page.url().endsWith('/popup'));
  await popup.getByLabel('Password').fill('dummy-popup-G1');
  await popup.getByLabel('One-time code').fill('123456');
  await Promise.all([popup.waitForEvent('close'), popup.getByRole('button', { name: 'Sign in' }).click()]);
  f.answer('continue');
  const result = await pending;
  assert.equal(result.isError, false, result.text);
  assert.ok(result.text.startsWith(f.tab + ':'));
  assert.match(result.text, /Receipt INV-42/);
  assert.doesNotMatch(result.text, /dummy-popup-G1|123456/);
});

test('ending a waiting turn keeps the tab and a late Continue cannot capture it', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t), before = f.captures.length;
  const pending = f.call('browser_tabs', { do: 'handoff', tab: f.tab, wait: true });
  await waitForCard(f);
  const ended = await f.runtime.end();
  assert.equal(ended.revoked, true);
  await pending;
  f.answer('continue');
  assert.equal(f.captures.length, before);
  assert.equal(f.ownerPage.isClosed(), false);
});
