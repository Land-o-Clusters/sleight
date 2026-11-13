// Pointer input for sleight.driver/1. Behavior follows sleight's drag.js window-local
// pid posting. No engine or agent-desktop implementation is used here.
import Foundation
import AppKit
import CoreGraphics
import Darwin

struct DriverPointerFault: Error {
    let code: String
    let message: String
    var delivery = "not-sent"
    var cleanup = "not-needed"
    var personTookOver = false
    var unhealthy = false
    var reason: String? = nil
    var pointerRefusal: String? = nil
    var targetRole: String? = nil

    var json: [String: Any] {
        var value: [String: Any] = ["code": code, "message": message, "unhealthy": unhealthy, "delivery": delivery,
         "retry": delivery == "not-sent" ? "safe" : "read-first",
         "personTookOver": personTookOver, "settled": false, "buttonCleanup": cleanup]
        if let reason = reason { value["reason"] = reason }
        if let pointerRefusal = pointerRefusal { value["pointerRefusal"] = pointerRefusal }
        if delivery == "not-sent", let targetRole = targetRole { value["targetRole"] = targetRole }
        if code == "ACTION_UNSUPPORTED" && delivery == "not-sent" { value["clipboard"] = "untouched" }
        return value
    }
}

struct DriverPointerWindow {
    let pid: pid_t
    let windowID: UInt32
    let bounds: CGRect
    let json: [String: Any]
}

struct DriverPointerGeometry {
    let bounds: CGRect
    let pixelWidth: Double
    let pixelHeight: Double
}

// RT2 supplies these closures from the bound window and retained read. RT6 supplies
// the person check inside checkBeforePost. None has a permissive default.
struct DriverPointerContext {
    let window: DriverPointerWindow
    let geometry: DriverPointerGeometry?
    let validateRead: () throws -> Void
    let resolveElement: (Any) throws -> CGRect
    let checkBeforePost: () throws -> Void
    let checkReleaseIdentity: () throws -> Void
    let remaining: () -> Double
    let wait: (Double) throws -> Void
    let admitInput: () throws -> Void
    var actionPlan: (([DriverPointerStep]) -> Void)? = nil
    var checkCoordinate: ((CGPoint) throws -> Void)? = nil
    var dispatch: (((() throws -> Void)?, () throws -> Void) throws -> Void)? = nil
    var clearRelease: (() -> Void)? = nil
}

struct DriverPointerEvent {
    let type: CGEventType
    let point: CGPoint                    // global top-left points
    var button: CGMouseButton = .left
    var clickCount: Int64 = 1
    var wheelX: Int32 = 0
    var wheelY: Int32 = 0
}

struct DriverPointerStep {
    let event: DriverPointerEvent
    var release: DriverPointerEvent? = nil // prepared before any input
    var delay: Double = 0
}

protocol DriverPointerPrepared {
    func validate(_ index: Int) throws
    func post(_ index: Int) throws
    func release(_ index: Int) throws
}

extension DriverPointerPrepared {
    func validate(_ index: Int) throws {}
}

protocol DriverPointerSink {
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared
}

enum DriverPointer {
    static let methods = ["click", "doubleClick", "rightClick", "scroll", "drag"]
    static let dragSteps = 25

    static func fault(_ code: String, _ message: String) -> DriverPointerFault {
        DriverPointerFault(code: code, message: message)
    }

    static func incompleteAncestry() -> DriverPointerFault {
        DriverPointerFault(code: "ACTION_UNSUPPORTED",
            message: "The target's accessibility tree is incomplete. Try another element from a read or a keyboard route.",
            pointerRefusal: "incomplete-ancestry")
    }

    static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
              n.doubleValue.isFinite else { return nil }
        return n.doubleValue
    }

    static func validRect(_ rect: CGRect) -> Bool {
        [rect.origin.x, rect.origin.y, rect.width, rect.height, rect.maxX, rect.maxY].allSatisfy { $0.isFinite }
            && rect.size.width > 0 && rect.size.height > 0
    }

    static func contains(_ rect: CGRect, _ point: CGPoint) -> Bool {
        point.x.isFinite && point.y.isFinite && point.x >= rect.minX && point.y >= rect.minY
            && point.x < rect.maxX && point.y < rect.maxY
    }

    static func validateTarget(_ value: Any) throws {
        if let pair = value as? [Any], pair.count == 2,
           number(pair[0]) != nil, number(pair[1]) != nil { return }
        if let n = number(value), n >= 0, n <= 9_007_199_254_740_991, n.rounded() == n { return }
        if let object = value as? [String: Any], object.count == 1,
           driverFocusedTarget(object) { return }
        if let object = value as? [String: Any], object.count == 1,
           let key = object.keys.first, ["id", "label"].contains(key),
           let text = object[key] as? String, !text.isEmpty, text.utf16.count <= 16_384 { return }
        throw fault("INVALID_PARAMS", "Expected an element number, exact id or label, or a two-number point.")
    }

    static func targetPoint(_ value: Any, context: DriverPointerContext) throws -> CGPoint {
        let bounds = context.window.bounds
        if let pair = value as? [Any] {
            if let geometry = context.geometry, geometry.bounds != bounds {
                throw fault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=bounds")
            }
            guard let geometry = context.geometry, validRect(geometry.bounds),
                  geometry.bounds == bounds, geometry.pixelWidth.isFinite, geometry.pixelHeight.isFinite,
                  geometry.pixelWidth > 0, geometry.pixelHeight > 0 else {
                throw fault("CAPTURE_GEOMETRY_REQUIRED", "Read a screenshot of the current window before using a point.")
            }
            let sx = geometry.pixelWidth / bounds.width, sy = geometry.pixelHeight / bounds.height
            guard sx >= 0.25, sx <= 4, sy >= 0.25, sy <= 4,
                  abs(sx - sy) / max(sx, sy) <= 0.03 else {
                throw fault("CAPTURE_SCALE_MISMATCH", "Screenshot scale does not match the current window.")
            }
            let x = number(pair[0])!, y = number(pair[1])!
            guard x >= 0, y >= 0, x < geometry.pixelWidth, y < geometry.pixelHeight else {
                throw fault("POINT_OUTSIDE_WINDOW", "The point is outside the window screenshot.")
            }
            let point = CGPoint(x: bounds.minX + x / sx, y: bounds.minY + y / sy)
            try context.checkCoordinate?(point)
            return point
        }
        let frame = try context.resolveElement(value)
        guard validRect(frame) else { throw fault("ELEMENT_UNAVAILABLE", "The element has no usable frame.") }
        let point = CGPoint(x: frame.midX, y: frame.midY)
        guard contains(bounds, point) else {
            throw fault("POINT_OUTSIDE_WINDOW", "The element center is outside the bound window.")
        }
        return point
    }

    static func arguments(method: String, args: [Any]) throws
        -> (button: CGMouseButton, count: Int64, direction: String?, amount: Double, pages: Bool) {
        guard methods.contains(method) else { throw fault("METHOD_NOT_FOUND", "Unknown pointer method.") }
        var button: CGMouseButton = .left
        var count: Int64 = method == "doubleClick" ? 2 : 1
        var scrollDirection: String?
        var amount: Double = 0
        var isPages = false
        switch method {
        case "click":
            guard args.count == 1 || args.count == 2 else { throw fault("INVALID_PARAMS", "click takes a target and optional options.") }
            if args.count == 2 {
                guard let options = args[1] as? [String: Any], Set(options.keys).isSubset(of: ["mouseButton", "clickCount"]) else {
                    throw fault("INVALID_PARAMS", "Unknown click options.")
                }
                if let value = options["mouseButton"] {
                    guard let name = value as? String, ["left", "right", "middle"].contains(name) else {
                        throw fault("INVALID_PARAMS", "Unknown mouse button.")
                    }
                    button = name == "right" ? .right : name == "middle" ? .center : .left
                }
                if let value = options["clickCount"] {
                    guard let n = number(value), (1...3).contains(n), n.rounded() == n else {
                        throw fault("INVALID_PARAMS", "clickCount must be 1, 2 or 3.")
                    }
                    count = Int64(n)
                }
            }
        case "doubleClick", "rightClick":
            guard args.count == 1 else { throw fault("INVALID_PARAMS", "Expected one pointer target.") }
            if method == "rightClick" { button = .right }
        case "drag":
            guard args.count == 2 else { throw fault("INVALID_PARAMS", "drag takes two targets.") }
            try validateTarget(args[1])
        case "scroll":
            guard args.count == 3, let direction = args[1] as? String,
                  ["up", "down", "left", "right"].contains(direction) else {
                throw fault("INVALID_PARAMS", "scroll takes a target, direction and positive pages or pixels.")
            }
            scrollDirection = direction
            if let pixels = args[2] as? [String: Any], Set(pixels.keys) == ["pixels"],
               let n = number(pixels["pixels"]), n > 0, n <= 100_000 {
                // pixels means display points, matching App.scroll's distance unit.
                amount = n
            } else if let pages = number(args[2]), pages > 0, pages <= 100 {
                amount = pages; isPages = true
            } else { throw fault("INVALID_PARAMS", "Scroll distance must be positive and bounded.") }
        default: break
        }
        try validateTarget(args[0])
        return (button, count, scrollDirection, amount, isPages)
    }

    static func plan(method: String, args: [Any], context: DriverPointerContext) throws -> [DriverPointerStep] {
        let parsed = try arguments(method: method, args: args)
        guard context.window.pid > 0, context.window.windowID > 0, validRect(context.window.bounds) else {
            throw fault("IDENTITY_UNVERIFIED", "A verified window and process are required.")
        }
        let button = parsed.button, count = parsed.count
        var wheelX: Int32 = 0, wheelY: Int32 = 0
        if let direction = parsed.direction {
            let horizontal = direction == "left" || direction == "right"
            let extent = horizontal ? context.window.bounds.width : context.window.bounds.height
            let distance = parsed.amount * (parsed.pages ? extent : 1)
            guard distance.isFinite, distance <= 100_000 else {
                throw fault("INVALID_PARAMS", "Scroll distance exceeds 100000 points.")
            }
            let signed = Int32(max(1, distance.rounded())) * ((direction == "up" || direction == "left") ? 1 : -1)
            if horizontal { wheelX = signed } else { wheelY = signed }
        }
        try context.validateRead()
        let start = try targetPoint(args[0], context: context)
        if method == "scroll" {
            return [DriverPointerStep(event: DriverPointerEvent(type: .scrollWheel, point: start, clickCount: 0,
                                                                wheelX: wheelX, wheelY: wheelY))]
        }
        let down: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
        let up: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
        if method == "drag" {
            let end = try targetPoint(args[1], context: context)
            func release(_ point: CGPoint) -> DriverPointerEvent { DriverPointerEvent(type: .leftMouseUp, point: point) }
            var steps = [DriverPointerStep(event: DriverPointerEvent(type: .mouseMoved, point: start), delay: 0.05),
                         DriverPointerStep(event: DriverPointerEvent(type: .leftMouseDown, point: start),
                                           release: release(start), delay: 0.5)]
            for i in 1...dragSteps {
                let fraction = Double(i) / Double(dragSteps)
                let point = CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)
                steps.append(DriverPointerStep(event: DriverPointerEvent(type: .leftMouseDragged, point: point),
                                               release: release(point), delay: 0.02))
            }
            // A stationary destination move lets the target process accept dragover before up.
            steps.append(DriverPointerStep(event: DriverPointerEvent(type: .leftMouseDragged, point: end),
                                           release: release(end), delay: 0.02))
            steps.append(DriverPointerStep(event: release(end)))
            return steps
        }
        var steps: [DriverPointerStep] = []
        for n in 1...count {
            let release = DriverPointerEvent(type: up, point: start, button: button, clickCount: n)
            steps.append(DriverPointerStep(event: DriverPointerEvent(type: down, point: start, button: button, clickCount: n),
                                           release: release, delay: 0.01))
            steps.append(DriverPointerStep(event: release, delay: n == count ? 0 : 0.05))
        }
        return steps
    }

    static func perform(method: String, args: [Any], context: DriverPointerContext,
                        sink: DriverPointerSink) throws -> [String: Any] {
        let steps = try plan(method: method, args: args, context: context)
        context.actionPlan?(steps)
        let prepared = try sink.prepare(steps, window: context.window)
        var attempted = false, pending: Int? = nil
        do {
            // Leave time for release before the core's hard-deadline watchdog retires
            // the helper. A drag cannot start with less than its full planned spacing.
            let required = steps.reduce(0.1) { $0 + $1.delay }
            guard context.remaining().isFinite, context.remaining() > required else {
                throw fault("DEADLINE_EXCEEDED", "Insufficient time to post and release the pointer sequence.")
            }
            for (index, step) in steps.enumerated() {
                try context.checkBeforePost()
                if let checkCoordinate = context.checkCoordinate,
                   [CGEventType.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(step.event.type),
                   args.first is [Any] {
                    try checkCoordinate(step.event.point)
                    try context.checkBeforePost()
                }
                guard context.remaining() > step.delay + 0.05 else {
                    throw fault("DEADLINE_EXCEEDED", "Pointer deadline reached before the next event.")
                }
                // Mark before attempting a post, since a thrown post can have delivered input.
                try prepared.validate(index)
                try context.admitInput()
                if step.release != nil { pending = index }
                attempted = true
                let release: (() throws -> Void)? = step.release == nil ? nil : {
                    try context.checkReleaseIdentity()
                    try prepared.release(index)
                }
                if let dispatch = context.dispatch { try dispatch(release, { try prepared.post(index) }) }
                else { try prepared.post(index) }
                if [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(step.event.type) { pending = nil }
                if pending == nil { context.clearRelease?() }
                if step.delay > 0 { try context.wait(step.delay) }
            }
            try context.checkBeforePost()
        } catch {
            #if !SLEIGHT_POINTER_STANDALONE
            if !attempted, let fault = error as? DriverFault { throw fault }
            #endif
            var disposition = error as? DriverPointerFault ?? fault("POINTER_DISPATCH_FAILED", "Pointer dispatch stopped.")
            disposition.delivery = attempted ? "unknown" : "not-sent"
            if let index = pending {
                do {
                    // Deadline/person cancellation still permits release, but PID reuse never does.
                    try context.checkReleaseIdentity()
                    try prepared.release(index)
                    context.clearRelease?()
                    disposition.cleanup = "released"
                } catch {
                    disposition.cleanup = "unconfirmed"
                    disposition.unhealthy = true
                }
            }
            throw disposition
        }
        return ["window": context.window.json, "delivery": "sent-unverified", "retry": "read-first",
                "personTookOver": false, "settled": false, "postedEvents": steps.count]
    }
}

// Event construction has no desktop reads or posts. Only Prepared.post/release dispatch.
// Resolve the private location symbols at runtime and refuse if either is unavailable.
final class DriverPointerNativeSink: DriverPointerSink {
    typealias SetLocation = @convention(c) (CGEvent, CGPoint) -> Void
    typealias GetLocation = @convention(c) (CGEvent) -> CGPoint

    final class Prepared: DriverPointerPrepared {
        let pid: pid_t
        let source: CGEventSource
        let events: [CGEvent]
        let releases: [Int: CGEvent]
        var sourceFlags: () -> CGEventFlags
        init(pid: pid_t, source: CGEventSource, events: [CGEvent], releases: [Int: CGEvent]) {
            self.pid = pid; self.source = source; self.events = events; self.releases = releases
            self.sourceFlags = { CGEventSource.flagsState(source.sourceStateID) }
        }
        func validateEvent(_ event: CGEvent) throws {
            // This checks our private source, not the person's HID modifiers.
            // The person watch handles physical input and person-held modifiers.
            guard sourceFlags().isEmpty else {
                throw DriverPointer.fault("PERSON_HOLDS_MODIFIER", "The private pointer source has modifier flags set.")
            }
            // Pointer options currently admit no modifiers. Check every bit,
            // including non-modifier bits, rather than silently clearing a chord.
            guard event.flags.isEmpty else {
                throw DriverPointer.fault("EVENT_BUILD_FAILED", "Unexpected flags on a pointer event.")
            }
        }
        func validate(_ index: Int) throws { try validateEvent(events[index]) }
        func send(_ event: CGEvent, cleanup: Bool = false) throws {
            if !cleanup { try validateEvent(event) }
            event.timestamp = DispatchTime.now().uptimeNanoseconds
            event.postToPid(pid)
        }
        func post(_ index: Int) throws { try send(events[index]) }
        func release(_ index: Int) throws {
            guard let event = releases[index] else { throw DriverPointer.fault("EVENT_BUILD_FAILED", "Missing button release.") }
            // The caller has a pending press and rechecks its process identity.
            // Flag changes must never prevent ending that press.
            try send(event, cleanup: true)
        }
    }

    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared {
        guard let source = CGEventSource(stateID: .privateState),
              let setSymbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation"),
              let getSymbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventGetWindowLocation") else {
            throw DriverPointer.fault("POINTER_UNAVAILABLE", "Private event source or window-local event API is unavailable.")
        }
        let setLocation = unsafeBitCast(setSymbol, to: SetLocation.self)
        let getLocation = unsafeBitCast(getSymbol, to: GetLocation.self)
        // Private-state hygiene only. This cannot observe a person's held key.
        guard CGEventSource.flagsState(source.sourceStateID).isEmpty else {
            throw DriverPointer.fault("PERSON_HOLDS_MODIFIER", "The private pointer source has modifier flags set.")
        }
        func make(_ item: DriverPointerEvent) throws -> CGEvent {
            let local = CGPoint(x: item.point.x - window.bounds.minX, y: item.point.y - window.bounds.minY)
            let event: CGEvent
            if item.type == .scrollWheel {
                guard let wheel = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                                          wheel1: item.wheelY, wheel2: item.wheelX, wheel3: 0) else {
                    throw DriverPointer.fault("EVENT_BUILD_FAILED", "Cannot build a scroll event.")
                }
                event = wheel
            } else {
                guard let type = NSEvent.EventType(rawValue: UInt(item.type.rawValue)),
                      let native = NSEvent.mouseEvent(with: type,
                          location: NSPoint(x: local.x, y: window.bounds.height - local.y), modifierFlags: [],
                          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(window.windowID),
                          context: nil, eventNumber: 1, clickCount: Int(item.clickCount),
                          pressure: [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(item.type) ? 0 : 1),
                      let mouse = native.cgEvent?.copy() else {
                    throw DriverPointer.fault("EVENT_BUILD_FAILED", "Cannot build a window-local mouse event.")
                }
                event = mouse
                event.type = item.type
                event.setSource(source)
            }
            event.flags = []
            event.location = item.point
            setLocation(event, local)
            event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(window.pid))
            let wheel = item.type == .scrollWheel
            if !wheel {
                event.setIntegerValueField(.mouseEventSubtype, value: 3)
                event.setIntegerValueField(.mouseEventClickState, value: item.clickCount)
                event.setIntegerValueField(.mouseEventButtonNumber, value: Int64(item.button.rawValue))
                for raw: UInt32 in [91, 92] {
                    guard let field = CGEventField(rawValue: raw) else {
                        throw DriverPointer.fault("EVENT_BUILD_FAILED", "Window field is unavailable.")
                    }
                    event.setIntegerValueField(field, value: Int64(window.windowID))
                }
            }
            // Quartz ignores mouse-only fields 7, 91 and 92 on wheel events.
            // A wheel retains the private window-local point and absolute location,
            // and is dispatched only to the bound PID. Covered-wheel routing needs
            // its own live qualification; never manufacture a successful readback.
            let roundTrip = getLocation(event)
            guard event.type == item.type, event.flags.isEmpty,
                  roundTrip.x.isFinite, roundTrip.y.isFinite,
                  abs(roundTrip.x - local.x) <= 0.5, abs(roundTrip.y - local.y) <= 0.5,
                  event.getIntegerValueField(.eventSourceStateID) == Int64(source.sourceStateID.rawValue),
                  event.getIntegerValueField(.eventTargetUnixProcessID) == Int64(window.pid),
                  wheel || (event.getIntegerValueField(CGEventField(rawValue: 91)!) == Int64(window.windowID)
                      && event.getIntegerValueField(CGEventField(rawValue: 92)!) == Int64(window.windowID)) else {
                throw DriverPointer.fault("EVENT_BUILD_FAILED", "Window-local event validation failed.")
            }
            return event
        }
        var events: [CGEvent] = [], releases: [Int: CGEvent] = [:]
        for (index, step) in steps.enumerated() {
            events.append(try make(step.event))
            if let release = step.release { releases[index] = try make(release) }
        }
        return Prepared(pid: window.pid, source: source, events: events, releases: releases)
    }
}

#if !SLEIGHT_POINTER_STANDALONE
// The entry point deliberately requires RT6's person guard and capture geometry
// from the capture lane. Tool params cannot provide their own trusted geometry.
// Integration must preserve DriverPointerFault.json in the protocol error reply.
extension DriverPointer {
    static func fromCore<T>(_ work: () throws -> T) throws -> T {
        do { return try work() }
        catch let error as DriverFault {
            throw DriverPointerFault(code: error.code, message: error.message,
                                     personTookOver: driverBoolean(error.disposition["personTookOver"]) ?? (error.code == "PERSON_TOOK_OVER"), unhealthy: error.unhealthy,
                                     reason: error.disposition["reason"] as? String,
                                     targetRole: error.disposition["targetRole"] as? String)
        }
    }

    static func context(request: DriverRequest, core: DriverCore, geometry: DriverPointerGeometry?,
                        checkPerson: @escaping () throws -> Void,
                        hitTest: ((CGPoint) throws -> DriverNode?)? = nil,
                        pixelCheck: ((CGPoint) throws -> Bool)? = nil) throws -> DriverPointerContext {
        try fromCore { try request.keys(["windowId", "processStart", "readId", "args"], optional:
            Set(["personToken"]).union(["click", "doubleClick", "rightClick"].contains(request.method) ? ["coordinateReadId"] : [])) }
        guard let readID = driverInteger(request.params["readId"]), readID > 0,
              let args = request.params["args"] as? [Any], let id = request.params["windowId"] as? String else {
            throw fault("INVALID_PARAMS", "Input requires a bound read and positional arguments.")
        }
        let parsed = try arguments(method: request.method, args: args)
        let activation = ["click", "doubleClick"].contains(request.method) && parsed.button == .left
        let bound = try fromCore { try core.boundWindow(request.params, request: request) }
        let metadata = bound.window
        guard let pid = driverInteger(metadata["pid"]), pid > 0, pid <= Int32.max,
              let windowNumber = UInt32(id), windowNumber > 0,
              let bounds = metadata["bounds"] as? DriverObject,
              let x = number(bounds["x"]), let y = number(bounds["y"]),
              let width = number(bounds["width"]), let height = number(bounds["height"]) else {
            throw fault("IDENTITY_UNVERIFIED", "Window metadata is incomplete.")
        }
        let rect = CGRect(x: x, y: y, width: width, height: height)
        let window = DriverPointerWindow(pid: pid_t(pid), windowID: windowNumber, bounds: rect, json: metadata)
        request.actionEvent?.prepare(window: metadata)
        func identity(requireBounds: Bool) throws {
            let current = try fromCore { try core.inventory.bound(request.params) }
            guard driverInteger(current["pid"]) == pid else { throw fault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=pid") }
            if requireBounds {
                guard let currentBounds = current["bounds"] as? DriverObject,
                      number(currentBounds["x"]) == x, number(currentBounds["y"]) == y,
                      number(currentBounds["width"]) == width, number(currentBounds["height"]) == height else {
                    throw fault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=bounds")
                }
            }
        }
        func coordinateHit(_ point: CGPoint) throws -> DriverNode? {
            if let hitTest = hitTest { return try checkedCoordinateHit(.success, try hitTest(point)) }
            else if core.inventory.fixture != nil { throw fault("ACTION_UNSUPPORTED", "Coordinate fixtures require an injected hit test.") }
            else {
                let app = AXUIElementCreateApplication(pid_t(pid))
                try request.check()
                AXUIElementSetMessagingTimeout(app, Float(min(0.1, request.remaining)))
                var element: AXUIElement?
                let status = AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &element)
                let checked = try checkedCoordinateHit(status, element.map(DriverNode.init))
                if let element = checked?.ax {
                    var actual: pid_t = 0
                    guard AXUIElementGetPid(element, &actual) == .success, actual == pid_t(pid) else { throw fault("STALE_ELEMENT", "The coordinate target changed its process.") }
                    return DriverNode(element)
                } else { return nil }
            }
        }
        var focusedFrame: CGRect?
        return DriverPointerContext(window: window, geometry: geometry,
            validateRead: {
                guard let map = core.maps[id], map.id == readID,
                      map.processStart == request.params["processStart"] as? String,
                      map.root.same(bound.root) else { throw fault("STALE_READ", "The retained read expired; read again.") }
                if request.method == "drag" && driverBoolean(metadata["onScreen"]) == false {
                    throw fault("NO_WINDOWS_AVAILABLE", "NO_WINDOWS_AVAILABLE")
                }
            }, resolveElement: { target in
                var params = request.params; params["target"] = target
                let element = try fromCore { try core.resolveElement(params, request: request) }
                let node = element.node
                if !element.secure {
                    try fromCore {
                        let checkLabels = activation || element.role == kAXMenuItemRole
                        let names = checkLabels ? DriverKeyboard.clipboardMenuAttributes : Array(DriverKeyboard.clipboardMenuAttributes.prefix(4))
                        try DriverKeyboard.refuseClipboardMenu(node.attributes(names, request: request),
                            layout: node.fake == nil ? nil : [:], checkLabels: checkLabels)
                    }
                }
                let frame = try fromCore { try node.frame(request) }
                if let selector = target as? DriverObject, driverBoolean(selector["focused"]) == true { focusedFrame = frame }
                request.actionEvent?.prepare(window: metadata, rect: frame)
                return frame
            }, checkBeforePost: {
                try fromCore { try request.check() }
                try identity(requireBounds: true)
                try fromCore(checkPerson)
                if let selector = args.first as? DriverObject, driverBoolean(selector["focused"]) == true {
                    var params = request.params; params["target"] = selector
                    let element = try fromCore { try core.resolveElement(params, request: request) }
                    guard let frame = focusedFrame, try fromCore({ try element.node.frame(request) }) == frame else {
                        throw fault("STALE_ELEMENT", "The focused target moved before input.")
                    }
                }
            }, checkReleaseIdentity: { try identity(requireBounds: false) }, remaining: { request.remaining },
            wait: { seconds in
                guard request.remaining > seconds + 0.05 else { throw fault("DEADLINE_EXCEEDED", "Pointer spacing exceeds the deadline.") }
                let until = ProcessInfo.processInfo.systemUptime + seconds
                while ProcessInfo.processInfo.systemUptime < until {
                    Thread.sleep(forTimeInterval: min(0.02, max(0, until - ProcessInfo.processInfo.systemUptime)))
                    try fromCore { try request.check() }
                    try fromCore(checkPerson)
                }
            }, admitInput: { try request.admitInput() }, actionPlan: { steps in
                request.actionEvent?.plan(steps.map { $0.event.point })
            }, checkCoordinate: { point in
                let node = try coordinateHit(point)
                if let node = node {
                    try fromCore {
                        // A hit can be a child of a menu item. Establish menu
                        // ancestry from structure before reading any labels.
                        var current = node, lineage: [DriverNode] = []
                        var menuLineage: [DriverNode]? = nil, button = false
                        for depth in 0..<66 {
                            guard !lineage.contains(where: { $0.same(current) }) else { throw DriverFault("STALE_ELEMENT") }
                            lineage.append(current)
                            let structural = try current.attributes([kAXRoleAttribute, kAXSubroleAttribute,
                                kAXMenuItemCmdCharAttribute, kAXMenuItemCmdVirtualKeyAttribute, kAXMenuItemCmdModifiersAttribute], request: request)
                            guard let role = structural[kAXRoleAttribute] as? String, !role.isEmpty else { throw incompleteAncestry() }
                            if role == "AXSecureTextField" || structural[kAXSubroleAttribute] as? String == "AXSecureTextField" {
                                guard menuLineage == nil else { throw incompleteAncestry() }
                                if ["click", "doubleClick", "rightClick"].contains(request.method) { throw DriverFault("SECURE_FIELD") }
                                return
                            }
                            try DriverKeyboard.refuseClipboardMenu(structural, layout: current.fake == nil ? nil : [:], checkLabels: false)
                            if depth == 0 { button = role == "AXButton" }
                            // Prove the chain to a window/app, while keeping label
                            // reads inside the first menu ancestor as before.
                            if [kAXMenuItemRole, kAXMenuRole].contains(role), menuLineage == nil { menuLineage = lineage }
                            if [kAXWindowRole, kAXApplicationRole].contains(role) { break }
                            let attrs = try current.attributes([kAXParentAttribute], request: request)
                            guard let raw = attrs[kAXParentAttribute] else { throw incompleteAncestry() }
                            if let fake = current.fake, let parent = fake[kAXParentAttribute] as? DriverObject {
                                current = DriverNode(fake: parent, path: current.path + "/parent")
                            } else {
                                guard CFGetTypeID(raw as CFTypeRef) == AXUIElementGetTypeID() else { throw incompleteAncestry() }
                                current = DriverNode(raw as! AXUIElement)
                            }
                            guard current.pid() == pid_t(pid) else { throw DriverFault("STALE_ELEMENT") }
                            if depth == 65 { throw incompleteAncestry() }
                        }
                        guard menuLineage != nil || activation && button else { return }
                        for target in menuLineage ?? [node] {
                            let labels = try target.attributes([kAXTitleAttribute, kAXDescriptionAttribute], request: request)
                            try DriverKeyboard.refuseClipboardMenu(labels, layout: [:])
                        }
                    }
                }
                if ["click", "doubleClick", "rightClick"].contains(request.method) {
                    try fromCore {
                        guard let deliveredID = driverInteger(request.params["coordinateReadId"]),
                              let map = core.coordinateMaps[deliveredID], !map.truncated,
                              map.processStart == request.params["processStart"] as? String,
                              map.root.same(bound.root) else { throw DriverFault("TARGET_CHANGED") }
                        let needsPixels = try coordinateNeedsPixels(map: map, hit: node, point: point,
                            pid: pid, request: request)
                        if needsPixels {
                            guard try pixelCheck?(point) == true else { throw DriverFault("TARGET_CHANGED") }
                            // Capture may wait for a compositor frame. Recheck AX
                            // after that wait before admitting the mouse-down.
                            _ = try coordinateNeedsPixels(map: map, hit: coordinateHit(point), point: point,
                                pid: pid, request: request)
                        }
                    }
                }
            }, dispatch: { release, send in
                if let registry = request.inputRelease { try registry.post("pointer", release: release, send) }
                else { try send() }
            }, clearRelease: { request.inputRelease?.clear("pointer") })
    }

    static func coordinateNeedsPixels(map: DriverReadMap, hit: DriverNode?, point: CGPoint,
                                      pid: Int, request: DriverRequest) throws -> Bool {
        func changed() -> DriverFault {
            let role = (try? hit?.attributes([kAXRoleAttribute], request: request))?[kAXRoleAttribute] as? String ?? ""
            let names = ["AXButton": "button", "AXGroup": "container", "AXSheet": "sheet", "AXDialog": "dialog"]
            var error = DriverFault("TARGET_CHANGED")
            error.disposition["targetRole"] = names[role] ?? "other"
            return error
        }
        let covering = map.elements.values.filter { $0.frame.map { contains($0, point) } == true }
        let deepest = covering.map(\.depth).max()
        let candidates = covering.filter { $0.depth == deepest }
        guard candidates.count <= 1 else { throw changed() }
        guard let expected = candidates.first else {
            guard hit == nil else { throw changed() }
            return true
        }
        guard !expected.secure else { throw DriverFault("SECURE_FIELD") }
        guard let hit = hit, expected.node.same(hit), hit.pid() == pid_t(pid),
              try hit.belongs(to: map.root, pid: pid, request: request),
              try hit.frame(request) == expected.frame else { throw changed() }
        let structural = try hit.attributes([kAXRoleAttribute, kAXSubroleAttribute], request: request)
        guard structural[kAXRoleAttribute] as? String == expected.role,
              structural[kAXSubroleAttribute] as? String != "AXSecureTextField" else { throw changed() }
        let attrs = try hit.attributes(driverCoordinateAttributes, request: request)
        guard !expected.coordinateIdentity.values.contains("unsupported"),
              driverCoordinateIdentity(attrs) == expected.coordinateIdentity else { throw changed() }
        return ["AXWindow", "AXGroup", "AXCanvas", "AXLayoutArea", "AXScrollArea", "AXWebArea", "AXImage"].contains(expected.role)
    }

    static func checkedCoordinateHit(_ status: AXError, _ node: DriverNode?) throws -> DriverNode? {
        guard status == .success else { throw fault("AX_UNAVAILABLE", "The coordinate target could not be checked.") }
        guard node != nil else { throw fault("AX_UNAVAILABLE", "The coordinate target could not be checked.") }
        return node
    }
}
#endif

// Available to the standalone planner without importing the tree adapter.
private func driverFocusedTarget(_ target: [String: Any]) -> Bool {
    guard target.count == 1, let value = target["focused"] as? NSNumber else { return false }
    return CFGetTypeID(value) == CFBooleanGetTypeID() && value.boolValue
}
