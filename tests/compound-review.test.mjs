import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compoundFixture, compoundTestNode } from './fixtures/compound-runtime.mjs';
import { createCompoundParent } from '../plugins/sleight/lib/mac-driver/compound/parent.mjs';
import { classifyCompoundTarget, compoundLabelBoundary, normalizeCompoundLabel } from '../plugins/sleight/lib/mac-driver/compound/boundary.mjs';

const families = ['Pay', 'Confirm', 'Submit', 'Send', 'Transfer', 'Order', 'Book', 'Buy', 'Delete', 'Sign-in', 'Sign_up',
  'Security', 'Privacy', 'Consent', 'Create account', 'Checkout', 'Subscribe', 'Purchase', 'Allow', 'Overwrite', 'Keep Both', 'Account', 'Secure', 'Credit card'];
for (const label of families) test(`boundary family ${label} cannot be downgraded by provider.classify`, async () => {
  for (const [operation, token, field] of [['menu', 'edit', 'help'], ['menu', 'edit', 'value'], ['choose', 'control', 'description'],
    ['choose', 'coast', 'title'], ['prepareSaveAs', 'directory', 'help']]) {
    const h = compoundFixture(operation); h.node(token)[field] = label;
    if (token === 'coast') h.intent.option.label = label;
    const r = await h.run(); assert.equal(r.stop?.reason, 'BOUNDARY_REQUIRED', JSON.stringify(r));
    assert.equal(h.mutations.length, token === 'coast' ? 1 : 0);
  }
});
for (const [raw, canonical] of [['ＣＯＮＦＩＲＭ', 'confirm'], ['Con\u200bfirm', 'confirm'], ['SİGN_IN', 'sign in'],
  ['Sіgn-in', 'sign in'], ['DéLéTe', 'delete'], ['sign\u2212up', 'sign up'], ['CONFIRM', 'confirm']])
  test(`boundary normalization ${JSON.stringify(raw)}`, () => {
    assert.equal(normalizeCompoundLabel(raw), canonical); assert.equal(compoundLabelBoundary(raw), 'boundary');
  });
for (const raw of ['Confirmer', 'Comprar', 'Überweisen', 'Conferma', '確認', '確認する', '付款', '결제'])
  test(`localized boundary ${raw}`, () => { assert.equal(compoundLabelBoundary(raw), 'boundary'); });
for (const raw of [null, '', '\ud800']) test(`unclassifiable target ${JSON.stringify(raw)} stops`, async () => {
  const h = compoundFixture('choose'); h.node('control').title = raw; h.node('control').value = null;
  assert.equal(classifyCompoundTarget({ transition: { kind: 'choose.open', node: h.node('control') } }), 'unknown');
  const r = await h.run(); assert.ok(['BOUNDARY_REQUIRED', 'OBSERVATION_INCOMPLETE'].includes(r.stop?.reason));
  assert.equal(h.mutations.length, 0);
});
test('save opener and fields use real target labels while typed Pay.txt remains data', async () => {
  const h = compoundFixture('prepareSaveAs'); h.intent.destination = '/fixtures/project/Pay.txt';
  h.snapshot.nodes = [h.node('root'), compoundTestNode('opener', 'root', 'AXMenuItem', 'Save As…', { help: 'Send' })];
  delete h.snapshot.panel; delete h.snapshot.domains.panel; h.snapshot.relations = []; h.snapshot.saveOpener = 'opener';
  const r = await h.run(); assert.equal(r.stop?.reason, 'BOUNDARY_REQUIRED'); assert.equal(h.mutations.length, 0);
});
test('execute reclassifies the actual node after provider classification changes', async () => {
  const h = compoundFixture('choose'); let calls = 0;
  h.provider.classify = async () => ++calls === 1 ? 'local' : 'unknown';
  const r = await h.run(); assert.equal(r.stop?.reason, 'BOUNDARY_REQUIRED'); assert.equal(h.mutations.length, 0);
});
test('admission.consume is required before any parent can be constructed', () => {
  const h = compoundFixture(); delete h.admission.consume;
  assert.throws(() => createCompoundParent({ admission: h.admission }), { code: 'FLOW_REFUSED' });
  assert.equal(h.mutations.length, 0);
});
test('a refused consume cannot send the first primitive', async () => {
  const h = compoundFixture(); h.admission.consume = () => false;
  const r = await h.run(); assert.equal(r.stop?.reason, 'FLOW_REFUSED'); assert.equal(h.mutations.length, 0);
});
test('a plain authority object cannot impersonate a parent service snapshot', async () => {
  const h = compoundFixture(); h.admission.current = () => h.auth;
  const r = await h.run(); assert.equal(r.stop?.reason, 'AUTHORITY_CHANGED'); assert.equal(h.mutations.length, 0);
});
for (const [name, change] of [['epoch', h => { h.auth.generation++; }], ['lease token', h => { h.auth.lease.token = 'B'; }],
  ['approval scope', h => { h.auth.approvalScope.binding.document = 'B'; }]])
  test(`cached authority snapshot fails verification after ${name} changes`, async () => {
    const h = compoundFixture(); let cached;
    h.admission.current = () => { cached ??= h.authority.snapshot(); return cached; };
    h.on('admit', change);
    const r = await h.run(); assert.equal(r.stop?.reason, 'AUTHORITY_CHANGED'); assert.equal(h.mutations.length, 0);
  });
test('authority verification re-samples a service with a mutating getter', async () => {
  const h = compoundFixture(); let reads = 0;
  Object.defineProperty(h.auth, 'generation', { enumerable: true, get() { return ++reads; } });
  const r = await h.run(); assert.equal(r.stop?.reason, 'AUTHORITY_CHANGED'); assert.equal(h.mutations.length, 0);
  assert.ok(reads >= 2); assert.equal(h.counts.get('reserve') ?? 0, 0);
});
test('dispatch person re-sample prevents input arriving during consume', async () => {
  const h = compoundFixture(); h.admission.consume = () => { h.sequence++; h.lastInput = 1; return true; };
  const r = await h.run(); assert.equal(r.stop?.reason, 'PERSON_TOOK_OVER'); assert.equal(h.mutations.length, 0);
});
test('dispatch authority revalidation prevents revocation after consume', async () => {
  const h = compoundFixture(); h.on('before-input', x => { x.auth.approved = false; });
  const r = await h.run(); assert.equal(r.stop?.reason, 'APP_DECLINED'); assert.equal(h.mutations.length, 0);
});
test('production helper provider accesses equal the closed capability set', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/mac-driver/compound/helper.mjs', import.meta.url), 'utf8');
  // Also forbid computed, aliased and reflective escapes. This examines the
  // production call sites, so an added provider.activate() fails this test.
  assert.doesNotMatch(source, /provider\s*\[|(?:Reflect\.|Object\.(?:values|entries|assign))\([^\n]*provider|=\s*provider\s*[;,]/);
  const used = [...source.matchAll(/\bprovider(?:\?\.)?\.?(\w+)\s*(?:\?\.)?\(/g)].map(m => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ['classify', 'inventory', 'mechanism', 'perform', 'person', 'phase', 'read',
    'resolveDelivered', 'retire', 'settle'].sort());
});
