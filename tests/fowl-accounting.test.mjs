import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { modelId, tokenCost, roundPlan } from '../bench/fowl/accounting.mjs';
import { roundCost, addRoundSpend } from '../bench/fowl/add-spend.mjs';

const recorded = JSON.parse(readFileSync(new URL('fixtures/fowl-haiku-5-5-result.json', import.meta.url)));
test('Chrome uses isolated account auth at Haiku high and Browser Use must split rounds', async () => {
  const { roundAuth } = await import('../bench/fowl/accounting.mjs');
  assert.equal(typeof roundAuth, 'function');
  assert.equal(roundAuth('haiku', ['claude-in-chrome']), 'account');
  assert.equal(roundAuth('haiku', []), 'account', 'an unsupported-only cohort needs no Claude funding');
  assert.equal(roundAuth('haiku', ['']), 'account', 'empty CLI funding output needs no Claude funding');
  assert.equal(roundAuth('haiku', ['claude-cu', 'claude-in-chrome']), 'account');
  assert.equal(roundAuth('haiku', ['playwright-mcp']), 'account', 'every Claude arm runs on the owner login');
  assert.equal(roundAuth('haiku', ['sleight', 'claude-in-chrome']), 'account');
  assert.equal(roundAuth('opus', ['browser-use']), 'api');
  assert.equal(roundAuth('opus', ['browser-use', 'claude-cu']), 'api');
  assert.throws(() => roundAuth('haiku', ['sleight', 'browser-use']), /round of its own/);
  assert.equal(roundPlan(['--plan', '--surface', 'claude-in-chrome', '--model', 'haiku']).auth, 'account');
});
test('the actual wrapper auth block admits a Haiku Chrome round without reading an API key', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-fowl-chrome-auth-')); t.after(() => removeTemp(dir));
  const wrapper = readFileSync(new URL('../bench/fowl/rounds.sh', import.meta.url), 'utf8');
  const block = wrapper.slice(wrapper.indexOf('SPEND='), wrapper.indexOf('[ "$AUTH" = account ] || [ -n "$OUT" ]'));
  const tasks = join(dir, 'tasks.json');
  writeFileSync(tasks, JSON.stringify([{ name: 'fixture', browser: 'chrome' }]));
  const result = spawnSync('/bin/sh', ['-eu', '-c', block + '\nprintf "%s" "$AUTH"', 'auth-fixture',
    '--tasks', tasks, '--surface', 'claude-in-chrome'], {
    encoding: 'utf8', env: { HOME: dir, REPO: new URL('..', import.meta.url).pathname, PATH: process.env.PATH,
      MODEL: 'claude-haiku-5-5', SURFACE: 'claude-in-chrome', TASKS: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'account');
});
test('model aliases select explicit 5.5 IDs and the last option wins in the round plan', () => {
  for (const alias of ['haiku', 'sonnet', 'opus']) {
    assert.equal(modelId(alias), `claude-${alias}-5-5`);
    for (const surface of ['sleight', 'fowlbrowser']) {
      const plan = roundPlan(['--surface', surface, '--model', alias]);
      assert.equal(plan.model, `claude-${alias}-5-5`);
      assert.deepEqual(plan.args.slice(-2), ['--model', plan.model]);
      assert.equal(plan.surface, surface);
    }
  }
  assert.equal(modelId('claude-haiku-5-5'), 'claude-haiku-5-5');
  assert.equal(roundPlan(['--model', 'sonnet', '--model', 'haiku']).model, 'claude-haiku-5-5');
});
test('the recorded tiny Haiku result is priced from all four token counts', () => {
  assert.equal(tokenCost(recorded), 0.0016165);
  assert.equal(tokenCost({ ...recorded, total_cost_usd: 9000 }), 0.0016165);
  assert.equal(tokenCost({ total_cost_usd: 9000 }), undefined);
  assert.equal(tokenCost({ modelUsage: { future: { inputTokens: 1, costUSD: 9000 } } }), undefined);
  assert.equal(tokenCost({ modelUsage: { 'claude-haiku-5-5': { inputTokens: -1 } } }), undefined);
  assert.equal(tokenCost({ usage: recorded.usage, total_cost_usd: 9000 }, 'claude-haiku-5-5'), 0.0016165);
});

test('an unpriced round blocks future budget admission until the owner reconciles its cost', async t => {
  const { addRoundSpend } = await import('../bench/fowl/add-spend.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'sleight-fowl-unknown-')); t.after(() => removeTemp(dir));
  mkdirSync(join(dir, 'task')); writeFileSync(join(dir, 'task', 'events.jsonl'), JSON.stringify({ type: 'result', total_cost_usd: 9 }));
  const ledger = join(dir, 'ledger.json'), now = new Date('2026-10-13T00:00:00Z');
  writeFileSync(ledger, JSON.stringify({ month: '2026-10', usd: 4 }));
  assert.throws(() => addRoundSpend(dir, ledger, { now }), /Token cost/);
  const failed = JSON.parse(readFileSync(ledger, 'utf8'));
  assert.equal(failed.usd, 4); assert.equal(failed.unpriced, true);
  writeFileSync(join(dir, 'task', 'events.jsonl'), JSON.stringify(recorded));
  assert.throws(() => addRoundSpend(dir, ledger, { now }), /reconcil/i);
  writeFileSync(ledger, JSON.stringify({ month: '2026-10', usd: 4 }));
  assert.equal(addRoundSpend(dir, ledger, { now }), 4.001617);
});
for (const priced of [false, true]) test(`a missing run transcript blocks spend${priced ? ' alongside a priced task' : ''}`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-fowl-missing-')); t.after(() => removeTemp(dir));
  mkdirSync(join(dir, 'missing'));
  writeFileSync(join(dir, 'missing', 'run.json'), JSON.stringify({ model: 'claude-haiku-5-5', result: { total_cost_usd: 3 } }));
  if (priced) {
    mkdirSync(join(dir, 'priced'));
    writeFileSync(join(dir, 'priced', 'events.jsonl'), JSON.stringify(recorded));
  }
  const ledger = join(dir, 'ledger.json'), now = new Date('2026-10-13T00:00:00Z');
  writeFileSync(ledger, JSON.stringify({ month: '2026-10', usd: 4, note: 'keep' }));
  assert.throws(() => addRoundSpend(dir, ledger, { now }), /Token cost.*missing/);
  assert.deepEqual(JSON.parse(readFileSync(ledger, 'utf8')), { month: '2026-10', usd: 4, note: 'keep', unpriced: true, unpricedRound: dir });
});
test('month rollover preserves unresolved spend and unknown ledger fields', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-fowl-rollover-')); t.after(() => removeTemp(dir));
  const ledger = join(dir, 'ledger.json'), now = new Date('2026-10-13T00:00:00Z');
  const previous = { month: '2026-09', usd: 4, unpriced: true, unpricedRound: '/fixture/prior', note: 'keep' };
  writeFileSync(ledger, JSON.stringify(previous));
  assert.throws(() => addRoundSpend(dir, ledger, { now }), /reconcil/i);
  assert.deepEqual(JSON.parse(readFileSync(ledger, 'utf8')), previous);
  writeFileSync(ledger, JSON.stringify({ month: '2026-09', usd: 4, note: 'keep' }));
  assert.equal(addRoundSpend(dir, ledger, { now }), 0);
  assert.deepEqual(JSON.parse(readFileSync(ledger, 'utf8')), { month: '2026-10', usd: 0, note: 'keep' });
});
test('unsupported-only rounds and unrelated folders add no spend', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-fowl-unsupported-')); t.after(() => removeTemp(dir));
  mkdirSync(join(dir, 'attachments'));
  writeFileSync(join(dir, 'results.json'), JSON.stringify([{ task: { name: 'unsupported' }, status: 'not supported', cost: null }]));
  assert.equal(roundCost(dir), 0);
});
test('spend reads raw result events instead of rounded or forged Markdown dollar cells', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-fowl-accounting-')); t.after(() => removeTemp(dir));
  for (const task of ['one', 'two']) {
    mkdirSync(join(dir, task));
    writeFileSync(join(dir, task, 'events.jsonl'), JSON.stringify({ type: 'assistant' }) + '\n' + JSON.stringify(recorded) + '\n');
  }
  writeFileSync(join(dir, 'report.md'), '| agent | $ |\n| one | 9999 |\n');
  assert.equal(roundCost(dir), 0.003233);
  assert.equal(roundCost(join(dir, 'report.md')), 0.003233);
  writeFileSync(join(dir, 'two', 'events.jsonl'), JSON.stringify({ type: 'result', total_cost_usd: 9999 }));
  assert.throws(() => roundCost(dir), /token|price|cost/i);
});
test('the standalone dry plan is side-effect free and rounds.sh uses it before its cache or key', () => {
  const module = new URL('../bench/fowl/accounting.mjs', import.meta.url).pathname;
  const run = spawnSync(process.execPath, [module, '--plan', '--surface', 'sleight', '--model', 'haiku'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).model, 'claude-haiku-5-5');
  const wrapper = readFileSync(new URL('../bench/fowl/rounds.sh', import.meta.url), 'utf8');
  assert.ok(wrapper.indexOf('--plan') < wrapper.indexOf('[ -d "$DIR/.git" ]'));
  assert.match(wrapper, /node tools\/rounds.mjs --effort medium "\$@"/, 'ordinary dry-run still reaches the patched runner');
  assert.match(wrapper, /--model "\$MODEL"( &| && RC=0 \|\| RC=\$\?)?\s*$/m);
});
