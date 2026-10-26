// Appended only to the temporary instrumented consent host by consent-guard-probe.mjs.
// The fake request is never delivered to an Electron consent broker or a grant store.
var probeStep = "setup"
var probeStopped = false
var probeAlert: NSAlert?
let app = NSApplication.shared
let probeHost = ConsentHost()
func probeReceipt(_ outcome: String, _ fields: [String: Any] = [:]) {
    var record = fields
    record["outcome"] = outcome; record["step"] = probeStep
    if let event = NSApp.currentEvent?.cgEvent {
        record["receivedEvent"] = ["type": Int(event.type.rawValue),
            "sourceState": event.getIntegerValueField(.eventSourceStateID),
            "sourcePid": event.getIntegerValueField(.eventSourceUnixProcessID),
            "userData": event.getIntegerValueField(.eventSourceUserData)]
    }
    let bytes = try! JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    FileHandle.standardOutput.write(bytes + Data([10]))
}
app.setActivationPolicy(.accessory)
DispatchQueue.global().async {
    while let line = readLine() {
        guard let bytes = line.data(using: .utf8),
            let command = try? JSONSerialization.jsonObject(with: bytes) as? [String: String] else { continue }
        // NSAlert runs a nested modal loop. Schedule into that mode rather than queue behind the modal block.
        RunLoop.main.perform(inModes: [.default, .modalPanel]) {
            if let step = command["step"] {
                probeStep = step; probeReceipt("armed")
            }
            if command["finish"] != nil {
                probeStopped = true; probeHost.modal.close(); probeAlert?.window.orderOut(nil)
                NSApp.stop(nil)
            }
        }
        CFRunLoopWakeUp(CFRunLoopGetMain())
    }
    RunLoop.main.perform(inModes: [.default, .modalPanel]) {
        probeStopped = true; probeHost.modal.close(); probeAlert?.window.orderOut(nil)
        NSApp.stop(nil)
    }
    CFRunLoopWakeUp(CFRunLoopGetMain())
}
DispatchQueue.main.async {
    while !probeStopped {
        let alert = NSAlert()
        probeAlert = alert
        alert.messageText = "sleight consent guard probe"
        alert.informativeText = "Fake request. This test cannot approve an app or save a grant."
        alert.addButton(withTitle: "Always allow")
        alert.addButton(withTitle: "Cancel")
        // personModal adds the word field and removes the protected Return default, as on real cards.
        // The person-return step must type the displayed word before Return.
        let ready = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { timer in
            guard alert.window.isVisible, let screen = NSScreen.screens.first else { return }
            timer.invalidate()
            let button = alert.buttons[0]
            let rect = alert.window.convertToScreen(button.convert(button.bounds, to: nil))
            probeReceipt("ready", ["pid": getpid(), "x": rect.midX, "y": screen.frame.maxY - rect.midY])
        }
        RunLoop.main.add(ready, forMode: .modalPanel)
        let result = probeHost.personModal(alert, choices: ["always", "cancel"], kind: "debugger")
        ready.invalidate()
        if !probeStopped {
            probeReceipt(result == .alertFirstButtonReturn ? "accepted" : "cancelled")
        }
        alert.window.orderOut(nil)
        probeAlert = nil
        // Re-arm the same fake request after an accepted attempt, with only one card visible at any time.
    }
    NSApp.stop(nil)
}
app.run()
probeAlert?.window.orderOut(nil)
