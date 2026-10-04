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

The third record retains its original failed verdict. Its trace and transcript prove the same refusal
as the fourth. No Calculator button was clicked in these unlisted runs. The first two failures were
sandbox failures, rather than approval refusals. Host access resolved them.

The listed trial is pending: `~/Library/Application Support/sleight/preapproved.json` did not exist.
The agent asked the user to write it with Calculator listed at `high` risk and permissions `600`.
It did not create or edit that approval file. No acceptance result is claimed.

The driver was reviewed and corrected for replies without content, bounded group cancellation,
descendants with redirected output, cancelled headless approvals and stale Calculator snapshots.
Its unit tests cover those failures. A failing cleanup test left one Node fixture running, which was
stopped with direct operator approval after its terminal handle ended. No helper was restarted.

Required checks are recorded in the branch handoff. `bench/run.mjs` was not run. Home paths in the
published JSON records were replaced with `~`.
