import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInventoryRead } from '../plugins/sleight/lib/inventory-read.mjs';

test('inventory reads may silence the engine printout, and nothing else goes in the call', () => {
  assert.equal(isInventoryRead('(await cua.listApps({ emit: false })).map(a => a.id).join("\\n")'), true);
  assert.equal(isInventoryRead('(await cua.listApps()).map(a => a.id).join("\\n")'), true);
  assert.equal(isInventoryRead('(await cua.listApps({ emit: true }))'), true);
  assert.equal(isInventoryRead('(await cua.listApps({ disableDiffing: false }))'), false);
  assert.equal(isInventoryRead('(await cua.listApps({ emit: x }))'), false);
});
