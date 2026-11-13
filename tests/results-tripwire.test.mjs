import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectBank, FAMILIES, main, readBank, renderValidationPage } from '../bench/results-hub.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

function fixture(t) {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-tripwire-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'validation-160a'); mkdirSync(dir);
  const put = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
  const identity = { startedAt: '2026-11-07T15:00:00Z', builds: { A: 'a'.repeat(40), B: 'b'.repeat(40) } };
  const steps = [];
  for (const side of ['A', 'B']) for (const n of [1, 2]) {
    const id = `native-${side}-r${n}`;
    const step = { id, side, kind: 'native-haiku', tasks: 'one,two,excluded' }; steps.push(step);
    put(`${id}.receipt.json`, { ...step, build: identity.builds[side], rc: 0, runnerRc: 0,
      result: `/old/bank/${id}.json`, startedAt: identity.startedAt, endedAt: '2026-11-07T16:00:00Z',
      engine: { version: '26.1027.51404', build: '23880' }, engineEnd: { version: '26.1027.51404', build: '23880' },
      command: ['--model', 'claude-haiku-5-5', '--effort', 'high'] });
    put(`${id}.json`, { model: 'claude-haiku-5-5', effort: 'high', results: [
      { arm: 'sleight', task: 'one', seconds: side === 'A' ? n * 10 : n * 20, passed: true, models: ['actual-model'] },
      { arm: 'sleight', task: 'two', seconds: 50, passed: n === 1, reason: 'wrong value', models: ['actual-model'] },
      { arm: 'sleight', task: 'excluded', seconds: 30, passed: true, models: ['actual-model'] },
    ] });
  }
  steps.push({ id: 'not-run', side: 'A', kind: 'safari-haiku', tasks: 'later' });
  put('schedule.json', steps); put('queue-identity.json', identity);
  put('exclusions.json', { entries: [{ task: 'excluded', kinds: ['native-haiku'], sides: ['A', 'B'], reason: 'fixture failed twice' }] });
  put('verdict.json', { identity, verdicts: [{ kind: 'native-haiku', runs: 2, passA: 3, passB: 3,
    aTotal: 65, bTotal: 80, slowdown: 80 / 65 - 1, limit: .425, comparableTasks: 2, reasons: [],
    tasks: [{ task: 'one' }, { task: 'two' }] }], errors: [] });
  return { root, dir, put, steps };
}

test('partial tripwire keeps failures, exclusions, actual model ids and both timing statistics', t => {
  const { dir } = fixture(t);
  const bank = readBank(dir);
  assert.ok(bank, 'a tripwire needs no final-verdict.json or plan.json');
  const { record, studies: [s] } = collectBank(bank);
  assert.equal(record.complete, false);
  assert.equal(record.tripwire.groups[0].aPassingTotal, 60);
  assert.equal(record.tripwire.groups[0].bPassingTotal, 70);
  assert.equal(record.tripwire.groups[0].aTotal, 65);
  assert.equal(s.runs.length, 8);
  assert.equal(s.runs.filter(r => !r.passed).length, 2);
  assert.equal(record.tripwire.excludedRuns.length, 4);
  assert.deepEqual(s.models['build-A'], ['actual-model']);
  assert.deepEqual(s.effortBySide['build-B'], ['high']);
  assert.match(s.engine, /26.1027.51404 build 23880/);
  assert.equal(record.tripwire.steps.at(-1).status, 'not run');
  const md = renderValidationPage({ validation: { banks: [record], studies: [s] } }, 'validation');
  assert.match(md, /1\.6\.0 tripwire A\/B/);
  assert.match(md, /owner.*first rounds/i);
  assert.match(md, /mean attempt/i);
  assert.match(md, /passing lower.median/i);
  assert.match(md, /fixture failed twice/);
  assert.match(md, /not-run/);
  assert.match(md, /did not establish a skill cause/);
});

test('tripwire refuses a stale saved gate instead of publishing inconsistent totals', t => {
  const { dir, put } = fixture(t);
  const verdict = JSON.parse(readFileSync(join(dir, 'verdict.json')));
  verdict.verdicts[0].aTotal = 999; put('verdict.json', verdict);
  assert.throws(() => collectBank(readBank(dir)), /gate.*disagree/i);
});

test('stopped receipt retains its failed result without scoring an unfinished group', t => {
  const { dir, put, steps } = fixture(t);
  const id = steps[0].id;
  const r = JSON.parse(readFileSync(join(dir, `${id}.receipt.json`)));
  put(`${id}.receipt.json`, { ...r, rc: 1, reason: 'cleanup unconfirmed' });
  rmSync(join(dir, 'verdict.json'));
  const { record, studies: [s] } = collectBank(readBank(dir));
  assert.equal(record.tripwire.groups[0].status, 'incomplete');
  assert.equal(record.tripwire.groups[0].slowdown, null);
  assert.equal(s.runs.length, 8);
  assert.equal(record.tripwire.steps[0].status, 'stopped');
});

test('receipt identity mismatches fail before collecting task data', t => {
  const { dir, put, steps } = fixture(t);
  const id = steps[0].id, r = JSON.parse(readFileSync(join(dir, `${id}.receipt.json`)));
  put(`${id}.receipt.json`, { ...r, build: 'c'.repeat(40) });
  assert.throws(() => collectBank(readBank(dir)), /receipt identity mismatch/);
});

test('stopped native results are recovered from the logged owned result path', t => {
  const { root, dir, put, steps } = fixture(t), id = steps[0].id;
  const r = JSON.parse(readFileSync(join(dir, `${id}.receipt.json`)));
  const host = join(root, 'host'), path = join(host, 'bench/results/stopped.json');
  mkdirSync(join(host, 'bench/results'), { recursive: true });
  cpSync(join(dir, `${id}.json`), path);
  rmSync(join(dir, `${id}.json`)); rmSync(join(dir, 'verdict.json'));
  put(`${id}.receipt.json`, { ...r, result: undefined, root: host, rc: 1, reason: 'cleanup unconfirmed' });
  writeFileSync(join(dir, `${id}.log`), `STOP: cleanup unconfirmed\nresults: ${path}\n`);
  const { record, studies: [s] } = collectBank(readBank(dir));
  assert.equal(s.runs.filter(r => r.round === id).length, 2);
  assert.equal(s.runs.find(r => r.round === id).receiptStatus, 'stopped');
  assert.equal(record.tripwire.groups[0].status, 'incomplete');
  assert.equal(record.tripwire.groups[0].limit, .425);
});

test('validation-only collection preserves every other family and the root README', t => {
  const { root, dir } = fixture(t), out = join(root, 'hub');
  mkdirSync(join(out, 'data'), { recursive: true });
  const repo = new URL('..', import.meta.url).pathname;
  for (const f of FAMILIES) cpSync(join(repo, 'docs/results/data', `${f.id}.json`), join(out, 'data', `${f.id}.json`));
  const readme = readFileSync(join(repo, 'README.md'), 'utf8');
  main(['--validation-only', '--hub-only', '--bank', dir, '--out', out]);
  for (const f of FAMILIES.filter(f => f.id !== 'validation')) assert.equal(
    readFileSync(join(out, 'data', `${f.id}.json`), 'utf8'), readFileSync(join(repo, 'docs/results/data', `${f.id}.json`), 'utf8'));
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), readme);
  assert.match(readFileSync(join(out, 'validation.md'), 'utf8'), /1\.6\.0 tripwire A\/B/);
});
