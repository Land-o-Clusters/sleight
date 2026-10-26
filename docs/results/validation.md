[Benchmarks](README.md) · [Native](native-claim.md) · [Apps](app-claim.md) · [Chrome and Helium](browser-turbo.md) · [Safari and Firefox](browser-race.md) · [Experiments](ab-tests.md) · Validation · [Releases](release-passes.md) · [Insights](insights.md) · [Interactive](https://land-o-clusters.github.io/sleight/results/explore.html)

# Validation: build A against build B

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="charts/family-validation-dark.svg">
  <img src="charts/family-validation-light.svg" width="900" alt="Validation: 474 of 484 recorded attempts passed across 42 study and arm rows. Task sets differ between studies.">
</picture>

<sub>Validation: 474 of 484 recorded attempts passed across 42 study and arm rows. Task sets differ between studies.</sub>

These banks compare two builds of sleight on the same tasks, build A (an earlier build, usually the last release) against build B (the build under test). No other tool is in these tables, and they never count toward a claim. A mark means build B has a higher expected time than build A, or a lower pass rate. It is not a significance test.

1 scored bank: 1 validation, 0 re-measure. 6 more have no score file. 21 A/B groups in all. Build B has a higher expected time or a lower pass rate than build A on 37 of 72 task comparisons. Newest scored bank: validation-140-final (2026-10-20).

<details><summary>Method</summary>

- Expected time is the mean seconds per attempt divided by the pass rate (`bench/claim-score.mjs`). A failed run adds its time to the mean and lowers the rate. A task an arm never passed has no expected time, and that arm then has no total. Median and range are over passing runs, and p90 (nearest rank) appears only at 5 or more runs.
- The validation runner (`bench/validation/validation-140.mjs`) alternates the two builds round by round on one Mac with the tester away, and scores both with the claim scorer. Where an earlier round of build A passed its identity checks (prompts, harness, model, engine), the runner reuses it and counts it in build A's rounds.
- The re-measure runner (`bench/validation/remeasure.mjs`) runs 3 rounds of the final build against the stored build A rounds. Its gate needs build B to have no higher expected time and no lower pass rate on every selected task.
- A score file keeps each run's seconds and whether it passed, and not the failure reason. Each bank's folder keeps the receipts and logs.

</details>

## validation-140-final

Validation bank, 2026-10-20, 12:11 to 18:11 UTC, ChatGPT engine `26.1013.40934`, build A `ed484d76`, build B `56d625e3`. The bank is not complete.

| Group | Browser | Tasks | Build B marked on | Passes A | Passes B |
| --- | --- | --- | --- | --- | --- |
| `as3-firefox` | firefox | 5 | 3 of 5 | 15/15 | 15/15 |
| `as3-safari` | safari | 5 | 3 of 5 | 15/15 | 15/15 |
| `cc-calendar-ambiguous-firefox` | n/a | 1 | 1 of 1 | 3/3 | 3/3 |
| `cc-calendar-ambiguous-safari` | n/a | 1 | 0 of 1 | 3/3 | 3/3 |
| `cc-calendar-firefox` | n/a | 1 | 1 of 1 | 3/3 | 3/3 |
| `cc-calendar-safari` | n/a | 1 | 0 of 1 | 3/3 | 3/3 |
| `cc-dropdown-firefox` | n/a | 1 | 0 of 1 | 3/3 | 3/3 |
| `cc-dropdown-safari` | n/a | 1 | 0 of 1 | 3/3 | 3/3 |
| `cc-dropdown-slow-firefox` | n/a | 1 | 1 of 1 | 3/3 | 3/3 |
| `cc-dropdown-slow-safari` | n/a | 1 | 1 of 1 | 3/3 | 3/3 |
| `cc-list-firefox` | n/a | 1 | 1 of 1 | 3/3 | 3/3 |
| `cc-list-native` | n/a | 1 | 0 of 1 | 3/3 | 3/3 |
| `cc-list-pop-up-firefox` | n/a | 1 | 0 of 1 | 3/3 | 3/3 |
| `cc-list-pop-up-safari` | n/a | 1 | 0 of 1 | 3/3 | 3/3 |
| `cc-list-safari` | n/a | 1 | 0 of 1 | 3/3 | 3/3 |
| `cc-new-tab-firefox` | n/a | 1 | 0 of 1 | 3/3 | 3/3 |
| `cc-new-tab-safari` | n/a | 1 | 0 of 1 | 3/3 | 3/3 |
| `native` | n/a | 10 | 6 of 10 | 27/30 | 25/30 |
| `race-firefox` | firefox | 12 | 2 of 12 | 36/36 | 36/36 |
| `race-safari` | safari | 12 | 8 of 12 | 36/36 | 34/36 |
| `release-haiku` | chrome | 13 | 10 of 13 | 65/65 | 65/65 |

Groups left out of the comparison:

| Group | State | Why |
| --- | --- | --- |
| `release-opus` | deferred | `DEFERRED release-opus: comparison awaits completion with --only-groups release-opus` |

<details><summary>as3-firefox: 3 of 5 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `smoke-red` | 15.5 (3/3) | 10.4 (3/3) | -33.0% | no |
| `survey-p09` | 36.6 (3/3) | 42.7 (3/3) | +16.6% | slower |
| `survey-p10` | 30.7 (3/3) | 33.9 (3/3) | +10.6% | slower |
| `ao-moss-color` | 11.6 (3/3) | 10.8 (3/3) | -7.0% | no |
| `ao-cheapest-mug` | 11.8 (3/3) | 13.1 (3/3) | +10.5% | slower |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `smoke-red` | 10.2 [9.8 to 11.1] | 13.6 [13.4 to 19.4] |
| `survey-p09` | 43.0 [41.8 to 43.2] | 35.6 [33.1 to 41.1] |
| `survey-p10` | 30.2 [29.2 to 42.4] | 31.0 [26.5 to 34.7] |
| `ao-moss-color` | 10.0 [9.9 to 12.4] | 9.6 [9.3 to 15.8] |
| `ao-cheapest-mug` | 13.9 [11.4 to 14.0] | 12.0 [10.2 to 13.3] |

</details>

<details><summary>as3-safari: 3 of 5 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `smoke-red` | 16.5 (3/3) | 19.6 (3/3) | +18.8% | slower |
| `survey-p09` | 44.9 (3/3) | 52.0 (3/3) | +15.8% | slower |
| `survey-p10` | 43.2 (3/3) | 41.3 (3/3) | -4.2% | no |
| `ao-moss-color` | 16.2 (3/3) | 12.2 (3/3) | -24.8% | no |
| `ao-cheapest-mug` | 16.0 (3/3) | 18.7 (3/3) | +17.2% | slower |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `smoke-red` | 19.3 [15.9 to 23.4] | 13.8 [12.7 to 22.9] |
| `survey-p09` | 51.8 [50.9 to 53.3] | 43.0 [41.7 to 49.9] |
| `survey-p10` | 43.8 [35.6 to 44.6] | 42.9 [39.3 to 47.3] |
| `ao-moss-color` | 11.3 [10.4 to 14.9] | 14.2 [12.7 to 21.8] |
| `ao-cheapest-mug` | 19.5 [15.4 to 21.2] | 16.1 [14.0 to 17.7] |

</details>

<details><summary>cc-calendar-ambiguous-firefox: 1 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-calendar-ambiguous-firefox` | 4.2 (3/3) | 5.1 (3/3) | +22.4% | slower |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-calendar-ambiguous-firefox` | 5.2 [4.6 to 5.5] | 4.3 [3.8 to 4.4] |

</details>

<details><summary>cc-calendar-ambiguous-safari: 0 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-calendar-ambiguous-safari` | 6.1 (3/3) | 5.3 (3/3) | -13.0% | no |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-calendar-ambiguous-safari` | 5.5 [5.0 to 5.5] | 6.2 [5.6 to 6.6] |

</details>

<details><summary>cc-calendar-firefox: 1 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-calendar-firefox` | 15.3 (3/3) | 20.0 (3/3) | +30.5% | slower |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-calendar-firefox` | 18.3 [15.0 to 26.6] | 14.6 [13.2 to 18.1] |

</details>

<details><summary>cc-calendar-safari: 0 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-calendar-safari` | 12.9 (3/3) | 12.1 (3/3) | -6.2% | no |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-calendar-safari` | 12.6 [9.7 to 14.1] | 12.2 [11.9 to 14.7] |

</details>

<details><summary>cc-dropdown-firefox: 0 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-dropdown-firefox` | 21.2 (3/3) | 17.1 (3/3) | -19.2% | no |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-dropdown-firefox` | 16.2 [15.3 to 19.9] | 20.8 [20.8 to 22.0] |

</details>

<details><summary>cc-dropdown-safari: 0 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-dropdown-safari` | 18.2 (3/3) | 16.6 (3/3) | -9.0% | no |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-dropdown-safari` | 16.2 [15.9 to 17.6] | 16.5 [15.9 to 22.2] |

</details>

<details><summary>cc-dropdown-slow-firefox: 1 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-dropdown-slow-firefox` | 22.6 (3/3) | 26.0 (3/3) | +14.9% | slower |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-dropdown-slow-firefox` | 27.3 [22.6 to 28.0] | 23.1 [21.2 to 23.5] |

</details>

<details><summary>cc-dropdown-slow-safari: 1 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-dropdown-slow-safari` | 17.7 (3/3) | 21.1 (3/3) | +19.2% | slower |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-dropdown-slow-safari` | 21.6 [19.7 to 22.1] | 16.2 [14.1 to 22.9] |

</details>

<details><summary>cc-list-firefox: 1 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-list-firefox` | 25.1 (3/3) | 34.0 (3/3) | +35.4% | slower |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-list-firefox` | 32.1 [31.8 to 38.2] | 28.1 [18.5 to 28.8] |

</details>

<details><summary>cc-list-native: 0 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-list-native` | 57.2 (3/3) | 39.5 (3/3) | -31.0% | no |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-list-native` | 39.0 [21.0 to 58.4] | 54.5 [48.5 to 68.7] |

</details>

<details><summary>cc-list-pop-up-firefox: 0 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-list-pop-up-firefox` | 19.8 (3/3) | 18.3 (3/3) | -7.7% | no |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-list-pop-up-firefox` | 17.7 [16.2 to 20.9] | 15.2 [13.0 to 31.2] |

</details>

<details><summary>cc-list-pop-up-safari: 0 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-list-pop-up-safari` | 14.8 (3/3) | 14.3 (3/3) | -3.6% | no |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-list-pop-up-safari` | 14.3 [13.7 to 14.8] | 15.0 [13.1 to 16.3] |

</details>

<details><summary>cc-list-safari: 0 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-list-safari` | 20.1 (3/3) | 16.9 (3/3) | -15.8% | no |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-list-safari` | 16.8 [15.7 to 18.3] | 21.3 [17.6 to 21.4] |

</details>

<details><summary>cc-new-tab-firefox: 0 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-new-tab-firefox` | 14.5 (3/3) | 12.7 (3/3) | -12.6% | no |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-new-tab-firefox` | 11.8 [11.7 to 14.5] | 13.8 [13.7 to 16.0] |

</details>

<details><summary>cc-new-tab-safari: 0 of 1 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `cc-new-tab-safari` | 15.4 (3/3) | 11.6 (3/3) | -24.3% | no |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `cc-new-tab-safari` | 11.2 [10.6 to 13.1] | 15.6 [14.2 to 16.3] |

</details>

<details><summary>native: 6 of 10 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `textedit-edit` | 15.7 (3/3) | 17.0 (3/3) | +8.3% | slower |
| `finder-rename` | 9.7 (3/3) | 20.5 (2/3) | +110.8% | slower and lower pass rate |
| `finder-create-folder` | 17.6 (3/3) | 24.3 (3/3) | +37.8% | slower |
| `textedit-two-windows` | 24.7 (3/3) | 23.6 (3/3) | -4.3% | no |
| `textedit-window-drag` | no pass (0/3) | 298.3 (1/3) | n/a | no |
| `textedit-replace-save` | 11.2 (3/3) | 10.4 (3/3) | -6.6% | no |
| `textedit-insert-line` | 25.5 (3/3) | 32.4 (3/3) | +27.2% | slower |
| `word-memo` | 87.0 (3/3) | 94.2 (3/3) | +8.3% | slower |
| `word-brief` | 102.7 (3/3) | 60.8 (3/3) | -40.8% | no |
| `textedit-notes-table` | 114.9 (3/3) | 356.3 (1/3) | +210.0% | slower and lower pass rate |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `textedit-edit` | 17.3 [9.1 to 24.5] | 14.0 [9.2 to 23.8] |
| `finder-rename` | 10.5 [10.5 to 11.1] | 9.8 [9.4 to 9.9] |
| `finder-create-folder` | 19.5 [17.8 to 35.6] | 16.9 [16.1 to 19.9] |
| `textedit-two-windows` | 21.6 [14.8 to 34.5] | 21.7 [17.8 to 34.6] |
| `textedit-window-drag` | 97.3 [97.3 to 97.3] | no passes |
| `textedit-replace-save` | 10.4 [9.4 to 11.5] | 10.9 [8.6 to 14.0] |
| `textedit-insert-line` | 20.7 [19.7 to 56.8] | 22.6 [22.2 to 31.6] |
| `word-memo` | 97.5 [85.6 to 99.5] | 78.3 [60.3 to 122.3] |
| `word-brief` | 63.3 [53.7 to 65.4] | 97.0 [77.8 to 133.3] |
| `textedit-notes-table` | 133.7 [133.7 to 133.7] | 131.8 [64.1 to 148.9] |

</details>

<details><summary>race-firefox: 2 of 12 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `form-travel` | 80.4 (3/3) | 60.0 (3/3) | -25.4% | no |
| `form-settings` | 100.8 (3/3) | 77.4 (3/3) | -23.2% | no |
| `form-checkout` | 51.3 (3/3) | 49.0 (3/3) | -4.4% | no |
| `form-settings-helium` | 85.6 (3/3) | 89.9 (3/3) | +5.0% | slower |
| `shipping-link` | 15.8 (3/3) | 14.5 (3/3) | -8.2% | no |
| `size-guide` | 17.3 (3/3) | 16.4 (3/3) | -5.2% | no |
| `demoid` | 18.7 (3/3) | 20.0 (3/3) | +6.8% | slower |
| `handoff` | 25.4 (3/3) | 24.3 (3/3) | -4.2% | no |
| `inject-order` | 26.5 (3/3) | 24.0 (3/3) | -9.6% | no |
| `inject-mail` | 24.4 (3/3) | 23.0 (3/3) | -5.7% | no |
| `wikipedia` | 14.7 (3/3) | 14.4 (3/3) | -1.8% | no |
| `mdn` | 16.0 (3/3) | 12.7 (3/3) | -20.6% | no |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `form-travel` | 58.7 [56.3 to 64.9] | 70.2 [63.3 to 107.5] |
| `form-settings` | 78.2 [75.0 to 79.1] | 104.2 [85.1 to 113.2] |
| `form-checkout` | 45.1 [43.7 to 58.3] | 51.9 [44.4 to 57.5] |
| `form-settings-helium` | 88.6 [83.6 to 97.4] | 83.9 [80.0 to 92.8] |
| `shipping-link` | 15.0 [11.5 to 16.9] | 15.7 [15.1 to 16.5] |
| `size-guide` | 16.2 [16.0 to 17.0] | 16.8 [16.4 to 18.6] |
| `demoid` | 15.8 [15.1 to 29.1] | 19.4 [17.2 to 19.5] |
| `handoff` | 25.1 [21.2 to 26.6] | 26.1 [22.3 to 27.8] |
| `inject-order` | 23.8 [23.6 to 24.6] | 23.1 [22.5 to 33.9] |
| `inject-mail` | 23.5 [19.2 to 26.4] | 25.5 [17.5 to 30.2] |
| `wikipedia` | 14.4 [14.3 to 14.5] | 13.8 [12.6 to 17.6] |
| `mdn` | 12.1 [12.0 to 14.0] | 15.7 [13.9 to 18.3] |

</details>

<details><summary>race-safari: 8 of 12 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 3 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `form-travel` | 69.7 (3/3) | 68.4 (3/3) | -1.8% | no |
| `form-settings` | 152.4 (3/3) | 507.1 (1/3) | +232.7% | slower and lower pass rate |
| `form-checkout` | 62.4 (3/3) | 60.3 (3/3) | -3.4% | no |
| `form-settings-helium` | 141.9 (3/3) | 130.3 (3/3) | -8.1% | no |
| `shipping-link` | 16.1 (3/3) | 14.7 (3/3) | -8.8% | no |
| `size-guide` | 19.3 (3/3) | 19.5 (3/3) | +1.5% | slower |
| `demoid` | 20.3 (3/3) | 22.8 (3/3) | +12.1% | slower |
| `handoff` | 23.4 (3/3) | 23.5 (3/3) | +0.8% | slower |
| `inject-order` | 24.7 (3/3) | 26.1 (3/3) | +5.4% | slower |
| `inject-mail` | 19.8 (3/3) | 26.8 (3/3) | +35.4% | slower |
| `wikipedia` | 16.8 (3/3) | 22.9 (3/3) | +36.1% | slower |
| `mdn` | 14.8 (3/3) | 15.6 (3/3) | +5.7% | slower |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `form-travel` | 70.5 [63.7 to 71.1] | 65.5 [61.8 to 81.7] |
| `form-settings` | 180.7 [180.7 to 180.7] | 145.5 [104.2 to 207.6] |
| `form-checkout` | 57.1 [53.4 to 70.2] | 61.0 [52.7 to 73.5] |
| `form-settings-helium` | 129.2 [123.1 to 138.7] | 146.0 [104.2 to 175.5] |
| `shipping-link` | 14.9 [13.8 to 15.3] | 15.1 [15.0 to 18.1] |
| `size-guide` | 19.0 [18.4 to 21.2] | 18.8 [18.8 to 20.2] |
| `demoid` | 23.2 [20.4 to 24.8] | 21.5 [17.4 to 22.0] |
| `handoff` | 23.9 [21.3 to 25.4] | 22.9 [22.1 to 25.1] |
| `inject-order` | 25.4 [25.4 to 27.5] | 25.2 [22.9 to 26.1] |
| `inject-mail` | 21.6 [19.9 to 38.9] | 19.3 [19.0 to 21.1] |
| `wikipedia` | 20.1 [16.5 to 32.1] | 17.0 [16.1 to 17.4] |
| `mdn` | 14.4 [13.0 to 19.6] | 14.3 [14.0 to 16.0] |

</details>

<details><summary>release-haiku: 10 of 13 tasks marked</summary>

Each cell is expected seconds, then passes/runs. Build A had 5 rounds on `claude-haiku-5-5`.

| Task | Build A | Build B | Change in expected time | Marked |
| --- | --- | --- | --- | --- |
| `form-travel` | 52.1 (5/5) | 54.6 (5/5) | +4.8% | slower |
| `form-settings` | 22.6 (5/5) | 24.5 (5/5) | +8.4% | slower |
| `form-checkout` | 29.1 (5/5) | 30.3 (5/5) | +4.2% | slower |
| `form-settings-helium` | 21.9 (5/5) | 28.5 (5/5) | +30.6% | slower |
| `shipping-link` | 9.4 (5/5) | 9.0 (5/5) | -3.8% | no |
| `size-guide` | 10.5 (5/5) | 10.9 (5/5) | +3.6% | slower |
| `demoid` | 12.7 (5/5) | 13.2 (5/5) | +3.8% | slower |
| `mobile` | 10.6 (5/5) | 10.5 (5/5) | -1.0% | no |
| `handoff` | 15.6 (5/5) | 16.1 (5/5) | +3.4% | slower |
| `inject-order` | 15.9 (5/5) | 15.1 (5/5) | -4.8% | no |
| `inject-mail` | 14.6 (5/5) | 16.7 (5/5) | +14.2% | slower |
| `wikipedia` | 5.5 (5/5) | 6.1 (5/5) | +11.8% | slower |
| `mdn` | 5.6 (5/5) | 6.8 (5/5) | +21.5% | slower |

| Arm | Model ids in the runs | Effort | Versions recorded | Build |
| --- | --- | --- | --- | --- |
| build B (new) | `claude-haiku-5-5` | not recorded | not recorded | `56d625e3` |
| build A (earlier) | `claude-haiku-5-5` | not recorded | not recorded | `ed484d76` |

Passing runs, median [fastest to slowest]:

| Task | build B (new) | build A (earlier) |
| --- | --- | --- |
| `form-travel` | 54.4 [48.2 to 58.5], p90 58.5 | 55.0 [45.1 to 56.2], p90 56.2 |
| `form-settings` | 23.5 [21.7 to 30.2], p90 30.2 | 20.8 [18.7 to 31.4], p90 31.4 |
| `form-checkout` | 28.7 [27.9 to 34.3], p90 34.3 | 29.1 [25.0 to 33.6], p90 33.6 |
| `form-settings-helium` | 25.9 [23.8 to 36.9], p90 36.9 | 21.1 [19.2 to 25.0], p90 25.0 |
| `shipping-link` | 9.1 [8.1 to 10.0], p90 10.0 | 9.3 [7.4 to 11.4], p90 11.4 |
| `size-guide` | 10.6 [9.8 to 11.9], p90 11.9 | 10.3 [9.4 to 12.0], p90 12.0 |
| `demoid` | 12.6 [9.5 to 16.9], p90 16.9 | 12.5 [9.4 to 14.8], p90 14.8 |
| `mobile` | 10.3 [9.6 to 12.1], p90 12.1 | 10.5 [9.7 to 11.9], p90 11.9 |
| `handoff` | 15.9 [15.2 to 17.1], p90 17.1 | 14.8 [14.4 to 18.6], p90 18.6 |
| `inject-order` | 15.0 [13.1 to 17.5], p90 17.5 | 14.5 [13.6 to 19.0], p90 19.0 |
| `inject-mail` | 17.6 [11.6 to 19.3], p90 19.3 | 16.3 [8.7 to 19.4], p90 19.4 |
| `wikipedia` | 5.7 [5.4 to 7.3], p90 7.3 | 5.6 [5.0 to 6.0], p90 6.0 |
| `mdn` | 6.0 [5.6 to 10.5], p90 10.5 | 5.0 [4.8 to 6.8], p90 6.8 |

</details>

<details><summary>Banks without a score (6)</summary>

These folders have a plan and no score file, so they are aborted attempts or runs still going.

| Bank | Kind | Groups planned |
| --- | --- | --- |
| `validation-140-final-try1-check-stop` | validation | 22 |
| `validation-140-final-try2-chrome-stop` | validation | 22 |
| `validation-140-final-try3-word-stop` | validation | 22 |
| `validation-140-final-try4-word-stop` | validation | 22 |
| `validation-140-final-try5-textedit-stop` | validation | 22 |
| `validation-140-final-try6-heap-flake` | validation | 22 |

</details>

[data/validation.json](data/validation.json) has every counted run and the scored cells, and the [interactive page](https://land-o-clusters.github.io/sleight/results/explore.html) charts them. Rebuild every page with `node bench/results-hub.mjs`.

[Benchmarks](README.md) · [Native](native-claim.md) · [Apps](app-claim.md) · [Chrome and Helium](browser-turbo.md) · [Safari and Firefox](browser-race.md) · [Experiments](ab-tests.md) · Validation · [Releases](release-passes.md) · [Insights](insights.md) · [Interactive](https://land-o-clusters.github.io/sleight/results/explore.html)
