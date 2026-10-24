import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '../../plugins/sleight/vendor/playwright-core/index.mjs';
import { createCDPFilter } from '../../plugins/sleight/lib/direct-browser/cdp-filter.mjs';
import { createPageRegistry } from '../../plugins/sleight/lib/direct-browser/page.mjs';
import { createV3TurnBinding } from '../../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { createV3TurnRuntime } from '../../plugins/sleight/lib/direct-browser/worker.mjs';
import { snapshot, acknowledgeSnapshot } from '../../plugins/sleight/lib/direct-browser/snapshot.mjs';

export const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'needs SLEIGHT_LIVE_DOM_TEST=1 (owned headless fixtures only)';
export async function fixture(t, html, { message = 'Inspect the animation after each requested action.', routes = {} } = {}) {
  const pin = JSON.parse(readFileSync(new URL('../../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
    .browsers.find(b => b.name === 'chromium-headless-shell');
  const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
  const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
    'chrome-headless-shell-' + platform, 'chrome-headless-shell');
  assert.ok(existsSync(executablePath), 'pinned headless Chromium must be installed');
  const profile = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-fd1-'));
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html'); response.end(routes[request.url] ?? html);
  });
  let context, socket, browser, filter, registry, runtime, current = true;
  t.after(async () => {
    try {
      current = false;
      if (runtime) assert.deepEqual((await runtime.end()).cleanup, []);
      await browser?.close();
      if (filter) assert.equal(await filter.dispose(), true, 'owned CDP sessions must detach');
      if (socket && socket.readyState !== 3) await new Promise(resolve => { socket.once('close', resolve); socket.terminate(); });
      await context?.close();
    } finally {
      server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
      rmSync(profile, { recursive: true, force: true });
    }
    assert.equal(existsSync(profile), false);
    t.diagnostic('Cleanup: owned headless browser closed, CDP sessions/socket collected, fixture server closed, private profile removed.');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--site-per-process'], viewport: { width: 1200, height: 800 } });
  const sentinel = context.pages()[0];
  await sentinel.goto('about:blank');
  const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
  const endpoint = 'ws://127.0.0.1:' + port + path;
  const { ws } = createRequire(import.meta.url)('../../plugins/sleight/vendor/playwright-core/lib/utilsBundle.js');
  socket = new ws(endpoint);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const pending = new Map(), listeners = new Set(), wire = []; let serial = 0;
  socket.on('message', bytes => {
    const frame = JSON.parse(bytes.toString());
    if (!frame.id) { for (const listener of listeners) listener(frame); return; }
    const wait = pending.get(frame.id); pending.delete(frame.id);
    if (frame.error) wait?.reject(Error(frame.error.message)); else wait?.resolve(frame.result);
  });
  socket.on('close', () => { for (const wait of pending.values()) wait.reject(Error('fixture closed')); pending.clear(); });
  const upstream = { sessionId: 'root', on: (_name, fn) => listeners.add(fn), off: (_name, fn) => listeners.delete(fn),
    send(method, params = {}, route = 'root') {
      wire.push({ method, route, type: params.type }); const id = ++serial;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(route === 'root' ? {} : { sessionId: route }) }));
      });
    } };
  filter = createCDPFilter({ session: upstream, protectedPort: Number(port) });
  const bridge = await filter.listen();
  browser = await chromium.connectOverCDP(bridge.endpoint, { noDefaults: true, timeout: 10000 });
  registry = createPageRegistry({ browser, session: await browser.newBrowserCDPSession(), upstream,
    ownTarget: filter.own, releaseTarget: filter.release, frames: filter.frames, endpoint, endpointBlocked: filter.endpointBlocked });
  const { tab } = await registry.openTab({ url: 'http://127.0.0.1:' + server.address().port + '/start' });
  const entry = registry.tab(tab);
  const binding = createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'fd1', text: message }, () => current);
  runtime = await createV3TurnRuntime({ binding, browser: 'bfixture', pages: registry, snapshot, endpoint, dependencies: { acknowledgeSnapshot } });
  const call = async (name, args) => {
    const result = await runtime.call({ name, arguments: { tab, ...args } });
    if (!result.isError) runtime.delivered(result);
    return result;
  };
  return { entry, tab, call, wire, sentinel, registry, context };
}
