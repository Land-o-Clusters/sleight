import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const api = await import('../plugins/sleight/lib/direct-browser/trusted-dom.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
test('authority reads adopt the exact pinned node into Playwright utility world', async () => {
  assert.equal(typeof api.trustedRead, 'function');
  const node = {}, document = {}, calls = [];
  const utility = { world: 'utility', async evaluateExpression(source, options, args) {
    calls.push({ source, options, args }); return 'native evidence';
  } };
  const impl = { _frame: { utilityContext: async () => utility } };
  const handle = { _connection: { toImpl(value) { assert.equal(value, handle); return impl; } },
    evaluate() { assert.fail('MAIN world must never supply authority'); } };
  assert.equal(await api.trustedRead(handle, function nativeReader(el, doc) { return el.ownerDocument === doc; }, document), 'native evidence');
  assert.deepEqual(calls[0].args, [impl, document]);
  assert.equal(calls[0].options.isFunction, true);
  assert.match(calls[0].source, /nativeReader/);
  assert.notEqual(node, impl);
});
test('unavailable or non-utility execution refuses without a MAIN-world fallback', async () => {
  assert.equal(typeof api.trustedRead, 'function');
  for (const handle of [{}, { _connection: { toImpl: () => ({ _frame: { utilityContext: async () => ({ world: 'main' }) } }) } }])
    await assert.rejects(api.trustedRead(handle, el => el.form), /TRUSTED_DOM_REQUIRED/);
});
test('trusted handles pass stack coordinates only to the utility world', async () => {
  const point = { x: 70, y: 50 }, result = {}, node = { _frame: { utilityContext: async () => ({
    world: 'utility', evaluateExpressionHandle(source, options, args) {
      assert.deepEqual(args, [node, point]); assert.equal(options.isFunction, true); return result;
    }, evaluateExpression() {},
  }) } };
  const handle = { _connection: { toImpl: () => node } };
  assert.equal(await api.trustedHandle(handle, (el, point) => [el, point], point), result);
});
test('all context authority readers and action risk/fingerprints use the trusted boundary', () => {
  const base = new URL('../plugins/sleight/lib/direct-browser/', import.meta.url);
  const context = readFileSync(new URL('v3-context.mjs', base), 'utf8');
  for (const name of ['focusCheckedNode','readPaymentPage','inspectElement','samePageDocument','ownDocument'])
    assert.doesNotMatch(context, new RegExp('\\.evaluate(?:Handle)?\\(' + name), name);
  const action = readFileSync(new URL('act.mjs', base), 'utf8');
  assert.doesNotMatch(action, /\.evaluate\(inspectTarget/);
});


test('a delegate without a separate utility world cannot supply trusted evidence', async () => {
  const impl = { _frame: { _page: { delegate: { noUtilityWorld: () => true } },
    utilityContext: async () => ({ world: 'utility', evaluateExpression: () => assert.fail('MAIN context must not run') }) } };
  const handle = { _connection: { toImpl: () => impl } };
  await assert.rejects(api.trustedRead(handle, el => el.form), /TRUSTED_DOM_REQUIRED/);
});
