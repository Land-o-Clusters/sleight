import Foundation
import ApplicationServices

extension DriverRuntime {
    // Parent-only release transport for the stepped child. No event in this
    // closed schema can press a key/button, move the pointer or grant authority.
    func releasePostedInput(_ value: Any?) throws {
        guard let params = value as? DriverObject, Set(params.keys) == ["windowId", "processStart", "pid", "holds"],
              let pid = driverInteger(params["pid"]), pid > 0, pid <= Int(Int32.max),
              let holds = params["holds"] as? [DriverObject], holds.count <= 132 else { throw DriverFault("INVALID_PARAMS") }
        let binding: DriverObject = ["windowId": params["windowId"] as Any, "processStart": params["processStart"] as Any]
        let identity = {
            let current = try self.core.inventory.bound(binding)
            guard driverInteger(current["pid"]) == pid else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=release-pid") }
        }
        let window = try core.inventory.bound(binding)
        guard driverInteger(window["pid"]) == pid else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=release-pid") }
        var events: [CGEvent] = []
        var failure: Error?
        let modifierMasks: [Int: UInt64] = [57: 1 << 16, 54: 1 << 20, 55: 1 << 20, 56: 1 << 17, 60: 1 << 17,
            58: 1 << 19, 61: 1 << 19, 59: 1 << 18, 62: 1 << 18, 63: 1 << 23]
        for (index, hold) in holds.enumerated() {
          do {
            let event: CGEvent?
            let remainingFlags = holds.dropFirst(index + 1).reduce(UInt64(0)) { flags, pending in
                flags | (driverInteger(pending["key"]).flatMap { modifierMasks[$0] } ?? 0)
            }
            if Set(hold.keys) == ["key"], let key = driverInteger(hold["key"]), (0...127).contains(key) {
                event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(key), keyDown: false)
                event?.type = .keyUp
                if modifierMasks[key] != nil {
                    guard let changed = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(key), keyDown: false) else { throw DriverFault("DRIVER_INTERNAL") }
                    changed.type = .flagsChanged
                    changed.flags = CGEventFlags(rawValue: remainingFlags)
                    events.append(changed)
                }
            } else if Set(hold.keys) == ["button", "x", "y"], let button = driverInteger(hold["button"]), (0...31).contains(button),
                      let x = hold["x"] as? Double, let y = hold["y"] as? Double, x.isFinite, y.isFinite,
                      abs(x) <= 100000, abs(y) <= 100000, let mouse = CGMouseButton(rawValue: UInt32(button)) {
                guard let id = UInt32(params["windowId"] as? String ?? ""), let frame = window["bounds"] as? DriverObject,
                      let left = frame["x"] as? Double, let top = frame["y"] as? Double,
                      let width = frame["width"] as? Double, let height = frame["height"] as? Double else { throw DriverFault("IDENTITY_UNVERIFIED") }
                let target = DriverPointerWindow(pid: Int32(pid), windowID: id,
                    bounds: CGRect(x: left, y: top, width: width, height: height), json: window)
                let spec = DriverPointerEvent(type: button == 0 ? .leftMouseUp : button == 1 ? .rightMouseUp : .otherMouseUp,
                    point: CGPoint(x: x, y: y), button: mouse)
                guard let prepared = try DriverPointerNativeSink().prepare([DriverPointerStep(event: spec)], window: target) as? DriverPointerNativeSink.Prepared,
                      let release = prepared.events.first else { throw DriverFault("DRIVER_INTERNAL") }
                event = release
            } else { throw DriverFault("INVALID_PARAMS") }
            guard let event = event else { throw DriverFault("DRIVER_INTERNAL") }
            event.flags = CGEventFlags(rawValue: remainingFlags); events.append(event)
          } catch { failure = failure ?? error }
        }
        // Recheck before every release, including a key following a mouse-up.
        for event in events {
            do { try identity(); try postReleaseEvent(event, pid_t(pid)) }
            catch { failure = failure ?? error }
        }
        if let failure = failure { throw failure }
    }
}
