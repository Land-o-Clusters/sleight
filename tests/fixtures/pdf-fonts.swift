// Offline CGPDFContext fixture. Core Text embeds the glyph subsets it draws.
import Foundation
import CoreText
import CoreGraphics

let path = CommandLine.arguments[1]
var mediaBox = CGRect(x: 0, y: 0, width: 612, height: 792)
guard let context = CGContext(URL(fileURLWithPath: path) as CFURL, mediaBox: &mediaBox, nil) else {
    fatalError("Cannot create fixture PDF")
}
for (name, text) in [("ArialMT", "Embedded TrueType invoice 731.42"),
                     ("HiraginoSans-W3", "日本語の請求書 合計七百円")] {
    let font = CTFontCreateWithName(name as CFString, 18, nil)
    guard CTFontCopyPostScriptName(font) as String == name else { fatalError("Fixture font unavailable: \(name)") }
    context.beginPDFPage(nil)
    context.textMatrix = .identity
    context.textPosition = CGPoint(x: 40, y: 700)
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text,
        attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
    CTLineDraw(line, context)
    context.endPDFPage()
}
context.closePDF()
