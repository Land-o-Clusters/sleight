// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');

test('native host source: the debugger and relaunch cards have their own exact frame, no Always on a relaunch, and no input synthesis', () => {
  assert.match(source, /BEGIN APP FRAME[\s\S]*END APP FRAME/, 'native app card protocol absent');
  assert.match(source, /\["debugger", "relaunch"\]\.contains\(kind\)/);
  assert.match(source, /kind == "relaunch" \? \["relaunch", "cancel"\]/);
  assert.match(source, /temporary\.boolValue \? \["once", "session", "cancel"\] : \["once", "session", "always", "cancel"\]/);
  // The card answers only from a button of its own alert. The first button is the narrowest choice (Allow once).
  assert.match(source, /guard let id = sender\.representedObject as\? String, let frame = pending\[id\]/);
  assert.doesNotMatch(source, /AXUIElement|CGEventPost|\.post\(|activate\(ignoringOtherApps|performClick/);
  // The ordinary payment sheet names an app document as one.
  assert.match(source, /documentKind"\] as\? String == "app-document"/);
  // The payment and operation sheet takes exactly the JS choices, never session or Always.
  assert.match(source, /guard choices == \["once", "cancel"\] else \{ exit\(65\) \}/);
});

test('native app frame admits only exact keys and exact choice sets without launching UI', { skip: macCommandSkip('xcrun') }, t => {
  const functionSource = source.match(/\/\/ BEGIN APP FRAME\n([\s\S]*?)\/\/ END APP FRAME/);
  assert.ok(functionSource, 'native app card protocol absent');
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-native-app-card-')))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import Foundation\nimport CoreFoundation\n' + functionSource[1] + `
let app: [String: Any] = ["name": "Fixture App", "bundleId": "invalid.fixture.app", "signer": "TEAM123456", "version": "1.2.3",
  "runtime": "electron/39.0.0", "profile": "${MAC_USERS}fixture/Profile", "temporary": false, "pid": 4242, "pidBirth": "1760000000.25",
  "executable": "/Applications/Fixture.app/Contents/MacOS/Fixture", "cdhash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
func card(_ kind: String, _ over: [String: Any] = [:], app overApp: [String: Any] = [:], drop: String? = nil, dropApp: String? = nil) -> [String: Any] {
  var data: [String: Any] = ["kind": kind, "app": app.merging(overApp) { $1 }, "session": "client", "turn": "turn1", "epoch": 1]
  for (key, value) in over { data[key] = value }
  if let drop = drop { data.removeValue(forKey: drop) }
  if let dropApp = dropApp { var inner = data["app"] as! [String: Any]; inner.removeValue(forKey: dropApp); data["app"] = inner }
  return data
}
let full = ["once", "session", "always", "cancel"], short = ["once", "session", "cancel"], relaunch = ["relaunch", "cancel"]
let samples: [Bool] = [
  appFrame(card("debugger"), full) != nil,
  appFrame(card("debugger", app: ["temporary": true]), short) != nil,
  appFrame(card("relaunch"), relaunch) != nil,
  appFrame(card("debugger", app: ["temporary": true]), full) == nil,
  appFrame(card("debugger"), short) == nil,
  appFrame(card("debugger"), ["always", "once", "session", "cancel"]) == nil,
  appFrame(card("debugger"), ["once", "session", "always"]) == nil,
  appFrame(card("relaunch"), full) == nil,
  appFrame(card("relaunch"), ["once", "cancel"]) == nil,
  appFrame(card("debugger"), relaunch) == nil,
  appFrame(card("opt-in"), ["enable", "cancel"]) == nil,
  appFrame(card("debugger", ["approved": true]), full) == nil,
  appFrame(card("debugger", app: ["approved": true]), full) == nil,
  appFrame(card("debugger", drop: "turn"), full) == nil,
  appFrame(card("debugger", dropApp: "profile"), full) == nil,
  appFrame(card("debugger", dropApp: "temporary"), full) == nil,
  appFrame(card("debugger", app: ["temporary": "no"]), full) == nil,
  appFrame(card("debugger", app: ["pid": true]), full) == nil,
  appFrame(card("debugger", app: ["pid": 0]), full) == nil,
  // The unlaunched form: pid 0 with birth "unlaunched", on a debugger card only. A relaunch card needs a process.
  appFrame(card("debugger", app: ["pid": 0, "pidBirth": "unlaunched"]), full) != nil,
  appFrame(card("debugger", app: ["pid": 0, "pidBirth": "unlaunched", "temporary": true]), short) != nil,
  appFrame(card("relaunch", app: ["pid": 0, "pidBirth": "unlaunched"]), relaunch) == nil,
  appFrame(card("debugger", app: ["pidBirth": "unlaunched"]), full) == nil,
  appFrame(card("relaunch", app: ["pidBirth": "unlaunched"]), relaunch) == nil,
  appFrame(card("debugger", app: ["pid": -1, "pidBirth": "unlaunched"]), full) == nil,
  appFrame(card("debugger", app: ["pid": 0, "pidBirth": "Unlaunched"]), full) == nil,
  appFrame(card("debugger", app: ["profile": "relative/profile"]), full) == nil,
  appFrame(card("debugger", app: ["bundleId": "x y"]), full) == nil,
  appFrame(card("debugger", app: ["name": "Bad\\u{7}Name"]), full) == nil,
  appFrame(card("debugger", app: ["name": ""]), full) == nil,
  appFrame(card("debugger", ["session": "bad session"]), full) == nil,
  appFrame(card("debugger", ["session": ""]), full) == nil,
  appFrame(card("debugger", ["epoch": 0]), full) == nil,
  appFrame(card("debugger", ["epoch": false]), full) == nil,
]
let relaunchWords = appCardText(appFrame(card("relaunch"), relaunch)!)
let debuggerWords = appCardText(appFrame(card("debugger"), full)!)
let unlaunchedWords = appCardText(appFrame(card("debugger", app: ["pid": 0, "pidBirth": "unlaunched"]), full)!)
let words: [Bool] = [
  relaunchWords.title.contains("Fixture App"), relaunchWords.body.contains("its own Quit"), !relaunchWords.body.contains("Always"),
  // 1.3.1's relaunch flow: same profile, in the background, no answer to the app's prompts, and what Cancel does.
  // Review F2: a launch that carries the pipe can't be kept from activating, so the card says so.
  relaunchWords.body.contains("on the same profile"), relaunchWords.body.contains("may come to the front briefly"),
  !relaunchWords.body.contains("in the background"), relaunchWords.body.contains("sleight answers none of them"),
  relaunchWords.body.contains("Cancel keeps Fixture App as it is"), relaunchWords.body.contains("Process: 4242"),
  debuggerWords.title.contains("Fixture App"), debuggerWords.body.contains("separate from the app approval"), debuggerWords.body.contains("Process: 4242"),
  debuggerWords.body.contains("Signer: TEAM123456"),
  // Name and code identity, no process: sleight starts or reopens the app only after this approval.
  unlaunchedWords.title.contains("Fixture App"), unlaunchedWords.body.contains("Bundle: invalid.fixture.app"),
  unlaunchedWords.body.contains("Signer: TEAM123456"), unlaunchedWords.body.contains("Executable: /Applications/Fixture.app/Contents/MacOS/Fixture"),
  unlaunchedWords.body.contains("Process: not connected yet (sleight starts or reopens it only after your approval)"), !unlaunchedWords.body.contains("Process: 0"),
]
print(samples.allSatisfy { $0 } && words.allSatisfy { $0 } ? "pass" : "fail \\(samples) \\(words)")
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8' }); assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout.trim(), 'pass', run.stdout);
});

test('the full consent host still compiles with the app cards, without launching UI', { skip: macCommandSkip('xcrun') }, t => {
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-native-app-host-')))));
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(),
    new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname, '-o', join(dir, 'consent-host')], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
});

test('operation cards show scope first and label a session app grant accurately without UI', { skip: macCommandSkip('xcrun') }, t => {
  const block = source.match(/\/\/ BEGIN OPERATION TEXT\n([\s\S]*?)\/\/ END OPERATION TEXT/);
  assert.ok(block);
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-operation-text-')))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import Foundation\n' + block[1] + `
let scope = "Allow for this Grok Bot session only"
let app = operationCardText(["request": String(repeating: "x", count: 2048), "scope": scope], scope: scope)!
let action = operationCardText(["request": "Pay $268?", "scope": "Allow this action once"], scope: "Allow this action once")!
let payment = operationCardText(["amount": "$268"], scope: nil)!
let valid = app.body.hasPrefix(scope + "\\n\\n") && app.allow == "Allow this session"
  && action.body.hasPrefix("Allow this action once\\n\\n") && action.allow == "Allow once"
  && payment.body.contains("$268") && payment.allow == "Allow once"
print(valid ? "pass" : "fail")
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout.trim(), 'pass');
});
