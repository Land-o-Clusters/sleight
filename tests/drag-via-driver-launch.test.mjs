import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLocalTool } from './fixtures/local-tools.mjs';
import { createDragViaDriver } from '../plugins/sleight/lib/drag-via-driver.mjs';

const source = { windowId: '11', pid: 7, processStart: '7:100', bundleId: 'org.sleight.Editor',
  app: 'Editor', title: '11.txt', identityVerified: true };
const args = { app: source.bundleId, windowId: 11, from: [20, 40], to: [120, 40] };

function harness({ result = { ok: true, path: 'background', windowId: 11, deliveryVerified: false },
  verify, execute } = {}) {
  const calls = [];
  const run = createDragViaDriver({
    current: () => {},
    driver: {
      resolveApp: async () => ({ app: { id: source.bundleId, pid: 7, processStart: source.processStart, running: true } }),
      verifyWindowIdentity: async () => { calls.push('verify'); if (verify) return verify(); return { window: source }; },
    },
    bindings: () => ({ source }),
    runLocal: async (script, request, options) => {
      calls.push([script, request, options]);
      if (script === 'drag-focus.js') return { ok: true, marker: 'focus snapshot' };
      return execute ? execute() : result;
    },
  });
  return { calls, run };
}

test('declined local-drag approval reaches neither the driver nor the executor', async () => {
  const h = harness();
  const result = await callLocalTool('drag', args, async () => false, h.run);
  assert.equal(result.isError, true); assert.deepEqual(h.calls, []);
});

test('a background runtime drag keeps focus capture and skips foreground restoration', async () => {
  const h = harness();
  const result = await callLocalTool('drag', args, async () => true, h.run);
  assert.equal(!!result.isError, false);
  assert.deepEqual(h.calls.filter(Array.isArray).map(call => call[0]), ['drag-focus.js', 'drag.js']);
});

test('driver preflight refusal does no release or restoration input', async () => {
  const h = harness({ verify: () => { throw Object.assign(new Error('stale'), { code: 'IDENTITY_CHANGED' }); } });
  const result = await callLocalTool('drag', args, async () => true, h.run);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /IDENTITY_CHANGED.*delivery=not-sent.*retry=safe/);
  assert.deepEqual(h.calls.filter(Array.isArray).map(call => call[1].op), ['capture']);
});

test('a foreground runtime result retains the original owned focus restoration', async () => {
  const h = harness({ result: { ok: true, path: 'foreground', windowId: 11 } });
  const result = await callLocalTool('drag', args, async () => true, h.run);
  assert.equal(!!result.isError, false);
  const restore = h.calls.filter(Array.isArray).at(-1);
  assert.equal(restore[0], 'drag-focus.js'); assert.equal(restore[1].op, 'restore');
  assert.equal(restore[1].marker, 'focus snapshot'); assert.deepEqual(restore[2], { cleanup: true });
});

test('an executor exception retains the launchers release and restoration cleanup without retry', async () => {
  const h = harness({ execute: () => { throw new Error('lost child reply'); } });
  const result = await callLocalTool('drag', args, async () => true, h.run);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /delivery=unknown.*retry=read-first/);
  const local = h.calls.filter(Array.isArray);
  assert.deepEqual(local.map(call => call[0]), ['drag-focus.js', 'drag.js', 'drag-focus.js', 'drag-focus.js']);
  assert.deepEqual(local.slice(-2).map(call => call[1].op), ['release', 'restore']);
  assert.ok(local.slice(-2).every(call => call[2].cleanup === true));
});

test('a successful AX move still invokes the existing optional changed-lines read exactly once', async () => {
  const h = harness({ result: { ok: true, path: 'accessibility', windowId: 11, textChanged: true, deliveryVerified: true } });
  let reads = 0;
  const result = await callLocalTool('drag', args, async () => true, h.run, undefined, undefined,
    { afterDrag: async () => { reads++; return [{ type: 'text', text: 'changed lines' }]; } });
  assert.equal(!!result.isError, false); assert.equal(reads, 1);
  assert.equal(result.content.at(-1).text, 'changed lines');
  assert.equal(h.calls.filter(call => Array.isArray(call) && call[0] === 'drag.js').length, 1);
});
