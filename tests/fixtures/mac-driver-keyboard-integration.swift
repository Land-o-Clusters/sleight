if CommandLine.arguments.dropFirst() == ["--dump-layout"] {
    let layout = try DriverKeyboard.systemLayout(), source = CGEventSource(stateID: .privateState)!
    let specs = [DriverKeyboardEvent(type: "flagsChanged", keyCode: 55, flags: 0x100000),
        DriverKeyboardEvent(type: "keyDown", keyCode: 1, flags: 0x100000),
        DriverKeyboardEvent(type: "keyUp", keyCode: 0, flags: 0, unicode: "🪄")]
    var events = [DriverObject]()
    for spec in specs {
        let event = try DriverKeyboard.systemCGEvent(spec, source: source)
        var length = 0, units = [UniChar](repeating: 0, count: 32)
        event.keyboardGetUnicodeString(maxStringLength: 32, actualStringLength: &length, unicodeString: &units)
        events.append(["type": event.type.rawValue, "keyCode": event.getIntegerValueField(.keyboardEventKeycode),
            "flags": event.flags.rawValue, "keyboardType": event.getIntegerValueField(.keyboardEventKeyboardType),
            "sourceState": event.getIntegerValueField(.eventSourceStateID),
            "unicode": String(utf16CodeUnits: units, count: length)])
    }
    var belief = [DriverObject]()
    for active in [true, false] {
        let event = try DriverFocusProviders.activationEvent(active, source: source), back = NSEvent(cgEvent: event)!
        belief.append(["type": event.type.rawValue, "subtype": back.subtype.rawValue,
                       "sourceState": event.getIntegerValueField(.eventSourceStateID)])
    }
    let group = DispatchGroup()
    var backgroundCount = -1
    group.enter()
    DispatchQueue(label: "sleight.layout-fixture").async {
        backgroundCount = (try? DriverKeyboard.systemLayout().count) ?? -1
        group.leave()
    }
    guard group.wait(timeout: .now() + 5) == .success else { exit(2) }
    let result: DriverObject = ["layoutCount": layout.count, "backgroundLayoutCount": backgroundCount,
        "sCode": layout["s"].map { $0.keyCode as Any } ?? NSNull(), "sourceState": source.sourceStateID.rawValue,
        "keyboardType": Int(LMGetKbdType()), "events": events, "belief": belief]
    print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
    exit(0)
}
var fixture = try! DriverJSON.decode(Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let fixtureWindows = NSMutableArray(array: fixture["windows"] as? [DriverObject] ?? [])
fixture["windows"] = fixtureWindows
let control = fixture["control"] as? DriverObject ?? [:]
let core = DriverCore(fixture: fixture), runtime = DriverRuntime(core: core, nonce: String(repeating: "a", count: 64))
var active = false
var menuPhase = false
var menuOwnerChanged = false
var front: Int32 = 1
var keyDownSeen = false
var time = 0.0
var posted = 0
var intervals = 0
var menuReads = 0
var betweenChunks = false
var secureBetween = false
let focus = DriverFocusBelief(providers: DriverFocusProviders(
    secureInput: { control["secure"] as? Bool == true || secureBetween },
    heldModifiers: { betweenChunks && control["betweenChunkModifier"] as? Bool == true ? 0x100000 : UInt64(control["held"] as? Int ?? 0) },
    snapshot: { _ in
        if let after = driverInteger(control["focusTimeoutAfterPosts"]), posted >= after {
            throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=snapshot-timeout")
        }
        return DriverFocusSnapshot(pid: menuOwnerChanged || menuPhase && control["focusAtMenu"] as? Bool == true ? 9 : front,
        processStart: "owner", window: (betweenChunks && control["betweenChunkSnapshot"] as? Bool == true ? "changed-window" : "owner-window") as CFString) },
    belief: { _, _ in
        if active && control["beliefThrows"] as? Bool == true { throw DriverFault("AX_UNAVAILABLE") }
        return active && control["beliefTimeout"] as? Bool != true
    }, makeEvent: { state in { _ in
        fputs(state ? "belief:activate\n" : "belief:deactivate\n", stderr)
        active = state
        if state { intervals += 1 }
        if !state && control["focusDuringRestore"] as? Bool == true { front = 42 }
    } },
    now: { time }, pause: { time += $0 }, restore: { previous, _, _ in
        fputs("focus:restore\n", stderr)
        front = previous.pid; return true
    }, frontmost: { DriverFocusSnapshot(pid: front, processStart: "owner", window: nil) },
    personInputSince: { _ in control["personInput"] as? Bool == true || betweenChunks && control["betweenChunkPersonInput"] as? Bool == true }))
let keyboard = DriverKeyboard(layout: { ["s": DriverKeyboardMapping(keyCode: driverInteger(control["sCode"]) ?? 1, modifiers: []),
    "z": DriverKeyboardMapping(keyCode: 6, modifiers: []), "Z": DriverKeyboardMapping(keyCode: 6, modifiers: ["shift"]),
    "g": DriverKeyboardMapping(keyCode: 5, modifiers: []),
    "v": DriverKeyboardMapping(keyCode: 9, modifiers: []),
    "d": DriverKeyboardMapping(keyCode: 2, modifiers: []),
    "k": DriverKeyboardMapping(keyCode: 40, modifiers: []),
    "q": DriverKeyboardMapping(keyCode: 12, modifiers: []), "Q": DriverKeyboardMapping(keyCode: 12, modifiers: ["shift"])] },
    makeEvent: { spec in { _ in
        posted += 1
        if spec.type == "keyDown" { keyDownSeen = true }
        fputs("key:\(spec.type):\(spec.keyCode)\n", stderr)
        if posted == driverInteger(control["stallPost"]) { time += 0.401 }
    } },
    pause: { time += (control["paceMs"] as? Double ?? 0) / 1000 }, focus: focus, menuItems: { _, _, _ in
        menuReads += 1
        let phase = control["menuReadPhase"] as? String ?? "after"
        if let failure = control["menuReadFailure"] as? String, (phase == "before" ? menuReads == 1 : menuReads > 1) { throw DriverFault(failure) }
        let values = (menuReads > 1 ? control["menusAfter"] : nil) as? [DriverObject] ?? control["menus"] as? [DriverObject] ?? []
        return values.map { value in
            var attributes: DriverObject = [:]
            for (name, attribute) in [("character", kAXMenuItemCmdCharAttribute), ("virtualKey", kAXMenuItemCmdVirtualKeyAttribute),
                ("modifiers", kAXMenuItemCmdModifiersAttribute), ("glyph", kAXMenuItemCmdGlyphAttribute),
                ("title", kAXTitleAttribute), ("mark", kAXMenuItemMarkCharAttribute)] { attributes[attribute] = value[name] }
            return DriverKeyboardMenuItem(attributes: attributes, enabled: value["enabled"] ?? true,
                press: { _, beforePress in
                    if let failure = control["metadataReadFailure"] as? String { throw DriverFault(failure) }
                    if control["focusDuringMetadata"] as? Bool == true { menuOwnerChanged = true }
                    try beforePress()
                    if control["menuActivates"] as? Bool == true { front = 42 }
                    fputs("menu:press\n", stderr)
                    if control["pressIdentity"] as? Bool == true { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-id") }
                    if control["pressThrows"] as? Bool == true { throw DriverFault("ACTION_UNCONFIRMED") }
                })
        }
    }, beforeInput: { _, _ in
        if intervals > 0 && !active {
            betweenChunks = true
            if control["betweenChunkIdentity"] as? Bool == true, var window = fixtureWindows[0] as? DriverObject {
                window["pid"] = 99; fixtureWindows[0] = window
            }
            secureBetween = control["betweenChunkPreflight"] as? Bool == true
            if let failure = control["betweenChunkFailure"] as? String { throw DriverFault(failure) }
        }
        if keyDownSeen && control["takeoverAfterKeyDown"] as? Bool == true { throw DriverFault("PERSON_TOOK_OVER") }
        if menuPhase && control["takeoverAtMenu"] as? Bool == true { throw DriverFault("PERSON_TOOK_OVER") }
    })
keyboard.register(in: runtime, fault: {
    var error = DriverFault($0.code, unhealthy: $0.unhealthy); error.disposition = $0.json; return error
})
runtime.register(method: "getAXState") { request, core in
    let result = try core.readTree(request.params, request: request)
    if var map = core.maps["7"] {
        if control["changedTree"] as? Bool == true { map.text = "different pre-chord tree" }
        if control["partialTree"] as? Bool == true { map.truncated = true }
        core.maps["7"] = map
    }
    return result
}
runtime.register(method: "settle") { _, _ in
    menuPhase = true
    var result: DriverObject = ["settled": control["settled"] as? Bool ?? true, "reason": control["reason"] as? String ?? "quiet"]
    for key in ["personTookOver", "focusChanged"] {
        if let value = control[key] as? Bool { result[key] = value }
    }
    return result
}
runtime.serve()
