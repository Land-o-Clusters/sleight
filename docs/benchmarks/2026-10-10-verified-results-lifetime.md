# Verified results memory, reset and degraded reads

Follow-up to `62207a6`, first rebased onto private `pane/auto-mode` at `33c4ddd`, then `d8c2dbf`
after the hold. The later base includes `8e9e201` and shares the benchmark helpers' Swift module cache. Rebase conflicts
in the changelog and prose list retain both branches' entries, including the windows design and
replay reports. Publication goes to the private repository.

Observation comparisons now use a counter, which removes the link retaining every earlier tree.
Reset and engine restart clear result attribution while retaining numbered-element history for
the guard. Unknown root roles and missing URLs report `UI unverified (degraded read)` before a
window or element change can be claimed. The abbreviated Save fixture keeps its header and
root, with the sidebar removed. No apps were driven, and no screenshots or live engine probes ran.

## Attempts

| Check | Result |
|---|---|
| First private rebase | Exit 1, prose-list conflict in the first commit. |
| Rebase continuation | Exit 1, prose-list conflict in the second commit. |
| Rebase after retaining both lists | Exit 0. |
| New lifetime and relay regressions before fixes | Exit 1, 5/12 passed. Memory retention, reset, degraded roots and sidebar evidence failed. |
| Engine-restart regression with an inventory reply | Exit 1, 0/1 passed. The call lost its cached line for element 14. |
| Lifetime, relay, previous review, result and compactor suites after fixes | Exit 0, 66/66 passed. |
| CPU runner syntax check | Exit 0. |
| First loaded CPU run | Exit 0. Six cases, five paired samples per case, before the repeated-read fix. |
| Independent-review regression before its fix | Exit 1, 0/1 passed. Repeated URL-less observations hid URL loss. |
| Reset, degraded-read and sidebar regressions after that fix | Exit 0, 5/5 passed. |
| Second loaded CPU run | Interrupted during the chat turn. One before-arm sample was retained; the terminal handle was unavailable on resume, so no exit status was collected. |
| First required `npm run check` | Exit 1 after one terminal interrupt. 1,131 passed, 55 failed and 1 was cancelled. Socket tests reported sandbox `listen EPERM`. A linker could not write its worktree output. Native compiles timed out at 180 seconds. Short helper deadlines also failed under load. |
| First required `npm run lint:prose` | Exit 1, four errors in 74 files. Wording corrected. |
| Host-access `npm run check` | Exit 1 after one terminal interrupt. 1,175 passed, 11 failed and 1 was cancelled. The socket permission failures cleared. Native compiles still timed out at 180 seconds, and short helper deadlines failed while host load reached 260. |
| Final-source loaded CPU run | Exit 0. All six cases retained five paired samples. |
| Idle CPU attempt | Exit 1 before sampling: `sleight-hold exists; CPU work stopped`. One-minute load was 180.56. |
| Prose check after the hold | Exit 1, three errors in 74 files. Wording corrected. |
| Rebase onto `8e9e201` | Each replayed commit stopped with exit 1 for changelog and prose-list conflicts. Continuation exited 0. Restoring the saved changes needed another prose-list resolution. |
| Full check on `8e9e201` | Exit 1 without interruption. 1,195/1,196 passed, with no cancellations. Native compilation completed. The clipboard process-exit fixture failed its contention assertion. |
| Clipboard process-exit test alone | Exit 1, 1/2 passed, with the same missing-exception failure. |
| Clipboard test after retaining its transaction owner | Exit 0, 2/2 passed. The fixture keeps its coordinator reachable until process exit. |
| Prose checks with the later base and fixture report | Both exited 1, each with one wording error in 76 files. Corrected. |
| Full check after the clipboard fixture repair | Exit 1 without interruption. 1,190/1,196 passed, with no cancellations. The clipboard test passed. The background-drag and Chess native compiles timed out at 180 seconds. Helper tests for target resolution, doctor collection, process-group collection and app health missed short deadlines. Sampled one-minute load was 54.5 to 64.7 during concurrent lane checks. |
| Prose check after those wording corrections | Exit 0. Checked 76 files. |
| Prose check after adding the check result and queue status | Exit 1, one wording error in the added result row. Corrected. |
| Prose check after correcting that result row | Exit 0. Checked 76 files. |
| Serialized `npm run check` | Exit 0. All 1,196 unit tests, both manifest validations and 26 mod tests passed. Unit tests took 126.5 seconds. Sampled one-minute load was 25.0 to 30.9. |
| Idle comparison after the serialized checks | Exit 1 when load rose from 9.45 to 10.14. The 300-line unchanged case completed, and the one-value case retained partial samples. |
| Immediate idle retry | Exit 1 before sampling at load 11.28. |
| Idle comparison after Puddle window 1010b | Exit 0. All six cases retained five paired samples. Sampled one-minute load ranged from 5.33 to 6.12. |

Independent review found that a URL-less observation could replace the trusted baseline inside
one reply, hiding the URL loss in its later guard read. The fix keeps the trusted observation
through the reply. The regression covers joined and separate text items, repeated guard reads,
and the full-read override.

The clipboard fixture now retains its coordinator on the child process's global object. Its
module-local reference could otherwise become unreachable after module evaluation. The child
still exits without releasing the transaction. The test checks cleanup on process exit.
The isolated failure and pass above cover this fixture change. Production clipboard code is unchanged.

## Retained memory

The child harness collects memory before and after 400 actions using Node's `--expose-gc`.
The harness retains the compactor through the final collection. Each action changes one value in a 3,000-line tree.
The test bounds the increase below 12 MiB, which allows collector variation while rejecting the
old chain. These figures use decimal MB.

| Code | Before | After 400 actions | Increase |
|---|---:|---:|---:|
| Reviewed feature | 4.364 | 97.676 | 93.312 |
| Counter identity | 4.367 | 5.091 | 0.723 |
| Counter identity in the failed full check | 4.367 | 5.016 | 0.648 |
| Counter identity in the host-access check | 4.366 | 4.933 | 0.567 |
| Counter identity after the later rebase | 4.367 | 4.917 | 0.550 |
| Counter identity in the passing full check | 4.367 | 4.956 | 0.589 |

The cache still retains the current tree and element history for each window, as it did before
the feature. This test bounds accumulation within one window, not the number of distinct windows.

## CPU measurement

`node bench/verified-results-cost.mjs idle` and `loaded` compare the pre-feature compactor from
`33c4ddd` with the revised source. Both arms run in one Node process, alternate their order across
five paired samples, and warm up for 20 calls before each sample. Only `process()` is timed with
user plus system CPU. Imports, tree construction, action classification and report writes are
outside the timing. The measurement uses 300-line and 3,000-line trees, with unchanged, one-value
and all-label changes. The wide case includes the existing quadratic alignment.

The `idle` mode requires one-minute host load below 10, and `loaded` requires at least 10, checked throughout
each sample. Samples use the existing host load. Measurement stops while `/tmp/sleight-hold` exists.
Actual load, user/system samples and source hashes are retained for every attempt.
The host's one-minute load was 153 to 187 during preparation. A later idle run completed at load 5.33 to 6.12.

The first loaded run preceded the repeated-read fix. Its sampled one-minute load ranged from
59.5 to 151.8. Median CPU milliseconds per call were:

| Lines | Tree case | Before feature | Revised feature | Added CPU |
|---|---|---:|---:|---:|
| 300 | Unchanged | 0.267 | 0.361 | 0.094 |
| 300 | One value | 0.257 | 0.653 | 0.395 |
| 300 | All element labels | 0.805 | 2.501 | 1.696 |
| 3,000 | Unchanged | 2.542 | 2.637 | 0.095 |
| 3,000 | One value | 2.578 | 2.621 | 0.043 |
| 3,000 | All element labels | 55.277 | 62.279 | 7.002 |

The final-source run measured one-minute loads from 194.7 to 303.5:

| Lines | Tree case | Before feature | Revised feature | Added CPU |
|---|---|---:|---:|---:|
| 300 | Unchanged | 0.355 | 0.330 | -0.024 |
| 300 | One value | 0.370 | 0.690 | 0.320 |
| 300 | All element labels | 1.064 | 1.903 | 0.838 |
| 3,000 | Unchanged | 3.460 | 3.558 | 0.098 |
| 3,000 | One value | 3.522 | 3.598 | 0.077 |
| 3,000 | All element labels | 62.460 | 72.304 | 9.844 |

The final-source idle run completed at 10:55:41 UTC with terminal exit 0. Every sample passed the
load guard, and sampled one-minute load ranged from 5.33 to 6.12:

| Lines | Tree case | Before feature | Revised feature | Added CPU |
|---|---|---:|---:|---:|
| 300 | Unchanged | 0.153 | 0.154 | 0.0002 |
| 300 | One value | 0.168 | 0.363 | 0.196 |
| 300 | All element labels | 0.521 | 1.690 | 1.169 |
| 3,000 | Unchanged | 1.626 | 1.709 | 0.083 |
| 3,000 | One value | 1.674 | 1.744 | 0.070 |
| 3,000 | All element labels | 38.453 | 42.024 | 3.571 |

[Raw CPU data](2026-10-10-verified-results-cost.json) retains both completed loaded runs, the interrupted
attempt and all idle attempts. The final source hash matches the worktree compactor.
The figures vary by tree case, so 0.7 ms is not a general per-call cost. Under idle load, unchanged
and one-value cases added at most 0.196 ms, while all-label changes added 1.169 to 3.571 ms.
The small negative unchanged delta under load did not recur in the idle run and establishes no speed gain.
This measures the compactor alone, not total
relay CPU, engine time or model turns.

## Check history and release checks

The loaded run finished at 06:14:54 UTC. At 06:15:30, sleight-arch placed a load hold for Puddle's
Spend gate and lanes, to remain until load is below 20 or Puddle's architect clears it. The idle
attempt at 06:15:55 stopped before collecting a sample. The hold was gone when the owner resumed
work at 07:03 UTC. Checks resumed on the later base. The clipboard fixture repair passed in
isolation and in the next full run, but native compile and helper deadlines failed during concurrent
lane checks. Receipt-review coordinated one full check at a time under the owner's authorization.
The serialized check passed at 07:49 UTC, and its slot was released to simulation savelock.
The idle CPU sample requires load below 10. Load was still 30.9 after the passing check.
A later quiet gap reached 9.45, but load crossed 10 during the second case. The retry stopped
before sampling at 11.28. Both failures are retained. The unused gap was released to the next
queued checks, which have a direct request to wake this chat when they finish.
After those checks released their slots, a new Puddle hold was set at 08:19 UTC for window 1010b.
The hold was absent at 10:25 UTC, but load remained above the starting threshold of 8.
At 10:55 UTC, load was 5.36 and the idle comparison started. It completed all six cases with
five paired samples each and terminal exit 0. All seven CPU attempts remain in the raw report.

Before release, sleight-arch runs Calculator, TextEdit, Chess and a Safari form with these result notes.
