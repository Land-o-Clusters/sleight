import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentClock } from '../bench/agent-time.mjs';
import { runDriver } from '../bench/driver.mjs';
import { executeRealTask } from '../bench/real-run.mjs';
import { score } from '../bench/claim-score.mjs';
import { regradeRow, scoreRounds } from '../bench/fowl/race-score.mjs';
import { realAgentSetup } from '../bench/fowl/real-gate-setup.mjs';
import { runGateAgent } from '../bench/fowl/real-gate.mjs';
import { realBrowserPlan } from '../bench/fowl/real-browser.mjs';
import { publicPrivateMailRow } from '../bench/private-mail.mjs';
import { spawnSync } from 'node:child_process';

test('agent clock ends on final result or Codex turn event, not last output or collection', () => {
  let time = 1100; const c = new AgentClock(1000, () => time);
  c.append('{"type":"assistant"}\n'); assert.equal(c.seconds(), null);
  time = 1500; c.append('{"type":"res'); c.append('ult","result":"done"}\n');
  time = 9000; c.append('{"type":"system"}\n'); assert.equal(c.seconds(), 0.5);
  for (const type of ['turn.completed', 'turn.failed']) { const x = new AgentClock(1000, () => 2000); x.append(JSON.stringify({ type })); assert.equal(x.seconds(), 1); }
  const pretty = new AgentClock(1000, () => 1700); pretty.append('{\n "type": "result"\n}'); assert.equal(pretty.seconds(), 0.7);
});

test('a CLI cannot replace the harness clock by printing a timing field and missing final stays unknown', () => {
  const c = new AgentClock(1000, () => 9000); c.append('{"type":"result","agentSeconds":2.5}\n'); assert.equal(c.seconds(), 8);
  const x = new AgentClock(1000, () => 9000); x.append('not a result'); assert.equal(x.seconds(), null);
});

test('native driver retains final-event interval while its child finishes later', async () => {
  const r = await runDriver(process.execPath, ['-e', 'console.log(JSON.stringify({type:"result",result:"done"})); setTimeout(()=>{},250)'], { format: 'stream-json' });
  assert.equal(r.code, 0); assert.equal(r.groupClean, true);
  assert.ok(r.agentSeconds >= 0);
  assert.ok((r.stamps.closeAt - r.stamps.spawnAt) / 1000 - r.agentSeconds >= 0.15);
  assert.equal(r.agentTiming.startupIncluded, true); assert.equal(r.agentTiming.start, 'spawn');
});

test('CLI init becomes the ready boundary and its metadata reaches native results', async () => {
  const r = await runDriver(process.execPath, ['-e', 'console.log(JSON.stringify({type:"system",subtype:"init"})); setTimeout(()=>console.log(JSON.stringify({type:"result"})),20)'], { format: 'stream-json' });
  assert.equal(r.code, 0); assert.equal(r.groupClean, true);
  assert.deepEqual(r.agentTiming, { start: 'system/init', end: 'final-result-event', startupIncluded: false });
  const dir = mkdtempSync(join(tmpdir(), 'ca4-time-'));
  try {
    const out = await executeRealTask({ prompt: () => 'fixture', check: () => true }, { dir }, { lockHeld: true, drive: async () => r });
    assert.deepEqual(out.agentTiming, r.agentTiming); assert.equal(out.secondsTiming.startupIncluded, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native results keep agentSeconds before checks and cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca3-time-'));
  try {
    const r = await executeRealTask({ setup() {}, prompt: () => 'fixture', check: () => true, cleanup() {} }, { dir }, {
      lockHeld: true, drive: async () => ({ code: 0, groupClean: true, agentSeconds: 1.25, out: { result: 'done' } }),
    });
    assert.equal(r.agentSeconds, 1.25); assert.equal(typeof r.seconds, 'number'); assert.equal(r.passed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('private native rows allow only a numeric agent interval while retaining their existing fields', () => {
  const row = { arm: 'sleight', task: 'mimestream-label', run: 1, passed: true, seconds: 8, turns: 2 };
  assert.equal(publicPrivateMailRow({ ...row, agentSeconds: 2.5 }).agentSeconds, 2.5);
  assert.equal(publicPrivateMailRow({ ...row, agentSeconds: 'secret' }).agentSeconds, null);
  assert.equal('agentSeconds' in publicPrivateMailRow(row), false);
});

test('race native Codex and Claude rows propagate agentSeconds without changing outer interval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ca3-race-time-'));
  try {
    for (const surface of ['codex', 'sleight-turbo']) {
      const dir = join(root, surface), task = { name: 'mdn', browser: 'chrome', prompt: 'Look up MDN.', result: 'answer' };
      const plan = realAgentSetup({ task, surface, dir, realBrowser: realBrowserPlan({ browser: 'chrome', round: 'ca3-time' }), dryRun: true });
      const r = await runGateAgent({ ...plan, task, dir, surface }, {
        runNativeCodex: async () => ({ code: 0, out: { result: 'done' }, groupClean: true, toolCalls: 0, forbidden: [], stderr: '', agentSeconds: 2.25 }),
        runClaude: async () => ({ exit: { code: 0 }, groupClean: true, stdout: '{"type":"result","result":"done"}\n', stderr: '', agentSeconds: 3.25 }),
      });
      assert.equal(r.agentSeconds, surface === 'codex' ? 2.25 : 3.25); assert.ok(r.finished >= r.started);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('claim scorer opt-in uses agentSeconds and preserves older row durations and input objects', () => {
  const rows = [{ arm: 'sleight', task: 'x', passed: true, seconds: 10, agentSeconds: 2 }, { arm: 'sleight', task: 'x', passed: false, seconds: 20 }];
  assert.equal(score(rows).sleight.x.expected, 30);
  assert.equal(score(rows, { agentSeconds: true }).sleight.x.expected, 22);
  assert.equal(rows[0].seconds, 10);
});

test('race regrading retains both intervals and opt-in comparison keeps old rows', () => {
  const row = regradeRow({ task: { name: 'mdn' }, surface: 'cursor-cu', wallMs: 10000, agentSeconds: 2,
    successfulBrowserCalls: 1, outcome: { ok: true } });
  assert.equal(row.seconds, 10); assert.equal(row.agentSeconds, 2);
  const rounds = [{ browser: 'chrome', name: 'test', rows: [row, { ...row, agentSeconds: undefined, seconds: 8 }] }];
  assert.equal(scoreRounds(rounds).chrome.table['cursor-cu'].mdn.mean, 9);
  assert.equal(scoreRounds(rounds, { agentSeconds: true }).chrome.table['cursor-cu'].mdn.mean, 5);
});

test('native and race scorer CLIs expose --agent-seconds and preserve default scores', () => {
  const root = mkdtempSync(join(tmpdir(), 'ca3-score-cli-'));
  try {
    const results = join(root, 'results'); mkdirSync(results);
    const rules = join(root, 'rules.json');
    writeFileSync(rules, JSON.stringify({ since: '', tasks: ['x'], arms: ['sleight'], reasons: [], files: [], windows: [] }));
    writeFileSync(join(results, 'run.json'), JSON.stringify({ results: [{ arm: 'sleight', task: 'x', run: 1, passed: true, seconds: 10, agentSeconds: 2 }] }));
    const round = join(root, 'round'); mkdirSync(round);
    writeFileSync(join(round, 'browser.json'), '{"browser":"chrome"}');
    writeFileSync(join(round, 'results.json'), JSON.stringify([{ task: { name: 'mdn' }, surface: 'cursor-cu', wallMs: 10000, agentSeconds: 2,
      successfulBrowserCalls: 1, outcome: { ok: true } }]));
    for (const opt of [[], ['--agent-seconds']]) {
      const native = spawnSync(process.execPath, ['bench/claim-score.mjs', '--results', results, '--rules', rules, '--json', ...opt], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr); const n = JSON.parse(native.stdout);
      assert.equal(n.table.sleight.x.mean, opt.length ? 2 : 10);
      const race = spawnSync(process.execPath, ['bench/fowl/race-score.mjs', round, '--json', ...opt], { encoding: 'utf8' });
      assert.equal(race.status, 0, race.stderr); const r = JSON.parse(race.stdout);
      assert.equal(r.browsers.chrome.table['cursor-cu'].mdn.mean, opt.length ? 2 : 10);
      if (opt.length) { assert.match(n.timing, /agentSeconds/); assert.match(r.timing, /agentSeconds/); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
