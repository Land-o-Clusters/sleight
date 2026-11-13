import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

const source = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
test('all three host-read failures carry fixed read identifiers and unavailable values', () => {
  const audit = s => {
    for (const key of ['hostRead("CG_EVENT"', 'hostRead("CG_WINDOWS"', 'windowRead(pid, overlay: !overlayIDs.isEmpty',
      '"record": "guard-stop"', '"failedRead": stopRead!']) assert.ok(s.includes(key), key);
    const body = s.slice(s.indexOf('    var stopRead:'), s.indexOf('    func frontWindow('));
    assert.doesNotMatch(body, /title|AXTitle|kCGWindowName/);
    assert.match(body, /if stop == nil/);
    assert.match(body, /"read": read, "value": value \?\? s, "pid": pid/);
  };
  audit(source);
  for (const key of ['hostRead("CG_EVENT"', 'hostRead("CG_WINDOWS"', 'windowRead(pid, overlay: !overlayIDs.isEmpty',
    '"record": "guard-stop"', '"failedRead": stopRead!']) assert.throws(() => audit(source.replaceAll(key, 'REMOVED')), assert.AssertionError);
});

test('compiled guard fault records preserve the first failing read, with no title data', { skip: process.platform !== 'darwin' }, t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'uc3st4-host-read-'))); t.after(() => removeTemp(bank));
  const body = source.slice(source.indexOf('    var stopRead:'), source.indexOf('    func frontWindow('));
  const retry = source.slice(source.indexOf('func boundedHostRead<'), source.indexOf('// Kernel birth'));
  const variants = [
    ['good', body],
    ['last-fault', body.replace('if stop == nil', 'if true')],
    ['no-emit', body.replace('emit(["record": "guard-stop", "stop": s, "failedRead": stopRead!])', '')],
    ['wrong-value', body.replace('value: "nil"', 'value: "match"')],
  ];
  const classes = variants.map(([name, code], i) => `final class Replay${i} { var stop: String?; var armed = true\n${code}\n}
var reads${i} = 0
let r${i} = Replay${i}(); let x${i}: Int? = r${i}.hostRead("CG_WINDOWS", pid: 7, { reads${i} += 1; return nil })
r${i}.fault("FOREIGN_WINDOW")
results.append(["name": "${name}", "stop": r${i}.stop!, "read": r${i}.stopRead!, "events": events.count, "reads": reads${i}]); events = []`).join('\n');
  const swift = `import Foundation
var events: [[String: Any]] = [], results: [[String: Any]] = []
func emit(_ row: [String: Any]) { events.append(row) }
${retry}
${classes}
var transientReads = 0, pauses = 0
let transient: Int? = boundedHostRead({ transientReads += 1; return transientReads < 3 ? nil : 7 }, missing: {}, pause: { pauses += 1 })
var falseReads = 0
let readableFalse: Bool? = boundedHostRead({ falseReads += 1; return false }, missing: {}, pause: {})
results.append(["name": "retry", "transientReads": transientReads, "pauses": pauses, "value": transient!, "falseReads": falseReads, "falseValue": readableFalse!])
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: results))
`;
  writeFileSync(join(bank, 'replay.swift'), swift);
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'replay.swift'), '-o', join(bank, 'replay')],
    { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(join(bank, 'replay'), [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 0, run.stderr);
  const rows = JSON.parse(run.stdout);
  const valid = r => r.stop === 'HOST_STATE_UNAVAILABLE' && r.read.read === 'CG_WINDOWS' && r.read.value === 'nil' && r.read.pid === 7 && r.events === 2 && r.reads === 3;
  assert.equal(valid(rows[0]), true);
  for (const row of rows.slice(1, 4)) assert.equal(valid(row), false, row.name);
  assert.deepEqual(rows[4], { name: 'retry', transientReads: 3, pauses: 2, value: 7, falseReads: 1, falseValue: false });
});

test('bounded host retry rejects one-read, unbounded, missing-pause and nil-as-match variants', () => {
  const body = source.slice(source.indexOf('func boundedHostRead<'), source.indexOf('// Kernel birth'));
  const audit = text => {
    assert.match(text, /for attempt in 0\.\.<3/);
    assert.match(text, /if let value = read\(\) \{ return value \}/);
    assert.match(text, /if attempt < 2 \{ pause\(\) \}/);
    assert.match(text, /usleep\(20_000\)/);
    assert.match(text, /return nil/);
  };
  audit(body);
  for (const [before, after] of [['0..<3', '0..<1'], ['0..<3', '0..<4'], ['pause()', ''], ['20_000', '200_000'], ['return nil', 'return read()']])
    assert.throws(() => audit(body.replace(before, after)), assert.AssertionError);
});

test('other guard stops name their measured condition without exposing a window title', () => {
  const needles = ['("SAMPLE_GAP_MS", String(signals.gapMs))', '("FRONT_WINDOW_MATCH", String(!signals.frontChanged))',
    '("POINTER_MATCH", String(!signals.pointerChanged))', '("HID_ACTIVITY", String(signals.personActive))',
    'read: "PARENT_PID", value: String(getppid())', 'read: "KERNEL_PROCESS_BIRTH", value: "nil", pid: vmPID',
    'read: "UTM_CAPTURE_STATE", value: "nil"', 'read: "UTM_UNCOVERED_MATCH", value: "false"',
    'read: field, value: "mismatch", pid: vmPID', 'read: "ELAPSED_SECONDS", value: String(now - began)'];
  const audit = s => { for (const needle of needles) assert.ok(s.includes(needle), needle); };
  audit(source);
  for (const needle of needles) assert.throws(() => audit(source.replaceAll(needle, 'REMOVED')), assert.AssertionError);
  const detail = source.slice(source.indexOf('    func identityFault('), source.indexOf('    var captureItem:'));
  assert.doesNotMatch(detail, /vmTitle|AXTitle|kCGWindowName/);
});

test('AX retry spans a 5.5 second overlay, pauses input and stops on bounded unavailable reads', { skip: process.platform !== 'darwin' }, t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'uc3st13-ax-retry-'))); t.after(() => removeTemp(bank));
  const policy = source.slice(source.indexOf('struct OverlayAXRetry'), source.indexOf('func overlayOptIn'));
  const methods = source.slice(source.indexOf('    var stopRead:'), source.indexOf('    func frontWindow(')) +
    source.slice(source.indexOf('    var pendingAXWindows:'), source.indexOf('    func signalFault('));
  const retry = source.slice(source.indexOf('func boundedHostRead<'), source.indexOf('// Kernel birth'));
  const variants = [
    ['good', policy, methods],
    ['no-overlay-wait', policy.replace('if !overlay', 'if true'), methods],
    ['unbounded', policy.replace('now - began! >= 30', 'false').replace('now - cleared! >= 1', 'false'), methods],
    ['nil-as-readable', policy, methods.replace('if value != nil', 'if true')],
    ['accept-unavailable', policy, methods.replace('fault(reason, read: "AX_WINDOWS", value: "nil", pid: pid)', '')],
  ];
  const classes = variants.map(([name, p, m], i) => `${p.replaceAll('OverlayAXRetry', `Policy${i}`)}
final class Replay${i} { var stop: String?; var armed = true
${m.replaceAll('OverlayAXRetry', `Policy${i}`)}
}
do {
  let g = Replay${i}()
  for n in 0..<55 { let _: [Int]? = g.windowRead(7, overlay: true, now: Double(n)/10, required: { true }, read: { nil }) }
  let paused = !g.pendingAXWindows.isEmpty, survived = g.stop == nil
  let _: [Int]? = g.windowRead(7, overlay: false, now: 5.5, required: { true }, read: { nil })
  let _: [Int]? = g.windowRead(7, overlay: false, now: 5.6, required: { true }, read: { [1] })
  let recovered = g.stop == nil && g.pendingAXWindows.isEmpty
  let persistent = Replay${i}()
  for n in [0.0, 29.9, 30.0] { let _: [Int]? = persistent.windowRead(7, overlay: true, now: n, required: { true }, read: { nil }) }
  let afterClear = Replay${i}()
  for n in [0.0, 5.5, 6.5] { let _: [Int]? = afterClear.windowRead(7, overlay: n == 0, now: n, required: { true }, read: { nil }) }
  let noOverlay = Replay${i}(); let _: [Int]? = noOverlay.windowRead(7, overlay: false, now: 0, required: { true }, read: { nil })
  results.append(["name": "${name}", "paused": paused, "survived": survived, "recovered": recovered,
    "persistent": persistent.stop as Any? ?? NSNull(), "afterClear": afterClear.stop as Any? ?? NSNull(), "noOverlay": noOverlay.stop as Any? ?? NSNull()])
}`).join('\n');
  writeFileSync(join(bank, 'replay.swift'), `import Foundation
typealias AXUIElement = Int
func emit(_ row: [String: Any]) {}
var results: [[String: Any]] = []
${retry.replace('usleep(20_000)', '')}
${classes}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: results))`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'replay.swift'), '-o', join(bank, 'replay')],
    { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(join(bank, 'replay'), [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 0, run.stderr);
  const rows = JSON.parse(run.stdout);
  const valid = r => r.paused && r.survived && r.recovered &&
    ['persistent', 'afterClear', 'noOverlay'].every(k => r[k] === 'HOST_STATE_UNAVAILABLE');
  assert.equal(valid(rows[0]), true, JSON.stringify(rows[0]));
  for (const row of rows.slice(1)) assert.equal(valid(row), false, row.name);
  assert.match(source, /"systemOverlayActive": !overlayIDs\.isEmpty \|\| !pendingAXWindows\.isEmpty/);
  assert.match(source, /windowRead\(pid, overlay: !overlayIDs\.isEmpty, now: now,/);
  assert.match(source, /required: \{ NSRunningApplication\(processIdentifier: pid\)\?\.isTerminated == false \}/);
});
