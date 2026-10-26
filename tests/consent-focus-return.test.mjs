import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

// The 2026-10-22 qualification runs: the click that answered a card left the accessory host active with no window, and when the
// worker and its host exited, VS Code (the card's app, its window under the card) came to the front. The host now hands
// activation back when a card closes. These tests drive the decision with fakes; nothing is shown or activated.
const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');

test('cards and alerts record who was in front, follow the person to the activating click, and hand activation back', () => {
  assert.match(source, /activeAsk = \(id, panel\); if !panel.passive \{ focus\.presenting\(data\) \}; panel\.show\(\); return/);
  assert.match(source, /self\.activeAsk = nil; if card.kind != "handoff" \{ self\.focus\.dismissed\(\) \}; self\.respond\(id, choice\); self\.showNextAsk\(\)/);
  assert.match(source, /func closeAsk\(\) \{ guard let ask = activeAsk else \{ return \}; ask\.panel\.close\(\); activeAsk = nil; if !ask.panel.passive \{ focus\.dismissed\(\) \} \}/);
  assert.match(source, /addObserver\(forName: NSApplication\.willBecomeActiveNotification, object: nil, queue: nil\) \{ \[weak self\] _ in\s*self\?\.focus\.hostActivating\(\)/);
  // All four menu-bar alerts (turbo off, session opt-in or resume, action confirm, and VC10's Revoke card for a Mac without
  // Touch ID or a password) go through personModal, which restores.
  assert.equal((source.match(/personModal\(alert, choices:/g) ?? []).length, 4);
  assert.match(source, /focus\.presenting\(\[:\]\)\n\s*let result = withExtendedLifetime\(actions\) \{ modal\.run\(abort: \{ NSApp\.abortModal\(\) \}\) \{ alert\.runModal\(\) \} \}\n\s*focus\.dismissed\(\)/);
  // A recorded app is checked by pid, bundle and launch date.
  assert.match(source, /AppIdentity\(pid: pid, bundle: app\.bundleIdentifier, launched: app\.launchDate\?\.timeIntervalSince1970\)/);
  // Handoff never becomes key or runs focus restoration. Other cards keep the existing behavior.
  assert.match(source, /func show\(\) \{\s*if passive \{ panel.orderFrontRegardless\(\) \} else \{ panel.makeKeyAndOrderFront\(nil\) \}\s*NSSound\(named: "Glass"\)\?\.play\(\)\s*\}/);
  const block = source.match(/\/\/ BEGIN FOCUS RETURN\n([\s\S]*?)\/\/ END FOCUS RETURN/)?.[1];
  assert.ok(block, 'focus return absent');
  assert.doesNotMatch(block, /CGEvent|AXUIElement|NSApp\.|NSRunningApplication\(|NSWorkspace\./, 'the decision itself touches no system state');
  assert.doesNotMatch(source, /activate\(ignoringOtherApps|activateIgnoringOtherApps/);
});

test('Swift focus return with fakes: back to the person\'s latest app, never the card\'s app, never over the person\'s own switch', { skip: macCommandSkip('xcrun') }, t => {
  const block = source.match(/\/\/ BEGIN FOCUS RETURN\n([\s\S]*?)\/\/ END FOCUS RETURN/)[1];
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-focus-return-')))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import Foundation\n' + block + `
func check(_ ok: Bool, _ what: String) { if !ok { print("FAIL " + what); exit(1) } }
// pids: host 50, Terminal 100, Safari 200, the VS Code fixture 300 (a second copy 301 shares its bundle), Notes 400.
let base: [pid_t: AppIdentity] = [50: AppIdentity(pid: 50, bundle: nil, launched: 1), 100: AppIdentity(pid: 100, bundle: "com.apple.Terminal", launched: 1),
  200: AppIdentity(pid: 200, bundle: "com.apple.Safari", launched: 1), 300: AppIdentity(pid: 300, bundle: "com.microsoft.VSCode", launched: 1),
  301: AppIdentity(pid: 301, bundle: "com.microsoft.VSCode", launched: 2), 400: AppIdentity(pid: 400, bundle: "com.apple.Notes", launched: 1)]
var front: pid_t? = 100, active = false, apps = base, activated: [pid_t] = []
func make() -> FocusReturn {
    FocusReturn(host: 50, frontmost: { front }, identify: { apps[$0] }, hostActive: { active }, activate: { activated.append($0) })
}
let vscode: [String: Any] = ["kind": "debugger", "app": ["bundleId": "com.microsoft.VSCode", "pid": NSNumber(value: 300)]]
let unlaunched: [String: Any] = ["kind": "debugger", "app": ["bundleId": "com.microsoft.VSCode", "pid": NSNumber(value: 0)]]
let notes: [String: Any] = ["kind": "debugger", "app": ["bundleId": "com.apple.Notes", "pid": NSNumber(value: 400)]]
let alert: [String: Any] = [:]
func reset() { front = 100; active = false; apps = base; activated = [] }
// The click: willBecomeActive fires with the person's app still in front, then the host is active.
func click(_ focus: FocusReturn) { focus.hostActivating(); front = 50; active = true }

// The receipts' case: the click activates the host; the card closes; Terminal comes back before any host exit.
reset(); var focus = make(); focus.presenting(vscode); click(focus)
check(focus.dismissed() == 100 && activated == [100], "click then close returns to Terminal")
// The person switched to Safari after the card appeared, then clicked it: Safari, their latest choice, comes back.
reset(); focus = make(); focus.presenting(vscode); front = 200; click(focus)
check(focus.dismissed() == 200 && activated == [200], "latest app before the click")
// The workspace still reports Terminal while the host is active: activity decides.
reset(); focus = make(); focus.presenting(vscode); active = true
check(focus.dismissed() == 100, "stale frontmost while the host is active")
// The fixture took over while the card was up, or no app holds activation: Terminal comes back (the accepted trade-off).
reset(); focus = make(); focus.presenting(vscode); front = 300
check(focus.dismissed() == 100, "fixture in front")
reset(); focus = make(); focus.presenting(vscode); front = 301
check(focus.dismissed() == 100, "another copy of the card's app in front")
reset(); focus = make(); focus.presenting(vscode); front = nil
check(focus.dismissed() == 100, "no app in front")
// The person moved to Safari and never clicked the card: Safari stays.
reset(); focus = make(); focus.presenting(vscode); front = 200
check(focus.dismissed() == nil && activated.isEmpty, "the person's own switch stands")
// Nothing took over (a card that timed out unclicked): no call at all.
reset(); focus = make(); focus.presenting(vscode)
check(focus.dismissed() == nil && activated.isEmpty, "Terminal still in front")
// The person was in the card's app, by pid or by bundle (before launch): never recorded, never activated.
reset(); front = 300; focus = make(); focus.presenting(vscode); click(focus)
check(focus.previous == nil && focus.dismissed() == nil && activated.isEmpty, "previous is the card's app")
reset(); front = 301; focus = make(); focus.presenting(unlaunched); click(focus)
check(focus.previous == nil && focus.dismissed() == nil && activated.isEmpty, "previous shares the card's bundle")
// The recorded app quit, or its pid now belongs to a relaunched copy: nothing to return to.
reset(); focus = make(); focus.presenting(vscode); click(focus); apps[100] = nil
check(focus.dismissed() == nil && activated.isEmpty, "previous app gone")
reset(); focus = make(); focus.presenting(vscode); click(focus); apps[100] = AppIdentity(pid: 100, bundle: "com.apple.Terminal", launched: 9)
check(focus.dismissed() == nil && activated.isEmpty, "pid reused by a later launch")
reset(); focus = make(); focus.presenting(vscode); click(focus); apps[100] = AppIdentity(pid: 100, bundle: "com.example.other", launched: 1)
check(focus.dismissed() == nil && activated.isEmpty, "pid reused by another app")
// Menu-bar alerts name no app and still return activation; runModal activates the host the same way.
reset(); focus = make(); focus.presenting(alert); click(focus)
check(focus.dismissed() == 100, "alert")
// An alert over an open card: activation returns once, when the last closes.
reset(); focus = make(); focus.presenting(vscode); focus.presenting(alert); click(focus)
check(focus.dismissed() == nil && focus.open == 1, "alert closes first")
check(focus.dismissed() == 100 && activated == [100], "card closes last")
// Queued cards with a lagging frontmost: after the first answer the workspace still names the host, then the fixture.
reset(); focus = make(); focus.presenting(vscode); click(focus)
check(focus.dismissed() == 100, "first card")
active = false; focus.presenting(vscode); check(focus.previous == AppIdentity(pid: 100, bundle: "com.apple.Terminal", launched: 1), "host not recorded")
front = 300; click(focus); check(focus.previous?.pid == 100, "fixture not recorded")
check(focus.dismissed() == 100 && activated == [100, 100], "second card keeps Terminal")
// A queued card about another app while the frontmost still names the first card's app: that app is not recorded either.
reset(); focus = make(); focus.presenting(vscode); click(focus); check(focus.dismissed() == 100, "vscode card")
front = 300; active = false; focus.presenting(notes); check(focus.previous?.pid == 100, "closed card's app not recorded")
click(focus); check(focus.dismissed() == 100, "notes card returns to Terminal")
// Once focus has returned, the next card records afresh.
front = 200; focus.presenting(notes); check(focus.previous?.pid == 200, "fresh record after return")
_ = focus.dismissed()
// One close per card: a close with no card open does nothing.
reset(); focus = make(); active = true
check(focus.dismissed() == nil && activated.isEmpty, "no card shown")
focus.hostActivating(); check(focus.previous == nil, "no record without a card")
// The host never records itself.
reset(); front = 50; focus = make(); focus.presenting(vscode); active = true
check(focus.previous == nil && focus.dismissed() == nil && activated.isEmpty, "no previous app recorded")
// The card's target: pid only when launched.
check(cardTarget(vscode)?.pid == 300 && cardTarget(vscode)?.bundle == "com.microsoft.VSCode", "launched target")
check(cardTarget(unlaunched)?.pid == nil && cardTarget(unlaunched)?.bundle == "com.microsoft.VSCode", "unlaunched target")
check(cardTarget(alert) == nil, "no target")
print("pass")
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8', timeout: 180000 });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.stdout.trim(), 'pass', run.stdout + run.stderr);
});
