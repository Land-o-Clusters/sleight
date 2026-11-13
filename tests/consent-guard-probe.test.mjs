import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileProbe, probeHostSource, runProbe, stepVerdict } from '../bench/consent-guard-probe.mjs';
import { macCommandSkip } from './requirements.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

test('missing delivery is inconclusive and acceptance outweighs a refusal receipt', () => {
  assert.equal(stepVerdict([]), 'no-receipt');
  assert.equal(stepVerdict([{ outcome: 'armed' }]), 'no-receipt');
  assert.equal(stepVerdict([{ outcome: 'refused' }]), 'refused');
  assert.equal(stepVerdict([{ outcome: 'refused', reason: 'timing' }]), 'too-soon');
  assert.equal(stepVerdict([{ outcome: 'refused' }, { outcome: 'accepted' }]), 'accepted');
  assert.throws(() => probeHostSource('wrong source'), /CONSENT_PROBE_SOURCE_DRIFT/);
  const instrumented = probeHostSource();
  assert.match(instrumented, /tooSoon \? "timing" : "provenance"/);
  assert.doesNotMatch(instrumented, /alert.buttons\[0\].keyEquivalent = "\\r"/);
});

test('probe compiles without launch and separate poster rejects invalid arguments', { skip: macCommandSkip('xcrun') }, t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-consent-probe-build-'))));
  const binaries = compileProbe(directory);
  assert.ok(existsSync(binaries.host));
  assert.ok(existsSync(binaries.poster));
  for (const args of [[], ['unknown', '123', '10', '20'], ['hidpid', '0', '10', '20']]) {
    const invalid = spawnSync(binaries.poster, args, { encoding: 'utf8', timeout: 10000 });
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /^usage:/);
    assert.equal(invalid.stdout, '');
  }
});

test('probe uses card receipts for all six steps and closes its owned host, fake processes only', async t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-consent-probe-fake-'))));
  const host = join(directory, 'host'), poster = join(directory, 'poster'), stopped = join(directory, 'stopped');
  const shown = join(directory, 'shown');
  writeFileSync(host, `#!${process.execPath}
const { createInterface } = require('node:readline');
  const { writeFileSync } = require('node:fs');
const emit = record => console.log(JSON.stringify(record));
writeFileSync(${JSON.stringify(shown)}, String(Date.now()));
emit({ outcome: 'ready', pid: process.pid, x: 10, y: 20 });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const command = JSON.parse(line);
  if (command.step) {
    emit({ outcome: 'armed', step: command.step });
    setTimeout(() => {
      const accepted = command.step.startsWith('person-');
      emit({ outcome: accepted ? 'accepted' : 'refused', step: command.step });
      if (accepted) {
        writeFileSync(${JSON.stringify(shown)}, String(Date.now()));
        emit({ outcome: 'ready', pid: process.pid, x: 10, y: 20 });
      }
    }, command.step.startsWith('person-') ? 700 : 650);
  }
  if (command.finish) { writeFileSync(${JSON.stringify(stopped)}, 'closed'); lines.close(); process.stdin.destroy(); }
});
`);
  writeFileSync(poster, `#!${process.execPath}
const { readFileSync } = require('node:fs');
const sinceShow = Date.now() - Number(readFileSync(${JSON.stringify(shown)}, 'utf8'));
console.log(JSON.stringify({ mode: process.argv[2], sinceShow }));
process.exitCode = sinceShow >= 600 ? 0 : 1;
`);
  chmodSync(host, 0o700); chmodSync(poster, 0o700);
  const log = [];
  const result = await runProbe({ directory, binaries: { host, poster }, say: record => log.push(record) });
  assert.equal(result.passed, true);
  assert.deepEqual(result.steps.map(({ step, verdict }) => [step, verdict]), [
    ['ax', 'refused'], ['pid', 'refused'], ['hid', 'refused'], ['hidpid', 'refused'], ['person-click', 'accepted'], ['person-return', 'accepted'],
  ]);
  assert.equal(log.filter(record => record.poster).length, 4);
  assert.ok(log.filter(record => record.poster).every(record => JSON.parse(record.attempted).sinceShow >= 600));
  assert.equal(readFileSync(stopped, 'utf8'), 'closed');
  assert.equal(existsSync(join(directory, 'grants.json')), false);
});
