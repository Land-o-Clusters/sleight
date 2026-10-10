# Simulator readiness and Helium control file, 2026-10-10

Rebased `codex/real-use-tasks` onto `private/pane/auto-mode` at `a8602dc`. The only
commit on the previous public tip (`0d24316`) was already in that base as `f8aae8b`.

Haiku `simulator-form` setup failed with the owner away, then cleanup refused to
quit the DeviceHub the run launched. sleight-arch quit it by hand after each pass.
The first pass
([`2026-10-10-release-haiku-1.json`](2026-10-10-release-haiku-1.json)) stopped on
"Fixture process changed while original is running" (pid 63618). `4a43726` already
waits for that original to exit. The second
([`2026-10-10-release-haiku-2.json`](2026-10-10-release-haiku-2.json)) had one
DeviceHub process (`pids: [73541]`) and ended "Fixture application readiness
unconfirmed". Inherit mode required `isFinishedLaunching` and a focused window.
DeviceHub opened with `open -g` can finish launching and have a window without
focus. Cleanup then threw "Launched app identity changed; quit refused" for that
same pid.

Inherit setup now records which condition held. A focused window still counts, and
so does any window after finished launching. If DeviceHub reports neither, the
control file's `simulatorBooted` flag (set after `bootedIPhone` returns) is enough.
Quit reports the observed and expected pid and bundle on a mismatch. An empty
bundle string on the launched pid is accepted, and the quit request sends
`Number(lease.pid)` with the bundle setup recorded.

The control file's `launched` field made every Helium setup time out (7 of 7 with
the field, 4 of 4 without). `real-helium.swift` cast the file to
`[String: String]`, so `{"command":"opened","launched":true}` parsed as nothing
and `command()` never became `opened`. The helper now reads `command` from
`[String: Any]`. A unique created window that matches the fixture is closed even
when setup fails before `owned` is assigned. The parent writes `launched` again,
and the parent-PID handoff test is unskipped.

When setup succeeds, the default `simulator-form` path is still the round-12
sequence. The task acquires the viewer lease and boots if needed. It then marks
launch ownership, opens the viewer in the background, and opens the form URL.
Cleanup closes fixture windows. It shuts down only a boot this run started. It
quits only a viewer this run launched. Before round 12 the task booted, served
the form, opened the URL, and quit DeviceHub or Simulator by name.

No live DeviceHub or Helium run in this task. `/tmp/sleight-live.lock` was already
present, and `--owner-away` was not confirmed.

## Verification

Fake-clock tests cover inherit readiness with a window and no focus, a focused
window, simctl boot without a window, and readiness still unconfirmed when none
of those hold. Quit tests report the observed and expected pid and bundle on a
mismatch, allow an empty bundle on the launched pid, and coerce a string pid.
Helium regressions cover a
boolean `launched` field and closing a created fixture after a timed-out setup.
The default simulator-form lifecycle tests still pass.

The first `npm run check` in the workspace sandbox exited 1: 1,355 of 1,357
unit tests passed, and the two window-observer tests failed with `listen
EPERM` on their private sockets. The host-access retry exited 0. All 1,357
unit tests passed in 19.1 s. Both plugin manifests validated. All 28 mod
tests passed. `npm run lint:prose` exited 0 across 91 files.
