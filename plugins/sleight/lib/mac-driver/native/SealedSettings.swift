// One store for settings authority. No production byte-sealing command exists.
import Foundation
import CoreFoundation
import CryptoKit
import Security
import LocalAuthentication
import Darwin

enum SettingsFault: String, Error, CustomStringConvertible { case unsafe = "SETTINGS_UNSAFE", invalid = "SETTINGS_INTENT_REFUSED", oversize = "SETTINGS_OVERSIZE"
    case keyStore = "SETTINGS_KEYSTORE_UNAVAILABLE", untrusted = "SETTINGS_UNTRUSTED"
    case person = "PERSON_INPUT_REQUIRED", preview = "SETTINGS_PREVIEW_ONLY", write = "SETTINGS_WRITE_FAILED"
    var description: String { rawValue }
}

let settingsFixedNames = ["preapproved.json", "permissions.json", "turbo.json", "turbo-owner.json", "turbo-apps.json",
    "electron-grants.json", "hand.json", "settings-link.json", "routine-launcher.mjs"]
func settingsMatches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
func settingsAbsolute(_ path: String) -> Bool {
    path.hasPrefix("/") && path != "/" && !path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().contains { $0.isEmpty || $0 == "." || $0 == ".." }
}
func settingsName(_ file: String) -> Bool {
    settingsFixedNames.contains(file) || settingsMatches(file, #"^(routines|watches)/[a-f0-9]{20}/[a-z][a-z0-9-]*\.json$"#)
}
func settingsBase64(_ bytes: Data) -> String { bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
func settingsDecode(_ string: String, count: Int) -> Data? {
    let padded = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - string.count % 4) % 4)
    guard let bytes = Data(base64Encoded: padded), bytes.count == count, settingsBase64(bytes) == string else { return nil }
    return bytes
}
func settingsHash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
func settingsCanonical(_ path: String) -> String? {
    guard let pointer = realpath(path, nil) else { return nil }; defer { free(pointer) }; return String(cString: pointer)
}
// CryptoKit's HMAC.isValidAuthenticationCode performs the constant-time comparison, including wrong-length input.
func settingsTimingSafeEqual(_ given: Data, key: Data, message: Data) -> Bool {
    HMAC<SHA256>.isValidAuthenticationCode(given, authenticating: message, using: SymmetricKey(data: key))
}
func settingsMACMessage(_ record: SettingsKeyRecord, file: String, counter: Int64, bytes: Data) -> Data {
    Data(["sleight-seal", "1", file, record.installId, String(counter), settingsHash(bytes)].joined(separator: "\0").utf8)
}

struct SettingsKeyRecord: Codable {
    var installId: String, key: String, counters: [String: Int64], present: [String]
    func validate() throws {
        guard settingsDecode(installId, count: 16) != nil, settingsDecode(key, count: 32) != nil,
            counters.count <= 16384, present.count <= 16384, Set(present).count == present.count,
            Set(present).isSubset(of: Set(counters.keys)), counters.keys.allSatisfy(settingsName), present.allSatisfy(settingsName),
            counters.values.allSatisfy({ $0 > 0 && $0 <= 9007199254740991 }) else { throw SettingsFault.keyStore }
    }
    static func fresh() throws -> SettingsKeyRecord {
        var installation = Data(count: 16), secret = Data(count: 32)
        guard installation.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }) == errSecSuccess,
            secret.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { throw SettingsFault.keyStore }
        return SettingsKeyRecord(installId: settingsBase64(installation), key: settingsBase64(secret), counters: [:], present: [])
    }
}
protocol KeyStore { func load() throws -> SettingsKeyRecord?; func save(_ record: SettingsKeyRecord) throws }

// There is no login-keychain fallback. A missing entitlement fails without prompting.
final class KeychainKeyStore: KeyStore {
    private let group: String
    private let service = "com.landoclusters.sleight.settings.v1"
    init() throws {
        var code: SecCode?, staticCode: SecStaticCode?, info: CFDictionary?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let own = code,
            SecCodeCopyStaticCode(own, [], &staticCode) == errSecSuccess, let disk = staticCode,
            SecCodeCopySigningInformation(disk, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
            let data = info as? [String: Any], data[kSecCodeInfoIdentifier as String] as? String == "com.landoclusters.sleight.helper",
            let team = data[kSecCodeInfoTeamIdentifier as String] as? String, settingsMatches(team, "^[A-Z0-9]{10}$"),
            let entitlements = data[kSecCodeInfoEntitlementsDict as String] as? [String: Any],
            let groups = entitlements["keychain-access-groups"] as? [String], groups.contains(team + ".com.landoclusters.sleight") else { throw SettingsFault.keyStore }
        group = team + ".com.landoclusters.sleight"
    }
    private func query() -> [String: Any] {
        let context = LAContext(); context.interactionNotAllowed = true
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "settings",
            kSecAttrAccessGroup as String: group, kSecUseDataProtectionKeychain as String: true,
            kSecAttrSynchronizable as String: false, kSecUseAuthenticationContext as String: context]
    }
    func load() throws -> SettingsKeyRecord? {
        var q = query(); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let bytes = result as? Data, bytes.count <= 4 * 1024 * 1024 else { throw SettingsFault.keyStore }
        let record = try JSONDecoder().decode(SettingsKeyRecord.self, from: bytes); try record.validate(); return record
    }
    func save(_ record: SettingsKeyRecord) throws {
        try record.validate()
        let bytes = try JSONEncoder().encode(record), q = query()
        let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
        if status == errSecItemNotFound {
            var add = q; add[kSecValueData as String] = bytes
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw SettingsFault.keyStore }
        } else if status != errSecSuccess { throw SettingsFault.keyStore }
    }
#if SLEIGHT_KEYSTORE_PROBE
    // A probe build must reach SecItem even when ad-hoc signed, rather than failing our identity precheck.
    init(probeGroup: String) throws {
        guard settingsMatches(probeGroup, #"^[A-Z0-9]{10}\.com\.landoclusters\.sleight$"#) else { throw SettingsFault.invalid }
        group = probeGroup
    }
    func probe(_ service: String, op: String) -> Int32 {
        guard settingsMatches(service, #"^com\.landoclusters\.sleight\.probe\.[A-Za-z0-9.-]{1,80}$"#) else { return 64 }
        var q = query(); q[kSecAttrService as String] = service
        var status: OSStatus
        switch op {
        case "add":
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            q[kSecValueData as String] = Data(repeating: 7, count: 32)
            status = SecItemAdd(q as CFDictionary, nil)
        case "read": q[kSecReturnData as String] = true; var result: CFTypeRef?; status = SecItemCopyMatching(q as CFDictionary, &result)
        case "delete": status = SecItemDelete(q as CFDictionary)
        default: return 64
        }
        // Metadata only. The probe never emits the value, even on success.
        print("key-store-probe status=\(status)")
        return status == errSecSuccess ? 0 : 1
    }
#endif
}

#if SLEIGHT_TEST_KEYSTORE
// SLEIGHT_TEST_FILE_KEYSTORE is a binary-scan marker. This whole class is absent from production builds.
let settingsFileKeyStoreMarker = "SLEIGHT_TEST_FILE_KEYSTORE"
final class FileKeyStore: KeyStore {
    private let path: String
    init(path: String) { precondition(!settingsFileKeyStoreMarker.isEmpty); self.path = path }
    func load() throws -> SettingsKeyRecord? {
        var st = stat()
        guard lstat(path, &st) == 0 else { if errno == ENOENT { return nil }; throw SettingsFault.keyStore }
        guard (st.st_mode & S_IFMT) == S_IFREG, (st.st_mode & 0o7777) == 0o600, st.st_uid == getuid(), st.st_nlink == 1 else { throw SettingsFault.keyStore }
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); guard fd >= 0 else { throw SettingsFault.keyStore }; defer { close(fd) }
        let bytes = try settingsReadDescriptor(fd, limit: 4 * 1024 * 1024)
        let record = try JSONDecoder().decode(SettingsKeyRecord.self, from: bytes); try record.validate(); return record
    }
    func save(_ record: SettingsKeyRecord) throws {
        try record.validate()
        let temporary = path + "." + String(getpid()) + ".tmp"
        let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw SettingsFault.keyStore }; defer { close(fd); unlink(temporary) }
        try settingsWriteDescriptor(fd, bytes: JSONEncoder().encode(record))
        guard rename(temporary, path) == 0 else { throw SettingsFault.keyStore }
    }
}
#endif

func settingsReadDescriptor(_ fd: Int32, limit: Int) throws -> Data {
    var out = Data(), buffer = [UInt8](repeating: 0, count: 16384)
    while true {
        let n = read(fd, &buffer, buffer.count)
        if n == 0 { return out }; if n < 0 { if errno == EINTR { continue }; throw SettingsFault.unsafe }
        guard n <= limit - out.count else { throw SettingsFault.oversize }; out.append(contentsOf: buffer.prefix(n))
    }
}
func settingsWriteDescriptor(_ fd: Int32, bytes: Data) throws {
    try bytes.withUnsafeBytes { raw in
        var offset = 0
        while offset < bytes.count {
            let n = write(fd, raw.baseAddress!.advanced(by: offset), bytes.count - offset)
            if n < 0 && errno == EINTR { continue }; guard n > 0 else { throw SettingsFault.write }; offset += n
        }
    }
    guard fsync(fd) == 0 else { throw SettingsFault.write }
}

// JSONSerialization accepts duplicate keys. Sidecars and settings must not have two meanings.
func settingsJSON(_ bytes: Data) throws -> [String: Any] {
    let b = Array(bytes); var i = 0
    func space() { while i < b.count && [9, 10, 13, 32].contains(b[i]) { i += 1 } }
    func string() throws -> String {
        let start = i; guard i < b.count && b[i] == 34 else { throw SettingsFault.unsafe }; i += 1
        while i < b.count {
            if b[i] == 92 { i += 2; continue }
            if b[i] == 34 { i += 1; guard let text = try JSONSerialization.jsonObject(with: Data(b[start..<i]), options: .fragmentsAllowed) as? String else { throw SettingsFault.unsafe }; return text }
            i += 1
        }; throw SettingsFault.unsafe
    }
    func value(_ depth: Int) throws {
        guard depth < 64 else { throw SettingsFault.unsafe }; space(); guard i < b.count else { throw SettingsFault.unsafe }
        if b[i] == 34 { _ = try string(); return }
        if b[i] == 123 {
            i += 1; space(); var keys = Set<String>(); if i < b.count && b[i] == 125 { i += 1; return }
            while true {
                space(); let key = try string(); guard keys.insert(key).inserted else { throw SettingsFault.unsafe }
                space(); guard i < b.count && b[i] == 58 else { throw SettingsFault.unsafe }; i += 1; try value(depth + 1); space()
                guard i < b.count else { throw SettingsFault.unsafe }; if b[i] == 125 { i += 1; return }
                guard b[i] == 44 else { throw SettingsFault.unsafe }; i += 1
            }
        }
        if b[i] == 91 {
            i += 1; space(); if i < b.count && b[i] == 93 { i += 1; return }
            while true { try value(depth + 1); space(); guard i < b.count else { throw SettingsFault.unsafe }
                if b[i] == 93 { i += 1; return }; guard b[i] == 44 else { throw SettingsFault.unsafe }; i += 1 }
        }
        let start = i; while i < b.count && ![9, 10, 13, 32, 44, 93, 125].contains(b[i]) { i += 1 }
        guard i > start else { throw SettingsFault.unsafe }
    }
    try value(0); space(); guard i == b.count, let result = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw SettingsFault.unsafe }
    return result
}
func settingsInteger(_ value: Any?) -> Int64? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
        n.doubleValue.rounded() == n.doubleValue, n.doubleValue >= 0, n.doubleValue <= 9007199254740991 else { return nil }; return n.int64Value
}
func settingsBool(_ value: Any?) -> Bool { guard let n = value as? NSNumber else { return false }; return CFGetTypeID(n) == CFBooleanGetTypeID() }
func settingsText(_ value: Any?, limit: Int = 128) -> Bool {
    guard let text = value as? String, !text.isEmpty, text.count <= limit else { return false }
    return text.unicodeScalars.allSatisfy { $0.value >= 32 && !((127...159).contains($0.value)) }
}
func settingsByteLimit(_ file: String) -> Int {
    if file == "hand.json" || file == "settings-link.json" { return 4096 }
    if file == "permissions.json" { return 262144 }
    if file == "turbo-owner.json" { return 8192 }
    return 1048576
}
func settingsCleanPreapproved(_ apps: [[String: Any]]) -> [[String: Any]] {
    let rank = ["low": 0, "medium": 1, "high": 2]
    var entries = [[String: Any]](), positions = [String: Int]()
    for app in apps {
        let name = app["app"] as! String
        if let index = positions[name] {
            let sameTeam = entries[index]["launchTeam"] as? String == app["launchTeam"] as? String
            if rank[app["riskLevel"] as! String]! < rank[entries[index]["riskLevel"] as! String]! { entries[index] = app }
            if !sameTeam { entries[index].removeValue(forKey: "launchTeam") }
        } else { positions[name] = entries.count; entries.append(app) }
    }
    return entries
}
func settingsSchema(_ file: String, _ bytes: Data) throws {
    guard bytes.count <= settingsByteLimit(file) else { throw SettingsFault.oversize }
    guard settingsName(file), String(data: bytes, encoding: .utf8) != nil else { throw SettingsFault.unsafe }
    if file == "routine-launcher.mjs" { guard !bytes.isEmpty else { throw SettingsFault.unsafe }; return }
    let data = try settingsJSON(bytes)
    func fields(_ allowed: [String]) -> Bool { Set(data.keys).isSubset(of: Set(allowed)) }
    func version(_ v: Int64 = 1) -> Bool { settingsInteger(data["version"]) == v }
    switch file {
    case "preapproved.json":
        guard fields(["version", "apps"]), version(), let apps = data["apps"] as? [[String: Any]], apps.count <= 4096 else { throw SettingsFault.unsafe }
        for app in apps {
            // 2.0 records `launchTeam`. This version accepts it and grants nothing from it (owner, 2026-11-10).
            guard Set(app.keys).isSubset(of: ["app", "riskLevel", "added", "source", "launchTeam"]), settingsText(app["app"], limit: 4096),
                app["launchTeam"] == nil || settingsMatches(app["launchTeam"] as? String ?? "", #"^(apple|[A-Z0-9]{10})$"#),
                let name = app["app"] as? String, name == name.trimmingCharacters(in: .whitespacesAndNewlines), !name.contains("*"),
                let risk = app["riskLevel"] as? String, ["low", "medium", "high"].contains(risk),
                app["source"] == nil || app["source"] as? String == "always-allow",
                app["added"] == nil || settingsMatches(app["added"] as? String ?? "", #"^\d{4}-\d\d-\d\d$"#) else { throw SettingsFault.unsafe }
        }
    case "permissions.json":
        guard fields(["version", "apps", "sites", "only"]), version(), let apps = data["apps"] as? [[String: Any]], apps.count <= 256,
            let sites = data["sites"] as? [String], sites.count <= 256, Set(sites).count == sites.count else { throw SettingsFault.unsafe }
        func origin(_ value: String) -> Bool {
            guard let url = URLComponents(string: value), ["http", "https"].contains(url.scheme ?? ""), let host = url.host,
                !host.isEmpty, host == host.lowercased(), url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty else { return false }
            return !((url.scheme == "http" && url.port == 80) || (url.scheme == "https" && url.port == 443))
        }
        guard sites.allSatisfy(origin) else { throw SettingsFault.unsafe }
        if let raw = data["only"] {
            guard let only = raw as? [String], !only.isEmpty, only.count <= 256, Set(only).count == only.count, only.allSatisfy(origin) else { throw SettingsFault.unsafe }
        }
        for app in apps {
            guard Set(app.keys).isSubset(of: ["id", "name", "aliases"]), let id = app["id"] as? String, id.count <= 255,
                settingsMatches(id, #"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$"#), app["name"] == nil || settingsText(app["name"]) else { throw SettingsFault.unsafe }
            if let raw = app["aliases"] { guard let aliases = raw as? [String], (1...4).contains(aliases.count), aliases.allSatisfy({ settingsText($0) }) else { throw SettingsFault.unsafe } }
        }
    case "turbo.json":
        guard fields(["version", "enabled", "profileRoot", "executable", "receipt", "entryHashes"]), version(), settingsBool(data["enabled"]) else { throw SettingsFault.unsafe }
        if data["enabled"] as? Bool == true {
            guard let executable = data["executable"] as? String, executable.hasPrefix("/"),
                let profile = data["profileRoot"] as? String, profile.hasPrefix("/"), let receipt = data["receipt"] as? [String: Any],
                receipt["accepted"] as? Bool == true, settingsInteger(receipt["protocol"]) == 1, receipt["helperMode"] as? String == "source",
                receipt["node"] is String, receipt["files"] is [[String: Any]], data["entryHashes"] is [String: String] else { throw SettingsFault.unsafe }
        }
    case "turbo-apps.json":
        guard fields(["version", "apps"]), version(), let apps = data["apps"] as? [String: [String: Any]], apps.count <= 64 else { throw SettingsFault.unsafe }
        for (id, app) in apps {
            guard settingsMatches(id, #"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$"#), Set(app.keys) == ["build", "enabled"], settingsBool(app["enabled"]),
                let build = app["build"] as? String, build.hasPrefix(id + "@"), settingsMatches(build, #"^[A-Za-z0-9._@+-]{1,128}$"#) else { throw SettingsFault.unsafe }
        }
    case "turbo-owner.json":
        guard Set(data.keys) == ["version", "sleight", "pluginRoot", "sha256"], version(),
            data["sleight"] is NSNull || settingsMatches(data["sleight"] as? String ?? "", #"^\d+\.\d+\.\d+([+-][A-Za-z0-9.-]+)?$"#),
            let path = data["pluginRoot"] as? String, path.hasPrefix("/"), settingsMatches(data["sha256"] as? String ?? "", "^[a-f0-9]{64}$") else { throw SettingsFault.unsafe }
    case "settings-link.json":
        guard Set(data.keys) == ["version", "sha256"], version(), settingsMatches(data["sha256"] as? String ?? "", "^[a-f0-9]{64}$") else { throw SettingsFault.unsafe }
    case "electron-grants.json":
        guard fields(["version", "grants"]), version(2), let grants = data["grants"] as? [[String: Any]], grants.count <= 4096 else { throw SettingsFault.unsafe }
        for grant in grants {
            guard Set(grant.keys) == ["record", "seal"], grant["seal"] is String, let record = grant["record"] as? [String: Any],
                Set(record.keys) == ["key", "name", "bundleId", "signer", "version", "runtime", "profile", "executable", "cdhash"],
                record.values.allSatisfy({ settingsText($0, limit: 4096) }) else { throw SettingsFault.unsafe }
        }
    case "hand.json":
        guard fields(["version", "enabled", "capture", "stream", "labels", "style", "character", "record_runs", "narration", "voice", "perch", "lines", "size", "cast", "stageAttention"]), version(), settingsBool(data["enabled"]) else { throw SettingsFault.unsafe }
        for key in ["stream", "record_runs", "perch", "stageAttention"] { if let value = data[key], !settingsBool(value) { throw SettingsFault.unsafe } }
        for (key, values) in ["capture": ["hidden", "visible"], "labels": ["off", "role", "title"], "style": ["glove", "ring", "seam", "sprite"], "narration": ["off", "bubbles", "voice"], "lines": ["on", "off"]] {
            if let value = data[key], !values.contains(value as? String ?? "") { throw SettingsFault.unsafe }
        }
        if let value = data["character"], !settingsMatches(value as? String ?? "", "^[a-z0-9-]{1,48}$") { throw SettingsFault.unsafe }
        if let value = data["cast"] { guard let cast = value as? [String], cast.count <= 32, Set(cast).count == cast.count,
            cast.allSatisfy({ settingsMatches($0, "^[a-z0-9-]{1,48}$") }) else { throw SettingsFault.unsafe } }
        if let value = data["size"] {
            if let n = value as? NSNumber { guard !settingsBool(n), (104...560).contains(n.doubleValue) else { throw SettingsFault.unsafe } }
            else if !["small", "medium", "stage"].contains(value as? String ?? "") { throw SettingsFault.unsafe }
        }
        if let value = data["voice"] {
            guard let voice = value as? [String: Any], Set(voice.keys).isSubset(of: ["id", "rate"]), settingsMatches(voice["id"] as? String ?? "", "^[A-Za-z0-9._-]{1,200}$") else { throw SettingsFault.unsafe }
            if let rate = voice["rate"] { guard let n = rate as? NSNumber, !settingsBool(n), (0.1...0.6).contains(n.doubleValue) else { throw SettingsFault.unsafe } }
        }
    default:
        // The caller's routine/watch parser also validates its closed execution language before running it.
        let leaf = (file as NSString).lastPathComponent
        if leaf == "script.json" {
            guard settingsInteger(data["sleightReplay"]) == 1 || data["url"] is String else { throw SettingsFault.unsafe }
        } else if leaf == "routine.json" { guard settingsInteger(data["seconds"]) != nil else { throw SettingsFault.unsafe } }
    }
}

struct SettingsVerdict {
    let file: String, state: String, content: String?
    init(_ file: String, _ state: String, _ content: String? = nil) { self.file = file; self.state = state; self.content = content }
    func line() throws -> String {
        var row: [String: Any] = ["file": file, "state": state]
        if state == "trusted", let content = content { row["content"] = content }
        return String(data: try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!
    }
}
// A plan is built from fixed intents inside the helper. Its bytes are never accepted from the wire.
struct SettingsChange {
    fileprivate var writes: [(String, Data)] = [], removals: [String] = []
    fileprivate var before: [String: String] = [:]
    let reason: String, cardApp: String?, risk: String?, needsSheet: Bool
    var review: String { writes.map { "\($0.0):\n\(String(data: $0.1, encoding: .utf8)!)" }.joined(separator: "\n") }
}
struct SettingsAdoptionReview {
    fileprivate let files: [(String, Data)]
    var text: String { files.map { "\($0.0):\n\(String(data: $0.1, encoding: .utf8)!)" }.joined(separator: "\n") }
}

final class SealedSettings {
    let root: String, home: String
    private let keyStore: KeyStore
#if SLEIGHT_TEST_KEYSTORE
    var testFault: String?
#endif
    init(root: String, home: String, keyStore: KeyStore) throws {
        guard settingsAbsolute(root), settingsAbsolute(home),
            root == home || root.hasPrefix(home + "/") else { throw SettingsFault.unsafe }
        self.root = root; self.home = home; self.keyStore = keyStore
    }
    private func directory(_ path: String) throws -> Int32 {
        // Check even the ancestors above home for links. Their ownership rules belong to macOS.
        var cursor = "/", fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw SettingsFault.unsafe }
        do {
            for part in path.split(separator: "/") {
                cursor = cursor == "/" ? "/" + part : cursor + "/" + part
                let next = openat(fd, String(part), O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
                guard next >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
                close(fd); fd = next; var st = stat()
                guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR,
                    !(cursor == home || cursor.hasPrefix(home + "/")) || st.st_uid == getuid() && (st.st_mode & 0o022) == 0,
                    cursor != root || (st.st_mode & 0o7777) == 0o700 else { throw SettingsFault.unsafe }
            }
            guard settingsCanonical(path) == path else { throw SettingsFault.unsafe }
            return fd
        } catch { close(fd); throw error }
    }
    private func parent(_ file: String) throws -> (Int32, String) {
        guard settingsName(file) || settingsName(String(file.dropLast(5))) && file.hasSuffix(".seal") else { throw SettingsFault.unsafe }
        let full = root + "/" + file
        return (try directory((full as NSString).deletingLastPathComponent), (full as NSString).lastPathComponent)
    }
    private func unchangedDirectory(_ fd: Int32, _ path: String) throws {
        let other = try directory(path); defer { close(other) }; var before = stat(), after = stat()
        guard fstat(fd, &before) == 0, fstat(other, &after) == 0, before.st_ino == after.st_ino, before.st_dev == after.st_dev else { throw SettingsFault.unsafe }
    }
    private func readFile(_ file: String, limit: Int) throws -> Data {
        let (dir, leaf) = try parent(file); defer { close(dir) }
        let fd = openat(dir, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }; defer { close(fd) }
        var before = stat(), after = stat(), named = stat()
        guard fstat(fd, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG, before.st_uid == getuid(),
            (before.st_mode & 0o7777) == 0o600, before.st_nlink == 1, settingsCanonical(root + "/" + file) == root + "/" + file else { throw SettingsFault.unsafe }
        guard before.st_size <= limit else { throw SettingsFault.oversize }
        let bytes = try settingsReadDescriptor(fd, limit: limit)
        guard fstat(fd, &after) == 0, fstatat(dir, leaf, &named, AT_SYMLINK_NOFOLLOW) == 0,
            before.st_ino == named.st_ino, before.st_dev == named.st_dev, before.st_size == after.st_size,
            before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
            before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else { throw SettingsFault.unsafe }
        try unchangedDirectory(dir, (root + "/" + file as NSString).deletingLastPathComponent)
        return bytes
    }
    private func missing(_ error: Error) -> Bool { let e = error as NSError; return e.domain == NSPOSIXErrorDomain && e.code == Int(ENOENT) }
    private func verify(_ file: String, record: SettingsKeyRecord?) -> SettingsVerdict {
        let bytes: Data
        do { bytes = try readFile(file, limit: settingsByteLimit(file)); try settingsSchema(file, bytes) }
        catch {
            if !missing(error) { return SettingsVerdict(file, "unsafe") }
            if record?.present.contains(file) == true { return SettingsVerdict(file, "tampered") }
            do { _ = try readFile(file + ".seal", limit: 1024); return SettingsVerdict(file, "tampered") }
            catch { return SettingsVerdict(file, missing(error) ? "absent" : "unsafe") }
        }
        let side: Data
        do { side = try readFile(file + ".seal", limit: 1024) }
        catch { return SettingsVerdict(file, missing(error) ? "unsealed" : error as? SettingsFault == .oversize ? "tampered" : "unsafe") }
        do {
            let s = try settingsJSON(side)
            guard Set(s.keys) == ["version", "file", "counter", "mac"], settingsInteger(s["version"]) == 1,
                s["file"] as? String == file, let counter = settingsInteger(s["counter"]), counter > 0,
                let mac = s["mac"] as? String, let given = settingsDecode(mac, count: 32), let record = record,
                let key = settingsDecode(record.key, count: 32),
                settingsTimingSafeEqual(given, key: key, message: settingsMACMessage(record, file: file, counter: counter, bytes: bytes)) else { return SettingsVerdict(file, "tampered") }
            guard counter == record.counters[file] else { return SettingsVerdict(file, "stale") }
            return SettingsVerdict(file, "trusted", String(data: bytes, encoding: .utf8)!)
        } catch { return SettingsVerdict(file, "tampered") }
    }
    func verifyAll() throws -> [SettingsVerdict] {
        // No writes and no creation on a missing or inaccessible store.
        let record = try? keyStore.load()
        var names = Set(settingsFixedNames + (record?.present ?? []))
        for family in ["routines", "watches"] {
            let path = root + "/" + family
            guard let fd = try? directory(path) else { continue }; defer { close(fd) }
            let ids = try directoryNames(fd, limit: 4096)
            guard ids.count <= 4096 else { throw SettingsFault.unsafe }
            for id in ids where settingsMatches(id, "^[a-f0-9]{20}$") {
                guard let nested = try? directory(path + "/" + id) else { continue }; defer { close(nested) }
                let children = try directoryNames(nested, limit: 256)
                guard children.count <= 256 else { throw SettingsFault.unsafe }
                for child in children {
                    let name = child.hasSuffix(".seal") ? String(child.dropLast(5)) : child
                    if settingsName(family + "/" + id + "/" + name) { names.insert(family + "/" + id + "/" + name) }
                }
            }
        }
        return names.sorted().map { verify($0, record: record) }
    }
    private func directoryNames(_ fd: Int32, limit: Int) throws -> [String] {
        let copy = dup(fd); guard copy >= 0 else { throw SettingsFault.unsafe }
        guard let stream = fdopendir(copy) else { close(copy); throw SettingsFault.unsafe }; defer { closedir(stream) }
        var result: [String] = []
        while let entry = readdir(stream) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            guard result.count < limit else { throw SettingsFault.unsafe }; result.append(name)
        }
        return result
    }
    // Share the Node writer lock. Its recovery guard is persistent; the kernel releases its lock on exit.
    private func preapprovedLock(_ directory: Int32) throws -> Int32 {
        let name = "preapproved.json.lock", recovery = name + ".reclaim", deadline = Date().timeIntervalSince1970 + 5
        func fault(_ reason: String) -> NSError {
            let path = root + "/" + name
            func quote(_ text: String) -> String { "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'" }
            return NSError(domain: "SleightApprovalLock", code: 1, userInfo: [NSLocalizedDescriptionKey:
                "\(reason): \(path). After stopping approval writers, clear it with: rm -f -- \(quote(path)) \(quote(path + ".reclaim"))"])
        }
        func start(_ pid: Int32) -> String? {
            var info = proc_bsdinfo(); let size = Int32(MemoryLayout<proc_bsdinfo>.size)
            guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size, info.pbi_start_tvsec > 0 else { return nil }
            return String(info.pbi_start_tvsec)
        }
        func dead(_ record: [String: Any]) -> Bool {
            guard let pid = settingsInteger(record["pid"]), pid > 0, pid <= Int64(Int32.max) else { return false }
            if Darwin.kill(Int32(pid), 0) != 0 { return errno == ESRCH }
            guard let saved = record["startTime"] as? String, settingsMatches(saved, "^[1-9][0-9]{0,15}$"),
                let current = start(Int32(pid)) else { return false }
            return saved != current
        }
        while true {
            let own = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
            if own >= 0 {
                do {
                    var owner: [String: Any] = ["pid": Int(getpid())]
                    if let birth = start(getpid()) { owner["startTime"] = birth }
                    try settingsWriteDescriptor(own, bytes: JSONSerialization.data(withJSONObject: owner)); return own
                } catch { close(own); unlinkat(directory, name, 0); throw error }
            }
            guard errno == EEXIST else { throw fault("cannot open writer lock") }
            let existing = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
            if existing < 0 { if errno == ENOENT { continue }; throw fault("unreadable or unsafe writer lock") }
            defer { close(existing) }
            var before = stat()
            guard fstat(existing, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_nlink == 1,
                before.st_uid == getuid(), before.st_mode & 0o7777 == 0o600, before.st_size <= 1024 else { throw fault("unreadable or unsafe writer lock") }
            if let bytes = try? settingsReadDescriptor(existing, limit: 1024), let record = try? settingsJSON(bytes), dead(record) {
                let guardFD = openat(directory, recovery, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
                guard guardFD >= 0 else { throw fault("unreadable or unsafe writer lock") }
                defer { close(guardFD) }
                var guardStat = stat(), guardNamed = stat()
                guard fstat(guardFD, &guardStat) == 0, guardStat.st_mode & S_IFMT == S_IFREG, guardStat.st_nlink == 1,
                    guardStat.st_uid == getuid(), guardStat.st_mode & 0o7777 == 0o600,
                    fstatat(directory, recovery, &guardNamed, AT_SYMLINK_NOFOLLOW) == 0,
                    guardNamed.st_dev == guardStat.st_dev, guardNamed.st_ino == guardStat.st_ino else { throw fault("unreadable or unsafe writer lock") }
                if flock(guardFD, LOCK_EX | LOCK_NB) == 0 {
                    defer { flock(guardFD, LOCK_UN) }
                    var named = stat()
                    if fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0, named.st_dev == before.st_dev, named.st_ino == before.st_ino {
                        unlinkat(directory, name, 0)
                    }
                    continue
                }
                guard errno == EAGAIN || errno == EWOULDBLOCK else { throw fault("cannot acquire writer recovery lock") }
            }
            guard Date().timeIntervalSince1970 < deadline else { throw fault("writer busy; retry the change") }
            usleep(10_000)
        }
    }
    private func locked<T>(preapproved: Bool = false, _ action: () throws -> T) throws -> T {
        // Only authorized write paths call locked(). Verification never creates directories.
        if root != home {
            var fd = try directory(home); defer { close(fd) }
            var path = home
            for part in String(root.dropFirst(home.count + 1)).split(separator: "/") {
                let name = String(part)
                if mkdirat(fd, name, 0o700) != 0 && errno != EEXIST { throw SettingsFault.unsafe }
                path += "/" + name
                let next = try directory(path); close(fd); fd = next
            }
        }
        let fd = try directory(root); defer { close(fd) }
        let lock = openat(fd, ".settings-lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
        guard lock >= 0 else { throw SettingsFault.unsafe }; defer { close(lock) }
        var st = stat()
        guard fstat(lock, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_nlink == 1, st.st_uid == getuid(),
            (st.st_mode & 0o7777) == 0o600, flock(lock, LOCK_EX) == 0 else { throw SettingsFault.unsafe }
        defer { flock(lock, LOCK_UN) }
        var named = stat()
        guard fstatat(fd, ".settings-lock", &named, AT_SYMLINK_NOFOLLOW) == 0, named.st_ino == st.st_ino, named.st_dev == st.st_dev else { throw SettingsFault.unsafe }
        try unchangedDirectory(fd, root)
        let approvalLock: Int32?
        if preapproved { approvalLock = try preapprovedLock(fd) } else { approvalLock = nil }
        defer {
            if let approvalLock = approvalLock {
                var own = stat(), named = stat()
                if fstat(approvalLock, &own) == 0, fstatat(fd, "preapproved.json.lock", &named, AT_SYMLINK_NOFOLLOW) == 0,
                    own.st_dev == named.st_dev, own.st_ino == named.st_ino { unlinkat(fd, "preapproved.json.lock", 0) }
                close(approvalLock)
            }
        }
        return try action()
    }
    private func publish(_ file: String, bytes: Data, record: inout SettingsKeyRecord) throws {
        try settingsSchema(file, bytes)
        let (dir, leaf) = try parent(file); defer { close(dir) }
        let temporary = leaf + "." + String(getpid()) + ".tmp"
        let fd = openat(dir, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw SettingsFault.write }; defer { close(fd); unlinkat(dir, temporary, 0) }
        try settingsWriteDescriptor(fd, bytes: bytes)
        let counter = (record.counters[file] ?? 0) + 1
        guard counter <= 9007199254740991 else { throw SettingsFault.keyStore }
        record.counters[file] = counter; if !record.present.contains(file) { record.present.append(file) }
        try keyStore.save(record) // Advance durably before either public rename.
#if SLEIGHT_TEST_KEYSTORE
        if testFault == "after-counter" { throw SettingsFault.write }
#endif
        let message = settingsMACMessage(record, file: file, counter: counter, bytes: bytes)
        let mac = settingsBase64(Data(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: settingsDecode(record.key, count: 32)!))))
        // Exact field order is shared with the Node test fixture, not JSON canonicalization of file content.
        let quoted = String(data: try JSONSerialization.data(withJSONObject: file, options: [.fragmentsAllowed, .withoutEscapingSlashes]), encoding: .utf8)!
        let side = Data("{\"version\":1,\"file\":\(quoted),\"counter\":\(counter),\"mac\":\"\(mac)\"}".utf8)
        let sideTemp = temporary + ".seal", sideFD = openat(dir, sideTemp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard sideFD >= 0 else { throw SettingsFault.write }; defer { close(sideFD); unlinkat(dir, sideTemp, 0) }
        try settingsWriteDescriptor(sideFD, bytes: side)
        try unchangedDirectory(dir, (root + "/" + file as NSString).deletingLastPathComponent)
        guard renameat(dir, sideTemp, dir, leaf + ".seal") == 0, fsync(dir) == 0,
            renameat(dir, temporary, dir, leaf) == 0, fsync(dir) == 0 else { throw SettingsFault.write }
    }
    private func erase(_ file: String, record: inout SettingsKeyRecord) throws {
        guard settingsName(file) else { throw SettingsFault.invalid }
        let (dir, leaf) = try parent(file); defer { close(dir) }
        let next = (record.counters[file] ?? 0) + 1
        guard next <= 9007199254740991 else { throw SettingsFault.keyStore }
        record.counters[file] = next; record.present.removeAll { $0 == file }; try keyStore.save(record)
        try unchangedDirectory(dir, (root + "/" + file as NSString).deletingLastPathComponent)
        // An explicit removal removes the name, never a link target. Counters remain as replay tombstones.
        guard (unlinkat(dir, leaf, 0) == 0 || errno == ENOENT), (unlinkat(dir, leaf + ".seal", 0) == 0 || errno == ENOENT), fsync(dir) == 0 else { throw SettingsFault.write }
    }
    private func currentObject(_ file: String, absent: [String: Any]) throws -> [String: Any] {
        let record = try keyStore.load(), row = verify(file, record: record)
        if row.state == "absent" { return absent }
        guard row.state == "trusted", let content = row.content else { throw SettingsFault.untrusted }
        return try settingsJSON(Data(content.utf8))
    }
    func prepareIntent(_ args: [String]) throws -> SettingsChange {
        guard settingsIntentCheck(args), args != ["verify"], !["adopt", "repair"].contains(args[0]) else { throw SettingsFault.invalid }
        let family = args[0], op = args[1], value = args.last!
        let removal = (family == "allow" && op == "remove") || (family == "hand" && op == "off") ||
            (family == "turbo" && (op == "off" || op == "app" && args[2] == "off")) ||
            (family == "permissions" && ["block", "revoke"].contains(op)) || (["routine", "watch"].contains(family) && op == "remove")
        let reason = family == "turbo" ? (op == "app" ? "change sleight turbo for " + value : "change sleight turbo")
            : family == "permissions" ? "change sleight permissions for " + value : "change sleight " + family
        var change = SettingsChange(reason: reason, cardApp: family == "allow" && op == "add" ? args[2] : nil,
            risk: family == "allow" && op == "add" ? args[3] : nil, needsSheet: !removal && family != "allow")
        func put(_ file: String, _ data: [String: Any]) throws {
            let bytes = try JSONSerialization.data(withJSONObject: data, options: [.sortedKeys, .withoutEscapingSlashes])
            try settingsSchema(file, bytes); change.writes.append((file, bytes))
        }
        if family == "allow" {
            var data = try currentObject("preapproved.json", absent: ["version": 1, "apps": [[String: Any]]()])
            var apps = data["apps"] as! [[String: Any]], app = args[2]
            apps.removeAll { $0["app"] as? String == app }
            if op == "add" { apps.append(["app": app, "riskLevel": args[3], "source": "always-allow"]) }
            data["apps"] = apps; try put("preapproved.json", data)
        } else if family == "hand" {
            var data = try currentObject("hand.json", absent: ["version": 1, "enabled": false]); data["enabled"] = false; try put("hand.json", data)
        } else if family == "turbo" && op != "app" {
            var data = try currentObject("turbo.json", absent: ["version": 1, "enabled": false]); data["enabled"] = op == "on"
            // Enabling requires an adopted receipt. A missing receipt cannot be manufactured by an intent.
            try put("turbo.json", data)
        } else if family == "turbo" {
            let id = args[3]
            var data = try currentObject("turbo-apps.json", absent: ["version": 1, "apps": [String: Any]()])
            var apps = data["apps"] as! [String: Any]
            if args[2] == "on" {
                guard var app = apps[id] as? [String: Any] else { throw SettingsFault.untrusted }
                app["enabled"] = true; apps[id] = app
            } else { apps.removeValue(forKey: id) }
            data["apps"] = apps; try put("turbo-apps.json", data)
        } else if family == "permissions" && op == "revoke" {
            var data = try currentObject("preapproved.json", absent: ["version": 1, "apps": [[String: Any]]()])
            data["apps"] = (data["apps"] as! [[String: Any]]).filter { value != "all" && $0["app"] as? String != value }
            try put("preapproved.json", data)
            var grants = try currentObject("electron-grants.json", absent: ["version": 2, "grants": [[String: Any]]()])
            grants["grants"] = (grants["grants"] as! [[String: Any]]).filter { value != "all" && ($0["record"] as? [String: Any])?["bundleId"] as? String != value }
            try put("electron-grants.json", grants)
            if value == "all" { try put("turbo.json", ["version": 1, "enabled": false]); try put("turbo-apps.json", ["version": 1, "apps": [String: Any]()]) }
        } else if family == "permissions" {
            var data = try currentObject("permissions.json", absent: ["version": 1, "apps": [[String: Any]](), "sites": [String]()])
            if op == "sites" {
                if value == "all" { data.removeValue(forKey: "only") }
                else { data["only"] = value.components(separatedBy: ",") }
            } else if op == "block" || op == "unblock" {
                if settingsMatches(value, #"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$"#) {
                    var apps = data["apps"] as! [[String: Any]]; apps.removeAll { $0["id"] as? String == value }
                    if op == "block" { apps.append(["id": value]) }; data["apps"] = apps
                } else {
                    var sites = data["sites"] as! [String]; sites.removeAll { $0 == value }; if op == "block" { sites.append(value) }; data["sites"] = sites
                }
            } else { throw SettingsFault.untrusted } // Repair requires the printed adoption review, never an empty deny list.
            try put("permissions.json", data)
        } else if ["routine", "watch"].contains(family) && ["remove", "unlock"].contains(op) {
            guard settingsMatches(value, "^[a-f0-9]{20}$") else { throw SettingsFault.invalid }
            let prefix = family + "s/" + value + "/"
            change.removals = op == "unlock" ? [prefix + "paused.json"] : try verifyAll().map(\.file).filter { $0.hasPrefix(prefix) }
        } else { throw SettingsFault.invalid } // Install/record inputs require the signed package's schema integration.
        for file in change.writes.map({ $0.0 }) + change.removals {
            let row = verify(file, record: try keyStore.load())
            change.before[file] = row.state == "trusted" ? settingsHash(Data(row.content!.utf8)) : row.state
        }
        return change
    }
    func commitIntent(_ change: SettingsChange, personConfirmed: Bool) throws {
        if let app = change.cardApp, let risk = change.risk {
            // Cards can overlap. Merge the person's choice under the same lock as the persistent counter.
            try allow(app, risk: risk, person: personConfirmed); return
        }
        guard !change.needsSheet && change.cardApp == nil || personConfirmed else { throw SettingsFault.person }
        try locked(preapproved: change.writes.contains(where: { $0.0 == "preapproved.json" }) || change.removals.contains("preapproved.json")) {
            var record = try keyStore.load() ?? SettingsKeyRecord.fresh()
            for (file, expected) in change.before {
                let row = verify(file, record: record), current = row.state == "trusted" ? settingsHash(Data(row.content!.utf8)) : row.state
                guard current == expected else { throw SettingsFault.untrusted }
            }
            for (file, bytes) in change.writes { try publish(file, bytes: bytes, record: &record) }
            for file in change.removals { try erase(file, record: &record) }
        }
    }
    // These internal methods accept authorization only from code executing inside this helper, never from a wire field.
    func removeAllow(_ app: String) throws {
        try locked(preapproved: true) {
            guard var record = try keyStore.load() else { throw SettingsFault.untrusted }
            let verdict = verify("preapproved.json", record: record)
            guard verdict.state == "trusted", let content = verdict.content else { throw SettingsFault.untrusted }
            var list = try settingsJSON(Data(content.utf8)); let apps = list["apps"] as! [[String: Any]]
            list["apps"] = settingsCleanPreapproved(apps).filter { $0["app"] as? String != app }
            try publish("preapproved.json", bytes: JSONSerialization.data(withJSONObject: list, options: [.sortedKeys, .withoutEscapingSlashes]), record: &record)
        }
    }
    private func allow(_ app: String, risk: String, person: Bool) throws {
        guard person else { throw SettingsFault.person }
        try locked(preapproved: true) {
            var record = try keyStore.load() ?? SettingsKeyRecord.fresh()
            let verdict = verify("preapproved.json", record: record)
            guard ["trusted", "absent"].contains(verdict.state) else { throw SettingsFault.untrusted }
            var data: [String: Any] = verdict.content.flatMap { try? settingsJSON(Data($0.utf8)) } ?? ["version": 1, "apps": [[String: Any]]()]
            var apps = settingsCleanPreapproved(data["apps"] as! [[String: Any]]); apps.removeAll { $0["app"] as? String == app }
            apps.append(["app": app, "riskLevel": risk, "source": "always-allow"]); data["apps"] = apps
            try publish("preapproved.json", bytes: JSONSerialization.data(withJSONObject: data, options: [.sortedKeys, .withoutEscapingSlashes]), record: &record)
        }
    }
    func reviewAdoption() throws -> SettingsAdoptionReview {
        let adoptable = ["turbo.json", "turbo-owner.json", "turbo-apps.json", "hand.json", "permissions.json", "settings-link.json", "routine-launcher.mjs"]
        let names = try verifyAll().map(\.file).filter { adoptable.contains($0) || $0.hasPrefix("routines/") || $0.hasPrefix("watches/") }
        var batch: [(String, Data)] = []
        for file in names {
            do { let bytes = try readFile(file, limit: 1048576); try settingsSchema(file, bytes); batch.append((file, bytes)) }
            catch { if !missing(error) { throw error } }
        }
        return SettingsAdoptionReview(files: batch)
    }
    func adoptReviewed(_ review: SettingsAdoptionReview, word: String, confirmed: Bool, repair: Bool = false) throws {
        guard word == "adopt" && confirmed else { throw SettingsFault.person }
        try locked {
            var record = repair ? try SettingsKeyRecord.fresh() : try keyStore.load() ?? SettingsKeyRecord.fresh()
            // Confirm exactly what was printed, then validate the entire batch before advancing any counter.
            for (file, bytes) in review.files { guard try readFile(file, limit: 1048576) == bytes else { throw SettingsFault.untrusted }; try settingsSchema(file, bytes) }
            for (file, bytes) in review.files { try publish(file, bytes: bytes, record: &record) }
        }
    }
#if SLEIGHT_TEST_KEYSTORE
    func testWrite(_ file: String, bytes: Data) throws {
        let parent = (root + "/" + file as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try locked(preapproved: file == "preapproved.json") { var record = try keyStore.load() ?? SettingsKeyRecord.fresh(); try publish(file, bytes: bytes, record: &record) }
    }
    func testBump(_ file: String) throws {
        try locked { guard var record = try keyStore.load(), let n = record.counters[file] else { throw SettingsFault.keyStore }
            record.counters[file] = n + 1; try keyStore.save(record) }
    }
    func testAdopt(word: String, confirmed: Bool) throws { try adoptReviewed(reviewAdoption(), word: word, confirmed: confirmed) }
    func testAlwaysAllow(app: String, physical: Bool) throws {
        try commitIntent(prepareIntent(["allow", "add", app, "high"]), personConfirmed: physical)
    }
#endif
}

struct SettingsIntentForm { let name: String, arguments: Int; init(_ name: String, _ arguments: Int) { self.name = name; self.arguments = arguments } }
// Closed forms, each takes identifiers or options. No form takes serialized file content.
let settingsIntentForms = [SettingsIntentForm("verify", 0), SettingsIntentForm("allow add", 2), SettingsIntentForm("allow remove", 1),
    SettingsIntentForm("turbo on", 0), SettingsIntentForm("turbo off", 0), SettingsIntentForm("turbo app on", 1), SettingsIntentForm("turbo app off", 1),
    SettingsIntentForm("permissions block", 1), SettingsIntentForm("permissions unblock", 1), SettingsIntentForm("permissions sites", 1),
    SettingsIntentForm("permissions revoke", 1), SettingsIntentForm("permissions repair", 0), SettingsIntentForm("hand off", 0),
    SettingsIntentForm("routine add", 1), SettingsIntentForm("routine unlock", 1), SettingsIntentForm("routine remove", 1),
    SettingsIntentForm("watch record", 1), SettingsIntentForm("watch unlock", 1), SettingsIntentForm("watch remove", 1),
    SettingsIntentForm("adopt", 0), SettingsIntentForm("repair", 0)]
func settingsIntentCheck(_ args: [String]) -> Bool {
    for form in settingsIntentForms {
        let prefix = form.name.components(separatedBy: " ")
        if Array(args.prefix(prefix.count)) == prefix && args.count == prefix.count + form.arguments {
            let values = Array(args.dropFirst(prefix.count))
            guard values.allSatisfy({ settingsText($0, limit: 4096) && !$0.contains("{") && !$0.contains("}") && !$0.contains("[") && !$0.contains("]") }) else { return false }
            if form.name == "allow add" { return ["low", "medium", "high"].contains(values[1]) }
            return true
        }
    }; return false
}

// This is the single enforcement switch. It is a build flag, never a setting or environment value.
// Even a build with the flag must prove its signature and entitlement before using the key store.
func settingsEnforcementRequested() -> Bool {
#if SLEIGHT_ENFORCE_SETTINGS
    return true
#else
    return false
#endif
}

func settingsAccountHome() throws -> String {
    guard let row = getpwuid(getuid()), let path = row.pointee.pw_dir else { throw SettingsFault.unsafe }
    return String(cString: path)
}
private final class UnavailableSettingsKeyStore: KeyStore {
    func load() throws -> SettingsKeyRecord? { throw SettingsFault.keyStore }
    func save(_ record: SettingsKeyRecord) throws { throw SettingsFault.keyStore }
}
func settingsVerificationHandshake() -> Bool {
    if fcntl(3, F_GETFD) < 0 { return true } // Direct terminal verification has no parent proof pipe.
    var st = stat()
    guard fstat(3, &st) == 0, [S_IFIFO, S_IFSOCK].contains(st.st_mode & S_IFMT),
        let bytes = try? JSONSerialization.data(withJSONObject: ["settingsReady": 1, "pid": getpid()], options: [.sortedKeys]) else { return false }
    // Only process metadata leaves before the parent proves the running code. No key-store or settings read has occurred.
    FileHandle(fileDescriptor: 3, closeOnDealloc: false).write(bytes + Data([10]))
    return readLine() == "go"
}
func settingsMain(_ args: [String]) -> Int32 {
    guard settingsIntentCheck(args) else { return 64 }
    if args == ["verify"] && !settingsVerificationHandshake() { return 65 }
    do {
        let home = try settingsAccountHome(), root = home + "/Library/Application Support/sleight"
        let keys: KeyStore = (try? KeychainKeyStore()) ?? UnavailableSettingsKeyStore()
        let store = try SealedSettings(root: root, home: home, keyStore: keys)
        if args == ["verify"] {
            let mode = ["settingsEnforcement": settingsEnforcementRequested() && keys is KeychainKeyStore]
            if let bytes = try? JSONSerialization.data(withJSONObject: mode, options: [.sortedKeys]) {
                FileHandle.standardError.write(bytes + Data([10]))
            }
            for verdict in try store.verifyAll() { print(try verdict.line()) }; return 0
        }
        // Preview has no settings mutation surface. Existing commands retain their current writers and authorization.
#if SLEIGHT_SEALED_SETTINGS
        if settingsEnforcementRequested() && keys is KeychainKeyStore { return settingsAuthorizedIntentMain(store, args) }
#endif
        throw SettingsFault.preview
    } catch { FileHandle.standardError.write(Data("\(error)\n".utf8)); return 65 }
}
func settingsMenuSealLine() -> String {
    if !settingsEnforcementRequested() {
        return "Sealed settings: preview, trust unchanged; adoption comes with the signed release."
    }
    do {
        let home = try settingsAccountHome(), keys: KeyStore = (try? KeychainKeyStore()) ?? UnavailableSettingsKeyStore()
        let store = try SealedSettings(root: home + "/Library/Application Support/sleight", home: home, keyStore: keys)
        let problems = try store.verifyAll().filter { !["trusted", "absent"].contains($0.state) }
        let mode = settingsEnforcementRequested() ? "enforced" : "preview, trust unchanged"
        guard let first = problems.first else { return "Sealed settings: \(mode)" }
        return "Sealed settings: \(first.file) \(first.state), \(mode); settings untrusted, review this file in sleight's settings."
    } catch { return "Sealed settings: helper unavailable, settings untrusted" }
}
