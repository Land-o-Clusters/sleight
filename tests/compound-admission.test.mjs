import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { createMacSafety, macLeaseTarget } from '../plugins/sleight/lib/mac-safety.mjs';
import { DRIVER_ACTION_METHODS, DRIVER_CORE_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { createCompoundParent, createRuntimeCompoundAdmission } from '../plugins/sleight/lib/mac-driver/compound/parent.mjs';
import { createCompoundReservation } from '../plugins/sleight/lib/mac-driver/compound/reservation.mjs';
import { createCompoundFlowBridge } from '../plugins/sleight/lib/mac-driver/compound/flow.mjs';
import { compoundFixture, compoundTestBinding } from './fixtures/compound-runtime.mjs';

function safetyFixture(options = {}) {
  const calls = [], cards = [], titles = [];
  const window = { ...compoundTestBinding, bundleId: options.bundleId ?? compoundTestBinding.bundleId,
    app: 'Fixture', title: 'Draft', identityVerified: true,
    bounds: { x: 0, y: 0, width: 100, height: 100 } };
  const h = { approved: true, blocked: false, siteLimited: false, reads: 0, window, calls, cards, titles };
  h.safety = createMacSafety({ driver: { async request(method) {
    calls.push(method);
    if (method === 'resolveApp') return { app: { id: window.bundleId, name: 'Fixture', pid: window.pid,
      processStart: window.processStart, path: '/Applications/Fixture.app' }, windows: [window] };
    if (method === 'verifyWindowIdentity') return { window: structuredClone(h.window) };
    if (method === 'getAXState') { h.reads++; return { window: structuredClone(h.window), readId: h.reads,
      text: 'Window: "Draft", App: Fixture.\n0 standard window Draft' }; }
    assert.fail('unexpected fake driver method ' + method);
  } }, lease: { acquire: () => 'owned', renew() {}, release() {}, close() {} },
  approve: async request => { cards.push(request); return h.approved; },
  policy: (_id, _ancestors, title) => { titles.push(title); return options.forbidden ?
    { allow: false, code: 'FORBIDDEN_TARGET' } : { allow: true }; },
  targetParents: () => [1], ancestry: () => [{ pid: 999, path: '/Applications/OtherHost.app/Contents/MacOS/OtherHost' }],
  permissions: { app: () => h.blocked ? 'blocked' : undefined, page() {}, sitesLimited: () => h.siteLimited },
  approvalScope: options.scope ?? 'session' });
  return h;
}
test('real production admission refuses every compound method and input primitive before helper access', async () => {
  const h = safetyFixture(), fake = compoundFixture();
  const parent = createCompoundParent({ admission: createRuntimeCompoundAdmission({ safety: h.safety }),
    provider: fake.provider, reservation: fake.reservation, contracts: fake.contracts });
  const result = await parent.run(fake.intent, compoundTestBinding);
  assert.equal(result.stop.reason, 'METHOD_NOT_FOUND'); assert.equal(h.calls.length, 0);
  assert.equal(fake.calls.length, 0); assert.equal(fake.mutations.length, 0);
  for (const method of [...DRIVER_ACTION_METHODS, 'compoundBegin', 'compoundPrepare', 'compoundAdmit', 'compoundExecute',
    'compoundAcknowledge', 'menu', 'choose', 'prepareSaveAs'])
    await assert.rejects(h.safety.request(method, {}), { code: 'METHOD_NOT_FOUND' });
  assert.equal(h.calls.length, 0); assert.equal(h.cards.length, 0);
  assert.ok(DRIVER_CORE_METHODS.every(m => !/compound|menu|choose|SaveAs/.test(m)));
});
test('native production registrar remains closed even though inert compound source composes', async () => {
  const source = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverMain.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /registerCompound|compoundBegin|compoundExecute|registerPointer|registerKeyboard|registerSemantic/);
});
for (const scope of ['once', 'document', 'session']) test(`real approval seam preserves ${scope} scope during fake-only compound reads`, async () => {
  const real = safetyFixture({ scope }), fake = compoundFixture();
  await real.safety.request('getApp', { selector: 'Fixture' });
  fake.admission.authorizeRead = async () => {
    await real.safety.request('getAXState', { windowId: '42', processStart: 'start-1' }); return true;
  };
  const result = await fake.run(); assert.equal(result.state, 'completed'); assert.equal(fake.mutations.length, 3);
  assert.equal(real.reads, 10); assert.equal(real.cards.length, scope === 'once' ? 10 : 1);
  // This test layers actual read admission over an isolated fake mutation sink.
  // The real action seam remains closed for the entire run.
  await assert.rejects(real.safety.request('click', {}), { code: 'METHOD_NOT_FOUND' });
});
test('actual once-approval revocation while settling stops before the next internal content read', async () => {
  const real = safetyFixture({ scope: 'once' }), fake = compoundFixture();
  await real.safety.request('getApp', { selector: 'Fixture' });
  fake.admission.authorizeRead = async () => {
    await real.safety.request('getAXState', { windowId: '42', processStart: 'start-1' }); return true;
  };
  fake.on('settle', () => { real.approved = false; });
  const r = await fake.run(); assert.equal(r.stop.reason, 'APP_DECLINED'); assert.equal(fake.mutations.length, 1);
  assert.equal(real.reads, 3); assert.equal(r.observation.status, 'unavailable'); assert.equal(fake.invalidated, true);
});
for (const [name, configure, reason] of [
  ['changed bundle identity', h => { h.window.bundleId = 'com.apple.Terminal'; }, 'IDENTITY_CHANGED'],
  ['unknown site', h => { h.siteLimited = true; }, 'SITE_UNPROVEN'],
  ['revoked acquisition', h => h.safety.revoke([compoundTestBinding.bundleId]), 'APP_NOT_ACQUIRED'],
  ['ended cell', h => h.safety.endTurn(), 'APP_NOT_ACQUIRED'],
  ['blocked app', h => { h.blocked = true; }, 'APP_BLOCKED'],
]) test(`real admission stops ${name} before a fake compound primitive`, async () => {
  const real = safetyFixture(), fake = compoundFixture();
  await real.safety.request('getApp', { selector: 'Fixture' }); configure(real);
  fake.admission.authorizeRead = async () => {
    await real.safety.request('getAXState', { windowId: '42', processStart: 'start-1' }); return true;
  };
  const r = await fake.run(); assert.equal(r.stop.reason, reason); assert.equal(fake.mutations.length, 0);
});
test('real admission stops forbidden app before acquisition or a fake compound primitive', async () => {
  const real = safetyFixture({ bundleId: 'com.apple.Terminal' }), fake = compoundFixture();
  fake.admission.authorizeRead = async () => {
    await real.safety.request('getApp', { selector: 'Fixture' }); return true;
  };
  const r = await fake.run();
  assert.equal(r.stop.reason, 'FORBIDDEN_TARGET'); assert.equal(fake.mutations.length, 0);
  assert.equal(real.reads, 0); assert.equal(real.cards.length, 0);
  assert.deepEqual(real.calls, ['resolveApp']);
});
test('real flow-rule analyzer receives each actual internal string, including intermediate provenance', async () => {
  const rules = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'report\\.txt', destinations: ['*'] }] }, { browsers: [] });
  const h = compoundFixture('prepareSaveAs');
  const bridge = createCompoundFlowBridge({ rules, formatObservation: () => ({ content: [{ type: 'text',
    text: 'Window: "Draft", App: test.compound.App.\n0 standard window Draft' }] }) });
  h.admission.admit = async request => bridge.analyze(request);
  h.admission.consume = witness => bridge.consume(witness);
  h.admission.observe = async request => bridge.observe(request);
  const r = await h.run(); assert.equal(r.stop.reason, 'FLOW_REFUSED'); assert.equal(h.mutations.length, 1);
  assert.equal(h.mutations[0].value, '/fixtures/project');
});
test('real flow source provenance from an internal observation refuses the next value', async () => {
  const rules = new FlowRules({ version: 1, rules: [{ id: 'source', kind: 'source', sources: ['test.compound.App'], destinations: ['*'] }] }, { browsers: [] });
  const h = compoundFixture('prepareSaveAs');
  const bridge = createCompoundFlowBridge({ rules, formatObservation: () => ({ content: [{ type: 'text',
    text: 'Window: "Draft", App: test.compound.App.\n0 standard window Draft\n1 text report.txt' }] }) });
  h.admission.admit = async request => bridge.analyze(request);
  h.admission.consume = witness => bridge.consume(witness);
  h.admission.observe = async request => bridge.observe(request);
  const r = await h.run(); assert.equal(r.stop.reason, 'FLOW_REFUSED'); assert.equal(h.mutations.length, 1);
  assert.equal(r.steps[0].effectObserved, true); assert.equal(r.steps[1].effectObserved, true); assert.equal(r.steps[2].attempts, 0);
});

function fenceService() {
  const held = new Map(), retired = new Set();
  return {
    acquire(record) { if (held.has(record.bundleId)) return undefined; held.set(record.bundleId, record); return record; },
    validate(record, execution) { return held.get(record.bundleId) === record && record.execution === execution && !retired.has(execution); },
    dispatched(record) { record.outstanding = true; }, acknowledged(record) { record.outstanding = false; },
    confirmRetirement(execution) { retired.add(execution); }, retired(_record, execution) { return retired.has(execution); },
    release(record, execution, proof) {
      assert.ok(proof.neverDispatched || retired.has(execution)); assert.equal(held.get(record.bundleId), record); held.delete(record.bundleId);
    },
  };
}
test('real lease adapter reserves app scope and fences an expired, delayed writer until retirement', async t => {
  const directory = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-compound-leases-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1000;
  const a = new InputLease({ directory, holder: 'fixture-a', now: () => now }), b = new InputLease({ directory, holder: 'fixture-b', now: () => now });
  t.after(() => { a.close(); b.close(); });
  const documentA = a.acquireGrant(macLeaseTarget(compoundTestBinding)), fence = fenceService();
  const first = createCompoundReservation({ lease: a, documentGrant: documentA, fence });
  const one = first.acquire(compoundTestBinding, 'one', 31000); first.dispatched(one, 'one');
  assert.throws(() => b.acquireGrant(macLeaseTarget({ ...compoundTestBinding, windowId: '43' })));
  now = 40000;
  const documentB = b.acquireGrant(macLeaseTarget({ ...compoundTestBinding, windowId: '43' }));
  const second = createCompoundReservation({ lease: b, documentGrant: documentB, fence });
  assert.throws(() => second.acquire({ ...compoundTestBinding, windowId: '43' }, 'two', 70000), { code: 'LEASE_REFUSED' });
  assert.throws(() => first.validate(one, 'one')); assert.throws(() => first.release(one, 'one'), { code: 'LEASE_REFUSED' });
  fence.confirmRetirement('one'); first.release(one, 'one');
  const two = second.acquire({ ...compoundTestBinding, windowId: '43' }, 'two', 70000);
  assert.equal(second.validate(two, 'two'), true);
  fence.confirmRetirement('two'); second.release(two, 'two');
  assert.equal(b.inspect(documentB.key).expires > now, true, 'document lease remains held throughout app upgrade and release');
});
test('two parent sessions cannot replace an expired writer while its fake OS input is blocked', async t => {
  const directory = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-compound-blocked-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = 1000, unblock, started, firstExecution;
  const entered = new Promise(resolve => { started = resolve; }), blocked = new Promise(resolve => { unblock = resolve; });
  const a = new InputLease({ directory, holder: 'parent-a', now: () => time }), b = new InputLease({ directory, holder: 'parent-b', now: () => time });
  t.after(() => { a.close(); b.close(); });
  const fence = fenceService(), documentA = a.acquireGrant(macLeaseTarget(compoundTestBinding));
  const adapterA = createCompoundReservation({ lease: a, documentGrant: documentA, fence });
  const first = compoundFixture(); first.auth.lease = { ...documentA, live: true, fenced: true };
  const retirement = first.provider.retire;
  first.provider.retire = async () => { const done = await retirement(); if (done) fence.confirmRetirement(firstExecution); return done; };
  first.on('perform', async () => { started(); await blocked; });
  first.parent = createCompoundParent({ admission: first.admission, provider: first.provider, contracts: first.contracts,
    now: () => time, reservation: { ...adapterA, acquire(...args) { firstExecution = args[1]; return adapterA.acquire(...args); } } });
  const pending = first.run(); t.after(() => unblock()); await entered;
  assert.equal(first.mutations.length, 0, 'the admitted fake OS call has not mutated yet');
  time = 40000; first.time = time;
  const secondBinding = { ...compoundTestBinding, windowId: '43' }, documentB = b.acquireGrant(macLeaseTarget(secondBinding));
  const adapterB = createCompoundReservation({ lease: b, documentGrant: documentB, fence });
  const second = compoundFixture(); second.time = time; second.auth.lease = { ...documentB, live: true, fenced: true };
  second.auth.approvalScope.binding = secondBinding; second.snapshot.binding = { ...secondBinding };
  const parentB = createCompoundParent({ admission: second.admission, provider: second.provider, contracts: second.contracts,
    now: () => time, reservation: adapterB });
  const denied = await parentB.run(second.intent, secondBinding);
  assert.equal(denied.stop?.reason, 'LEASE_REFUSED'); assert.equal(second.mutations.length, 0);
  unblock(); const result = await pending;
  assert.equal(result.stop.reason, 'DEADLINE_EXCEEDED'); assert.equal(result.state, 'uncertain');
  assert.equal(first.mutations.length, 1); assert.equal(result.steps[1].attempts, 0); assert.equal(result.transportRetired, true);
  const replacement = adapterB.acquire(secondBinding, 'replacement-after-retirement', 70000);
  assert.equal(adapterB.validate(replacement, 'replacement-after-retirement'), true);
  fence.confirmRetirement('replacement-after-retirement'); adapterB.release(replacement, 'replacement-after-retirement');
});
