# Real-use tasks, 2026-10-08

Branch: `codex/real-use-tasks`, based on `4617c00574302bc9278799ebdcc3fb81bd988a73` from
`origin/main`. The delivery message gives the published commit.

The `real` suite adds six tasks with independent checks and passing and failing unit cases.
The original seven task definitions and prompts remain unchanged. Safari, Preview, Finder and
Helium were added to `BENCH_APPS` by name and exact bundle ID, under the owner's 2026-10-08 ruling.

## Live qualification

**0 of 18 requested model trials completed. Qualification remains blocked.** Each task needs three
live runs. Safari's first setup timed out before returning its new window ID, before any model call.
The run stopped on unconfirmed cleanup. A subsequent scoped observation found the active macOS
authorization process with two on-screen windows on layer 8. Prompt contents and their requester
were not inspected. All further live checks stopped under the task's permission-prompt rule.

| Task | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| safari-form | Setup failed, model not started | Not started | Not started |
| helium-form | Not started | Not started | Not started |
| preview-pdf | Not started | Not started | Not started |
| finder-files | Not started | Not started | Not started |
| textedit-calculator | Not started | Not started | Not started |
| simulator-flow | Not started | Not started | Not started |

The command used was `node bench/run.mjs --arm sleight --suite real --tasks safari-form --runs 3`.
An earlier invocation was cancelled through its terminal while waiting for the existing live lock
so review fixes could land. It didn't open an app or call a model. Both invocations exited 1.
The [published JSON](2026-10-08-real-use-tasks.json) retains both failures and one completed
full dry pass, which exited 0 without app driving or model calls. An earlier sandbox dry attempt
could not listen on loopback or write results, so it didn't produce a result file.

The dry pass is fixture evidence, not live qualification. No full live suite ran, and these tasks
have no measured speeds. Whether the owner was using the Mac during setup was not recorded.

## Checks and repairs

Form checks use five exact server fields, including the select, checkbox and per-run code. PDF
checks read both saved pages and require rotation 0 on page 1 and 90 on page 2. Finder checks exact
file names, contents and ordinary file types inside the fixture folder. TextEdit checks saved text
equal to 391. The simulator checks the saved value and ordered screen sequence ending at the profile.

Review found permission-observer, acquisition, driver-process and Preview identity gaps. The fixes
restrict observation to the system authorization process, refuse an unavailable observer, monitor
through cleanup, retain uncertain acquisitions, collect the owned driver group, and verify the
recorded Preview document. Live evidence then exposed the observer's layer-0 assumption. Its
regression case now uses the measured layer 8 and passes. The PDF helper now awaits collection of
its own compiler group after a timeout or cancellation. App setup and cleanup still need live proof.

Earlier bare `npm run check` runs exited 0 with 675 unit tests, validation and nine mod tests.
The later check exited 1 when three Swift compilations timed out: the new PDF fixture and the
existing native drag and Chess fixtures. The host reported elevated memory pressure during that
failure, although that observation does not establish why compilation stalled. After the process-cleanup
fix, another bare check passed 676 of 677 unit
tests and exited 1 on the PDF helper's 60-second compile limit. An existing native fixture took
89 seconds and passed in that run, so the new helper now uses the same bounded three-minute
compile allowance as the existing fixtures. Its execution limit remains 15 seconds.

| Final command | Exit | Evidence |
|---|---|---|
| `npm run check` | 0 | 677 unit tests and 9 mod tests passed, with plugin validation |
| `npm run lint:prose` | 0 | 48 files |
| `node --check bench/run.mjs` | 0 | Runner syntax |
| `git diff --check` | 0 | Whitespace |

## Recovery

Safari window cleanup is unconfirmed because setup never returned its window ID. The page server
was closed. The scratch folder was preserved at
`<temp>/sleight-bench/2026-10-08T21-21-53-369Z/sleight-safari-form-1`. Raw transcripts and traces stay
in private temporary storage outside the repo, and published evidence contains no screenshots or
owner home paths.

The cooperative lock was released on exit, as the task explicitly requires. This follows the brief
over the review suggestion to retain the lock after failed cleanup. The failure stops the pass and
preserves its fixture, but another holder can acquire the lock before manual recovery finishes.
A later holder acquired the lock, and its lock was left alone.

Before resuming, the owner must resolve the macOS authorization prompts and confirm that any Safari
window opened for `http://127.0.0.1:62356/e0e21e4b/` is closed. Recovery must leave other windows
alone. Then run each of the six task IDs individually with `--runs 3`, using the normal lock wait.
No app approvals beyond the existing ruling are needed by this suite.
