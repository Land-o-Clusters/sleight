# Real-use tasks, round 3, 2026-10-08

Branch: `codex/real-use-tasks`. Code: `f425373a8b2f3600a7aba5dcb7bef2aa9a86aa36`.
Parent: `7420d18d5f390b332060ef720822bf22362e20c4`.
The delivery message gives the published report commit.

**0 of 18 requested model trials completed. Qualification stopped on unconfirmed Safari cleanup.**
Safari started in the background, but native setup failed with Accessibility error `-25204`
before the helper reported readiness. The runner stopped after that first setup. It didn't start
a model trial. The remaining 17 trial slots weren't started.

## Changes

The real runner forces `SLEIGHT_SURFACES=computer` for arm preflight and every task, after inherited,
arm and per-run settings. It records that selection in the result file. This selects native app
access for Helium, using the normal benchmark app approval. Helium's new setting has unit proof,
but wasn't requalified live in this round.

Safari starts in the background with `open -g -a Safari` before acquiring a fixture window.
The native helper waits up to ten seconds for the process to finish launching. It advances the
main run loop so AppKit can refresh cached launch state. Review found that sleeping alone could
keep returning an old value. A regression test covers that state change.

Default surface settings and the original seven task prompts are unchanged. The permission
refusal stop gate, system permission observation, retained-window cleanup and live lock remain.

## Requested trials

| Task | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| safari-form | Setup failed, model not started | Not started | Not started |
| helium-form | Not started | Not started | Not started |
| preview-pdf | Not started | Not started | Not started |
| finder-files | Not started | Not started | Not started |
| textedit-calculator | Not started | Not started | Not started |
| simulator-flow | Not started | Not started | Not started |

The direct command was
`node bench/run.mjs --arm sleight --suite real --tasks safari-form --runs 3`, exit 1.
It waited for the existing live lock. The [JSON report](2026-10-08-real-use-tasks-3.json) retains
its complete result file, including `surfaces: "computer"` and the failed setup.

Safari reached native acquisition, which confirms the process passed its launch wait. An AX read
then failed with `-25204` (`cannotComplete`). The helper had not reported `armed`.
The record doesn't identify the attribute that failed or establish whether a new window had
already been created. It cannot support a claim that the failure was harmless or that the window
was closed.

The system permission observer didn't report a window during the attempt. A requesting process
and title weren't recorded. While waiting for the lock, an auxiliary observer call failed because
the sandbox denied access to the process-list service. The scoped host retry returned `false`,
meaning it didn't observe a visible system permission window. The observer didn't inspect browser
windows or prompt bodies.

## Cleanup and recovery

The page server closed and the fixture helper was collected. The runner preserved the scratch
folder at `<temp>/sleight-bench/2026-10-09T00-59-54-312Z/sleight-safari-form-1`.
The cleanup command remains in its `window-0-control.json`, but a written command doesn't establish
that the window closed. The helper didn't return ownership, so this attempt cannot supply a
safe window identifier for recovery.

The runner released its live lock on exit as required. Another holder can then acquire the lock
while Safari cleanup remains unconfirmed. I stopped further live attempts. Recovery must verify
only any window created by this attempt and leave other Safari windows alone. The window's identity
and closure still need verification before resuming.

ChatGPT and the shared helper weren't restarted, killed, patched or wrapped. Raw traces and
transcripts stay in private temporary storage. Published evidence contains no screenshots or
owner home paths. Whether the owner was using the Mac during the attempt wasn't recorded.

## Verification

| Command | Exit | Evidence |
|---|---:|---|
| `npm run check` | 0 | 703 unit tests, plugin validation and 9 mod tests |
| `npm run lint:prose` | 0 | 50 files, including this report |
| Focused environment, fixture, driver and runner tests | 0 | 28 tests |
| `node --check bench/run.mjs` | 0 | Runner syntax |
| `git diff --check` | 0 | Whitespace |

The first bare check in the sandbox exited 1 on seven loopback-server permission failures and a
hover fixture linker output-write refusal. The first host check exited 1 on
`doctor collects a descendant that retains pipes after its parent exits`: its `stuck` value was
false. That existing test passed in isolation and in the following full check. The cause wasn't
established, and doctor code wasn't changed. The JSON lists every failed case and its exit.

The failed native setup and unconfirmed cleanup remain the result of this round. All six tasks
still need three live model trials. This branch is published for review, without merging.
