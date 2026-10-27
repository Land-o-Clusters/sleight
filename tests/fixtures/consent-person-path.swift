// Only the OS process-path lookup is controlled. The production classifier and tracking run unchanged.
let fixtureWindowServerPid: Int32 = Int32.max - 1
func fixtureProcPidPath(_ pid: Int32, _ buffer: UnsafeMutableRawPointer!, _ size: UInt32) -> Int32 {
    if pid != fixtureWindowServerPid { return proc_pidpath(pid, buffer, size) }
    let path = "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer"
    let bytes = Array(path.utf8CString)
    guard bytes.count <= Int(size) else { return 0 }
    bytes.withUnsafeBytes { raw in buffer.copyMemory(from: raw.baseAddress!, byteCount: raw.count) }
    return Int32(bytes.count - 1)
}
