import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { checkReportPath, integer, runChild, writeReport } from '../bench/windows/kit.mjs';
import { PROBE_SCHEMA, main as probeMain, parseProbeArgs, pipeName, probeArguments, probeEngine } from '../bench/windows/probe-engine.mjs';
import { FIXTURE, compareHost, comparePlans, discoverSuites, main as checksMain, parseCheckArgs, readFixture, runChecks, tapCounts, validateFixture } from '../bench/windows/run-checks.mjs';
import { cases } from '../bench/windows/plan-cases.mjs';
import { captureSwiftPlans } from '../bench/windows/capture-swift-plans.mjs';

const temp = () => trackTemp(mkdtempSync(join(tmpdir(), 'sleight-win0-test-')));
const ok = stdout => ({ status: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '', reason: null });
const capabilities = () => ok({ schema: 'sleight.windows-host-capabilities/1', modes: ['--plan-dump'], drawing: false });
const inventory = extra => ({ schema: PROBE_SCHEMA, engines: [], processes: [], pipes: [], errors: [], searchComplete: true,
  connection: { connected: false, serverPid: 0, bytesWritten: 0, frames: [] }, ...extra });
const options = () => parseProbeArgs(['--output', 'report.json']);
const tap = ({ pass = 2, fail = 0, skipped = 0, cancelled = 0, todo = 0 } = {}) =>
  `TAP version 13\n# tests ${pass + fail + skipped + cancelled + todo}\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancelled}\n# skipped ${skipped}\n# todo ${todo}\n`;
function harness() {
  const root = temp(); mkdirSync(join(root, 'tests'));
  for (let i = 1; i <= 4; i++) writeFileSync(join(root, 'tests', `win${i}.test.mjs`), '// reviewed offline test\n');
  writeFileSync(join(root, 'source.swift'), '// synthetic source\n');
  writeFileSync(join(root, 'host.exe'), 'synthetic executable, never launched\n');
  const manifest = { schema: 'sleight.windows-check-manifest/1', suites: [1, 2, 3, 4].map(i => ({ item: `WIN${i}`, patterns: [`win${i}.test.mjs`] })) };
  const fixture = { schema: 'sleight.windows-ring-fixtures/1', source: 'source.swift',
    sourceSha256: createHash('sha256').update(readFileSync(join(root, 'source.swift'))).digest('hex'),
    cases: [{ id: 'example', flags: ['--cursor-style=ring', '--seed=7'], frames: [{ dumpClock: 0 }], output: [{ effect: 'end', idle: true }], exitCode: 0 }] };
  return { root, manifest, fixture, host: join(root, 'host.exe'), platform: 'win32', nodeVersion: '24.0.0' };
}

test('probe accepts bounded options and local pipe names', () => {
  const parsed = parseProbeArgs(['--output', 'report.json', '--pipe-name', '\\\\.\\pipe\\sky-cua.123',
    '--search-root', 'C:\\Apps\\ChatGPT', '--observe-seconds', '30', '--connect-ms', '400', '--read-ms', '500']);
  assert.equal(parsed.pipe, 'sky-cua.123'); assert.equal(parsed.observeSeconds, 30);
  assert.equal(pipeName('codex-{123}'), 'codex-{123}');
  const args = probeArguments(parsed);
  assert.ok(args.includes('-File')); assert.ok(args.includes('-SearchRoot1'));
  assert.equal(args[args.indexOf('-SearchRoot1') + 1], 'C:\\Apps\\ChatGPT');
  assert.ok(!args.includes('-Command'));
  assert.equal(args[args.indexOf('-ExecutionPolicy') + 1], 'Bypass');
  assert.ok(args.indexOf('-ExecutionPolicy') < args.indexOf('-File'));
});

test('probe refuses remote pipes, traversal, flags, invalid durations and duplicate options', () => {
  for (const name of ['\\\\remote\\pipe\\sky', '../sky', '..', '', 'sky/one', '-Command x', 'a'.repeat(241)]) assert.throws(() => pipeName(name));
  for (const args of [[], ['--output'], ['--output', 'x', '--output', 'y'], ['--output', 'x', '--wat', 'a'],
    ['--output', 'x', '--observe-seconds', '0'], ['--output', 'x', '--observe-seconds', '121'],
    ['--output', 'x', '--connect-ms', '1e3'], ['--output', 'x', '--search-root', '\\\\remote\\share'],
    ['--output', 'x', '--search-root', 'relative']]) assert.throws(() => parseProbeArgs(args), JSON.stringify(args));
});

test('integer validation rejects coercion and unsafe values', () => {
  for (const value of ['', true, '1e2', '-1', '1.5', '999999999999999999999']) assert.throws(() => integer(value, 0, 100, 'test'));
  assert.equal(integer('10', 0, 100, 'test'), 10);
});

test('probe platform gate performs zero spawns on Mac', async () => {
  let calls = 0;
  await assert.rejects(probeEngine(options(), { platform: 'darwin', execute: async () => { calls++; } }), /requires Windows/);
  assert.equal(calls, 0);
});

test('mock PowerShell inventory preserves absence and incomplete-search distinctions', async () => {
  for (const complete of [true, false]) {
    const report = await probeEngine(options(), { platform: 'win32', env: {}, execute: async (command, args, opts) => {
      assert.match(command, /WindowsPowerShell\\v1\.0\\powershell\.exe$/); assert.equal(opts.lowPriority, true);
      assert.equal(args.includes('-PipeName'), false);
      return ok(inventory({ searchComplete: complete }));
    } });
    assert.equal(report.questions.enginePresent, complete ? 'not-found-in-searched-roots' : 'unknown');
    assert.equal(report.questions.externalConnect, 'not-tested');
    assert.match(report.questions.thirdPartyEngineUsable, /unverified/);
  }
});

test('mock pipe connection identifies server but never claims a usable engine', async () => {
  const report = await probeEngine({ ...options(), pipe: 'sky' }, { platform: 'win32', env: {}, execute: async () => ok(inventory({
    engines: [{ path: 'C:\\Apps\\codex-computer-use-arm64.exe' }],
    connection: { connected: true, serverPid: 42, bytesWritten: 0, frames: [{ method: 'string' }] },
    observation: { clicks: [{ downMs: 20, before: { hwnd: '0x1' }, after: { hwnd: '0x2' } }] },
  })) });
  assert.equal(report.questions.externalConnect, 'connected-from-standalone-powershell');
  assert.equal(report.questions.pipeServer, 'measured'); assert.match(report.questions.handshake, /shapes/);
  assert.match(report.questions.focus, /correlate/); assert.match(report.questions.thirdPartyEngineUsable, /unverified/);
});

test('silent and denied mock pipe probes leave handshake unknown', async () => {
  for (const connected of [true, false]) {
    const report = await probeEngine({ ...options(), pipe: 'sky' }, { platform: 'win32', env: {}, execute: async () => ok(inventory({
      connection: { connected, bytesWritten: 0, frames: [], outcome: connected ? 'read-timeout' : 'access-denied' },
    })) });
    assert.equal(report.questions.handshake, 'unknown-client-first-or-silent');
  }
});

test('observer readiness is forwarded once without echoing arbitrary PowerShell stderr', async () => {
  let ready = 0;
  await probeEngine({ ...options(), observeSeconds: 30 }, { platform: 'win32', onReady: () => ready++, execute: async (_command, _args, opts) => {
    assert.equal(opts.lowPriority, false);
    assert.equal(opts.normalPriority, true);
    opts.onStderr('private diagnostic text\nSLEIGHT_OBSERVER_');
    opts.onStderr('READY\n'); opts.onStderr('SLEIGHT_OBSERVER_READY\n');
    return ok(inventory());
  } });
  assert.equal(ready, 1);
});

test('baseline diff correlates pipe and process creation without asserting creator identity', async () => {
  const baseline = inventory({ pipes: ['sky-old'], processes: [{ pid: 2, created: 'before' }] });
  const report = await probeEngine(options(), { platform: 'win32', env: {}, baseline, execute: async () => ok(inventory({
    pipes: ['sky-old', 'sky-new'], processes: [{ pid: 2, created: 'after' }],
  })) });
  assert.deepEqual(report.comparison.newPipes, ['sky-new']); assert.equal(report.comparison.newProcesses.length, 1);
  assert.match(report.comparison.attribution, /correlation only/);
  await assert.rejects(probeEngine(options(), { platform: 'win32', baseline: {}, execute: async () => ok(inventory()) }), /Invalid baseline/);
});

test('probe removes the Windows profile prefix from local report paths', async () => {
  const report = await probeEngine(options(), { platform: 'win32', env: { USERPROFILE: 'C:\\Users\\fixture' },
    execute: async () => ok(inventory({ engines: [{ path: 'C:\\Users\\fixture\\AppData\\Local\\engine.exe' }] })) });
  assert.equal(report.engines[0].path, '%USERPROFILE%\\AppData\\Local\\engine.exe');
});

test('probe redacts mixed-case profiles, short user paths, username and machine identifiers', async () => {
  const report = await probeEngine(options(), { platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\Fixture', USERNAME: 'Fixture', COMPUTERNAME: 'VM-PRIVATE' },
    execute: async () => ok(inventory({ engines: [
      { path: 'c:\\uSeRs\\fIXTURE\\AppData\\engine.exe' },
      { path: ['C:', 'Users', 'FIXTUR~1', 'AppData', 'engine.exe'].join('/') },
      { path: 'D:\\Users\\Another\\engine.exe' },
    ], pipes: ['fixture-sky', 'vm-private-cua', 'skyFIXTURE123VM-PRIVATEapp'] })) });
  assert.equal(report.engines[0].path, '%USERPROFILE%\\AppData\\engine.exe');
  assert.equal(report.engines[1].path, '%USERPROFILE%/AppData/engine.exe');
  assert.equal(report.engines[2].path, '%USERPROFILE%\\engine.exe');
  assert.deepEqual(report.pipes, ['%USERNAME%-sky', '%COMPUTERNAME%-cua', 'skyFIXTURE123VM-PRIVATEapp']);
});

test('failed probe keeps a bounded redacted stderr tail in the error and saved report', async () => {
  const output = join(temp(), 'failed-probe.json');
  const env = { USERPROFILE: 'C:\\Users\\Fixture', USERNAME: 'Fixture', COMPUTERNAME: 'VM-PRIVATE' };
  const stderr = 'old diagnostic\n' + 'é'.repeat(600) + '\n\u001b[31mCompile failed c:\\users\\FIXTURE\\probe.ps1 on vm-private\u001b[0m\u0000\u0007';
  await assert.rejects(probeMain(['--output', output], { platform: 'win32', env,
    execute: async () => ({ ...ok('private stdout'), status: 1, stderr }) }), error => {
    assert.match(error.message, /Compile failed %USERPROFILE%\\probe.ps1 on %COMPUTERNAME%/);
    assert.ok(Buffer.byteLength(error.stderrTail) <= 512);
    assert.doesNotMatch(error.message, /old diagnostic|private stdout|fixture|vm-private|\u001b|\u0000|\u0007|\ufffd/i);
    return true;
  });
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assert.match(report.stderrTail, /Compile failed/);
  assert.ok(report.reason.includes(report.stderrTail));
});

test('malformed successful probe output retains redacted stderr without exposing stdout', async () => {
  await assert.rejects(probeEngine(options(), { platform: 'win32', env: { USERPROFILE: 'C:\\Users\\Fixture' },
    execute: async () => ({ ...ok('private stdout'), stderr: 'warning C:\\Users\\Fixture\\script.ps1' }) }), error => {
    assert.match(error.message, /invalid JSON/);
    assert.equal(error.stderrTail, 'warning %USERPROFILE%\\script.ps1');
    assert.ok(error.message.includes(error.stderrTail));
    assert.doesNotMatch(error.message, /private stdout/);
    return true;
  });
});

test('probe rejects process failures, malformed JSON, missing fields and any reported pipe write', async () => {
  for (const result of [{ status: 1, stdout: 'do not echo this' }, { status: 0, reason: 'timeout', stdout: '{}' },
    ok('not-json'), ok({}), ok(inventory({ connection: { bytesWritten: 1, frames: [] } }))]) {
    await assert.rejects(probeEngine(options(), { platform: 'win32', execute: async () => result }), error => !error.message.includes('do not echo'));
  }
});

test('reports refuse existing files and symlinks', () => {
  const root = temp(), output = join(root, 'result.json');
  checkReportPath(output);
  writeReport(output, { count: 2 }); assert.equal(JSON.parse(readFileSync(output)).count, 2);
  assert.throws(() => checkReportPath(output), /already exists/);
  assert.throws(() => writeReport(output, { count: 3 }), /EEXIST/);
  if (process.platform !== 'win32') {
    const link = join(root, 'link.json'); symlinkSync(output, link); assert.throws(() => writeReport(link, {}), /EEXIST/);
  }
});

test('CLI platform refusals save error reports without starting Windows processes', { skip: process.platform === 'win32' }, async () => {
  const root = temp(), probe = join(root, 'probe.json'), checks = join(root, 'checks.json');
  await assert.rejects(probeMain(['--output', probe]), /requires Windows/);
  assert.equal(JSON.parse(readFileSync(probe)).verdict, 'error');
  await assert.rejects(checksMain(['--output', checks]), /require Windows/);
  assert.equal(JSON.parse(readFileSync(checks)).exitCode, 1);
  await assert.rejects(probeMain(['--output', probe]), /already exists/);
});

test('manifest discovers all four suites without executing them', () => {
  const h = harness();
  assert.deepEqual(discoverSuites(h.root, h.manifest).map(s => s.files), [1, 2, 3, 4].map(i => [`tests/win${i}.test.mjs`]));
  h.manifest.suites[0].patterns = ['absent*.test.mjs'];
  assert.deepEqual(discoverSuites(h.root, h.manifest)[0].files, []);
});

test('manifest rejects traversal, duplicate ownership, unknown items and symlink tests', () => {
  const h = harness();
  for (const pattern of ['../win1.test.mjs', '**/win1.test.mjs', 'win(1).test.mjs']) {
    const m = structuredClone(h.manifest); m.suites[0].patterns = [pattern]; assert.throws(() => discoverSuites(h.root, m));
  }
  const duplicate = structuredClone(h.manifest); duplicate.suites[1].patterns = ['win1.test.mjs'];
  assert.throws(() => discoverSuites(h.root, duplicate), /duplicate/);
  const unknown = structuredClone(h.manifest); unknown.suites[0].item = 'WIN5'; assert.throws(() => discoverSuites(h.root, unknown));
  assert.throws(() => discoverSuites(h.root, { ...h.manifest, suites: [] }));
  if (process.platform !== 'win32') {
    symlinkSync(join(h.root, 'tests', 'win1.test.mjs'), join(h.root, 'tests', 'link.test.mjs'));
    const m = structuredClone(h.manifest); m.suites[0].patterns = ['link.test.mjs']; assert.throws(() => discoverSuites(h.root, m), /Symlinked/);
  }
});

test('TAP totals preserve skips, failures, cancellation and todo', () => {
  assert.deepEqual(tapCounts(tap({ pass: 1, skipped: 2, fail: 3, cancelled: 1, todo: 1 })), { tests: 8, pass: 1, skipped: 2, fail: 3, cancelled: 1, todo: 1 });
  assert.equal(tapCounts(''), null); assert.equal(tapCounts(tap() + '# pass 2\n'), null);
  assert.equal(tapCounts(tap().replace('# tests 2', '# tests 3')), null);
});

test('plan comparator tolerates numeric noise and detects keys, arrays, nulls and ordering', () => {
  assert.equal(comparePlans([{ a: 1, b: [2] }], [{ b: [2.0000001], a: 1 }]), null);
  for (const [a, b] of [[1, 1.001], [1, NaN], [{ a: 1 }, {}], [[1, 2], [2, 1]], [null, {}], [true, false], [[], {}]]) {
    assert.ok(comparePlans(a, b), JSON.stringify([a, b]));
  }
});

test('fixture validation refuses unknown modes, unsafe flags and duplicate cases', () => {
  const h = harness(); validateFixture(h.fixture);
  for (const flag of ['--hand', '--hand-demo', '--time-plans', '--cursor-style=sprite', '--seed=x']) {
    const f = structuredClone(h.fixture); f.cases[0].flags.push(flag); assert.throws(() => validateFixture(f));
  }
  const f = structuredClone(h.fixture); f.cases.push(f.cases[0]); assert.throws(() => validateFixture(f));
});

test('host comparison runs only plan-dump and respects expected refusal exits', async () => {
  const h = harness();
  h.fixture.cases.push({ ...h.fixture.cases[0], id: 'bad-frame', output: [], exitCode: 65 });
  let n = 0;
  const result = await compareHost(h.host, h.fixture, { execute: async (command, args, opts) => {
    assert.equal(command, h.host);
    if (args[0] === '--capabilities') { assert.ok(opts.timeout <= 3000); assert.equal(opts.input, ''); return capabilities(); }
    assert.equal(args[0], '--plan-dump'); assert.match(opts.input, /dumpClock/);
    return n++ === 0 ? ok('{"effect":"end","idle":true}\n') : { ...ok(''), status: 65 };
  } });
  assert.equal(result.verdict, 'pass'); assert.equal(result.cases.length, 2);
});

test('host comparison records bad JSON, wrong exits and differences as failures', async () => {
  const h = harness();
  for (const result of [ok('broken'), ok('{"effect":"different"}\n'), { ...ok(''), status: 65 }, { ...ok(''), reason: 'timeout' }]) {
    const report = await compareHost(h.host, h.fixture, { execute: async (_host, args) => args[0] === '--capabilities' ? capabilities() : result });
    assert.equal(report.verdict, 'fail'); assert.ok(report.cases[0].difference);
  }
});

test('host comparison refuses planner inputs without a non-drawing capability confirmation', async () => {
  const h = harness();
  for (const result of [ok(''), ok('unrecognized option'), ok({ modes: ['--plan-dump'] }),
    ok({ schema: 'sleight.windows-host-capabilities/1', modes: ['--hand'], drawing: false }),
    { ...capabilities(), status: 64 }, { ...capabilities(), reason: 'timeout' }]) {
    let calls = 0;
    const report = await compareHost(h.host, h.fixture, { execute: async (_host, args) => {
      calls++; assert.deepEqual(args, ['--capabilities']); return result;
    } });
    assert.equal(calls, 1); assert.equal(report.verdict, 'fail'); assert.equal(report.cases.length, 0);
    assert.match(report.reason, /capabilit/i);
  }
});

test('host comparison stops after malformed, timed-out or unterminated first planner output', async () => {
  const h = harness(); h.fixture.cases.push({ ...h.fixture.cases[0], id: 'never-run' });
  for (const result of [ok('not JSON'), { ...ok(''), reason: 'timeout' }, ok('{"effect":"act"}\n')]) {
    let calls = 0;
    const report = await compareHost(h.host, h.fixture, { execute: async (_host, args, opts) => {
      calls++;
      if (args[0] === '--capabilities') return capabilities();
      assert.ok(opts.timeout <= 3000);
      return { ...result, stderr: 'compile error C:\\Users\\Fixture\\host.cs\u0000' };
    }, env: { USERPROFILE: 'C:\\Users\\Fixture' } });
    assert.equal(calls, 2); assert.equal(report.cases.length, 1); assert.equal(report.verdict, 'fail');
    assert.match(report.cases[0].stderrTail, /compile error %USERPROFILE%/);
  }
});

test('guest checks require Windows and Node 24 or later before spawning', async () => {
  let calls = 0; const execute = async () => { calls++; };
  await assert.rejects(runChecks({ ...harness(), platform: 'darwin', execute }), /require Windows/);
  for (const nodeVersion of ['22.0.0', '23.11.0', 'invalid'])
    await assert.rejects(runChecks({ ...harness(), nodeVersion, execute }), /Node 24 or later/);
  assert.equal(calls, 0);
});

test('guest checks accept Node 24, 25 and later majors', async () => {
  for (const nodeVersion of ['24.0.0', '25.0.0', '26.12.1', '30.0.0']) {
    const h = harness(); delete h.host;
    let calls = 0;
    const report = await runChecks({ ...h, nodeVersion, execute: async () => { calls++; return ok(tap()); } });
    assert.equal(calls, 4); assert.equal(report.node, nodeVersion);
    assert.equal(report.suites.length, 4); assert.ok(report.suites.every(suite => suite.verdict === 'pass'));
  }
});

test('guest mock checks run serially with fresh Claude configs and compare the host', async () => {
  const configs = [], h = harness(); let calls = 0;
  const report = await runChecks({ ...h, execute: async (command, args, opts) => {
    calls++;
    if (command === h.host) return args[0] === '--capabilities' ? capabilities() : ok('{"effect":"end","idle":true}\n');
    assert.deepEqual(args.slice(0, 3), ['--test', '--test-concurrency=1', '--test-reporter=tap']);
    assert.equal(opts.lowPriority, true); assert.ok(existsSync(opts.env.CLAUDE_CONFIG_DIR)); configs.push(opts.env.CLAUDE_CONFIG_DIR);
    return ok(tap());
  } });
  assert.equal(report.exitCode, 0); assert.equal(report.verdict, 'pass'); assert.equal(calls, 6);
  assert.equal(new Set(configs).size, 4); assert.ok(configs.every(path => !existsSync(path)));
  assert.ok(report.unverified.includes('capture exclusion'));
});

test('missing suites and absent host produce incomplete exit 2', async () => {
  const h = harness(); h.manifest.suites[0].patterns = ['missing.test.mjs']; delete h.host;
  let calls = 0; const report = await runChecks({ ...h, execute: async () => { calls++; return ok(tap()); } });
  assert.equal(report.exitCode, 2); assert.equal(report.suites[0].verdict, 'blocked'); assert.equal(report.comparison.verdict, 'blocked');
  assert.equal(calls, 3);
});

test('all-skipped, partially skipped and todo suites never pass', async () => {
  for (const counts of [{ pass: 0, skipped: 3 }, { pass: 2, skipped: 1 }, { pass: 1, todo: 1 }]) {
    const h = harness(); delete h.host;
    const report = await runChecks({ ...h, execute: async () => ok(tap(counts)) });
    assert.equal(report.exitCode, 2); assert.ok(report.suites.every(s => s.verdict === 'incomplete'));
  }
});

test('failed tests, invalid TAP and child errors set exit 1', async () => {
  for (const result of [{ ...ok(tap({ fail: 1 })), status: 1 }, ok(''), { ...ok(''), reason: 'timeout' }]) {
    const h = harness(); delete h.host;
    const report = await runChecks({ ...h, execute: async () => result });
    assert.equal(report.exitCode, 1); assert.equal(report.suites[0].verdict, 'fail');
  }
});

test('failed guest suites save redacted stderr tails, including timeouts', async () => {
  const h = harness(); delete h.host;
  const report = await runChecks({ ...h, env: { USERPROFILE: 'C:\\Users\\Fixture', COMPUTERNAME: 'VM-PRIVATE' },
    execute: async () => ({ ...ok(''), reason: 'timeout', stderr: 'x'.repeat(900) + '\n\u001b[31mfailed c:\\users\\FIXTURE\\test.mjs vm-private\u001b[0m\u0000' }) });
  assert.equal(report.exitCode, 1);
  for (const suite of report.suites) {
    assert.match(suite.stderrTail, /failed %USERPROFILE%\\test.mjs %COMPUTERNAME%/);
    assert.ok(Buffer.byteLength(suite.stderrTail) <= 512);
    assert.doesNotMatch(suite.stderrTail, /fixture|vm-private|\u001b|\u0000/i);
  }
});

test('interruption stops the remaining guest suites and cleans its config', async () => {
  let config; const h = harness();
  const report = await runChecks({ ...h, execute: async (_command, _args, opts) => {
    config = opts.env.CLAUDE_CONFIG_DIR; return { ...ok(''), reason: 'interrupted' };
  } });
  assert.equal(report.suites.length, 1); assert.equal(report.exitCode, 1); assert.equal(existsSync(config), false);
});

test('stale source fixture refuses every guest test before spawning', async () => {
  const h = harness(); writeFileSync(join(h.root, 'source.swift'), 'changed'); let calls = 0;
  await assert.rejects(runChecks({ ...h, execute: async () => { calls++; } }), /source changed/);
  assert.equal(calls, 0);
});

test('guest source hash accepts CRLF and still rejects substantive source changes', async () => {
  const h = harness(); delete h.host;
  writeFileSync(join(h.root, 'source.swift'), '// synthetic source\r\n');
  const report = await runChecks({ ...h, execute: async () => ok(tap()) });
  assert.ok(report.suites.every(s => s.verdict === 'pass'));
  writeFileSync(join(h.root, 'source.swift'), '// changed source\r\n');
  await assert.rejects(runChecks({ ...h, execute: async () => assert.fail('must not spawn') }), /source changed.*line endings/i);
});

test('guest checks refuse an external host executable', async () => {
  const h = harness(), other = harness();
  await assert.rejects(runChecks({ ...h, host: other.host, execute: async () => ok(tap()) }), /reviewed regular/);
});

test('check CLI supports inventory and rejects duplicate, unknown and unbounded options', () => {
  assert.equal(parseCheckArgs(['--list']).list, true);
  assert.equal(parseCheckArgs(['--output', 'x', '--timeout-ms', '1000']).timeout, 1000);
  for (const args of [[], ['--output'], ['--list', '--list'], ['--output', 'x', '--timeout-ms', '999999'], ['--what', 'x']]) assert.throws(() => parseCheckArgs(args));
});

test('Swift capture refuses non-Mac hosts without compilation', async () => {
  let calls = 0;
  await assert.rejects(captureSwiftPlans('unused', { platform: 'win32', execute: async () => { calls++; } }), /requires macOS/);
  assert.equal(calls, 0);
});

test('mock Swift capture uses only the dump mode and cleans its private compiler cache', async () => {
  const output = join(temp(), 'fixture.json.gz'); let build, count = 0;
  const report = await captureSwiftPlans(output, { platform: 'darwin', execute: async (command, args) => {
    if (command === '/usr/bin/xcrun') {
      assert.deepEqual(args.slice(0, 3), ['swiftc', '-O', '-module-cache-path']); build = dirname(args[args.indexOf('-module-cache-path') + 1]);
      return ok('');
    }
    assert.equal(args[0], '--ring-plan-dump');
    return { ...ok(''), status: cases[count++].exitCode ?? 0 };
  } });
  assert.equal(report.cases, 12); assert.equal(existsSync(build), false);
  assert.equal(readFixture(output).cases.length, 12);
});

test('Swift capture removes its build directory on compiler failure and refuses existing output before compiling', async () => {
  const output = join(temp(), 'failed.json.gz'); let build, calls = 0;
  await assert.rejects(captureSwiftPlans(output, { platform: 'darwin', execute: async (_command, args) => {
    calls++; build = dirname(args[args.indexOf('-module-cache-path') + 1]); return { ...ok(''), status: 1 };
  } }), /compilation failed/);
  assert.equal(existsSync(build), false); assert.equal(existsSync(output), false);
  writeFileSync(output, 'existing');
  await assert.rejects(captureSwiftPlans(output, { platform: 'darwin', execute: async () => { calls++; } }), /already exists/);
  assert.equal(calls, 1); assert.equal(readFileSync(output, 'utf8'), 'existing');
});

test('committed Swift fixture has the captured source hash and all 12 reviewed inputs', () => {
  const fixture = readFixture(FIXTURE); validateFixture(fixture);
  const source = readFileSync(new URL('../' + fixture.source, import.meta.url));
  assert.equal(createHash('sha256').update(source.toString('utf8').replaceAll('\r\n', '\n')).digest('hex'), fixture.sourceSha256);
  assert.equal(fixture.cases.length, cases.length);
  fixture.cases.forEach((entry, index) => {
    assert.deepEqual(entry.frames, cases[index].frames); assert.deepEqual(entry.flags, cases[index].flags);
    assert.equal(entry.exitCode, cases[index].exitCode ?? 0);
    if (entry.exitCode === 0) assert.equal(entry.output.at(-1).effect, 'end');
  });
});

test('synthetic reference cases include all action kinds, status cases and refusal exits', () => {
  const kinds = new Set(cases.flatMap(c => c.frames.map(f => f.kind).filter(Boolean)));
  assert.deepEqual([...kinds].sort(), ['click', 'double', 'drag', 'key', 'right', 'scroll', 'type']);
  assert.equal(cases.filter(c => c.exitCode === 65).length, 4); assert.equal(cases.length, 12);
});

test('PowerShell probe has bounded reads, original Win32 interop and no action calls', () => {
  const source = readFileSync(new URL('../bench/windows/probe-engine.ps1', import.meta.url), 'utf8');
  for (const api of ['GetNamedPipeServerProcessId', 'GetForegroundWindow', 'SetWindowsHookEx', 'UnhookWindowsHookEx', 'CallNextHookEx', 'Win32_Process', 'Get-AppxPackage']) assert.ok(source.includes(api));
  assert.match(source, /prefix\.Length < 16384/); assert.match(source, /frames\.Count -lt 4/);
  assert.doesNotMatch(source, /SendInput|SetForegroundWindow|Start-Process|Invoke-Expression|pipe\.Write|ReadAllBytes|Get-Clipboard/);
  assert.match(source, /Frame-Shape/); assert.match(source, /otherKeyCount/);
  assert.match(source, /input\.flags & 1/); assert.match(source, /finally \{\s*result\.hookRemoved = UnhookWindowsHookEx/);
});

test('probe byte accounting is wired to counted I/O on a read-only pipe, with an in-memory selftest', () => {
  const source = readFileSync(new URL('../bench/windows/probe-engine.ps1', import.meta.url), 'utf8');
  assert.match(source, /PipeDirection\.In,/);
  assert.match(source, /BytesWritten \+= count/);
  assert.match(source, /result\.bytesWritten = counted\.BytesWritten/);
  assert.match(source, /\$connection\.bytesWritten = \$capture\.bytesWritten/);
  assert.match(source, /VerifyByteCounter\(\)/);
  assert.match(source, /counted\.BytesWritten != 6/);
});

test('owned child runner collects exit and Unicode output', async () => {
  const result = await runChild(process.execPath, ['-e', 'const b = Buffer.from("café"); process.stdout.write(b.subarray(0, 4)); setTimeout(() => { process.stdout.write(b.subarray(4)); process.exitCode = 3; }, 20);']);
  assert.equal(result.status, 3); assert.equal(result.stdout, 'café'); assert.equal(result.reason, null);
});

test('owned child runner bounds output and waits for timed-out child exit', async () => {
  const large = await runChild(process.execPath, ['-e', 'process.stdout.write("x".repeat(20000))'], { maxBytes: 100 });
  assert.equal(large.reason, 'output-limit');
  const timed = await runChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 200 });
  assert.equal(timed.reason, 'timeout'); assert.ok(timed.signal || timed.status !== null);
});

test('output-limit failures retain the last stderr diagnostic within a bounded buffer', async () => {
  const result = await runChild(process.execPath, ['-e', 'process.stderr.write("x".repeat(20000) + "\\nlast diagnostic");'], { maxBytes: 100 });
  assert.equal(result.reason, 'output-limit');
  assert.match(result.stderr, /last diagnostic$/);
  assert.ok(Buffer.byteLength(result.stderr) <= 8192);
});

test('Windows timeouts return for VM restore without signaling a guest process', async () => {
  const calls = []; let child;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const process = new EventEmitter(); process.pid = 4321;
    if (calls.length === 1) {
      child = process; process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.stdin = new PassThrough();
      process.kill = () => assert.fail('VM restore owns cleanup'); process.unref = () => {};
    } else assert.fail('no guest termination helper');
    return process;
  };
  const pending = runChild('node.exe', ['--test', 'offline.test.mjs'], { platform: 'win32', spawn,
    env: { SystemRoot: 'C:\\Windows' }, timeout: 10 });
  const result = await pending;
  assert.equal(calls.length, 1); assert.equal(result.reason, 'timeout'); assert.equal(result.cleanup, 'restore-required');
  assert.ok([child.stdin, child.stdout, child.stderr].every(s => s.destroyed));
});

test('Windows timeout does not claim guest cleanup when its child has no PID', { timeout: 1000 }, async () => {
  let child;
  const spawn = () => {
    const process = new EventEmitter();
    if (!child) {
      child = process; process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.stdin = new PassThrough();
    } else assert.fail('no guest cleanup child');
    return process;
  };
  const result = await runChild('node.exe', [], { platform: 'win32', spawn, timeout: 10 });
  assert.equal(result.reason, 'timeout'); assert.equal(result.cleanup, 'restore-required');
  assert.equal(result.status, null);
});

for (const cleanup of ['tree-unconfirmed', 'restore-required']) test(`guest checks stop before another suite or host on ${cleanup}`, async () => {
  const h = harness(); let calls = 0;
  const report = await runChecks({ ...h, execute: async () => {
    calls++; return { ...ok(''), reason: 'timeout', cleanup };
  } });
  assert.equal(calls, 1); assert.equal(report.suites.length, 1); assert.equal(report.exitCode, 1);
  assert.equal(report.suites[0].cleanup, cleanup); assert.equal(report.comparison.verdict, 'blocked');
});

test('Windows launcher probe records all three non-drawing command forms with quoted CMD paths', async () => {
  const { probeWindowsLaunchers } = await import('../bench/windows/run-checks.mjs');
  const calls = [];
  const results = await probeWindowsLaunchers({ platform: 'win32', root: 'C:\\Plugin Cache\\sleight',
    execute: async (command, args, options) => { calls.push({ command, args, options }); return ok('platform  win32\n'); } });
  assert.equal(calls.length, 3); assert.deepEqual(results.map(result => result.form), ['extensionless', 'cmd', 'cmd-exe']);
  assert.ok(results.every(result => result.doctorReached && result.exitCode === 0));
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', '""C:\\Plugin Cache\\sleight\\plugins\\sleight\\bin\\sleight-mcp" --doctor"']);
  assert.equal(calls[1].command, calls[0].command);
  assert.deepEqual(calls[1].args, ['/d', '/s', '/c', '""C:\\Plugin Cache\\sleight\\plugins\\sleight\\bin\\sleight-mcp.cmd" --doctor"']);
  assert.equal(calls[2].command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(calls[2].args, ['/d', '/c', '""C:\\Plugin Cache\\sleight\\plugins\\sleight\\bin\\sleight-mcp.cmd" --doctor"']);
  assert.ok(calls.every(call => call.options.lowPriority && call.options.env.CLAUDE_CONFIG_DIR && call.options.windowsVerbatimArguments === true));
  await assert.rejects(probeWindowsLaunchers({ platform: 'darwin', execute: () => assert.fail('Mac probe') }), /Windows/);
});


test('launcher probes forward exact CMD arguments verbatim to spawn', async () => {
  const { probeWindowsLaunchers } = await import('../bench/windows/run-checks.mjs');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const spawns = [];
  const results = await probeWindowsLaunchers({ platform: 'win32', root: 'C:\\Plugin Cache\\sleight', execute: (command, args, options) =>
    runChild(command, args, { ...options, platform: 'win32', spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => { child.stdout.end('platform  win32\n'); child.emit('close', 0); }); return child;
    } }) });
  assert.equal(results.length, 3);
  for (const [index, suffix] of ['', '.cmd', '.cmd'].entries()) {
    assert.equal(spawns[index].command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(spawns[index].args, index === 2 ? ['/d', '/c', '""C:\\Plugin Cache\\sleight\\plugins\\sleight\\bin\\sleight-mcp.cmd" --doctor"'] :
      ['/d', '/s', '/c', `""C:\\Plugin Cache\\sleight\\plugins\\sleight\\bin\\sleight-mcp${suffix}" --doctor"`]);
    assert.equal(spawns[index].options.windowsVerbatimArguments, true);
    assert.equal(spawns[index].options.shell, false); assert.equal(spawns[index].options.windowsHide, true);
  }
});
