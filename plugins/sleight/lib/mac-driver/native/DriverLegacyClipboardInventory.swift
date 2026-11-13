import Foundation
import Darwin

// Metadata only, shared across native and browser legacy filename families.
// Never opens payloads, follows entries, creates storage, deletes or recovers.
struct DriverLegacyClipboardInventory {
    struct Metadata { let mode: mode_t; let uid: uid_t }
    struct Access {
        var metadata: (String) throws -> Metadata?
        var names: (String) throws -> [String]
        static var system: Self {
            Self(metadata: { path in
                var info = Darwin.stat()
                if lstat(path, &info) != 0 {
                    if errno == ENOENT { return nil }
                    throw DriverFault("ACTION_UNSUPPORTED")
                }
                return Metadata(mode: info.st_mode, uid: info.st_uid)
            }, names: { try FileManager.default.contentsOfDirectory(atPath: $0) })
        }
    }
    let directory: URL
    var access: Access = .system
    static var system: Self {
        let home = NSHomeDirectoryForUser(NSUserName()) ?? NSHomeDirectory()
        return Self(directory: URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/sleight/clipboard"))
    }
    func scan() throws -> Int {
        guard try access.metadata(directory.path) != nil else { return 0 }
        // Refuse symlinked ancestors as well as a symlinked catalog. An unsafe
        // catalog is retained exactly as found, with no attempted repair.
        func check(_ path: URL) throws {
            let parent = path.deletingLastPathComponent()
            if parent.path != path.path { try check(parent) }
            guard let entry = try access.metadata(path.path), entry.mode & S_IFMT == S_IFDIR else { throw DriverFault("ACTION_UNSUPPORTED") }
            if path.path == directory.path {
                guard entry.uid == getuid(), entry.mode & 0o077 == 0 else { throw DriverFault("ACTION_UNSUPPORTED") }
            } else if entry.mode & 0o022 != 0 {
                guard entry.uid == 0, entry.mode & 0o1000 != 0 || path.path == "/" else { throw DriverFault("ACTION_UNSUPPORTED") }
            }
        }
        try check(directory)
        return try access.names(directory.path).filter {
            $0.hasPrefix("runtime-snapshot-") || $0.hasPrefix("snapshot-")
        }.count
    }
}
