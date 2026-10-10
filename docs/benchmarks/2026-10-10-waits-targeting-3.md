# Waits, window targeting and stop: third follow-up

This corrects private `codex/waits-targeting` at `abbb1f4`. At the start, private
`pane/auto-mode` was `fa079f0`; `codex/verified-results` wasn't its ancestor, so no rebase was
required. There is no merge or public push.

## Changes

`select_window` accepts `windowNumber` with an exact title or file URL. The next native identity
check uses the returned number. Explicit `cua.getApp({ windowId: 11 })` acquisitions
also supply their number. Otherwise, equal-title reads use the app's focused window number.
Where `AXWindowNumber` is absent, a unique match between AX bounds and CG bounds supplies it.
Ambiguous geometry, unavailable helper trust and unknown identity fall back to the existing
engine header and window guards, with one warning per relay session. A readable known number
that disappears, a different focused window, or a changed retained AX reference still stops input.
Selection requires one matching window. Single windows and Save sheets retain their skipped check.

Confirmed stop collects the engine and owned helpers, checks input resources and releases owned
leases, while keeping the MCP connection and session approvals. The next user message permits
the next call to spawn a fresh engine and replay initialization internally. That call must acquire
the app again. Esc retains the current engine. New engines get new health and clipboard helpers;
local helpers reopen only after collection. A failed initialization is collected and can retry
after another user message. Engine request IDs are separated across restarts so a late approval
cannot approve a different app. Old input retries, reads and recovery timers cannot enter the new engine.
Collection cancels pending initialization waiters. A second stop cannot make a later call join
an obsolete restart. If that stop cannot collect the initializing engine, replacement waits for
a later confirmed collection so the launcher retains ownership of the existing engine.

The pending-call refusal predates native identity. `e42b974` already refuses every leased action
while another call is pending in `prepareLease`. The new check reaches that same refusal earlier.
A regression compares identity on and off with an engine read pending; neither forwards input
or starts another native query. The existing pending-call guard remains.

## Evidence and remaining checks

New regressions failed before fixes for fallback, selection numbers, retained relay restart,
reused approval IDs, cancelled restart and helper reopening. Independent review also reproduced
stale internal reads, helper retries and recovery deadlines. Regressions now cover those paths,
initialization failure and timeout retry, missing AX numbers and explicit engine window IDs.
Review reproduced two more cases: stopping during initialization left a 30-second waiter,
and an unconfirmed collection could allow another engine to start. Both regressions failed before
the fixes and passed afterward. The reviewer confirmed both fixes.

The subprocess launcher test uses a protocol fixture and isolated health probes. It sends
initialize, acquires an app, approves once, stops, sends the next-message marker, then acquires
again through the same launcher. It verifies two different engine PIDs, two initializations,
two accepted engine requests, one client approval and a probe from the replacement health helper.
This proves the MCP lifecycle. Claude desktop behavior still needs a live check.

The existing cost runner now has two explicit slots:

```sh
node bench/waits-targeting-live.mjs measure --idle
node bench/waits-targeting-live.mjs measure --loaded
```

Idle requires natural one-minute load below 3. Loaded requires 10 or more. The runner checks
the class before launching Calculator and on every measured action. Each slot compares identity
off and on in reversed order, with one Calculator window, two repetitions and eight warm actions
per arm. It records milliseconds and sampled CPU per action, including owned descendants,
Calculator and the shared service. Startup CPU remains separate. Shared-service activity and
processes that exit between samples limit CPU attribution. The runner uses natural load.

At 08:24 UTC, `/tmp/sleight-hold` reserved the Mac for Puddle measurements, starting around
08:45 UTC for 100 to 120 minutes. The live lock was absent. No live or cost run started in this
follow-up. Idle and loaded costs, Esc during a turn, confirmed stop followed by a new message,
TextEdit Save with `waitFor`, and two equal-title TextEdit windows remain unqualified.
Chess is optional and hasn't run in this follow-up. The hold remains intact.

The [prior report](2026-10-10-waits-targeting.md) retains earlier attempts, including failures.

## Verification

| Command | Result | Exit |
| --- | --- | --- |
| Focused tests in the nine files below | 141 passed, zero failures | 0 |
| `npm run lint:prose` | 75 files, zero errors or warnings | 0 |
| `npm run check` | Waited at the hold gate, then interrupted through its original terminal. The suite and plugin checks did not run. | 1 |
| `git diff --check` | Clean | 0 |

```sh
node --test tests/checked-stop.test.mjs tests/relay-input-lease.test.mjs tests/window-identity.test.mjs tests/select-window.test.mjs tests/drag-focus.test.mjs tests/waits-targeting-runner.test.mjs tests/bench-footprint.test.mjs tests/clipboard-relay.test.mjs tests/lease-launcher.test.mjs
```

An intermediate run passed 134 of 135 tests and failed the new launcher test because its optional
trace callback was called unconditionally. That call is fixed. The launcher test passes in the
final focused run. The first prose run reported six style errors. Adding the verification section
produced one more style error. These were corrected before the final passing run.

This is a code checkpoint. Full check exit 0, idle and loaded Calculator costs, and the live
checks above remain required. The AX-to-CG bridge has mocked coverage and still needs host
verification. The hold was left intact, and the interrupted check no longer waits in the background.
