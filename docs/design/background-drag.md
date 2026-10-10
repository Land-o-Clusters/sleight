# Background drag

`drag` posts a held, stepped sequence to the target PID before using the foreground path.
The exact-window resolution, content checks, selected-text snapshot, loss checks and verified
spacing repair remain. TextEdit needs a non-whitespace selection in one text area. Line-end drops
use the final glyph's bounds plus a small right offset. A zero-length range may report bounds above
the line. The fixture and skill use the measured glyph geometry.

The AppKit event has the chosen window number and window-local mouse subtype. TextEdit retains the
measured Command flag. Other apps get an unmodified drag.
`CGEventSetWindowLocation` supplies local coordinates, while the public screen location remains
absolute. JXA needs an explicitly encoded CGPoint and a typed message send to retrieve the CGEvent.
Every event, including the release, is prepared before posting. The private getter confirms the
setter's coordinate round trip. Missing symbols, unusable events or failed setters choose foreground
before any background event. These private APIs can change with macOS.

After posting, unchanged TextEdit text permits foreground fallback. Changed, lost or unreadable
text does not. The original text and selection are checked again before foreground mouse-down.
An unconfirmed release also prohibits fallback. Apps without text snapshots report unverified
delivery and require a readback. An event post alone cannot justify another drag.

Both paths validate the exact window and content geometry. Foreground HID events also
require both endpoints to be exposed. PID events can reach a covered window without raising it.
Background never activates, raises, warps or restores focus. Foreground keeps its existing pointer
and focus cleanup. Unknown child termination retains the launcher's guarded timeout cleanup.
Results name `path` and, when used, `fallbackReason`, including errors. The per-app approval remains
because foreground fallback can still take the pointer. Leases continue to reserve the entire app.

The [product report](../benchmarks/2026-10-04-background-drag-product.md) contains live evidence,
failed attempts and limits. Unit tests cover path choice, lost and unreadable text, spacing repair,
owner edits during settling, release failure, approval refusal and launcher focus handling.

## Rich TextEdit moves through Accessibility

When the selected text's AX attributes differ from the destination, the first child prepares RTF
without editing. The launcher reserves the same clipboard coordinator as `clipboard.mjs` and
snapshots the readable clipboard items and formats. It stages RTF for a second child, which
rechecks the text, source RTF, process, window and drop plan. It invokes `AXPress` on one enabled
menu item with Command-V alone, after another text, caret, focus and clipboard check. Insertion
must match in text and attributes before source deletion. The whole text and
moved attributes must match after deletion too. Prepared moves never fall back to pointer input.
Restoration requires the clipboard generation the launcher installed. A newer copy is left alone.

Collecting a child does not acknowledge a Paste action still pending in TextEdit. Unconfirmed Paste,
including a killed child, retains the original snapshot and clipboard reservation in the relay.
Restoration is deferred until the target process exits. Graceful relay shutdown waits for that
recovery, with its supervisor running. A restoration failure with a mutation receipt can retry
without another app action. An unreceipted write retains the snapshot and a generation fence.
Recovery ends if the original bytes are already present or a later copy replaces that uncertain
generation. It cannot safely overwrite the uncertain generation. Forced process death loses the
in-memory snapshot. These recovery paths have unit coverage and need live qualification.

Plain moves keep their existing edits. The rich path requires readable AX attributes and RTF.
It refuses if preparation fails. Unit tests pass. The fixed-path live check is pending a
desktop change. The [investigation](../benchmarks/2026-10-09-textedit-fixes.md) includes the original
format-loss reproduction and every stopped attempt.
