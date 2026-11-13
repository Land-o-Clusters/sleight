import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDragViaDriver } from '../plugins/sleight/lib/drag-via-driver.mjs';

const source = { windowId: '11', processStart: '7:100', pid: 7, bundleId: 'org.sleight.Editor',
  app: 'Editor', title: '11.txt', identityVerified: true };
const destination = { ...source, windowId: '22', title: '22.txt' };
const request = { app: source.bundleId, windowId: 11, from: [20, 40], to: [120, 40] };

function harness({ result = { ok: true, path: 'background', windowId: 11, deliveryVerified: false },
  bindings = { source }, verify, execute, resolve, current = () => {} } = {}) {
  const calls = [];
  const driver = { resolveApp: async selector => {
    calls.push(['resolve', selector]);
    return resolve ? resolve(selector) : { app: { id: source.bundleId, pid: source.pid, processStart: source.processStart, running: true } };
  }, verifyWindowIdentity: async (windowId, options) => {
    calls.push(['verify', windowId, options]);
    return verify ? verify(windowId, options, calls) : { window: structuredClone(windowId === '11' ? source : destination) };
  } };
  const runLocal = async (...args) => { calls.push(['run', ...args]); return execute ? execute(...args) : result; };
  const run = createDragViaDriver({ driver, runLocal, bindings: async args => {
    calls.push(['bindings', args]); return bindings;
  }, current });
  return { run, calls, driver, result };
}

test('construction is inert and delegates other local tools and cleanup unchanged', async () => {
  const h = harness(); assert.deepEqual(h.calls, []);
  const options = { cleanup: true }, args = { op: 'restore' };
  assert.strictEqual(await h.run('drag-focus.js', args, options), h.result);
  assert.deepEqual(h.calls, [['run', 'drag-focus.js', args, options]]);
});

test('missing dependencies refuse without constructing or launching a driver', () => {
  for (const options of [undefined, {}, { driver: {} }, { driver: { verifyWindowIdentity() {} }, runLocal() {}, bindings() {} }]) {
    assert.throws(() => createDragViaDriver(options), error => error.code === 'INVALID_PARAMS');
  }
  assert.throws(() => createDragViaDriver({ driver: { verifyWindowIdentity() {}, resolveApp() {} }, runLocal() {}, bindings() {} }),
    error => error.code === 'INVALID_PARAMS', 'the parent must supply its revocation check explicitly');
});

test('one drag checks its driver binding before and after the unchanged local executor', async () => {
  const h = harness();
  assert.strictEqual(await h.run('drag.js', request), h.result);
  assert.deepEqual(h.calls.map(call => call[0]), ['bindings', 'resolve', 'verify', 'run', 'verify']);
  assert.deepEqual(h.calls[1], ['resolve', request.app]);
  assert.deepEqual(h.calls[2], ['verify', '11', { processStart: source.processStart }]);
  assert.deepEqual(h.calls[3].slice(0, 3), ['run', 'drag.js', request]);
  assert.equal(typeof h.calls[3][3].run, 'function');
});

test('cross-window drag validates both bindings and preserves every request field', async () => {
  const args = { ...request, toWindowId: 22, from: 'the current text selection', to: 'end of line 2',
    elementLines: { 7: 'text Billing' }, elementWindow: { windowId: 11, title: '11.txt' },
    toElementLines: { 8: 'text Security' }, toElementWindow: { windowId: 22, title: '22.txt' },
    screenshots: { '11.txt': [1200, 800] }, screenshotsByWindow: { 22: [1600, 1000] },
    holdMs: 0, steps: 1, settleMs: 0, dp2: false, dp7: false };
  const result = { ok: true, path: 'accessibility', windowId: 11, toWindowId: 22, textChanged: true, deliveryVerified: true };
  const h = harness({ bindings: { source, destination }, result });
  assert.strictEqual(await h.run('drag.js', args), result);
  assert.deepEqual(h.calls.map(call => call[0]), ['bindings', 'resolve', 'verify', 'verify', 'run', 'verify', 'verify']);
  assert.deepEqual(h.calls.find(call => call[0] === 'run')[2], args);
});

test('missing windowId stays missing for the guarded script selectors', async () => {
  const h = harness(); const { windowId: _, ...args } = request;
  await h.run('drag.js', args);
  assert.equal(Object.hasOwn(h.calls.find(call => call[0] === 'run')[2], 'windowId'), false);
});

test('malformed, stale and mismatched parent bindings cannot start the executor', async () => {
  for (const bindings of [null, {}, { source: null }, { source: { ...source, windowId: 11 } },
    { source: { ...source, pid: 0 } }, { source: { ...source, processStart: '' } },
    { source: { ...source, identityVerified: false } }, { source: { ...source, windowId: '22' } },
    { source, destination }, { source: { ...source, bundleId: '' } }]) {
    const h = harness({ bindings });
    await assert.rejects(h.run('drag.js', request), error => error.refused === true &&
      error.delivery === 'not-sent' && error.retry === 'safe');
    assert.equal(h.calls.some(call => call[0] === 'run'), false);
  }
});

test('cross-window destination must be distinct and in the same process and app', async () => {
  for (const binding of [undefined, source, { ...destination, pid: 8 }, { ...destination, processStart: '7:101' },
    { ...destination, bundleId: 'org.sleight.Other' }, { ...destination, windowId: '33' }]) {
    const h = harness({ bindings: { source, destination: binding } });
    await assert.rejects(h.run('drag.js', { ...request, toWindowId: 22 }), error => error.refused === true);
    assert.equal(h.calls.some(call => call[0] === 'run'), false);
  }
});

test('fresh driver metadata must match the exact retained identity', async () => {
  for (const change of [{ windowId: '22' }, { pid: 8 }, { processStart: '7:101' }, { bundleId: 'org.sleight.Other' },
    { title: 'replacement.txt' }, { identityVerified: false }]) {
    const h = harness({ verify: () => ({ window: { ...source, ...change } }) });
    await assert.rejects(h.run('drag.js', request), error => error.code === 'IDENTITY_CHANGED' && error.refused === true);
    assert.equal(h.calls.some(call => call[0] === 'run'), false);
  }
});

test('the request selector cannot borrow another app or process binding', async () => {
  for (const change of [{ id: 'org.sleight.Other' }, { pid: 8 }, { processStart: '7:101' }, { running: false }]) {
    const h = harness({ resolve: () => ({ app: { id: source.bundleId, pid: 7, processStart: source.processStart, running: true, ...change } }) });
    await assert.rejects(h.run('drag.js', request), error => error.code === 'IDENTITY_CHANGED' && error.refused === true);
    assert.equal(h.calls.some(call => call[0] === 'run'), false);
  }
});

test('an app without a bundle ID binds by its resolved process and canonical path', async () => {
  const unbundled = { ...source, bundleId: null };
  const h = harness({ bindings: { source: unbundled }, verify: () => ({ window: unbundled }),
    resolve: () => ({ app: { id: '/Applications/NativeEditor.app', pid: 7, processStart: source.processStart, running: true } }) });
  assert.strictEqual(await h.run('drag.js', { ...request, app: '/Applications/NativeEditor.app' }), h.result);
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
});

test('a stale numeric ID retains the legacy sole-window recovery only with fresh inventory proof', async () => {
  const resolved = windows => ({ app: { id: source.bundleId, pid: source.pid, processStart: source.processStart, running: true }, windows });
  const visible = { ...source, onScreen: true };
  const h = harness({ resolve: () => resolved([visible]) });
  await h.run('drag.js', { ...request, windowId: 3 });
  assert.equal(h.calls.find(call => call[0] === 'run')[2].windowId, 3, 'the script produces its original recovery note');
  for (const windows of [[], [{ ...visible, onScreen: false }], [visible, { ...visible, windowId: '22' }],
    [visible, { ...visible, windowId: '3', onScreen: false }], [{ ...visible, pid: 8 }]]) {
    const bad = harness({ resolve: () => resolved(windows) });
    await assert.rejects(bad.run('drag.js', { ...request, windowId: 3 }), error => error.refused === true);
    assert.equal(bad.calls.some(call => call[0] === 'run'), false);
  }
});

test('driver failures and revocation before dispatch never fall back to unguarded input', async () => {
  for (const code of ['SCREEN_LOCKED', 'PERSON_TOOK_OVER', 'STALE_READ', 'DRIVER_EXIT', 'DEADLINE_EXCEEDED']) {
    const h = harness({ verify: () => { throw Object.assign(new Error(code), { code, unhealthy: code === 'DRIVER_EXIT' }); } });
    await assert.rejects(h.run('drag.js', request), error => error.code === code && error.refused === true &&
      error.delivery === 'not-sent' && error.retry === 'safe');
    assert.equal(h.calls.some(call => call[0] === 'run'), false);
  }
  let checks = 0;
  const h = harness({ current: () => { if (++checks === 3) throw new Error('revoked'); } });
  await assert.rejects(h.run('drag.js', request), error => error.code === 'USER_STOPPED' &&
    error.delivery === 'not-sent' && error.retry === 'safe');
  assert.equal(h.calls.some(call => call[0] === 'run'), false);
});

test('request and binding snapshots cannot change while driver admission awaits', async () => {
  const args = structuredClone(request), bound = structuredClone(source);
  const h = harness({ bindings: { source: bound }, verify: () => {
    args.to[0] = 999; bound.pid = 9;
    return { window: source };
  } });
  await h.run('drag.js', args);
  assert.deepEqual(h.calls.find(call => call[0] === 'run')[2].to, request.to);
});

test('a local executor exception stays uncertain and is never retried', async () => {
  const failure = new Error('lost child reply');
  const h = harness({ execute: () => { throw failure; } });
  await assert.rejects(h.run('drag.js', request), error => !error.refused &&
    error.delivery === 'unknown' && error.retry === 'read-first');
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
});

test('frozen errors and non-Error failures retain the pre-dispatch refusal boundary', async () => {
  for (const error of [Object.freeze(Object.assign(new Error('stale'), { code: 'IDENTITY_CHANGED' })),
    Object.freeze({ code: 'SCREEN_LOCKED', message: 'locked' }), 'lost verifier']) {
    const h = harness({ verify: () => { throw error; } });
    await assert.rejects(h.run('drag.js', request), value => value.refused === true && value.delivery === 'not-sent');
    assert.equal(h.calls.some(call => call[0] === 'run'), false);
  }
});

test('lost post-action identity cannot report a verified move or trigger another drag', async () => {
  let verifications = 0;
  const h = harness({ result: { ok: true, path: 'accessibility', windowId: 11, deliveryVerified: true, textChanged: true },
    verify: () => { if (++verifications > 1) throw Object.assign(new Error('gone'), { code: 'IDENTITY_CHANGED' }); return { window: source }; } });
  const result = await h.run('drag.js', request);
  assert.equal(result.ok, false); assert.equal(result.path, 'accessibility');
  assert.equal(result.deliveryVerified, false); assert.equal(result.delivery, 'unknown');
  assert.equal(result.retry, 'read-first'); assert.equal(result.code, 'IDENTITY_CHANGED');
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
});

test('a legacy refusal is returned untouched without speculative reads or retries', async () => {
  for (const path of ['none', 'background', 'foreground', 'accessibility']) {
    const result = { ok: false, path, error: 'original refusal', lostText: true, deliveryVerified: false };
    const h = harness({ result });
    assert.strictEqual(await h.run('drag.js', request), result);
    assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
    assert.equal(h.calls.filter(call => call[0] === 'verify').length, 1);
  }
});

test('malformed and mismatched success replies cannot be accepted as delivery proof', async () => {
  for (const result of [null, {}, 'ok', { ok: true, windowId: 22, path: 'background' },
    { ok: true, windowId: 11, toWindowId: 22, path: 'accessibility' }]) {
    const h = harness({ result });
    const reply = await h.run('drag.js', request);
    assert.equal(reply.ok, false); assert.equal(reply.deliveryVerified, false);
    assert.equal(reply.delivery, 'unknown'); assert.equal(reply.retry, 'read-first');
    assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
  }
});
