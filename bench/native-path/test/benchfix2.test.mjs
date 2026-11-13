import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProof, proofExitCode } from '../../../scripts/glc1-runtime-proof.mjs';
import * as preflight from '../../glide-preflight.mjs';
import * as loads from '../../load.mjs';
import { sourceIdentity, runRuntimeArms, armMarkdown, scoreRuntimeArms } from '../../runtime-arm.mjs';
import { runDriver } from '../../driver.mjs';
import { createMacDriverClient } from '../../../plugins/sleight/lib/mac-driver/client.mjs';
import { SOURCE, ENGINE, DRIVER, build, receipt, step1Report, processEvidence, engineReceipt } from '../../../tests/runtime-gate-fixtures.mjs';

const prepared = { status: 'ready', origin: 'source', build: DRIVER.build,
  elapsedMs: 40000, compileMs: 39700, compileCount: 2 };
const rowResult = (extra = {}, code = 1) => ({ code, result: { auth: 'login',
  results: [{ passed: false, groupClean: true, runtimeReceipt: receipt('nonce'), ...extra }] } });
const run = (execute, options = {}) => runProof(options, { preflight: () => {}, prepare: () => prepared, execute });

// A removed safety key would reopen the fixture after the child stopped its pass.
for (const [key, cause] of [
  ['permissionRefusal', 'PERMISSION_PROMPT'], ['approvalStop', 'PERMISSION_PROMPT'],
  ['observerError', 'OBSERVER_STOP'], ['appDialog', 'APP_DIALOG'],
  ['cleanupUnconfirmed', 'CLEANUP_ERROR'], ['liveLockKept', 'CLEANUP_ERROR'],
  ['fixtureLockUnconfirmed', 'CLEANUP_ERROR'], ['skipped', 'TASK_RESULT_UNVERIFIED'],
]) for (const code of [0, 1]) test(`${key} stops after one attempt at exit ${code}`, async () => {
  const report = await run(() => rowResult({ [key]: true }, code));
  assert.equal(report.results.length, 1);
  assert.equal(report.stopped, cause);
  assert.equal(proofExitCode(report), 1);
});

test('only a plain failed task with confirmed cleanup continues at exit 1', async () => {
  const report = await run(() => rowResult());
  assert.equal(report.results.length, 12);
  assert.equal(report.stopped, undefined);
  assert.equal(proofExitCode(report), 1);
});
for (const [extra, code, cause] of [
  [{}, 2, 'CHILD_EXIT_UNEXPECTED'], [{}, null, 'CHILD_EXIT_UNEXPECTED'],
  [{ passed: true }, 1, 'TASK_RESULT_UNVERIFIED'],
  [{ passed: undefined }, 1, 'TASK_RESULT_UNVERIFIED'],
  [{ groupClean: undefined }, 1, 'GROUP_CLEANUP_UNVERIFIED'],
]) test(`unverified child result stops as ${cause} (${code}, ${JSON.stringify(extra)})`, async () => {
  const report = await run(() => rowResult(extra, code));
  assert.equal(report.results.length, 1);
  assert.equal(report.stopped, cause);
});
test('held pass attempts stop even when its one row is a clean task failure', async () => {
  const report = await run(() => { const result = rowResult(); result.result.heldAttempts = [{}]; return result; });
  assert.equal(report.results.length, 1);
  assert.equal(report.stopped, 'CLEANUP_ERROR');
});
for (const [key, cause] of [['permissionRefusal', 'PERMISSION_PROMPT'], ['approvalStop', 'PERMISSION_PROMPT'],
  ['observerError', 'OBSERVER_STOP'], ['appDialog', 'APP_DIALOG']]) test(`pass-level ${key} also stops`, async () => {
  const report = await run(() => { const result = rowResult(); result.result[key] = true; return result; });
  assert.equal(report.results.length, 1); assert.equal(report.stopped, cause);
});
test('malformed result rows stop with a receipt label', async () => {
  for (const results of [null, {}, [null], [true]]) {
    const report = await run(() => ({ code: 1, result: { auth: 'login', results } }));
    assert.equal(report.results.length, 1); assert.match(report.stopped, /receipt unverified/);
  }
});

test('proof rows and console summaries retain mismatched preparation builds', async () => {
  const logs = [], previous = console.log;
  console.log = line => logs.push(line);
  let report;
  try {
    report = await run(() => rowResult({ runtimeReceipt: { ...receipt('nonce'), driverSourceBuild: '9'.repeat(64) } }, 0), { popupSmoke: true });
  } finally { console.log = previous; }
  const check = report.results[0].result.results[0].glideBuildCheck;
  assert.equal(check.status, 'mismatch');
  assert.equal(check.preparedSourceBuild, DRIVER.build);
  assert.equal(check.attemptSourceBuild, '9'.repeat(64));
  assert.match(logs.join('\n'), /GLIDE_BUILD_MISMATCH/);
  assert.match(logs.join('\n'), /compileMs=39700.*cold/);
});
test('build checks use the source identity and separately compare binary hashes', () => {
  const prep = { ...prepared, binarySha256: 'a'.repeat(64) };
  const attempt = { runtimeReceipt: { ...receipt('nonce'), driverBuild: 'a'.repeat(64) } };
  assert.equal(preflight.glideBuildCheck(prep, attempt).status, 'match');
  attempt.runtimeReceipt.driverBuild = 'b'.repeat(64);
  assert.equal(preflight.glideBuildCheck(prep, attempt).status, 'mismatch');
  delete attempt.runtimeReceipt;
  assert.equal(preflight.glideBuildCheck(prep, attempt).status, 'unverified');
});
test('preparation records the prepared binary bytes without launching them', async t => {
  const root = mkdtempSync(join(tmpdir(), 'benchfix2-binary-')), binary = join(root, 'helper');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(binary, 'abc');
  const preparation = await preflight.prepareGlide({ prepare: () => ({ status: 'ready', origin: 'source',
    build: DRIVER.build, binary, spawn: () => assert.fail('preparation must not launch the helper') }) });
  assert.equal(preparation.binarySha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(preparation.compileMs, 0); assert.equal(preparation.compileCount, 0);
});
test('proof labels missing build evidence as unverified and continues', async () => {
  const report = await run(() => rowResult({ runtimeReceipt: undefined }, 0), { popupSmoke: true });
  assert.equal(report.results[0].result.results[0].glideBuildCheck.status, 'unverified');
  assert.equal(report.stopped, undefined); assert.equal(report.buildUnverified, true);
});

test('markdown prints cold and warm preparation beside the comparison and raw row loads', () => {
  const results = [{ arm: 'sleight-own', task: 'calculator-click', run: 1,
    loadStart: [4.29, 99, 99], loadEnd: [5.1, 99, 99], loadCores: 10,
    glideBuildCheck: { status: 'mismatch', preparedSourceBuild: 'before', attemptSourceBuild: 'after' } }];
  for (const [preparation, cache] of [[prepared, 'cold'], [{ ...prepared, compileMs: 0, compileCount: 0 }, 'warm']]) {
    const md = armMarkdown({ results, glidePreparation: preparation, score: scoreRuntimeArms(results) });
    assert.match(md, new RegExp(`compileMs=${preparation.compileMs}.*${cache}`));
    assert.match(md, /status=ready.*origin=source/);
    assert.match(md, /compileCount=/);
    assert.match(md, /first call.*compileMs/);
    assert.match(md, /GLIDE_BUILD_MISMATCH.*before.*after/);
    assert.match(md, /4.29.*5.1.*10 cores/);
    assert.match(md, /half/);
  }
});
test('load rows flag either endpoint strictly above half the cores and always show raw samples', async () => {
  for (const [start, end, flagged] of [[5.01, 1, true], [1, 5.01, true], [5, 5, false], [4.29, 4.77, false]]) {
    const row = { arm: 'sleight', task: 'calculator-click', run: 1,
      ...loads.loadReceipt({ loadStart: [start, 99, 99], loadEnd: [end, 99, 99], loadCores: 10 }) };
    assert.equal(row.loadExceededHalfCores, flagged);
    const summary = loads.loadSummary([row]).join('\n');
    assert.ok(summary.includes(String(start))); assert.ok(summary.includes(String(end)));
    assert.match(summary, /10 cores/);
    assert.equal(summary.includes('LOAD_WARNING'), flagged);
  }
  const driver = await runDriver(process.execPath, ['-e', 'console.log(JSON.stringify({result:"offline"}))']);
  assert.equal(driver.code, 0); assert.equal(driver.groupClean, true);
  assert.equal(typeof loads.loadReceipt(driver.stamps).loadExceededHalfCores, 'boolean');
});

for (const failAt of [1, 2]) test(`source read ${failAt} labels the 10 second Git timeout and preserves other failures`, () => {
  let calls = 0;
  assert.throws(() => sourceIdentity('.', { read(_command, _args, options) {
    assert.equal(options.timeout, 10000); assert.equal(options.killSignal, 'SIGKILL');
    if (++calls === failAt) throw Object.assign(Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
    return 'same-sha';
  } }), /SOURCE_CHECK_TIMEOUT/);
  assert.throws(() => sourceIdentity('.', { read() { throw Error('unrelated failure'); } }), /unrelated failure/);
});
test('an in-loop source timeout publishes a labeled stop before any attempt', async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'benchfix2-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'step1.json'), JSON.stringify(step1Report()));
  let reads = 0, report;
  const code = await runRuntimeArms({ ownerAway: true, out: join(root, 'summary'), step1: join(root, 'step1.json') }, {
    root, held: () => false, ownReady() {}, build, prepare: () => prepared,
    engine: () => ({ version: ENGINE.version, chatgptBuild: ENGINE.build }),
    source() { if (++reads > 1) throw Object.assign(Error('git ETIMEDOUT'), { code: 'ETIMEDOUT' }); return SOURCE; },
    inventory: () => ({ helpers: [], drivers: [] }),
    execute: () => assert.fail('source timeout must stop before child launch'),
    publish: (_, result) => { report = structuredClone(result); },
  });
  assert.equal(code, 1); assert.equal(report.stop, 'SOURCE_CHECK_TIMEOUT');
  assert.equal(report.results.length, 0);
});

test('runtime arm records and rejects a preflight build mismatch before the next child', async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'benchfix2-arm-')), configs = [];
  t.after(() => { configs.forEach(path => rmSync(path, { recursive: true, force: true })); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'bench/results'), { recursive: true });
  writeFileSync(join(root, 'step1.json'), JSON.stringify(step1Report()));
  let report;
  await runRuntimeArms({ ownerAway: true, out: join(root, 'summary'), step1: join(root, 'step1.json') }, {
    root, held: () => false, liveLockHeld: () => false, ownReady() {}, build, source: () => SOURCE,
    engine: () => ({ version: ENGINE.version, chatgptBuild: ENGINE.build }),
    prepare: () => ({ ...prepared, build: '9'.repeat(64) }), inventory: () => ({ helpers: [], drivers: [] }),
    observe: async operation => { const value = await operation(); return { value, processEvidence: value.processEvidence }; },
    execute: command => {
      configs.push(command.env.CLAUDE_CONFIG_DIR);
      const runtime = command.env.SLEIGHT_RUNTIME, nonce = command.env.SLEIGHT_RUNTIME_RUN_NONCE;
      const path = join(root, 'bench/results', configs.length + '.json');
      writeFileSync(path, JSON.stringify({ model: 'claude-haiku-5-5', effort: 'high',
        armMetadata: { sleight: { claudeVersion: 'fixture' } },
        engine: { changed: false, start: { version: ENGINE.version, chatgptBuild: ENGINE.build }, end: { version: ENGINE.version, chatgptBuild: ENGINE.build } },
        results: [{ task: 'calculator-click', arm: 'sleight', passed: true, seconds: 10, turns: 3,
          models: ['claude-haiku-5-5'], engineVersion: ENGINE.version, ...SOURCE,
          ...runtime === 'own' ? { runtimeReceipt: receipt(nonce) } : { engineReceipt: engineReceipt() } }] }));
      return { stdout: 'results: ' + path, groupClean: true, exit: { code: 0 }, processEvidence: processEvidence(runtime) };
    }, publish: (_, result) => { report = structuredClone(result); },
  });
  assert.equal(configs.length, 2); assert.equal(report.stop, 'GLIDE_BUILD_MISMATCH');
  assert.equal(report.results[1].glideBuildCheck.status, 'mismatch');
  assert.equal(report.results[1].valid, false);
});

test('a real driver client ping supplies the preparation source identity without treating it as a binary digest', async t => {
  const driver = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', build: 'b'.repeat(64),
    spawn: () => spawn(process.execPath, [fileURLToPath(new URL('../../../tests/mac-driver-core-client.test.mjs', import.meta.url)), '--fake-helper'],
      { stdio: ['pipe', 'pipe', 'pipe'] }) }) });
  t.after(() => driver.close());
  const ping = await driver.ping();
  const attempt = { runtimeReceipt: { driverSourceBuild: ping.build, driverBuild: 'a'.repeat(64), ping } };
  assert.equal(preflight.glideBuildCheck({ ...prepared, build: 'b'.repeat(64) }, attempt).status, 'match');
  assert.equal(preflight.glideBuildCheck(prepared, attempt).status, 'mismatch');
});
