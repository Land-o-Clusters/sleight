import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { preparePdfHelper, extractPdf } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { createPdfReader } from '../plugins/sleight/lib/direct-browser/pdf.mjs';
import { createPageRegistry } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { snapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { pdfTotalFixture } from '../bench/world/pdf-total.mjs';
import { textPdf } from '../bench/pdf-fixture.mjs';

const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url))).browsers.find(row => row.name === 'chromium');
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', `chromium-${pin.revision}`,
  'chrome-mac-' + process.arch, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'requires opt-in headless Chromium fixture harness'
  : process.platform !== 'darwin' || !existsSync(executablePath) ? 'requires macOS PDFKit and pinned headless Chromium' : false;

test('owned headless PDF tab returns page 3 through PDFKit without refetching; HTML and site guards retain their paths', {
  skip, timeout: 360000,
}, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sleight-pdf-real-'));
  const fixture = pdfTotalFixture({ cents: 73142 }), hits = [], sockets = new Set();
  const server = createServer((request, response) => {
    hits.push(request.url);
    if (request.url === '/many') {
      const pdf = textPdf(Array.from({ length: 20 }, (_, i) => 'Continuation page ' + (i + 1) + ': ' + 'invoice terms '.repeat(25)));
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length }); response.end(pdf);
    } else fixture.serve(request, response);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let browser, dispatcher, blocked = false;
  t.after(async () => {
    await dispatcher?.end(); await browser?.close();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/pdf-host.swift', import.meta.url));
  const built = await preparePdfHelper({ cacheRoot: join(root, 'cache'), inventory: { accepted: true, protocol: 1, node: process.version,
    helperMode: 'source', files: [{ path: 'native/pdf-host.swift', bytes: source.length, sha256: createHash('sha256').update(source).digest('hex') }] } });
  assert.equal(built.status, 'ready', JSON.stringify(built));
  const pdf = createPdfReader({ extract: (path, cursor) => extractPdf(built.receipt, path, cursor) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Full Chromium in headless mode supports its PDF viewer; headless-shell downloads PDFs instead.
  const context = await chromium.launchPersistentContext(join(root, 'profile'), { headless: true, executablePath });
  browser = context.browser();
  const pages = createPageRegistry({ browser, session: await browser.newBrowserCDPSession() });
  dispatcher = createToolDispatcher({ browser: 'bfixture', pages, pdf, snapshot,
    sites: () => blocked ? 'Blocked fixture site.' : undefined, runSteps() {}, fillFields() {} });
  const call = async (name, args) => { const result = await dispatcher.call({ name, arguments: args });
    assert.equal(result.isError, false, result.text); dispatcher.delivered(result); return result; };
  const html = await call('browser_open', { url: origin + '/pdf-total' });
  assert.match(html.text, /Read invoice PDF/);
  const htmlTab = /^t\S+/.exec(html.text)[0];
  let originalCdp;
  await pages.enqueue(htmlTab, async entry => {
    originalCdp = entry.cdp;
    entry.cdp = { async send() { throw Error('Resource tree unavailable for this ordinary page'); } };
  });
  try { assert.match((await call('browser_read', { tab: htmlTab })).text, /Read invoice PDF/); }
  finally { await pages.enqueue(htmlTab, async entry => { entry.cdp = originalCdp; }); }
  const opened = await call('browser_open', { url: origin + '/invoice' }), tab = /^t\S+/.exec(opened.text)[0];
  assert.match(opened.text, /Page 3\/3: "Final invoice total: USD 731.42\."/);
  assert.equal(dispatcher.delivered(opened), false, 'PDF reads never deliver DOM refs');
  const firstHits = hits.filter(url => url === '/invoice').length;
  const read = await call('browser_read', { tab, max_chars: 1000 });
  assert.match(read.text, /Page 3\/3/); assert.equal(fixture.grade('Page 3: USD 731.42'), true);
  assert.equal(hits.filter(url => url === '/invoice').length, firstHits, 'read uses loaded bytes');
  const large = await call('browser_open', { url: origin + '/many' }), longTab = /^t\S+/.exec(large.text)[0];
  let part = await call('browser_read', { tab: longTab, max_chars: 1000 }), ref = /ref="(pdf_[a-f0-9]+)"/.exec(part.text)[1];
  assert.ok(part.text.length <= 1000);
  part = await call('browser_read', { tab: longTab, ref, max_chars: 1000 });
  assert.ok(part.text.length <= 1000); assert.match(part.text, /Continuation page/);
  await pages.enqueue(longTab, async entry => { await entry.page.reload(); });
  const stale = await dispatcher.call({ name: 'browser_read', arguments: { tab: longTab, ref } });
  assert.equal(stale.isError, true); assert.match(stale.text, /continuation expired/);
  blocked = true;
  const refused = await dispatcher.call({ name: 'browser_read', arguments: { tab } });
  assert.equal(refused.isError, true); assert.equal(refused.text, 'Blocked fixture site.');
  assert.deepEqual(await dispatcher.end(), { revoked: true, cleanup: [] });
  assert.equal(browser.contexts()[0].pages().length, 1, 'the pre-existing headless blank tab stays outside ownership');
});

test('pdf-total grader needs the exact random total and page number', () => {
  const fixture = pdfTotalFixture({ cents: 42424 });
  assert.equal(fixture.grade('Page 3: USD 424.24.'), true);
  for (const answer of ['Page 3: USD 19.50.', 'The final total is USD 424.24.', 'Page 3: USD 1424.24.', 'Page 2: USD 424.24.', 'Page 2: USD 424.24. Page 3: USD 19.50.'])
    assert.equal(fixture.grade(answer), 'PDF_TOTAL_OR_PAGE_MISSING');
});
