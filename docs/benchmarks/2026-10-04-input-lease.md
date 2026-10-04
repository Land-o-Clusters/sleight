# Input lease repair, October 4

The final five races each left one marker and one refusal. The command
`node bench/input-lease.mjs` exited 0. Both engines were collected, snapshot
directories were removed and zero lease files remained. Change review was off,
as it is on main after `570a1ab`. The fixture raises only its uniquely named
temporary window and closes only its own document.

All live attempts are below. Home paths in the raw records use `~`.

| Attempt | Result | Raw records |
|---|---|---|
| Owner's original `72f5a28` pass | 1/6; refused natural reads and engine timeouts | [Before repair](2026-10-04-input-lease-before-fix.json) |
| Owner's `762db4a` baseline | 0/6; helper timeouts, later cleared by restarting ChatGPT | [Baseline](2026-10-04-input-lease-owner-baseline.json) |
| General benchmark before revised scope | 0/3 completed tasks passed, with empty answers. An overlapping run in the primary checkout prompted a terminal interruption, so this attempt does not establish a complete task comparison. | [Partial attempt](2026-10-04-input-lease-general-attempt-1.json) |
| First lease attempt in sandbox | Could not reach TextEdit; no races | [Sandbox attempt](2026-10-04-input-lease-sandbox-attempt.json) |
| First host lease attempt | Engine read an existing untitled window instead of the fixture; stopped before typing | [Window attempt](2026-10-04-input-lease-window-attempt.json) |
| Host attempt after fixture window selection | 5/5 one-marker, one-refusal races. The extended long action stopped at the window guard, then cleanup completed. | [Extended attempt](2026-10-04-input-lease-heartbeat-attempt.json) |
| Rebased lease attempt in sandbox | Could not reach TextEdit; no races | [Rebased sandbox attempt](2026-10-04-input-lease-rebased-sandbox-attempt.json) |
| Final rebased host lease attempt | 5/5 one-marker, one-refusal races; exit 0 and cleanup passed | [Final attempt](2026-10-04-input-lease-final.json) |

One further extended-run request was declined before execution. No process or
results file was created for it. The revised scope leaves the general benchmark
to sleight-arch at merge. No further general pass was run.

The initial regression run failed 12 tests before the fixes. Review found three
more cases: a same-name bundle inheriting another app's ID, the final header
following the wrong handle, and recovery reassigning `const app`. Each received
a failing regression test before its fix. After the rebase, the full suite passed
153/154: the launcher cleanup test still assumed change review was on. Its
fixture now opts in so it continues to verify saved-snapshot removal.
The final `npm run check` exited 0 with 157 unit tests, plugin validation and
8 mod tests passing. `npm run lint:prose` exited 0 with zero flags. After the live
run, three more unit regressions narrowed identity lookup for interleaved handles
and kept inventory search strings from discarding the target. The ledger edits
also produced three lint failures on wording flags before the final pass.

Forced engine termination remains possible in the launcher's deadline path and
the extended benchmark's cleanup. Neither process collection nor the five short
races establish the shared helper's behavior after forced termination. The earlier
helper wedge has no established cause in these records.
