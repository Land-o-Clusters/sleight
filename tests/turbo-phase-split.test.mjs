import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { spawnSync } from 'node:child_process';

const script = new URL('../bench/fowl/turbo-phase-split.mjs', import.meta.url);
function fixture(t) {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-phase-split-')));
  mkdirSync(join(root, 'task'));
  writeFileSync(join(root, 'results.json'), JSON.stringify([{ task: { name: 'task' }, run: { started: 0, finished: 1000 } }]));
  return root;
}
const phase = (ms, name, turn, call) => JSON.stringify({ t: new Date(ms).toISOString(), direction: 'turbo-phase',
  msg: { phase: name, ...(turn === undefined ? {} : { turn }), ...(call === undefined ? {} : { call }) } });
const cli = (...args) => spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8' });

test('round split reports startup and final-turn intervals without changing the trace or exposing other fields', t => {
  const root = fixture(t), file = join(root, 'task', 'trace-42.jsonl');
  const text = [phase(10, 'worker-spawn-start'), phase(12, 'worker-spawned'), phase(22, 'worker-entry'),
    phase(30, 'helpers-check-start'), phase(40, 'helpers-check-end'), phase(45, 'connection-select-start'), phase(60, 'connection-select-end'),
    phase(70, 'worker-ready'), phase(75, 'bridge-ready'), phase(80, 'tools-registered'), phase(100, 'first-call-admitted', 1),
    phase(100, 'call-start', 1, 1), phase(110, 'connection-start'), phase(130, 'connection-end'), phase(140, 'runtime-ready'),
    phase(150, 'call-result', 1, 1), phase(200, 'call-start', 1, 2), phase(220, 'call-result', 1, 2),
    phase(300, 'turn-end-requested', 1), phase(320, 'turn-end', 1),
    JSON.stringify({ t: new Date(400).toISOString(), direction: 'to-client', msg: { text: 'private page content' } }), '{broken'].join('\n');
  writeFileSync(file, text);
  const out = cli(root);
  assert.equal(out.status, 0, out.stderr);
  const rows = JSON.parse(out.stdout), session = rows[0].sessions[0];
  assert.deepEqual(session.startup, { launchToSpawnMs: 10, spawnMs: 2, workerLoadMs: 10, helperCheckMs: 10,
    connectionSelectMs: 15, workerReadyMs: 48, registrationGapMs: 5 });
  assert.deepEqual(session.turns, [{ turn: 1, firstAdmissionGapMs: 20, firstCallMs: 50, connectionMs: 20, runtimeReadyMs: 40,
    lastResultToEndRequestMs: 80, turnCleanupMs: 20, lastResultToTurnEndMs: 100 }]);
  assert.equal(session.turnEndToProcessExitMs, 680);
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.doesNotMatch(out.stdout, /private page content|broken|to-client/);
});

test('old rounds without phase traces report missing evidence rather than zero duration', t => {
  const root = fixture(t), out = cli(root);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), [{ task: 'task', sessions: [], missing: 'no correlated turbo-phase trace; record SLEIGHT_TRACE for this task' }]);
});

test('shared trace directories match only a complete session within the task lifetime', t => {
  const root = fixture(t), traces = join(root, 'shared'); mkdirSync(traces);
  writeFileSync(join(traces, 'trace-42.jsonl'), [phase(10, 'worker-spawn-start'), phase(100, 'first-call-admitted', 1)].join('\n'));
  writeFileSync(join(traces, 'trace-43.jsonl'), [phase(-20, 'worker-spawn-start'), phase(100, 'first-call-admitted', 1)].join('\n'));
  const out = cli(root, '--trace-dir', traces);
  assert.equal(out.status, 0, out.stderr);
  const sessions = JSON.parse(out.stdout)[0].sessions;
  assert.deepEqual(sessions.map(row => row.trace), ['trace-42.jsonl']);
  assert.equal(sessions[0].startup.helperCheckMs, null);
  assert.equal(sessions[0].turns[0].lastResultToTurnEndMs, null);
});
