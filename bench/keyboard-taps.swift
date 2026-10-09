// Prints the event taps that can hold up the keyboard (enabled filter taps on key events) as JSON:
// [{ "pid", "app", "avgUsecLatency", "maxUsecLatency" }]. A benchmark run left Device Hub with one
// whose last key took 40 s, and the owner's keyboard stopped working (2026-10-09).
import AppKit
import CoreGraphics
import Foundation

var count: UInt32 = 0
CGGetEventTapList(0, nil, &count)
var taps = [CGEventTapInformation](repeating: CGEventTapInformation(), count: Int(count))
CGGetEventTapList(count, &taps, &count)
let keys: UInt64 = (1 << 10) | (1 << 11) | (1 << 12) // key down, key up, flags changed
let out = taps.filter { $0.enabled && $0.options == .defaultTap && ($0.eventsOfInterest & keys) != 0 }.map { t in
  ["pid": Int(t.tappingProcess),
   "app": NSRunningApplication(processIdentifier: t.tappingProcess)?.localizedName ?? "",
   "avgUsecLatency": Double(t.avgUsecLatency), "maxUsecLatency": Double(t.maxUsecLatency)] as [String: Any]
}
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
