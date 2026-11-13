import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMacSafety } from '../plugins/sleight/lib/mac-safety.mjs';

const base = { windowId: '1', pid: 42, processStart: '100.2', bundleId: 'test.editor', app: 'Editor',
  title: '', identityVerified: true, windowSubrole: 'AXDialog', bounds: { x: 0, y: 0, width: 500, height: 400 } };
const dialog = { ...base };
const unverified = { ...base, windowId: '2', identityVerified: false, windowSubrole: 'AXStandardWindow' };
const standard = { ...base, windowId: '3', title: 'Document', windowSubrole: 'AXStandardWindow' };
const later = { ...standard, windowId: '4', title: 'Later' };

async function acquire(factory, windows, { selected = windows[0], selector = 'Editor', verified = selected } = {}) {
  const calls = [], policyWindows = [], cards = [], leases = [];
  const safety = factory({
    driver: { async request(method, params) {
      calls.push({ method, params });
      if (method === 'resolveApp') return { app: { id: base.bundleId, name: base.app, pid: base.pid,
        processStart: base.processStart, path: '/Applications/Editor.app' }, windows };
      if (method === 'verifyWindowIdentity') {
        assert.equal(params.windowId, selected.windowId);
        return { window: verified };
      }
      assert.equal(method, 'getAXState'); assert.equal(params.windowId, selected.windowId);
      return { window: verified, text: 'offline', readId: 1 };
    } },
    policy: ({ app }) => { policyWindows.push(app); return { allow: true }; },
    ancestry: () => [{ pid: 90, path: '/Applications/Host.app/Contents/MacOS/Host' }],
    targetParents: () => [1], permissions: { app() {}, page() {}, sitesLimited: () => false },
    approve: async card => { cards.push(card); return true; },
    lease: { acquire(target) { leases.push(target); return 'lease'; }, renew() {}, release() {}, close() {} },
  });
  try {
    const result = await safety.request('getApp', { selector });
    assert.equal(result.window.windowId, selected.windowId);
    assert.equal(cards.length, 1); assert.equal(leases.length, 1);
    assert.deepEqual(calls.map(c => c.method), ['resolveApp', 'verifyWindowIdentity', 'verifyWindowIdentity', 'getAXState']);
    return { result, policyWindows };
  } finally { safety.close(); }
}

test('getApp chooses the first verified standard window after a dialog and an unverified standard window', async () => {
  await acquire(createMacSafety, [dialog, unverified, standard, later], { selected: standard });
});
for (const windows of [[dialog, { ...dialog, windowId: '5' }], [unverified, dialog]]) {
  test(`getApp falls back to windows[0] (${windows[0].windowSubrole}, verified=${windows[0].identityVerified})`, async () => {
    await acquire(createMacSafety, windows, { verified: { ...windows[0], identityVerified: true } });
  });
}
for (const patch of [{ pid: 43 }, { processStart: 'reused' }, { bundleId: 'other.app' }]) {
  test(`preferred standard window still refuses changed ${Object.keys(patch)[0]}`, async () => {
    await assert.rejects(acquire(createMacSafety, [dialog, { ...standard, ...patch }], { selected: standard }), { code: 'IDENTITY_CHANGED' });
  });
  test(`AX verification still refuses changed ${Object.keys(patch)[0]}`, async () => {
    await assert.rejects(acquire(createMacSafety, [dialog, standard], { selected: standard, verified: { ...standard, ...patch } }), { code: 'IDENTITY_CHANGED' });
  });
}
test('explicit window selector still binds to the selected window id', async () => {
  await assert.rejects(acquire(createMacSafety, [dialog, standard], { selected: standard, selector: { windowId: dialog.windowId } }), { code: 'IDENTITY_CHANGED' });
});

test('broken selection variants fail the same behavioral assertions', async t => {
  const url = new URL('../plugins/sleight/lib/mac-safety.mjs', import.meta.url);
  const source = (await readFile(url, 'utf8')).replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  const preference = "resolved.windows.find(w => w?.identityVerified === true && w.windowSubrole === 'AXStandardWindow') ?? resolved.windows[0]";
  for (const [name, from, to, check] of [
    ['first-window', preference, 'resolved.windows[0]', f => acquire(f, [dialog, standard], { selected: standard })],
    ['unverified-standard', preference, "resolved.windows.find(w => w.windowSubrole === 'AXStandardWindow') ?? resolved.windows[0]", f => acquire(f, [dialog, unverified, standard], { selected: standard })],
    ['last-standard', preference, "resolved.windows.findLast(w => w?.identityVerified === true && w.windowSubrole === 'AXStandardWindow') ?? resolved.windows[0]", f => acquire(f, [dialog, standard, later], { selected: standard })],
    ['no-fallback', preference, "resolved.windows.find(w => w?.identityVerified === true && w.windowSubrole === 'AXStandardWindow')", f => acquire(f, [dialog])],
  ]) await t.test(name, async () => {
    assert.ok(source.includes(from), name);
    const mutant = await import('data:text/javascript;base64,' + Buffer.from(source.replace(from, to)).toString('base64'));
    await assert.rejects(check(mutant.createMacSafety));
  });
});
