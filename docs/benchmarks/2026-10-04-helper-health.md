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
