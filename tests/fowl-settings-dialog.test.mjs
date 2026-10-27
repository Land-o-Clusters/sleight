import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { startGateForms } from '../bench/fowl/real-gate-sites.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

// The pinned fixture's handlers. The gate must leave their visible behavior and
// submit payload alone; this miniature DOM lets us execute them without a browser.
const fixture = `<h1>Settings</h1><dialog id="confirm">Save these settings?</dialog>
<script type="module">
const $ = s => document.querySelector(s);
const values = () => structuredClone(document.values);
const showErrors = () => document.valid;
const submit = async (form, data) => document.submits.push({ form, data });
$('#form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const e = {};
  if (showErrors(e)) $('#confirm').showModal();
});
$('#cancel').onclick = () => $('#confirm').close();
$('#do-save').onclick = async () => { const v = values(); $('#confirm').close(); await submit('settings', v); };
</script>`;
const data = { reference: 'p08', emailAlerts: true, smsAlerts: true, weeklyDigest: false, theme: 'auto', twoFactor: true,
  volume: 82, languages: ['de', 'es-MX', 'ko'], timezone: 'America/Argentina/Salta',
  priorities: ['Mentions', 'Reminders', 'Security', 'Product updates', 'Billing'] };

async function harness(t, html = fixture, transport = 'ok') {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'gr1-dialog-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'site')); writeFileSync(join(root, 'site/settings.html'), html);
  const server = await startGateForms(root, { ports: [0], gradeToken: () => ({}) });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.ports[0]}`;
  const read = async (after = 0) => (await fetch(`${origin}/gate-log/p08?after=${after}`)).json();
  const response = await fetch(origin + '/settings', { headers: { 'sec-fetch-dest': 'document' } });
  const page = await response.text();
  const handlers = new Map(), elements = new Map(), pending = [], queued = [];
  const element = id => {
    const listeners = new Map();
    return { open: false, remove() { this.removed = true; },
      addEventListener(name, fn) { listeners.set(name, fn); },
      emit(name) { return listeners.get(name)?.({ preventDefault() {} }); },
      showModal() { this.open = true; }, close() { this.open = false; this.emit('close'); },
      listeners, id };
  };
  for (const id of ['#form', '#confirm', '#cancel', '#do-save', 'script[type="module"]']) elements.set(id, element(id));
  const document = { values: structuredClone(data), valid: true, submits: [], querySelector: id => elements.get(id) };
  const navigator = { sendBeacon(path, body) {
    if (transport === 'throws') throw Error('beacon transport unavailable');
    if (transport === 'refuses') return false;
    queued.push(JSON.parse(body));
    pending.push(fetch(origin + path, { method: 'POST', headers: { origin }, body }));
    return true;
  } };
  if (transport === 'absent') delete navigator.sendBeacon;
  const context = { document, navigator, structuredClone, addEventListener: (name, fn) => handlers.set(name, fn) };
  const code = page.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  if (response.ok) runInNewContext(code, context);
  const flush = async () => { await Promise.all(pending.splice(0)); return read(); };
  return { origin, read, response, page, document, elements, handlers, queued, flush,
    save: () => elements.get('#form').emit('submit'), cancel: () => elements.get('#cancel').onclick(),
    confirm: () => elements.get('#do-save').onclick() };
}

test('fixture records exact values once per dialog transition with one local beacon', async t => {
  const h = await harness(t);
  assert.equal(h.response.status, 200);
  assert.equal(h.page.replace(/<script type="module">[\s\S]*?<\/script>/, ''), fixture.replace(/<script type="module">[\s\S]*?<\/script>/, ''));
  h.save(); h.save();
  assert.equal(h.elements.get('#confirm').open, true);
  let log = await h.flush();
  assert.equal(log.dialogs.length, 1);
  assert.deepEqual(log.dialogs[0].data, data);
  assert.equal(log.dialogs[0].event, 'opened');
  assert.equal(h.queued.length, 1);
  assert.equal(JSON.stringify(log).includes(h.queued[0].key), false, 'log never exposes the write key');
  assert.equal(h.elements.get('script[type="module"]').removed, true);
  h.document.values.volume = 81; h.cancel();
  log = await h.flush();
  assert.deepEqual(log.dialogs.map(r => r.event), ['opened', 'cancelled']);
  assert.equal(log.dialogs[1].data.volume, 81);
  assert.equal(h.elements.get('#confirm').open, false);
  assert.equal(h.document.submits.length, 0);
  assert.equal((await h.read(log.cursor)).dialogs.length, 0);
  h.save(); await h.confirm(); log = await h.flush();
  assert.deepEqual(log.dialogs.map(r => r.event), ['opened', 'cancelled', 'opened', 'confirmed']);
  assert.deepEqual(structuredClone(h.document.submits), [{ form: 'settings', data: { ...data, volume: 81 } }]);
  assert.equal(h.queued.length, 4);
});
for (const how of ['escape', 'close', 'pagehide']) test(`${how} cancels an open dialog once`, async t => {
  const h = await harness(t); h.save();
  if (how === 'escape') { h.elements.get('#confirm').emit('cancel'); h.elements.get('#confirm').close(); }
  if (how === 'close') h.elements.get('#confirm').close();
  if (how === 'pagehide') h.handlers.get('pagehide')();
  assert.deepEqual((await h.flush()).dialogs.map(r => r.event), ['opened', 'cancelled']);
  assert.equal(h.queued.length, 2);
});
test('invalid forms keep the dialog closed and emit no evidence', async t => {
  const h = await harness(t); h.document.valid = false; h.save();
  assert.equal(h.elements.get('#confirm').open, false);
  assert.deepEqual((await h.flush()).dialogs, []);
});
test('the log rejects fabricated writes, replay and non-navigation keys', async t => {
  const h = await harness(t);
  const post = body => fetch(h.origin + '/gate-log/settings-dialog', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post({ event: 'opened', data })).status, 403);
  h.save(); await h.flush();
  assert.equal((await post(h.queued[0])).status, 409);
  const source = await (await fetch(h.origin + '/settings')).text();
  assert.equal(source.includes(h.queued[0].key), false);
  assert.equal((await post({ key: null, event: 'opened', data })).status, 403);
  assert.equal((await h.read()).dialogs.length, 1);
});
test('changed fixture handlers fail closed instead of silently dropping evidence', async t => {
  const h = await harness(t, fixture.replace("if (showErrors(e)) $('#confirm').showModal();", 'if (showErrors(e)) customOpen();'));
  assert.equal(h.response.status, 500);
});
for (const transport of ['throws', 'refuses', 'absent']) test(`a ${transport} beacon leaves normal fixture behavior and no stop evidence`, async t => {
  const h = await harness(t, fixture, transport);
  h.save(); assert.equal(h.elements.get('#confirm').open, true);
  await h.confirm(); assert.equal(h.document.submits.length, 1);
  assert.equal(h.elements.get('#confirm').open, false);
  assert.deepEqual((await h.flush()).dialogs, []);
});

test('offline measurement of 30 dialog openings and their loopback records', async t => {
  const h = await harness(t), synchronous = [], delivery = [], baseline = [];
  for (let i = 0; i <= 30; i++) {
    let start = performance.now(); h.elements.get('#confirm').showModal();
    const bare = performance.now() - start; h.elements.get('#confirm').open = false;
    start = performance.now(); h.save(); const sync = performance.now() - start;
    const log = await h.flush(), received = performance.now() - start;
    assert.equal(log.dialogs.at(-1).event, 'opened');
    if (i) { baseline.push(bare); synchronous.push(sync); delivery.push(received); }
    h.cancel(); await h.flush();
  }
  const stats = values => { const sorted = values.sort((a, b) => a - b); return { median: sorted[14], p95: sorted[28], max: sorted[29] }; };
  t.diagnostic(JSON.stringify({ samples: 30, unit: 'ms', baselineStub: stats(baseline), beaconWithNodeFetch: stats(synchronous),
    loopbackRecordAndRead: stats(delivery), beacons: h.queued.length, records: (await h.read()).dialogs.length }));
  assert.equal(h.queued.length, 62);
  assert.equal((await h.read()).dialogs.length, 62);
});
