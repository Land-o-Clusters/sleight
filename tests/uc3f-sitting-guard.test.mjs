import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { UC3F_BLOCK_SECONDS } from '../bench/windows/uc3f-rows.mjs';

test('compiled Swift UC3F policy and broken variants run without host sampling or drawing', { skip: process.platform !== 'darwin', timeout: 360000 }, async t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-uc3f-guard-test-')));
  try {
    let source = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
    const policy = source.slice(source.indexOf('struct UC3FGuardPolicy'), source.indexOf('// Pure safety decisions'));
    assert.ok(policy.includes('func reason'));
    const variants = [
      ['HID', 'if presence == "present" {', 'if true {'],
      ['Hold', 'if let reason = signals.reason { return reason }', 'if let reason = signals.reason, reason != "TIMED_WINDOW_HOLD" { return reason }'],
      ['Cap', 'elapsed >= blockSeconds', 'false'],
      ['Lock', 'if !lockValid { return "LIVE_LOCK_CHANGED" }', 'if false { return "LIVE_LOCK_CHANGED" }'],
      ['Prompt', 'if presence == "present" && !ownerConfirmed', 'if false && !ownerConfirmed'],
    ];
    let fixtures = '';
    for (const [name, before, after] of variants) {
      assert.ok(policy.includes(before), name);
      fixtures += policy.replaceAll('UC3FGuardPolicy', `Broken${name}`).replaceAll(before, after) + '\n';
    }
    fixtures += `
if CommandLine.arguments.dropFirst() == ["--selftest-uc3f-mutants"] {
  var person = GuardSignals(); person.personActive = true
  var hold = GuardSignals(); hold.held = true
  let hid = BrokenHID(presence: "away", blockSeconds: 9000).reason(person, elapsed: 1, lockValid: true)
  let awayHold = BrokenHold(presence: "away", blockSeconds: 9000).reason(hold, elapsed: 1, lockValid: true)
  let presentHold = BrokenHold(presence: "present", blockSeconds: 3600).reason(hold, elapsed: 1, lockValid: true)
  let cap = BrokenCap(presence: "away", blockSeconds: 9000).reason(GuardSignals(), elapsed: 9000, lockValid: true)
  let lock = BrokenLock(presence: "present", blockSeconds: 3600).reason(GuardSignals(), elapsed: 1, lockValid: false)
  let prompt = BrokenPrompt(presence: "present", blockSeconds: 3600).arm(ownerConfirmed: false, initialIdle: 0, lockValid: true)
  emit(["drawing": false, "HID": hid as Any? ?? NSNull(), "awayHold": awayHold as Any? ?? NSNull(),
    "presentHold": presentHold as Any? ?? NSNull(), "cap": cap as Any? ?? NSNull(), "lock": lock as Any? ?? NSNull(), "prompt": prompt as Any? ?? NSNull()])
  exit(0)
}
`;
    // Mutate Guard's production methods in subclasses, all in one compile.
    const method = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
    const wiringVariants = [
      ['Arm', method('    func armUC3F(', '    func checkDeadline('), 'uc3fPolicy = policy', '// lost arm assignment'],
      ['Deadline', method('    func checkDeadline(', '    func recordForeign('), 'uc3fPolicy == nil && ', ''],
      ['Sample', method('    func sampleSignals(', '    func liveLockValid('), 'policy.reason(signals, elapsed: now - began, lockValid: lockValid())', 'Optional<String>.none'],
      ['Capture', method('    func checkVM(', '    func captureState('), 'on && !ownerPresent', 'on'],
      ['Identity', method('    func checkVM(', '    func captureState('), 'num(list[0], kCGWindowNumber) == vmWindow', 'true'],
      ['Geometry', method('    func checkVM(', '    func captureState('), 'bounds(list[0]) != nil', 'bounds(list[0]) == vmBounds'],
      ['Detail', method('    func checkVM(', '    func captureState('), 'identityFault("WINDOW_ID")', 'fault("IDENTITY_CHANGED")'],
    ];
    for (const [name, code, before, after] of wiringVariants) {
      assert.ok(code.includes(before), name);
      fixtures += `final class Broken${name}Guard: Guard {\n${code.replace('    func ', '    override func ').replace(before, after)}\n}\n`;
    }
    fixtures += `func wiringGuard(_ name: String?) -> Guard {
      switch name {
        ${wiringVariants.map(([name]) => `case "${name}": return Broken${name}Guard()`).join('\n')}
        default: return Guard()
      }
    }\n`;
    source = source.replace('final class Guard {', 'class Guard {')
      .replace('let g = Guard(); g.kind = kind', 'let g = wiringGuard(row["broken"] as? String); g.kind = kind');
    source = source.replace('if CommandLine.arguments.dropFirst() == ["--dump-uc3f"]', fixtures + '\nif CommandLine.arguments.dropFirst() == ["--dump-uc3f"]');
    writeFileSync(join(bank, 'guard.swift'), source);
    const binary = join(bank, 'guard');
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'guard.swift'), '-o', binary],
      { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
    assert.equal(built.status, 0, built.stderr);
    const base = { presence: 'away', blockSeconds: UC3F_BLOCK_SECONDS.away, ownerConfirmed: false, initialIdle: 10,
      idle: 11, elapsed: 1, lockValid: true };
    const cases = [
      ['away idle stays armed', {}, null],
      ['away hardware input stops', { idle: 0 }, 'PERSON_ACTIVE'],
      ['away focus stops', { frontChanged: true }, 'FRONTMOST_CHANGED'],
      ['away pointer stops', { pointerChanged: true }, 'POINTER_CHANGED'],
      ['away hold stops', { held: true }, 'TIMED_WINDOW_HOLD'],
      ['away cap stops', { elapsed: 9000, idle: 9010 }, 'DEADLINE_EXCEEDED'],
      ['away cap is not renewable', { elapsed: 9001, idle: 9011 }, 'DEADLINE_EXCEEDED'],
      ['away cap cannot be unbounded', { blockSeconds: 0 }, 'BLOCK_CAP_REQUIRED'],
      ['away busy startup refuses', { initialIdle: 0 }, 'PERSON_ACTIVE'],
      ['present explicit prompt required', { presence: 'present', blockSeconds: 3600 }, 'OWNER_GO_REQUIRED'],
      ['present expects owner input and focus', { presence: 'present', blockSeconds: 3600, ownerConfirmed: true, initialIdle: 0, idle: 0, frontChanged: true, pointerChanged: true }, null],
      ['present hold stops', { presence: 'present', blockSeconds: 3600, ownerConfirmed: true, idle: 0, held: true }, 'TIMED_WINDOW_HOLD'],
      ['present cap stops', { presence: 'present', blockSeconds: 3600, ownerConfirmed: true, elapsed: 3600, idle: 3610 }, 'DEADLINE_EXCEEDED'],
      ['present wrong cap refuses', { presence: 'present', blockSeconds: 9000, ownerConfirmed: true }, 'BLOCK_CAP_REQUIRED'],
      ['present permission stop preserved', { presence: 'present', blockSeconds: 3600, ownerConfirmed: true, permission: true }, 'PERMISSION_PROMPT'],
      ['present stale sample stops', { presence: 'present', blockSeconds: 3600, ownerConfirmed: true, gapMs: 501 }, 'GUARD_STALE'],
      ['present foreign window stops', { presence: 'present', blockSeconds: 3600, ownerConfirmed: true, foreign: true }, 'FOREIGN_WINDOW'],
      ...['away', 'present'].flatMap(presence => [
        [`${presence} missing live lock refuses`, { presence, blockSeconds: UC3F_BLOCK_SECONDS[presence], ownerConfirmed: true, lockValid: false }, 'LIVE_LOCK_CHANGED'],
        [`${presence} removed live lock stops`, { presence, blockSeconds: UC3F_BLOCK_SECONDS[presence], ownerConfirmed: true, lockStillValid: false }, 'LIVE_LOCK_CHANGED'],
      ]),
    ];
    const replay = spawnSync(binary, ['--dump-uc3f'], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
      input: cases.map(([, input]) => JSON.stringify({ ...base, ...input })).join('\n') + '\n' });
    assert.equal(replay.status, 0, replay.stderr);
    const actual = replay.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(actual.length, cases.length);
    for (const [i, [name, , stop]] of cases.entries()) await t.test(name, () => assert.deepEqual(actual[i], { drawing: false, stop }));
    const broken = spawnSync(binary, ['--selftest-uc3f-mutants'], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    assert.equal(broken.status, 0, broken.stderr);
    const result = JSON.parse(broken.stdout);
    for (const name of ['HID', 'awayHold', 'presentHold', 'cap', 'lock', 'prompt']) await t.test(`broken ${name} loses its required refusal`, () => {
      assert.equal(result[name], null);
      assert.throws(() => assert.equal(result[name], name === 'HID' ? 'PERSON_ACTIVE' : name.includes('Hold') ? 'TIMED_WINDOW_HOLD' :
        name === 'cap' ? 'DEADLINE_EXCEEDED' : name === 'lock' ? 'LIVE_LOCK_CHANGED' : 'OWNER_GO_REQUIRED'));
    });
    assert.equal(result.drawing, false);
    const present = { kind: 'uc3f-present', blockSeconds: 3600, ownerConfirmed: true,
      initialIdle: 0, elapsed: 1, lockValid: true, captureOn: false };
    const away = { ...present, kind: 'uc3f-away', blockSeconds: 9000, initialIdle: 10 };
    const legacy = { ...away, kind: 'vm' };
    const wiringCases = [
      ['present capture and movement expected', { captureOn: true, moved: true, personActive: true, frontChanged: true, pointerChanged: true }, null],
      ['present needs explicit go at arm', { ownerConfirmed: false }, 'OWNER_GO_REQUIRED'],
      ['present arm pins cap', { blockSeconds: 9000 }, 'BLOCK_CAP_REQUIRED'],
      ['present missing lock at arm', { lockValid: false }, 'LIVE_LOCK_CHANGED'],
      ['present hold stops in sample', { held: true }, 'TIMED_WINDOW_HOLD'],
      ['present lock change stops in sample', { lockStillValid: false }, 'LIVE_LOCK_CHANGED'],
      ['present stale sample stops', { gapMs: 501 }, 'GUARD_STALE'],
      ['present foreign window stops', { foreign: true }, 'FOREIGN_WINDOW'],
      ['present permission stops', { permission: true }, 'PERMISSION_PROMPT'],
      ['present blocked window stops', { blocked: true }, 'WINDOW_BLOCKED'],
      ['present unknown capture stops', { captureOn: null }, 'CAPTURE_STATE_UNKNOWN'],
      ['present different UTM window stops', { window: 71 }, 'IDENTITY_CHANGED'],
      ['present different VM title stops', { title: 'other-vm' }, 'IDENTITY_CHANGED'],
      ['present extra UTM window stops', { secondWindow: true }, 'IDENTITY_CHANGED'],
      ['present restarted UTM stops', { restarted: true }, 'IDENTITY_CHANGED'],
      ['present missing process start stops', { missingStart: true }, 'PROCESS_START_UNREADABLE'],
      ['present missing window stops', { missingWindow: true }, 'IDENTITY_CHANGED'],
      ['present missing bounds stops', { missingBounds: true }, 'IDENTITY_CHANGED'],
      ['present exceeds legacy cap safely', { elapsed: 2500 }, null],
      ['present block deadline stops', { elapsed: 3600 }, 'DEADLINE_EXCEEDED'],
      ['away captures still stop', { ...away, captureOn: true }, 'CAPTURE_ON'],
      ['away geometry still stops', { ...away, moved: true }, 'IDENTITY_CHANGED'],
      ['away different ID at same geometry stops', { ...away, window: 71 }, 'IDENTITY_CHANGED'],
      ['away different title at same geometry stops', { ...away, title: 'other-vm' }, 'IDENTITY_CHANGED'],
      ['away input still stops', { ...away, personActive: true }, 'PERSON_ACTIVE'],
      ['away focus still stops', { ...away, frontChanged: true }, 'FRONTMOST_CHANGED'],
      ['away pointer still stops', { ...away, pointerChanged: true }, 'POINTER_CHANGED'],
      ['away lasts beyond legacy cap', { ...away, elapsed: 2500 }, null],
      ['away deadline stops', { ...away, elapsed: 9000 }, 'DEADLINE_EXCEEDED'],
      ['RT31 capture still stops', { ...legacy, captureOn: true }, 'CAPTURE_ON'],
      ['RT31 geometry still stops', { ...legacy, moved: true }, 'IDENTITY_CHANGED'],
      ['RT31 deadline still stops', { ...legacy, elapsed: 601 }, 'DEADLINE_EXCEEDED'],
    ];
    const brokenCases = [
      ['Arm', { moved: true }, null], ['Deadline', { elapsed: 2500 }, null], ['Sample', { held: true }, 'TIMED_WINDOW_HOLD'],
      ['Capture', { captureOn: true }, null], ['Identity', { window: 71 }, 'IDENTITY_CHANGED'], ['Geometry', { moved: true }, null],
    ];
    const wiring = spawnSync(binary, ['--dump-uc3f-wiring'], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
      input: [...wiringCases.map(([, input]) => ({ ...present, ...input })),
        ...brokenCases.map(([broken, input]) => ({ ...present, ...input, broken })),
        { ...present, window: 71, broken: 'Detail' }].map(JSON.stringify).join('\n') + '\n' });
    assert.equal(wiring.status, 0, wiring.stderr);
    const wiringResults = wiring.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(wiringResults.length, wiringCases.length + brokenCases.length + 1);
    for (const [i, [name, input, stop]] of wiringCases.entries()) await t.test(name, () => {
      assert.equal(wiringResults[i].drawing, false);
      assert.equal(wiringResults[i].ownerPresent, (input.kind ?? present.kind) === 'uc3f-present' &&
        !['OWNER_GO_REQUIRED', 'BLOCK_CAP_REQUIRED'].includes(stop) && input.lockValid !== false);
      assert.equal(wiringResults[i].stop, stop);
      const field = input.restarted || input.missingStart ? 'PROCESS_START' : input.secondWindow || input.missingWindow ? 'WINDOW_COUNT' :
        input.window ? 'WINDOW_ID' : input.title ? 'WINDOW_TITLE' : input.moved || input.missingBounds ? 'WINDOW_BOUNDS' : null;
      assert.equal(wiringResults[i].identityField, stop === 'IDENTITY_CHANGED' ? field : null);
    });
    for (const [i, [name, , stop]] of brokenCases.entries()) await t.test(`broken Guard ${name} wiring is caught`, () => {
      assert.throws(() => assert.equal(wiringResults[wiringCases.length + i].stop, stop), assert.AssertionError);
    });
    await t.test('broken identity detail is caught even when its stop code survives', () => {
      assert.equal(wiringResults.at(-1).stop, 'IDENTITY_CHANGED');
      assert.throws(() => assert.equal(wiringResults.at(-1).identityField, 'WINDOW_ID'), assert.AssertionError);
    });
  } finally { rmSync(bank, { recursive: true, force: true }); }
});

function wiringPolicy(source) {
  const arm = source.slice(source.indexOf('        if op == "arm" {'), source.indexOf('        if op == "check", armed'));
  const sample = source.slice(source.indexOf('    func sample()'), source.indexOf('    var vmPID:'));
  assert.match(arm, /armUC3F\(r, initialIdle: initialIdle, lockValid: liveLockValid\(bind: true\)\)/);
  assert.match(sample, /checkDeadline\(now\)/);
  assert.match(sample, /sampleSignals\(signals, now: now, lockValid: \{ liveLockValid\(\) \}\)/);
  assert.match(sample, /let overlayIDs = overlayExemption\(rows\)/);
  assert.match(sample, /if kind == "vm" \|\| uc3fPolicy != nil \{ checkVM\(rows\.filter \{ !overlayIDs\.contains\(num\(\$0, kCGWindowNumber\)\) \}\) \}/);
}
test('host arm and sample call the dump-tested wiring, with caught missing-call variants', () => {
  const source = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
  wiringPolicy(source);
  for (const before of ['armUC3F(r, initialIdle: initialIdle, lockValid: liveLockValid(bind: true))',
    'checkDeadline(now)', 'sampleSignals(signals, now: now, lockValid: { liveLockValid() })',
    'let overlayIDs = overlayExemption(rows)',
    'checkVM(rows.filter { !overlayIDs.contains(num($0, kCGWindowNumber)) })']) {
    assert.throws(() => wiringPolicy(source.replace(before, 'removed()')), assert.AssertionError);
  }
});
