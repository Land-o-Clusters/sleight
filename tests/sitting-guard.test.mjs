import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const guardSource = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
const witness = 'org.sleight.bench.rt25-witness';
const owned = { pid: 7, owned: true, bound: true };
const documentWindow = { pid: 7, layer: 0, bundle: witness, owned: true, fixture: true };
const menuWindow = { ...documentWindow, layer: 101, hitRole: 'AXMenu', hitPID: 7 };
const windowCase = (name, rows, stop, now = 12.99) => ({ name,
  input: { op: 'fixture-windows', rows, now, menuUntil: 13 }, expected: { stop } });
const fixtureCases = [
  ...['StatusIndicator', 'Software Cursor'].flatMap(name => [
    { name: `${name} metadata survives without inferring a sensor`,
      input: { op: 'window-evidence', pid: 123, bundle: '', window: 99, owner: 'Window Server', name, layer: 555,
        bounds: [1486, 1, 28, 28], alpha: 1 },
      expected: { pid: 123, bundle: '', window: 99, owner: 'Window Server', name, layer: 555, bounds: [1486, 1, 28, 28], alpha: 1,
        privacyIndicator: name === 'StatusIndicator' ? 'unidentified' : 'not-applicable' } },
    windowCase(`${name} name alone never grants an exemption`, [{ pid: 123, layer: 555, bundle: '', name }], 'FOREIGN_WINDOW'),
  ]),
  windowCase('one witness menu within 3 seconds', [documentWindow, menuWindow], null),
  windowCase('foreign pid layer above zero', [documentWindow, { ...menuWindow, pid: 8, owned: false, fixture: false }], 'FOREIGN_WINDOW'),
  windowCase('foreign hit pid', [documentWindow, { ...menuWindow, hitPID: 8 }], 'WINDOW_BLOCKED'),
  windowCase('second extra non-menu window', [documentWindow, menuWindow, { ...documentWindow, layer: 102, hitRole: 'AXWindow' }], 'WINDOW_BLOCKED'),
  windowCase('non-menu extra window', [documentWindow, { ...menuWindow, hitRole: 'AXWindow' }], 'WINDOW_BLOCKED'),
  windowCase('second document window', [documentWindow, menuWindow, documentWindow], 'WINDOW_BLOCKED'),
  windowCase('two menu windows', [documentWindow, menuWindow, { ...menuWindow, layer: 102 }], 'WINDOW_BLOCKED'),
  windowCase('menu exactly at 3 seconds', [documentWindow, menuWindow], 'WINDOW_BLOCKED', 13),
  windowCase('menu after 3 seconds', [documentWindow, menuWindow], 'WINDOW_BLOCKED', 13.01),
  windowCase('menu permission cannot cover Chrome', [documentWindow, { ...menuWindow, bundle: 'com.google.Chrome' }], 'WINDOW_BLOCKED'),
  windowCase('permission prompt still wins', [documentWindow, { ...menuWindow, pid: 8, bundle: 'com.apple.SecurityAgent', owned: false, fixture: false }], 'PERMISSION_PROMPT'),
  windowCase('negative layer still counts', [documentWindow, menuWindow, { ...documentWindow, layer: -1 }], 'WINDOW_BLOCKED'),
  ...[
    [true, [], true, 'READY'], [false, [], false, 'APP_NOT_INSTALLED'],
    [true, [{ pid: 8, owned: false, bound: false }], false, 'APP_ALREADY_RUNNING'],
    [true, [owned], false, 'APP_ALREADY_RUNNING'],
  ].map(([installed, running, available, reason]) => ({ name: `optional Chrome ${reason} ${running.length}`,
    input: { op: 'optional-chrome', installed, running }, expected: { available, reason } })),
  ...[[], [owned], [{ pid: 8, owned: false, bound: false }]].map(running => ({ name: `launch rechecks Chrome count ${running.length} owned ${running[0]?.owned}`,
    input: { op: 'expect-app', running }, expected: { ok: running.length === 0 } })),
  ...[
    [true, [owned], ['AXWindow'], true], [false, [owned], ['AXWindow'], false],
    [true, [], ['AXWindow'], false], [true, [owned, owned], ['AXWindow'], false],
    [true, [{ ...owned, owned: false }], ['AXWindow'], false], [true, [{ ...owned, bound: false }], ['AXWindow'], false],
    [true, [owned], ['AXWindow', 'AXWindow'], false], [true, [owned], ['AXMenu'], false], [true, [owned], null, false],
  ].map(([permitted, running, roles, ready], i) => ({ name: `Chrome ready identity ${i}`,
    input: { op: 'chrome-fixture-ready', permitted, running, roles }, expected: { ready } })),
  ...[
    {}, { bundle: 'com.google.Chrome' }, { bound: false }, { background: false }, { validFrame: false },
    { roles: [] }, { roles: ['AXWindow', 'AXWindow'] },
  ].map((override, i) => ({ name: `context menu binding ${i}`,
    input: { op: 'expect-context-menu', bundle: witness, bound: true, background: true, validFrame: true, roles: ['AXWindow'], now: 10, ...override },
    expected: { ok: i === 0, menuUntil: i === 0 ? 13 : 0 } })),
  { name: 'cleanup only launched pid', input: { op: 'quit-chrome', running: [owned] }, expected: { quitPIDs: [7] } },
  { name: 'cleanup refuses a second owner Chrome', input: { op: 'quit-chrome', running: [owned, { pid: 8, owned: false, bound: false }] }, expected: { error: 'CLEANUP_IDENTITY_REQUIRED', quitPIDs: [] } },
  { name: 'cleanup refuses unknown pid despite a bound flag', input: { op: 'quit-chrome', running: [{ ...owned, owned: false }] }, expected: { error: 'CLEANUP_IDENTITY_REQUIRED', quitPIDs: [] } },
  { name: 'cleanup refuses replaced identity', input: { op: 'quit-chrome', running: [{ ...owned, bound: false }] }, expected: { error: 'CLEANUP_IDENTITY_REQUIRED', quitPIDs: [] } },
  ...[
    [true, undefined, [], null], [true, undefined, [{ pid: 7, owned: false, bound: false }], null],
    [true, undefined, [owned, { pid: 8, owned: false, bound: false }], 'FOREIGN_WINDOW'],
    [false, 7, [owned], null], [false, 7, [], null],
    [true, 7, [owned, { pid: 8, owned: false, bound: false }], 'FOREIGN_WINDOW'],
    [true, 7, [{ pid: 8, owned: false, bound: false }], 'FOREIGN_WINDOW'],
    [false, 7, [{ ...owned, bound: false }], 'FOREIGN_WINDOW'],
    [false, undefined, [{ pid: 8, owned: false, bound: false }], 'FOREIGN_WINDOW'],
  ].map(([permitted, chromePID, running, stop], i) => ({ name: `Chrome process census including windowless owner ${i}`,
    input: { op: 'chrome-processes', permitted, chromePID, running }, expected: { stop } })),
];

test('sample cannot adopt an owner Chrome after the fixture ready PID is pinned', { skip: process.platform !== 'darwin', timeout: 360000 }, () => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-chrome-adoption-test-')));
  try {
    // Execute the ownership block from Guard.sample(), with only OS metadata faked.
    // A bundle-wide permit makes pid 8 owned, hides FOREIGN_WINDOW and authorizes its quit.
    const sample = guardSource.slice(guardSource.indexOf('            let fixture = kind =='), guardSource.indexOf('            safetyRows.append('));
    assert.ok(sample.includes('own.insert(pid)'));
    const census = guardSource.slice(guardSource.indexOf('        if kind == "runtime", launchPermits.contains("com.google.Chrome")'),
      guardSource.indexOf('        guard let rows = hostRead("CG_WINDOWS"'));
    assert.ok(census.includes('chromeProcessesAllowed'));
    const binding = /            if ready \{\n([\s\S]*?)\n            \}/.exec(guardSource)?.[1];
    assert.ok(binding?.includes('chromePID = pid'));
    const pure = guardSource.slice(guardSource.indexOf('struct GuardSignals'), guardSource.indexOf('// The same detector'));
    const source = `import Foundation
import CoreGraphics
${pure}
let kCGWindowName = "title"
enum NSRunningApplication {
  static var apps: [FixtureProcess] = []
  static func runningApplications(withBundleIdentifier: String) -> [FixtureProcess] { apps }
}
final class Replay {
  var kind = "runtime", own = Set<Int32>([7]), ownStarts: [Int32: UInt64] = [7: 20]
  var launchPermits = Set(["com.google.Chrome"]), chromePID: Int32? = 7
  var baseline = Set<Int>(), cleaning = Set<Int32>(), stop: String?
  let started: UInt64 = 10
  func identity(_ app: UInt64?) -> UInt64? { app }
  func bound(_ pid: Int32) -> Bool { ownStarts[pid] == 20 }
  func fixtureTitle(_ title: String) -> Bool { false }
  func fault(_ reason: String, read: String = "", value: String? = nil, pid: Int32 = 0) { stop = stop ?? reason }
  func recordForeign(_ evidence: [String: Any]) {}
  func fixtureProcesses(_ apps: [FixtureProcess]) -> [FixtureProcess] { apps }
  func sampleProcesses() {
${census}
  }
  func readyFixture() {
    let pid: Int32 = 7, date: UInt64 = 20
${binding}
  }
  func sampleWindow(_ pid: Int32) {
    let id = Int(pid) * 10, bundle = "com.google.Chrome", app: UInt64? = 20
    let w: [String: Any] = [:]
    let evidence: [String: Any] = ["pid": pid, "bundle": bundle, "window": id]
    var newForeign: [[String: Any]] = []
${sample}
    if !newForeign.isEmpty { fault("FOREIGN_WINDOW") }
  }
}
let replay = Replay(); replay.sampleWindow(8)
let running: [Int32] = [7, 8]
let quits = running.allSatisfy { chromeCleanupAllowed(owned: replay.own.contains($0), bound: replay.bound($0)) } ? running : []
let pending = Replay(); pending.own = []; pending.ownStarts = [:]; pending.chromePID = nil
pending.sampleWindow(7)
let pendingOwned = pending.own.sorted()
pending.readyFixture(); pending.sampleWindow(7)
let windowless = Replay()
NSRunningApplication.apps = [FixtureProcess(pid: 7, owned: true, bound: true), FixtureProcess(pid: 8, owned: false, bound: false)]
windowless.sampleProcesses()
let result: [String: Any] = ["stop": replay.stop as Any? ?? NSNull(), "owned": replay.own.sorted(), "quitPIDs": quits,
  "pendingOwned": pendingOwned, "readyPID": pending.chromePID as Any? ?? NSNull(), "readyOwned": pending.own.sorted(),
  "permitAfterReady": pending.launchPermits.contains("com.google.Chrome"), "readyStop": pending.stop as Any? ?? NSNull(),
  "windowlessStop": windowless.stop as Any? ?? NSNull(), "windowlessOwned": windowless.own.sorted()]
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: result))
`;
    writeFileSync(join(bank, 'sample.swift'), source);
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'sample.swift'), '-o', join(bank, 'sample')],
      { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
    assert.equal(built.status, 0, built.stderr);
    const result = spawnSync(join(bank, 'sample'), [], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { stop: 'FOREIGN_WINDOW', owned: [7], quitPIDs: [], pendingOwned: [],
      readyPID: 7, readyOwned: [7], permitAfterReady: false, readyStop: null, windowlessStop: 'FOREIGN_WINDOW', windowlessOwned: [7] });
  } finally { rmSync(bank, { recursive: true, force: true }); }
});

test('Swift detectors evaluate idle and fixture recordings without a desktop', { skip: process.platform !== 'darwin', timeout: 600000 }, async t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sitting-guard-test-')));
  try {
    const selected = spawnSync('/usr/bin/xcode-select', ['-p'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 5000 });
    assert.equal(selected.status, 0, selected.stderr);
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'),
      fileURLToPath(new URL('../bench/sitting-guard.swift', import.meta.url)), '-o', join(bank, 'guard')], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 300000 });
    assert.equal(built.status, 0, built.stderr);
    const r = spawnSync(join(bank, 'guard'), ['--selftest'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { drawing: false, passed: 120, failed: 0 });
    const handsOff = spawnSync(join(bank, 'guard'), ['--replay-idle'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ initialIdle: 10, ownerPresentHandsOff: true, steps: [
        { op: 'sample', t: 0.02, idle: 0.001 }, { op: 'open', t: 0.1, allowance: 0 },
        ...Array.from({ length: 40 }, (_, n) => ({ op: 'sample', t: 0.12 + n * 0.02, idle: 0.001 })),
        { op: 'close', t: 1 }, { op: 'sample', t: 1.3, idle: 0.001 },
      ] }) + '\n' });
    assert.equal(handsOff.status, 0, handsOff.stderr);
    const logged = JSON.parse(handsOff.stdout);
    assert.equal(logged.stop, null); assert.equal(logged.resets.length, 42);
    assert.ok(logged.resets.every(row => row.ownerObserved === true && row.accepted === false && Number.isFinite(row.inferredInputUptime)));
    const terminalReplay = spawnSync(join(bank, 'guard'), ['--replay-owner-terminal'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ stdinTTY: true, sameTTY: true, foreground: true, local: true,
        chain: [{ path: '/bin/zsh', sameTTY: true }, { path: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' }] }) + '\n{}\n' });
    assert.equal(terminalReplay.status, 0, terminalReplay.stderr);
    assert.deepEqual(terminalReplay.stdout.trim().split('\n'), ['OWNER_TERMINAL_CONFIRMED', 'LOCAL_OWNER_TTY_REQUIRED']);
    const faultReplay = spawnSync(join(bank, 'guard'), ['--dump-hands-off'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 5000,
      input: [{}, { lockValid: false }, { fault: 'IDENTITY_CHANGED', laterFault: 'FOREIGN_WINDOW' }, { invalidIdle: true }].map(JSON.stringify).join('\n') + '\n' });
    assert.equal(faultReplay.status, 0, faultReplay.stderr);
    assert.deepEqual(faultReplay.stdout.trim().split('\n').map(JSON.parse).map(r => r.stop), [null, 'LIVE_LOCK_CHANGED', 'IDENTITY_CHANGED', 'PERSON_ACTIVE']);
    const sample = (t, idle) => ({ op: 'sample', t, idle });
    const open = t => ({ op: 'open', t }), close = t => ({ op: 'close', t });
    const cases = [
      { name: 'steady outside', steps: [sample(.02, 10.02), sample(1, 11)], stop: null, accepted: [] },
      { name: 'one pulse then rebase', steps: [open(.1), sample(.2, .011), sample(.4, .211), close(1.2), sample(1.4, 1.211)], stop: null, accepted: [true] },
      { name: 'second pulse in call', steps: [open(.1), sample(.2, .011), sample(.24, .01)], stop: 'PERSON_ACTIVE', accepted: [true, false] },
      { name: 'one outside call', steps: [sample(.2, .011)], stop: 'PERSON_ACTIVE', accepted: [false] },
      { name: 'reset in reply tail', steps: [open(.1), close(.2), sample(.34, .01), sample(.5, .17)], stop: null, accepted: [true] },
      { name: 'reset after reply tail', steps: [open(.1), close(.2), sample(.36, .01)], stop: 'PERSON_ACTIVE', accepted: [false] },
      { name: 'drop below rebased line after call', steps: [open(.1), sample(.2, .011), close(.3), sample(.5, .311), sample(.6, .2)], stop: 'PERSON_ACTIVE', accepted: [true, false] },
      { name: 'separate calls each get one', steps: [open(.1), sample(.2, .011), close(.3), open(.5), sample(.6, .011), close(.7), sample(1, .411)], stop: null, accepted: [true, true] },
      { name: '20ms samples distinguish quick second reset', steps: [open(.1), sample(.12, .011), sample(.14, .009)], stop: 'PERSON_ACTIVE', accepted: [true, false] },
      { name: 'zero count refuses first reset', steps: [{ ...open(.1), allowance: 0 }, sample(.12, .001)], stop: 'PERSON_ACTIVE', accepted: [false] },
      { name: 'two count accepts two and stops third', steps: [{ ...open(.1), allowance: 2 }, sample(.12, .001), sample(.14, .001), sample(.16, .001)], stop: 'PERSON_ACTIVE', accepted: [true, true, false] },
    ];
    const replay = spawnSync(join(bank, 'guard'), ['--replay-idle'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 5000,
      input: cases.map(c => JSON.stringify({ initialIdle: 10, steps: c.steps })).join('\n') + '\n' });
    assert.equal(replay.status, 0, replay.stderr);
    const results = replay.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(results.length, cases.length);
    for (const [i, c] of cases.entries()) {
      assert.equal(results[i].drawing, false, c.name); assert.equal(results[i].stop, c.stop, c.name);
      assert.deepEqual(results[i].resets.map(r => r.accepted), c.accepted, c.name);
    }
    const replayFixtures = binary => {
      const replay = spawnSync(binary, ['--replay-fixtures'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 5000,
        input: fixtureCases.map(c => JSON.stringify(c.input)).join('\n') + '\n' });
      assert.equal(replay.status, 0, replay.stderr);
      const values = replay.stdout.trim().split('\n').map(JSON.parse);
      assert.equal(values.length, fixtureCases.length);
      return fixtureCases.filter((c, i) => {
        assert.equal(values[i].drawing, false);
        return JSON.stringify(values[i], Object.keys({ drawing: false, ...c.expected }).sort()) !==
          JSON.stringify({ drawing: false, ...c.expected }, Object.keys({ drawing: false, ...c.expected }).sort());
      }).map(c => c.name);
    };
    assert.deepEqual(replayFixtures(join(bank, 'guard')), []);
    t.diagnostic(`${fixtureCases.length} fixture replays, 11 idle replays, 120 selftest assertions`);
    // Compile only the exact pure production decisions and replay entry point for mutations.
    // No copied detector and no desktop-capable class is present in these executables.
    const slice = (start, end) => guardSource.slice(guardSource.indexOf(start), guardSource.indexOf(end));
    const pureSource = 'import Foundation\nimport CoreGraphics\n' +
      slice('func emit(', 'func windows(') + slice('struct GuardSignals', '// The same detector') +
      slice('func mayQuitDocument(', 'func editedState(') + slice('func requestFixtureQuit(', 'func fixtureCandidate(') +
      slice('func replayFixtures(', 'if CommandLine.arguments.dropFirst() == ["--replay-idle"]');
    const mutations = [
      ['overlay layer evidence', '"layer": layer', '"layer": 0'],
      ['expired menu', 'row.menu && now < menuUntil', 'row.menu'],
      ['non-menu allowance', 'row.menu && now < menuUntil', 'now < menuUntil'],
      ['two menu windows', 'extras.count == 1 && extras.allSatisfy(menuAllowed) ? 1 : 0', 'extras.count <= 2 && extras.allSatisfy(menuAllowed) ? 2 : 0'],
      ['blanket menu exemption', 'if row.fixture && !row.cleaning {', 'if row.fixture && !row.cleaning && !rows.contains(where: menuAllowed) {'],
      ['foreign window', 'signals.foreign = true', 'signals.foreign = false'],
      ['foreign menu ancestry', 'measured["refused"] as? Bool == false', 'true'],
      ['running Chrome availability', 'installed && running.isEmpty', 'installed'],
      ['Chrome launch race', 'bundle == "com.google.Chrome" && !running.isEmpty', 'false'],
      ['unbound Chrome readiness', 'permitted && running.count == 1 && running[0].owned && running[0].bound && roles == ["AXWindow"]',
        'permitted && running.count == 1 && running[0].owned && roles == ["AXWindow"]'],
      ['foreign context menu', 'bound && background && validFrame', 'background && validFrame'],
      ...[['unowned cleanup', 'bound'], ['replaced cleanup identity', 'owned'], ['blanket Chrome cleanup', 'true']]
        .map(([name, decision]) => [name, 'func chromeCleanupAllowed(owned: Bool, bound: Bool) -> Bool { owned && bound }',
          `func chromeCleanupAllowed(owned: Bool, bound: Bool) -> Bool { ${decision} }`]),
      ['menu lifetime', 'let contextMenuAllowanceSeconds = 3.0', 'let contextMenuAllowanceSeconds = 4.0'],
      ['bundle-wide Chrome process permit', 'if let pid = chromePID { return running[0].pid == pid && running[0].owned && running[0].bound }', 'if chromePID != nil { return true }'],
    ];
    for (const [name, before, after] of [['unchanged pure extraction', null, null], ...mutations]) {
      await t.test(name, () => {
        if (before) assert.ok(pureSource.includes(before), name);
        const source = before ? pureSource.replace(before, after) : pureSource;
        writeFileSync(join(bank, 'fixture.swift'), source);
        const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'fixture.swift'), '-o', join(bank, 'fixture')],
          { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
        assert.equal(built.status, 0, built.stderr);
        const failures = replayFixtures(join(bank, 'fixture'));
        if (!before) assert.deepEqual(failures, []);
        else { assert.ok(failures.length > 0, `${name} survived`); t.diagnostic(`${name}: ${failures.length} failing replay(s): ${failures.join(', ')}`); }
      });
    }
    await t.test('production menu deadline matches replay and expires at 3 seconds', () => {
      // Execute the production handler's deadline expression, not a second allowance.
      const expression = /menuUntil = (ProcessInfo\.processInfo\.systemUptime[^\n]*)/.exec(guardSource)?.[1];
      assert.ok(expression);
      const deadline = expression.replace('ProcessInfo.processInfo.systemUptime', '10.0');
      const program = 'import Foundation\nimport CoreGraphics\n' + slice('struct GuardSignals', '// The same detector') +
        `\nprint(${deadline})\n`;
      writeFileSync(join(bank, 'deadline.swift'), program);
      const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'deadline.swift'), '-o', join(bank, 'deadline')],
        { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
      assert.equal(built.status, 0, built.stderr);
      const result = spawnSync(join(bank, 'deadline'), [], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(Number(result.stdout), 13);
    });
  } finally { rmSync(bank, { recursive: true, force: true }); }
});
test('native guard confines mutations to owned cleanup and never posts input or activates', () => {
  const s = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(s, /CGEventPost|CGEventTap|\.activate\(|osascript|SCScreenshotManager/);
  assert.equal(s.match(/\.forceTerminate\(/g)?.length, 1);
  assert.match(s, /requestFixtureQuit\(bundle: process.bundleIdentifier/);
  assert.match(s, /guard fixtureOnly else/);
  assert.match(s, /bound\(pid\), AXUIElementPerformAction\(button, "AXPress"/);
  const cleanup = s.slice(s.indexOf('func beginCleanup('), s.indexOf('func sample()'));
  assert.doesNotMatch(cleanup, /fixtureCandidate\(/);
  assert.match(cleanup, /retainedDocument\(same: CFEqual/);
  assert.match(s, /let edited = docs.map.*editedState/);
  assert.match(s, /writeIntent: writeIntents.contains\(pid\)/);
  assert.match(s, /AXDocumentEdited\/AXEdited unavailable; fixture discard required\./);
  assert.match(s, /if op == "input-readiness", !armed/);
  assert.match(s, /let windowSignals = fixtureWindowSignals\(safetyRows/);
  assert.match(s, /return menuParentAccepted\(measured\)/);
  assert.match(s, /return optionalChrome\(installed: installed, running: running\)/);
  assert.match(s, /guard fixtureLaunchAllowed\(bundle: bundle, running: fixtureProcesses\(apps\)\)/);
  assert.match(s, /guard chromeFixtureReady\(permitted: permitted, running: running, roles: \["AXWindow"\]\) else/);
  assert.match(s, /guard contextMenuAllowed\(bundle: bundle, bound: bound\(pid\), background: pid != front/);
  assert.match(cleanup, /guard chromeCleanupAllowed\(owned: own.contains\(app.processIdentifier\), bound: bound\(app.processIdentifier\)\)/);
  assert.match(cleanup, /let targets = own.filter/);
  const vmCheck = s.slice(s.indexOf('func checkVM('), s.indexOf('func receive('));
  assert.doesNotMatch(vmCheck, /tree\(/);
  assert.match(vmCheck, /now - captureReadAt >= 0.5/);
  assert.doesNotMatch(s, new RegExp(/\/Users\/|ledger\//.source + '|' + ['lanes', 'may', 'test'].join('-')));
});

test('live sample overlay wiring resolves process metadata and bypasses only the recorded cursor tuple', { skip: process.platform !== 'darwin', timeout: 900000 }, () => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-overlay-wiring-')));
  const policy = guardSource.slice(guardSource.indexOf('let statusIndicatorLayer:'), guardSource.indexOf('if CommandLine.arguments.dropFirst() == ["--input-readiness"]'));
  const loop = guardSource.slice(guardSource.indexOf('        for w in rows where num(w, kCGWindowLayer) >= 0'), guardSource.indexOf('            let fixture = kind =='));
  const evidence = guardSource.slice(guardSource.indexOf('func windowEvidence('), guardSource.indexOf('// Counts describe observations.'));
  const tuple = { bundlePath: '/Applications/ChatGPT.app/Contents/XPCServices/CUAService.xpc', owner: 'ChatGPT Computer Use', name: 'Software Cursor', layer: 0 };
  const server = '/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer';
  const cases = [tuple, ...[
    { name: 'ChatGPT' }, { name: 'Allow Computer Use' }, { owner: 'CUAService' }, { layer: 1 },
    { bundlePath: '/Applications/ChatGPT.app.fake/Contents' }, { bundlePath: '/Applications/Impostor.app' },
    { bundlePath: null }, { name: 'Software Cursor ' },
  ].map(change => ({ ...tuple, ...change })),
  ...[555, 0, 25, 2147483630].map(layer => ({ executable: server, owner: 'Window Server', name: 'StatusIndicator', layer })),
  { executable: server, owner: 'Foreign', name: 'StatusIndicator', layer: 555 },
  { owner: 'WindowServer', name: 'StatusIndicator', layer: 555 }];
  const source = `import Foundation
import CoreGraphics
struct NSRunningApplication {
  static var path: String?
  init?(processIdentifier: Int32) { guard processIdentifier == 123 else { return nil } }
  var bundleURL: URL? { Self.path.map { URL(fileURLWithPath: $0) } }
  var bundleIdentifier: String? { "fixture.bundle" }
}
var fakeExecutable: String?
func executablePath(_ pid: Int32) -> String? { pid == 123 ? fakeExecutable : nil }
func num(_ w: [String: Any], _ k: CFString) -> Int { (w[k as String] as? NSNumber)?.intValue ?? -1 }
func bounds(_ w: [String: Any]) -> CGRect? { CGRect(x: 0, y: 0, width: 126, height: 126) }
${evidence}
${policy}
while let line = readLine() {
  let row = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
  NSRunningApplication.path = row["bundlePath"] as? String; fakeExecutable = row["executable"] as? String
  let rows: [[String: Any]] = [[kCGWindowOwnerPID as String: 123, kCGWindowNumber as String: 9,
    kCGWindowName as String: row["name"]!, kCGWindowOwnerName as String: row["owner"]!, kCGWindowLayer as String: row["layer"]!]]
  var overlays: [[String: Any]] = [], processed: [Int] = []
  let overlayIDs = Set<Int>()
${loop}
    processed.append(id)
  }
  let output: [String: Any] = ["processed": processed, "overlays": overlays]
  print(String(data: try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
}`;
  try {
    writeFileSync(join(bank, 'wiring.swift'), source);
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'wiring.swift'), '-o', join(bank, 'wiring')],
      { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(join(bank, 'wiring'), [], { input: cases.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 0, run.stderr);
    const results = run.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(results.length, cases.length);
    results.forEach((result, index) => {
      assert.deepEqual(result.processed, index === 0 ? [] : [9], JSON.stringify(cases[index]));
      if (result.overlays.length) for (const key of ['owner', 'name', 'layer']) assert.equal(result.overlays[0][key], cases[index][key]);
    });
  } finally { rmSync(bank, { recursive: true, force: true }); }
});
