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

With `SLEIGHT_RICH_TEXT_MOVE=1`, when the selected text's font, size, color or underline differs from the destination, the first child prepares RTF
without editing. The launcher reserves the same clipboard coordinator as `clipboard.mjs` and
snapshots the readable clipboard items and formats. It stages RTF for a second child, which
rechecks the text, source RTF, process, window and drop plan. It looks directly in Edit and invokes
`AXPress` on the first enabled menu item with Command-V alone, after another text, caret, focus and clipboard check. Insertion
must match in text and attributes before source deletion. The whole text and
moved attributes must match after deletion too. Prepared moves never fall back to pointer input.
Restoration requires the clipboard generation the launcher installed. A newer copy is left alone.
The setting is off pending live qualification. Without it, the existing plain Accessibility
move runs. Missing foreground color compares equal to opaque black.

The launcher supplies a deadline before spawning each 30-second child. The second child refuses
Paste with less than five seconds left, including process startup and preparation. It sets a
one-second AX messaging timeout on the application and Paste item; `-25204` remains an
unconfirmed Paste result rather than waiting for the parent to kill a hung message.

The child writes a synchronous stderr receipt immediately before `AXPress`. Collection without
that receipt permits immediate restoration. A kill between the receipt and action counts as
possibly posted. Collecting a child does not acknowledge a Paste still pending in TextEdit.
Unconfirmed posted Paste retains the original snapshot and clipboard reservation for at most
ten seconds. Recovery can restore sooner after the target process exits. At nine seconds,
final recovery gets 250 ms to read and restore only if both bytes and generation still match
the staged RTF. Helper collection has the remaining 750 ms before reservation release. The
relay reports restored or left contents and discards the snapshot. A Paste still queued in
TextEdit can consume the restored original. Exact clipboard ownership cannot prove consumption.
Shutdown allows three seconds for recovery, then collects the helper and reports contents left.
A restoration failure with a mutation receipt can retry
without another app action. An unreceipted write retains the snapshot and a generation fence.
Recovery ends if the original bytes are already present or a later copy replaces that uncertain
generation, within the same bounded reservation. It cannot safely overwrite the uncertain generation. Forced process death loses the
in-memory snapshot. These recovery paths have unit coverage and need live qualification.

The rich path ignores spelling and paragraph annotations, leaving plain moves on their existing
edits. Bold and italic faces are compared through their font names. If initial RTF preparation
fails, the old plain move remains available after checking the full text and selection again.
A prepared child still refuses changed or unavailable
rich text. Edit-menu localization is unqualified. Unit tests pass. Live qualification remains
pending. The [investigation](../benchmarks/2026-10-09-textedit-fixes.md) includes the original
format-loss reproduction and every stopped attempt.

## TextEdit save lock

After an Accessibility text write, a Shift press and release goes to TextEdit's PID as two
`flagsChanged` events. The earlier comparison measured 0/10 hangs with the pair and 5/8 without
it. The saved bytes matched after ten product moves too. These counts support keeping the
mitigation. The activity responsible for the document's save lock remains unidentified.

The [2026-10-10 investigation](../benchmarks/2026-10-10-save-lock.md) distinguishes candidate
causes from measurements. A Shift pair changes both modifier state and event delivery. It could
finish pending document work or reschedule an autosave monitor, and its delays could matter.
The new probe gives every arm the same delay and compares the pair with a zero-modifier event,
a Shift release alone, Escape and no event. It records saved bytes and dirty state before Cmd+S
to identify runs already autosaved before the shortcut. An autosave racing the shortcut remains possible.
On 2026-10-11 the posted Cmd+S never started a save (idle main thread 14 s later, autosave at about
30 s). Command down and up around S didn't save either (2 live runs, 2026-10-11), so the
experiment needs the engine's Cmd+S. Hang rates after delivery wait on a live run.

The historical Open-panel setup cannot be reproduced under this task's no-dialog rule. The
existing background TextEdit process returned `AXWindows -25204` before any new input, which
does not establish a save-lock hang. Stopped attempts don't add trials to the older denominators.
A fresh instance then restored extra windows. Exact-fixture cleanup also failed on an Accessibility
read. A later read-only check confirmed zero Accessibility windows in that same launch and released
the retained live lock without app input. The comparison must wait until an instance can open only
its owned fixture and the live hold has ended.
