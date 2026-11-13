import AppKit
import Darwin
import SQLite3
import UniformTypeIdentifiers

struct DriverSemanticSnapshot {
    let count: Int
    let items: [[String: Data]]
    let typeOrder: [[String]]
    init(count: Int, items: [[String: Data]], typeOrder: [[String]]? = nil) {
        self.count = count; self.items = items
        self.typeOrder = typeOrder ?? items.map { $0.keys.sorted() }
    }
}
struct DriverSemanticClipboardFault: Error { let ownedCount: Int? }
protocol DriverSemanticPasteboard: AnyObject {
    var generation: Int { get }
    func acquire() throws
    func release()
    func snapshot() throws -> DriverSemanticSnapshot
    func replace(_ items: [[String: Data]], expected: Int) throws -> Int
    func restore(_ snapshot: DriverSemanticSnapshot, expected: Int) throws -> Int
}
extension DriverSemanticPasteboard {
    func restore(_ snapshot: DriverSemanticSnapshot, expected: Int) throws -> Int { try replace(snapshot.items, expected: expected) }
}

// Only this adapter reaches AppKit. Tests inject the lower byte-provider boundary,
// so snapshot, preparation, generation fencing and readback run unchanged.
struct DriverSemanticBoardAccess {
    var generation: () -> Int
    var types: () throws -> [[String]]
    var data: (Int, String) throws -> Data
    var prepare: (DriverSemanticSnapshot) throws -> (() -> Bool)
    var clear: (_ localOnly: Bool) -> Int
    static func system(_ board: @escaping () -> NSPasteboard) -> Self {
        Self(generation: { board().changeCount }, types: {
            let pb = board()
            if pb.pasteboardItems == nil && !(pb.types ?? []).isEmpty { throw DriverFault("ACTION_UNSUPPORTED") }
            return (pb.pasteboardItems ?? []).map { $0.types.map(\.rawValue) }
        }, data: { index, type in
            guard let items = board().pasteboardItems, index < items.count,
                  let bytes = items[index].data(forType: NSPasteboard.PasteboardType(rawValue: type)) else { throw DriverFault("ACTION_UNSUPPORTED") }
            return bytes
        }, prepare: { snapshot in
            let objects = try snapshot.items.enumerated().map { index, reps -> NSPasteboardItem in
                let item = NSPasteboardItem()
                for type in snapshot.typeOrder[index] {
                    guard item.setData(reps[type]!, forType: NSPasteboard.PasteboardType(rawValue: type)) else { throw DriverFault("ACTION_UNSUPPORTED") }
                }
                return item
            }
            return { objects.isEmpty || board().writeObjects(objects) }
        }, clear: { local in
            local ? board().prepareForNewContents(with: .currentHostOnly) : board().clearContents()
        })
    }
}

final class DriverSemanticPasteboardNative: DriverSemanticPasteboard {
    static let byteLimit = 32 * 1024 * 1024
    static let itemLimit = 4096
    // No image/PDF/RTFD/file-promise providers are materialized for a snapshot.
    // Their declaration gives no byte bound, so one such representation refuses.
    static let largeNonTextRepresentationLimit = 0
    private var database: OpaquePointer?
    private let access: DriverSemanticBoardAccess
    let reservationURL: URL
    init(board: @escaping () -> NSPasteboard = { fatalError("Legacy test requires an injected board") }, reservationURL: URL? = nil,
         access: DriverSemanticBoardAccess? = nil) {
        // Match Node homedir(), including its HOME override, for one lock domain.
        let home = ProcessInfo.processInfo.environment["HOME"].flatMap { $0.isEmpty ? nil : $0 }
            ?? NSHomeDirectoryForUser(NSUserName()) ?? NSHomeDirectory()
        self.reservationURL = reservationURL ?? URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/sleight/clipboard.sqlite")
        self.access = access ?? .system(board)
    }
    deinit { release() }
    var generation: Int { access.generation() }
    func acquire() throws {
        guard database == nil else { throw DriverFault("ACTION_UNSUPPORTED") }
        let directory = reservationURL.deletingLastPathComponent()
        try DriverSemanticSnapshotStore.checkDirectory(directory, create: true, privateMode: false)
        let fd = open(reservationURL.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw DriverFault("ACTION_UNSUPPORTED") }
        defer { close(fd) }
        var info = Darwin.stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_mode & 0o022 == 0 else { throw DriverFault("ACTION_UNSUPPORTED") }
        var db: OpaquePointer?
        guard sqlite3_open_v2(reservationURL.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let db = db else {
            if let db = db { sqlite3_close(db) }; throw DriverFault("ACTION_UNSUPPORTED")
        }
        var current = Darwin.stat()
        guard lstat(reservationURL.path, &current) == 0, current.st_ino == info.st_ino, current.st_dev == info.st_dev else {
            sqlite3_close(db); throw DriverFault("ACTION_UNSUPPORTED")
        }
        let status = sqlite3_exec(db, "PRAGMA busy_timeout=0; BEGIN IMMEDIATE", nil, nil, nil)
        guard status == SQLITE_OK else {
            sqlite3_close(db)
            // The wire table has no busy code yet. Preserve the distinction for
            // integration without inventing an unrecognized protocol code.
            throw DriverSemanticReservationBusy()
        }
        database = db
    }
    func release() {
        if let db = database { sqlite3_exec(db, "ROLLBACK", nil, nil, nil); sqlite3_close(db); database = nil }
    }
    static func validate(_ items: [[String: Data]]) throws {
        guard items.count <= itemLimit else { throw DriverFault("ACTION_UNSUPPORTED") }
        var size = 0, representations = 0
        for item in items {
            guard !item.isEmpty, item.count <= 256 else { throw DriverFault("ACTION_UNSUPPORTED") }
            for (type, bytes) in item {
                let lower = type.lowercased()
                guard !type.isEmpty, type.utf8.count <= 1024,
                      !type.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                      !lower.contains("promise"), !lower.contains("filecontents"),
                      bytes.count <= byteLimit - size else { throw DriverFault("ACTION_UNSUPPORTED") }
                size += bytes.count; representations += 1
                guard representations <= 8192 else { throw DriverFault("ACTION_UNSUPPORTED") }
            }
        }
    }
    private func read() throws -> DriverSemanticSnapshot {
        let count = generation, types = try access.types()
        guard types.count <= Self.itemLimit else { throw DriverFault("ACTION_UNSUPPORTED") }
        var declared = 0, large = 0
        // Preflight the entire declaration list before requesting even text data:
        // a later image provider must not follow earlier allocations.
        for names in types {
            guard !names.isEmpty, names.count <= 256, Set(names).count == names.count else { throw DriverFault("ACTION_UNSUPPORTED") }
            for name in names {
                guard !name.isEmpty, name.utf8.count <= 1024,
                      !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw DriverFault("ACTION_UNSUPPORTED") }
                let lower = name.lowercased(), type = UTType(name)
                if lower.contains("promise") || lower.contains("filecontents") ||
                    ["nstiffpboardtype", "nspdfpboardtype", "nsrtfdpboardtype", "com.apple.flat-rtfd"].contains(lower) ||
                    type?.conforms(to: .image) == true || type?.conforms(to: .pdf) == true || type?.conforms(to: .rtfd) == true { large += 1 }
                declared += 1
                guard declared <= 8192, large <= Self.largeNonTextRepresentationLimit else { throw DriverFault("ACTION_UNSUPPORTED") }
            }
        }
        var items = [[String: Data]](), size = 0, total = 0
        for (index, names) in types.enumerated() {
            guard !names.isEmpty, names.count <= 256, Set(names).count == names.count else { throw DriverFault("ACTION_UNSUPPORTED") }
            var representations = [String: Data]()
            for type in names {
                let lower = type.lowercased()
                guard !lower.contains("promise"), !lower.contains("filecontents"), total < 8192,
                      type.utf8.count <= 1024 else { throw DriverFault("ACTION_UNSUPPORTED") }
                // NSPasteboard exposes no byte length before data(forType:).
                // Reject on return before retaining another representation.
                let bytes = try access.data(index, type)
                guard bytes.count <= Self.byteLimit - size else { throw DriverFault("ACTION_UNSUPPORTED") }
                size += bytes.count; total += 1; representations[type] = bytes
            }
            items.append(representations)
        }
        try Self.validate(items)
        guard generation == count else { throw DriverFault("CLIPBOARD_CHANGED") }
        return DriverSemanticSnapshot(count: count, items: items, typeOrder: types)
    }
    func snapshot() throws -> DriverSemanticSnapshot {
        guard database != nil else { throw DriverFault("ACTION_UNSUPPORTED") }; return try read()
    }
    static func contains(_ actual: [[String: Data]], requested: [[String: Data]]) -> Bool {
        actual.count == requested.count && zip(actual, requested).allSatisfy { got, wanted in wanted.allSatisfy { got[$0.key] == $0.value } }
    }
    func replace(_ items: [[String: Data]], expected: Int) throws -> Int {
        try restore(DriverSemanticSnapshot(count: expected, items: items), expected: expected)
    }
    func restore(_ snapshot: DriverSemanticSnapshot, expected: Int) throws -> Int {
        guard database != nil else { throw DriverFault("ACTION_UNSUPPORTED") }
        try Self.validate(snapshot.items)
        guard snapshot.typeOrder.count == snapshot.items.count,
              zip(snapshot.typeOrder, snapshot.items).allSatisfy({ Set($0.0) == Set($0.1.keys) && $0.0.count == $0.1.count }) else { throw DriverFault("ACTION_UNSUPPORTED") }
        let write = try access.prepare(snapshot)
        guard generation == expected else { throw DriverFault("CLIPBOARD_CHANGED") }
        let cleared = access.clear(true)
        guard generation == cleared else { throw DriverFault("CLIPBOARD_CHANGED") }
        guard write() else {
            guard generation == cleared else { throw DriverFault("CLIPBOARD_CHANGED") }
            throw DriverSemanticClipboardFault(ownedCount: cleared)
        }
        guard generation == cleared else { throw DriverFault("CLIPBOARD_CHANGED") }
        do {
            let verified = try read()
            guard verified.count == cleared, Self.contains(verified.items, requested: snapshot.items) else { throw DriverSemanticClipboardFault(ownedCount: cleared) }
        } catch let fault as DriverFault where fault.code == "CLIPBOARD_CHANGED" { throw fault }
        catch { throw DriverSemanticClipboardFault(ownedCount: generation == cleared ? cleared : nil) }
        return cleared
    }
}
struct DriverSemanticReservationBusy: Error {}

// Byte-compatible with clipboard-recovery.mjs v2: a big-endian header length,
// JSON metadata, then each representation's raw bytes in declaration order.
// Runtime records add an expected generation and use a separate filename prefix:
// the browser's recovery cannot discard that generation check. Concealed originals
// never go to disk.
final class DriverSemanticSnapshotStore {
    struct Token { let name: String; let device: dev_t; let inode: ino_t }
    struct Record { let token: Token; let original: DriverSemanticSnapshot; let staged: DriverSemanticSnapshot; let expected: Int }
    let directory: URL
    private let boot: () throws -> String
    private let now: () -> Double
    init(directory: URL, boot: @escaping () throws -> String = DriverSemanticSnapshotStore.bootSession,
         now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.directory = directory; self.boot = boot; self.now = now
    }
    static let memoryOnlyTypes: Set<String> = ["org.nspasteboard.TransientType", "org.nspasteboard.ConcealedType", "com.agilebits.onepassword",
        "de.petermaurer.TransientPasteboardType", "com.typeit4me.clipping", "Pasteboard generator type",
        "application/x-nspasteboard-concealed-type", "com.trolltech.anymime.application--x-nspasteboard-concealed-type"]
    static func bootSession() throws -> String {
        var time = timeval(), size = MemoryLayout<timeval>.size
        guard sysctlbyname("kern.boottime", &time, &size, nil, 0) == 0 else { throw DriverFault("ACTION_UNSUPPORTED") }
        return "\(time.tv_sec):\(time.tv_usec)"
    }
    static func checkDirectory(_ directory: URL, create: Bool, privateMode: Bool = true) throws {
        // Callers normalize the macOS temporary-directory alias. No symlink
        // components are followed, including above the private snapshot bank.
        let parent = directory.deletingLastPathComponent()
        if parent.path != directory.path { try checkDirectory(parent, create: create, privateMode: false) }
        var info = Darwin.stat()
        if lstat(directory.path, &info) != 0 {
            guard errno == ENOENT, create, mkdir(directory.path, 0o700) == 0,
                  lstat(directory.path, &info) == 0 else { throw DriverFault("ACTION_UNSUPPORTED") }
        }
        guard info.st_mode & S_IFMT == S_IFDIR else { throw DriverFault("ACTION_UNSUPPORTED") }
        if privateMode {
            guard info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw DriverFault("ACTION_UNSUPPORTED") }
        } else if directory.pathComponents.count > 1, info.st_mode & 0o022 != 0 {
            // The system root and root-owned sticky directories are safe ancestors. A
            // writable non-sticky descendant can replace the reservation bank.
            guard info.st_uid == 0, info.st_mode & 0o1000 != 0 || directory.path == "/" else { throw DriverFault("ACTION_UNSUPPORTED") }
        }
    }
    private func syncDirectory() throws {
        let fd = open(directory.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw DriverFault("ACTION_UNSUPPORTED") }; defer { close(fd) }
        guard fsync(fd) == 0 else { throw DriverFault("ACTION_UNSUPPORTED") }
    }
    private func safe(_ info: Darwin.stat) -> Bool {
        info.st_mode & S_IFMT == S_IFREG && info.st_uid == getuid() && info.st_mode & 0o7777 == 0o600 && info.st_nlink == 1 && info.st_size <= DriverSemanticPasteboardNative.byteLimit
    }
    private func writeAll(_ data: Data, fd: Int32) throws {
        try data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                guard count > 0 else { throw DriverFault("ACTION_UNSUPPORTED") }; offset += count
            }
        }
    }
    func save(original: DriverSemanticSnapshot, staged: DriverSemanticSnapshot, expected: Int) throws -> Token? {
        guard !original.items.contains(where: { !Self.memoryOnlyTypes.isDisjoint(with: $0.keys) }) else { return nil }
        try DriverSemanticPasteboardNative.validate(original.items); try DriverSemanticPasteboardNative.validate(staged.items)
        var payload = Data()
        func metadata(_ snapshot: DriverSemanticSnapshot) -> [[DriverObject]] {
            snapshot.items.enumerated().map { index, item in snapshot.typeOrder[index].map { type in
                let bytes = item[type]!; payload.append(bytes); return ["type": type, "size": bytes.count]
            } }
        }
        let originalMeta = metadata(original), stagedMeta = metadata(staged)
        let header: DriverObject = ["version": 2, "createdAt": Int(now()), "bootSession": try boot(),
            "original": originalMeta, "staged": stagedMeta, "runtimeExpectedCount": expected]
        let bytes = try JSONSerialization.data(withJSONObject: header, options: [.sortedKeys])
        guard payload.count + bytes.count + 4 <= DriverSemanticPasteboardNative.byteLimit else { throw DriverFault("ACTION_UNSUPPORTED") }
        var size = UInt32(bytes.count).bigEndian, record = withUnsafeBytes(of: &size) { Data($0) }
        record.append(bytes); record.append(payload)
        try Self.checkDirectory(directory, create: true)
        // Same backup/index exclusion as the browser store, without a child process.
        let backup = try PropertyListSerialization.data(fromPropertyList: "com.apple.backupd", format: .binary, options: 0)
        let excluded = backup.withUnsafeBytes { setxattr(directory.path, "com.apple.metadata:com_apple_backup_excludeItem", $0.baseAddress, $0.count, 0, XATTR_NOFOLLOW) }
        guard excluded == 0 else { throw DriverFault("ACTION_UNSUPPORTED") }
        let marker = open(directory.appendingPathComponent(".metadata_never_index").path, O_WRONLY | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard marker >= 0 else { throw DriverFault("ACTION_UNSUPPORTED") }
        var markerInfo = Darwin.stat()
        let markerSafe = fstat(marker, &markerInfo) == 0 && safe(markerInfo) && fsync(marker) == 0
        close(marker)
        guard markerSafe else { throw DriverFault("ACTION_UNSUPPORTED") }
        let name = "runtime-snapshot-" + UUID().uuidString.lowercased() + ".bin", path = directory.appendingPathComponent(name).path
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw DriverFault("ACTION_UNSUPPORTED") }; defer { close(fd) }
        var info = Darwin.stat()
        guard fstat(fd, &info) == 0, safe(info) else { throw DriverFault("ACTION_UNSUPPORTED") }
        let token = Token(name: name, device: info.st_dev, inode: info.st_ino)
        do { try writeAll(record, fd: fd); guard fsync(fd) == 0 else { throw DriverFault("ACTION_UNSUPPORTED") }; try syncDirectory() }
        catch { try? remove(token); throw error }
        return token
    }
    func remove(_ token: Token) throws {
        try Self.checkDirectory(directory, create: false)
        let path = directory.appendingPathComponent(token.name).path
        let fd = open(path, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw DriverFault("ACTION_UNSUPPORTED") }; defer { close(fd) }
        var info = Darwin.stat()
        guard fstat(fd, &info) == 0, safe(info), info.st_dev == token.device, info.st_ino == token.inode else { throw DriverFault("ACTION_UNSUPPORTED") }
        let zero = Data(count: 65536); var remaining = Int(info.st_size)
        while remaining > 0 { let n = min(remaining, zero.count); try writeAll(zero.prefix(n), fd: fd); remaining -= n }
        guard fsync(fd) == 0 else { throw DriverFault("ACTION_UNSUPPORTED") }
        var latest = Darwin.stat()
        guard lstat(path, &latest) == 0, latest.st_ino == info.st_ino, latest.st_dev == info.st_dev,
              unlink(path) == 0 else { throw DriverFault("ACTION_UNSUPPORTED") }
        try syncDirectory()
    }
    func records() throws -> [Record] {
        if !FileManager.default.fileExists(atPath: directory.path) { return [] }
        try Self.checkDirectory(directory, create: false)
        var records = [Record]()
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
            where name.range(of: "^runtime-snapshot-[0-9a-f-]{36}\\.bin$", options: .regularExpression) != nil {
            let path = directory.appendingPathComponent(name).path
            let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard fd >= 0 else { continue }; defer { close(fd) }
            var info = Darwin.stat()
            guard fstat(fd, &info) == 0, safe(info) else { continue }
            let token = Token(name: name, device: info.st_dev, inode: info.st_ino)
            var data = Data(count: Int(info.st_size))
            let count = data.withUnsafeMutableBytes { raw in Darwin.read(fd, raw.baseAddress, raw.count) }
            guard count == data.count, data.count >= 4 else { continue }
            let length = data.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
            guard length <= data.count - 4,
                  let header = try? JSONSerialization.jsonObject(with: data[4..<(4 + length)]) as? DriverObject,
                  // Browser records remain owned by the browser recovery routine.
                  let expected = header["runtimeExpectedCount"] as? Int, expected >= 0, expected < Int.max else { continue }
            do {
                guard header["version"] as? Int == 2, let created = header["createdAt"] as? Double,
                      header["bootSession"] as? String == (try boot()), now() >= created, now() - created <= 600000 else {
                    try remove(token); continue
                }
                var offset = 4 + length
                func snapshot(_ key: String) throws -> DriverSemanticSnapshot {
                    guard let metadata = header[key] as? [[DriverObject]], metadata.count <= 4096 else { throw DriverFault("ACTION_UNSUPPORTED") }
                    var items = [[String: Data]](), order = [[String]]()
                    for reps in metadata {
                        var item = [String: Data](), types = [String]()
                        for rep in reps {
                            guard let type = rep["type"] as? String, item[type] == nil, let size = rep["size"] as? Int,
                                  size >= 0, size <= data.count - offset else { throw DriverFault("ACTION_UNSUPPORTED") }
                            item[type] = data[offset..<(offset + size)]; offset += size; types.append(type)
                        }
                        items.append(item); order.append(types)
                    }
                    try DriverSemanticPasteboardNative.validate(items)
                    return DriverSemanticSnapshot(count: expected, items: items, typeOrder: order)
                }
                let original = try snapshot("original"), staged = try snapshot("staged")
                guard offset == data.count, !original.items.contains(where: { !Self.memoryOnlyTypes.isDisjoint(with: $0.keys) }),
                      staged.items.count == 1, staged.items[0]["org.nspasteboard.TransientType"] == Data(),
                      staged.items[0]["public.utf8-plain-text"] != nil else { try remove(token); continue }
                records.append(Record(token: token, original: original, staged: staged, expected: expected))
            } catch { continue }
        }
        return records
    }
}

// Owns the original through uncertain delivery and restoration. A timer makes one
// off-request restore attempt after 500 ms, then releases the shared reservation.
// A retained disk record is retryable on next start; concealed data stays in memory.
final class DriverSemanticClipboardRecovery {
    private let board: DriverSemanticPasteboard
    private let store: DriverSemanticSnapshotStore?
    private let lock = NSRecursiveLock()
    private var saved: DriverSemanticSnapshot?
    private var expected: Int?
    private var tokens = [DriverSemanticSnapshotStore.Token]()
    private var staged: DriverSemanticSnapshot?
    private var acquired = false
    private var lastStaged: Int?
    private var restored: Int?
    private var restoreAttempts = 0
    private var restoreFailed = false
    private var timer: DispatchWorkItem?
    init(board: DriverSemanticPasteboard, store: DriverSemanticSnapshotStore?) { self.board = board; self.store = store }
    func start() throws {
        lock.lock(); defer { lock.unlock() }
        guard let store = store else { return }
        let records = try store.records()
        guard !records.isEmpty else { return }
        for record in records {
            try board.acquire(); acquired = true
            defer { if acquired { board.release(); acquired = false } }
            if board.generation != record.expected { try store.remove(record.token); continue }
            let current = try board.snapshot()
            if DriverSemanticPasteboardNative.contains(current.items, requested: record.original.items) {
                try store.remove(record.token); continue
            }
            guard current.items.isEmpty || DriverSemanticPasteboardNative.contains(current.items, requested: record.staged.items) else {
                try store.remove(record.token); continue
            }
            saved = record.original; expected = record.expected; staged = record.staged; tokens = [record.token]
            try restore()
        }
    }

    func begin() throws -> DriverSemanticSnapshot {
        lock.lock(); defer { lock.unlock() }
        if saved != nil { try restore() }
        try start() // Recover earlier crashed helpers before staging again.
        try board.acquire(); acquired = true
        do { return try board.snapshot() } catch { acquired = false; board.release(); throw error }
    }
    func stage(_ items: [[String: Data]], saving original: DriverSemanticSnapshot, beforeWrite: () throws -> Void = {}) throws -> Int {
        lock.lock(); defer { lock.unlock() }
        guard acquired, original.count >= 0, original.count < Int.max else { throw DriverFault("ACTION_UNSUPPORTED") }
        // The durable record is synced before the first mutating call. Oversized
        // snapshots (including metadata and staged bytes) refuse without a clear.
        let staged = DriverSemanticSnapshot(count: original.count + 1, items: items)
        if let token = try store?.save(original: original, staged: staged, expected: original.count + 1) { tokens.append(token) }
        do { try beforeWrite() } catch {
            for token in tokens { try? store?.remove(token) }; tokens = []; throw error
        }
        self.staged = staged
        saved = original; expected = original.count + 1; lastStaged = expected; restored = nil; restoreAttempts = 0; restoreFailed = false
        let work = DispatchWorkItem { [weak self] in try? self?.restore() }
        timer = work; DispatchQueue.global().asyncAfter(deadline: .now() + 0.5, execute: work)
        do {
            let count = try board.replace(items, expected: original.count)
            guard count == expected else { throw DriverFault("CLIPBOARD_CHANGED") }; return count
        } catch let failure as DriverSemanticClipboardFault {
            if let count = failure.ownedCount { expected = count }
            throw failure
        } catch {
            // A conflict is another owner's clipboard. Leave it alone forever.
            if let fault = error as? DriverFault, fault.code == "CLIPBOARD_CHANGED" { finish() }
            throw error
        }
    }
    func withOwned<T>(_ generation: Int, _ body: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard acquired, expected == generation, board.generation == generation else { throw DriverFault("CLIPBOARD_CHANGED") }
        return try body()
    }
    func ownership(_ generation: Int) -> String {
        lock.lock(); defer { lock.unlock() }
        if lastStaged == generation, let restored = restored, board.generation == restored { return "restored" }
        if saved != nil, expected == board.generation { return restoreFailed ? "restore-failed" : "held" }
        return "changed"
    }
    private func finish() {
        for token in tokens { try? store?.remove(token) }
        saved = nil; expected = nil; staged = nil; tokens = []; timer?.cancel(); timer = nil
        if acquired { board.release(); acquired = false }
    }
    func releaseIfUnstaged() {
        lock.lock(); defer { lock.unlock() }
        if saved == nil && acquired { board.release(); acquired = false }
    }
    func restore() throws {
        lock.lock(); defer { lock.unlock() }
        guard let saved = saved, let expected = expected else { releaseIfUnstaged(); return }
        guard restoreAttempts < 5 else { throw DriverFault("CLIPBOARD_RESTORE_FAILED") }
        if !acquired { try board.acquire(); acquired = true }
        restoreAttempts += 1
        do {
            guard board.generation == expected else { throw DriverFault("CLIPBOARD_CHANGED") }
            // Journal the next clear before restoring too. Keep the prior token
            // until success, so death before or after that clear is recoverable.
            if let staged = staged, let token = try store?.save(original: saved, staged: staged, expected: expected + 1) { tokens.append(token) }
            restored = try board.restore(saved, expected: expected); finish()
        } catch let fault as DriverFault where fault.code == "CLIPBOARD_CHANGED" {
            finish(); throw fault
        } catch {
            // Do not hold every session's Copy/Cut forever after a failed restore.
            // If AppKit cleared before failing, retain that owned generation for
            // one clean-shutdown/next-call retry in this process.
            restoreFailed = true
            if let failure = error as? DriverSemanticClipboardFault, let count = failure.ownedCount { self.expected = count }
            if acquired { board.release(); acquired = false }
            throw DriverFault("CLIPBOARD_RESTORE_FAILED")
        }
    }
    // Integrator calls once after draining the request queue, before EOF _exit.
    // No DriverRequest deadline applies to this restoration.
    func shutdown() { lock.lock(); defer { lock.unlock() }; timer?.cancel(); restoreAttempts = min(restoreAttempts, 4); try? restore() }
}
