import AppKit
import ApplicationServices

// Construct and read back only. No NSApplication, windows, AX queries or posts.
// NSEvent.h defines the type and both subtypes. The constructor's last fields
// stay zero because the public activation contract specifies no payload.
@main
struct FocusBeliefReadback {
    static func main() throws {
        var rows = [[String: Any]]()
        for (windowNumber, subtype): (Int, NSEvent.EventSubtype) in [
            (0, .applicationActivated), (0, .applicationDeactivated),
            (7, .applicationActivated), (7, .applicationDeactivated)
        ] {
            var row: [String: Any] = ["expectedType": NSEvent.EventType.appKitDefined.rawValue,
                                      "expectedSubtype": subtype.rawValue, "windowNumber": windowNumber]
            if let event = NSEvent.otherEvent(with: .appKitDefined, location: .zero,
                modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: windowNumber, context: nil,
                subtype: subtype.rawValue, data1: 0, data2: 0) {
                row["constructed"] = true
                row["type"] = event.type.rawValue
                row["subtype"] = event.subtype.rawValue
                if let cg = event.cgEvent {
                    row["cgEvent"] = true
                    row["cgType"] = cg.type.rawValue
                    if let back = NSEvent(cgEvent: cg) {
                        row["roundTrip"] = true
                        row["roundTripType"] = back.type.rawValue
                        row["roundTripSubtype"] = back.subtype.rawValue
                    } else { row["roundTrip"] = false }
                } else { row["cgEvent"] = false }
            } else { row["constructed"] = false }
            rows.append(row)
        }
        let result: [String: Any] = ["os": ProcessInfo.processInfo.operatingSystemVersionString,
                                   "events": rows]
        print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
    }
}
