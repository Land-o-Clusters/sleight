# Action notes, 2026-10-04

Calculator median turns were equal with notes on and off. TextEdit's comparison is incomplete:
three of its four trials hit the four-minute limit. These runs don't show a turn reduction.

Twelve trials, two repetitions per task and arm, used Sonnet 5.5 at medium effort. Each ran from
an empty private temporary directory with only the sleight relay connected and built-in tools
disabled. The existing benchmark hook approved only allowlisted apps. Arms alternated within each
task, with order reversed for repetition two. The lock covered one trial at a time, including
teardown. `bench/run.mjs` was not run. ChatGPT was not quit or restarted.

| Task | Notes off, turns | Notes on, turns | Off passed | On passed |
|---|---|---|---|---|
| Calculator clicks | 10, 4 (median 7) | 9, 5 (median 7) | 2/2 | 2/2 |
| Calculator menu | 8, 12 (median 10) | 11, 9 (median 10) | 2/2 | 2/2 |
| TextEdit save | 29, timeout | timeout, timeout | 1/2 | 0/2 |

Calculator checks required a successful app action, returned display data and the expected answer.
TextEdit checked the saved file's contents. Passing that check does not verify document closure.
Timeouts have no final Claude `num_turns`, so they have no median. The raw transcript records the
tool calls before interruption. Each timeout's Claude exit code was 143 and its harness exit was 1.
The series exited 1. Completed successful trials and their harnesses exited 0.

The live notes reported changed and unchanged UI, the Save sheet opening and its disappearance.
They also reported unknown for menus, missing baselines and errors. TextEdit's first notes-on trial
made several Save and window-recovery attempts before timeout. Its second, and the second notes-off
trial, timed out during app acquisition. Shared helper activity, app state left by earlier runs and two
repetitions per arm limit the comparison. No further live trials followed those helper timeouts.

After this comparison, a unit test caught a parser gap from the native TextEdit trace: a full window
root can start at element ID 1 after a menu closes. The final parser accepts nonzero root IDs. That
fix passed its unit test but has no separate live turn measurement. The index records the comparison
and final source hashes. Approvals, input guards and engine calls are unchanged by this fix.

The setup attempts before the declared comparison remain published:

| Attempt | Result | Harness exit |
|---|---|---|
| 1 | Engine sandbox denial, cancelled and collected | 1 |
| 2 | Extra installed servers loaded, excluded | 1 |
| 3 | Strict config also disabled the plugin server | 1 |
| 4 | Account servers remained loaded, engine sandbox denial | 1 |
| 5 | Engine sandbox denial, old number-only checker falsely passed | 0 |

Attempt 5's original file retains its false pass. The index's audit marks it failed because it has
no successful action or returned display. The corrected checker has regression tests for that case,
extra servers, failed snapshots, missing actions and cancellation. Setup failures were excluded
before paired outcomes were collected.

[The index](2026-10-04-action-notes-index.json) lists all 17 raw JSON files, judgments, turns, read
counts and notes. Each raw file contains the transcript, trace and approval requests. Home paths
are `~`. Home-folder labels are `[home user]`. Image bytes are omitted. The launcher's trace truncates long strings, while transcript text
tool results are retained. [Series exits](2026-10-04-action-notes-series.jsonl) cover the eleven
trials after the separately collected first baseline.

Run one trial, after reviewing the harness and obtaining host access when needed:

```sh
sh bench/action-notes-live.sh on calculator-click 1 8
```

The last argument gives the attempt a new file name. Use `off` for the control. The other tasks are
`calculator-menu` and `textedit-save`. `node bench/action-notes-report.mjs` rebuilds the index without
driving an app. The default series names are already used by this report.
