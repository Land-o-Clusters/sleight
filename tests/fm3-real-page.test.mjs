import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fillFormCode } from '../plugins/sleight/lib/fill-form.mjs';
import { clickResultCode } from '../plugins/sleight/lib/tab-click-result.mjs';

// FowlBrowser's MIT fixture pages are read from the installed clone, never copied or changed.
const modulePath = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs');
const site = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/test/forms/site');
const executablePath = [1234, 1228].map(version => join(homedir(),
  `Library/Caches/ms-playwright/chromium_headless_shell-${version}/chrome-headless-shell-mac-arm64/chrome-headless-shell`))
  .find(path => existsSync(path));

test('FM3 real fixture isolated-world switch and checkout cover (owner only)', {
  skip: process.platform !== 'darwin' ? 'FM3 fixture adapter needs macOS Chromium' :
    !existsSync(modulePath) ? 'playwright-core is not installed' :
      !existsSync(join(site, 'settings.html')) || !existsSync(join(site, 'checkout.html')) ? 'FowlBrowser fixtures are not installed' :
        !executablePath ? 'headless Chromium is not installed' :
          process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'browser launches are reserved for sleight-arch; set SLEIGHT_LIVE_DOM_TEST=1',
}, async t => {
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = createServer((req, res) => {
    if (req.url === '/nested.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<style>body{margin:0;height:800px}#panel{position:absolute;top:100px;left:10px;width:400px;height:100px;overflow:auto}#content{position:relative;height:800px}header{position:fixed;top:100px;left:10px;width:400px;height:40px;z-index:2;background:white}button{position:absolute;top:50px;left:10px;width:100px;height:40px}</style><div id="panel"><div id="content"><button id="nestedDetails" type="button">Details</button></div></div><header role="banner">Navigation</header>');
      return;
    }
    if (req.url === '/wrapped.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<style>body{margin:0}#wrap{overflow-x:hidden;height:200px}.bar{position:fixed;bottom:0;left:0;right:0;height:60px}.notice{position:fixed;bottom:0;left:0;right:0;height:120px;z-index:3;background:#111}</style><div id="wrap"><div class="bar"><button id="wrappedPay" type="button">Pay</button></div></div><div class="notice" role="dialog" aria-label="Offer">Offer</div>');
      return;
    }
    if (req.url === '/bands.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<style>body{margin:0;height:3000px}.band{position:fixed;left:0;right:0;z-index:3;background:#111}#bottom{bottom:0;height:80px}#middle{top:45%;height:10%;display:none}button{position:absolute;left:10px;width:100px;height:40px}#low{top:560px}#high{top:1100px}</style><div class="band" id="bottom" role="contentinfo" aria-label="Bottom bar">Bar</div><div class="band" id="middle" role="banner" aria-label="Middle band">Band</div><button id="low" type="button">Low</button><button id="high" type="button">High</button>');
      return;
    }
    if (req.url === '/label.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<style>label{position:relative;display:inline-block;padding:20px}#agree{position:absolute;left:20px;top:20px;width:20px;height:20px;margin:0;opacity:0}.box{position:absolute;left:20px;top:20px;width:20px;height:20px;border:1px solid #333}</style><label><input type="checkbox" id="agree"><span class="box"></span> Agree</label>');
      return;
    }
    if (req.url === '/partial.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<style>body{margin:0;height:1600px}header{position:fixed;top:0;left:0;width:100%;height:40px;z-index:2;background:white}button{position:absolute;top:100px;left:10px;width:100px;height:40px}</style><header role="banner">Navigation</header><button id="details" type="button">Details</button>');
      return;
    }
    const file = join(site, (req.url ?? '/').replace(/\?.*$/, ''));
    if (!file.startsWith(site + '/') || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'text/plain' });
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage(), session = await page.context().newCDPSession(page);
  const origin = `http://127.0.0.1:${server.address().port}`;
  let contextId, clicks = 0;
  const navigate = async path => {
    await page.goto(origin + path);
    const { frameTree } = await session.send('Page.getFrameTree');
    ({ executionContextId: contextId } = await session.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'sleight-fixture-reads',
    }));
  };
  const isolated = async (fn, arg) => {
    const reply = await session.send('Runtime.evaluate', { contextId, returnByValue: true, awaitPromise: true,
      expression: `(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})` });
    if (reply.exceptionDetails) throw Error(reply.exceptionDetails.text);
    return reply.result.value;
  };
  const loc = selector => {
    const target = page.locator(selector);
    const api = { count: () => target.count(),
      evaluate: (fn, arg) => isolated(({ selector, source, arg }) => {
        const element = document.querySelector(selector);
        // Match the engine's documented default getter without reaching into the page world.
        const readonly = element.tagName.includes('-') ? new Proxy(element, { get(el, key) {
          if (key === 'checked') return el.checked === true;
          const value = el[key]; return typeof value === 'function' ? value.bind(el) : value;
        }, set() { throw Error('fixture reads are read-only'); } }) : element;
        return (0, eval)('(' + source + ')')(readonly, arg);
      }, { selector, source: fn.toString(), arg }),
      // Like the engine's resolvePointerActionTarget: scroll to the center, then input at the box center
      // with no in-page hit test.
      click: async () => {
        clicks++;
        await target.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
        const box = await target.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      },
      setChecked: (value, options) => target.setChecked(value, { timeout: options.timeoutMs }),
    };
    return new Proxy(api, { get(target, key) {
      if (!(key in target)) throw Error('unsupported engine locator method: ' + String(key));
      return target[key];
    } });
  };
  const notes = [], tab = { id: 'fixture', playwright: { locator: loc }, getAXState: async () => '' };
  const context = createContext({ cua: { getTab: async () => tab }, tab, setTimeout, clearTimeout,
    nodeRepl: { write: text => notes.push(text) } });
  await navigate('/settings.html');
  assert.equal(await isolated(() => document.querySelector('#twoFactor').checked), undefined);
  const out = await runInContext('(async()=>{' + fillFormCode('return await sleight.fillForm(tab,[{locator:"#twoFactor",value:true}])') + '})()', context);
  assert.match(out, /twoFactor\) unverifiable:/);
  assert.equal(clicks, 0);
  assert.equal(await page.locator('#twoFactor').evaluate(el => el.checked), false);

  await navigate('/checkout.html');
  const click = 'var tab = await cua.getTab("fixture"); await tab.playwright.locator("#pay").click();';
  await assert.rejects(runInContext('(async()=>{' + clickResultCode(click) + '})()', context), /covered by button Accept all in region Cookie notice\./);
  assert.equal(clicks, 0);
  assert.deepEqual(notes, []);
  await page.locator('#reject').click();
  await runInContext('(async()=>{' + clickResultCode(click) + '})()', context);
  assert.equal(clicks, 1);

  await navigate('/partial.html');
  await page.evaluate(() => window.scrollTo(0, 110));
  assert.equal(await page.locator('#details').evaluate(el => el.getBoundingClientRect().top), -10);
  notes.length = 0;
  await runInContext('(async()=>{' + clickResultCode('var tab = await cua.getTab("fixture"); await tab.playwright.locator("#details").click();') + '})()', context);
  assert.equal(clicks, 2);
  assert.deepEqual(notes, []);
  assert.ok(await page.locator('#details').evaluate(el => el.getBoundingClientRect().top) >= 40);

  await navigate('/nested.html');
  await page.locator('#panel').evaluate(el => { el.scrollTop = 60; });
  assert.equal(await page.locator('#nestedDetails').evaluate(el => el.getBoundingClientRect().top), 90);
  notes.length = 0;
  await runInContext('(async()=>{' + clickResultCode('var tab = await cua.getTab("fixture"); await tab.playwright.locator("#nestedDetails").click();') + '})()', context);
  assert.equal(clicks, 3);
  assert.deepEqual(notes, []);
  assert.ok(await page.locator('#nestedDetails').evaluate(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; }) >= 140);

  // Covered where it sits by a fixed bottom bar, clear after the engine's center scroll: no refusal.
  await page.setViewportSize({ width: 800, height: 600 });
  await navigate('/bands.html');
  assert.equal(await page.evaluate(() => document.elementFromPoint(60, 580).id), 'bottom');
  notes.length = 0;
  await runInContext('(async()=>{' + clickResultCode('var tab = await cua.getTab("fixture"); await tab.playwright.locator("#low").click();') + '})()', context);
  assert.equal(clicks, 4);
  assert.deepEqual(notes, []);
  // Clear where it sits near the top, under a fixed middle band after the center scroll: refused.
  await page.evaluate(() => { scrollTo(0, 1000); document.querySelector('#middle').style.display = 'block'; });
  assert.equal(await page.evaluate(() => document.elementFromPoint(60, 120).id), 'high');
  await assert.rejects(runInContext('(async()=>{' + clickResultCode('var tab = await cua.getTab("fixture"); await tab.playwright.locator("#high").click();') + '})()', context), /covered by banner Middle band\./);
  assert.equal(clicks, 4);

  // A fixed bar inside an overflow-x wrapper isn't clipped by it, so the cover over it is still named.
  await navigate('/wrapped.html');
  notes.length = 0;
  await assert.rejects(runInContext('(async()=>{' + clickResultCode('var tab = await cua.getTab("fixture"); await tab.playwright.locator("#wrappedPay").click();') + '})()', context), /covered by dialog Offer/);
  assert.equal(clicks, 4);

  // A styled box over a hidden checkbox in its own label activates the checkbox, so it is no cover.
  await navigate('/label.html');
  notes.length = 0;
  await runInContext('(async()=>{' + clickResultCode('var tab = await cua.getTab("fixture"); await tab.playwright.locator("#agree").click();') + '})()', context);
  assert.equal(clicks, 5);
  assert.deepEqual(notes, []);
  assert.equal(await page.locator('#agree').isChecked(), true);
});
