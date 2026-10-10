# TextEdit review follow-up

The follow-up addresses the review of `72437b7` and rebases the feature onto private upstream
`3f5c509`. The full project check passes. Live qualification remains incomplete.

The AX comparison now uses font name, font size, foreground/background color and underline.
Bold and italic faces are represented by their font names. Spelling marks and paragraph
annotations do not select the RTF path. Initial RTF preparation failure uses the existing plain
AX edits after checking the full text and selection again. Prepared-child revalidation still
refuses changes before Paste. Unit tests cover both fallback cases, concurrent owner edits and
the spelling-only comparison.

Paste lookup reads Edit directly and stops at its first enabled Command-V item. It does not walk
other menus. The lookup currently requires the English Edit title, so localized menus are unqualified.
The child writes a synchronous stderr receipt immediately before `AXPress`. A collected child
without that receipt restores the clipboard immediately. A child killed between the receipt and
the action conservatively counts as possibly posted. Real-child tests kill before and after the
receipt. A truncated receipt stream remains uncertain.

Shutdown allows three seconds for recovery. It then closes the clipboard helper, with a 250 ms
grace and a further 500 ms before forcing that owned child. If restoration is still unconfirmed,
the relay reports the clipboard as left, releases its reservation after helper collection and
discards the private snapshot on exit. It never restores private bytes beneath a possibly queued
Paste. A test delays a recovery reply past the deadline and confirms it cannot restore later.

Published clipboard hashes were removed from both earlier records that contained them. New
reports retain only whether the clipboard items and formats matched. Source-code hashes remain.
The Save-panel diagnosis depends on Screen Recording permission because macOS otherwise omits
the CG window names. That limitation is recorded in known problems.

| Raw record | Result |
|---|---|
| [Live lock refusal](2026-10-10-textedit-fixes-1791610413771.json) | Another run held the shared lock. No TextEdit operation ran. Load was 187.2, 174.1 and 99.2 over 1, 5 and 15 minutes. |
| [Lock refusal after the hold cleared](2026-10-10-textedit-fixes-1791617484067.json) | The shared lock was still occupied at 07:31 UTC. No app operation ran. Load was 18.8, 28.5 and 34.5. The sandbox denied the repository report write. Its saved temporary record was recovered and published. |

The requested rich move, misspelled plain move and orphan-panel reproduction remain pending the
live lock. The fresh-file `open -g -a TextEdit` retry is prepared for an off-Space failure. It was
not used after either lock refusal. The 1.5 s Paste wait has not yet been qualified at load 10 or more.
Reports exclude clipboard contents and hashes. App dialogs were left unanswered.

The stale-snapshot regression first failed because a concurrent owner edit could be overwritten
after RTF preparation threw. Rechecking the full text and selected range fixed it. The four
focused drag and clipboard suites then passed 55/55, exit 0. Independent review confirmed the
fix and its zero-write refusal for changed text or selection.

Verification attempts:

| Command or check | Result |
|---|---|
| First prose lint | Exit 1, seven wording findings, corrected. |
| Check and lint running at chat interruption | Terminal handles were lost and final statuses were unavailable. No matching commands remained before replacements started. |
| Replacement `npm run check` in the sandbox | Exit 1 after one Ctrl-C and collection. 1,120 passed, 55 failed and one cancelled. Failures included denied loopback/Unix sockets, a denied fixture output, 180-second Swift compilation timeouts and short-deadline helper tests under load. |
| Replacement `npm run lint:prose` | Exit 0, no findings in 73 files, before the final report edits. |
| Host-access probe: `node --test tests/background-drag-native.test.mjs tests/bench-real-web.test.mjs` | Exit 1. All 34 web/socket tests passed. Swift fixture compilation still timed out at 180 seconds. |
| Final serialized `npm run check` with host access | Exit 0. All 1,185 Node tests passed, with no failures, skips or cancellations. Both manifests validated. All 26 mod tests passed. Node tests took 17.9 s. One-minute host load was 19.7 before and 22.2 after. |
| Prose lint after the final report edits | Exit 1, three punctuation findings, corrected. |
| Final `npm run lint:prose` | Exit 0, no errors, warnings or suggestions in 75 files. |

The failed check ran with one-minute load between 102.8 and 182.7. The memory-pressure value was
2. Load later reached 259.6 while other full-suite processes were active. Host access cleared the
socket failures but did not clear the compilation timeout. Validation and plugin tests were not
reached by that failed check. The background-drag and Chess native tests now use the repository's
shared Swift module cache, following an isolated timeout reproduction and successful shared-cache
rerun in the waits-targeting lane. Their assertions and 180-second deadlines are unchanged. This
lane's final full check verified the adopted setup. Its terminal was collected and no process
referencing this worktree remained. The full-check slot then returned to the routines lane.
