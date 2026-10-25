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

test('the menu bar item starts hidden, carries the glove template glyph and has no title text', () => {
  assert.match(source, /item\.isVisible = false/);
  assert.match(source, /image\.isTemplate = true/);
  assert.doesNotMatch(source, /"sleight disconnected"/);
  assert.match(source, /item\.isVisible = menuVisible\(status, requests: requests, handEnabled: hand\?\.enabled \?\? false, sinceAct: since\)/);
  // The hookup runs on the bar button only, starts on a connect transition and leaves no timer behind.
  assert.match(source, /if hookupConnects\(from: previous, to: status\)/);
  assert.match(source, /if index == hookupFrameCount \{ timer\.invalidate\(\); self\.hookupTimer = nil \}/);
});

test('the Ghost Hand row is a checkmark item that answers with its own choice, without asking', () => {
  assert.match(source, /case let \.toggle\(title, choice, on\):[\s\S]*?entry\.state = on \? \.on : \.off/);
  assert.match(source, /case let \.toggle\(title, choice, on\):[\s\S]*?#selector\(control\(_:\)\)/);
});

test('Turn Turbo Off asks first, and Settings & Help opens only the fixed docs address', () => {
  const confirmOff = source.match(/@objc func confirmOff\(_ sender: NSMenuItem\) \{([\s\S]*?)\n    \}/)?.[1];
  assert.ok(confirmOff, 'Turn Turbo Off confirmation absent');
  assert.match(confirmOff, /let alert = NSAlert\(\)\n\s*alert\.messageText = "Turn turbo off\?"/);
  assert.match(confirmOff, /alert\.addButton\(withTitle: "Turn Off"\)\n\s*alert\.addButton\(withTitle: "Cancel"\)\n\s*let answer = personModal\(alert, choices: \["turbo-off", "cancel"\], kind: "turbo-off"\)\n\s*if answer == \.alertFirstButtonReturn \{ respond\(id, choice\) \}/);
  assert.equal(confirmOff.match(/respond\(/g)?.length, 1, 'only the confirmed first button responds');
  // This alert must install GB12's guarded actions and retain them throughout the abortable modal.
  assert.match(source, /func personModal\([^\n]+\{\n\s*let actions = consentInputActions\(alert, choices: choices, kind: kind\)\n(?:\s*defer \{ for action in actions \{ action\.typing\?\.invalidate\(\) \} \}\n)?\s*focus\.presenting\(\[:\]\)\n\s*let result = withExtendedLifetime\(actions\) \{ modal\.run\(abort: \{ NSApp\.abortModal\(\) \}\) \{ alert\.runModal\(\) \} \}\n[^}]*DispatchQueue\.main\.async \{ self\.showNextAsk\(\) \}\n\s*return result/);
  assert.match(source, /return choice == "always" \|\| \[[^\n]*"turbo-off"(?:, "handoff")?\]\.contains\(kind\)/);
  assert.match(source, /URL\(string: "https:\/\/github\.com\/Land-o-Clusters\/sleight\/blob\/main\/docs\/settings\.md#" \+ \(status == nil \? "ghost-hand" : "turbo"\)\)/);
  assert.equal(source.match(/NSWorkspace\.shared\.open/g)?.length, 1);
});

test('the Permissions rows only remove access: Revoke and Never Act answer at once on the hand channel, and nothing lifts a block', () => {
  assert.match(source, /@objc func permissionClick\(_ sender: NSMenuItem\) \{\n {8}guard let event = sender\.representedObject as\? \[String: String\] else \{ return \}\n {8}writePermissionEvent\(event\)\n {4}\}/);
  assert.match(source, /\["revoke", "revoke-all", "block"\]\.contains\(op\)/);
  assert.doesNotMatch(source, /[Uu]nblock"/, 'no menu row unblocks');
  assert.match(source, /func menuNeedsUpdate\(_ menu: NSMenu\) \{ fillPermissions\(menu\) \}/);
});

test('the usage row is a plain disabled line that answers nothing', () => {
  assert.match(source, /case let \.usage\(text\): menu\.addItem\(NSMenuItem\(title: text, action: nil, keyEquivalent: ""\)\)/);
});

test('the status menu shows only while turbo is in use and admits only the worker\'s known choices', { skip: macCommandSkip('xcrun') }, t => {
  const block = source.match(/\/\/ BEGIN STATUS MENU\n([\s\S]*?)\/\/ END STATUS MENU/);
  const hookup = source.match(/\/\/ BEGIN HOOKUP\n([\s\S]*?)\/\/ END HOOKUP/);
  assert.ok(block, 'status menu block absent'); assert.ok(hookup, 'hookup block absent');
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-status-menu-')))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import Foundation\n' + block[1] + hookup[1] + `
func check(_ ok: Bool, _ what: String) { if !ok { print("FAIL " + what); exit(1) } }
check(!statusVisible("disconnected", requests: 0), "hidden when disconnected")
check(!statusVisible(nil, requests: 0), "hidden before any status")
check(statusVisible("disconnected", requests: 1), "shown for a waiting request")
for s in ["connected", "connected-idle", "paused", "cleanup-required"] { check(statusVisible(s, requests: 0), "shown when " + s) }
let rows = statusRows(["status": "connected", "browser": "Google Chrome", "payments": "ask", "version": "1.3.0"], ["pause", "disconnect", "turbo-off"])!
check(rows == [.status(title: "Connected to Google Chrome", dot: "green", details: ["Payments: asks unless you named the amount"]),
  .separator, .action("Pause", choice: "pause"), .action("Disconnect", choice: "disconnect"),
  .separator, .confirm("Turn Turbo Off…", choice: "turbo-off"), .help, .separator, .footer("sleight 1.3.0")], "connected menu")
let paused = statusRows(["status": "paused", "browser": "Helium"], ["disconnect", "turbo-off"])!
check(paused.first == .status(title: "Paused · Helium", dot: "orange", details: ["Resumes when Claude next asks, with your OK"]), "paused header")
check(!paused.contains(.action("Pause", choice: "pause")), "no Pause when paused")
check(statusRows(["status": "cleanup-required"], ["cleanup"])! == [.status(title: "Cleanup needed", dot: "red", details: []),
  .separator, .action("Clean Up", choice: "cleanup"), .separator, .help], "cleanup menu, no footer without a version")
check(statusRows(["status": "connected"], ["pause", "launch"]) == nil, "unknown choice refused")
check(statusRows(["status": "elsewhere"], ["pause"]) == nil, "unknown status refused")
check(statusRows(["status": "connected", "browser": "Chrome<script>"], ["disconnect"])!.first == .status(title: "Connected", dot: "green", details: []), "odd browser name dropped")
check(statusRows(["status": "connected", "payments": "sometimes", "version": "1.3.0; rm"], ["disconnect"])!.last == .help, "unknown payment value and odd version dropped")
check(statusRows(["status": "connected", "optOut": "failed"], ["disconnect"])!.first == .status(title: "Connected", dot: "green", details: [optOutFailed]), "failed opt-out shown")
// The Ghost Hand row: a checkmark showing the hand's setting, whose one choice flips it.
check(statusRows(["status": "connected", "hand": "on"], ["pause", "disconnect", "hand-off", "turbo-off"])! == [.status(title: "Connected", dot: "green", details: []),
  .separator, .action("Pause", choice: "pause"), .action("Disconnect", choice: "disconnect"),
  .separator, .toggle("Ghost Hand", choice: "hand-off", on: true), .confirm("Turn Turbo Off…", choice: "turbo-off"), .help], "hand on row")
check(statusRows(["status": "paused", "hand": "off"], ["disconnect", "hand-on", "turbo-off"])!.contains(.toggle("Ghost Hand", choice: "hand-on", on: false)), "hand off row")
check(statusRows(["status": "cleanup-required", "hand": "on"], ["cleanup", "hand-off"])! == [.status(title: "Cleanup needed", dot: "red", details: []),
  .separator, .action("Clean Up", choice: "cleanup"), .separator, .toggle("Ghost Hand", choice: "hand-off", on: true), .help], "hand row while cleanup waits")
check(statusRows(["status": "connected", "hand": "on"], ["hand-on"]) == nil, "the choice must flip the shown state")
check(statusRows(["status": "connected", "hand": "off"], ["hand-off"]) == nil, "the choice must flip the shown state, off")
check(statusRows(["status": "connected"], ["disconnect", "hand-off"]) == nil, "a hand choice needs the hand state")
check(statusRows(["status": "connected", "hand": "on"], ["disconnect", "hand-off", "hand-on"]) == nil, "one hand choice at most")
check(statusRows(["status": "connected", "hand": "maybe"], ["disconnect"]) == nil, "unknown hand state refused")
check(statusRows(["status": "connected", "hand": "on"], ["disconnect"])! == [.status(title: "Connected", dot: "green", details: []),
  .separator, .action("Disconnect", choice: "disconnect"), .separator, .help], "no row without its choice")
// The shared host: the glove shows for turbo, a waiting request, or an enabled hand that acted in the last five minutes.
check(handIdleWindow == 300, "five minutes")
check(!menuVisible(nil, requests: 0, handEnabled: true, sinceAct: nil), "hand on, no action yet")
check(menuVisible(nil, requests: 0, handEnabled: true, sinceAct: 0), "hand just acted")
check(menuVisible(nil, requests: 0, handEnabled: true, sinceAct: 299.9), "inside the window")
check(!menuVisible(nil, requests: 0, handEnabled: true, sinceAct: 300), "past the window")
check(!menuVisible(nil, requests: 0, handEnabled: false, sinceAct: 1), "hand off")
check(!menuVisible("disconnected", requests: 0, handEnabled: true, sinceAct: nil), "turbo disconnected, hand idle")
check(menuVisible("paused", requests: 0, handEnabled: false, sinceAct: nil), "turbo paused")
check(menuVisible(nil, requests: 1, handEnabled: false, sinceAct: nil), "a waiting request")
// Without turbo, the hand's own block: its toggle, Settings & Help, the version.
check(handRows(enabled: true, version: "1.3.1") == [.toggle("Ghost Hand", choice: "hand-toggle", on: true), .separator, .help, .separator, .footer("sleight 1.3.1")], "hand-only menu")
check(handRows(enabled: false, version: "1.3; x") == [.toggle("Ghost Hand", choice: "hand-toggle", on: false), .separator, .help], "hand-only menu, odd version dropped")
// With turbo, the hand channel's toggle joins the turbo menu once, before Turn Turbo Off.
check(withHand(statusRows(["status": "connected"], ["pause", "disconnect", "turbo-off"])!, enabled: true) == [.status(title: "Connected", dot: "green", details: []),
  .separator, .action("Pause", choice: "pause"), .action("Disconnect", choice: "disconnect"),
  .separator, .toggle("Ghost Hand", choice: "hand-toggle", on: true), .confirm("Turn Turbo Off…", choice: "turbo-off"), .help], "turbo menu with the hand")
check(withHand(statusRows(["status": "cleanup-required"], ["cleanup"])!, enabled: false) == [.status(title: "Cleanup needed", dot: "red", details: []),
  .separator, .action("Clean Up", choice: "cleanup"), .separator, .toggle("Ghost Hand", choice: "hand-toggle", on: false), .help], "cleanup menu with the hand")
let workerRow = statusRows(["status": "connected", "hand": "on"], ["disconnect", "hand-off"])!
check(withHand(workerRow, enabled: true) == workerRow, "never a second Ghost Hand row")
// Turbo's connect hookup: the four dabs flow in and settle on the glyph in under a second.
check(Double(hookupFrameCount) * hookupInterval < 1 && Double(hookupFrameCount) * hookupInterval >= 0.5, "under a second")
check(hookupFrame(menuGlyph, hookupFrameCount - 1) == menuGlyph, "settles on the glyph")
check((0..<(hookupFrameCount - 1)).allSatisfy { hookupFrame(menuGlyph, $0) != menuGlyph }, "moves until the last frame")
check(hookupFrame(menuGlyph, 0).contains("fill-opacity") && hookupFrame(menuGlyph, 0).components(separatedBy: "<rect").count == 5, "four dabs fading in")
check(hookupFrame(menuGlyph, 0).replacingOccurrences(of: #"<rect[^>]*/>"#, with: "", options: .regularExpression)
  == menuGlyph.replacingOccurrences(of: #"<rect[^>]*/>"#, with: "", options: .regularExpression), "only the dabs move")
check(hookupConnects(from: nil, to: "connected") && hookupConnects(from: "disconnected", to: "connected") && hookupConnects(from: "paused", to: "connected"), "connecting")
// Never Act on <site>: the site turbo last worked on, after the session actions, only with its choice and a bare http(s) origin.
check(statusRows(["status": "connected", "site": "https://example.com"], ["pause", "disconnect", "block-site", "turbo-off"])! == [.status(title: "Connected", dot: "green", details: []),
  .separator, .action("Pause", choice: "pause"), .action("Disconnect", choice: "disconnect"), .action("Never Act on example.com", choice: "block-site"),
  .separator, .confirm("Turn Turbo Off…", choice: "turbo-off"), .help], "site row")
check(statusRows(["status": "connected", "site": "http://localhost:8080"], ["block-site"])!.contains(.action("Never Act on http://localhost:8080", choice: "block-site")), "http keeps its scheme")
check(statusRows(["status": "connected"], ["block-site"]) == nil, "the site choice needs its site")
for bad in ["https://example.com/path", "javascript:alert(1)", "https://EXAMPLE.com", "https://example.com:99999x"] {
  check(statusRows(["status": "connected", "site": bad], ["disconnect"]) == nil, "an origin only: " + bad)
}
check(statusRows(["status": "connected", "site": "https://example.com"], ["disconnect"])! == [.status(title: "Connected", dot: "green", details: []),
  .separator, .action("Disconnect", choice: "disconnect"), .separator, .help], "no site row without its choice")
// The Permissions submenu: each grant with its last use, Revoke All, Never Act in the current app, the blocks, ChatGPT's list.
let payload: [String: Any] = ["grants": [["title": "Fixture", "detail": "always", "used": 1000.0, "target": "app:Fixture"],
  ["title": "Chat App", "detail": "debugger, always", "used": NSNull(), "target": "electron:com.example.chat"],
  ["title": "Google Chrome", "detail": "turbo", "used": 4000.0, "target": "turbo"]],
  "blocked": ["Blocked App", "https://blocked.example"], "current": ["title": "Editor", "target": "com.example.editor"], "only": ["https://a.example"]]
check(permissionRows(permissionsData(payload)!, now: 8200) == [.grant("Fixture · always · used 2h ago", target: "app:Fixture"),
  .grant("Chat App · debugger, always · not used yet", target: "electron:com.example.chat"), .info("Google Chrome · turbo · used 1h ago"),
  .info("Turn Turbo Off… or sleight-mcp turbo off stops turbo"), .revokeAll, .separator, .block("Never Act in Editor", target: "com.example.editor"), .separator, .info("Blocked: Blocked App"),
  .info("Blocked: https://blocked.example"), .info("Acts only on: https://a.example"), .info("sleight-mcp permissions changes these"),
  .separator, .info("ChatGPT's own Always allow list: in ChatGPT's settings")], "permission rows")
// Turbo's row only points to Turn Turbo Off…: no Revoke, and no Revoke All when it is the only row.
check(permissionRows(permissionsData(["grants": [["title": "Helium", "detail": "turbo", "used": NSNull(), "target": "turbo"]], "blocked": [Any]()])!, now: 0) ==
  [.info("Helium · turbo · not used yet"), .info("Turn Turbo Off… or sleight-mcp turbo off stops turbo"),
  .separator, .info("ChatGPT's own Always allow list: in ChatGPT's settings")], "turbo row points to Turn Turbo Off")
check(permissionRows(permissionsData(["grants": [Any](), "blocked": [Any]()])!, now: 0) == [.info("Nothing beyond this session's approvals"),
  .separator, .info("ChatGPT's own Always allow list: in ChatGPT's settings")], "nothing standing")
let grant: [String: Any] = ["title": "Fixture", "detail": "always", "used": NSNull(), "target": "app:Fixture"]
for (bad, what) in [(["grants": [Any](), "blocked": [Any](), "extra": 1] as [String: Any], "unknown key"),
  (["grants": [grant.merging(["more": 1]) { $1 }], "blocked": [Any]()], "grant key"), (["grants": [grant.merging(["target": "app:"]) { $1 }], "blocked": [Any]()], "empty app"),
  (["grants": [grant.merging(["target": "unblock:x"]) { $1 }], "blocked": [Any]()], "unknown target"), (["grants": [grant.merging(["used": "x"]) { $1 }], "blocked": [Any]()], "used text"),
  (["grants": [grant.merging(["used": true]) { $1 }], "blocked": [Any]()], "used boolean"), (["grants": [grant.merging(["title": "a\\u{7}b"]) { $1 }], "blocked": [Any]()], "control character"),
  (["grants": [Any](), "blocked": Array(repeating: "x", count: 25)], "too many blocks"), (["grants": [Any](), "blocked": [Any](), "current": ["title": "x", "target": "not a bundle"]], "current target"),
  (["grants": [Any](), "blocked": [Any](), "only": [Any]()], "empty only"), (["grants": [Any]()], "no blocked")] {
  check(permissionsData(bad) == nil, "refused: " + what)
}
check(usedWords(nil, now: 9) == "not used yet" && usedWords(100, now: 130) == "used just now" && usedWords(0, now: 300) == "used 5m ago" && usedWords(0, now: 3 * 86400) == "used 3d ago", "used words")
// The submenu joins the hand-only block after the toggle, and the turbo menu before Turn Turbo Off, once.
check(handRows(enabled: true, version: "1.3.1", permissions: [.info("x")]) == [.toggle("Ghost Hand", choice: "hand-toggle", on: true), .permissions([.info("x")]),
  .separator, .help, .separator, .footer("sleight 1.3.1")], "hand-only menu with permissions")
check(withHand(statusRows(["status": "connected"], ["disconnect", "turbo-off"])!, enabled: true, permissions: [.info("x")]) == [.status(title: "Connected", dot: "green", details: []),
  .separator, .action("Disconnect", choice: "disconnect"), .separator, .toggle("Ghost Hand", choice: "hand-toggle", on: true), .permissions([.info("x")]),
  .confirm("Turn Turbo Off…", choice: "turbo-off"), .help], "turbo menu with the hand and permissions")
check(withHand(workerRow, enabled: true, permissions: [.info("x")]).filter({ if case .toggle = $0 { return true }; return false }).count == 1, "still one Ghost Hand row")
check(!hookupConnects(from: "connected", to: "connected") && !hookupConnects(from: "connected-idle", to: "connected") && !hookupConnects(from: nil, to: "paused"), "not connecting")
// The host line, from the relay's label of each host's own clientInfo (fixtures in tests/fixtures/host-client-info.json).
for (host, label) in [("claude-code", "Claude Code 2.1.289"), ("codex", "Codex 0.160.0"), ("cursor", "Cursor")] {
  check(statusRows(["status": "connected", "host": label, "payments": "ask"], ["disconnect"])!.first ==
    .status(title: "Connected", dot: "green", details: ["Host: " + label, "Payments: asks unless you named the amount"]), "host line for " + host)
}
check(statusRows(["status": "connected-idle", "host": "Codex 0.160.0"], ["disconnect"])!.first ==
  .status(title: "Connected", dot: "green", details: ["Host: Codex 0.160.0", "Its session has ended"]), "idle session names no host by guess")
check(statusRows(["status": "connected-idle"], ["disconnect"])!.first == .status(title: "Connected", dot: "green", details: ["Its session has ended"]), "no host, no host line")
check(statusRows(["status": "connected", "host": "Codex\\nmodel gpt"], ["disconnect"])!.first == .status(title: "Connected", dot: "green", details: []), "odd host dropped")
check(statusRows(["status": "connected", "host": String(repeating: "a", count: 73)], ["disconnect"])!.first == .status(title: "Connected", dot: "green", details: []), "long host dropped")
// The usage row (1.4.0): each path's median from the action log's last 7 days, exact keys and bounded numbers, after Permissions.
check(usageData(["native": 1.5, "turbo": 0.6, "saved": 312]) == UsageStats(native: 1.5, turbo: 0.6, saved: 312), "usage with both paths")
check(usageWords(UsageStats(native: 1.5, turbo: 0.6, saved: 312)) == "Last 7 days: 1.5 s per native action · 0.6 s per turbo action · 312 reads saved", "usage words")
check(usageWords(usageData(["native": 12, "saved": 1])!) == "Last 7 days: 12.0 s per native action · 1 read saved", "native only")
check(usageWords(usageData(["turbo": 0.4, "saved": 0])!) == "Last 7 days: 0.4 s per turbo action · 0 reads saved", "turbo only")
for (bad, what) in [(["native": 1.5, "saved": 3, "days": 7] as [String: Any], "extra key"), (["saved": 3], "no path"), (["native": 1.5], "no saved"),
  (["perAction": 1.5, "saved": 3], "the old key"), (["native": "1.5", "saved": 3], "text seconds"), (["native": true, "saved": 3], "boolean seconds"),
  (["native": -0.1, "saved": 3], "negative"), (["turbo": 3600.1, "saved": 3], "over an hour"), (["native": 1.5, "saved": 3.5], "fractional saved"),
  (["native": 1.5, "saved": 1e10], "huge saved"), (["native": 1.5, "saved": 3, "turbo": NSNull()], "null turbo"), (["native": 1.5, "saved": false], "boolean saved")] {
  check(usageData(bad) == nil, "usage refused: " + what)
}
check(usageData("Last 7 days") == nil, "usage is an object")
check(handRows(enabled: true, version: "1.4.0", permissions: [.info("x")], usage: UsageStats(native: 1.5, turbo: nil, saved: 2)) == [.toggle("Ghost Hand", choice: "hand-toggle", on: true),
  .permissions([.info("x")]), .usage("Last 7 days: 1.5 s per native action · 2 reads saved"), .separator, .help, .separator, .footer("sleight 1.4.0")], "hand-only menu with usage")
check(withHand(statusRows(["status": "connected"], ["disconnect", "turbo-off"])!, enabled: true, usage: UsageStats(native: nil, turbo: 0.4, saved: 0)) == [.status(title: "Connected", dot: "green", details: []),
  .separator, .action("Disconnect", choice: "disconnect"), .separator, .toggle("Ghost Hand", choice: "hand-toggle", on: true),
  .usage("Last 7 days: 0.4 s per turbo action · 0 reads saved"), .confirm("Turn Turbo Off…", choice: "turbo-off"), .help], "turbo menu with usage")
check(handRows(enabled: true, version: "1.4.0") == [.toggle("Ghost Hand", choice: "hand-toggle", on: true), .separator, .help, .separator, .footer("sleight 1.4.0")], "no usage, no row")
print("pass")
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8' });
  assert.equal(run.stdout.trim(), 'pass', run.stdout);
});
