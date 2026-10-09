import AppKit
import PDFKit
import CoreText

// PDFKit reads Preview's saved PDFs, including compressed page dictionaries.
// The helper never accesses apps, the engine or the desktop.
do {
    let args = CommandLine.arguments
    let url = URL(fileURLWithPath: args[2])
    if args[1] == "create" {
        let document = PDFDocument()
        for (index, value) in args[3].split(separator: ",").enumerated() {
            // A text PDF page, so both visual labels and saved text survive.
            let data = NSMutableData()
            let consumer = CGDataConsumer(data: data)!
            var bounds = CGRect(x: 0, y: 0, width: 400, height: 500)
            let context = CGContext(consumer: consumer, mediaBox: &bounds, nil)!
            context.beginPDFPage(nil)
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: "Page \(index + 1)", attributes: [.font: NSFont.systemFont(ofSize: 32)]))
            context.textPosition = CGPoint(x: 40, y: 400)
            CTLineDraw(line, context)
            context.endPDFPage()
            context.closePDF()
            let page = PDFDocument(data: data as Data)!.page(at: 0)!
            page.rotation = Int(value)!
            document.insert(page, at: index)
        }
        guard document.write(to: url) else { throw NSError(domain: "PDF write", code: 1) }
        print("{}")
    } else {
        guard let document = PDFDocument(url: url) else { throw NSError(domain: "PDF read", code: 1) }
        let rotations = (0..<document.pageCount).map { document.page(at: $0)!.rotation }
        let texts = (0..<document.pageCount).map { document.page(at: $0)!.string ?? "" }
        let result: [String: Any] = ["rotations": rotations, "texts": texts]
        print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
    }
} catch { fputs("PDF fixture failed\n", stderr); exit(1) }
