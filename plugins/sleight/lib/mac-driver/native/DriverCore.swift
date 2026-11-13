import AppKit
import ApplicationServices

final class DriverCore {
    let inventory: DriverInventory
    let session: DriverSession
    let person: DriverPerson
    let geometry = DriverGeometryBank()
    let popups = DriverPopupBank()
    var requestedMenuTitles: [String] = []
    var maps: [String: DriverReadMap] = [:]
    // Bounded history for the image/read actually delivered by the parent.
    // Before-action walks replace maps, never these immutable frame snapshots.
    var coordinateMaps: [Int: DriverReadMap] = [:]
    var nextRead = 0
    var observeRead: ((DriverBoundWindow) -> DriverReadObservation?)?
    init(fixture: DriverObject? = nil, personProviders: DriverPersonProviders? = nil) {
        inventory = DriverInventory(fixture: fixture)
        person = DriverPerson(providers: personProviders ?? (fixture == nil ? .system : .fixture))
        if let fixture = fixture {
            session = DriverSession(providers: DriverSessionProviders(
                dictionary: { fixture["session"] as? DriverObject ?? ["kCGSSessionOnConsoleKey": true,
                    "kCGSessionLoginDoneKey": true, "CGSSessionScreenIsLocked": false] },
                hidIdle: { 10 }, acquireSleep: { 1 }, releaseSleep: { _ in 0 }))
        } else { session = DriverSession() }
    }
    func health() -> DriverObject {
        var result: DriverObject = ["protocol": driverProtocol, "apiVersion": driverAPIVersion, "build": driverBuild, "platform": "darwin", "healthy": true,
         "accessibility": inventory.fixture != nil ? true : AXIsProcessTrusted(),
         "screenRecording": inventory.fixture != nil ? false : CGPreflightScreenCaptureAccess()]
        result.merge(session.sample().health) { _, new in new }; return result
    }
}
