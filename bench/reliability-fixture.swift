import AppKit

let control = URL(fileURLWithPath: CommandLine.arguments[1])
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 320, height: 180),
                      styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Sleight Reliability Fixture"
window.contentView?.addSubview(NSTextField(labelWithString: "Owned responsiveness fixture"))
window.orderFrontRegardless()
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    let files = FileManager.default
    if files.fileExists(atPath: control.appendingPathComponent("hang").path) {
        files.createFile(atPath: control.appendingPathComponent("hung").path, contents: Data())
        while files.fileExists(atPath: control.appendingPathComponent("hang").path) &&
              !files.fileExists(atPath: control.appendingPathComponent("stop").path) {
            Thread.sleep(forTimeInterval: 0.1)
        }
        files.createFile(atPath: control.appendingPathComponent("resumed").path, contents: Data())
    }
    if files.fileExists(atPath: control.appendingPathComponent("stop").path) { app.terminate(nil) }
}
FileManager.default.createFile(atPath: control.appendingPathComponent("ready").path, contents: Data())
app.run()
