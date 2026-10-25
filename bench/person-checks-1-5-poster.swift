// Owner-run fixture input only. Never posts globally, requests TCC, or sends Apple events.
import AppKit
import ApplicationServices
import Darwin

func fail(_ text: String) -> Never { fputs(text + "\n", stderr); exit(1) }
let args = Array(CommandLine.arguments.dropFirst())
// Read-only check the runner makes before showing any card, so a missing grant fails before the person starts.
if args == ["access"] {
    print(CGPreflightPostEventAccess() ? "true" : "false")
    exit(0)
}
if args == ["voiceover"] {
    print(NSWorkspace.shared.isVoiceOverEnabled ? "true" : "false")
    exit(0)
}
guard args.count == 4, ["key", "click"].contains(args[0]),
    let pid = Int32(args[1]), pid > 0,
    let x = Double(args[2]), x.isFinite, let y = Double(args[3]), y.isFinite,
    CGPreflightPostEventAccess() else { fail("POST_EVENT_ACCESS_REQUIRED: no permission requested") }
guard let source = CGEventSource(stateID: .privateState) else { fail("EVENT_SOURCE_UNAVAILABLE") }
source.userData = 0
let event: CGEvent?
if args[0] == "key" {
    // Exactly one posted letter, after the person focuses the field. No Return or HID spoofing.
    event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
} else {
    event = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
        mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
}
guard let event = event else { fail("EVENT_UNAVAILABLE") }
event.postToPid(pid)
if args[0] == "click" {
    usleep(100_000)
    guard let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
        mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else { fail("EVENT_UNAVAILABLE") }
    up.postToPid(pid)
}
print("posted")
