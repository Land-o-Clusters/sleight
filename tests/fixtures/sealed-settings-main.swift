// App-free test harness. Never linked into the consent host.
import Foundation
import Darwin
let args = Array(CommandLine.arguments.dropFirst())
#if SLEIGHT_TEST_KEYSTORE
guard args.count >= 3 else { exit(64) }
let root = args[0], keyFile = args[1], op = args[2]
do {
    let store = try SealedSettings(root: root, home: root, keyStore: FileKeyStore(path: keyFile))
    if op == "denied-key-store" {
        final class DeniedKeyStore: KeyStore {
            func load() throws -> SettingsKeyRecord? { throw SettingsFault.keyStore }
            func save(_ record: SettingsKeyRecord) throws { throw SettingsFault.keyStore }
        }
        let denied = try SealedSettings(root: root, home: root, keyStore: DeniedKeyStore())
        for verdict in try denied.verifyAll() { print(try verdict.line()) }
        do { try denied.testAlwaysAllow(app: "Mail", physical: true); exit(1) } catch { }
    } else if op == "verify" {
        for verdict in try store.verifyAll() { print(try verdict.line()) }
    } else if op == "fixture" {
        guard args.count == 4 else { exit(64) }
        let vector = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[3]))) as! [String: Any]
        let seed = try JSONSerialization.data(withJSONObject: vector["store"]!)
        try FileKeyStore(path: keyFile).save(try JSONDecoder().decode(SettingsKeyRecord.self, from: seed))
        for entry in vector["files"] as! [[String: String]] {
            try store.testWrite(entry["file"]!, bytes: Data(entry["content"]!.utf8))
        }
    } else if op == "selftest-deny-edit" {
        guard args.count == 5, let count = Int(args[4]), [1, 2].contains(count), ["block", "unblock"].contains(args[3]) else { exit(64) }
        let initial = (1...count).map { ["id": "com.fixture.App\($0)"] }
        let sites = ["https://blocked.example"], only = ["https://allowed.example"]
        let data: [String: Any] = ["version": 1, "apps": initial, "sites": sites, "only": only]
        try store.testWrite("permissions.json", bytes: JSONSerialization.data(withJSONObject: data))
        let change = try store.prepareIntent(["permissions", args[3], "com.fixture.App1"])
        try store.commitIntent(change, personConfirmed: true)
        let row = try store.verifyAll().first { $0.file == "permissions.json" }!
        guard row.state == "trusted", let content = row.content else { exit(1) }
        let saved = try settingsJSON(Data(content.utf8))
        let apps = saved["apps"] as! [[String: String]]
        let expected = initial.filter { $0["id"] != "com.fixture.App1" } + (args[3] == "block" ? [["id": "com.fixture.App1"]] : [])
        guard apps == expected, saved["sites"] as? [String] == sites, saved["only"] as? [String] == only else { exit(1) }
        print("deny edit selftest passed")
    } else if op == "selftest-launch-team" {
        func bytes(_ apps: [[String: Any]]) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["version": 1, "apps": apps])
        }
        for team in ["apple", "FIXTURE123"] {
            let apps: [[String: Any]] = [["app": "A", "riskLevel": "high", "launchTeam": team]]
            try settingsSchema("preapproved.json", bytes(apps))
            try store.testWrite("preapproved.json", bytes: bytes(apps))
            let row = try store.verifyAll().first { $0.file == "preapproved.json" }!
            guard row.state == "trusted", let content = row.content,
                  let saved = try settingsJSON(Data(content.utf8))["apps"] as? [[String: Any]],
                  saved.first?["launchTeam"] as? String == team else { exit(1) }
        }
        for team: Any in ["", "adhoc", "lowercase1", "TOO-LONG-TEAM", 42, NSNull()] {
            do { try settingsSchema("preapproved.json", bytes([["app": "A", "riskLevel": "high", "launchTeam": team]])); exit(1) } catch { }
        }
        do { try settingsSchema("preapproved.json", bytes([["app": "A", "riskLevel": "high", "persist": "always"]])); exit(1) } catch { }
        for (risk, otherRisk) in [("high", "low"), ("low", "high")] {
            let bound: [String: Any] = ["app": "A", "riskLevel": risk, "launchTeam": "FIXTURE123"]
            for other: [String: Any] in [bound, ["app": "A", "riskLevel": otherRisk, "launchTeam": "OTHERTEAM1"], ["app": "A", "riskLevel": otherRisk]] {
                let clean = settingsCleanPreapproved([bound, other])
                guard clean.count == 1,
                      (clean[0]["launchTeam"] as? String == "FIXTURE123") == (other["launchTeam"] as? String == "FIXTURE123") else { exit(1) }
            }
        }
        print("launch team selftest passed: 2 sealed round trips, 7 invalid entries, 6 duplicate pairs")
    } else if op == "selftest-duplicates" {
        guard args.count == 4 else { exit(64) }
        let risks = args[3].split(separator: ",").map(String.init)
        var apps = risks.map { ["app": "A", "riskLevel": $0] }
        apps.append(["app": "B", "riskLevel": "medium"])
        func bytes(_ list: [[String: String]]) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["version": 1, "apps": list] as [String: Any])
        }
        try store.testWrite("preapproved.json", bytes: bytes(apps))
        let row = try store.verifyAll().first { $0.file == "preapproved.json" }!
        guard row.state == "trusted", let content = row.content else { exit(1) }
        let raw = try settingsJSON(Data(content.utf8))["apps"] as! [[String: Any]]
        guard raw.count == risks.count + 1 else { exit(1) }
        try store.testAlwaysAllow(app: "C", physical: true)
        let next = try store.verifyAll().first { $0.file == "preapproved.json" }!
        let kept = try settingsJSON(Data(next.content!.utf8))["apps"] as! [[String: Any]]
        guard kept.count == 3, kept.first { $0["app"] as? String == "A" }?["riskLevel"] as? String == "low" else { exit(1) }
        try store.removeAllow("A")
        let removed = try store.verifyAll().first { $0.file == "preapproved.json" }!
        let final = try settingsJSON(Data(removed.content!.utf8))["apps"] as! [[String: Any]]
        guard final.count == 2, !final.contains(where: { $0["app"] as? String == "A" }) else { exit(1) }
        var invalid = apps; invalid.append(["app": "bad", "riskLevel": "critical"])
        do { try settingsSchema("preapproved.json", bytes(invalid)); exit(1) } catch { }
        print("duplicates selftest passed")
    } else if op == "remove" {
        guard args.count == 4 else { exit(64) }; try store.removeAllow(args[3])
    } else if op == "intent" {
        exit(settingsIntentCheck(Array(args.dropFirst(3))) ? 0 : 64)
    } else if op == "apply" {
        guard args.count >= 5 else { exit(64) }
        let change = try store.prepareIntent(Array(args.dropFirst(4)))
        try store.commitIntent(change, personConfirmed: args[3] == "confirmed")
    } else if op == "two-intents" {
        let first = try store.prepareIntent(["allow", "add", "Mail", "high"])
        let second = try store.prepareIntent(["allow", "add", "Calculator", "low"])
        try store.commitIntent(first, personConfirmed: true)
        try store.commitIntent(second, personConfirmed: true)
    } else if op == "adopt" {
        guard args.count == 5 else { exit(64) }
        try store.testAdopt(word: args[3], confirmed: args[4] == "ok")
    } else if op == "click" {
        guard args.count == 5 else { exit(64) }
        try store.testAlwaysAllow(app: args[3], physical: args[4] == "physical")
    } else if op == "bump" {
        guard args.count == 4 else { exit(64) }
        try store.testBump(args[3])
    } else if op == "torn" {
        guard args.count == 4 else { exit(64) }
        store.testFault = "after-counter"
        try store.testWrite(args[3], bytes: Data("{\"version\":1,\"apps\":[]}".utf8))
    } else if op == "menu-line" { print(settingsMenuSealLine())
    } else if op == "home" { print(try settingsAccountHome())
    } else if op == "handshake" { guard settingsVerificationHandshake() else { exit(65) }; print("verified transport")
    } else if op == "oversize" {
        var bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "sleight": NSNull(), "pluginRoot": "/fixture", "sha256": String(repeating: "a", count: 64)] as [String: Any])
        bytes.append(Data(repeating: 32, count: 9000)); try store.testWrite("turbo-owner.json", bytes: bytes)
    } else { exit(64) }
} catch { FileHandle.standardError.write(Data("\(error)\n".utf8)); exit(65) }
#else
if args == ["--production-marker-check"] { print("production"); exit(0) }
exit(64)
#endif
