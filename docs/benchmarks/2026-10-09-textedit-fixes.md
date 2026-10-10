# TextEdit formatting and Save panel investigation

The original covered-window move lost a bold font and red color in 1/1 completed RTF trials. It
saved the correct text, `beta gamma alpha`, with plain formatting. The fixture was a new file in
`/private/tmp`. The original drag came from `6e21846`. The foreground fallback was disabled before
activation or pointer input. The sampled front application was unchanged.

An attributed-string write to `AXSelectedText` returned `-25201` (illegal argument) with the text
unchanged. The first probe looked for AppKit font keys in an AX attributed string, so its
`bold: false` fields do not measure the fixture's formatting. The later RTF read does:
`AXRTFForRange` returned `Helvetica-Bold`, 14 pt, and the red color in 1/1 completed support probes.

The fix prepares an RTF insertion when the selection's attributes differ from the destination.
The relay reserves the shared clipboard and snapshots its readable items and formats. It stages
the RTF for another drag child, which rechecks the text, source RTF, process, window and drop
index. Paste uses `AXPress` on one enabled menu item with Command-V alone. The pasted text and
attributes must match before source deletion. After deletion, the
complete text and moved attributes must match too. Plain moves use the existing Accessibility
edits. Clipboard restoration checks the owned generation. It leaves a newer copy alone.

After collection, the child cannot act again, but TextEdit may still have a pending Paste callback.
When consumption is unconfirmed, the relay retains the original clipboard in memory with its
reservation. It attempts restoration after the target process exits. The error instructs the user
to save other work and quit TextEdit before continuing. Graceful shutdown waits for recovery.
Forced process death loses the in-memory snapshot. After an unreceipted clipboard write, recovery
retains the snapshot with a fence on the uncertain generation. Copying later replaces that
generation and ends recovery without overwriting the new contents. The original bytes can also
confirm recovery. These failure cases have unit coverage and need live qualification.

The fixed path has not completed a live move. Setup lost its AX window when the user entered a
full-screen Space. A final read-only probe confirmed `fullScreenSpace: true`, zero AX windows,
zero windows on screen and one window elsewhere. Each opened fixture was closed, with helper
collection and lock release confirmed. Cleanup was restricted to the retained fixture document.
Live work is paused until TextEdit is on the current desktop in the background. Plain-document
live regression also remains pending.

The Save panel reproduction is pending that desktop change too. Unit tests check the observation
of only `Save Panel Accessory View` with zero AX windows. They also check its read note on tool
and JSON-RPC errors, including priority over Space or helper advice. The note describes a
possible orphan with Cancel or Escape as recovery for a visible panel. For a hidden panel or one
that will not close, the user should save other work first. Then quit and reopen TextEdit.
A normal document window, a failed AX read, or another app prevents this diagnosis. Localized
panel titles remain untested.

Every attempt is below. Timestamps inside the JSON are UTC. This work began on October 9 in New York.

| Raw record | Result |
|---|---|
| [Initial refusal](2026-10-09-textedit-fixes-locked.json) | Another run held the lock. The sandbox also refused publication. The private record was recovered with `apply_patch`. App operations did not run. |
| [Attributed write](2026-10-10-textedit-fixes-1791598701904.json) | Rejected with `-25201`, text unchanged. Initial font-key observation was incorrect. |
| [Read timeout](2026-10-10-textedit-fixes-1791598815525.json) | Fixture setup timed out. Exact document cleanup confirmed. |
| [RTF support](2026-10-10-textedit-fixes-1791598891205.json) | Selected RTF retained bold and color. |
| [Geometry refusal](2026-10-10-textedit-fixes-1791599278388.json) | Window matching refused before input. A bounded layout wait was added. |
| [Original format loss](2026-10-10-textedit-fixes-1791599339650.json) | Correct move and save, original bold and red formatting lost. Clipboard bytes unchanged. |
| [Missing AX window](2026-10-10-textedit-fixes-1791599390202.json) | Fixed-path setup refused before input. |
| [AX timeout](2026-10-10-textedit-fixes-1791599441057.json) | `AXWindows` returned `-25204`. Exact document cleanup confirmed. |
| [Readiness refusal](2026-10-10-textedit-fixes-1791599561730.json) | Bounded readiness polling did not find an owned AX window. |
| [Window diagnosis](2026-10-10-textedit-fixes-1791599630540.json) | CG listed the fixture elsewhere. AX did not list its window. |
| [Hidden-app hypothesis](2026-10-10-textedit-fixes-1791599707004.json) | TextEdit was not hidden. Setup refused without unhiding it. |
| [Space confirmation](2026-10-10-textedit-fixes-1791599996811.json) | Read only: the current Space was full screen. TextEdit was elsewhere. |

The initial sandboxed `npm test` exited 1 on artifact and socket permissions, including clipboard
lock, hover fixture and window observer tests. Focused checks then passed 86 drag/clipboard tests,
147 relay/health tests and three formatting-verifier tests. Review added attribute verification
before source deletion, conditional Undo advice, and retention of an unconfirmed clipboard
transaction across graceful shutdown. The benchmark uses a separate collected drag child with
bounded fixture-helper teardown.

A later complete check stopped producing output and was interrupted through its retained terminal.
It exited 1. Its stalled-test cause was not established. The next complete check exited 1 on the
existing clipboard process-exit test. Forced garbage collection reproduced its early lock release:
the fixture did not retain its coordinator. The fixture now retains it through exit, and the test
forces garbage collection before checking contention. Both process-lock tests then passed.
After rebasing onto `3c4a042`, bare `npm run check` exited 0 with 1,165 tests, both plugin
validations and 11 mod tests passing. Bare `npm run lint:prose` exited 0. Release qualification
remains pending.
