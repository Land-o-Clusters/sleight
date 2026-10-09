# Cleanup AX reads, 2026-10-09

The branch was rebased onto `6abba43` from `origin/pane/auto-mode`, including the architect's Codex
arm and CPU footprint. Its adopted fixture code, tests and brief-10 evidence matched `309c2c9`.
The first rebase tried to replay older squashed commits and stopped on conflicts. It was aborted,
then rebased from the adopted tip. The [full result](2026-10-09-real-use-tasks-11.json) records the
architect's pass and development attempts. The pass terminal exit code wasn't supplied.

With the owner away, Word passed once in 42.2 s and 10 turns. Its result dialogs were recorded and
left to Claude. Excel's model reported saved edits and D4 = 15 and exited 0, but the task failed
when AXFocusedWindow returned `-25204` and cleanup remained unconfirmed. Its saved-file check
result wasn't retained. PowerPoint didn't run.

## Changes

Cleanup's native AX reads now retry only `-25204`, within one 15-second budget starting at the
first error. All cleanup reads share it, separate from setup's deadline. Other AX errors stop
immediately. Optional absent values retain their prior meaning.

The retry wraps only a read. Existing presses, focus checks, document identity checks and retained
window ownership still govern cleanup. The parent waits up to 30 seconds so the helper can finish
its read wait and report the outcome. Permission stops still collect the helper without AX cleanup.
Diagnostics retain cleanup retries, elapsed time, last code and attribute, and the readiness,
deadline or error outcome alongside the setup records.

Ready-state dialog observations also receive bounded read waits, with separate diagnostics. Each
complete observation starts a fresh episode. A close request during a read or wait preserves the
original deadline when cleanup begins. This covers the helper's transition from observation to closing.
Any wait makes cleanup repeat its document and focus checks before a press. Button lookups also
recheck document identity after waiting.

The supplied result doesn't establish whether Excel's failed read began before the close request.
Live qualification remains for sleight-arch's Excel and PowerPoint rerun. Sol didn't run live apps
or load experiments. Mail and Mimestream wait for the owner.

## Verification

Fake-clock tests cover recovery after 12 seconds, a shared deadline across attributes, slow reads,
immediate hard errors and one failed press attempt. Cleanup refuses a changed focus after
recovery. A parent test retains the receipts and lets the helper finish beyond 15 seconds.
Further regressions cover overlapping close requests, separate observation episodes and a changed
document on the same retained window. The focused fixture suite passed 66/66.

Bare `npm run check` exited 0 with 981 unit tests, both plugin validations and 11 mod tests. The
first attempt failed on 44 sandbox denials for local listeners, sockets and a fixture output file.
Review found the transition and identity gaps described above, then a deadline renewal when close
arrived during a successful read. All three have regressions. Re-review didn't find remaining
important issues. Bare `npm run lint:prose` exited 0 across 59 files. Each result is retained in the JSON.
