import test from 'node:test';
import assert from 'node:assert/strict';
import { createCua } from '../plugins/sleight/lib/repl/cua.mjs';
import { formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { createMacSafety } from '../plugins/sleight/lib/mac-safety.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';

test('UC2B cua prints one wait receipt per waited action and none for quiet actions', async () => {
  const writes = [];
  const window = { windowId: '42', pid: 321, processStart: '100.25', bundleId: 'test.wait', app: 'Wait', identityVerified: true,
    onScreen: true, minimized: false, bounds: { x: 0, y: 0, width: 400, height: 300 } };
  let clicks = 0;
  const driver = { ping: async () => ({ build: 'a'.repeat(64) }), async request(method) {
    if (method === 'inputGateState') return { enabled: true };
    if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid,
      processStart: window.processStart }, windows: [window] };
    if (method === 'verifyWindowIdentity') return { window };
    if (method === 'personState') return { token: 'person-token', personTookOver: false };
    if (method === 'click') return { window, delivery: 'sent-unverified', ...++clicks === 1 ? { waitedForPersonMs: 3020 } : {} };
    return { window, text: 'Window: Wait\n0 button One', readId: 1 };
  } };
  const parent = createMacSafety({ driver, inputRegistrar: await prepareMacInputRegistrar(driver, 'a'.repeat(64)),
    lease: { acquire: () => 'lease', renew() {}, release() {}, close() {} }, approve: async () => true,
    policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 900, path: '/usr/bin/node' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false } });
  parent.setPolicy({ checkPause() {}, beforeAction: async ({ args, personToken }) => ({ args, personToken }) });
  const cua = createCua({ platform: 'darwin', write: value => writes.push(value), emitImage: () => assert.fail('no image'),
    request: (...args) => parent.request(...args) });
  const app = await cua.getApp('Wait');
  writes.length = 0;
  await app.click(0); await app.click(0);
  assert.deepEqual(writes, ['sleight waited 3020 ms for the person to pause']);
});

test('UC2B failure text reports a wait once while preserving refusal and non-delivery', () => {
  const text = formatMacDriverError({ code: 'PERSON_TOOK_OVER', delivery: 'not-sent', retry: 'safe',
    waitedForPersonMs: 8000, reason: 'person-pointer', message: 'PRIVATE' }, { action: true });
  assert.match(text, /PERSON_TOOK_OVER.*delivery=not-sent; retry=safe/);
  assert.equal(text.split('\n').filter(line => line.startsWith('sleight waited')).length, 1);
  assert.doesNotMatch(text, /PRIVATE/);
});
