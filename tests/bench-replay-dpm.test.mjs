import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { describe } from 'node:test';
import { packageSkip } from './requirements.mjs';

describe('offline replay with the source parser', { skip: packageSkip('typescript') }, async () => {
const { assertCheck } = await import('../bench/replay/checks.mjs');
const { loadCheck } = await import('../bench/replay/run.mjs');

const spec = loadCheck('DP1');
const start = '2026-10-20T02:07:31.990Z', end = '2026-10-20T02:07:32.988Z';
const replay = { calls: [{ index: 5, name: 'js', recordedArguments: { code: 'await app.pressKey("super+w"); await app.getAXState();' },
  startedAt: start, finishedAt: end, result: { content: [{ type: 'text', text: 'sleight: the app has no windows left. Nothing more to read.' }] } }] };
const event = (decision, reason = 'no windows') => ({ t: end, direction: 'dp1-decision', msg: { id: 6, decision, reason } });
function fixture(t, events = []) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-dpm-check-')));
  t.after(() => removeTemp(dir));
  // Transport text can contain a decision-looking string. It is not relay evidence.
  writeFileSync(join(dir, 'trace.jsonl'), JSON.stringify({ t: end, event: 'mcp', direction: 'received', msg: event('skipped-read') }) + '\n');
  writeFileSync(join(dir, 'trace-123.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
  return dir;
}

test('DPm reads DP1 decisions from relay trace files and reports the actual kept-read reason', t => {
  const dir = fixture(t, [event('kept-read', 'windows non-empty')]);
  const check = assertCheck(spec, replay, dir);
  assert.equal(check.verdict, 'fail');
  assert.match(check.failures[0], /kept-read \(windows non-empty\).*expected skipped-read/);
  assert.ok(!check.failures[0].includes('required trace evidence missing'));
});

test('DPm distinguishes disabled DP1 from absent relay evidence', t => {
  const dir = fixture(t);
  const baseline = assertCheck(spec, { ...replay, env: { SLEIGHT_DP1: '0' } }, dir);
  assert.equal(baseline.verdict, 'fail');
  assert.match(baseline.failures[0], /SLEIGHT_DP1=0 disables this event/);
  rmSync(join(dir, 'trace-123.jsonl'));
  const missing = assertCheck(spec, replay, dir);
  assert.equal(missing.verdict, 'inconclusive');
  assert.match(missing.reason, /trace-<pid>\.jsonl is missing/);
});

test('DPm rejects blocked or unrelated-call decisions and after-call reads', t => {
  for (const events of [[event('blocked-read', 'timeout')], [{ ...event('skipped-read'), t: '2026-10-20T02:07:33.000Z' }],
    [event('skipped-read'), { t: end, direction: 'guard-read', msg: { phase: 'after-call' } }]]) {
    assert.equal(assertCheck(spec, replay, fixture(t, events)).verdict, 'fail');
  }
  assert.equal(assertCheck(spec, replay, fixture(t, [event('skipped-read')])).verdict, 'pass');
  const reopened = { calls: [{ ...replay.calls[0], result: { content: [{ type: 'text', text: 'Window: "Untitled", App: TextEdit.' }] } }] };
  assert.equal(assertCheck(spec, reopened, fixture(t, [event('skipped-read')])).verdict, 'fail');
});

const retained = join(homedir(), 'Projects/sleight-wt/race-1017/evidence-replay-dp1d');
test('DPm explains all ten retained DP1d failures without claiming the old campaign passed', {
  skip: !existsSync(join(retained, '1-A/result.json')) && 'Retained DP1d evidence is not installed',
}, () => {
  for (let index = 1; index <= 10; index++) {
    const variant = index % 2 ? 'A' : 'B', dir = join(retained, `${index}-${variant}`);
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    const check = assertCheck(spec, result, dir);
    assert.equal(check.verdict, 'fail');
    assert.match(check.failures.join('; '), variant === 'A' ? /kept-read \(windows non-empty\)/ : /SLEIGHT_DP1=0 disables this event/);
  }
});
});
