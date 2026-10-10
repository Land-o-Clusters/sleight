# Desktop replay, 2026-10-09

Branch `codex/replay-desktop`, base `origin/pane/auto-mode` at `11a2893`.
The mod adds `/sleight replay <file>` and `/sleight record [file]`, plus a file field,
Replay file and Record session buttons. Replay calls the session's `computer.replay` tool once,
with its default selector waits. The relay, guards, input lease and approval path are unchanged.
The mod approves only its exact pane snapshot and its own `turn_ended` call.

Each attempted step gets a log entry with its result and wait in milliseconds. These entries
arrive together when the replay tool returns. A failed replay sends its structured result to
Claude so it can inspect the window and continue. Stop interrupts the engine and suppresses
that handoff, including when Stop arrives while the mod is loading the file or connecting.

Recording uses the existing CLI recorder on the current session's saved transcript, since
the live session API can omit earlier calls after compaction. It refuses an existing output
file, an empty recording and truncated recorder output. Paths are relative to the session's
workspace unless absolute. There is no shell interpolation.

The ordinary tool bridge is unchanged, and ordinary computer calls don't read transcripts or files,
poll, or start timers for replay. This is a source inspection claim; no new CPU measurement
was taken. The pure replay helpers load with the mod.

## Runs

All commands below ran in `~/Projects/sleight-wt/replay-desktop`. Failed development attempts
are included. No live app run started: the shared live lock was occupied at the live preflight.
The hold file was absent at the check preflights. No permission prompt or app dialog was answered.

| Run | Command | Result | Exit |
|---|---|---|---:|
| 1 | `npm run test:mod` | Baseline: 11 passed. | 0 |
| 2 | `npm run test:mod` | New test did not load: invalid TypeScript cast syntax. | 1 |
| 3 | `npm run test:mod` | Red tests: 11 passed, 5 failed for missing features. | 1 |
| 4 | `npm run test:mod` | 16 failed: host context passed to an imported helper. | 1 |
| 5 | `npm run test:mod` | 7 passed, 9 failed: missing Input submit handler and wrong file-write fixture. | 1 |
| 6 | `npm run test:mod` | 15 passed, 1 failed: fixture expected a relative path instead of the host's absolute path. | 1 |
| 7 | `npm run test:mod` | 16 passed after the fixture correction. | 0 |
| 8 | `node --test tests/replay.test.mjs` | 10 passed, 21 failed: a recorder extraction omitted a tool constant. | 1 |
| 9 | `node --test tests/replay.test.mjs` | 31 passed after restoring the constant. The extraction was later removed. | 0 |
| 10 | `npm run test:mod` | New Stop tests did not load: invalid cast syntax. | 1 |
| 11 | `npm run test:mod` | 18 passed. | 0 |
| 12 | `npm run test:mod` | 18 passed, 1 failed because Stop during file loading still allowed replay to start. | 1 |
| 13 | `npm run test:mod` | 19 passed after adding the cancellation latch. | 0 |
| 14 | `npm run test:mod` | 20 passed with saved-transcript recording and truncated-output refusal. | 0 |
| 15 | `npm run test:mod` | 20 passed, 1 failed because the Refresh fixture expected different snapshot code. Fixture corrected. | 1 |
| 16 | `npm run lint:prose` | Vale style pack absent in the new worktree. | 2 |
| 17 | `vale sync` | Unable to initialize StylesPath in the sandbox. | 2 |
| 18 | `npm run check` | Sandbox denied local sockets and worktree build output. | 1 |
| 19 | `vale sync` | Pinned style pack installed with scoped host access. | 0 |
| 20 | `npm run check` | Host access: 1,036 passed, 1 failed in the existing clipboard-lock test. | 1 |
| 21 | `npm run lint:prose` | 14 wording flags in changed prose. | 1 |
| 22 | `node --test tests/clipboard-lock.test.mjs` | Isolated reproduction: 1 passed, 1 failed. | 1 |
| 23 | `node --test tests/clipboard-lock.test.mjs` | Host access: 2 passed. | 0 |
| 24 | `npm run lint:prose` | 2 wording flags remained in the report. | 1 |
| 25 | `npm run check` | Host access: 1,037 unit tests and 21 mod tests passed. Both manifests validated. | 0 |
| 26, 27 | `npm run lint:prose` | Final prose checks: 61 files, zero errors or warnings. | 0 |

The clipboard-lock failure did not reproduce in the isolated host run or the final full run.
Its code was left unchanged. The required final commands were bare, each with exit code 0.

The review found and corrected the file-loading Stop race, compacted recording history,
and the missing Refresh target after a successful replay. The final review cleared the change.
Engine and relay code are unchanged from the base.

## Manual desktop check

The owner checks the native pane. This branch has not been released or installed in the owner's
desktop session. After publishing the feature, the release owner runs
`claude plugin marketplace update sleight` and `claude plugin update sleight@sleight`.
Confirm the installed `gitCommitSha` matches that release, then use a fresh Claude desktop Code session.

1. Ask Claude to complete a small Calculator task through sleight, keeping Calculator in the
   background. The owner alone answers any approval request.
2. Enter `/sleight record task.json`. Confirm the message lists the recorded steps and file.
   Repeat it once and confirm the existing file is refused.
3. Enter `/sleight`. In the pane, set Replay JSON file to `task.json` and click Replay file.
   The command equivalent is `/sleight replay task.json`.
4. Check that the Actions log shows each attempted step's result and wait when the call returns.
   Click Refresh to view Calculator after a successful replay that acquired it by literal name.
5. Replay again and click Stop while it runs. Confirm no later step or automatic Claude handoff
   follows the stop. Start a new user request only when ready to resume.
6. For a script whose selector no longer exists, replay it and confirm the failed step and wait
   appear, then Claude receives the stop details and checks the window before continuing.
7. Choose a new filename and click Record session. Confirm it records the current session and
   updates the file field.

## Limits

Native desktop layout, real approval prompts and live interruption are unmeasured here.
The harness exercises command routing, pane buttons, replay results, cancellation races,
approval ownership and stop handoff. It does not prove native desktop behavior.
The replay tool returns one result, so step logs do not stream while it runs.
The host caps recorder stdout at 4 MiB. Larger sessions need the CLI's output filename form.
Refresh gets the replay target from a literal `getApp` name in a recorded step. Scripts that
acquire only an object or window ID may not establish a new target for Refresh.
