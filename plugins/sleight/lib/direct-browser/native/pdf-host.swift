import Foundation
import PDFKit
import Darwin

@_silgen_name("sandbox_init")
func sandboxInit(_ profile: UnsafePointer<CChar>, _ flags: UInt64, _ error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32
@_silgen_name("sandbox_free_error")
func sandboxFreeError(_ error: UnsafeMutablePointer<CChar>)

// PDFKit lazily initializes each standard PDF font. Bootstrap only fixed source
// data before confinement, so no caller document gets to run during initialization.
func bootstrapPDFKit() throws {
    let fonts = ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
                 "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
                 "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Symbol", "ZapfDingbats"]
    let kids = fonts.indices.map { "\(3 + $0 * 3) 0 R" }.joined(separator: " ")
    var objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count \(fonts.count) /Kids [\(kids)] >>"]
    for (index, font) in fonts.enumerated() {
        let page = 3 + index * 3, content = "BT /F1 12 Tf 40 740 Td (PDF) Tj ET"
        objects.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 \(page + 1) 0 R >> >> /Contents \(page + 2) 0 R >>")
        objects.append("<< /Type /Font /Subtype /Type1 /BaseFont /\(font) >>")
        objects.append("<< /Length \(content.utf8.count) >>\nstream\n\(content)\nendstream")
    }
    var pdf = "%PDF-1.7\n", offsets = [0]
    for (index, object) in objects.enumerated() {
        offsets.append(pdf.utf8.count); pdf += "\(index + 1) 0 obj\n\(object)\nendobj\n"
    }
    let xref = pdf.utf8.count
    pdf += "xref\n0 \(offsets.count)\n0000000000 65535 f \n"
    for offset in offsets.dropFirst() { pdf += String(format: "%010d 00000 n \n", offset) }
    pdf += "trailer\n<< /Size \(offsets.count) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n"
    guard PDFDocument(data: Data(pdf.utf8))?.string?.contains("PDF") == true else {
        throw NSError(domain: "PDF bootstrap", code: 1)
    }
}

// Install before PDFKit sees any document bytes. Only the staged file is readable;
// no file writes, network, process launches or service lookups are permitted.
func confine(_ path: String) throws {
    guard path.hasPrefix("/"), !path.unicodeScalars.contains(where: { $0.value < 32 }) else {
        throw NSError(domain: "PDF sandbox", code: 1)
    }
    let quoted = path.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    let profile = "(version 1)(deny default)(allow file-read* (literal \"\(quoted)\"))(allow process-info* (target self))"
    var error: UnsafeMutablePointer<CChar>?
    let result = profile.withCString { sandboxInit($0, 0, &error) }
    if let error = error { sandboxFreeError(error) }
    guard result == 0 else { throw NSError(domain: "PDF sandbox", code: 2) }
}

// PDFKit can expand a small input substantially. Sample this process's physical
// footprint independently of parsing, even while PDFKit blocks the main thread.
func watchMemory() {
    Thread.detachNewThread {
        while true {
            var info = task_vm_info_data_t()
            let capacity = MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size
            var count = mach_msg_type_number_t(capacity)
            let result = withUnsafeMutablePointer(to: &info) {
                $0.withMemoryRebound(to: integer_t.self, capacity: capacity) {
                    task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
                }
            }
            if result != KERN_SUCCESS || info.phys_footprint > 1024 * 1024 * 1024 { _exit(70) }
            usleep(50000)
        }
    }
}

// No PDFView, actions, links, scripts, applications, or network operations.
// A private staged file and a UTF-16 cursor arrive as data on stdin.
func reply(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data)
}
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count < 16384,
          let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          let path = request["path"] as? String,
          let start = request["page"] as? Int, let offset = request["offset"] as? Int,
          start >= 0, offset >= 0 else {
        try reply(["error": "The file is not a readable PDF."]); exit(0)
    }
    try bootstrapPDFKit()
    try confine(path)
    watchMemory()
    guard let document = PDFDocument(data: try Data(contentsOf: URL(fileURLWithPath: path))) else {
        try reply(["error": "The file is not a readable PDF."]); exit(0)
    }
    guard !document.isLocked else { try reply(["error": "The PDF is locked; unlock a copy first."]); exit(0) }
    guard document.allowsCopying else { try reply(["error": "The PDF does not allow text copying."]); exit(0) }
    guard document.pageCount > 0, document.pageCount <= 10000, start < document.pageCount else {
        try reply(["error": "The PDF page count or cursor is unsupported."]); exit(0)
    }
    var rows = [[String: Any]](), remaining = 40000, next: [String: Int]? = nil
    let figures = try NSRegularExpression(pattern: "(?:[0-9][ -]?){12,19}")
    for index in start..<min(document.pageCount, start + 32) {
        guard let page = document.page(at: index) else { throw NSError(domain: "PDF page", code: 1) }
        let text = (page.string ?? "") as NSString
        let begin = index == start ? offset : 0
        guard begin <= text.length else { throw NSError(domain: "PDF cursor", code: 1) }
        var length = min(remaining, text.length - begin)
        // Keep surrogate pairs intact. The JavaScript renderer uses the same UTF-16 offsets.
        if length > 0, begin + length < text.length {
            let last = text.character(at: begin + length - 1)
            if last >= 0xD800 && last <= 0xDBFF { length -= 1 }
        }
        // A figure spans at most 38 UTF-16 units. Bounded lookaround protects both
        // slice edges without copying and repeatedly masking the whole page.
        let lower = max(0, begin - 38), upper = min(text.length, begin + length + 38)
        let window = text.substring(with: NSRange(location: lower, length: upper - lower))
        let masked = NSMutableString(string: window)
        for match in figures.matches(in: window, range: NSRange(location: 0, length: masked.length)).reversed() {
            let replacement = "[redacted]".padding(toLength: match.range.length, withPad: " ", startingAt: 0)
            masked.replaceCharacters(in: match.range, with: replacement)
        }
        rows.append(["page": index + 1, "offset": begin, "text": masked.substring(with: NSRange(location: begin - lower, length: length))])
        remaining -= length
        if begin + length < text.length { next = ["page": index, "offset": begin + length]; break }
        if index + 1 < document.pageCount { next = ["page": index + 1, "offset": 0] } else { next = nil }
        if remaining < 2 { break }
    }
    try reply(["pageCount": document.pageCount, "pages": rows, "next": next as Any? ?? NSNull()])
} catch {
    try? reply(["error": "PDF text extraction failed."])
}
