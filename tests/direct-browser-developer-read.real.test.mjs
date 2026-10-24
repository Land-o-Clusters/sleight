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
setTimeout(() => { throw new Error('fixture render failed'); }, 0);
Promise.allSettled([
  fetch('/ok?token=private-query#private-fragment', {method:'POST',headers:{Authorization:'Bearer private-header'},body:'private-request-body'}),
  fetch('/broken?key=private-query'), fetch('/redirect'), fetch('http://127.0.0.1:1/unreachable')
]).then(() => { window.fixtureDone = true; console.info('fixture settled'); });
</script>`;

test('owned real-page console, request failures and timings are scrubbed without replay or foreign reads', { skip, timeout: 30000 }, async t => {
  assert.ok(existsSync(executablePath), 'pinned Chromium headless shell must be installed');
  const hits = [], sockets = new Set();
  const server = createServer((request, response) => {
    hits.push([request.method, request.url]);
    request.resume(); response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/' || request.url === '/next') { response.setHeader('Content-Type', 'text/html'); response.end(request.url === '/' ? HTML : '<title>Next document</title>'); }
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
  assert.match(logs, /fixture render failed/); assert.match(logs, /sensitive text omitted/);
  const network = await call({ network: true });
  assert.match(network, /\/broken.*"status":503/); assert.match(network, /"method":"POST".*\/ok/);
  assert.match(network, /\/redirect.*"status":302/); assert.match(network, /\/missing.*"status":404/);
  assert.match(network, /"outcome":"failed"/); assert.match(network, /"duration":/);
  const performance = await call({ performance: true });
  assert.match(performance, /DomContentLoaded: \d/); assert.match(performance, /TaskDuration: \d/);
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
