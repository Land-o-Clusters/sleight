# sleight against FowlBrowser, later rounds (2026-10-12)

These results used `8b68924` (baseline). The next race targets `6a12d60` (head).

The setup is the one in [the 10:25 round](2026-10-12-fowlbrowser-h2h.md): FowlBrowser's runner and grader at
`8b68924` with sleight's patch, its 13 tasks, each run in Chrome and Helium (normal and swapped order), Opus 5.5 at
medium effort. These rounds ran on the owner's Claude account rather than the API key. sleight changed between
rounds. The commit column is the branch's last commit before the round started. The owner was using the Mac during
all of them.

A task counts as done right when the runner's outcome is ok, as in the 10:25 write-up. The runner also has checks
of its own. FowlBrowser's handoff runs failed one of them ("no tab_handoff in the journal") once in each earlier round and
twice at 15:23. sleight's runs failed one in the 14:27 round and none in the others.

| Round (EDT) | sleight commit | Arm | Done right | Time, 26 runs | Cost | Calls | Runner checks failed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 15:23 | `118b1b3` | FowlBrowser | 26/26 | 805 s | $5.55 | 241 | 2 |
| 15:23 | `118b1b3` | sleight | 26/26 | 893 s | $8.39 | 204 | 0 |
| 14:27 | `6b14a6a` | FowlBrowser | 26/26 | 967 s | $7.19 | 238 | 1 |
| 14:27 | `6b14a6a` | sleight | 22/26 | 1,414 s | $9.07 | 220 | 1 |
| 13:22 | `1df3d23` | FowlBrowser | 26/26 | 943 s | $7.11 | 242 | 1 |
| 13:22 | `1df3d23` | sleight | 25/26 | 1,101 s | $9.13 | 208 | 0 |
| 13:09 | `0729754` | FowlBrowser | 26/26 | 884 s | $6.89 | 246 | 1 |
| 13:09 | `0729754` | sleight | 22/26 | 1,258 s | $10.64 | 246 | 0 |

At 15:23 sleight matched FowlBrowser on tasks for the first time and made fewer calls. FowlBrowser was still
10% faster and cost 34% less. The engine's own documentation was 81% of the characters sleight's results sent
Claude over 13 runs earlier in the day, and later calls in a run read it again from context.

Per task at 15:23, both runs' times added:

| Task | FowlBrowser | sleight |
| --- | --- | --- |
| `form-travel` | 151 s | 161 s |
| `form-settings` | 99 s | 100 s |
| `form-checkout` | 120 s | 92 s |
| `form-settings-helium` | 89 s | 109 s |
| `shipping-link` | 32 s | 35 s |
| `size-guide` | 41 s | 49 s |
| `demoid` | 44 s | 52 s |
| `mobile` | 42 s | 43 s |
| `handoff` | 49 s | 61 s |
| `inject-order` | 49 s | 61 s |
| `inject-mail` | 48 s | 53 s |
| `wikipedia` | 19 s | 41 s |
| `mdn` | 22 s | 36 s |

sleight-only rounds (one browser order, so 13 runs each), all 13/13: finished 12:51, 1,013 s and $4.54; finished
12:56, 684 s and $4.82; finished 14:54 with A1's form helper, 814 s and $5.98.

Merged on the branch between the 14:27 and 15:23 rounds: tab calls routed off the native path (`375779f`,
`d6ec4f3`), a form helper that fills a form in one call (`eec96b5`), a size cap on browser trees and `emit: false`
reads kept out of results (`b1cff76`), and `sleight.dragTo` (`118b1b3`), with which the Helium settings form took
39 s instead of 313 s.

Raw reports, home paths shown as `~`, in [2026-10-12-fowlbrowser-h2h-2/](2026-10-12-fowlbrowser-h2h-2/): one file per
round, arm and order (`1523-sleight-normal.md` and so on), and `r3-sleight.md`, `r4-sleight.md`, `r6-sleight-a1.md`.
