import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { CE8_STEPS, replayWindowIdentity } from '../scripts/replay-window-identity.mjs';

test('AD3 replay distinguishes missing historical facts from readable fake metadata', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ad3-replay-')));
  for (const step of CE8_STEPS) {
    const reply = { content: [{ type: 'text', text: 'Window: "Cursor Agents", App: Cursor.\n0 standard window Cursor Agents\n' +
      'sleight-warning: native window identity is inconclusive\nsleight: UI unverified (degraded read).' }] };
    writeFileSync(join(root, `${step}.json`), JSON.stringify({ results: [{ out: { entryTurns: [{ harnessNewChat: {
      bundleId: 'com.todesktop.230313mzl4w4u92', reply,
    } }] } }] }));
  }
  const result = replayWindowIdentity(root);
  assert.equal(result.recordedWarnings, 6);
  assert.equal(result.factQualifiedHistoricalReplays, 0);
  assert.match(result.historicalWarningOutcome, /unverified/);
  assert.equal(result.fakeReadableWarnings, 0);
  assert.equal(result.fakeUnreadableWarnings, 6);
  assert.equal(result.degradedReadReplies, 6);
});
