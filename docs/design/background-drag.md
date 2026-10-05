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
