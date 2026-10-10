import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulatorFocusReport } from '../bench/simulator-focus-report.mjs';

test('all published Simulator records scrub device identifiers and personal strings without changing ownership', () => {
  const sim = { udid: 'DEVICE-IDENTIFIER', name: 'iPhone "private" 雪', app: 'DeviceHub', bootAttempted: true };
  const report = { error: `${sim.name} ${sim.udid} /Users/fixture-owner`, rows: [{ text: `Owner Full Name: ${sim.udid}` }],
    result: { sim: { ...sim }, nested: [sim.name, null, 3] } };
  const before = structuredClone({ sim, report });
  const json = simulatorFocusReport(report, sim, { home: '/Users/fixture-owner', ownerName: 'Owner Full Name' });
  assert.doesNotMatch(json, /DEVICE-IDENTIFIER|private|雪|fixture-owner|Owner Full Name/);
  const result = JSON.parse(json);
  assert.equal(result.simulatorOwnership.udid, '<simulator-id>');
  assert.equal(result.simulatorOwnership.name, '<simulator-name>');
  assert.equal(result.simulatorOwnership.bootAttempted, true);
  assert.deepEqual({ sim, report }, before);
});
test('a pre-launch failure can be published without a Simulator identity', () => {
  assert.equal(JSON.parse(simulatorFocusReport({ error: 'stopped' }, undefined, { home: '/Users/test', ownerName: 'Test Owner' })).simulatorOwnership, null);
});
