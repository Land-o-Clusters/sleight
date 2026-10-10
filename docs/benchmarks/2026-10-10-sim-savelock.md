# Simulator, save lock and turn cleanup, 2026-10-10

Work is on `codex/sim-savelock` in an isolated worktree. The [follow-up](2026-10-10-sim-savelock-2.md)
rebases it onto `private/pane/auto-mode` and records the review corrections.
The primary checkout's existing changes were preserved. No merge or push to `main` is part of this task.
The branch uses the private remote for publication.

- [Simulator analysis](2026-10-10-simulator-focus.md) separates the parked screenshot-scaling bug
  from the still-unconfirmed Safari focus failures. Its owner-away probe has not run.
- [TextEdit investigation](2026-10-10-save-lock.md) retains every stopped attempt and the safe
  background event comparison. No edit or save trial completed. Extra restored windows and an
  Accessibility read failure initially left the owned fixture's cleanup unconfirmed. A later
  read-only check confirmed closure and released the retained live lock without app input.
  It ran during the hold and left the owned process running. Cleanup remained incomplete.
  The original Shift mitigation remains in place.
- [Turn cleanup](2026-10-10-turn-lifecycle.md) fixes forgotten cleanup after an engine rejection,
  with regression tests for the original turn identity and newer work in flight.

## Validation

The final bare `npm run check` exited 0: all 1,150 Node tests, both manifest validations and
11 mod tests passed, with zero failures, cancellations or skipped tests.
Bare `npm run lint:prose` passed across 73 files with zero flags.
Every attempt and exit code is recorded in the
[validation receipt](2026-10-10-sim-savelock-validation.json).

Earlier checks reported native compiler deadlines and process timing failures while several chats
ran full suites together. The first interrupted checks lost their terminal handles; those exit
results remain unknown. Later interrupted runs have their final exits recorded. Sandbox refusals
on test sockets and worktree output writes preceded the host retry. Those earlier attempts did not
qualify the branch.

The original final run used the coordinated queue and ran one test file at a time, with the same tests and
deadlines. The clipboard process fixture also keeps its transaction owner reachable after module
evaluation, so garbage collection cannot release its reservation before the process exits.
The receipt-review chat reproduced that fixture failure and verified the correction; this branch's
two existing clipboard reservation tests also passed, exit 0. No assertion changed.
The follow-up restores the working branch's four test workers.
