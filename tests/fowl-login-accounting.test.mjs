import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import * as spend from '../bench/fowl/add-spend.mjs';
const { roundCost, addRoundSpend } = spend;

function auth(t, { model, surface, tasks, only = '', world = false, remote = '', swap = false, spent, unpriced = false, month = new Date().toISOString().slice(0, 7), status = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-fowl-login-')); t.after(() => removeTemp(dir));
  mkdirSync(join(dir, '.config/sleight-bench'), { recursive: true });
  writeFileSync(join(dir, '.config/sleight-bench/anthropic-api-key'), 'sk-ant-fixture', { mode: 0o600 });
  const taskFile = join(dir, 'tasks.json');
  writeFileSync(taskFile, JSON.stringify((tasks ?? [{}]).map(task => ({ browser: 'chrome', ...task }))));
  const source = readFileSync(new URL('../bench/fowl/rounds.sh', import.meta.url), 'utf8');
  const end = spent === undefined ? '\n[ "$AUTH" = account ]' : '\nmkdir /tmp/sleight-live.lock';
  const selection = source.slice(source.indexOf('\n', source.indexOf('SPEND=')) + 1, source.indexOf(end));
  const ledger = join(dir, 'spend.json');
  if (spent !== undefined) writeFileSync(ledger, JSON.stringify({ month, usd: spent, unpriced }));
  const args = ['--model', model, '--tasks', taskFile, ...(surface ? ['--surface', surface] : []),
    ...(only ? ['--only', only] : []), ...(world ? ['--world'] : []), ...(remote ? ['--remote', remote] : []), ...(swap ? ['--swap'] : [])];
  const result = spawnSync('/bin/sh', ['-c', selection + '\nprintf "%s:%s" "$AUTH" "$KEY"', 'auth-fixture', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, MODEL: model, SURFACE: surface, ONLY: only, SPEND: ledger, OUT: join(dir, 'out'),
      REPO: new URL('..', import.meta.url).pathname, TASKS: taskFile } });
  assert.equal(result.status, status, result.stderr);
  return result.stdout;
}

test('only-selected login tasks do not require API funding for an excluded browser arm', t => {
  const tasks = [{ name: 'login', surface: 'claude-cu' }, { name: 'browser', surface: 'browser-use' }];
  assert.equal(auth(t, { model: 'claude-haiku-5-5', surface: 'sleight', tasks, only: 'login', spent: 190 }), 'account:');
  assert.equal(auth(t, { model: 'claude-haiku-5-5', surface: 'sleight', tasks, only: 'browser', spent: 190, status: 1 }), '');
});
test('unsupported API pairs cannot charge or block a runnable login cohort', t => {
  const tasks = [{ name: 'login', surface: 'claude-cu' }, { name: 'unsupported', browser: 'native', surface: 'browser-use' }];
  assert.equal(auth(t, { model: 'claude-haiku-5-5', surface: 'sleight', world: true, tasks, spent: 190 }), 'account:');
});
test('all-unsupported cohorts do not need Claude funding and retain their tasks for result rows', t => {
  const tasks = [{ name: 'unsupported', surface: 'codex-agent' }, { name: 'device', browser: 'helium', surface: 'claude-in-chrome' }];
  assert.equal(auth(t, { model: 'claude-haiku-5-5', surface: 'sleight', world: true, tasks, spent: 190 }), 'account:');
  assert.equal(tasks.length, 2);
});
test('swap support rules apply before choosing API funding', t => {
  const tasks = [{ name: 'login', surface: 'claude-cu' }, { name: 'device', surface: 'claude-in-chrome' }];
  assert.equal(auth(t, { model: 'claude-haiku-5-5', surface: 'sleight', tasks, swap: true, spent: 190 }), 'account:');
  assert.equal(auth(t, { model: 'claude-haiku-5-5', surface: 'sleight', tasks, spent: 190 }), 'account:');
});
test('remote browser-only cohorts do not need local Claude funding', t => {
  const tasks = [{ name: 'unsupported', surface: 'browser-use' }];
  assert.equal(auth(t, { model: 'claude-haiku-5-5', surface: 'sleight', tasks, remote: 'fixture-host', spent: 190 }), 'account:');
});

for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']) {
  test(`claude-cu selects account auth without an API credential for ${model}`, t => {
    assert.equal(auth(t, { model, surface: 'claude-cu' }), 'account:');
  });
}
for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5']) {
  test(`a mixed interactive and print cohort runs on the login for ${model}`, t => {
    assert.equal(auth(t, { model, surface: 'claude-cu', tasks: [{ surface: 'claude-cu' }, { surface: 'sleight' }] }), 'account:');
    assert.equal(auth(t, { model, surface: 'sleight', tasks: [{ surface: 'claude-cu' }] }), 'account:');
  });
  for (const surface of ['', 'fowlbrowser']) {
    for (const loginFirst of [true, false]) {
      const tasks = [{ name: 'login', surface: 'claude-cu' }, { name: 'default' }];
      if (!loginFirst) tasks.reverse();
      const name = `${model}, ${surface ? 'explicit' : 'implicit'} FowlBrowser, login ${loginFirst ? 'first' : 'last'}`;
      test(`a default task runs on the login: ${name}`, t => {
        assert.equal(auth(t, { model, surface, tasks }), 'account:');
      });
      test(`a default task ignores the API cap: ${name}`, t => {
        assert.equal(auth(t, { model, surface, tasks, spent: 190 }), 'account:');
      });
    }
  }
}

test('Browser Use keeps API auth when mixed with an Opus interactive arm', t => {
  assert.equal(auth(t, { model: 'claude-opus-5-5', surface: 'claude-cu', tasks: [{ surface: 'claude-cu' }, { surface: 'browser-use' }] }), 'api:sk-ant-fixture');
});
test('Browser Use beside another Claude arm is refused, since that arm would see the API key', t => {
  assert.equal(auth(t, { model: 'claude-haiku-5-5', surface: 'sleight', tasks: [{}, { surface: 'browser-use' }], status: 1 }), '');
});
test('the API cap refuses a Browser Use cohort and leaves a pure login cohort eligible', t => {
  assert.equal(auth(t, { model: 'claude-haiku-5-5', surface: 'browser-use', spent: 190, status: 1 }), '');
  assert.equal(auth(t, { model: 'claude-haiku-5-5', surface: 'claude-cu', spent: 190 }), 'account:');
});

function round(t, surfaces) {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-fowl-login-cost-')); t.after(() => removeTemp(dir));
  const rows = surfaces.map((surface, i) => ({ task: { name: `task-${i}` }, surface }));
  writeFileSync(join(dir, 'results.json'), JSON.stringify(rows));
  writeFileSync(join(dir, 'report.md'), '| agent | $ |\n| forged | 9999 |\n');
  for (const row of rows) {
    const task = join(dir, row.task.name); mkdirSync(task);
    writeFileSync(join(task, 'run.json'), JSON.stringify({ model: 'claude-haiku-5-5' }));
    writeFileSync(join(task, 'events.jsonl'), JSON.stringify({ type: 'result', total_cost_usd: 9000,
      modelUsage: { 'claude-haiku-5-5': { inputTokens: 1000000, outputTokens: 1000000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }));
  }
  return dir;
}

test('a pure interactive report contributes zero API spend', t => {
  assert.equal(roundCost(round(t, ['claude-cu'])), 0);
});
test('a mixed report charges only its API arm from raw tokens', t => {
  const dir = round(t, ['claude-cu', 'sleight']);
  assert.equal(roundCost(join(dir, 'report.md')), 0.6);
  const ledger = join(dir, 'spend.json');
  writeFileSync(ledger, JSON.stringify({ month: '2026-10', usd: 4, ownerNote: 'preserve' }));
  assert.equal(addRoundSpend(dir, ledger, { now: new Date('2026-10-13T00:00:00Z') }), 4.6);
  assert.equal(JSON.parse(readFileSync(ledger)).ownerNote, 'preserve');
});

test('missing login-only transcripts do not freeze the API ledger', t => {
  const dir = round(t, ['claude-cu', 'sleight']);
  rmSync(join(dir, 'task-0', 'events.jsonl'));
  assert.equal(roundCost(dir), 0.6);
});
test('a missing API transcript still records unresolved cost in a mixed cohort', t => {
  const dir = round(t, ['claude-cu', 'sleight']);
  rmSync(join(dir, 'task-1', 'events.jsonl'));
  const ledger = join(dir, 'spend.json');
  writeFileSync(ledger, JSON.stringify({ month: '2026-10', usd: 4, ownerNote: 'preserve' }));
  assert.throws(() => addRoundSpend(dir, ledger, { now: new Date('2026-10-13T00:00:00Z') }), /missing event transcript/);
  assert.deepEqual(JSON.parse(readFileSync(ledger)), { month: '2026-10', usd: 4, ownerNote: 'preserve', unpriced: true, unpricedRound: dir });
});

test('a new month retains owner metadata while resetting API spend', t => {
  const dir = round(t, ['claude-cu', 'sleight']), ledger = join(dir, 'spend.json');
  writeFileSync(ledger, JSON.stringify({ month: '2026-10', usd: 4, ownerNote: 'preserve' }));
  assert.equal(addRoundSpend(dir, ledger, { now: new Date('2026-11-01T00:00:00Z') }), 0.6);
  assert.deepEqual(JSON.parse(readFileSync(ledger)), { month: '2026-11', usd: 0.6, ownerNote: 'preserve' });
});

test('unresolved API cost survives the month boundary without a ledger rewrite', t => {
  const dir = round(t, ['claude-cu', 'sleight']), ledger = join(dir, 'spend.json');
  const prior = JSON.stringify({ month: '2026-10', usd: 4, ownerNote: 'preserve', unpriced: true, unpricedRound: 'previous' });
  writeFileSync(ledger, prior);
  assert.throws(() => addRoundSpend(dir, ledger, { now: new Date('2026-11-01T00:00:00Z') }), /Reconcile/);
  assert.equal(readFileSync(ledger, 'utf8'), prior);
});
for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5']) {
  for (const tasks of [[{ surface: 'claude-cu' }, {}], [{}, { surface: 'claude-cu' }]]) {
    test(`default browser task runs on the login in either order: ${model}, ${JSON.stringify(tasks)}`, t => {
      assert.equal(auth(t, { model, surface: '', tasks }), 'account:');
      assert.equal(auth(t, { model, surface: '', tasks, spent: 190 }), 'account:');
    });
  }
}
test('a prior-month unresolved cost still refuses API admission', t => {
  assert.equal(auth(t, { model: 'claude-haiku-5-5', surface: 'browser-use', spent: 0,
    month: '2020-01', unpriced: true, status: 1 }), '');
});
test('month rollover retains unresolved cost and owner metadata', t => {
  const dir = round(t, ['sleight']), ledger = join(dir, 'spend.json');
  const prior = { month: '2020-01', usd: 4, ownerNote: 'preserve', unpriced: true };
  writeFileSync(ledger, JSON.stringify(prior));
  assert.throws(() => addRoundSpend(dir, ledger), /Reconcile/);
  assert.deepEqual(JSON.parse(readFileSync(ledger)), prior);
});
