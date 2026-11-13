import Foundation
import CoreFoundation

typealias DriverObject = [String: Any]

struct DriverFault: Error {
    let code: String
    let message: String
    let unhealthy: Bool
    var disposition: DriverObject = [:]
    init(_ code: String, _ message: String? = nil, unhealthy: Bool = false) {
        self.code = driverErrorCodes[code] == nil ? "DRIVER_PROTOCOL" : code
        self.message = message ?? self.code
        self.unhealthy = unhealthy || driverErrorCodes[self.code]!.unhealthy
    }
    var json: DriverObject {
        var value: DriverObject = ["code": code, "message": message, "next": driverErrorCodes[code]!.next, "unhealthy": unhealthy]
        value.merge(disposition) { _, new in new }; return value
    }
}

func driverInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
          abs(number.doubleValue) <= 9_007_199_254_740_991 else { return nil }
    return number.intValue
}

func driverBoolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
}
