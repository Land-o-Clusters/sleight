# Named-window drag checks, 2026-10-04

Branch: `codex/drag-raise`, worktree: `~/Projects/sleight-wt/text-drag-menu-names`.
The full benchmark was not run. These checks use the production relay and its
benchmark allowlist for Chess. App-driving runs hold `/tmp/sleight-live.lock`.

The main benchmark at `5782453` reported a successful drag while a different
stacked Chess game was in front. The local drag now sets the chosen AX window's
`AXMain` attribute before `AXRaise`. Fresh CG window order must put that exact
window first at both endpoints, counting the app's own windows. A failed raise
refuses before pressing. TextEdit and Chess have stacked-window unit cases.

Drag and hover distinguish windows absent from the current screen from an app
with no windows. The refusal explains that a window on another desktop or Space
(or hidden/minimized) must be brought on screen. This distinction has unit tests;
the checks did not switch the owner's Spaces.

## Attempts and cleanup

| Receipt | Result | Exit |
| --- | --- | --- |
| [Live 1](2026-10-04-drag-raise-live-1.json) | Cancelled while waiting for the lock; no apps driven | 1 |
| [Live 2](2026-10-04-drag-raise-live-2.json) | Sandbox denied Accessibility before opening games | 1 |
| [Live 3](2026-10-04-drag-raise-live-3.json) | Placement failed 3/3 before any drag; target games left open 3/3 | 1 |
| [Cleanup 3](2026-10-04-drag-raise-cleanup-3.json) | AX close accepted, games still open; lock retained | 73 |
| [Cleanup 3b](2026-10-04-drag-raise-cleanup-3b.json) | No sheet found; games still open | 73 |
| [Cleanup 3c](2026-10-04-drag-raise-cleanup-3c.json) | AXMain and AXRaise accepted; games still open | 73 |
| [Cleanup 3d](2026-10-04-drag-raise-cleanup-3d.json) | Guarded Cmd+W added; games still open | 73 |
| [Cleanup 3e](2026-10-04-drag-raise-cleanup-3e.json) | Exact document absence checked; games still open | 73 |
| [Cleanup 3f](2026-10-04-drag-raise-cleanup-3f.json) | Close-button clicks verified against CG order; games still open | 73 |
| [Cleanup 3g](2026-10-04-drag-raise-cleanup-3g.json) | Owner closed games; all six fixture paths verified absent | 0 |

Live 3's raw `closedAllOpenedWindows: true` fields are wrong. Foundation changed
the private temporary directory's `/private/tmp` spelling to `/tmp`, breaking
path validation and snapshot ownership matching. The unchanged receipt records
that failed attempt. Path tests now cover both aliases. Cleanup now asks AX to
close and verify each exact fixture document even when CG cannot map it to a
window. A regression test rejects the former false cleanup claim.

Cleanup 3 through 3f accepted native close commands without closing the games.
The cause is unknown. The owner closed them manually. Cleanup 3g confirms absence.
The later lock-removal command exited 1 because the lock was already absent.

## Verification

The first drag regression run failed 2/21 cases, and the first hover regression
run failed 1/17. Their combined run passed 38/38 after the production changes.
Cleanup's missing-mapping case failed before its fix and passed afterward.
Both full `npm run check` runs passed 302 unit tests, both manifest validations
and 8 mod tests, exit 0. A native fixture test exited 1 when its Swift input changed
during compilation. The subsequent full check passed the alias and close-sequence
tests. Prose lint exited 1 with two flags, then 1 with one flag added in the
verification paragraph. Both cleanup findings were addressed and reviewed.

Rebasing the old drag-polish history first exited 1 on changes already merged
into main. Its final tree matched main's `2e0e607` exactly. After aborting that
rebase, skipping the merged commits exited 0. This branch starts from `2598a1b`.

## Integration with background drag

The next rebase fetched `origin/main` at `562f423`, which includes the requested
`7540224`. It first exited 1 with conflicts in README, package.json and the drag
test harness. Resolving them kept both sets of tests, all README measurements and
the union of prose-lint files. Rebase continuation exited 0.

The merged background path initially bypassed AXMain and AXRaise. The new
regression run passed 31/34 and exited 1. The fix raises the exact chosen window
for both paths. Background PID posting checks its own app's window order at both
endpoints, while foreground HID posting checks every covering app. Background
posting still accepts coverage by another app and avoids HID input. If AXRaise
brings the target app forward, cleanup restores the prior front app while the
target remains frontmost. Tests cover that restoration on success and refusal.

Both paths explain off-Space windows before constructing events. Existing
guards still prevent a second drag after changed, lost or unreadable text, or an
unconfirmed background release. The focused run then passed 71/71, exit 0.

`relay.mjs` and `launch.mjs` match main byte for byte. This preserves the
pre-approved list, grant audit, once-only blocked-app prompts, change-review
snapshots and dialogs, script runner options, hover buffer limits and drag focus
capture. The stacked-Chess trials await a new owner-away window. Chess AX square
coordinates need screenshot verification, as main's product trials found a
vertical reversal. No merged live run or full benchmark ran during this rebase.

The merged regression suite passed 72/72, including the compiled native fixture
test, exit 0. Full `npm run check` first exited 1: 346/347 unit tests passed, and
`a timeout collects a process group even when the child and descendant ignore TERM`
failed with sandbox `kill EPERM`. The unchanged command was retried with host
access. Prose lint first exited 1 with two flags in the added text, then passed
with zero flags across the union of 28 files, exit 0.

The unchanged host `npm run check` passed 347/347 unit tests, both manifest
validations and 8 mod tests, exit 0. Read-only review covered the merged drag
changes. Prose lint exited 1 again on two wording flags in this paragraph.
Native background raising still needs the locked stacked-Chess trials when the
owner is away.


## Stacked games after the rebase

The owner authorized these trials while away. The branch then rebased onto
`eeae770`, which includes `7540224`. The package.json conflict exited 1;
keeping every prose file from both sides and continuing the rebase exited 0.
Main's relay and launch code remain unchanged.

| Receipt | Result | Exit |
| --- | --- | --- |
| [Live 4](2026-10-04-drag-raise-live-4.json) | Sandbox denied Accessibility before opening games | 1 |
| [Live 5](2026-10-04-drag-raise-live-5.json) | Selected game moved e2-e4; covering game unchanged; Chess stopped during cleanup | 73 |
| [Cleanup 5](2026-10-04-drag-raise-cleanup-5.json) | No running Chess process or windows at verification time | 0 |
| [Live 6](2026-10-04-drag-raise-live-6.json) | One setup failure before posting; two posts left both boards unchanged | 1 |
| [Cleanup 6](2026-10-04-drag-raise-cleanup-6.json) | Current fixture paths absent (6/6); first pair from Live 5 had restored | 0 |
| [Cleanup 5b](2026-10-04-drag-raise-cleanup-5b.json) | Sandbox denied Accessibility; lock retained | 73 |
| [Cleanup 5c](2026-10-04-drag-raise-cleanup-5c.json) | Native AX windows unavailable; lock retained | 73 |
| [Cleanup 5d](2026-10-04-drag-raise-cleanup-5d.json) | Exact restored documents absent after verified close-button actions | 0 |
| [Native-button cleanup](2026-10-04-drag-raise-cleanup-5e.json) | Verified file URLs before closing each restored game and both replacement games | n/a |
| [Cleanup 6b](2026-10-04-drag-raise-cleanup-6b.json) | Current paths absent (6/6); replacement game closed | 0 |
| [Cleanup 6c](2026-10-04-drag-raise-cleanup-6c.json) | Final AX inventory contains no fixture windows | 0 |

The first measured board screenshot supplied window-relative e2 `[680, 699]`
and e4 `[677, 548]`, with bounds `[100, 100, 1269, 984]`. Trials reuse points only
when those bounds match exactly. The screenshot pixels remain private; the raw
receipts include their hashes and coordinates. The initial coordinate-provider
regression failed 1/6 before the change, then passed. Tests reject stale
bounds and points outside the frame.

Across three submitted drags, the selected pawn moved once. Every post used the
background path and reported `deliveryVerified: false`. Later posts (2/2)
left both games unchanged despite the same measured endpoints. The cause of
those two no-ops remains unresolved. The tool still requires a fresh read before another drag.
The raise guards and board readback prevent calling those posts verified moves.

The first cleanup stopped seeing a running Chess process. Its two games restored
when Chess relaunched. Cleanup 6's success covers only its own six paths, not the
restored pair. Native cleanup then failed to read AX windows. The engine read
verified each restored file URL before its close button was pressed. Reads after
closing the last game opened replacement Game 1 windows. Both were closed. The final
native read avoided relaunching Chess and did not find any owned AX windows. CG still
listed an old fixture title without an AX document; that record is retained in
the receipt. The live lock was removed afterward, exit 0.

One cleanup wrapper was cancelled while waiting on this task's retained lock,
exit 1, without driving an app. Cleanup then ran under that same retained lock.
The native fixture now handles an absent Chess process and stops using stale
close controls once the exact document disappears. Its new regression failed
before the fix. The merged focused suite passed 61/61, exit 0. The final receipt
also includes the owned AX inventory, without relying on CG title matching.


Final review found two fixture issues: a missing Chess process falsely confirmed
closure, and cancellation during screenshot measurement could still submit a
drag. The native pre-change helper failed the new absence assertion, exit 1.
The cancellation regression failed 1/9, exit 1. Both are fixed; the controller
suite then passed 9/9, exit 0. An absent process now leaves exact-path cleanup
unconfirmed and keeps the lock. Unrelated Chess titles are redacted in snapshots.
The isolated native regression and the combined suite timed out in `swiftc`
after 60 seconds, both exit 1. The combined run passed 62/63 cases.
Prose lint then exited 1 with seven wording flags and passed after edits,
exit 0 across 35 files. Final review confirmed both fixture fixes.

The next native-only retry also timed out, exit 1. Splitting the diagnostic
Swift dictionaries and JSON output into typed expressions let the native test
pass within the unchanged timeout (51.4 seconds), exit 0. A read-only process
status probe for the expired compiler PIDs exited 70 with a diagnostic error;
it did not signal any process. The final full checks follow.


The final full `npm run check` passed 491/491 unit tests, both manifest
validations and 8 mod tests, exit 0. It ran inside the ordinary sandbox.
All named-window, off-Space, screenshot, cleanup and cancellation regressions
ran against the merged code. Live attempts and failures above remain published.

The next prose run flagged the table dash, exit 1. It was replaced with `n/a`.


The separate focused rerun passed 63/63, exit 0. Prose lint passed across
35 files, exit 0. Main then advanced to `b234f55`. Rebasing onto it exited 0.
The full check on that base passed 531/531 unit tests, both manifest validations
and 8 mod tests, exit 0. Prose lint again passed, exit 0. Main's relay and launch
files match exactly, and the prose list retains every file from both branches.

The verification addition had one prose flag, exit 1. It was corrected.
