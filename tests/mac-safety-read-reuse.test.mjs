import test from 'node:test';
import assert from 'node:assert/strict';
import { createMacSafety as standardSafety } from '../plugins/sleight/lib/mac-safety.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { productModule } from './fixtures/runtime-helper-inspection.mjs';

const reuseVariants = {
  default: ["process.env.SLEIGHT_GLIDE_READ_REUSE !== '0'", "process.env.SLEIGHT_GLIDE_READ_REUSE === '1'"],
  consume: ['delete entry.reuseReadId;', '/* broken: retain candidate after input */'],
  capture: ["['getApp', 'getAXState'].includes(method)", "['getApp', 'getAXState', 'getAXStateAndScreenshot'].includes(method)"],
  'capture-candidate': ['else delete entry.reuseReadId;', '/* broken: keep the earlier AX candidate after capture */'],
};
const createMacSafety = process.env.GLS4_REUSE_MUTANT ? (await productModule('mac-safety.mjs', source => {
  const [before, after] = reuseVariants[process.env.GLS4_REUSE_MUTANT];
  assert.ok(source.includes(before));
  // Keep the real capability provider. productModule's generic helper normally
  // substitutes its own registrar, which cannot admit our real capability.
  return source.replace(before, after).replace("'./mac-driver/input-registrar.mjs'",
    JSON.stringify(new URL('../plugins/sleight/lib/mac-driver/input-registrar.mjs', import.meta.url).href));
})).createMacSafety : standardSafety;

async function fixture(t, readReuse) {
  const window = { windowId: '42', pid: 42, processStart: '1.0', bundleId: 'test.reuse', app: 'Fixture',
    title: 'Fixture', identityVerified: true, onScreen: true, bounds: { x: 0, y: 0, width: 100, height: 100 } };
  const text = 'Window: "Fixture", App: Fixture.\n0 standard window Fixture\n\t1 button OK';
  const calls = [], reads = createMacReadState(); let readId = 0;
  const driver = { ping: async () => ({ build: 'b'.repeat(64) }), async request(method, params) {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'inputGateState') return { enabled: true };
    if (method === 'resolveApp') return { app: { id: window.bundleId, pid: 42, processStart: '1.0' }, windows: [window] };
    if (method === 'verifyWindowIdentity') return { window };
    if (['getAXState', 'getAXStateAndScreenshot'].includes(method)) {
      const reused = params.reuseIfUnchanged === readId && readId > 0;
      if (!reused) readId++;
      return { window, text, readId, reused, truncated: false,
        ...method === 'getAXStateAndScreenshot' ? { screenshot: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } } : {} };
    }
    if (method === 'personState') return { token: 'fresh-person', personTookOver: false };
    if (method === 'click') { assert.equal(params.personToken, 'fresh-person'); return { window, delivery: 'sent-unverified' }; }
    assert.fail(method);
  } };
  const safety = createMacSafety({ driver, readReuse, inputRegistrar: await prepareMacInputRegistrar(driver, 'b'.repeat(64)),
    lease: { acquire: () => 'lease', renew() { calls.push({ method: 'renew' }); }, release() {}, close() {} },
    approve: async () => true, policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/host' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false } });
  safety.setPolicy({ observe() {}, beforeAction: async action => { calls.push({ method: 'policy' }); return { args: action.args }; },
    checkPause() { calls.push({ method: 'pause' }); }, reset() {} });
  t.after(() => safety.close());
  const first = await safety.request('getApp', { selector: 'Fixture' });
  const snapshot = reads.read(first); reads.endCell([{ type: 'text', text }], [snapshot]);
  const context = { cell: 'cell', observe: row => reads.read(row),
    beforeRequest: (method, params) => reads.assertCurrent(method, params, 'cell'), fullTree: params => reads.fullTree(params) };
  return { safety, calls, first, reads, context, params: () => ({ windowId: '42', processStart: '1.0', readId, args: [1] }) };
}

for (const enabled of [false, true]) test(`parent before-action reuse=${enabled} preserves person, policy, Pause and lease checks`, async t => {
  const h = await fixture(t, enabled); h.calls.length = 0;
  await h.safety.request('click', h.params(), h.context);
  assert.deepEqual(h.calls.map(row => row.method), ['renew', 'verifyWindowIdentity', 'renew', 'getAXState', 'personState', 'policy', 'renew', 'pause', 'click']);
  const params = h.calls.find(row => row.method === 'getAXState').params;
  assert.equal(params.reuseIfUnchanged, enabled ? h.first.readId : undefined);
  await assert.rejects(h.safety.request('getAXState', { windowId: '42', processStart: '1.0', reuseIfUnchanged: 1 }), { code: 'INVALID_PARAMS' });
});

test('endTurn clears the parent reuse candidate and old delivered numbers', async t => {
  const h = await fixture(t, true); h.safety.endTurn(); h.reads.endTurn();
  await assert.rejects(h.safety.request('click', h.params(), h.context), { code: 'STALE_READ' });
  const next = await h.safety.request('getApp', { selector: 'Fixture' });
  assert.equal(h.calls.filter(row => row.method === 'getAXState').at(-1).params.reuseIfUnchanged, 0);
  assert.ok(next.readId > h.first.readId);
});

test('read reuse is enabled by default and the action consumes the delivered candidate', async t => {
  const saved = process.env.SLEIGHT_GLIDE_READ_REUSE;
  delete process.env.SLEIGHT_GLIDE_READ_REUSE;
  t.after(() => { if (saved === undefined) delete process.env.SLEIGHT_GLIDE_READ_REUSE; else process.env.SLEIGHT_GLIDE_READ_REUSE = saved; });
  const h = await fixture(t, undefined); h.calls.length = 0;
  await h.safety.request('click', h.params(), h.context);
  assert.equal(h.calls.find(row => row.method === 'getAXState').params.reuseIfUnchanged, h.first.readId);
  h.calls.length = 0;
  await h.safety.request('click', h.params(), h.context);
  assert.equal(h.calls.find(row => row.method === 'getAXState').params.reuseIfUnchanged, undefined);
});

test('the explicit environment opt-out still disables reuse', async t => {
  const saved = process.env.SLEIGHT_GLIDE_READ_REUSE;
  process.env.SLEIGHT_GLIDE_READ_REUSE = '0';
  t.after(() => { if (saved === undefined) delete process.env.SLEIGHT_GLIDE_READ_REUSE; else process.env.SLEIGHT_GLIDE_READ_REUSE = saved; });
  const h = await fixture(t, undefined); h.calls.length = 0;
  await h.safety.request('click', h.params(), h.context);
  assert.equal(h.calls.find(row => row.method === 'getAXState').params.reuseIfUnchanged, undefined);
});

test('combined capture walks and clears the earlier standalone AX reuse candidate', async t => {
  const h = await fixture(t, true);
  const combined = await h.safety.request('getAXStateAndScreenshot', { windowId: '42', processStart: '1.0' });
  assert.equal(h.calls.find(row => row.method === 'getAXStateAndScreenshot').params.reuseIfUnchanged, undefined);
  const snapshot = h.reads.read(combined); h.reads.endCell([{ type: 'text', text: combined.text }], [snapshot]);
  h.calls.length = 0;
  await h.safety.request('click', h.params(), h.context);
  assert.equal(h.calls.find(row => row.method === 'getAXState').params.reuseIfUnchanged, undefined);
});
