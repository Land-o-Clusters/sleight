import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { guardedCode, readCode } from '../plugins/sleight/lib/document-scope.mjs';

const expected = { title: 'Calculator', app: 'Calculator', url: null };
function fixture() {
  let title = 'Calculator', shifted = false;
  const calls = [];
  const raw = { getAXState: async options => {
    calls.push(['read', options.disableDiffing, options.emit]);
    return `Window: "${title}", App: Calculator.\n0 standard window\n1 button One\n2 button ${shifted ? 'Other' : 'Two'}`;
  }, click: async n => { calls.push(['click', n]); shifted = true; },
  typeText: async value => calls.push(['type', value]) };
  const context = createContext({ cua: { getApp: async () => raw }, nodeRepl: { write() {} } });
  return { calls, context, rename: name => { title = name; },
    run: code => runInContext(`(async () => { ${code} })()`, context) };
}

test('a compact guarded call uses fresh full reads and refuses a later window change', async () => {
  const f = fixture();
  await f.run(readCode('await cua.getApp("Calculator")'));
  const code = guardedCode('await app.typeText("x")', expected, 'window changed', undefined, { reuseSetup: true });
  assert.ok(Buffer.byteLength(code) < 2500, 'warm calls must not retransmit the guard implementation');
  await f.run(code);
  f.rename('Another window');
  await assert.rejects(f.run(code), /window changed/);
  assert.deepEqual(f.calls, [['read', true, false], ['type', 'x'], ['read', true, false], ['read', true, false]]);
});

test('a compact call still checks the next numbered action after a renumber', async () => {
  const f = fixture();
  await f.run(readCode('await cua.getApp("Calculator")'));
  await assert.rejects(f.run(guardedCode('await app.click(1); await app.click(2);', expected,
    'window changed', undefined, { reuseSetup: true })), /changed|renumber|stale/);
  assert.deepEqual(f.calls, [['read', true, false], ['click', 1], ['read', true, false]]);
});

test('missing runtime setup stops a compact call before any user code or app input', async () => {
  const f = fixture();
  await assert.rejects(f.run(guardedCode('globalThis.ran = true;', expected, 'window changed', undefined,
    { reuseSetup: true })), /guard setup.*missing/i);
  assert.equal(f.context.ran, undefined);
  assert.deepEqual(f.calls, []);
});

test('compact reads reset call observations before a later guarded call', async () => {
  const f = fixture();
  await f.run(readCode('await cua.getApp("Calculator")'));
  const code = readCode('await app.getAXState()', { reuseSetup: true });
  assert.ok(Buffer.byteLength(code) < 1000);
  await f.run(code);
  f.rename('Another window');
  await assert.rejects(f.run(guardedCode('await app.typeText("x")', expected, 'window changed', undefined,
    { reuseSetup: true })), /window changed/);
  assert.deepEqual(f.calls, [['read', true, false], ['read', true, false]]);
});
