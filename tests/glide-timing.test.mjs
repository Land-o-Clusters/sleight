import test from 'node:test';
import assert from 'node:assert/strict';
import { createMacSafety } from '../plugins/sleight/lib/mac-safety.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';

const window = { windowId: '7', pid: 42, processStart: '1.2', bundleId: 'test.fixture', app: 'Fixture',
  title: 'Draft', identityVerified: true, onScreen: true, minimized: false,
  bounds: { x: 0, y: 0, width: 100, height: 100 } };
const text = 'Window: "Draft", App: Fixture.\n0 standard window Draft\n\t1 button Press';
const binding = { windowId: '7', processStart: '1.2' };

// Removing a phase measurement or counting the native round trip as send time
// must fail these literal splits. The clock advances at external boundaries.
for (const refused of [false, true]) test('parent action timing preserves phase boundaries, refused=' + refused, async t => {
  let time = 0, readId = 0, sent = 0;
  const driver = { ping: async () => ({ build: 'a'.repeat(64) }), async request(method) {
    if (method === 'inputGateState') return { enabled: true };
    if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: 42, processStart: '1.2' }, windows: [window] };
    if (method === 'verifyWindowIdentity') return { window };
    if (method === 'personState') { time += 3; return { token: 'person', personTookOver: false }; }
    if (method === 'getAXState') { time += 2; return { window, text, readId: ++readId, truncated: false }; }
    if (method === 'click') { time += 50; sent++; return { window, delivery: 'sent-unverified',
      timing: { sendMs: 7, settleMs: 31, postReadMs: 11 } }; }
    assert.fail(method);
  } };
  const safety = createMacSafety({ driver, inputRegistrar: await prepareMacInputRegistrar(driver, 'a'.repeat(64)),
    timingNow: () => time,
    lease: { acquire: () => 'lease', renew() {}, release() {}, close() {} }, approve: () => true,
    policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 999, path: '/fixture/host' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false } });
  t.after(() => safety.close());
  safety.setPolicy({ checkPause() {}, beforeAction: ({ args }) => {
    time += 5;
    if (refused) throw Object.assign(Error('POLICY_REFUSED'), { code: 'POLICY_REFUSED', delivery: 'not-sent' });
    return { args };
  } });
  await safety.request('getApp', { selector: 'Fixture' });
  const pending = safety.request('click', { ...binding, readId: 1, args: [1] });
  const result = refused ? await pending.catch(error => error) : await pending;
  assert.ok(result.timing, 'missing phase receipt');
  assert.equal(result.timing.admissionReadMs, 2);
  assert.equal(result.timing.personMs, 3);
  assert.equal(result.timing.policyMs, 5);
  assert.equal(result.timing.sendMs, refused ? 0 : 7);
  assert.equal(result.timing.settleMs, refused ? 0 : 31);
  assert.equal(result.timing.postReadMs, refused ? 0 : 11);
  assert.equal(result.timing.driverMs, refused ? 0 : 50);
  assert.equal(result.timing.totalMs, refused ? 10 : 60);
  assert.equal(result.timing.nativeTimingAvailable, !refused);
  assert.equal(sent, refused ? 0 : 1);
  assert.doesNotMatch(JSON.stringify(result.timing), /Draft|Fixture|test\.fixture|"person"/);
  if (!refused) {
    safety.setPolicy({ checkPause() {}, inspectHelperStep: () => true, beforeAction: () => assert.fail('inspection cannot admit input') });
    assert.equal(await safety.request('click', { ...binding, readId: 2, args: [1] },
      { inspectOnly: true, helper: 'pickFromList', cell: 'inspection', messageId: 1 }), true);
    assert.equal(sent, 1, 'inspection dispatched input');
  }
});
