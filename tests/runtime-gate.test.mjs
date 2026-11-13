import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PARITY_MANIFEST, RELEASE_POLICY, canonicalProbePlan, gateVerdict, gateMarkdown, verifyParityResult,
  validRuntimeReceipt, assertStep1, scoreReleaseGroups, loadParityProof } from '../bench/runtime-gate.mjs';
import { OWN_BUILD, ENGINE, SOURCE, DRIVER, receipt, engineReceipt, metadata, step1Report, processEvidence } from './runtime-gate-fixtures.mjs';

const context = () => ({ build: OWN_BUILD, engine: ENGINE, sleightCommit: SOURCE.sleightCommit, driverIdentity: DRIVER });
const groups = () => Object.keys(RELEASE_POLICY.limits).map(id => ({ id,
  runs: Array.from({ length: 10 }, (_, i) => (i % 2 ? ['own', 'engine'] : ['engine', 'own']).map((runtime, side) => ({
    sequence: i * 2 + side + 1, round: i + 1, task: 'fixture-task', runtime, passed: true, seconds: 100, sessionId: 'release-session',
    runNonce: `synthetic-release-${id}-${i}-${side}`, buildStart: metadata(runtime), buildEnd: metadata(runtime),
    processEvidence: processEvidence(runtime), ...(runtime === 'own'
      ? { runtimeReceipt: receipt(`synthetic-release-${id}-${i}-${side}`) } : { engineReceipt: engineReceipt() }) }))).flat() }));
const seconds = (group, ownSeconds) => group.runs.filter(run => run.runtime === 'own').forEach(run => { run.seconds = ownSeconds; });
const proof = () => ({ schema: 'sleight.runtime-parity-proof/1', runtime: 'own', ...context(),
  rows: PARITY_MANIFEST.rows.map(row => ({ id: row.id, status: 'pass', reference: 'synthetic-result.json',
    verified: true, check: 'runtime-side/' + row.id, ...(row.id === 'laws-release-ab' && { groups: groups() }) })) });
const steps = () => ({ step1: { passed: true, complete: true, verdict: 'step1: mechanisms-pass', driverIdentity: DRIVER },
  step2: { passed: true, complete: true, verdict: 'step2: speed-pass', driverIdentity: DRIVER } });

test('the canonical manifest contains every RT1 row and the stricter LAWS requirements', () => {
  assert.equal(PARITY_MANIFEST.rows.length, 46);
  for (let n = 1; n <= 44; n++) assert.equal(PARITY_MANIFEST.rows.filter(row => row.id === `rt1-${String(n).padStart(2, '0')}`).length, 1);
  for (const row of PARITY_MANIFEST.rows) {
    assert.ok(row.capability.length > 5); assert.ok(row.proofRequired.length > 5); assert.equal(row.check, 'runtime-side/' + row.id);
    assert.equal(row.testFile, `tests/runtime-parity/${row.id}.test.mjs`);
    assert.equal(row.resultFile, `runtime-parity/${row.id}.json`);
    if (row.id.startsWith('rt1-')) assert.equal(row.proofStatus, 'engine-only, runtime proof missing');
  }
  assert.match(PARITY_MANIFEST.rows.find(row => row.id === 'rt1-09').capability, /double-click/);
  assert.match(PARITY_MANIFEST.rows.find(row => row.id === 'rt1-17').capability, /approval card/);
  assert.match(PARITY_MANIFEST.rows.find(row => row.id === 'laws-background-hover').capability, /without taking focus/);
  assert.equal(canonicalProbePlan().length, 29);
  assert.throws(() => PARITY_MANIFEST.rows.pop(), TypeError);
});
test('one untested parity row makes the combined verdict incomplete and is listed in Markdown', () => {
  const parity = proof(); parity.rows = parity.rows.filter(row => row.id !== 'rt1-10');
  const gate = gateVerdict({ ...context(), ...steps(), parity });
  assert.equal(gate.verdict, 'incomplete'); assert.equal(gate.passed, false);
  assert.equal(gate.unproven.length, 46); assert.ok(gate.unproven.includes('rt1-10')); assert.match(gateMarkdown(gate).join('\n'), /rt1-10 \(unproven\).*drag/);
});
test('both steps plus every bound runtime-side parity proof are required', () => {
  const data = { ...context(), ...steps(), parity: proof() };
  assert.equal(gateVerdict(data).verdict, 'incomplete', 'self-attested verified flags cannot prove any row');
  for (const key of ['step1', 'step2', 'parity']) assert.equal(gateVerdict({ ...data, [key]: undefined }).verdict, 'incomplete', key);
  assert.equal(gateVerdict({ ...data, step1: { passed: true, verdict: 'pass' } }).verdict, 'incomplete');
  assert.equal(gateVerdict({ ...data, step2: { passed: true, verdict: 'pass' } }).verdict, 'incomplete');
  assert.equal(gateVerdict({ ...data, step1: { ...data.step1, complete: false } }).verdict, 'incomplete');
  assert.equal(gateVerdict({ ...data, step2: { ...data.step2, complete: false } }).verdict, 'incomplete');
});
test('a failed parity row fails even if other rows or steps are unproven', () => {
  const parity = proof(); parity.rows[8].status = 'fail'; parity.rows.pop();
  const gate = gateVerdict({ ...context(), parity });
  assert.equal(gate.verdict, 'fail'); assert.deepEqual(gate.failed, ['rt1-09']);
  assert.equal(gateVerdict({ ...context(), ...steps(), parity: proof(), step2: { complete: true, passed: false } }).verdict, 'fail');
});
test('a generic pass, stale build, engine, commit or engine-side proof is unproven', () => {
  for (const change of [p => { p.runtime = 'engine'; }, p => { p.build = { ...OWN_BUILD, sourceSha256: '3'.repeat(64) }; },
    p => { p.engine = { ...ENGINE, build: 'other' }; }, p => { p.engine = { ...ENGINE, version: 'other' }; },
    p => { p.sleightCommit = 'other'; }, p => { p.rows[0].reference = ''; }, p => { delete p.rows[0].check; }, p => { p.rows[0].check = 'unrelated'; }, p => { delete p.rows[0].verified; },
    p => { p.rows.push(p.rows[0]); }]) {
    const parity = proof(); change(parity); assert.equal(gateVerdict({ ...context(), ...steps(), parity }).verdict, 'incomplete');
  }
});
test('runtime receipt requires the serving driver nonce echo, version, build and request counter', () => {
  const nonce = 'unique-synthetic-run-nonce';
  assert.equal(validRuntimeReceipt(receipt(nonce), { nonce, build: OWN_BUILD, processEvidence: processEvidence() }), true);
  for (const change of [r => { r.runNonce = 'old-run'; }, r => { delete r.ping.runNonce; }, r => { r.ping.runNonce = 'old-run'; },
    r => { r.driverRequests = 0; }, r => { r.engineHelperStarts = 1; }, r => { r.driverVersion = ''; },
    r => { r.driverBuild = 'other'; }, r => { r.ping.build = '3'.repeat(64); }, r => { delete r.ping.apiVersion; },
    r => { r.runtimeBuild = { ...OWN_BUILD, sourceSha256: '3'.repeat(64) }; }]) {
    const value = receipt(nonce); change(value); assert.equal(validRuntimeReceipt(value, { nonce, build: OWN_BUILD, processEvidence: processEvidence() }), false);
  }
  assert.equal(validRuntimeReceipt(undefined, { nonce, build: OWN_BUILD, processEvidence: processEvidence() }), false);
  const separateHashes = receipt(nonce); separateHashes.driverSourceBuild = separateHashes.ping.build = '3'.repeat(64);
  assert.equal(validRuntimeReceipt(separateHashes, { nonce, build: OWN_BUILD, processEvidence: processEvidence() }), true);
  assert.equal(validRuntimeReceipt(receipt(nonce), { nonce, build: OWN_BUILD }), false, 'the receipt cannot attest its own process inventory');
});
test('step 2 accepts only a complete step-1 report for its source and unchanged engine build', () => {
  assert.doesNotThrow(() => assertStep1(step1Report(), context()));
  for (const change of [r => { r.runtime = 'engine'; }, r => { r.verdict.verdict = 'pass'; },
    r => { r.cells.pop(); r.plan.pop(); }, r => { r.cells[0].trialsData.pop(); },
    r => { r.build.sleightCommit = 'other'; }, r => { r.build.engineVersion = 'other'; }, r => { r.build.engineBuild = 'other'; },
    r => { r.build.runtimeBuild = { ...OWN_BUILD, sourceSha256: '4'.repeat(64) }; }, r => { r.cleanupConfirmed = false; },
    r => { r.driverIdentity.build = '3'.repeat(64); },
    r => { delete r.cells[0].trialsData[0].runtimeReceipt; }, r => { r.cells[0].trialsData[0].evidence.windowClosed = false; },
    r => { r.cells.find(row => row.group === 6).baselineData[0].buildEnd.engineBuild = 'other'; },
    r => { r.cells.find(row => row.group === 6).order[0] = 'own'; }, r => { r.cells.find(row => row.group === 6).p50Ms = 0; }]) {
    const report = structuredClone(step1Report()); change(report); assert.throws(() => assertStep1(report, context()), /STEP1_REQUIRED/);
  }
});
test('step 2 rejects a sitting-marked file even with every canonical qualification receipt intact', () => {
  const report = step1Report();
  assert.doesNotThrow(() => assertStep1(report, context()));
  report.sitting = true;
  assert.throws(() => assertStep1(report, context()), /STEP1_REQUIRED/);
});
test('release parity enforces all eight per-group limits, two-pass loss, ABBA and total speed', () => {
  assert.equal(scoreReleaseGroups(groups(), context()).passed, true);
  assert.deepEqual(RELEASE_POLICY.limits, { 'chrome-haiku': 0.08, 'chrome-opus': 0.2, 'native-haiku': 0.2,
    'safari-haiku': 0.2, 'firefox-haiku': 0.08, 'as3-safari': 0.2, 'as3-firefox': 0.08, 'cc-haiku': 0.2 });
  for (const [id, limit] of Object.entries(RELEASE_POLICY.limits)) {
    const data = groups(), target = data.find(group => group.id === id);
    seconds(target, 100 * (1 + limit));
    seconds(data.find(group => group.id !== id), 50);
    assert.equal(scoreReleaseGroups(data, context()).passed, true, id + ' inclusive boundary');
    seconds(target, 100 * (1 + limit) + 0.01);
    assert.match(scoreReleaseGroups(data, context()).reasons.join(','), new RegExp(id + ': exceeds'));
  }
  for (const change of [g => g.pop(), g => { g[0].runs.filter(run => run.runtime === 'own').slice(0, 2).forEach(run => { run.passed = false; }); }, g => { g[0].runs[1].runtime = 'engine'; },
    g => { g[0].runs[1].sessionId = 'other'; }, g => { seconds(g[0], 101); }]) {
    const data = groups(); change(data); assert.equal(scoreReleaseGroups(data, context()).passed, false);
  }
  const parity = proof(); parity.rows.find(row => row.id === 'laws-release-ab').groups[0].runs.filter(run => run.runtime === 'own').slice(0, 2).forEach(run => { run.passed = false; });
  assert.equal(gateVerdict({ ...context(), ...steps(), parity }).verdict, 'fail');
});
test('zero-pass groups and forged summary labels cannot supply release medians or ABBA order', () => {
  let data = groups(); data.forEach(group => { group.runs.forEach(run => { run.passed = false; });
    Object.assign(group, { engineSeconds: 100, ownSeconds: 100, enginePasses: 0, ownPasses: 0, statistic: 'passing-median', order: 'ABBA' }); });
  assert.equal(scoreReleaseGroups(data, context()).passed, false);
  assert.match(scoreReleaseGroups(data, context()).reasons.join(','), /no passing median/);
  const parity = proof(); parity.rows.find(row => row.id === 'laws-release-ab').groups = data;
  assert.equal(gateVerdict({ ...context(), ...steps(), parity }).verdict, 'fail');
  data = groups(); data[0].runs.sort((a, b) => a.runtime.localeCompare(b.runtime));
  Object.assign(data[0], { order: 'ABBA', statistic: 'passing-median' });
  assert.equal(scoreReleaseGroups(data, context()).passed, false);
  data = groups(); data[0].ownSeconds = 1;
  assert.match(scoreReleaseGroups(data, context()).reasons.join(','), /differs from recorded runs/);
  data = groups(); data[0].runs.find(run => run.runtime === 'own').seconds = 10000;
  assert.equal(scoreReleaseGroups(data, context()).passed, true, 'a passing outlier does not replace the passing median');
  data[0].runs.filter(run => run.runtime === 'own').forEach(run => { run.seconds = 10000; run.passed = false; });
  assert.equal(scoreReleaseGroups(data, context()).passed, false);
  assert.equal(RELEASE_POLICY.laws.commit, '662e8ed410cc27dfbd2dc0a1d5a2e4e94bca13da');
  assert.equal(RELEASE_POLICY.laws.lines, '57-62');
});
test('release runs require their own receipts, unique nonces and step-1 build and engine evidence', () => {
  assert.equal(scoreReleaseGroups(groups()).passed, false, 'no qualified context');
  const changes = [
    run => { delete run.runtimeReceipt; }, run => { delete run.processEvidence; },
    run => { run.runtimeReceipt.runNonce = 'different-run-nonce'; },
    run => { run.processEvidence.binary.sha256After = '0'.repeat(64); },
    run => { run.processEvidence.samples[2].helpers = processEvidence('engine').samples[1].helpers; },
    run => { run.buildStart.sleightCommit = run.buildEnd.sleightCommit = 'other'; },
    run => { run.buildStart.engineBuild = run.buildEnd.engineBuild = 'other'; },
    run => { run.buildEnd.sleightDirty = true; },
    run => { run.buildStart.runtimeBuild = run.buildEnd.runtimeBuild = { ...OWN_BUILD, sourceSha256: '0'.repeat(64) }; },
    run => { run.runtimeReceipt.driverBuild = run.processEvidence.binary.sha256 = run.processEvidence.binary.sha256After = '0'.repeat(64); },
    run => { run.runtimeReceipt.driverVersion = '2'; run.runtimeReceipt.ping.apiVersion = 2; },
  ];
  for (const change of changes) {
    const data = groups(); change(data[0].runs.find(run => run.runtime === 'own'));
    assert.match(scoreReleaseGroups(data, context()).reasons.join(','), /per-run runtime evidence incomplete/);
  }
  for (const change of [run => { delete run.engineReceipt; }, run => { delete run.processEvidence; },
    run => { run.engineReceipt.engineBuild = 'other'; }, run => { run.runtimeReceipt = receipt(run.runNonce); },
    run => { run.processEvidence.samples[1].drivers = processEvidence().samples[1].drivers; }]) {
    const data = groups(); change(data[0].runs[0]);
    assert.equal(scoreReleaseGroups(data, context()).passed, false);
  }
  const data = groups(); data[1].runs[0].runNonce = data[0].runs[0].runNonce;
  assert.equal(scoreReleaseGroups(data, context()).passed, false, 'engine nonces cannot be reused across groups either');
});

test('a completed zero-pass mechanism fails the combined gate after the fix round', () => {
  assert.equal(gateVerdict({ step1: { passed: false, complete: false,
    verdict: 'step1: stop-program', zeroMechanisms: ['covered-click-calculator'] } }).verdict, 'fail');
  assert.equal(gateVerdict({ step1: { passed: false, complete: false,
    verdict: 'step1: stopped', zeroMechanisms: [] } }).verdict, 'incomplete');
});
test('static imports never import the live claim runner', () => {
  for (const name of ['runtime-gate', 'runtime-probe', 'runtime-probe-live', 'runtime-arm']) {
    const source = readFileSync(new URL(`../bench/${name}.mjs`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /import\s*(?:\(|[^;\n]*from\s*)['"]\.\/run\.mjs/);
  }
});

test('parity proofs require a matching runtime-side artifact and record its hash', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rt13-parity-unit-'));
  try {
    const parity = proof(), manifest = join(dir, 'proof.json');
    mkdirSync(join(dir, 'runtime-parity'));
    const result = join(dir, PARITY_MANIFEST.rows[0].resultFile);
    parity.rows[0].reference = PARITY_MANIFEST.rows[0].resultFile;
    writeFileSync(manifest, JSON.stringify(parity));
    // Caller-supplied verified flags are discarded when evidence is loaded.
    assert.equal(gateVerdict({ ...context(), ...steps(), parity: loadParityProof(manifest) }).verdict, 'incomplete');
    const artifact = { schema: 'sleight.runtime-parity-result/1', runtime: 'own', ...context(),
      checks: parity.rows.map(({ id, check, status, groups }) => ({ id, check, status, groups })) };
    writeFileSync(result, JSON.stringify(artifact));
    parity.rows[0].resultSha256 = createHash('sha256').update(readFileSync(result)).digest('hex');
    writeFileSync(manifest, JSON.stringify(parity));
    let loaded = loadParityProof(manifest);
    assert.equal(gateVerdict({ ...context(), ...steps(), parity: loaded }).verdict, 'incomplete');
    assert.equal(loaded.rows[0].verified, false);
    assert.equal(loaded.rows[0].artifactSha256, parity.rows[0].resultSha256);
    artifact.checks.pop(); writeFileSync(result, JSON.stringify(artifact));
    loaded = loadParityProof(manifest);
    assert.equal(gateVerdict({ ...context(), ...steps(), parity: loaded }).verdict, 'incomplete');
    artifact.build = { ...OWN_BUILD, sourceSha256: '3'.repeat(64) }; writeFileSync(result, JSON.stringify(artifact));
    assert.ok(loadParityProof(manifest).rows.every(row => row.verified === false));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runtime parity results bind the named producer, raw test output, build, engine and nonce receipt', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rt13-result-unit-'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  try {
    mkdirSync(join(dir, 'tests')); mkdirSync(join(dir, 'runtime-parity'));
    const expected = { id: 'fixture', check: 'runtime-side/fixture', proofStatus: 'runtime-proof',
      testFile: 'tests/runtime-fixture.test.mjs', resultFile: 'runtime-parity/fixture.json' };
    const source = '// synthetic runtime producer';
    let output = 'TAP version 13\nok 1 - runtime fixture\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n';
    writeFileSync(join(dir, expected.testFile), source);
    const artifact = { schema: 'sleight.runtime-parity-result/2', runtime: 'own', ...context(), id: expected.id,
      check: expected.check, runNonce: 'unique-synthetic-run-nonce', runtimeReceipt: receipt('unique-synthetic-run-nonce'),
      processEvidence: processEvidence(), producer: { file: expected.testFile, sha256: hash(source) },
      output: { file: 'runtime-parity/fixture.tap', sha256: hash(output) }, exitCode: 0, tests: 1, failures: 0 };
    output += '# runtime-evidence ' + JSON.stringify(Object.fromEntries(
      ['runNonce', 'build', 'engine', 'sleightCommit', 'runtimeReceipt', 'processEvidence', 'producer'].map(key => [key, artifact[key]]))) + '\n';
    artifact.output.sha256 = hash(output); writeFileSync(join(dir, artifact.output.file), output);
    const verify = value => verifyParityResult(value, { expected, parity: context(), baseDirectory: dir, root: dir });
    assert.equal(verify(artifact), true);
    for (const change of [a => { a.output.sha256 = '0'.repeat(64); }, a => { a.producer.sha256 = '0'.repeat(64); },
      a => { a.producer.file = 'tests/engine.test.mjs'; }, a => { a.build = { ...OWN_BUILD, sourceSha256: '0'.repeat(64) }; },
      a => { a.engine.version = 'other'; }, a => { a.engine.build = 'other'; }, a => { delete a.runtimeReceipt; },
      a => { a.runNonce = 'stale-synthetic-run-nonce'; }, a => { delete a.processEvidence; }, a => { a.exitCode = 1; }]) {
      const value = structuredClone(artifact); change(value); assert.equal(verify(value), false);
    }
    writeFileSync(join(dir, 'runtime-parity/fixture.tap'), 'hand-written JSON status: pass');
    artifact.output.sha256 = hash('hand-written JSON status: pass'); assert.equal(verify(artifact), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('parity rejects a self-consistent driver that differs from the step-1 identity', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rt13-driver-proof-unit-'));
  const hash = value => createHash('sha256').update(value).digest('hex');
  try {
    const expected = { id: 'fixture', check: 'runtime-side/fixture', proofStatus: 'runtime-proof',
      testFile: 'fixture.test.mjs', resultFile: 'fixture.json' };
    writeFileSync(join(dir, expected.testFile), '// synthetic test');
    const original = { schema: 'sleight.runtime-parity-result/2', runtime: 'own', ...context(),
      id: expected.id, check: expected.check, runNonce: 'unique-parity-proof-nonce', runtimeReceipt: receipt('unique-parity-proof-nonce'),
      processEvidence: processEvidence(), producer: { file: expected.testFile, sha256: hash('// synthetic test') },
      output: { file: 'fixture.tap' }, exitCode: 0, tests: 1, failures: 0 };
    const verify = (artifact, parity = context()) => {
      const tap = 'TAP version 13\nok 1 - fixture\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n' +
        '# runtime-evidence ' + JSON.stringify(Object.fromEntries(
          ['runNonce', 'build', 'engine', 'sleightCommit', 'runtimeReceipt', 'processEvidence', 'producer'].map(key => [key, artifact[key]]))) + '\n';
      writeFileSync(join(dir, 'fixture.tap'), tap); artifact.output.sha256 = hash(tap);
      return verifyParityResult(artifact, { expected, parity, root: dir, baseDirectory: dir });
    };
    assert.equal(verify(structuredClone(original)), true);
    const other = structuredClone(original);
    other.runtimeReceipt.driverBuild = other.processEvidence.binary.sha256 = other.processEvidence.binary.sha256After = '9'.repeat(64);
    assert.equal(validRuntimeReceipt(other.runtimeReceipt, { nonce: other.runNonce, build: OWN_BUILD, processEvidence: other.processEvidence }), true);
    assert.equal(verify(other), false, 'matching TAP and binary hashes still need the qualified binary');
    const version = structuredClone(original); version.runtimeReceipt.driverVersion = '2'; version.runtimeReceipt.ping.apiVersion = 2;
    assert.equal(verify(version), false);
    assert.equal(verify(structuredClone(original), { ...context(), driverIdentity: undefined }), false);
    const parity = proof(); parity.driverIdentity = { ...DRIVER, build: '9'.repeat(64) };
    assert.equal(gateVerdict({ ...context(), ...steps(), parity }).rows[0].status, 'unproven');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('release TAP binds the exact scored groups and every per-run receipt', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rt13-release-proof-unit-'));
  const hash = value => createHash('sha256').update(value).digest('hex');
  try {
    const expected = { id: 'laws-release-ab', check: 'runtime-side/laws-release-ab', proofStatus: 'runtime-proof',
      testFile: 'fixture.test.mjs', resultFile: 'fixture.json' };
    writeFileSync(join(dir, expected.testFile), '// synthetic release test');
    const artifact = { schema: 'sleight.runtime-parity-result/2', runtime: 'own', ...context(),
      id: expected.id, check: expected.check, runNonce: 'unique-release-proof-nonce', runtimeReceipt: receipt('unique-release-proof-nonce'),
      processEvidence: processEvidence(), producer: { file: expected.testFile, sha256: hash('// synthetic release test') },
      output: { file: 'fixture.tap' }, exitCode: 0, tests: 1, failures: 0, groups: groups() };
    const writeTap = value => {
      const tap = 'TAP version 13\nok 1 - release\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n' +
        '# runtime-evidence ' + JSON.stringify(value) + '\n';
      writeFileSync(join(dir, 'fixture.tap'), tap); artifact.output.sha256 = hash(tap);
    };
    const verify = () => verifyParityResult(artifact, { expected, parity: context(), root: dir, baseDirectory: dir });
    writeTap(artifact); assert.equal(verify(), true);
    const original = structuredClone(artifact.groups);
    artifact.groups[0].runs[1].seconds = 1; assert.equal(verify(), false, 'changing only scored data leaves stale TAP');
    artifact.groups = structuredClone(original); delete artifact.groups[0].runs[1].runtimeReceipt;
    writeTap(artifact); assert.equal(verify(), false, 'rehashing TAP does not replace a missing per-run receipt');
    artifact.groups = original; const withoutGroups = { ...artifact }; delete withoutGroups.groups;
    writeTap(withoutGroups); assert.equal(verify(), false, 'a separate summary table is not evidence');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
