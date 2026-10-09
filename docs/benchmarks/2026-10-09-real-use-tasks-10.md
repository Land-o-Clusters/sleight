# Initial Office reads, 2026-10-09

sleight-arch reran Office with the owner away at `edaf82b` on `arch/codex-real-arm`, which includes
`b8f4b3f`. The [full result](2026-10-09-real-use-tasks-10.json) retains that pass. Its terminal exit
code was not supplied. Sol didn't run live apps or load experiments for this revision. Mail and
Mimestream wait until the owner can watch them.

Word failed before a model call on `-25204` while reading AXFocusedWindow, with zero retries and
zero wait recorded. It was already running, which excluded it from the retry path. Excel stopped
on its activation screen, titled “Excel” with “Start Using Excel”. That stop is correct and the
harness must leave it for the owner. PowerPoint did not run.

## Changes

First AX reads during setup now retry `-25204` and `-25205` for both already-running and newly
launched apps, within one 30-second budget. Other errors stop immediately. Cleanup and reads after
fixture input never retry. Unsupported optional attributes still mean absent.

Office window readiness also covers existing apps and shares the initial-read deadline. The wait
doesn't restart when a read recovers or the fixture opens. Diagnostics identify `already-running`
or `cold-launch`, the last AX error and attribute, elapsed time, and readiness or deadline. Early
setup failure retains the original PID and running state without taking ownership of an old app.

## Why Word remained running

The [earlier pass](2026-10-09-real-use-tasks-8.json) at `3ac2a33` launched Word PID 72606. It stopped
on an unrecognized application dialog, suppressed AX cleanup and collected its helper. Normal quit
then remained unconfirmed after five seconds, including the final pass cleanup. The fixture was
unsaved. The original reason Word didn't exit wasn't recorded.

The [next pass](2026-10-09-real-use-tasks-9.json) and this rerun both inherited PID 72606. Those
leases correctly preserved an already-running app. Closure of the old fixture remains unconfirmed.
Brief 8 corrected the result-dialog classification, and brief 9 extended normal quit to 30 seconds.
This revision retains those fixes without claiming
that they cleaned up the old session. The harness must not force-quit unsaved work or claim ownership
from an old PID alone.

## Verification

Fake-clock tests cover both running cases, both AX errors, a 12-second recovery, shared deadlines,
slow reads and immediate stops for other errors. Native first-read and setup tests use fake apps.
A parent test retains the deadline receipt and preserves pre-existing Word without opening another
fixture or requesting quit. The result file records failed development attempts.

Bare `npm run check` exited 0 with 907 unit tests, both plugin validations and 11 mod tests.
Bare `npm run lint:prose` exited 0 across 54 files. The first check attempt hit sandbox denials for
local listeners and a fixture output file. The first prose check found two wording errors, since fixed.
Review found a deadline renewal after late Office readiness. Its regression failed at 59 seconds
before the fix and now stops at 30 seconds. Re-review didn't find remaining important issues.

Live Office qualification remains for sleight-arch, who also owns review and merge. The Codex arm
branch was read for evidence and wasn't merged.
