import AppKit
import ApplicationServices

// Read-only content channel. Nothing here writes a file, emits an event or adds
// additional structure to DriverElement.label, DriverReadMap.text or CC8.
let driverDocumentLimit = 4000
let driverDocumentTextRoles: Set<String> = ["AXStaticText", "AXHeading", "AXParagraph", "AXCell"]
let driverDocumentRoles: Set<String> = ["AXTextArea", "AXWebArea", "AXLayoutArea", "AXDocument", "AXHTMLContent"]

func driverDocumentRoot(_ role: String, _ subrole: String) -> Bool {
    driverDocumentRoles.contains(role) || subrole == "AXDocument"
}

func driverDocumentPrefix(_ text: String, _ units: Int) -> String {
    var out = String.UnicodeScalarView(), size = 0
    for scalar in text.unicodeScalars {
        let n = scalar.value > 0xffff ? 2 : 1
        if size + n > units { break }
        out.append(scalar); size += n
    }
    return String(out)
}

func driverDocumentQuote(_ text: String) -> String {
    let clean = driverClean(text)
    let data = try! JSONSerialization.data(withJSONObject: [clean], options: [.fragmentsAllowed, .withoutEscapingSlashes])
    return String(String(data: data, encoding: .utf8)!.dropFirst().dropLast())
}

// N counts omitted UTF-16 units. The suffix is inside the 4,000-unit budget.
func driverDocumentCap(_ text: String, omitted: Int = 0, limit: Int = driverDocumentLimit) -> String {
    let total = text.utf16.count + omitted
    if total <= limit { return text }
    var kept = min(text.utf16.count, max(0, limit - 20))
    for _ in 0..<8 {
        let prefix = driverDocumentPrefix(text, kept)
        let suffix = "\n(…\(total - prefix.utf16.count) more)"
        let next = min(text.utf16.count, max(0, limit - suffix.utf16.count))
        if next == kept { return prefix + suffix }
        kept = next
    }
    let prefix = driverDocumentPrefix(text, kept)
    return prefix + "\n(…\(total - prefix.utf16.count) more)"
}

// Keep at most the display prefix while counting omitted source/format units.
// Multiple document panes share one cap and one final omission suffix.
struct DriverDocumentSections {
    private var sections = [(Int, String)]()
    private var total = 0, retained = 0, count = 0
    mutating func append(_ number: Int, _ read: DriverDocumentRead) {
        guard !read.text.isEmpty else { return }
        total += read.text.utf16.count + read.omitted + (count > 0 ? 1 : 0); count += 1
        let separator = sections.isEmpty ? 0 : 1
        let available = max(0, driverDocumentLimit - retained - separator)
        if available > 0 {
            let prefix = driverDocumentPrefix(read.text, available)
            sections.append((number, prefix)); retained += separator + prefix.utf16.count
        }
    }
    func finish() -> [DriverObject] {
        let raw = sections.map { $0.1 }.joined(separator: "\n")
        let capped = driverDocumentCap(raw, omitted: max(0, total - raw.utf16.count))
        let footer = capped.range(of: "\n(…", options: .backwards)
        var remaining = footer.map { String(capped[..<$0.lowerBound]).utf16.count } ?? capped.utf16.count
        var result = [DriverObject]()
        for (number, text) in sections where remaining > 0 {
            if !result.isEmpty { remaining -= 1 }
            let prefix = driverDocumentPrefix(text, max(0, remaining))
            result.append(["element": number, "text": prefix]); remaining -= prefix.utf16.count
        }
        if let footer = footer, !result.isEmpty {
            result[result.count - 1]["text"] = (result.last?["text"] as? String ?? "") + String(capped[footer.lowerBound...])
        }
        return result
    }
}

extension DriverNode {
    func documentRange(_ value: Any?) -> NSRange? {
        if let o = value as? DriverObject, let start = driverInteger(o["location"]), let length = driverInteger(o["length"]),
           start >= 0, length >= 0, start <= Int.max - length { return NSRange(location: start, length: length) }
        guard let value = value, CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetType(value as! AXValue) == .cfRange, AXValueGetValue(value as! AXValue, .cfRange, &range),
              range.location >= 0, range.length >= 0, range.location <= Int.max - range.length else { return nil }
        return NSRange(location: range.location, length: range.length)
    }

    func documentAttributed(_ range: NSRange, request: DriverRequest) throws -> NSAttributedString? {
        try timeout(request)
        if let fake = fake {
            _ = try attributes(["AXAttributedStringForRange"], request: request)
            guard let object = fake["attributed"] as? DriverObject, let string = object["string"] as? String else { return nil }
            let source = string as NSString
            guard range.location <= source.length else { return nil }
            let slice = source.substring(with: NSRange(location: range.location, length: min(range.length, source.length - range.location)))
            let result = NSMutableAttributedString(string: slice)
            for run in object["runs"] as? [DriverObject] ?? [] {
                guard let start = driverInteger(run["location"]), let length = driverInteger(run["length"]),
                      start >= 0, length >= 0, start <= Int.max - length,
                      let attrs = run["attributes"] as? DriverObject else { continue }
                let overlap = NSIntersectionRange(NSRange(location: start, length: length), range)
                if overlap.length == 0 { continue }
                for (key, value) in attrs { result.addAttribute(NSAttributedString.Key(key), value: value,
                    range: NSRange(location: overlap.location - range.location, length: overlap.length)) }
            }
            return result
        }
        guard let ax = ax else { return nil }
        var selected = CFRange(location: range.location, length: range.length)
        guard let parameter = AXValueCreate(.cfRange, &selected) else { return nil }
        var result: CFTypeRef?
        let status = AXUIElementCopyParameterizedAttributeValue(ax, kAXAttributedStringForRangeParameterizedAttribute as CFString, parameter, &result)
        if status == .invalidUIElement { throw DriverFault("STALE_ELEMENT") }
        guard status == .success, let value = result, CFGetTypeID(value) == CFAttributedStringGetTypeID() else { return nil }
        let attributed = value as! NSAttributedString
        // A provider must honor the requested range. Oversized replies are not
        // parsed or retained, even if a broken provider returns the whole file.
        guard attributed.length <= range.length else { return nil }
        return attributed
    }
}

struct DriverDocumentRead {
    let text: String
    let readable: Bool
    let protected: Bool
    let omitted: Int
    var needsPixels = false

    static func heading(_ attributes: [NSAttributedString.Key: Any], fallback: Int = 0) -> Int {
        if let level = driverInteger(attributes[NSAttributedString.Key("AXHeadingLevel")]), (1...6).contains(level) { return level }
        if let style = attributes[.paragraphStyle] as? NSParagraphStyle, (1...6).contains(style.headerLevel) { return style.headerLevel }
        // Named styles are used only when the provider explicitly supplies one.
        // Font size and weight alone do not establish a heading.
        if let name = attributes[NSAttributedString.Key("AXParagraphStyle")] as? String,
           let match = name.range(of: "^Heading [1-6]$", options: .regularExpression), match == name.startIndex..<name.endIndex,
           let level = Int(name.suffix(1)) { return level }
        return (1...6).contains(fallback) ? fallback : 0
    }

    static func paragraphs(_ value: NSAttributedString, heading level: Int = 0, offset: Int = 0) -> [String] {
        let string = value.string as NSString
        var result = [String](), at = 0, tables: [ObjectIdentifier: (rows: Int, cols: Int)] = [:]
        while at < string.length {
            let range = string.paragraphRange(for: NSRange(location: at, length: 0))
            let length = (string.substring(with: range).trimmingCharacters(in: .newlines) as NSString).length
            let attrs = value.attributes(at: at, effectiveRange: nil)
            let h = heading(attrs, fallback: level)
            let style = paragraphStyle(attrs)
            // Offsets refer to the provider's UTF-16 string, never the formatted
            // tree. Plain paragraphs add nothing that the tree lacks.
            if h > 0 || !style.isEmpty {
                result.append("para offset \(offset + range.location) length \(length) \(h > 0 ? "H\(h)" : "P")" + (style.isEmpty ? "" : " " + style))
            }
            if let style = attrs[.paragraphStyle] as? NSParagraphStyle {
                for block in style.textBlocks.compactMap({ $0 as? NSTextTableBlock }) {
                    let id = ObjectIdentifier(block.table), old = tables[id] ?? (0, block.table.numberOfColumns)
                    tables[id] = (max(old.rows, block.startingRow + block.rowSpan), max(old.cols, block.startingColumn + block.columnSpan))
                }
            }
            at = NSMaxRange(range)
        }
        for table in tables.values.sorted(by: { $0.rows == $1.rows ? $0.cols < $1.cols : $0.rows < $1.rows }) {
            result.append("table \(table.rows)x\(table.cols)")
        }
        return result
    }

    // Emit only paragraph attributes that we can describe. Merely receiving an
    // attributed string or a default font does not add structure to a plain view.
    static func paragraphStyle(_ attrs: [NSAttributedString.Key: Any]) -> String {
        var parts = [String]()
        if let name = attrs[NSAttributedString.Key("AXParagraphStyle")] as? String, !name.isEmpty {
            parts.append("style " + driverDocumentQuote(name))
        }
        if let style = attrs[.paragraphStyle] as? NSParagraphStyle {
            let alignments: [NSTextAlignment: String] = [.left: "left", .right: "right", .center: "center", .justified: "justified"]
            if let alignment = alignments[style.alignment] { parts.append("align " + alignment) }
            if style.firstLineHeadIndent != 0 || style.headIndent != 0 || style.tailIndent != 0 {
                parts.append("indent \(style.firstLineHeadIndent),\(style.headIndent),\(style.tailIndent)")
            }
            if style.lineSpacing != 0 || style.paragraphSpacing != 0 || style.paragraphSpacingBefore != 0 {
                parts.append("spacing \(style.lineSpacing),\(style.paragraphSpacing),\(style.paragraphSpacingBefore)")
            }
        }
        return parts.joined(separator: " ")
    }

    static func hasStyles(_ value: NSAttributedString, heading level: Int) -> Bool {
        var found = level > 0
        value.enumerateAttributes(in: NSRange(location: 0, length: value.length)) { attrs, _, stop in
            if heading(attrs) > 0 || !paragraphStyle(attrs).isEmpty { found = true }
            if let style = attrs[.paragraphStyle] as? NSParagraphStyle, !style.textBlocks.isEmpty { found = true }
            stop.pointee = ObjCBool(found)
        }
        return found
    }

    static func read(_ root: DriverNode, pid: Int, request: DriverRequest, targets: [DriverSettleNodeKey: Int]) throws -> Self {
        // Prove the whole aggregate's subtree safe before asking for a parent
        // attributed string. A parent can otherwise include a password child.
        var stack = [(root, 0)], nodes = [(DriverNode, String, Bool)](), seen = Set<DriverSettleNodeKey>(), needsPixels = false
        while let (node, depth) = stack.popLast() {
            try request.check()
            // Check ownership before even role reads. A foreign child also makes
            // its parent's aggregate string unsafe to read.
            guard node.pid().map({ $0 == pid_t(pid) }) ?? (node.fake != nil) else {
                return Self(text: "text: structure unavailable", readable: false, protected: true, omitted: 0)
            }
            try node.timeout(request)
            guard depth <= 64, nodes.count < 3000, seen.insert(DriverSettleNodeKey(node: node)).inserted else {
                return Self(text: "text: structure unavailable", readable: false, protected: true, omitted: 0)
            }
            let attrs = try node.attributes([kAXRoleAttribute, kAXSubroleAttribute], request: request)
            guard let role = attrs[kAXRoleAttribute] as? String, !role.isEmpty else {
                return Self(text: "text: structure unavailable", readable: false, protected: true, omitted: 0)
            }
            if role == "AXSecureTextField" || attrs[kAXSubroleAttribute] as? String == "AXSecureTextField" {
                return Self(text: "<redacted>", readable: false, protected: true, omitted: 0)
            }
            let isDocument = driverDocumentRoot(role, attrs[kAXSubroleAttribute] as? String ?? "")
            nodes.append((node, role, isDocument))
            let (children, more) = try node.children(request, limit: 3000 - nodes.count)
            if more { return Self(text: "text: structure unavailable", readable: false, protected: true, omitted: 0) }
            // A frame only proves geometry. Empty div groups are often spacers;
            // only an explicit canvas supplies evidence of a visual region.
            if !isDocument && role == "AXCanvas",
               let frame = try? node.frame(request), frame.width > 0 && frame.height > 0 { needsPixels = true }
            for child in children.reversed() { stack.append((child, depth + 1)) }
        }
        var lines = [String](), priority = [String](), readable = false
        var covered = [DriverNode](), used = 0
        for (node, role, isDocument) in nodes {
            try request.check()
            // Only name elements in this read's canonical tree. These numbers
            // locate metadata; the metadata never enters the retained map.
            guard let number = targets[DriverSettleNodeKey(node: node)] else { continue }
            let target = "element \(number) "
            if role == "AXTable" {
                let attrs = try node.attributes(["AXRows", "AXColumns", "AXRowCount", "AXColumnCount"], request: request)
                let rows = driverInteger(attrs["AXRowCount"]) ?? (attrs["AXRows"] as? [Any])?.count ?? 0
                let cols = driverInteger(attrs["AXColumnCount"]) ?? (attrs["AXColumns"] as? [Any])?.count ?? 0
                if rows > 0 && cols > 0 { lines.append(target + "table \(rows)x\(cols)"); readable = true }
                continue
            }
            guard isDocument || ["AXStaticText", "AXHeading", "AXTextField", "AXComboBox", "AXSearchField", "AXCell", "AXParagraph", "AXLink"].contains(role) else { continue }
            // An aggregate's string already contains its children. Table shapes
            // above still contribute even when their text is in that aggregate.
            if covered.contains(where: { ancestor in
                if node.fake != nil { return node.path.hasPrefix(ancestor.path + "/") }
                return (try? node.belongs(to: ancestor, pid: Int(node.pid() ?? 0), request: request)) == true
            }) { continue }
            let available = max(0, driverDocumentLimit - used)
            if available == 0 { continue }
            let attrs = try node.attributes(["AXNumberOfCharacters", "AXSelectedTextRange", "AXHeadingLevel"], request: request)
            let fakeString = (node.fake?["attributed"] as? DriverObject)?["string"] as? String
            let count = min(1_000_000_000, max(0, driverInteger(attrs["AXNumberOfCharacters"]) ?? fakeString?.utf16.count ?? 0))
            // AX requires a range even when the character count is unsupported.
            // An unsupported range falls back to a bounded plain-value read.
            let selection = node.documentRange(attrs["AXSelectedTextRange"])
            // A long document is sampled around its caret, without reading the
            // preceding text. Absolute offsets stay honest when the paragraph
            // count before this bounded window is unknown.
            let start = selection.map { count > available && $0.location <= count ? max(0, $0.location - min(1000, available / 4)) : 0 } ?? 0
            let requested = min(count > 0 ? count - start : available, available)
            let attributed = requested > 0 ? try node.documentAttributed(NSRange(location: start, length: requested), request: request) : nil
            var string = "", sourceStart = start
            if let value = attributed {
                string = value.string
                let level = driverInteger(attrs["AXHeadingLevel"]) ?? 0
                let formatted = hasStyles(value, heading: level) ? paragraphs(value, heading: level, offset: start) : []
                lines += formatted.map { target + $0 }
                if !formatted.isEmpty && count > value.length {
                    lines.append(target + "styles sampled offset \(start) length \(value.length) of \(count)")
                }
                if !string.isEmpty { covered.append(node) }
            } else if available > 0 {
                let values = try node.attributes([kAXValueAttribute, kAXTitleAttribute], request: request)
                let raw = values[kAXValueAttribute] as? String ?? ((driverDocumentTextRoles.contains(role) || role == "AXLink") ? values[kAXTitleAttribute] as? String : nil) ?? ""
                let ns = raw as NSString
                sourceStart = min(start, ns.length)
                string = driverDocumentPrefix(ns.substring(from: sourceStart), available)
                if let level = driverInteger(attrs["AXHeadingLevel"]), (1...6).contains(level) {
                    lines.append(target + "heading H\(level)")
                }
            }
            used += string.utf16.count; readable = readable || !string.isEmpty
            if string.isEmpty && available > 0 {
                var emptyRegion = false
                if isDocument {
                    let (children, more) = try node.children(request, limit: 1)
                    emptyRegion = children.isEmpty && !more
                }
                if emptyRegion, let frame = try? node.frame(request), frame.width > 0 && frame.height > 0 { needsPixels = true }
            }
            let knownLength = max(count, sourceStart + string.utf16.count)
            if let selection = selection, selection.location <= knownLength {
                priority.append(target + "cursor offset \(selection.location)")
                if selection.length > 0 {
                    let length = min(selection.length, knownLength - selection.location)
                    priority.append(target + "selection offset \(selection.location) length \(length)")
                }
            }
        }
        // The omission suffix counts omitted structure, not page text that this
        // channel no longer repeats. Sections and final indentation share a cap.
        return Self(text: (priority + lines).joined(separator: "\n"), readable: readable, protected: false,
            omitted: 0, needsPixels: needsPixels)
    }
}

extension DriverCore {
    // A read can succeed without a Screen Recording grant. A failed optional
    // capture reports only its closed code; provider messages never carry text.
    func readDocumentTree(_ params: DriverObject, request: DriverRequest, known: DriverBoundWindow? = nil, backend: DriverCaptureBackend? = nil) throws -> DriverObject {
        var result = try readTree(params, request: request, known: known)
        guard let document = result["document"] as? DriverObject, document["needsPixels"] as? Bool == true,
              document["protected"] as? Bool != true, result["truncated"] as? Bool == false else { return result }
        if inventory.fixture != nil && backend == nil { return result }
        let captureParams: DriverObject = ["windowId": params["windowId"]!, "processStart": params["processStart"]!]
        let captureRequest = DriverRequest(copying: request, method: "getScreenshot", params: captureParams)
        do {
            let capture = try DriverCaptureService(backend: backend ?? DriverWindowCaptureBackend()).read(request: captureRequest, combined: false,
                bind: { try self.boundWindow(captureParams, request: captureRequest).window }, tree: { [:] })
            for key in ["capture", "screenshot", "geometry"] { result[key] = capture[key] }
            result["automaticScreenshot"] = true
        } catch let fault as DriverFault where !fault.unhealthy && ["SCREEN_RECORDING_REQUIRED", "CAPTURE_UNAVAILABLE", "CAPTURE_UNSUPPORTED", "CAPTURE_ENCODING_FAILED", "CAPTURE_SIZE_LIMIT"].contains(fault.code) {
            result["capture"] = ["status": "unavailable", "code": fault.code]
        }
        return result
    }
}
