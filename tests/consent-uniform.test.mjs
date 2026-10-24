import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import * as nativeHost from '../plugins/sleight/lib/direct-browser/host.mjs';

const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
test('standalone and shared cached consent hosts receive the installed icon through a closed environment', () => {
  assert.equal(typeof nativeHost.consentEnvironment, 'function');
  const env = nativeHost.consentEnvironment();
  assert.deepEqual(Object.keys(env).sort(), ['LANG', 'PATH', 'SLEIGHT_CONSENT_ICON']);
  assert.equal(env.SLEIGHT_CONSENT_ICON, new URL('../plugins/sleight/assets/icon.png', import.meta.url).pathname);
  const launcher = readFileSync(new URL('../plugins/sleight/lib/direct-browser/host.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /consent \? '--consent' : '--menu'\][\s\S]*?env: consentEnvironment\(\)/);
  assert.match(launcher, /spawn\(path, \[\], \{ env: consentEnvironment\(\)/);
});
test('validated Electron cards use the common automatic presenter and guarded choice mapping', () => {
  assert.match(source, /func automaticCard\(/, 'typed Electron-to-common-card adapter is missing');
  const next = source.slice(source.indexOf('func showNextAsk()'), source.indexOf('let modal = ModalGuard()'));
  assert.match(next, /automaticCard\(data, choices\)/);
  assert.doesNotMatch(next, /data\["presentation"\] != nil/);
  assert.match(source, /if reviewAsk\(id\) \{ return \}/);
  const panel = source.slice(source.indexOf('final class AskCardPanel'), source.indexOf('// END ASK CARD'));
  assert.match(panel, /choices = card.choices/);
  assert.match(panel, /finish\(choices\[sender.tag\]\)/);
  assert.match(panel, /personChoice\(card.kind, choices\[index\]\)/);
  assert.match(panel, /NSImage\(systemSymbolName: "hand.raised.fill"/);
  assert.doesNotMatch(panel.match(/func review\(\)[^\n]*/)?.[0] ?? '', /NSSound|show\(/);
  assert.match(source, /pending.count < 32/);
  assert.match(source, /closeAsk\(\); modal.close\(\); pending.removeAll\(\)/);
});

test('common card policy dispatches exact choices, queues once, expires and resets without UI', { skip: macCommandSkip('xcrun') }, t => {
  assert.match(source, /func automaticCard\(/, 'adapter is missing');
  const app = source.match(/\/\/ BEGIN APP FRAME\n([\s\S]*?)\/\/ END APP FRAME/)?.[1];
  const model = source.slice(source.indexOf('struct AskCard {'), source.indexOf('final class HandoffPanel'));
  const hostMethods = source.slice(source.indexOf('    func closeAsk()'), source.indexOf('    let modal = ModalGuard()'));
  const iconExpression = source.match(/icon\.image = ([^\n]+)/)?.[1];
  assert.ok(app && model && hostMethods);
  assert.ok(iconExpression);
  const dir = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-uniform-consent-'))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import Foundation\nimport CoreFoundation\n' + app + model + `
final class AskCardPanel {
    static var shows = 0, reviews = 0, closes = 0
    let answer: (String) -> Void
    let passive: Bool
    init(_ card: AskCard, deadline: Double, answer: @escaping (String) -> Void) { self.answer = answer; passive = card.kind == "handoff" }
    func show() { Self.shows += 1 }
    func review() { Self.reviews += 1 }
    func close() { Self.closes += 1 }
}
final class Modal { var active = false }
final class Focus {
    var presented: [String] = [], dismissals = 0
    func presenting(_ data: [String: Any]) { presented.append(data["kind"] as? String ?? "") }
    @discardableResult func dismissed() -> Int32? { dismissals += 1; return nil }
}
final class Host {
    var pending: [String: [String: Any]] = [:]
    var activeAsk: (id: String, panel: AskCardPanel)?
    let modal = Modal()
    let focus = Focus()
    var answers: [String] = []
    func rebuildMenu() {}
    func respond(_ id: String, _ choice: String) { pending.removeValue(forKey: id); answers.append(choice) }
` + hostMethods + `
}
let app: [String: Any] = ["name": "Fixture", "bundleId": "invalid.fixture", "signer": "TEAM", "version": "1",
  "runtime": "electron/39", "profile": "/fixture/profile", "temporary": false, "pid": 42, "pidBirth": "1",
  "executable": "/fixture/bin", "cdhash": String(repeating: "a", count: 40)]
func data(_ kind: String, temporary: Bool = false) -> [String: Any] {
  var copy = app; copy["temporary"] = temporary
  return ["kind": kind, "app": copy, "session": "client", "turn": "turn", "epoch": 1]
}
let full = ["once", "session", "always", "cancel"], short = ["once", "session", "cancel"], reopen = ["relaunch", "cancel"]
let debug = automaticCard(data("debugger"), full)!, temporary = automaticCard(data("debugger", temporary: true), short)!
let relaunch = automaticCard(data("relaunch"), reopen)!
precondition(debug.kind == "debugger" && debug.host == "sleight" && debug.choices == ["cancel", "once", "session", "always"])
precondition(debug.labels == ["Don't allow", "Allow once", "Allow this session", "Always allow"])
precondition(debug.question == "Let sleight control Fixture?" && debug.detail.contains("including anything open or signed in"))
precondition(temporary.choices == ["cancel", "once", "session"] && !temporary.labels.contains("Always allow"))
precondition(relaunch.kind == "relaunch" && relaunch.choices == ["cancel", "relaunch"])
precondition(relaunch.labels == ["Cancel", "Quit and reopen"] && relaunch.detail.contains("may come to the front briefly"))
precondition(automaticCard(data("relaunch"), full) == nil)
precondition(automaticCard(data("debugger", temporary: true), full) == nil)
precondition(consentIconPath("/installed/sleight/assets/icon.png") == "/installed/sleight/assets/icon.png")
precondition(consentIconPath("") == "")
precondition(consentIconPath("relative/assets/icon.png") == "")
let scope = "Allow for this Grok Bot session only"
let shell: [String: Any] = ["view": ["clientSession": "Grok Bot", "scope": scope],
  "operation": ["scope": scope, "request": "Use Fixture"],
  "presentation": ["style": "ask", "question": "Allow Fixture?", "detail": scope, "host": "Grok Bot",
    "icon": "/installed/sleight/assets/icon.png", "kind": "app"]]
let existing = automaticCard(shell, ["once", "cancel"])!
precondition(existing.kind == "app" && existing.choices == ["cancel", "once"] && existing.labels == ["Don't allow", "Allow this session"])
precondition(automaticCard(shell, full) == nil)
precondition(automaticCard(["kind": "opt-in", "session": "client", "epoch": 1], ["enable", "cancel"]) == nil)
// The actual panel expression, with the image framework replaced by a headless dependency.
struct NSImage {
  let source: String
  init?(contentsOfFile path: String) { guard path == "/installed/sleight/assets/icon.png" else { return nil }; source = "asset" }
  init?(systemSymbolName name: String, accessibilityDescription: String?) { source = name }
}
struct IconCard { let icon: String }
func image(_ path: String) -> NSImage? { let card = IconCard(icon: path); return ` + iconExpression + ` }
precondition(image("")?.source == "hand.raised.fill")
precondition(image("/missing/assets/icon.png")?.source == "hand.raised.fill")
precondition(image("/installed/sleight/assets/icon.png")?.source == "asset")
func frame(_ kind: String, _ choices: [String], expired: Bool = false) -> [String: Any] {
  return ["data": data(kind), "choices": choices, "deadline": Date().timeIntervalSince1970 * 1000 + (expired ? -1000 : 60000)]
}
let host = Host()
host.pending["a"] = frame("debugger", full); host.pending["b"] = frame("relaunch", reopen)
host.showNextAsk(); host.showNextAsk()
precondition(AskCardPanel.shows == 1 && host.activeAsk?.id == "a")
precondition(host.reviewAsk("a") && AskCardPanel.reviews == 1 && AskCardPanel.shows == 1)
host.activeAsk!.panel.answer("session")
precondition(host.answers == ["session"] && AskCardPanel.shows == 2 && host.activeAsk?.id == "b")
host.activeAsk!.panel.answer("cancel")
precondition(host.activeAsk == nil && host.pending.isEmpty)
host.pending["expired"] = frame("debugger", full, expired: true); host.showNextAsk()
precondition(host.pending.isEmpty && AskCardPanel.shows == 2)
host.modal.active = true; host.pending["queued"] = frame("debugger", full); host.showNextAsk()
precondition(host.activeAsk == nil && AskCardPanel.shows == 2)
host.modal.active = false; host.showNextAsk(); precondition(AskCardPanel.shows == 3)
host.closeAsk(); host.pending.removeAll(); host.showNextAsk()
precondition(host.activeAsk == nil && AskCardPanel.closes == 1 && AskCardPanel.shows == 3)
// Each shown card records the app in front first; each answer and the abort hand activation back.
precondition(host.focus.presented == ["debugger", "relaunch", "debugger"] && host.focus.dismissals == 3)
// The handoff adapter validates exact targets and keeps focus bookkeeping out of the passive card.
let native: [String: Any] = ["kind": "handoff", "session": "client", "turn": "turn", "app": "com.example.Reader"]
let tab: [String: Any] = ["kind": "handoff", "session": "client", "turn": "turn", "tab": "tfixture"]
let handoffChoices = ["continue", "cancel"]
let nativeCard = automaticCard(native, handoffChoices)!, tabCard = automaticCard(tab, handoffChoices)!
precondition(nativeCard.choices == ["cancel", "continue"] && nativeCard.labels == ["Cancel", "Continue"])
precondition(nativeCard.detail.contains("same app fresh, including its new window"))
precondition(tabCard.detail.contains("this tab or its owned opener") && !tabCard.detail.contains("its new window"))
precondition(nativeCard.detail.contains("expires in at most four minutes"))
precondition(automaticCard(native.merging(["tab": "tfixture"]) { $1 }, handoffChoices) == nil)
precondition(automaticCard(native.merging(["signedIn": true]) { $1 }, handoffChoices) == nil)
precondition(automaticCard(native.merging(["app": "bad app"]) { $1 }, handoffChoices) == nil)
precondition(automaticCard(native, ["always", "cancel"]) == nil)
host.pending["native"] = ["data": native, "choices": handoffChoices, "deadline": Date().timeIntervalSince1970 * 1000 + 60000]
host.showNextAsk(); precondition(host.activeAsk?.panel.passive == true)
host.activeAsk!.panel.answer("continue")
precondition(host.focus.presented == ["debugger", "relaunch", "debugger"] && host.focus.dismissals == 3)
print("pass")
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(dir, 'cache'), swift, '-o', binary], { encoding: 'utf8', timeout: 120000 });
  assert.equal(built.status, 0, built.stderr);
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'pass');
});
