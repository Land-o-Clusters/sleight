import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TOKEN, reproductionPlan, analyzeReproduction, main } from '../bench/hardware-double-keys.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const trial = extra => ({ stage: 'many-idle', observed: TOKEN, inputCalls: 0, forwardedInputs: 0, ...extra });
const analyze = trials => analyzeReproduction({ version: 1, trials });
const double = [...TOKEN].map(char => char + char).join('');

test('default and dry-run only print the complete owner-present worksheet', async () => {
  for (const args of [[], ['--dry-run']]) {
    const output = []; assert.equal(await main(args, text => output.push(text)), 0);
    assert.deepEqual(JSON.parse(output.join('')), reproductionPlan());
  }
  const plan = reproductionPlan();
  assert.equal(plan.automation, false); assert.equal(plan.trialsPerStage, 3); assert.equal(plan.stages.length, 7);
  assert.match(plan.instructions.join('\n'), /Physically type/);
  assert.match(plan.limits, /No live collector/);
});

test('clean physical trials do not reproduce a failure', () => {
  const result = analyze([trial(), trial(), trial()]);
  assert.equal(result.single, 3); assert.equal(result.doubled, 0); assert.equal(result.verdict, 'not-reproduced');
});

test('an exact doubled hardware token without any tool input remains unattributed', () => {
  const result = analyze([trial({ observed: double })]);
  assert.equal(result.doubled, 1); assert.equal(result.verdict, 'reproduced-without-process-attribution');
  assert.equal(result.rows[0].signature, 'hardware-doubling-without-requested-input');
});

test('optional passive counts distinguish session-visible and downstream copies', () => {
  const result = analyze([trial({ observed: double, hidDown: TOKEN.length, sessionDown: 2 * TOKEN.length }),
    trial({ observed: double, hidDown: TOKEN.length, sessionDown: TOKEN.length }),
    trial({ observed: double, hidDown: 100, sessionDown: 100 })]);
  assert.deepEqual(result.rows.map(row => row.signature), ['extra-session-events', 'downstream-of-session-observer', 'event-counts-inconclusive']);
});

test('unknown counts stay unknown and active tool inputs do not qualify as an idle repro', () => {
  const result = analyze([trial({ observed: double, hidDown: null, sessionDown: null }),
    trial({ observed: double, inputCalls: 1 }), trial({ observed: double, forwardedInputs: 1 }), trial({ observed: 'other' })]);
  assert.equal(result.rows[0].signature, 'hardware-doubling-without-requested-input');
  assert.deepEqual(result.rows.slice(1).map(row => row.signature), ['not-isolated', 'not-isolated', 'not-isolated']);
  assert.equal(result.other, 1);
});

test('evidence requires explicit valid stages and measured nonnegative counts', () => {
  for (const extra of [{ stage: 'made-up' }, { inputCalls: undefined }, { forwardedInputs: -1 },
    { hidDown: '9' }, { sessionDown: -1 }, { observed: 'x'.repeat(129) }]) assert.throws(() => analyze([trial(extra)]), /Invalid trial/);
  for (const value of [{}, { version: 2, trials: [trial()] }, { version: 1, trials: [] },
    { version: 1, trials: Array(1001).fill(trial()) }]) assert.throws(() => analyzeReproduction(value), /Expected version/);
});

test('no argument can accidentally enable a live run', async () => {
  for (const args of [['--live'], ['--owner-present'], ['--dry-run', '--live'], ['--analyze']])
    await assert.rejects(main(args), /No live mode exists/);
});

test('analyzer reads only the explicit bounded data file', async t => {
  const bank = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-hardware-double-'))), path = join(bank, 'evidence.json');
  writeFileSync(path, JSON.stringify({ version: 1, trials: [trial({ observed: double })] }));
  const output = []; assert.equal(await main(['--analyze', path], text => output.push(text)), 0);
  assert.equal(JSON.parse(output.join('')).doubled, 1);
  writeFileSync(path, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(main(['--analyze', path]), /at most 1 MiB/);
  await assert.rejects(main(['--analyze', bank]), /regular JSON file/);
  const link = join(bank, 'linked.json'); symlinkSync(path, link);
  await assert.rejects(main(['--analyze', link]), { code: 'ELOOP' });
});
