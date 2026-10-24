import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { roundCost, addRoundSpend } from '../bench/fowl/add-spend.mjs';
import { interactiveAgentSetup } from '../bench/world/arms/claude-cu/interactive.mjs';

const now = new Date('2026-10-13T00:00:00Z');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'sleight-fowl-interrupted-'));
  t.after(() => removeTemp(dir));
  return dir;
}
function partial(t, rows) {
  const dir = temp(t);
  for (const { name, funding, missing, model = 'claude-haiku-5-5', legacy = false } of rows) {
    const task = path.join(dir, name); fs.mkdirSync(task);
    const login = funding === 'login';
    const record = { name, model,
      ...(legacy ? { agentConfig: { interactive: login, auth: login ? 'isolated direct-plan login' : 'api' } }
        : { surface: login ? 'claude-cu' : 'sleight', funding }) };
    fs.writeFileSync(path.join(task, legacy ? 'run.json' : 'funding.json'), JSON.stringify(record));
    if (!missing) fs.writeFileSync(path.join(task, 'events.jsonl'), JSON.stringify({ type: 'result',
      modelUsage: { [model]: { inputTokens: 1000000, outputTokens: 1000000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }) + '\n');
  }
  return dir;
}
function ledger(dir) {
  const file = path.join(dir, 'spend.json');
  fs.writeFileSync(file, JSON.stringify({ month: '2026-10', usd: 4, ownerNote: 'preserve' }));
  return file;
}

test('interrupted mixed rounds exclude durable login funding before a final summary', t => {
  const dir = partial(t, [{ name: 'login', funding: 'login' }, { name: 'api', funding: 'api' }]);
  assert.equal(roundCost(dir), 0.6);
});
test('interrupted mixed rounds tolerate a missing login transcript and preserve ledger metadata', t => {
  const dir = partial(t, [{ name: 'login', funding: 'login', missing: true }, { name: 'api', funding: 'api' }]);
  const file = ledger(dir);
  assert.equal(addRoundSpend(dir, file, { now }), 4.6);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { month: '2026-10', usd: 4.6, ownerNote: 'preserve' });
});
test('an interrupted pure-login round with no transcript contributes zero API spend', t => {
  const dir = partial(t, [{ name: 'login', funding: 'login', missing: true }]), file = ledger(dir);
  assert.equal(addRoundSpend(dir, file, { now }), 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { month: '2026-10', usd: 4, ownerNote: 'preserve' });
});
test('legacy interactive task metadata excludes login without a final summary', t => {
  assert.equal(roundCost(partial(t, [{ name: 'login', funding: 'login', legacy: true, missing: true },
    { name: 'api', funding: 'api' }])), 0.6);
});
for (const funding of ['login', 'api']) {
  test(`immutable ${funding} funding survives an interrupted final run-record write`, t => {
    const dir = partial(t, [{ name: 'task', funding }]);
    fs.writeFileSync(path.join(dir, 'task/run.json'), '{');
    assert.equal(roundCost(dir), funding === 'login' ? 0 : 0.6);
  });
}
for (const problem of ['missing', 'unpriced']) {
  test(`an interrupted API task with ${problem} usage still requires reconciliation`, t => {
    const dir = partial(t, [{ name: 'login', funding: 'login', missing: true },
      { name: 'api', funding: 'api', missing: problem === 'missing', model: problem === 'unpriced' ? 'unknown-model' : 'claude-haiku-5-5' }]);
    const file = ledger(dir);
    assert.throws(() => addRoundSpend(dir, file, { now }), /Token cost unavailable for api/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { month: '2026-10', usd: 4, ownerNote: 'preserve', unpriced: true, unpricedRound: dir });
  });
}
test('explicit API funding cannot be excluded by conflicting summary or result metadata', t => {
  const dir = partial(t, [{ name: 'api', funding: 'api' }]);
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify([{ task: { name: 'api' }, surface: 'claude-cu' }]));
  const file = path.join(dir, 'api/run.json'), run = JSON.parse(fs.readFileSync(path.join(dir, 'api/funding.json')));
  run.result = { auth: 'isolated direct-plan login' };
  fs.writeFileSync(file, JSON.stringify(run));
  assert.equal(roundCost(dir), 0.6);
});

for (const funding of [['login'], ['api'], ['login', 'api']]) {
  test(`durable ${funding.join('/')} funding accounts despite a truncated summary`, t => {
    const dir = partial(t, funding.map((value, i) => ({ name: `task-${i}`, funding: value, missing: value === 'login' })));
    fs.mkdirSync(path.join(dir, 'attachments'));
    fs.writeFileSync(path.join(dir, 'results.json'), '[{"task":');
    const file = ledger(dir), usd = funding.includes('api') ? 4.6 : 4;
    assert.equal(addRoundSpend(dir, file, { now }), usd);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { month: '2026-10', usd, ownerNote: 'preserve' });
  });
}
test('known legacy login metadata does not need a complete summary', t => {
  const dir = partial(t, [{ name: 'login', funding: 'login', legacy: true, missing: true },
    { name: 'api', funding: 'api' }]);
  fs.writeFileSync(path.join(dir, 'results.json'), '[');
  assert.equal(roundCost(dir), 0.6);
});
for (const problem of ['missing', 'unpriced']) {
  test(`a truncated summary still refuses ${problem} API usage`, t => {
    const dir = partial(t, [{ name: 'login', funding: 'login', missing: true },
      { name: 'api', funding: 'api', missing: problem === 'missing', model: problem === 'unpriced' ? 'unknown-model' : 'claude-haiku-5-5' }]);
    fs.writeFileSync(path.join(dir, 'results.json'), '[');
    const file = ledger(dir);
    assert.throws(() => addRoundSpend(dir, file, { now }), /Token cost unavailable for api/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { month: '2026-10', usd: 4,
      ownerNote: 'preserve', unpriced: true, unpricedRound: dir });
  });
}
test('legacy funding that needs a truncated summary still requires reconciliation', t => {
  const dir = partial(t, [{ name: 'unknown', funding: 'api' }]);
  fs.rmSync(path.join(dir, 'unknown/funding.json'));
  fs.writeFileSync(path.join(dir, 'unknown/run.json'), JSON.stringify({ model: 'claude-haiku-5-5' }));
  fs.writeFileSync(path.join(dir, 'results.json'), '[');
  const file = ledger(dir);
  assert.throws(() => addRoundSpend(dir, file, { now }), /JSON/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { month: '2026-10', usd: 4,
    ownerNote: 'preserve', unpriced: true, unpricedRound: dir });
});
for (const model of ['claude-haiku-5-5', 'claude-opus-5-5']) {
  test(`interactive setup pins its background model to ${model} and strips host credentials`, t => {
    const dir = temp(t);
    const setup = interactiveAgentSetup({ dir: path.join(dir, 'task'), armDir: path.join(dir, 'arm'),
      prompt: 'Fixture task. Return RESULT ok.', model, hostEnv: { PATH: '/bin', HOME: dir,
        ANTHROPIC_SMALL_FAST_MODEL: 'conflicting-host-model', ANTHROPIC_API_KEY: 'fixture-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' } });
    assert.equal(setup.env.ANTHROPIC_SMALL_FAST_MODEL, model);
    assert.equal(setup.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(setup.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });
}

function patchedSource(t) {
  const cache = path.join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
  if (!fs.existsSync(path.join(cache, '.git'))) { t.skip('pinned FowlBrowser cache is absent'); return; }
  const dir = temp(t); fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'tools/rounds.mjs'), execFileSync('/usr/bin/git', ['-C', cache, 'show', '6a12d60:tools/rounds.mjs']));
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: dir });
  execFileSync('/usr/bin/git', ['apply', new URL('../bench/fowl/sleight-surface.patch', import.meta.url).pathname], { cwd: dir });
  return fs.readFileSync(path.join(dir, 'tools/rounds.mjs'), 'utf8');
}
for (const funding of ['login', 'api']) {
  test(`the patched runner persists ${funding} funding before the inert launch boundary`, t => {
    const source = patchedSource(t); if (!source) return;
    const out = temp(t), surface = funding === 'login' ? 'claude-cu' : 'sleight';
    const body = source.slice(source.indexOf('function runAgentBody('), source.indexOf('// --- Reports ---'));
    let checked = false;
    const run = runInNewContext('(' + body.trim() + ')', { fs, path, remote: null,
      BROWSER_ARMS: ['claude-cu'], roundSettings: () => ({}),
      agentSetup: () => ({ env: funding === 'api' ? { ANTHROPIC_API_KEY: 'fixture-key' } : {},
        ...(funding === 'login' ? { metadata: { interactive: true, auth: 'isolated direct-plan login' } } : {}) }),
      startAgent: (_setup, dir) => {
        assert.ok(fs.existsSync(path.join(dir, 'funding.json')), 'task funding must be durable before launch');
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'funding.json')));
        assert.equal(saved.funding, funding); assert.equal(saved.surface, surface);
        assert.equal(saved.model, 'claude-haiku-5-5');
        checked = true; throw Error('inert launch boundary');
      } });
    assert.throws(() => run({ name: 'fixture' }, out, { model: 'claude-haiku-5-5', surface,
      versionVerified: true }), /inert launch boundary/);
    assert.equal(checked, true);
  });
}
