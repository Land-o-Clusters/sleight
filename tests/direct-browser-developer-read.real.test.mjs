import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { createPageRegistry } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';

const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'needs SLEIGHT_LIVE_DOM_TEST=1, pinned headless Chromium only';
const HTML = `<!doctype html><title>Developer fixture</title><main>Fixture only</main><script>
window.getterReads = 0;
console.log('fixture started');
console.warn('Authorization:', 'private-split-credential');
console.log({ get dangerous() { window.getterReads++; return 'private-object-value'; } });
console.error('Failed to load inventory');
const labels = ['credential', 'credentials', 'token', 'tokens', 'password', 'passwords', 'passwd', 'pwd',
  'secret', 'secrets', 'cookie', 'cookies', 'csrf', 'xsrf', 'sid', 'session', 'sessions',
  'apikey', 'api key', 'api-key', 'api_key', 'apikeys', 'api keys', 'api-keys', 'api_keys',
  'privatekey', 'private key', 'private-key', 'private_key', 'jwt', 'bearer', 'auth', 'authorization', 'otp', 'code',
  'pass', 'passphrase', 'pw', 'key', 'access_key', 'signature', 'api.key', 'sess', 'pin', 'cvv', 'ssn'];
for (const label of labels) {
  console.log('User ' + label + ':', 'briefvalue');
}
for (const key of ['sk-shortkey', 'AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE', 'ghp_shortkey', 'gho_shortkey',
  'github_pat_shortkey', 'xoxa-shortkey', 'xoxb-shortkey', 'xoxp-shortkey',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature', 'eyJhbGciOiJIUzI1NiJ9', 'a123456789bcdefgh']) console.log('keycanary', key);
console.log('code', 'briefvalue');
console.log('api', 'key', 'briefvalue');
console.log('to\u200bken=briefvalue');
console.log('tоken=briefvalue');
console.log('tοken=briefvalue');
console.log('Compiled with exit code 1');
console.log('code splitting enabled');
console.log('Are you sure?');
console.log('metadata: useful');
console.log('Next.js docs');
console.log('reviewcanary Ab3dE7gH9k ABCD-1234-EFGH-5678 482913 Zm9vYmFy deadbeef');
console.log('reviewcanary abcdefghijklmnop aaaaaaaaaaaaaaaa');
console.log('load localhost:3000/api/reset?key=briefvalue');
console.log('load api.example.com?k=briefvalue');
console.log('failed:/api/reset?key=briefvalue');
console.log('at Object.render (../src/app.js:1:2)');
console.log('at sk_live_Ab3dE7gH9k:1:1 ghp_shortkey:1:2 AKIAIOSFODNN7EXAMPLE:1:1');
console.log('4111 1111 1111 1111', '123 45 6789', '212\u00a0555\u00a00123');
console.log('４１１１\u202f１１１１\u202f１１１１\u202f１１１１');
console.log('token 4111 1111 1111 1111 render failed');
console.log('token 4111 1111 password sunshine meadow blossom render failed');
console.log('passwort sunshine meadow blossom render failed');
console.log('contraseña sunshine meadow blossom render failed');
console.log('mot de passe sunshine meadow blossom render failed');
console.log('status code 404; Unexpected token in JSON; "key" prop; session expired; test pass');
console.log("Object.render Array.map v1.2.3 45ms 15000ms net::ERR_CONNECTION_REFUSED don't retry");
console.log('load https://alice.smith.example.com/users/clover/orders');
console.log('load http://127.0.0.1:8080/profile/forest');
console.log('keycanary https://example.invalid/sk-shortkey');
console.log('sure? metadata:useful year 2026 port 8080 HTTP 404 count 1234');
console.log('load /invite/abcdef123456/app12345678901234.min.js?x=briefvalue');
console.log('Customer phone 555 123 4567. paid with 4111 1111 1111 1111. SSN on file 123 45 6789. debug 555.123.4567; debug 123.45.6789.');
console.log('phone:555', 123, '4567...; phone:555 123 4567… render failed; phone:123-45 6789; debug 4111 1111-1111 1111; debug 555 123-4567; debug 123 - 45 / 6789.');
console.log('load "alice.example.com", alice.smith.example.co.uk. React version: 18.2.0 Object.render Array.map app.min.js; Chrome 120.0.6099 v3.1.0 status:200 retry:3 line:12; at window.performance.now; at render (this.state.name); event.target.name is undefined; Array.prototype.map(); e.target.id is not a function; React.Component.name()');
setTimeout(() => { throw new Error('fixture render failed'); }, 0);
Promise.allSettled([
  fetch('/ok?token=private-query#private-fragment', {method:'POST',headers:{Authorization:'Bearer private-header'},body:'private-request-body'}),
  fetch('/broken?key=private-query'), fetch('/redirect'), fetch('http://127.0.0.1:1/unreachable'),
  fetch('/invite/abcdef123456/app12345678901234.min.js'), fetch('/users/clover/orders'), fetch('/profile/forest')
]).then(() => { window.fixtureDone = true; console.info('fixture settled'); });
</script>`;

test('owned real-page console, request failures and timings are scrubbed without replay or foreign reads', { skip, timeout: 30000 }, async t => {
  assert.ok(existsSync(executablePath), 'pinned Chromium headless shell must be installed');
  const hits = [], sockets = new Set();
  const server = createServer((request, response) => {
    hits.push([request.method, request.url]);
    request.resume(); response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/' || request.url === '/next') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(request.url === '/' ? HTML : '<title>Next document</title>'); }
    else if (request.url === '/redirect') { response.writeHead(302, { Location: '/missing?token=private-redirect-query' }); response.end(); }
    else { response.writeHead(request.url.startsWith('/ok') ? 200 : request.url.startsWith('/broken') ? 503 : 404,
      { 'Set-Cookie': 'private-cookie=private-response-cookie; Path=/', 'Content-Type': 'text/plain' }); response.end('private-response-body'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, registry, session, foreign;
  t.after(async () => {
    try {
      if (registry) { const receipt = await registry.endTurn(); assert.equal(receipt.cleanedUp, true); }
      if (foreign) assert.equal(foreign.isClosed(), false, 'cleanup keeps the foreign fixture page');
      await session?.detach();
    } finally {
      await browser?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext();
  foreign = await context.newPage();
  await foreign.setContent('<title>Foreign private fixture</title>');
  session = await browser.newBrowserCDPSession();
  const { browserContextIds } = await session.send('Target.getBrowserContexts');
  assert.equal(browserContextIds.length, 1);
  // Production attaches to the existing default context. This fixture uses one
  // isolated incognito context, so background allocations must name it.
  const registrySession = { send: (method, params) => session.send(method, method === 'Target.createTarget'
    ? { ...params, browserContextId: browserContextIds[0] } : params) };
  registry = createPageRegistry({ browser, context, session: registrySession, timeoutMs: 10000 });
  const { tab } = await registry.openTab({ url: 'http://127.0.0.1:' + server.address().port });
  const entry = registry.tab(tab);
  await entry.page.waitForFunction(() => window.fixtureDone === true);
  await foreign.evaluate(() => console.error('private-foreign-console'));
  const unexpected = () => assert.fail('developer reads never touch the DOM or send input');
  const dispatcher = createToolDispatcher({ pages: registry, snapshot: unexpected, runSteps: unexpected, fillFields: unexpected });
  const before = JSON.stringify(hits);
  const call = async flags => {
    const result = await dispatcher.call({ name: 'browser_read', arguments: { tab, ...flags } });
    assert.equal(result.isError, false, result.text); assert.equal(dispatcher.delivered(result), false);
    assert.doesNotMatch(result.text, /private-|Authorization|Set-Cookie|postData|headers|requestId/);
    return result.text;
  };
  const logs = await call({ console: true });
  assert.match(logs, /fixture started/); assert.match(logs, /Failed to load inventory/);
  assert.match(logs, /fixture render failed/); assert.match(logs, /\[omitted\]/);
  assert.doesNotMatch(logs, /briefvalue|abcdef123456|Ab3dE7gH9k|ABCD-1234|482913|Zm9vYmFy|deadbeef|abcdefghijklmnop|aaaaaaaaaaaaaaaa/);
  assert.doesNotMatch(logs, /shortkey|AKIA|ASIA|ghp_|gho_|github_pat_|xox[abp]|eyJhbGciOiJIUzI1NiJ9/);
  assert.match(logs, /sure\? \[value\] year 2026 port 8080 HTTP 404 count 1234/);
  assert.match(logs, /\/invite\/\[seg\]\/\[seg\]/);
  assert.doesNotMatch(logs, /\b(?:4111|1111|123 45|6789|212|555|0123)\b|sunshine|meadow|blossom|alice|smith|clover|forest|127\.0\.0\.1/);
  for (const text of ['Customer phone [value].', 'paid with [value].', 'phone:[value]...',
    'phone:[value]... render failed', '\\"[sub].example.com\\", [sub].[sub].example.co.uk.',
    'React version: 18.2.0 Object.render Array.map app.min.js']) assert.ok(logs.includes(text), text);
  assert.doesNotMatch(logs, /123\.45|6789|4567|123-45|1111-1111/);
  for (const text of ['Chrome 120.0.6099 v3.1.0 status:200 retry:3 line:12', 'at window.performance.now',
    'at render (this.state.name)', 'event.target.name is undefined', 'Array.prototype.map()',
    'e.target.id is not a function', 'React.Component.name()']) assert.ok(logs.includes(text), text);
  for (const text of ['Compiled with exit code 1', 'code splitting enabled', 'Are you sure?', 'metadata: useful', 'Next.js docs', '../src/app.js:1:2',
    'status code 404', 'Unexpected token in JSON', '\\"key\\" prop', 'session expired', 'test pass', 'Object.render Array.map v1.2.3 45ms 15000ms net::ERR_CONNECTION_REFUSED don\'t retry',
    '[omitted] render failed', 'https://[sub].[sub].example.com/users/[seg]/orders', 'http://[ip]:8080/profile/[seg]'])
    assert.ok(logs.includes(text), text);
  assert.match(logs, /localhost:3000\/api\/reset/);
  assert.match(logs, /\[sub\].example.com/);
  const network = await call({ network: true });
  assert.match(network, /\/broken.*"status":503/); assert.match(network, /"method":"POST".*\/ok/);
  assert.match(network, /\/redirect.*"status":302/); assert.match(network, /\/missing.*"status":404/);
  assert.match(network, /"outcome":"failed"/); assert.match(network, /"duration":/);
  assert.match(network, /\/invite\/\[seg\]\/\[seg\]/);
  assert.doesNotMatch(network, /abcdef123456/);
  assert.doesNotMatch(network, /127\.0\.0\.1|clover|forest/);
  assert.match(network, /\[ip\]:\d+\/users\/\[seg\]\/orders/);
  assert.match(network, /\/profile\/\[seg\]/);
  const performance = await call({ performance: true });
  assert.match(performance, /DomContentLoaded: \d/); assert.match(performance, /TaskDuration: \d/);
  assert.match(performance, /since first developer read/); assert.match(performance, /started: \d{4}-/);
  const bounded = await call({ console: true, network: true, performance: true, max_chars: 1000 });
  assert.ok(bounded.length <= 1000); assert.match(bounded, /output truncated/);
  assert.equal(JSON.stringify(hits), before, 'reads must not issue, edit or replay a request');
  assert.equal(await entry.page.evaluate(() => window.getterReads), 0, 'no object getter was read');
  assert.equal(entry.state.snapshotNo, 0, 'developer output admits no page refs');
  assert.equal((await registry.list()).length, 1, 'only the allocated tab is owned');
  await entry.page.goto('http://127.0.0.1:' + server.address().port + '/next');
  const next = await call({ console: true, network: true });
  assert.doesNotMatch(next, /fixture started|fixture render failed|\/broken|\/missing/);
  assert.match(next, /\/next.*"status":200/);
  const developer = entry.developer;
  await registry.keep(tab);
  await assert.rejects(developer.read({ console: true }), /ended/);
  assert.equal(entry.cdp.listenerCount('Runtime.consoleAPICalled'), 0);
  assert.equal(entry.page.isClosed(), false, 'keep releases capture without closing the page');
  await entry.page.close();
});
