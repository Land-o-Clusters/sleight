import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { promisify } from 'node:util';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const exec = promisify(execFile);
test('UC2B quiet wait and fresh admission use fake desktop providers only', { skip: process.platform !== 'darwin', timeout: 900000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-person-wait-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Add a fake secure-input provider only to the temporary harness. No system
  // Carbon call or production test-only hook is used.
  const composed = macDriverSource().replace('releaseSleep: { _ in 0 }))',
    'releaseSleep: { _ in 0 }, secureInput: { (fixture["secureInput"] as? NSDictionary)?["active"] as? Bool ?? false }))');
  const source = join(root, 'main.swift'), binary = join(root, 'rules');
  const harness = await readFile(new URL('./fixtures/mac-driver-person-wait.swift', import.meta.url), 'utf8');
  await writeFile(source, composed.slice(0, composed.indexOf('// Source: DriverMain.swift\n')) + harness);
  const build = await exec('/usr/bin/xcrun', ['swiftc', '-D', 'SLEIGHT_DRIVER_FIXTURES', '-module-cache-path', join(root, 'modules'), source, '-o', binary],
    { timeout: 360000, killSignal: 'SIGKILL', maxBuffer: 65536 });
  if (build.stderr) t.diagnostic(build.stderr.trim());
  const result = await exec(binary, [], { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536 });
  assert.equal(result.stderr, '');
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.ok(rows.length >= 10);
  for (const row of rows) await t.test(row.name, () => assert.equal(row.pass, true, JSON.stringify(row)));

  for (const mode of ['allow', 'pause', 'approval', 'cancel', 'cap', 'floor', 'slow-parent']) await t.test(`native stdin checkpoint and cancellation: ${mode}`, async t => {
    let callbacks = 0;
    const client = createMacDriverClient({ platform: 'darwin', requiredMethods: ['ping', 'click', 'fixtureStats'],
      prepare: async () => ({ status: 'ready', spawn: ({ nonce }) => spawn(binary, ['--control-server'], {
        env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce }, stdio: ['pipe', 'pipe', 'pipe'],
      }) }) });
    t.after(() => client.close());
    await client.ping();
    const binding = { windowId: '42', processStart: 'start' };
    const read = await client.request('getAXState', binding), person = await client.request('personState', binding);
    let timer;
    t.after(() => clearTimeout(timer));
    const timeoutMs = mode === 'cap' ? 350 : mode === 'floor' ? 1500 : mode === 'slow-parent' ? 2800 : 5000;
    const action = client.request('click', { ...binding, readId: read.readId, personToken: person.token, args: [1] }, {
      timeoutMs, beforeInput() {
        callbacks++;
        if (mode === 'slow-parent') return new Promise(() => {});
        if (mode !== 'allow') throw Object.assign(Error(mode), { code: mode === 'pause' ? 'PAUSED' : 'APP_BLOCKED' });
      },
    });
    if (mode === 'cancel') timer = setTimeout(() => client.cancelPending(), 100);
    if (mode === 'allow') {
      const result = await action;
      assert.ok(result.waitedForPersonMs >= 1200); assert.ok(result.personWaitCapMs >= 4800 && result.personWaitCapMs <= 4850);
    } else await assert.rejects(action, error => error.code === (['cancel', 'cap', 'floor', 'slow-parent'].includes(mode) ? 'PERSON_TOOK_OVER' : mode === 'pause' ? 'PAUSED' : 'APP_BLOCKED') &&
      error.delivery === 'not-sent' && error.retry === 'safe');
    assert.deepEqual(await client.request('fixtureStats', {}), { posts: mode === 'allow' ? 1 : 0 });
    assert.equal(callbacks, ['cancel', 'cap', 'floor'].includes(mode) ? 0 : 1);
  });

  // One temporary executable carries independent broken variants selected only
  // by its test argv. The production source and binary have no such selector.
  let mutant = composed.slice(0, composed.indexOf('// Source: DriverMain.swift\n'));
  function alter(from, to) {
    assert.ok(mutant.includes(from), `mutation anchor missing: ${from}`);
    mutant = mutant.replaceAll(from, to);
  }
  alter('min(8.0, max(0, remaining() - 0.150))', 'min(personWaitMutation == "long-cap" ? 10.0 : 8.0, max(0, remaining() - (personWaitMutation == "no-reserve" ? 0.0 : 0.150)))');
  alter('remaining() > 0.150', 'remaining() > (personWaitMutation == "no-reserve" ? 0.0 : 0.150)');
  alter('max(0, remaining() - 0.150)', 'max(0, remaining() - (personWaitMutation == "no-reserve" ? 0.0 : 0.150))');
  alter('current.at - lastRelevant >= 1.0', 'current.at - lastRelevant >= (personWaitMutation == "short-quiet" ? 0.5 : 1.0)');
  alter('current.pointerPID != pid && current.at', '(current.pointerPID != pid || personWaitMutation == "ignore-pointer") && current.at');
  alter('try checkpoint()', 'if personWaitMutation != "skip-checkpoint" { try checkpoint() }');
  alter('max(0, tick + 0.020 - providers.now())', '(personWaitMutation == "slow-poll" ? 0.020 : max(0, tick + 0.020 - providers.now()))');
  alter('before.matchesPersonTarget(after, request: request, map: map)', '(before.matchesPersonTarget(after, request: request, map: map) || personWaitMutation == "skip-read-check")');
  alter('if let reason = reason {', 'if let reason = reason, personWaitMutation != "skip-posting-check" {');
  alter('current.at - lastRelevant < quietSeconds', '(personWaitMutation == "forget-scope" ? current.hidIdle < quietSeconds && current.involves(pid) : current.at - lastRelevant < quietSeconds)');
  alter('guard !person.heldModifiers()', 'guard personWaitMutation == "skip-modifiers" || !person.heldModifiers()');
  alter('state.secureInput { throw DriverFault("SECURE_INPUT_ACTIVE") }', 'state.secureInput && personWaitMutation != "skip-secure" { throw DriverFault("SECURE_INPUT_ACTIVE") }');
  alter('func checkBeforeDesktop(allowLocked: Bool = false) throws -> DriverSessionSample {',
    'func checkBeforeDesktop(allowLocked: Bool = false) throws -> DriverSessionSample {\n if personWaitMutation == "skip-lock" { return DriverSessionSample(onConsole: true, loginDone: true, sessionLocked: false, hidIdleSeconds: 10, secureInput: false) }');
  alter('guard window["processStart"] as? String == start else', 'guard window["processStart"] as? String == start || personWaitMutation == "skip-binding" else');
  alter('func driverSameBounds(_ a: CGRect, _ b: CGRect) -> Bool {\n    abs',
    'func driverSameBounds(_ a: CGRect, _ b: CGRect) -> Bool {\n    if personWaitMutation == "skip-bounds" { return true }; return abs');
  alter('if let stopped = stopped { return stopped }', 'if let stopped = stopped, personWaitMutation != "reset-takeover" { return stopped }');
  alter('let initialInput = beginInput && !inputChecked', 'let initialInput = personWaitMutation != "refuse-token-input" && beginInput && !inputChecked');
  alter('guard baseline.reason != "person-took-over" else', 'guard personWaitMutation == "admit-old-takeover" || baseline.reason != "person-took-over" else');
  alter('try request.checkParentAdmission()', 'if personWaitMutation != "skip-parent-admission" { try request.checkParentAdmission() }');
  alter('try control.check()\n        try stopCheck?()\n        if remaining', 'if personWaitMutation != "ignore-cancel" { try control.check() }\n        try stopCheck?()\n        if remaining');
  alter('waitBeforeAdmission: first && !request.inputAdmitted', 'waitBeforeAdmission: (first || personWaitMutation == "wait-later-guard") && !request.inputAdmitted');
  alter('guard request.remaining >= 0.500 else', 'guard personWaitMutation == "skip-budget-floor" || request.remaining >= 0.500 else');
  alter('try checkPerson(request)\n                return', 'if personWaitMutation != "skip-final-sample" { try checkPerson(request) }\n                return');
  alter('personState.softDeadline = hardDeadline - 0.150', 'if personWaitMutation != "no-soft-deadline" { personState.softDeadline = hardDeadline - 0.150 }');
  alter('providers.heldModifiers() & 0x9e0000 != 0', 'providers.heldModifiers() & (personWaitMutation == "empty-modifier-mask" ? 0 : 0x9e0000) != 0');
  alter('before.matchesPersonTarget(after, request: request, map: map) ||', '(personWaitMutation == "whole-window-digest" ? before.digest == after.digest : before.matchesPersonTarget(after, request: request, map: map)) ||');
  alter('if request.method == "drag", address == nil {', 'if request.method == "drag", address == nil, personWaitMutation != "skip-destination" {');
  const mutatedSource = join(root, 'mutated.swift'), mutatedBinary = join(root, 'mutated');
  await writeFile(mutatedSource, 'let personWaitMutation = CommandLine.arguments.dropFirst().first ?? "none"\n' + mutant + harness);
  await exec('/usr/bin/xcrun', ['swiftc', '-D', 'SLEIGHT_DRIVER_FIXTURES', '-module-cache-path', join(root, 'modules'), mutatedSource, '-o', mutatedBinary],
    { timeout: 360000, killSignal: 'SIGKILL', maxBuffer: 65536 });
  const variants = {
    'short-quiet': ['typing burst ends'], 'long-cap': ['continuous typing'], 'no-reserve': ['deadline reserve'],
    'ignore-pointer': ['pointer parked'], 'skip-checkpoint': ['wait checkpoint'], 'skip-read-check': ['fresh focus', 'fresh lines', 'second action waits'],
    'skip-modifiers': ['fresh modifiers'], 'skip-lock': ['fresh lock'], 'skip-secure': ['fresh secure'],
    'skip-binding': ['fresh binding'], 'skip-bounds': ['fresh bounds'], 'reset-takeover': ['post-admission takeover'],
    'skip-posting-check': ['resumed typing'],
    'forget-scope': ['leaving between the token'],
    'slow-poll': ['poll cadence includes'],
    'refuse-token-input': ['typing between the person token'],
    'admit-old-takeover': ['quiet took-over token'],
    'skip-parent-admission': ['parent admission after'],
    'ignore-cancel': ['cancel during wait'],
    'wait-later-guard': ['later unadmitted guard'],
    'skip-budget-floor': ['post-wait budget floor'],
    'skip-final-sample': ['final fresh sample'],
    'empty-modifier-mask': ['fresh modifiers'],
    'whole-window-digest': ['unrelated field typing'],
    'no-soft-deadline': ['post-wait validation deadline'],
    'skip-destination': ['drag checks the original destination'],
  };
  for (const [variant, expected] of Object.entries(variants)) await t.test(`broken variant detected: ${variant}`, async () => {
    const broken = await exec(mutatedBinary, [variant], { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536 })
      .catch(error => { assert.ok(error.stdout, `${variant} failed without any rule output`); return error; });
    const failed = broken.stdout.trim().split('\n').map(JSON.parse).filter(row => !row.pass).map(row => row.name);
    for (const prefix of expected) assert.ok(failed.some(name => name.startsWith(prefix)), `${variant}: expected ${prefix}, got ${JSON.stringify(failed)}; matching rows: ${broken.stdout.split("\n").filter(line => line.includes(prefix)).join("; ")}`);
  });
});
