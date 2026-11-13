// Fake only Core Audio metadata and OS callback delivery. Production owns pipes, worker, monitor and hide.
let testAudio = TestCallAudio()
let testAudioLock = NSLock()
var testListeners: [String: (DispatchQueue, AudioObjectPropertyListenerBlock)] = [:]
var testSource: DispatchSourceFileSystemObject?, testGeneration = 0
func testWakeWrite(_ fd: Int32, _ bytes: UnsafeRawPointer, _ count: Int) -> Int {
    if testState()["failWakeWrite"] as? Bool == true { testRecord("write-failed"); errno = EAGAIN; return -1 }
    return Darwin.write(fd, bytes, count)
}
func testState() -> [String: Any] {
    guard let bytes = try? Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments.last! + "/state.json")),
        let state = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return [:] }
    return state
}
func testRecord(_ value: String) {
    let path = CommandLine.arguments.last! + "/events"
    if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
    let file = try! FileHandle(forWritingTo: URL(fileURLWithPath: path))
    file.seekToEndOfFile(); file.write(Data((value + "\n").utf8)); file.closeFile()
}
func testAdd(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ queue: DispatchQueue,
    _ block: @escaping AudioObjectPropertyListenerBlock) -> OSStatus {
    testAudioLock.lock(); defer { testAudioLock.unlock() }
    if testState()["failAdd"] as? Bool == true { testRecord("add-failed"); return -1 }
    testListeners["\(object):\(selector)"] = (queue, block); testRecord("add")
    if testSource == nil {
        let fd = open(CommandLine.arguments.last!, O_EVTONLY); precondition(fd >= 0)
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write, queue: queue)
        source.setCancelHandler { close(fd) }
        source.setEventHandler {
            let state = testState(), generation = testState()["generation"] as? Int ?? 0
            testAudioLock.lock()
            guard generation > testGeneration else { testAudioLock.unlock(); return }
            testGeneration = generation
            let restart = state["event"] as? String == "restart"
            let selector = restart ? kAudioHardwarePropertyServiceRestarted : kAudioProcessPropertyIsRunningInput
            let object = restart ? AudioObjectID(kAudioObjectSystemObject) : 42
            let callback = testListeners["\(object):\(selector)"]
            if restart { testListeners.removeAll() }
            testAudioLock.unlock()
            if state["event"] as? String == "silent" { return }
            if let (queue, block) = callback {
                queue.async {
                    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                        mElement: kAudioObjectPropertyElementMain)
                    block(1, &address)
                }
            }
        }
        testSource = source; source.resume()
    }
    return noErr
}
func testRemove(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> OSStatus {
    if testState()["hangRemove"] as? Bool == true { sleep(10) }
    testAudioLock.lock(); defer { testAudioLock.unlock() }
    testListeners.removeValue(forKey: "\(object):\(selector)"); return noErr
}
struct TestCallAudio {
    func processes() -> [AudioObjectID]? { testState()["unavailable"] as? Bool == true ? nil : [42] }
    func word(_ object: AudioObjectID, _ selector: UInt32, _ scope: UInt32, _ element: UInt32) -> UInt32? {
        testState()["active"] as? Bool == true ? 1 : 0
    }
}
