// Owner-run fixture input only. Never posts globally, requests TCC, or sends Apple events.
import AppKit
import ApplicationServices
import Darwin

func fail(_ text: String) -> Never { fputs(text + "\n", stderr); exit(1) }
// BEGIN PERSON CHECK MOUSE EVENT
// PID posting bypasses the global event routing that normally annotates the target window.
// Match shell-card-poster's encoding, keeping the event's private-source provenance intact.
private typealias PersonWindowLocationSetter = @convention(c) (CGEvent, CGPoint) -> Void
private typealias PersonWindowLocationGetter = @convention(c) (CGEvent) -> CGPoint
private let personWindowLocation: (set: PersonWindowLocationSetter, get: PersonWindowLocationGetter)? = {
    guard let framework = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW | RTLD_LOCAL) else { return nil }
    guard let setter = dlsym(framework, "CGEventSetWindowLocation"),
        let getter = dlsym(framework, "CGEventGetWindowLocation") else { dlclose(framework); return nil }
    return (unsafeBitCast(setter, to: PersonWindowLocationSetter.self),
        unsafeBitCast(getter, to: PersonWindowLocationGetter.self))
}()
func personCheckMouseEvent(type: CGEventType, source: CGEventSource, window: Int,
    rect: CGRect, point: CGPoint) -> CGEvent? {
    guard [.leftMouseDown, .leftMouseUp].contains(type), window > 0,
        [rect.minX, rect.minY, rect.width, rect.height, point.x, point.y].allSatisfy({ $0.isFinite }),
        rect.width > 0, rect.height > 0, rect.contains(point), let location = personWindowLocation else { return nil }
    let local = CGPoint(x: point.x - rect.minX, y: rect.maxY - point.y)
    guard let native = NSEvent.mouseEvent(with: type == .leftMouseDown ? .leftMouseDown : .leftMouseUp,
        location: local, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: window, context: nil, eventNumber: 1, clickCount: 1,
        pressure: type == .leftMouseDown ? 1 : 0), let event = native.cgEvent else { return nil }
    event.setSource(source)
    event.location = point
    event.flags = []
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
    location.set(event, CGPoint(x: point.x - rect.minX, y: point.y - rect.minY))
    guard NSEvent(cgEvent: event)?.windowNumber == window,
        location.get(event) == CGPoint(x: point.x - rect.minX, y: point.y - rect.minY) else { return nil }
    return event
}
// END PERSON CHECK MOUSE EVENT
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
guard (args.count == 2 && args[0] == "key" || args.count == 9 && args[0] == "click"),
    let pid = Int32(args[1]), pid > 0,
    CGPreflightPostEventAccess() else { fail("POST_EVENT_ACCESS_REQUIRED: no permission requested") }
guard let source = CGEventSource(stateID: .privateState) else { fail("EVENT_SOURCE_UNAVAILABLE") }
source.userData = 0
if args[0] == "key" {
    // Exactly one posted letter, after the person focuses the field. No Return or HID spoofing.
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) else { fail("EVENT_UNAVAILABLE") }
    event.postToPid(pid)
} else {
    guard let window = Int(args[2]), window > 0 else { fail("WINDOW_UNPROVED") }
    let values = args.dropFirst(3).compactMap(Double.init)
    guard values.count == 6, values.allSatisfy({ $0.isFinite }) else { fail("GEOMETRY_UNPROVED") }
    let point = CGPoint(x: values[0], y: values[1])
    let rect = CGRect(x: values[2], y: values[3], width: values[4], height: values[5])
    // Encode both events before posting either. A missing annotation never sends a partial click.
    guard let down = personCheckMouseEvent(type: .leftMouseDown, source: source, window: window, rect: rect, point: point),
        let up = personCheckMouseEvent(type: .leftMouseUp, source: source, window: window, rect: rect, point: point)
        else { fail("EVENT_UNAVAILABLE") }
    down.postToPid(pid)
    usleep(100_000)
    up.postToPid(pid)
}
print("posted")
