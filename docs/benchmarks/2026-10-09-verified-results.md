# Verified results checks

Branch `codex/verified-results`, initially based on `11a2893` from `origin/pane/auto-mode`, then
rebased onto `06f52d8`, then `1e3cf19` (including `05903fa`). Changelog and prose-list conflicts kept all branches' additions.
This branch used unit fixtures only. ChatGPT remained running, and this work didn't answer
permission prompts or app dialogs.

## Attempts

| Check | Result |
|---|---|
| Baseline `npm test` | Exit 1. Sandbox denied Unix socket listeners in existing window-observer tests. Existing process-termination and read-failure timing tests also failed under concurrent compilation. The terminal abbreviated the output. The total failure count was not retained. |
| First `node --test tests/verified-results.test.mjs` | Exit 1, 13/13 failed because `beginAction` was absent. |
| Compactor and new unit tests | Exit 0, 32/32 passed. |
| First relay integration tests | Exit 1, 5/5 failed because summaries were not wired into replies. |
| First six-file affected suite after wiring | Exit 1. Existing window-note tests (6) expected the note to be the last item, or the only item. New integration tests (2) had enabled change review inadvertently, so the fixture expected unchanged code and concurrent forwarding that this mode prevents. |
| New unit and integration tests after fixture fixes | Exit 1, 19/20 passed. The new explicit modified-state test caught missing support for a flag clearing. |
| Six-file affected suite after modified-state support | 246/246 passed, zero failed. |
| First `npm run lint:prose` | Exit 2. The worktree lacked the pinned Vale styles. |
| First `vale sync` | Exit 2. Sandbox prevented initializing the worktree's styles directory. |
| Host `vale sync` after that denial | Exit 0. Pinned styles installed in this worktree. |
| First prose check with styles present | Exit 1, 18 errors. The new prose needed edits. |
| Prose check after edits | Exit 0, zero flags in 62 files. |
| First host `npm run check` | Exit 1, 1055/1057 unit tests passed. `clipboard-lock.test.mjs` failed its process-exit reservation assertion. `hover-fixture.test.mjs` hit its 60-second fixture-build deadline. Plugin validation and mod tests did not run after the unit failure. |
| Added cases after rebase | Exit 1, 15/19 passed. Missing roots, unterminated reads, stale observations and title-only save confirmation needed fixes. |
| Added review cases | Exit 1, 15/21 passed. Unchanged values losing Help and mixed save/navigation targets also needed fixes. |
| Affected suite after the review fixes | Exit 0, 253/253 passed. |
| Isolated clipboard-lock and hover-fixture rerun | Exit 0, 3/3 passed. The cached hover fixture built in about 1.2 seconds. |
| Full check interrupted for a new upstream commit | Exit 1 after one terminal Ctrl-C. Unit runner reported 1072 passed, zero failed and six cancelled. Validation and mod checks did not run. |
| Integrated `npm run check` after the final rebase | Exit 0. All 1123 unit tests passed, both plugin manifests validated, and all 11 mod tests passed. |
| Integrated prose check | Exit 1, two style errors in the design: a semicolon and the verb used for switching windows. Both were edited. |
| Corrected `npm run lint:prose`, repeated twice as the report was updated | All three runs exited 0, zero flags in 67 files. |

Affected files: `verified-results.test.mjs`, `verified-results-relay.test.mjs`,
`compact-reads.test.mjs`, `relay-input-lease.test.mjs`, `relay-clipboard.test.mjs` and `relay.test.mjs`.
Window-note assertions now find the existing note independently of the appended result summary.
The tests still check selection, lease, clipboard, change-review and failure behavior.
An independent review found stale observations, structurally incomplete trees, attribute loss
mistaken for changed state and ambiguous save targets. Each has a failing regression followed
by the passing affected suite. Guard code and `document-scope.mjs` were unchanged by this branch.

## Trace evidence and limits

`tests/fixtures/verified-results.json` keeps excerpts from Calculator click and TextEdit save/edit
traces under `$TMPDIR/sleight-bench/2026-10-09T2*`. Each excerpt identifies its source file and reply
IDs. Home paths are `~`, and the temporary evidence root is `/tmp/sleight-bench`.
The trace writer abbreviates long strings. These excerpts test uncertainty from incomplete reads,
and the complete Save-panel and document headers test window transitions. They cannot prove a
saved file or a value change. Controlled complete trees cover those cases without live claims.

No engine read, screenshot, subprocess, timer or second tree alignment was added. The relay keeps
small action contexts and the compactor records observations during its existing alignment.
CPU and latency effects remain unmeasured. The summary is per call, so it cannot distinguish
individual actions in a batch or prove that a disk write is durable.

Before release, sleight-arch must run the affected Calculator and TextEdit tasks with the new output.
