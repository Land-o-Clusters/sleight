import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../bench/turbo/v3-session.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'requires the owned headless Chromium';

test('headless worker records twenty opens, skips quiet viewport reads and settles resize requests', { skip, timeout: 60000 }, async t => {
  const root = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-x6-dom-'))));
  const metrics = join(root, 'turbo-metrics.jsonl'), old = process.env.SLEIGHT_TURBO_METRICS;
  process.env.SLEIGHT_TURBO_METRICS = metrics;
  t.after(() => { if (old === undefined) delete process.env.SLEIGHT_TURBO_METRICS; else process.env.SLEIGHT_TURBO_METRICS = old; });
  const server = createServer((req, res) => {
    if (req.url === '/slow') { setTimeout(() => res.end('ok'), 250); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Local fixture</title><output>Ready</output>' + (req.url === '/requests'
      ? `<script>addEventListener('resize',()=>{document.querySelector('output').textContent='Waiting';fetch('/slow').then(()=>document.querySelector('output').textContent='Request complete')})</script>` : ''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const session = await createSession({ origins: [origin], taskMessage: 'Read this local fixture and resize its viewport.' });
  t.after(() => session.close());
  const call = async (name, args) => {
    const result = await session.call({ name, arguments: args });
    assert.equal(result.isError, false, result.text);
    session.delivered(result);
    return result.text;
  };
  let opened;
  for (let n = 0; n < 20; n++) opened = await call('browser_open', { url: origin });
  const tab = /^(t\w+)/.exec(opened)[1];
  const before = readFileSync(metrics, 'utf8').trim().split('\n').map(JSON.parse);
  const starts = before.filter(row => row.phase === 'browser-open-start');
  assert.equal(starts.length, 20);
  for (const start of starts) {
    const phases = before.filter(row => row.call === start.call && row.turn === start.turn);
    assert.deepEqual(phases.map(row => row.phase), ['browser-open-start', 'browser-open-create-start', 'browser-open-create-end',
      'browser-open-attach-end', 'browser-open-identify-end', 'browser-open-adopt-end', 'browser-open-ready-end',
      'browser-open-goto-start', 'browser-open-navigated', 'browser-open-goto-end', 'browser-open-capture-start', 'browser-open-capture-end', 'browser-open-end']);
    assert.ok(phases.every((row, i) => i === 0 || Date.parse(row.t) >= Date.parse(phases[i - 1].t)));
  }
  assert.doesNotMatch(JSON.stringify(before), /Local fixture|127\.0\.0\.1|sleight-x6-dom/);
  const began = performance.now();
  const viewport = await call('browser_act', { tab, steps: [{ do: 'viewport', width: 390, height: 844 }], observe: 'none' });
  const viewportMs = performance.now() - began;
  assert.match(viewport, /viewport 390x844/);
  assert.doesNotMatch(viewport, /Ready|\[ref=/);
  const requesting = await call('browser_open', { url: origin + '/requests' });
  const requestTab = /^(t\w+)/.exec(requesting)[1];
  const requested = await call('browser_act', { tab: requestTab, steps: [{ do: 'viewport', width: 390, height: 844 }] });
  assert.match(requested, /Request complete/);
  assert.doesNotMatch(requested, /unconfirmed/);
  const waitStart = performance.now();
  await call('browser_act', { tab: requestTab, steps: [{ do: 'wait', ms: 3000 }], observe: 'none' });
  const waitMs = performance.now() - waitStart;
  const duration = (rows, a, b) => Date.parse(rows.find(row => row.phase === b).t) - Date.parse(rows.find(row => row.phase === a).t);
  const timings = starts.map(start => {
    const rows = before.filter(row => row.call === start.call && row.turn === start.turn);
    return { total: duration(rows, 'browser-open-start', 'browser-open-end'),
      create: duration(rows, 'browser-open-create-start', 'browser-open-create-end'),
      attach: duration(rows, 'browser-open-create-end', 'browser-open-attach-end'),
      identify: duration(rows, 'browser-open-attach-end', 'browser-open-identify-end'),
      adopt: duration(rows, 'browser-open-identify-end', 'browser-open-adopt-end'),
      ready: duration(rows, 'browser-open-adopt-end', 'browser-open-ready-end'),
      goto: duration(rows, 'browser-open-goto-start', 'browser-open-goto-end'),
      capture: duration(rows, 'browser-open-capture-start', 'browser-open-capture-end') };
  });
  t.diagnostic(JSON.stringify({ viewportMs, waitMs, openTimingsMs: timings }));
  const cleanup = await session.close();
  assert.deepEqual(cleanup, { revoked: true, cleanup: [] });
  const oldFlag = process.env.SLEIGHT_LB12;
  process.env.SLEIGHT_LB12 = '0';
  t.after(() => { if (oldFlag === undefined) delete process.env.SLEIGHT_LB12; else process.env.SLEIGHT_LB12 = oldFlag; });
  const control = await createSession({ origins: [origin], taskMessage: 'Resize this local fixture.' });
  t.after(() => control.close());
  const first = await control.call({ name: 'browser_open', arguments: { url: origin } });
  assert.equal(first.isError, false, first.text);
  const controlStart = performance.now();
  const changed = await control.call({ name: 'browser_act', arguments: { tab: /^(t\w+)/.exec(first.text)[1],
    steps: [{ do: 'viewport', width: 390, height: 844 }], observe: 'none' } });
  assert.equal(changed.isError, false, changed.text);
  assert.match(changed.text, /viewport 390x844/);
  t.diagnostic(JSON.stringify({ controlViewportMs: performance.now() - controlStart, viewportMs }));
  assert.deepEqual(await control.close(), { revoked: true, cleanup: [] });
});
