# Turn study, 2026-10-11

The offline sample covers 2026-10-10 00:00 EDT through 2026-10-11 00:44:26 EDT.
The specified cache held 90 transcripts in that range, all starting on 2026-10-10 EDT.
Of those, 65 contain 386 calls. The other 25 contain no calls. All 65 with calls match benchmark result rows.
Three more match without calls. The other 22 have no matching row.

The 11 classes mark 105 distinct calls in 42 runs: 234.843 s before calls plus 162.178 s
inside calls, totaling 397.021 s. All 386 calls total 1,548.818 attributed seconds.
All 386 have both timestamps. These are candidate costs. Actual savings need a live comparison.
Classes overlap, so their rows must not be added together.

The [raw JSON](2026-10-11-turn-study.json) lists every call's times, byte counts and classes,
with no transcript text or input code. `bench/turn-study.mjs` accepts `--since` and `--until`
or `--results`, and writes `--json` and `--table` outputs. This sample read results from
`~/Projects/sleight/bench/results/` and the worktree's `docs/benchmarks/`.

Run matching used 36 exact prompt paths, 17 first-call code and trace timestamp pairs within
2 s, and 15 exact four-number usage fingerprints. Result copies are deduplicated by pass,
arm, task and repetition. There are 435 result rows in the range. Of those, 68 matched and 367
have no transcript in this cache. The missing rows include 283 sleight and 10 LCU runs.
Codex accounts for the other 74. Missing transcripts contribute 0 s.

| Class | Runs | Calls | Gap s | Call s | Attributed s |
| --- | ---: | ---: | ---: | ---: | ---: |
| consecutive-read | 22 | 30 | 59.628 | 16.670 | 76.298 |
| wait-after-save | 10 | 11 | 26.378 | 49.638 | 76.016 |
| preliminary-inventory | 22 | 22 | 49.414 | 24.398 | 73.812 |
| spilled-result | 4 | 13 | 41.300 | 27.469 | 68.769 |
| spill-filter-followup | 4 | 10 | 31.694 | 12.243 | 43.937 |
| lease-or-guard-refusal | 8 | 9 | 34.163 | 7.572 | 41.735 |
| split-menu-click | 9 | 11 | 15.381 | 18.437 | 33.818 |
| explicit-delay | 4 | 4 | 7.700 | 21.902 | 29.602 |
| refused-tool | 3 | 4 | 8.895 | 0.006 | 8.901 |
| nonexistent-method | 6 | 6 | 5.517 | 2.615 | 8.132 |
| saved-unconfirmed-read | 2 | 2 | 4.345 | 1.524 | 5.869 |

| Task | Class | Runs | Calls | Gap s | Call s | Attributed s |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| textedit-save | wait-after-save | 10 | 11 | 26.378 | 49.638 | 76.016 |
| textedit-save | spilled-result | 4 | 13 | 41.300 | 27.469 | 68.769 |
| textedit-save | spill-filter-followup | 4 | 10 | 31.694 | 12.243 | 43.937 |
| textedit-save | lease-or-guard-refusal | 8 | 9 | 34.163 | 7.572 | 41.735 |
| textedit-save | consecutive-read | 4 | 8 | 30.574 | 9.408 | 39.982 |
| textedit-save | split-menu-click | 9 | 11 | 15.381 | 18.437 | 33.818 |
| iphone-mirroring-settings | preliminary-inventory | 10 | 10 | 22.449 | 9.863 | 32.312 |
| iphone-mirroring-settings | explicit-delay | 4 | 4 | 7.700 | 21.902 | 29.602 |
| calculator-click | preliminary-inventory | 7 | 7 | 16.880 | 8.068 | 24.948 |
| iphone-mirroring-settings | consecutive-read | 10 | 14 | 18.888 | 3.773 | 22.661 |
| textedit-save | preliminary-inventory | 4 | 4 | 8.544 | 5.369 | 13.913 |
| calculator-click | consecutive-read | 7 | 7 | 9.085 | 3.144 | 12.229 |
| textedit-edit | nonexistent-method | 6 | 6 | 5.517 | 2.615 | 8.132 |
| textedit-edit | refused-tool | 2 | 3 | 6.375 | 0.005 | 6.380 |
| textedit-save | saved-unconfirmed-read | 1 | 1 | 2.243 | 1.342 | 3.585 |
| textedit-edit | preliminary-inventory | 1 | 1 | 1.541 | 1.098 | 2.639 |
| textedit-save | refused-tool | 1 | 1 | 2.520 | 0.001 | 2.521 |
| textedit-edit | saved-unconfirmed-read | 1 | 1 | 2.102 | 0.182 | 2.284 |
| textedit-edit | consecutive-read | 1 | 1 | 1.081 | 0.345 | 1.426 |

The 13 persisted results were read from each session's result directory. Their text
ranged from 55,742 to 87,773 UTF-8 bytes. Filtering follow-ups accounted for 43.937 s across 10 calls.
The 11 save-wait calls took 49.638 s, with another 26.378 s before them.
The new classes are filtering after a spill, preliminary inventory, and explicit delay.
Their rules, together with the eight requested classes, are in the raw JSON.

All 18 synthetic tests failed before the behavior they cover was added and passed afterward.
The first `npm run check` exited 1 under the sandbox, which denied sockets, process inspection
and worktree writes. With host access it exited 0: 1,775 Node tests and 30 mod tests passed,
and both plugin manifests validated. The first `npm run lint:prose` exited 1 with 9 flags in
the new prose. After correction it exited 0 with 0 flags across 120 files.
No apps or engine were started for this study. Measurement limits are in
[Known problems](../known-problems.md#turn-study).

Sleight-arch must compare both versions on the same tasks and show fewer classified calls and
attributed seconds. Every task check must pass. TextEdit must save the exact contents and close
its document. Lease and stale-element refusals must remain. The comparison must report turns, total seconds,
model seconds and model seconds per turn for both versions. No reduction has been verified here.
