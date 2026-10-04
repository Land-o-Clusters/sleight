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

## Round 2

The branch was rebased onto `origin/main` at `27b0528`, preserving both sides' prose check files.
Preapprovals now write grant fields only to a private log per relay process, with a 64 KiB rotation
limit and one prior file. Full relay tracing requires explicit `SLEIGHT_TRACE`. Interactive sessions
still use the list. The user file was left as the user wrote it.

The calculation trials used `--audit-only`, disabling full relay tracing. The driver reads
grant records from the audit and UI evidence from Claude's full tool results. It checks that the
auditing relay process did not create a full trace during the trial.

| Start (UTC) | Driver exit | Claude exit | Result |
|---|---|---|---|
| [20:06:02](2026-10-04T20-06-02-064Z-preapproved-listed-audit-only.json) | 1 | 0 | Sandbox trial failed before app approval: trusted Node kernel exited. Zero grants. |
| [20:08:47](2026-10-04T20-08-47-033Z-preapproved-listed-audit-only.json) | 1 | 0 | Host trial displayed 144 with 17 grants and no full trace. Claude combined the final read with clicks, so the verdict failed its separate-read requirement. |
| [20:15:06](2026-10-04T20-15-06-040Z-preapproved-listed-audit-only.json) | 1 | 0 | Host trial wrote 21 per-process grants without a full trace. Changed button indices produced the wrong calculation. The input lease then stopped a retry after a filtered read lost the full window header. |
| [20:47:52](2026-10-04T20-47-52-206Z-preapproved-listed-audit-read.json) | 0 | 0 | Read-only host trial selected Calculator and completed a separate full read. Grant audit: 2 records. Tool results identified the user's list. Full tracing stayed off. |

The last trial used `--audit-read`, which verifies selection and a full read without clicking or
typing. It proves the default grant logging path, not another calculation result. Its owned process
group was collected before the live lock was released. The audit file had permissions `600`.
The failed calculation records keep their original verdicts. Their remaining UI issues are in the
README's Known problems.

Unit regressions reproduced import-time identity resolution, automatic full tracing, unmerged hover
preapproval and failed audit writes. Review then found that a failed full trace writer also broke
the fallback prompt, and simultaneous shared-file rotation could lose records. Tests reproduced
both, including four concurrent writer processes. The corrected fallback preserves client and
dialog prompts and the `once` setting. Per-process log files avoid the rotation collision.

Round 2 `npm run check` exited 0 (223 unit tests and 8 plugin tests). `npm run lint:prose` exited 0
across 18 files. `bench/run.mjs` was not run.
