import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { describe } from 'node:test';
import { packageSkip } from './requirements.mjs';

describe('offline replay with the source parser', { skip: packageSkip('typescript') }, async () => {
const { loadCheck } = await import('../bench/replay/run.mjs');
const { loadRecording } = await import('../bench/replay/recording.mjs');
const { auditRecording } = await import('../bench/replay/audit.mjs');

const text = value => ({ content: [{ type: 'text', text: value }] });
const tab = 't' + 'a'.repeat(31);
const race = calls => ({ kind: 'race', task: { name: 'offline', browser: 'chrome' }, calls });
const call = (name, args, result) => ({ server: 'sleight-turbo', name, arguments: args, result });

test('recorded response audit accepts a full stream and refuses an unrecorded mapping read', async () => {
  const rec = race([
    call('browser_read', {}, text(`${tab} http://127.0.0.1:5413/\nTitle: Fixture\n# Snapshot 1\n- button "Save" [ref=e1]`)),
    call('browser_act', { tab, steps: [{ do: 'click', ref: 'e1' }] }, text('saved')),
  ]);
  assert.deepEqual(await auditRecording(rec), { planned: 2, fed: 2, reached: 2, verdict: 'pass', reason: null });
  rec.calls[1].arguments.steps[0].ref = 'e99';
  const result = await auditRecording(rec);
  assert.equal(result.fed, 1); assert.equal(result.verdict, 'diverge');
  assert.match(result.reason, /mapping read/);
});

// Retained recordings are optional on other machines; synthetic coverage above always runs.
const expected = {
  DP1: [6, 6, 'pass', null], DP2: [6, 6, 'pass', null],
  DP7: [66, 2, 'diverge', 'Unmapped numeric argument to an unsupported method'],
  CK2: [12, 4, 'diverge', 'Object handle targets have no verified window frame'],
  CK3: [8, 7, 'diverge', 'Unmapped numeric argument to an unsupported method'],
  MC1: [12, 6, 'diverge', 'Offline audit has no recorded response for a mapping read'],
  MS1: [6, 6, 'pass', null], LB1: [4, 4, 'pass', null],
};
for (const id of ['DP1', 'DP2', 'DP7', 'CK2', 'CK3', 'MC1', 'MS1', 'LB1']) {
  const spec = loadCheck(id), source = spec.source.replace(/^~/, homedir());
  test(`retained recording feedback audit ${id}`, { skip: !existsSync(source) && 'Retained benchmark recording is not installed' }, async t => {
    let recording;
    try { recording = loadRecording(source, spec); } catch (error) {
      // macOS sweeps the temp evidence folder that holds native transcripts (DP7's was gone after the 2026-10-25 reboot).
      if (/^Transcript missing in /.test(error.message)) return t.skip('Retained transcript was swept from the temp folder');
      throw error;
    }
    const result = await auditRecording(recording);
    t.diagnostic(JSON.stringify({ spec: id, transcriptSHA256: recording.transcriptSHA256, ...result }));
    assert.deepEqual([result.planned, result.fed, result.verdict, result.reason], expected[id]);
  });
}
});
