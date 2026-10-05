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
