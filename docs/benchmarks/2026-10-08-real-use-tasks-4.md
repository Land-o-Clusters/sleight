# Real-use tasks, round 4, 2026-10-08

Branch: `codex/real-use-tasks`. Code: `69ba62981f9174906c646107171bbe4f9f3295d4`.
Parent: `dd720aebccd78225d905025308562f344d9d75b2`.
The delivery message gives the published report commit.

**0 of 18 requested model trials completed. The first Safari setup failed after an action.**
The helper opened Safari's File menu, then failed to find a unique “New Window” item.
Exact-title recovery reported “nothing created.” No model started, and the required stop after
an action prevented the remaining 17 slots from starting.

## Changes and why

Fresh native app setup now retries Accessibility errors `-25204` and `-25205` with a short backoff,
under one fifteen-second budget. Each retry records its error, backoff and elapsed wait.
The elapsed total includes failed AX reads. A deadline check prevents another retry after the
budget expires. Existing apps, cleanup, and a fixture that exists after an action don't retry.

On failed setup, the helper compares only exact run-owned titles in that app. A unique match can
be closed, with disappearance confirmed. Multiple matches refuse cleanup. No match records
“nothing created,” clears the acquisition, and permits the next run if no action preceded the
failure. Browser titles are `Form <nonce>`. Document and folder titles use their nonce filenames.
Other windows' titles aren't published and their contents aren't read.

Calculator and Simulator helpers borrow an app without claiming its windows. They leave those
windows open. An app must appear and answer the readiness read before the driver can start.
Node launch failures now await the helper's recovery receipt, after a fresh permission observation,
before deciding whether the acquisition is resolved. A collected compiler failure before Helium
setup also confirms no task window was created.

Review found the delayed-receipt race, a false readiness result for a missing inherited app, and
retry totals that omitted slow AX reads. Regression tests reproduce delayed receipts, missing apps
and slow AX reads. The final review found
no remaining critical or important issues. It didn't drive apps.

## Requested trials

| Task | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| safari-form | Setup failed; nothing created; model not started | Not started | Not started |
| helium-form | Not started | Not started | Not started |
| preview-pdf | Not started | Not started | Not started |
| finder-files | Not started | Not started | Not started |
| textedit-calculator | Not started | Not started | Not started |
| simulator-flow | Not started | Not started | Not started |

The direct command was
`node bench/run.mjs --arm sleight --suite real --tasks safari-form --runs 3`, exit 1.
It acquired the live lock without a recorded contention delay.
The [JSON report](2026-10-08-real-use-tasks-4.json) includes the full result file and all 18 slots.

Safari was already running (`fresh: false`), with 0 startup retries and 0 ms wait.
This run proves the “nothing created” recovery receipt and the stop after a setup action.
Fresh-app retries still need live verification. The menu error leaves its cause uncertain:
it can mean an absent item or multiple matches. The runner didn't retry that action.

The helper was collected, the page server closed, the scratch folder was removed, and the live
lock was absent after exit. Safari stayed running. ChatGPT and the shared helper weren't restarted,
killed, patched or wrapped. The permission observer didn't report a visible window, and no
permission was answered. Whether the owner was using the Mac wasn't recorded. Raw evidence stays in private
temporary storage. Published paths use `~`, with no screenshots or owner name.

## Verification

| Command | Exit | Evidence |
|---|---:|---|
| `npm run check` | 0 | 712 unit tests, plugin validation and 9 mod tests |
| `npm run lint:prose` | 0 | Final report included |
| Focused fixture and lifecycle tests | 0 | 33 tests |
| `node --check bench/real-fixture.js` | 0 | Native helper syntax |
| `node --check bench/run.mjs` | 0 | Runner syntax |
| `git diff --check` | 0 | Whitespace |

The first bare check in the sandbox exited 1: seven loopback fixtures were denied and the hover
fixture couldn't write its linked output in this worktree. The scoped host check exited 0.
The JSON retains each failed case. Lint passed before the code commit and again with this report.

Qualification remains incomplete. The Safari menu-item failure needs investigation before
another live qualification pass.
