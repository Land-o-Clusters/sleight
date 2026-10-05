import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserCall } from '../plugins/sleight/lib/browser-call.mjs';

test('literal browser calls are classified as browser', () => {
  assert.ok(browserCall('await cua.listBrowsers()'));
  assert.ok(browserCall('let tab = await cua.createBrowserTab("abc", "https://example.com")'));
  assert.ok(browserCall('await tab.getByRole("link", { name: "More" }).click()', new Set(['tab'])));
  assert.ok(browserCall('const rows = [1, 2]; await tab.goto("https://example.com")', new Set(['tab'])));
});

test('native access in any form keeps the call on the native path', () => {
  const tab = new Set(['tab']);
  for (const code of [
    'await cua.getApp("TextEdit"); await tab.reload()',
    'await cua["getApp"]("TextEdit"); await tab.reload()',
    'const { getApp } = cua; await getApp("TextEdit"); await tab.reload()',
    'const c = cua; await c.getApp("TextEdit"); await tab.reload()',
    'await globalThis.cua.getApp("TextEdit"); await tab.reload()',
    'await eval("cua.getApp(\\"TextEdit\\")"); await tab.reload()',
    'await Function("return cua")().getApp("TextEdit"); await tab.reload()',
    'await app.click(3); await tab.reload()',
    'const t = `${await cua.getApp("TextEdit")}`; await tab.reload()',
    'await tab.constructor.constructor("return cua")().getApp("TextEdit"); await tab.reload()',
    'await tab.__proto__.reload.call(tab)',
  ]) assert.equal(browserCall(code, tab), undefined, code);
});
