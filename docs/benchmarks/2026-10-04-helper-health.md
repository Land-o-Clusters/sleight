# Helper health, 2026-10-04

Engine 26.930.31730 on macOS 27.0 (26A428), Node 26.4.0. These are small direct MCP trials, separate
from `bench/run.mjs`. No ChatGPT quit or restart is part of the experiment. The runner holds the
shared live lock and closes only its temporary TextEdit document.

| Attempt | Result | Exit |
|---|---|---|
| [Sandbox smoke](2026-10-04-helper-smoke-sleight-helper-health-kExrMG.json) | The engine could not start its trusted Node sandbox. App actions did not run | 1 |
| [Host smoke](2026-10-04-helper-smoke-sleight-helper-health-f3NkSB.json) | 3/3 Calculator reads and 3/3 doctor inventory probes passed; all owned engines exited 0 | 0 |
| [Kill waiter cancelled](2026-10-04-helper-kill-wait-cancelled.json) | Interrupted before acquiring the lock to fix review findings. No engine or helper signal | 1 |
| [Helper identity attempt](2026-10-04-helper-kill-sleight-helper-health-5aSUGq.json) | First helper-only relaunch passed. The helper exited after readers closed. The next identity check refused to signal. No engine kill | 1 |
| [Descendant snapshot attempt](2026-10-04-helper-kill-sleight-helper-health-itSt61.json) | 3 helper-only relaunches passed. One pending getApp was killed; its descendants exited before inspection, which ended the run before health checks | 1 |
| [Parent getApp trials](2026-10-04-helper-kill-sleight-helper-health-XJJh5h.json) | 3 helper-only relaunches and 3 pending getApp kills passed. Action setup failed in the document proxy before a kill | 1 |
| [Unsupported key attempt](2026-10-04-helper-kill-sleight-helper-health-srxaw3.json) | Native action returned `keyNotFound("right")` before a kill; published as incomplete | 1 |
| [Remaining kill trials](2026-10-04-helper-kill-sleight-helper-health-D5c2FJ.json) | Remaining 15 kills completed, with healthy reads before and after cleanup. Private fixture closed, lock released | 0 |

The first failure said `sandbox-exec: sandbox_apply: Operation not permitted`. It is a host access
failure, not evidence of a helper wedge. The host run used the same script after that denial.

The [design](../design/helper-health.md) describes the recovery detector and the kill protocol.
Live traces include every trial, not a selection of passes. Inventory replies omit unrelated app
titles. The trace retains their success or failure.

Across the completed matrix, 18/18 kills had healthy fresh Calculator reads both before and after
owned-engine cleanup (36/36 reads).

| Target | Pending getApp | Pending Select All action | Idle |
|---|---|---|---|
| Engine parent | 3/3 healthy | 3/3 healthy | 3/3 healthy |
| Whole owned process group | 3/3 healthy | 3/3 healthy | 3/3 healthy |

Pending request IDs and accepted signals appear in the raw receipts. They prove request overlap,
not the exact native instruction interrupted. Helper-only controls passed 3/3 in each of two runs,
plus the first control in the failed identity attempt (7/7 fresh reads after helper relaunch).
Retained readers in the later control batches passed after all six kills.
These controls killed a responding helper. No wedge occurred, so they cannot establish whether killing
only SkyComputerUseService clears the original wedge.

The original 25-minute incident remains unexplained, and this small sample does not rule out a timing
race or a fault specific to the lease benchmark. No ChatGPT restart occurred. Existing launcher and
lease-harness shutdown deadlines remain unchanged because these trials did not establish killing
as the cause. The new doctor collects its own process group with bounded cleanup.

Unit verification before the kill trials: the baseline had 157 passing tests. The first detector
run failed three new assertions (exit 1), then passed all four (exit 0). The doctor test first failed
because the new entry point was missing (exit 1), then passed seven cases (exit 0). An additional
execution-timeout case failed (exit 1), then all eight passed (exit 0). The detector passed 5/5 cases,
including document mode (exit 0). `npm run check` passed 168 unit tests and 8 mod tests (exit 0) before
the two extra cases were added. Prose lint passed with no flags (exit 0). Final checks follow the run.

Review exposed an uncollected doctor descendant and a runner that could not cancel its foreground
child. Their new tests failed (exit 1) before the fixes, then passed (exit 0). The kill protocol's
missing-module run failed (exit 1), followed by two failed behavioral assertions (exit 1). Both pass
after requiring an actual pending-call kill and refusing helper signals after cancellation (exit 0).
The first prose pass on the added docs reported 14 flags (exit 1). The revised docs passed (exit 0).
An idle-kill receipt test failed before the cancellation check was added (exit 1), then all three
protocol tests passed (exit 0). The final checks passed 175 unit tests, both plugin validations and
8 mod tests (`npm run check`, exit 0), and prose lint (`npm run lint:prose`, exit 0).
The first prose pass on the completed results reported 7 flags (exit 1), which were corrected before
the final pass.

## Round 2 recovery review

The branch was rebased onto `origin/main`. The prose-lint conflict keeps all file entries from
both sides. The relay now tracks faults per app and retries a standalone read automatically, at
most once every 20 seconds. Recovery in the same relay clears the fault. Hidden recovery requires
a visible full app read before actions resume, so Claude does not miss UI changes consumed by
the automatic probe. The managed process inspector resolves from the current user's home.
The kill arm is owner-run only because helper signals interrupt all connected sessions.

| Attempt | Result | Exit |
|---|---|---|
| [Sandbox recovery](2026-10-04-helper-recovery-sleight-helper-health-Ab1XPB.json) | The engine sandbox failed with `sandbox_apply: Operation not permitted`. No native app read succeeded | 1 |
| [Host recovery](2026-10-04-helper-recovery-sleight-helper-health-cIKcWh.json) | 3/3 app-isolation and automatic-recovery trials passed. Engines collected, lock released | 0 |

The host run injected two timeout replies after successful native Calculator reads in each trial.
Chess remained readable while Calculator was gated. Automatic Calculator probes succeeded after
20.099, 20.093 and 20.086 seconds, followed by successful visible full reads in the same relays.
This tests recovery orchestration against a responding native engine, not recovery from a real
helper wedge. There were no helper signals or ChatGPT restarts in these runs.

New unit tests first failed seven recovery assertions (exit 1), then passed 63 relay cases (exit 0).
A parallel-reply crash test failed (exit 1), then passed with both success/success and success/error
reply orders (exit 0). Whitespace isolation and full-read requirements each failed before their
fixes (exit 1), then all 68 relay cases passed (exit 0). The inspector home-path test failed before
the path fix (exit 1), then all four protocol tests passed (exit 0). The first revised prose pass
reported one flag (exit 1), which was corrected.
Final checks passed 204 unit tests, both plugin validations and 8 mod tests (`npm run check`, exit 0).
Prose lint passed with no flags (`npm run lint:prose`, exit 0). The initial rebase stopped at the
package conflict (exit 1), and continuation succeeded after preserving both file lists (exit 0).

## Rebase after the background drag merge

The new base is `origin/main` at `562f423`, the status update after `7540224`. Both commits are
ancestors of this branch. Conflict resolution retains the pre-approved list and grant audit,
the `options.once` prompts, change review's later copies and dialog handling, launcher tools
and drag focus capture. `drag.js` matches main, including background drag and foreground fallback.
The prose-lint command contains all 29 files from both sides, and the hover build script remains.
The first replay and its continuation each stopped at a conflict (exit 1); the final continuation
completed (exit 0).

A new test checks the overlap between hidden helper reads and change review. A hidden Calculator
recovery must not capture an uncaptured TextEdit file or replace its cached Cancel button. A visible
TextEdit read still takes the later copy. Removing the automatic-read exclusion made that test fail
at the snapshot assertion (exit 1). Its first fixture also used an alternate handle where the
existing Cancel grammar requires `app`; the focused run and first full check each failed that
assertion (exit 1). After correcting the fixture, the regression test and all 107 focused helper tests
passed (exit 0).

The next full check passed 361/362 tests but failed main's process-cleanup readiness assertion
(exit 1). Its 300 ms timeout elapsed before the child printed `ready`. All four tests in that file
passed in isolation (exit 0). The full check was then repeated without another test or live run
in parallel. The process-cleanup code remains as merged from main.

| Attempt | Result | Exit |
|---|---|---|
| [Merged sandbox smoke](2026-10-04-helper-smoke-sleight-helper-health-9FTZ7q.json) | Engine startup failed with `sandbox_apply: Operation not permitted`. The owned engine exited 0 and the lock was released | 1 |
| [Merged host smoke](2026-10-04-helper-smoke-sleight-helper-health-ExDq7Z.json) | 3/3 Calculator reads and 3/3 doctor probes passed. All owned engines exited 0 and the lock was released | 0 |

The host smoke used the same locked runner after the sandbox denial. No helper signals or ChatGPT
restarts occurred. Both receipts use `~` for home paths.

Final `npm run check` passed all 362 unit tests, both plugin validations and 8 mod tests (exit 0).
The first prose pass on this rebase report found two flags (exit 1). The next pass found one
punctuation flag (exit 1). Those sentences were revised. Final prose lint passed all 29 files
with no flags (`npm run lint:prose`, exit 0).

## Rebase after clipboard, window selection and browser merges

The branch now builds on `origin/main` at `f35565c`. The shared request handler includes clipboard
planning and `clipboard.run`, with replies returning through `observeServerMessage`. The stream
callback and automatic recovery both call that handler. Browser handles and call classification,
window selection clearing and outcome notes, and the completion-time `actionPending` check remain.
The prose-lint script retains the union of 34 files from both sides.

The initial replay and its continuation stopped at conflicts (exit 1). A combined staging request
hit an index-lock sandbox denial (exit 128), and continuation still needed staged resolutions
(exit 1). Staging through a direct Git request succeeded (exit 0), followed by the final continuation
(exit 0). The browser regression test failed after the merge because the native helper gate refused
a browser acquisition (exit 1). Browser calls now bypass that gate, and the test passes (exit 0).
It covers acquisitions, DOM actions and saved tab reads during a native fault and after hidden
recovery. Added integration cases also verify clipboard restoration before publication and selected
window notes after another app's recovery. All 187 integration tests passed (exit 0).

The recovery receipt contained the owner's name in Chess game titles. Those titles and their
repeated AX labels are now `[Chess window]`. The originating feature commit was amended before
replaying the later commit. All 12 helper receipts and all three feature commit snapshots passed
the privacy scan (exit 0). The first history scan exceeded Node's default output buffer and did not
verify the history. A standalone rerun passed with a larger buffer (exit 0).
Future writes use the same scrubber. Its missing-module test
first failed (exit 1), then both privacy cases passed (exit 0), including quoted and escaped titles.
Doctor's native-read fixtures set `SLEIGHT_SURFACES=computer`. Main's browser discovery
tests still cover automatic selection and explicit overrides.

Full `npm run check` passed 463 unit tests, both plugin validations and 8 mod tests (exit 0).
The first prose pass on this section found one flag (exit 1), which was corrected.

| Attempt | Result | Exit |
|---|---|---|
| [Latest sandbox smoke](2026-10-04-helper-smoke-sleight-helper-health-UEbgBn.json) | Engine startup failed with `sandbox_apply: Operation not permitted`. Owned engine collected and lock released | 1 |
| [Latest host smoke](2026-10-04-helper-smoke-sleight-helper-health-EL8ya7.json) | 3/3 Calculator reads and 3/3 doctor probes passed. All owned engines exited 0 and the lock was released | 0 |

Both attempts used the locked runner. The host run followed the sandbox denial. Helper signals and
ChatGPT restarts were absent. The final prose check passed all 34 files with no flags
(`npm run lint:prose`, exit 0).

## Optional doctor app read, 2026-10-09

Worktree `~/Projects/sleight-wt/doctor-flow`, branch `codex/doctor-flow`, base `7644809`.
The first baseline `npm test` exited 1: the sandbox denied local test sockets and the generated
hover fixture directory. The required full check was then run with host access.
The first doctor test run failed all seven new app assertions (exit 1). The next run
stopped at a duplicate variable declaration (exit 1); after correcting it, all 18 doctor tests passed
(exit 0). The stand-in engine checks successful name and bundle-ID selection, missing and ambiguous
apps, declined approval, a missing window header, and a timeout after inventory succeeds.
The first prose check exited 2 because the new worktree lacked Vale's styles. `vale sync` also exited
2 in the sandbox, then succeeded with host access (exit 0).

`/tmp/sleight-hold` prevented live reads, leaving apps, input and dialogs untouched. This run
establishes the doctor's reporting with a stand-in engine. Its native app read remains unmeasured.
The first prose pass after style setup reported five flags (exit 1), which were corrected.
The next prose pass reported one punctuation flag (exit 1). The first host full check passed 993/994
unit tests (exit 1): the hover fixture's compiler exceeded its 60-second deadline under load.
The hover fixture then passed alone (1/1, exit 0). The next bare full check hit several 180-second
compiler deadlines. It was stopped with one Ctrl-C through its original terminal, which returned
exit 1. Host load afterward was 101.27, with normal memory pressure (level 1).

Review found that the initial inventory fixture used `name`, while the recorded engine contract
uses `displayName` and an optional `isRunning`. New regression cases failed before the fix (exit 1).
Doctor now requires `isRunning: true`. All 20 doctor cases passed afterward (exit 0).
Review also found that partial-error and RPC-error text could expose private UI data. Those two
regressions and two site regressions failed together (46/50 passed, exit 1). Error reporting now
uses a fixed class. All 64 combined doctor, flow and browser tests passed (exit 0), including 22
doctor cases. No app tree, title or field value is printed by the new app failure reports.
Rebasing onto `origin/pane/auto-mode` at `8aff828` succeeded (exit 0). Restoring the saved changes
first hit an index-lock sandbox denial (exit 1), then succeeded through direct Git with host access
(exit 0). Dropping that task-owned stash needed host access after a lock denial (1, then 0).
The prose pass after these receipt edits found one wording flag (exit 1), which was removed.
The next bare full check passed all 1,012 unit tests, both plugin validations and 11 mod tests
(`npm run check`, exit 0). That run overlapped high host load: the one-minute load average was 109.64
during the check. The next prose check passed all 59 files with zero flags (`npm run lint:prose`,
exit 0). Review closed the app inventory and private-error findings after the regression fixes.

## Doctor user-list approvals, 2026-10-09

Branch `codex/doctor-preapproved` starts at `origin/pane/auto-mode` commit `11a2893`, in
`~/Projects/sleight-wt/doctor-flow`. The architect's live check after the first merge found that
doctor skipped Calculator despite its entry in the owner's pre-approved list. Doctor had a separate
elicitation handler that declined every request, without loading that list.

Doctor now uses `loadPreapproved` and `createGrantAudit`, the session's existing loader and writer.
The fixed OS-user path, exact app identifiers and risk ceilings remain. A grant applies only to the
selected running app's computer-use approval. It is audited before the accept response, without
engine persistence. Unlisted apps, excessive or unknown risk, unrelated connectors, another app's
request and failed audits are declined without a prompt. Doctor only reads.

The stand-in engine regression run passed 28/30 tests (exit 1), failing both listed-app reads before
the fix. After the fix, all 49 focused doctor, list-loader and audit tests passed (exit 0). The
engine fixture verifies that the private audit file exists before it receives the accept response,
and that the response has no persistence field. Rejected requests don't write a grant record.

The locked runner was `node bench/doctor-app-read.mjs --doctor Calculator`, with `SLEIGHT_SURFACES=computer`
and engine 26.1002.52244. `/tmp/sleight-hold` was absent. Each attempt acquired and released
`/tmp/sleight-live.lock`, without input, dialogs or a ChatGPT restart.

| Attempt | Result | Exit |
| --- | --- | --- |
| [Sandbox](2026-10-09-doctor-preapproved-sleight-doctor-read-S3ApBG.json) | Engine startup failed with `sandbox_apply: Operation not permitted`. Receipt publication also needed host access | 1 |
| [Host](2026-10-09-doctor-preapproved-sleight-doctor-read-G3TZhe.json) | Inventory hit `js execution timed out` before an app acquisition. No grant was requested or written | 1 |

The failed publication's private staged receipt was copied into this report's directory without
changing its contents. The host attempt began at 21:43:31 EDT on 2026-10-09 and lasted 5,481 ms.
Calculator's read time and window header remain unmeasured because inventory failed first.
The timeout does not establish a native cause. The fix has stand-in engine evidence, and its app
read still needs a live result. The review covered the list, app scope, audit and persistence paths.
The first prose check on this follow-up found four flags in the receipt text (exit 1). Those
sentences were revised.
The next prose pass found one wording flag (exit 1), which was removed. The bare full check passed
all 1,045 unit tests, both plugin validations and 11 mod tests (`npm run check`, exit 0).
Prose lint then passed all 60 files with zero flags (`npm run lint:prose`, exit 0). The live runner's
syntax check passed (exit 0), and both raw receipts passed the home-path and private-text scan.
Before push, `origin/pane/auto-mode` advanced to `06f52d8` with the other-hosts merge. The doctor fix
rebased onto it without conflicts (exit 0), retaining the host's approval negotiation and turn
handling. The required checks were repeated on that combined code.
The rebased full check passed all 1,068 unit tests, both plugin validations and 11 mod tests
(`npm run check`, exit 0). The rebased prose check passed all 63 files with zero flags
(`npm run lint:prose`, exit 0).
