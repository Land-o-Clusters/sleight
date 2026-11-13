import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, doc, readOnly, skip } from './fixtures/bank.mjs';

// Ad chains: a page holds a cross-site frame that holds another cross-site frame (publisher, exchange, creative). Through the CDP
// filter such a page used to stay "interactive" for good (22/24 loads at depth 2, 23/24 at depth 3), browser_open waited its 3 s
// for the page to settle, and page.goto on the open page hung (5/20 at depth 3). Chrome drops a nested frame's pending load when
// Target.setAutoAttach reaches a session above it a second time or from a new session, so the filter sends it once per session.
const N = Number(process.env.N ?? 6);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hosts = ['localhost', 'a.localhost', 'b.localhost', 'c.localhost'];
const chain = (port, depth) => {
  const routes = {};
  for (let i = 0; i < depth; i++) routes['/n' + i] = `<!doctype html><div>L${i}</div>` +
    (i + 1 < depth ? `<iframe src="http://${hosts[i + 1]}:${port}/n${i + 1}"></iframe>` : '');
  routes['/plain'] = '<!doctype html><p>plain</p>';
  return { routes, body: `<input id="a" aria-label="Search"><iframe src="http://${hosts[0]}:${port}/n0"></iframe>` };
};
// Every frame's readyState, each bounded: a frame whose load never finishes has no answer.
const states = page => Promise.all(page.frames().map(frame => Promise.race([frame.evaluate(() => document.readyState).catch(() => 'gone'),
  sleep(3000).then(() => 'TIMEOUT')])));

for (const depth of [2, 3]) {
  test('cross-site frames nested ' + depth + ' deep: every load finishes and browser_open does not wait', { skip, timeout: 300000 }, async t => {
    const b = await bank(t), port = new URL(b.origin).port, { routes, body } = chain(port, depth), failures = [];
    for (let i = 0; i < N; i++) {
      const started = Date.now();
      const f = await b.start(doc(body, ''), readOnly, { route: '/d' + i, routes });
      const opened = Date.now() - started;
      await sleep(1200);
      const all = await states(f.page);
      if (opened > 2500 || all.length !== depth + 1 || all.some(state => state !== 'complete')) failures.push(i + ': open ' + opened + ' ms, frames ' + all.join('/'));
      await f.safe();
    }
    assert.deepEqual(failures, [], 'loads that did not finish: ' + failures.join(' | '));
  });
}

test('page.goto on an open page with cross-site frames nested 3 deep does not hang', { skip, timeout: 300000 }, async t => {
  const b = await bank(t), port = new URL(b.origin).port, { routes, body } = chain(port, 3), failures = [];
  const f = await b.start(doc(body, ''), readOnly, { route: '/nested', routes });
  await sleep(1000);
  for (let i = 0; i < N; i++) {
    const target = i % 2 ? '/nested' : '/plain';
    try { await f.page.goto(b.origin + target, { timeout: 6000 }); }
    catch (error) { failures.push(i + ' ' + target + ': ' + error.message.split('\n')[0]); continue; }
    await sleep(300);
    const all = await states(f.page);
    if (all.some(state => state !== 'complete')) failures.push(i + ' ' + target + ': frames ' + all.join('/'));
  }
  assert.deepEqual(failures, [], 'navigations that hung or left a frame unfinished: ' + failures.join(' | '));
  await f.safe();
});
