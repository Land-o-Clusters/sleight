// Read-only metadata. Never activates an app, sends Apple events or reads window titles.
import AppKit
import CoreGraphics

func emit(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let operation = args.first,
          let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        throw NSError(domain: "LC1_NATIVE_READER_UNAVAILABLE", code: 1)
    }
    if operation == "frontmost", args.count == 1 {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            throw NSError(domain: "LC1_FRONTMOST_UNAVAILABLE", code: 1)
        }
        let defaultMail = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "mailto:fixture@example.invalid")!)
            .flatMap { Bundle(url: $0)?.bundleIdentifier }
        let knownMail: Set<String> = Set([
            "com.apple.mail", "com.microsoft.Outlook", "com.readdle.smartemail-Mac",
            "com.airmailapp.Airmail", "org.mozilla.thunderbird", "com.mimestream.mimestream"
        ] + (defaultMail.map { [$0] } ?? []))
        let mailPids = Set(NSWorkspace.shared.runningApplications.filter {
            knownMail.contains($0.bundleIdentifier ?? "")
        }.map { Int($0.processIdentifier) })
        // A newly created mail window is enough to fail conservatively. No title or content is needed.
        let mailWindows = windows.compactMap { window -> Int? in
            guard let pid = window[kCGWindowOwnerPID as String] as? Int, mailPids.contains(pid),
                  window[kCGWindowLayer as String] as? Int == 0 else { return nil }
            return window[kCGWindowNumber as String] as? Int
        }.sorted()
        try emit(["pid": Int(app.processIdentifier), "isMail": knownMail.contains(app.bundleIdentifier ?? ""), "mailWindows": mailWindows])
    } else if operation == "windows", args.count == 2, let pid = Int(args[1]), pid > 0 {
        let sizes: [[String: Any]] = windows.compactMap { window in
            guard window[kCGWindowOwnerPID as String] as? Int == pid,
                  window[kCGWindowLayer as String] as? Int == 0,
                  let number = window[kCGWindowNumber as String] as? Int,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any] else { return nil }
            return ["window": number, "bounds": bounds]
        }.sorted { ($0["window"] as! Int) < ($1["window"] as! Int) }
        try emit(sizes)
    } else {
        throw NSError(domain: "LC1_NATIVE_ARGUMENTS", code: 1)
    }
} catch {
    // Fixed code only: compiler/runtime failures are caught by the JS adapter and become explicit skips.
    fputs("LC1_NATIVE_READER_UNAVAILABLE\n", stderr)
    exit(1)
}
