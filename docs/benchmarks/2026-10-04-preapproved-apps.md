# Preapproved apps, 2026-10-04

Branch `codex/user-preapproved-apps`, worktree `~/Projects/sleight-wt/user-preapproved-apps`.
Claude Code 2.1.289, Sonnet 5.5, medium effort, engine 26.930.31730. Each launched session used an
empty temporary folder and this branch's MCP server. The driver disabled built-in tools and approval
hooks.
The shared `/tmp/sleight-live.lock` covered each run and was released afterward.

Times are UTC. The Mac's local time was four hours earlier.

| Start | Driver exit | Claude exit | Result |
|---|---|---|---|
| [14:00:45](2026-10-04T14-00-45-525Z-preapproved-unlisted.json) | 130 | 143 | Engine kernel failed before approval. Cancelled through the original terminal handle. |
| [14:00:58](2026-10-04T14-00-58-099Z-preapproved-unlisted.json) | 1 | 0 | Engine exited 71: `sandbox-exec: sandbox_apply: Operation not permitted`. It failed before approval. |
| [14:01:38](2026-10-04T14-01-38-525Z-preapproved-unlisted.json) | 1 | 0 | Host run refused Calculator. The driver incorrectly required decline, but headless Claude returned cancel. |
| [14:06:37](2026-10-04T14-06-37-982Z-preapproved-unlisted.json) | 0 | 0 | Corrected verdict passed. One Calculator approval was cancelled. The tool result reported refusal, and the relay granted nothing. |
| [15:03:12](2026-10-04T15-03-12-682Z-preapproved-listed.json) | 1 | 0 | Calculator displayed 144 with 38 audited grants. The trace shortened the UI tree, hiding the edit field from the verdict. |
| [15:31:26](2026-10-04T15-31-26-314Z-preapproved-listed.json) | 0 | 0 | Calculator displayed 144 with 40 audited grants. The corrected verdict used the full final tool result. |

The third record retains its original failed verdict. Its trace and transcript prove the same refusal
as the fourth. No Calculator button was clicked in these unlisted runs. The first two failures were
sandbox failures, rather than approval refusals. Host access resolved them.

The user wrote `~/Library/Application Support/sleight/preapproved.json` with Calculator listed at
`high` risk and permissions `600`. The agent did not create or edit that approval file. Both listed
runs calculated `12 × 12` and displayed `144`. Both accepted every Calculator app approval. The trace
recorded every grant, and the tool results identified the user's list. Unit tests verify each grant's
stderr audit too. Claude captured the MCP child's stderr internally, so its own stderr was empty.
The first listed run recovered from changed button indices after opening Calculator's sidebar.
Its original failed verdict remains published. The second run passed, and its owned process group
was collected before the driver returned. Each driver released its live lock on exit.

The driver was reviewed and corrected for replies without content, bounded group cancellation,
descendants with redirected output, cancelled headless approvals and stale Calculator snapshots.
Its unit tests cover those failures, shortened traces and history values that differ from the current
edit field. A failing cleanup test left one Node fixture running, which was
stopped with direct operator approval after its terminal handle ended. No helper was restarted.

Final `npm run check` and `npm run lint:prose` exited 0. `bench/run.mjs` was not run. Home paths in the
published JSON records were replaced with `~`.
