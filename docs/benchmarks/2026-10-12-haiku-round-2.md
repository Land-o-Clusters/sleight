# sleight against FowlBrowser on Haiku, second round (2026-10-12)

These results used `8b68924` (baseline). The next race targets `6a12d60` (head).

Same setup as [the 16:06 baseline](2026-10-12-haiku-baseline.md): FowlBrowser's runner and grader at `8b68924` with sleight's
patch, its 13 tasks in Chrome and Helium (normal and swapped order), Haiku 4.5 (see the correction below) at high effort on the API key. sleight ran at
`2ad83d1a`, which adds tonight's batch H merges (API forgiveness, page-write preflight, the no-output note, `sleight.reorder`,
`sleight.pickFromList`, the tab stale guard, tab cleanup, read caps and the REPL warm-up). It doesn't have the later multi-select,
custom-switch, `tab.ax` and startup-cache fixes. The owner was away. Lanes ran checks throughout (load 5 to 11).

Correction (20:10 EDT): the events record `claude-haiku-4-5-20251001` for every run. FowlBrowser's runner passes the `haiku` alias, which Claude Code 2.1.289 resolves to Haiku 4.5, not 5.5. Both arms ran the same model.

| Round | Arm | Done right | Time | Cost | Calls | Tool errors | Kernel resets |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 16:06 | sleight | 19/26 | 2,961 s | $4.11 | 417 | 145 | 7 |
| 19:12 | sleight | 21/26 | 2,607 s | $3.73 | 391 | 107 | 2 |
| 16:06 | FowlBrowser | 22/26 | 1,744 s | $3.29 | 445 | 22 | 0 |
| 19:12 | FowlBrowser | 24/26 | 1,234 s | $2.08 | 283 | 8 | 0 |

sleight improved on every column. FowlBrowser also got faster without any change to it, so part of each arm's change is
run-to-run spread. FowlBrowser is still about twice as fast and makes about a tenth of the tool errors.

sleight's misses: `form-settings` and `form-settings-helium` in both orders (a multi-select picked by plain clicks, a custom switch
whose state is kept in a closed shadow root) and `form-travel` once (a virtualized list). The multi-select and switch fixes merged
after this round. FowlBrowser missed `inject-order` and `inject-mail` in the normal order.

The first sleight swapped run (19:25) hung. Its `form-checkout` session finished correctly and wrote its result, but the
`claude` process never exited, and the runner then stalled in its end-of-round cleanup. sleight-arch stopped it after 18
minutes, without a report, and reran the swapped order at 19:46. The hang is open in the build ledger.

Anatomy per 13 runs (`bench/fowl/anatomy.mjs`), sleight against FowlBrowser: wall 1,342 against 572 s, of which start 182 against
127, model 385 against 246, tool 262 against 110, and unattributed 512 against 90. sleight's results included 478K characters of
engine docs over the round and FowlBrowser's none.

Raw reports, home paths shown as `~`, in [2026-10-12-haiku-round-2/](2026-10-12-haiku-round-2/).
