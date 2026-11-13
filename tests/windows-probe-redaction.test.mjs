import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { redactReport, redactText } from '../bench/windows/kit.mjs';
import { main, parseProbeArgs, probeEngine } from '../bench/windows/probe-engine.mjs';
import { parseSittingArgs, runSitting, validateResult } from '../bench/windows/driver-sitting.mjs';

const schema = 'sleight.windows-engine-probe/1';
const legacySchema = '%USERNAME%.windows-engine-probe/1';
const inventory = extra => ({ schema, engines: [], pipes: [], processes: [], errors: [], searchComplete: true,
  connection: { connected: false, bytesWritten: 0, frames: [], outcome: 'not-requested', framing: 'unknown' }, ...extra });
const dependencies = (extra = {}) => ({ platform: 'win32', env: {},
  execute: async () => ({ status: 0, stdout: JSON.stringify(inventory()), stderr: '' }), ...extra });
const options = parseProbeArgs(['--output', 'unused.json']);

test('Sleight username preserves probe schema and scrubs profile paths and standalone tokens', async () => {
  const report = await probeEngine(options, dependencies({
    env: { USERNAME: 'Sleight', USERPROFILE: 'C:\\Users\\Sleight' },
    execute: async () => ({ status: 0, stdout: JSON.stringify(inventory({
      engines: [{ path: 'C:\\Users\\Sleight\\AppData\\engine.exe' }],
      pipes: ['Sleight', 'SLEIGHT', 'sleightly', 'sleight-worker'],
    })), stderr: '' }),
  }));
  assert.equal(report.schema, schema);
  assert.equal(report.engines[0].path, '%USERPROFILE%\\AppData\\engine.exe');
  assert.deepEqual(report.pipes, ['%USERNAME%', '%USERNAME%', 'sleightly', '%USERNAME%-worker']);
});

test('short usernames and computer names scrub standalone tokens while profile path rules still apply', () => {
  for (const name of ['a', 'ad']) {
    for (const key of ['USERNAME', 'COMPUTERNAME']) {
      assert.equal(redactText('a ad adapter data', { [key]: name }),
        name === 'a' ? `%${key}% ad adapter data` : `a %${key}% adapter data`);
    }
    assert.equal(redactText(`C:\\Users\\${name}\\file.txt`, { USERNAME: name }), '%USERPROFILE%\\file.txt');
  }
  assert.equal(redactText('Z:/Profiles/ad/file.txt', { USERPROFILE: 'Z:\\Profiles\\ad', USERNAME: 'ad' }), '%USERPROFILE%/file.txt');
});

test('identifier replacement requires token boundaries on both sides and escapes regex characters', () => {
  assert.equal(redactText('sleight sleightly xsleight sleight2 _sleight sleight_ -sleight sleight- (SLEIGHT).',
    { USERNAME: 'sleight' }), '%USERNAME% sleightly xsleight sleight2 _%USERNAME% %USERNAME%_ -%USERNAME% %USERNAME%- (%USERNAME%).');
  assert.equal(redactText('NODE nodeword prenode node1 _node node_ -node node- /node/',
    { COMPUTERNAME: 'Node' }), '%COMPUTERNAME% nodeword prenode node1 _%COMPUTERNAME% %COMPUTERNAME%_ -%COMPUTERNAME% %COMPUTERNAME%- /%COMPUTERNAME%/');
  assert.equal(redactText('a.b axb xa.b a.bz (A.B)', { USERNAME: 'a.b' }), '%USERNAME% axb xa.b a.bz (%USERNAME%)');
  assert.equal(redactText('ésleight sleighté sleight', { USERNAME: 'sleight' }), 'ésleight sleighté %USERNAME%');
  assert.equal(redactText('中bob bob中 ١bob bob١ 𝟘bob bob𝟘 bobcat', { USERNAME: 'bob' }),
    '中bob bob中 ١bob bob١ 𝟘bob bob𝟘 bobcat');
});

for (const [name, text, expected] of [
  ['Bob', 'BOB-PC DESKTOP-BOB Bob2 bobcat Bob.exe Bob@host ~bob/ \\\\srv\\share\\Bob\\x \\\\?\\C:\\Users\\Bob',
    '%NAME%-PC DESKTOP-%NAME% Bob2 bobcat %NAME%.exe %NAME%@host ~%NAME%/ \\\\srv\\share\\%NAME%\\x \\\\?\\%USERPROFILE%'],
  ['Sleight', 'sleight-worker Sleight_pc Sleight2 sleightly', '%NAME%-worker %NAME%_pc Sleight2 sleightly'],
  ['john.smith', 'john.smith-1 john.smith john.smith.pc', '%NAME%-1 %NAME% %NAME%.pc'],
  ['VM-PRIVATE', 'vm-private-cua', '%NAME%-cua'],
]) {
  for (const key of ['USERNAME', 'COMPUTERNAME']) test(`${key} scrubs the review leak forms for ${name}`, () => {
    assert.equal(redactText(text, { [key]: name }), expected.replaceAll('%NAME%', `%${key}%`));
  });
}

test('report scrubber preserves only root schema and verdict strings and scrubs every other subtree', () => {
  const input = { schema, verdict: 'passed-phase', mode: 'Sleight', phase: 'Sleight',
    errors: ['Sleight denied', { code: 'Sleight', reason: 'Sleight_pc' }],
    frames: [{ target: 'Sleight', detail: { schema: 'Sleight', verdict: 'Sleight', id: 'Sleight' } }],
    nested: { id: 'Sleight', deep: { code: 'Sleight' } } };
  const original = structuredClone(input);
  assert.deepEqual(redactReport(input, { USERNAME: 'Sleight', COMPUTERNAME: 'passed-phase' }), {
    schema, verdict: 'passed-phase', mode: '%USERNAME%', phase: '%USERNAME%',
    errors: ['%USERNAME% denied', { code: '%USERNAME%', reason: '%USERNAME%_pc' }],
    frames: [{ target: '%USERNAME%', detail: { schema: '%USERNAME%', verdict: '%USERNAME%', id: '%USERNAME%' } }],
    nested: { id: '%USERNAME%', deep: { code: '%USERNAME%' } },
  });
  assert.deepEqual(input, original);
  assert.deepEqual(redactReport([{ schema: 'Sleight', verdict: 'Sleight' }], { USERNAME: 'Sleight' }),
    [{ schema: '%USERNAME%', verdict: '%USERNAME%' }]);
  assert.deepEqual(redactReport({ schema: { note: 'Sleight' }, verdict: ['Sleight'] }, { USERNAME: 'Sleight' }),
    { schema: { note: '%USERNAME%' }, verdict: ['%USERNAME%'] });
});

test('probe questions remain fixed when an identifier matches a generated answer', async () => {
  const report = await probeEngine(options, dependencies({ env: { USERNAME: 'unknown', COMPUTERNAME: 'not-tested' } }));
  assert.equal(report.questions.pipeServer, 'unknown');
  assert.equal(report.questions.externalConnect, 'not-tested');
  assert.equal(report.connection.framing, '%USERNAME%');
});

test('the sitting report writer preserves schema and verdict while scrubbing matching phase values', async () => {
  const report = await runSitting(parseSittingArgs(['--phase', 'inventory', '--output', 'unused.json', '--revision', 'a'.repeat(40)]), {
    platform: 'win32', env: { USERNAME: 'Sleight', COMPUTERNAME: 'inventory' },
    assertUnelevated: async () => {},
    createClient: () => ({ request: async () => ({ windows: [] }), close: async () => {} }),
    execute: async () => assert.fail('no Windows process may start'),
  });
  assert.equal(report.schema, 'sleight.windows-driver-sitting/1');
  assert.equal(report.verdict, 'passed-phase');
  assert.equal(report.phase, '%COMPUTERNAME%');
  assert.throws(() => validateResult(report), /Invalid sitting result/);
});

test('probe scrubs errors and connection frames before publishing inventory', async () => {
  const report = await probeEngine(options, dependencies({ env: { USERNAME: 'Bob', COMPUTERNAME: 'VM-PRIVATE' },
    execute: async () => ({ status: 0, stderr: '', stdout: JSON.stringify(inventory({
      errors: ['DESKTOP-BOB denied'],
      connection: { connected: false, bytesWritten: 0, frames: [{ id: 'vm-private-cua', code: 'BOB-PC' }] },
    })) }),
  }));
  assert.deepEqual(report.errors, ['DESKTOP-%USERNAME% denied']);
  assert.deepEqual(report.connection.frames, [{ id: '%COMPUTERNAME%-cua', code: '%USERNAME%-PC' }]);
});

for (const baselineSchema of [legacySchema, schema]) test(`${baselineSchema} comparison uses scrubbed names without rewriting the baseline`, async () => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-wg2-test-')));
  const baseline = join(root, 'before.json'), output = join(root, 'after.json');
  // Match before-k61a's report shape, with synthetic identity and pipe names.
  const before = inventory({ schema: baselineSchema, observedUtc: '2026-10-31T22:58:52.1747022Z',
    os: 'Microsoft Windows NT 10.0.26300.0', architecture: 'ARM64', packages: [], searchedRoots: [],
    searchComplete: false, searchEntries: 0, bundledNodes: [],
    pipes: ['LOCAL\\mojo.100.200.300', '%USERNAME%-sky', '%COMPUTERNAME%-cua'], pipeCandidates: [],
    processes: [{ pid: 1, parentPid: 10, created: '10/31/2026 15:58:50', name: '%USERNAME%-worker.exe', path: '%USERPROFILE%\\worker.exe' }],
    connection: { requested: false, pipe: '', connected: false, serverPid: 0, bytesWritten: 0, bytesRead: 0,
      framing: 'unknown', frames: [], outcome: 'not-requested', elapsedMs: 0 }, observation: null,
    errors: ['no-install-roots'], questions: { enginePresent: 'unknown', pipeServer: 'unknown' } });
  const bytes = JSON.stringify(before, null, 2) + '\n';
  writeFileSync(baseline, bytes);
  const report = await main(['--output', output, '--baseline', baseline], dependencies({
    env: { USERNAME: 'Sleight', COMPUTERNAME: 'VM-PRIVATE' },
    execute: async () => ({ status: 0, stderr: '', stdout: JSON.stringify(inventory({
      pipes: ['LOCAL\\mojo.100.200.300', 'Sleight-sky', 'vm-private-cua', 'Sleight-new'],
      processes: [{ pid: 1, parentPid: 10, created: '10/31/2026 15:58:50', name: 'Sleight-worker.exe', path: 'C:\\Users\\Sleight\\worker.exe' },
        { pid: 2, created: 'after', name: 'vm-private-worker.exe', path: 'C:\\Users\\Sleight\\worker.exe' }],
    })) }),
  }));
  assert.equal(Object.hasOwn(report, 'baselineSchemaRepaired'), baselineSchema === legacySchema);
  assert.deepEqual(report.comparison.newPipes, ['%USERNAME%-new']);
  assert.deepEqual(report.comparison.newProcesses, [{ pid: 2, created: 'after', name: '%COMPUTERNAME%-worker.exe', path: '%USERPROFILE%\\worker.exe' }]);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), report);
  assert.equal(readFileSync(baseline, 'utf8'), bytes);
});

test('baseline file with the exact legacy schema is accepted, compared and marked in the saved report', async () => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-wg1-test-')));
  const baseline = join(root, 'before.json'), output = join(root, 'after.json');
  const before = inventory({ schema: legacySchema, pipes: ['old'], processes: [{ pid: 1, created: 'before' }] });
  writeFileSync(baseline, JSON.stringify(before));
  const report = await main(['--output', output, '--baseline', baseline], dependencies({
    execute: async () => ({ status: 0, stdout: JSON.stringify(inventory({ pipes: ['old', 'new'],
      processes: [{ pid: 1, created: 'before' }, { pid: 2, created: 'after' }] })), stderr: '' }),
  }));
  assert.equal(report.schema, schema);
  assert.equal(report.baselineSchemaRepaired, true);
  assert.deepEqual(report.comparison.newPipes, ['new']);
  assert.deepEqual(report.comparison.newProcesses, [{ pid: 2, created: 'after' }]);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).baselineSchemaRepaired, true);
  assert.deepEqual(JSON.parse(readFileSync(baseline, 'utf8')), before);
});

test('canonical baselines are not marked repaired and all other schema variants are refused', async () => {
  const report = await probeEngine(options, dependencies({ baseline: inventory() }));
  assert.equal(Object.hasOwn(report, 'baselineSchemaRepaired'), false);
  for (const bad of ['%COMPUTERNAME%.windows-engine-probe/1', '%username%.windows-engine-probe/1',
    '%USERNAME%.windows-engine-probe/2', 'Sleight.windows-engine-probe/1', schema + ' ', '', null]) {
    await assert.rejects(probeEngine(options, dependencies({ baseline: inventory({ schema: bad }) })), /Invalid baseline report/);
  }
});

test('legacy schema acceptance still validates the baseline inventory', async () => {
  for (const bad of [{ pipes: null }, { processes: {} }, { pipes: [null] }, { processes: [null] },
    { processes: [{ pid: '1', created: 'before' }] }, { processes: [{ pid: 1 }] }]) {
    await assert.rejects(probeEngine(options, dependencies({ baseline: inventory({ schema: legacySchema, ...bad }) })), /Invalid baseline report/);
  }
});

test('explicit non-report baselines are refused instead of silently disabling comparison', async () => {
  for (const baseline of [null, false, 0, '', [], {}]) {
    await assert.rejects(probeEngine(options, dependencies({ baseline })), /Invalid baseline report/);
  }
});
