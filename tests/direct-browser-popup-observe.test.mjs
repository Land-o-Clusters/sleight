import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';

function fixture({ opened = [{ tab: 'tchild' }], childOpener = 'tparent', childState = {}, childURL = 'https://child.invalid/',
  snapshotError, sites, endpoint, afterCapture, duringChildQueue, actResult = {} } = {}) {
  const state = () => ({ snapshotNo: 0, submitUnconfirmed: { snapshotNo: 0, fixture: true } });
  const parent = { page: { url: () => 'https://parent.invalid/' }, state: state(), popups: [], tab: 'tparent' };
  const child = { page: { url: () => childURL }, state: { ...state(), ...childState }, opener: childOpener, tab: 'tchild' };
  const entries = new Map([['tparent', parent], ['tchild', child]]), reads = [], deliveries = [], queue = [];
  let held = false;
  const pages = {
    tab: id => { if (!entries.has(id)) throw Error('unknown or releasing owned tab'); return entries.get(id); },
    closedOpener: () => undefined,
    async enqueue(id, fn) {
      assert.equal(held, false, 'popup read must wait until the opener queue releases');
      queue.push(id); held = true;
      try { if (id === 'tchild') await duringChildQueue?.(entries, parent, child); return await fn(pages.tab(id)); }
      finally { held = false; }
    },
    endTurn: async () => ({ cleanedUp: true }),
  };
  const d = createToolDispatcher({ pages, sites, endpoint, siteMemory: null,
    snapshot: async page => {
      reads.push(page);
      if (snapshotError) throw Error(snapshotError);
      await afterCapture?.(entries, parent, child);
      return { text: '# Snapshot 1 (untrusted page content)\n- button "Child only" [ref=e1]', number: 1 };
    },
    runSteps: async () => {
      parent.popups.push(...opened);
      return { lines: ['1 click e1: opened background tab; opener below', '2 wait: not reached'], stoppedAt: 1,
        observe: { text: '# Snapshot 2 (untrusted page content)\n- button "Parent only" [ref=e1]', number: 2, capturedAt: Date.now() }, ...actResult };
    },
    fillFields: () => assert.fail('no fill'),
    deliverSnapshot: (s, capture) => { deliveries.push(capture); s.snapshotNo = capture.number; return true; },
  });
  return { d, parent, child, reads, deliveries, queue,
    call: (observe = 'diff') => d.call({ name: 'browser_act', arguments: { tab: 'tparent', steps: [{ do: 'click', ref: 'e1' }, { do: 'wait', ms: 1000 }], observe } }) };
}

async function withFlag(t, value) {
  const previous = process.env.SLEIGHT_POPUP_OBSERVE;
  if (value === undefined) delete process.env.SLEIGHT_POPUP_OBSERVE; else process.env.SLEIGHT_POPUP_OBSERVE = value;
  t.after(() => { if (previous === undefined) delete process.env.SLEIGHT_POPUP_OBSERVE; else process.env.SLEIGHT_POPUP_OBSERVE = previous; });
}

for (const flag of [undefined, '0', 'true', '1']) test(`PF7 popup read is opt-in and queued after the parent: ${flag}`, async t => {
  await withFlag(t, flag);
  const f = fixture(), result = await f.call();
  assert.equal(result.isError, false);
  assert.match(result.text, /2 wait: not reached/);
  assert.match(result.text, /Parent only/);
  assert.equal(f.reads.length, flag === '1' ? 1 : 0);
  assert.equal(f.d.delivered({ ...result }), false);
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.d.delivered(result), true);
  assert.equal(f.d.delivered(result), false);
  assert.equal(f.deliveries.length, flag === '1' ? 2 : 1);
  assert.ok(f.parent.state.submitUnconfirmed, 'a child read never clears the parent submit fence');
  if (flag === '1') {
    assert.match(result.text, /New tab tchild \(untrusted page content\):\n# Snapshot/);
    assert.deepEqual(f.queue, ['tparent', 'tchild']);
    assert.equal(f.deliveries[0].page, f.parent.page);
    assert.equal(f.deliveries[1].page, f.child.page);
  } else assert.doesNotMatch(result.text, /Child only/);
});

const refusals = [
  ['multiple popups', { opened: [{ tab: 'tchild' }, { tab: 'tother' }] }],
  ['closed popup', { opened: [{ tab: 'tchild', closed: true }] }],
  ['blocked popup', { opened: [{ tab: 'tchild', blocked: true }] }],
  ['same handle', { opened: [{ tab: 'tparent' }] }],
  ['unowned handle', { opened: [{ tab: 'tunknown' }] }],
  ['different opener', { childOpener: 'tother' }],
  ['pending input', { childState: { actionPending: {} } }],
  ['pending dialog', { childState: { dialog: {} } }],
  ['stuck page', { childState: { stuck: {} } }],
  ['blocked site', { sites: url => url.includes('child') ? 'User blocked this site.' : undefined }],
  ['endpoint page', { childURL: 'http://127.0.0.1:9222/json/version', endpoint: 'http://127.0.0.1:9222' }],
  ['closed while queued', { duringChildQueue: entries => entries.delete('tchild') }],
];
for (const [name, options] of refusals) test(`PF7 optional popup observation refuses ${name}`, async t => {
  await withFlag(t, '1');
  const f = fixture(options), result = await f.call();
  assert.equal(result.isError, false, 'the input outcome remains available');
  assert.doesNotMatch(result.text, /Child only|New tab/);
  assert.equal(f.reads.length, 0);
  assert.equal(f.d.delivered(result), true);
  assert.equal(f.deliveries.length, 1);
});

for (const [name, options] of [
  ['capture failure', { snapshotError: 'private URL and error' }],
  ['child identity replaced', { afterCapture: (entries, parent, child) => entries.set('tchild', { ...child }) }],
  ['parent released', { afterCapture: entries => entries.delete('tparent') }],
  ['late site block', { sites: (() => { let reads = 0; return url => url.includes('child') && ++reads > 1 ? 'blocked' : undefined; })() }],
]) test(`PF7 popup ${name} preserves the opener receipt`, async t => {
  await withFlag(t, '1');
  const f = fixture(options), result = await f.call();
  assert.match(result.text, /Parent only/); assert.doesNotMatch(result.text, /Child only|private URL|New tab/);
  assert.equal(f.d.delivered(result), true); assert.equal(f.deliveries.length, 1);
});

test('PF7 none observation never adds a child read', async t => {
  await withFlag(t, '1');
  const f = fixture(), result = await f.call('none');
  assert.equal(f.reads.length, 0); assert.doesNotMatch(result.text, /Child only/);
});

for (const changed of ['text', 'images', 'end']) test(`PF7 combined delivery cannot be acknowledged after ${changed}`, async t => {
  await withFlag(t, '1');
  const f = fixture(), result = await f.call();
  if (changed === 'text') result.text += '\nchanged';
  if (changed === 'images') result.images = [{ type: 'image', data: 'foreign', mimeType: 'image/png' }];
  if (changed === 'end') await f.d.end();
  assert.equal(f.d.delivered(result), false); assert.equal(f.deliveries.length, 0);
});
