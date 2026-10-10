# Simulator launch handoff, 2026-10-10

Rebased `codex/real-use-tasks` onto `332e3ca` from `origin/pane/auto-mode`. The
[results](2026-10-10-real-use-tasks-12.json) retain the architect's failed run and development attempts.

With the owner away, the architect's `simulator-flow` run at 03:30 UTC failed during setup.
DeviceHub replaced its launch process. Setup refused the changed PID, then cleanup refused the
replacement. Claude never received the task. The architect reported quitting DeviceHub manually.
The pass terminal exit code and replacement PID were not supplied.

Setup now accepts one process handoff for an app this run launched. The replacement must have the
same bundle ID, and the recorded process must have exited. Receipts retain both PIDs and the handoff
time. Cleanup collects the helper, then requests an ordinary quit of the adopted PID and confirms
its exit. A second handoff, another bundle, a living original process, an existing app or an
unowned launch still refuses adoption. A handoff after readiness remains refused.

Inherited simulator setup now waits for launch completion and a focused window. Ordinary setup
cancellation can record an eligible successor without an AX action before returning its failure
receipt. Close commands preserve the launch ownership fact. Permission stops still collect the
helper without AX cleanup.

The default suite's `simulator-form` had no retained viewer identity. It now uses the same fixture
lifecycle, startup handoff and exact-PID cleanup. It shuts down only a simulator boot it started,
closes its form server on failure, observes permission refusals from streamed driver output, and
stops the pass on cleanup failure. The final pass tail no longer quits simulator viewers by name.
Published result files scrub owner names and home paths, including default-suite fixture diagnostics.

No live apps or load experiments ran in this task, so live DeviceHub qualification awaits the
architect's `simulator-flow` rerun while the owner is away.

## Verification

Fake-clock tests cover handoffs during pending launch and readiness, every required refusal, actual
inherited simulator readiness, cancellation at the handoff, retained PID diagnostics and cleanup
of only the adopted process. Runner tests cover the default task's lifecycle, streamed permission
detection, scrubbed output and cleanup failure. Review found the early-readiness and cancellation
gaps. Later review found that an uncollected driver bypassed local listener cleanup. Each had
failing regression tests before its fix.

The first bare check ran in the workspace sandbox and exited 1 after an owned-terminal interrupt.
Local listener and socket operations were denied. A native fixture output write also failed, and
the default cleanup-tail assertion still expected broad viewer cleanup. The retained terminal
confirmed exit before the host-access retry began.

The first host-access retry hit 180-second native compile timeouts. The host load average was
137.43. After one owned-terminal interrupt, the collected exit was 1: 1,143 tests passed,
10 failed and one was cancelled. The unit runner now limits concurrency to four files, bounding
native compiler fan-out while retaining every test. The first prose lint found five errors, which
were corrected.

The four-file retry also exceeded the 180-second compile deadlines. Host load reached 232.75.
Its retained terminal returned exit 1 after one interrupt. All 13 handoff tests passed in that run.
The operator approved termination of the compiler descendants, and a worktree inspection confirmed
none remained. The interrupted attempts and cleanup results are recorded in the JSON.

After the shared build hold cleared, the queued `npm run check` passed with exit 0.
All 1,160 unit tests passed in 162.8 seconds. The command also passed manifest validation and all
11 mod tests. `npm run lint:prose` passed with exit 0 across 70 files. A worktree inspection
confirmed no compiler processes remained after the successful check.
