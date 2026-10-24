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
import { handoffReadReady } from '../plugins/sleight/lib/direct-browser/handoff.mjs';

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-signin-resume-'))), cards = [], authenticated = new WeakSet(), captures = [], drainCounts = [];
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
  const call = async (name, args) => { const result = await runtime.call({ name, arguments: args }, { handoffDrain: detail => drainCounts.push(detail.ownedTabs) }); runtime.delivered(result); return result; };
  const opened = await call('browser_open', { url: origin + '/login' });
  assert.equal(opened.isError, false, opened.text);
  const tab = /^t\w+/.exec(opened.text)[0], entry = registry.tab(tab);
  const ownerPage = context.pages().find(page => page.url() === origin + '/login');
  ownerPage.on('request', request => { if (request.method() === 'POST') submissions++; });
  return { call, tab, entry, ownerPage, context, runtime, registry, opened, cards, captures, drainCounts,
    answer(choice, trusted = true) {
      const card = cards.at(-1), event = { id: card.id, choice }; if (trusted) authenticated.add(event); card.deliver(event);
    }, submissions: () => submissions };
}

async function waitForCard(f, count = 1) {
  for (let n = 0; n < 200 && f.cards.length < count; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.cards.length, count, 'the expected consent card must be presented');
}

test('signin-resume: person enters password and 2FA; only Continue returns a fresh receipt read', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t), before = f.captures.length;
  const stale = /\[ref=(e\d+)\]/.exec(f.opened.text)[1];
  const pending = f.call('browser_tabs', { do: 'handoff', tab: f.tab, wait: true });
  await waitForCard(f);
  assert.deepEqual(f.drainCounts, [1], 'the real registry reports its tab count before presenting a card');
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
  await waitForCard(f, 2);
  assert.equal(f.captures.length, before);
  assert.throws(() => f.registry.tab(f.tab), /handoff.*pending/i);
  await f.ownerPage.evaluate(() => { document.querySelector('main').innerHTML = '<h1>Receipt INV-42</h1>'; });
  f.answer('continue');
  const result = await pending;
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /Receipt INV-42/);
});

test('input hints reject auth secrets and populated unnamed fields without matching postal or promo codes', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (const [html, ready] of [
    ['<p>Enter your authentication code or PIN</p><input placeholder="Promo code" value="SAVE10"><input name="postal-code" value="90210">', true],
    ['<input name="verification-code">', false],
    ['<input name="code">', false],
    ...['otp_code', 'sms_code', 'user_pin', 'otp-code', 'sms-code', 'user-pin', 'otpCode', 'smsCode', 'userPin', 'OTPCode', 'SMSCode', 'OTPcode'].map(name => [`<input name="${name}">`, false]),
    ['<input aria-label="PIN">', false],
    ['<input placeholder="Postal PIN code" value="90210">', true],
    ['<input autocomplete="one-time-code" hidden>', false],
    ['<form aria-label="Sign in"><input value="opaque-secret"></form>', false],
    ['<form><button>Sign in</button><textarea>opaque-secret</textarea></form>', false],
    ['<form aria-label="Login"><div role="textbox" contenteditable>opaque-secret</div></form>', false],
    ['<form aria-label="Login"><input></form>', true],
    ['<form aria-label="Login" hidden><input></form><input placeholder="Promo code" value="SAVE10">', true],
    ['<form aria-label="Sign in"></form><iframe srcdoc="&lt;input value=&quot;opaque-secret&quot;&gt;"></iframe>', false],
    ['<div id="shadow"></div><script>document.getElementById("shadow").attachShadow({mode:"open"}).innerHTML = \'<input type="password">\'</script>', false],
  ]) {
    await f.ownerPage.setContent(html);
    assert.equal(await handoffReadReady(f.entry.page), ready, html);
  }
});

test('code and pin hints protect pending handoff without hiding ordinary editors or map pins', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t);
  await f.ownerPage.setContent('<label>Code editor<textarea>const answer = 42;</textarea></label><label>Map pin<input value="North pier"></label>');
  const ordinary = await f.call('browser_read', { tab: f.tab });
  assert.equal(ordinary.isError, false, ordinary.text);
  assert.match(ordinary.text, /const answer = 42/); assert.match(ordinary.text, /North pier/);
  const before = f.captures.length;
  const pending = f.call('browser_tabs', { do: 'handoff', tab: f.tab, wait: true });
  await waitForCard(f);
  let cards = 1;
  for (const name of ['code', 'pin', 'otp_code', 'sms_code', 'user_pin', 'otp-code', 'sms-code', 'user-pin', 'otpCode', 'smsCode', 'userPin', 'OTPCode', 'SMSCode', 'OTPcode']) {
    await f.ownerPage.setContent(`<label>Account<input name="${name}" value="482913"></label><p>Echo 482913</p>`);
    const refused = await f.call('browser_read', { tab: f.tab });
    assert.equal(refused.isError, true, name);
    assert.doesNotMatch(refused.text, /482913/, name);
    f.answer('continue');
    await waitForCard(f, ++cards);
    assert.equal(f.captures.length, before, name + ' must block the fresh snapshot');
  }
  await f.ownerPage.setContent('<label>Promo code<input value="SAVE10"></label><label>Postal code<input value="90210"></label>');
  f.answer('continue');
  const benign = await pending;
  assert.equal(benign.isError, false, benign.text);
  assert.match(benign.text, /SAVE10/); assert.match(benign.text, /90210/);
});

test('Continue after every owned tab closes ends the handoff without another card or read', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t), before = f.captures.length;
  const pending = f.call('browser_tabs', { do: 'handoff', tab: f.tab, wait: true });
  await waitForCard(f);
  await f.ownerPage.close();
  f.answer('continue');
  const result = await Promise.race([pending, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error('handoff did not finish after the last tab closed')), 2000);
    timer.unref(); pending.finally(() => clearTimeout(timer));
  })]);
  assert.match(result.text, /not resumed/);
  assert.equal(f.cards.length, 1);
  assert.equal(f.captures.length, before);
});

test('premature Continue keeps every owned tab paused until the person cancels', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t);
  const second = await f.call('browser_open', { url: f.ownerPage.url() });
  const tab = /^t\w+/.exec(second.text)[0], before = f.captures.length;
  const pending = f.call('browser_tabs', { do: 'handoff', tab: f.tab, wait: true });
  await waitForCard(f); f.answer('continue'); await waitForCard(f, 2);
  assert.throws(() => f.registry.tab(f.tab), /handoff.*pending/i);
  assert.throws(() => f.registry.tab(tab), /handoff.*pending/i);
  assert.equal(f.captures.length, before);
  f.answer('cancel'); await pending; await f.runtime.end();
  assert.equal(f.context.pages().filter(page => page.url().endsWith('/login')).length, 2);
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

test('whole expansion guards work through the production filtered owned-tab runtime', { skip, timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.ownerPage.evaluate(() => {
    document.body.innerHTML = '<div role="log" style="width:850px;height:560px;overflow:auto"><p>Beginning of chat</p><div role="list"><article data-key="one">first message</article><article data-key="two">last message</article></div><button type="button">Load more</button><p>You\'re all caught up</p></div>';
    window.wholeEffect = 'waiting';
    document.querySelector('button').onclick = () => fetch('/whole-expander-post', { method: 'POST' })
      .then(() => { window.wholeEffect = 'sent'; }, () => { window.wholeEffect = 'held'; });
  });
  const result = await f.call('browser_read', { tab: f.tab, whole: { max_seconds: 4 } });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /Items read: 2 .*Clicks: 1\./);
  assert.match(result.text, /blocked: "POST http:\/\/127\.0\.0\.1:/);
  assert.equal(await f.ownerPage.evaluate(() => window.wholeEffect), 'held');
});
