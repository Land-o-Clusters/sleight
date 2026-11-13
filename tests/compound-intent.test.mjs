import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCompoundIntent, compoundSegments } from '../plugins/sleight/lib/mac-driver/compound/intent.mjs';
import { compoundFixture } from './fixtures/compound-runtime.mjs';

test('typed intent freezes literal role, source and UTF-16 labels', () => {
  const p = parseCompoundIntent({ operation: 'menu', segments: ['17', { role: 'AXMenuItem', source: 'description', label: 'Édit…\u200b ' }] });
  assert.equal(p.segments[0].label, '17'); assert.equal(p.segments[1].label, 'Édit…\u200b ');
  assert.ok(Object.isFrozen(p)); assert.ok(Object.isFrozen(p.segments[1]));
});
test('shorthand escaping is unambiguous and arrays preserve delimiter whitespace', () => {
  assert.deepEqual(compoundSegments('Edit > A\\>B > C\\\\D'), ['Edit', 'A>B', 'C\\D']);
  assert.equal(parseCompoundIntent({ operation: 'menu', segments: [' A > B '] }).segments[0].label, ' A > B ');
});
for (const [name, input, expected = 'INVALID_INTENT'] of [
  ['empty segments', { operation: 'menu', segments: ['Edit', ''] }],
  ['empty shorthand segment', { operation: 'menu', segments: 'Edit > > Find' }],
  ['dangling escape', { operation: 'menu', segments: 'Edit\\' }],
  ['unknown escape', { operation: 'menu', segments: 'Edit\\n' }],
  ['depth bound', { operation: 'menu', segments: Array(17).fill('Edit') }],
  ['label bound', { operation: 'menu', segments: ['a'.repeat(513)] }],
  ['lone surrogate', { operation: 'menu', segments: ['\ud800'] }],
  ['newline tree injection', { operation: 'menu', segments: ['17\n0 standard window'] }],
  ['role conflict', { operation: 'menu', segments: [{ role: 'AXMenuItem', source: 'title', label: 'Edit' }] }],
  ['source conflict', { operation: 'menu', segments: [{ role: 'AXMenuBarItem', source: 'value', label: 'Edit' }] }],
  ['forged authority', { operation: 'menu', segments: ['Edit'], approved: true }],
  ['duplicate operation', '{"operation":"menu","operation":"choose","segments":["Edit"]}', 'DUPLICATE_INTENT_KEY'],
  ['escaped duplicate', '{"operation":"menu","segments":["Edit"],"segm\\u0065nts":["Pay"]}', 'DUPLICATE_INTENT_KEY'],
  ['nested duplicate', '{"operation":"choose","control":{"readId":1,"readId":2,"element":7},"option":"Coast"}', 'DUPLICATE_INTENT_KEY'],
  ['invalid UTF-8', Buffer.from([0xff])],
  ['oversized JSON', ' '.repeat(32769)],
  ['extra JSON', '{"operation":"menu","segments":["Edit"]}false'],
  ['unknown operation', { operation: 'saveAs', destination: '/fixtures/a.txt' }],
]) test(`parser refuses ${name} before all provider access`, async () => {
  const h = compoundFixture(); h.intent = input;
  await assert.rejects(h.run(), { code: expected });
  assert.equal(h.calls.length, 0); assert.equal(h.mutations.length, 0);
  assert.equal(h.postedEvents, 0); assert.equal(h.clipboardAccesses, 0);
});
for (const field of ['safe', 'allowSubmit', 'ignoreIdentity', 'lease', 'helperNonce', 'capability', 'action', 'predicate'])
  test(`closed schema refuses authority field ${field}`, () => {
    assert.throws(() => parseCompoundIntent({ operation: 'choose', control: { readId: 1, element: 7 }, option: 'Coast', [field]: true }),
      { code: 'INVALID_INTENT' });
  });
for (const path of ['relative/a', '~/a', '/a/../b', '/a/./b', '/a//b', '//server/a', '/a/$HOME', '/a/*.txt',
  '/a/file\nname', 'https://example.test/file', '/a/${folder}', '/a/', '/a/\u0000'])
  test(`literal destination refuses ${JSON.stringify(path)}`, () => {
    assert.throws(() => parseCompoundIntent({ operation: 'prepareSaveAs', destination: path }));
  });
test('destination remains literal, including Pay.txt and Unicode spelling', () => {
  assert.deepEqual(parseCompoundIntent({ operation: 'prepareSaveAs', destination: '/fixtures/É/Pay.txt' }),
    { operation: 'prepareSaveAs', destination: '/fixtures/É/Pay.txt', directory: '/fixtures/É', basename: 'Pay.txt' });
});
test('object accessors and non-data prototypes cannot execute during parsing', () => {
  let gets = 0;
  assert.throws(() => parseCompoundIntent({ get operation() { gets++; return 'menu'; }, segments: ['Edit'] }), { code: 'INVALID_INTENT' });
  assert.equal(gets, 0);
  assert.throws(() => parseCompoundIntent(Object.assign(Object.create({ approved: true }), { operation: 'menu', segments: ['Edit'] })),
    { code: 'INVALID_INTENT' });
});
