// Fake foreign window IDs and geometry only. No NSApplication, windows, event posting or run loop.
func check(_ ok: Bool) { if !ok { print("ENCODING_FAILED"); exit(1) } }
let source = CGEventSource(stateID: .privateState)!
source.userData = 0
let old = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
    mouseCursorPosition: CGPoint(x: 866, y: 447), mouseButton: .left)!
let oldWindow = NSEvent(cgEvent: old)!.windowNumber
var rows: [[String: Any]] = []
for (source, hidpid) in [(source, false), (CGEventSource(stateID: .hidSystemState)!, true)] {
for (window, rect, point) in [
    (2147483001, CGRect(x: 556, y: 318, width: 400, height: 199), CGPoint(x: 866, y: 447)),
    (2147483002, CGRect(x: -900, y: -200, width: 400, height: 199), CGPoint(x: -590, y: -71))
] {
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        let event = personCheckMouseEvent(type: type, source: source, window: window, rect: rect, point: point, hidpid: hidpid)!
        let ns = NSEvent(cgEvent: event)!
        let local = personWindowLocation!.get(event)
        let restored = CGEvent(withDataAllocator: nil, data: event.data!)!
        let restoredLocal = personWindowLocation!.get(restored)
        check(NSEvent(cgEvent: restored)!.windowNumber == window)
        check(restored.location == point)
        rows.append(["hidpid": hidpid, "window": ns.windowNumber, "expectedWindow": window,
            "global": [event.location.x, event.location.y], "expectedGlobal": [point.x, point.y],
            "local": [local.x, local.y], "restoredLocal": [restoredLocal.x, restoredLocal.y],
            "cocoaLocal": [local.x, rect.height - local.y], "clickCount": ns.clickCount,
            "sourceState": event.getIntegerValueField(.eventSourceStateID),
            "expectedSourceState": source.sourceStateID.rawValue,
            "sourcePid": event.getIntegerValueField(.eventSourceUnixProcessID),
            "expectedSourcePid": hidpid ? 0 : Int64(getpid()),
            "userData": event.getIntegerValueField(.eventSourceUserData)])
    }
}
}
let rect = CGRect(x: 10, y: 20, width: 400, height: 200), point = CGPoint(x: 100, y: 100)
let invalid = [
    personCheckMouseEvent(type: .leftMouseDown, source: source, window: 0, rect: rect, point: point),
    personCheckMouseEvent(type: .mouseMoved, source: source, window: 17, rect: rect, point: point),
    personCheckMouseEvent(type: .leftMouseDown, source: source, window: 17, rect: rect, point: .zero),
    personCheckMouseEvent(type: .leftMouseDown, source: source, window: 17, rect: .zero, point: point),
    personCheckMouseEvent(type: .leftMouseDown, source: source, window: 17, rect: rect, point: CGPoint(x: CGFloat.nan, y: 100))
]
check(invalid.allSatisfy { $0 == nil })
let result: [String: Any] = ["oldWindow": oldWindow, "pid": getpid(), "events": rows, "invalidRefused": invalid.count]
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
