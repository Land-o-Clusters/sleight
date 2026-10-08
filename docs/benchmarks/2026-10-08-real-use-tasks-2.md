# Real-use tasks, round 2, 2026-10-08

Branch: `codex/real-use-tasks`, rebased onto `origin/main` at
`2d2eb60855e30d916c731cfb6d703607b7bf980f`, including the runner lock fix `60b9946`.
The Helium measurements used `cc92ef14ae8ed407d33157a9ea03705aea52f8fc`.
The later stop and ownership fixes are at `2a64105dc513ad9e0ff90a792709b8fd98cfd32c`.
The delivery message gives the published report commit.

**3 of 18 requested model trials completed, with 1 pass. The suite is not qualified.**
Safari failed three setup checks because it wasn't running. Helium passed once and failed twice
after browser permission requests were dismissed. Those refusals were found after all three
Helium trials. Preview was stopped while waiting for another holder's live lock. The other tasks
weren't started. I stopped all further live runs after finding the permission refusals.

## Three-run outcomes

| Task | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| safari-form | Setup failed, model not started | Setup failed, model not started | Setup failed, model not started |
| helium-form | Fail, no server submission | Pass, all five fields submitted | Fail, no server submission |
| preview-pdf | Not started | Not started | Not started |
| finder-files | Not started | Not started | Not started |
| textedit-calculator | Not started | Not started | Not started |
| simulator-flow | Not started | Not started | Not started |

| Helium trial | Seconds | Turns | Cost USD | Driver exit | Independent check |
|---|---:|---:|---:|---:|---|
| 1 | 15.8 | 5 | 0.235048 | 0 | Fail |
| 2 | 26.4 | 11 | 0.213113 | 0 | Pass |
| 3 | 15.8 | 6 | 0.230093 | 0 | Fail |

A successful driver exit doesn't satisfy the form check. Runs 1 and 3 had no server submission
with the five required values. Each had two typed error tool results reporting that a browser
permission request was dismissed before a decision. Run 2 had no matching permission error.

The process and window title for those browser requests are **unavailable**. No such window was
observed. The system-only observer didn't detect the requests, and the saved engine refusal
doesn't identify their process or window title. Browser window inventories and prompt bodies
weren't inspected. The runner should have stopped at the first refusal. All three trials had
already finished when it was found in the saved results.

The driver now stops on the first streamed browser permission refusal and prevents another
trial. It collects the owned driver and observes system permission windows again before app
cleanup. The runner stops cleanup when a permission window is visible and reports only its process
and title.
These fixes have passing unit tests. They have no new live proof because the brief requires
stopping at a permission request.

## Attempts and cleanup

Each command was the direct runner invocation
`node bench/run.mjs --arm sleight --suite real --tasks <id> --runs 3`.
The [JSON report](2026-10-08-real-use-tasks-2.json) retains every result record, including failures.

| Source stamp, UTC | Task | Exit | Result |
|---|---|---:|---|
| 22:22:03.046 | Safari | 1 | Sandbox denied writing results before fixture setup; no result file |
| 22:22:25.208 | Safari | 1 | Safari absent, one setup failure and unconfirmed cleanup reported |
| 22:25:23.457 | Safari | 1 | Setup failed in 3/3 runs, Safari absent, cleanup confirmed |
| 22:38:40.199 | Helium | 1 | Fail, pass, fail; three model trials |
| 22:40:40.088 | Preview | 1 | Cancelled while waiting for another holder's lock; empty results |

The first Safari helper refused before creating a window. Its failure initially lacked an explicit
untouched state, so the runner reported uncertain cleanup and preserved
`<temp>/sleight-bench/2026-10-08T22-22-25-208Z/sleight-safari-form-1`.
The server closed and the helper was collected. A later fix distinguishes that untouched
preflight from an uncertain acquisition. All three subsequent Safari setup failures removed their
fixtures without opening windows.

All three Helium fixture windows were closed through their retained native Accessibility
references. The fixture folders were removed and the driver groups were collected. Preview was
interrupted once through its original terminal and exited 1 before acquiring the lock, opening
a fixture or calling a model. Another holder's lock was left alone.

The round-2 brief identifies the earlier windows as Safari's Automation prompt and a harmless
fixture crash report. The [initial report](2026-10-08-real-use-tasks.md) remains the record of those
attempts. Safari's absence during round 2 establishes that no Safari window remained at those
preflights. It doesn't change the earlier unconfirmed-cleanup record.

## Native fixture changes

Real setup, checks and cleanup no longer use Apple Events. LaunchServices opens pages and files.
Native Accessibility retains only the fixture window for cleanup. Safari must already be running
to avoid restoring an owner session. Helium must have one running process in the owner's profile.
A native Swift window-created observer pins its new fixture window without reading existing
focused windows. JXA cannot provide the C callback that observer requires.

Helium's existing windows and tabs aren't inventoried, switched to or closed. There is no profile
override. Finder's generic `Archive` title can match an already retained fixture during cleanup,
but cannot establish ownership during setup. PDF and text document cleanup refuses changed focus.
Ordinary cancellation retains the owned window reference for cleanup. A visible permission window
stops the helper before any further app cleanup.

The shared helper and ChatGPT weren't restarted, killed, patched or wrapped. The default seven
task definitions and prompts remain unchanged. Raw transcripts stay in private temporary storage.
Published evidence contains no screenshots or owner home paths.

The runner owns the live lock and tasks reuse it. The lock is released on exit as required, even
if helper collection cannot be confirmed. A later holder could then overlap an uncollected helper.
That limitation remains documented.

## Verification and remaining qualification

| Command | Exit | Evidence |
|---|---:|---|
| `npm run check` | 0 | Final code, plugin validation and 9 mod tests |
| `npm run lint:prose` | 0 | Prose, including this report |
| `node --check bench/run.mjs` | 0 | Runner syntax |
| `git diff --check` | 0 | Whitespace |

An ordinary sandbox check exited 1 on seven loopback permission failures and one linker output
write refusal. Scoped host access after the actual denial produced the passing check above.
Earlier failing checks and the original negative live records weren't discarded. No additional
full benchmark suite ran in round 2.

Qualification still needs three successful live trials for each task after the browser consent
issue is resolved. Safari also needs to be running before its fixture can be created. The gate
that stops runs on permission refusals needs live verification in that future run. This branch is published for
review, without merging.
