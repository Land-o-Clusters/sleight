import Foundation
import PDFKit

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
          start >= 0, offset >= 0,
          let document = PDFDocument(url: URL(fileURLWithPath: path)) else {
        try reply(["error": "The file is not a readable PDF."]); exit(0)
    }
    guard !document.isLocked else { try reply(["error": "The PDF is locked; unlock a copy first."]); exit(0) }
    guard document.allowsCopying else { try reply(["error": "The PDF does not allow text copying."]); exit(0) }
    guard document.pageCount > 0, document.pageCount <= 10000, start < document.pageCount else {
        try reply(["error": "The PDF page count or cursor is unsupported."]); exit(0)
    }
    var rows = [[String: Any]](), remaining = 40000, next: [String: Int]? = nil
    for index in start..<min(document.pageCount, start + 32) {
        guard let page = document.page(at: index) else { throw NSError(domain: "PDF page", code: 1) }
        // Mask the full page before chunking so a chunk boundary cannot reveal part of a card-like figure.
        var content = page.string ?? ""
        let figures = try NSRegularExpression(pattern: "(?:[0-9][ -]?){12,19}")
        for match in figures.matches(in: content, range: NSRange(location: 0, length: (content as NSString).length)).reversed() {
            let replacement = "[redacted]".padding(toLength: match.range.length, withPad: " ", startingAt: 0)
            content = (content as NSString).replacingCharacters(in: match.range, with: replacement)
        }
        let text = content as NSString
        let begin = index == start ? offset : 0
        guard begin <= text.length else { throw NSError(domain: "PDF cursor", code: 1) }
        var length = min(remaining, text.length - begin)
        // Keep surrogate pairs intact. The JavaScript renderer uses the same UTF-16 offsets.
        if length > 0, begin + length < text.length {
            let last = text.character(at: begin + length - 1)
            if last >= 0xD800 && last <= 0xDBFF { length -= 1 }
        }
        rows.append(["page": index + 1, "offset": begin, "text": text.substring(with: NSRange(location: begin, length: length))])
        remaining -= length
        if begin + length < text.length { next = ["page": index, "offset": begin + length]; break }
        if index + 1 < document.pageCount { next = ["page": index + 1, "offset": 0] } else { next = nil }
        if remaining < 2 { break }
    }
    try reply(["pageCount": document.pageCount, "pages": rows, "next": next as Any? ?? NSNull()])
} catch {
    try? reply(["error": "PDF text extraction failed."])
}
