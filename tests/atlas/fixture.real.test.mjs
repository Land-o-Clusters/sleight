// Shared atlas harness. Only the host runner may launch these headless fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywrightCore } from '../../plugins/sleight/lib/direct-browser/worlds.mjs';

export const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1'
  && 'AT1 Chromium 1248 behavior atlas requires the sleight-arch host runner';
export const modifiers = [[], ['ControlOrMeta']];
export const document = body => `<!doctype html><meta charset="utf-8"><title>atlas</title>
  <style>body{margin:0;padding:20px}button,input,select,textarea{margin:8px}</style>${body}`;
export const events = `<script>window.events=[];for(const type of ['input','change','click','focusin'])
  document.addEventListener(type,e=>events.push({type,id:e.target.id,meta:e.metaKey,ctrl:e.ctrlKey,
    inputType:e.inputType||null,data:e.data??null}));</script>`;
export const counts = async page => page.evaluate(() => ({
  input: events.filter(e => e.type === 'input').length,
  change: events.filter(e => e.type === 'change').length,
}));
export async function rejected(action) {
  try { await action(); return false; } catch { return true; }
}

export async function atlas(t, groups) {
  const pin = JSON.parse(readFileSync(new URL('../../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
    .browsers.find(b => b.name === 'chromium-headless-shell');
  assert.equal(pin.revision, '1248', 'atlas qualification pins Chromium revision 1248');
  const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
  const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
    'chrome-headless-shell-' + platform, 'chrome-headless-shell');
  assert.ok(existsSync(executablePath), 'host qualification needs pinned Chromium; no dependency skips');
  const routes = new Map(), sockets = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/redirect/')) {
      const remaining = Number(url.pathname.split('/').pop());
      res.writeHead(302, { Location: remaining ? '/redirect/' + (remaining - 1) : '/landed' }); res.end(); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const body = routes.get(url.pathname) ?? '<title>landed</title><p>local destination</p>';
    req.resume(); req.on('end', () => res.end(body));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, serial = 0;
  const tables = new Map();
  try {
    const runtime = loadPlaywrightCore({ turbo: true });
    browser = await runtime.inprocess.playwright.chromium.launch({ headless: true, executablePath });
    assert.equal(browser.version(), pin.browserVersion);
    t.diagnostic('AT1 runtime ' + JSON.stringify({ chromium: browser.version(), revision: pin.revision, playwright: '1.64.0', headless: true }));
    for (const [group, cases] of groups) {
      const rows = []; tables.set(group, rows);
      for (const row of cases) for (const mod of modifiers) {
        await t.test(`${group}: ${row.name} / ${mod.length ? 'ControlOrMeta' : 'plain'}`, { timeout: 20000 }, async () => {
          const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
          const path = '/fixture/' + (++serial), origin = 'http://127.0.0.1:' + server.address().port;
          routes.set(path, document(row.html));
          const page = await context.newPage(); page.setDefaultTimeout(1200); page.setDefaultNavigationTimeout(5000);
          try {
            await page.goto(origin + path);
            const actual = await row.run(page, mod, { context, origin, path });
            rows.push({ case: row.name, click: mod.length ? 'ControlOrMeta' : 'plain', outcome: actual });
            assert.deepEqual(actual, mod.length && row.modified !== undefined ? row.modified : row.want);
          } catch (error) {
            t.diagnostic('AT1 failure ' + JSON.stringify({ group, case: row.name, click: mod.length ? 'ControlOrMeta' : 'plain',
              error: String(error.message).replaceAll(homedir(), '~') }));
            throw error;
          } finally {
            // Includes every popup, pending action and beforeunload document in this row.
            const pages = context.pages(); await context.close();
            assert.ok(pages.every(page => page.isClosed()), 'every row page and popup closed');
            routes.delete(path);
          }
        });
      }
    }
  } finally {
    // Emit complete tables at the end so the host runner's lastLines receipt retains them.
    for (const [group, rows] of tables) for (const row of rows) t.diagnostic('AT1 row ' + group + ' ' + JSON.stringify(row));
    if (browser) await browser.close();
    await Promise.all([...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); })));
    await new Promise(resolve => server.close(resolve));
    assert.equal(sockets.size, 0, 'loopback sockets collected');
    t.diagnostic('AT1 cleanup: all row contexts and popups closed; owned headless browser closed; loopback server and sockets closed; no disk uploads or persistent profiles');
  }
}
