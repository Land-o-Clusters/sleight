# Verified results review fixes

Follow-up to `3a5fa3e`, rebased onto `6c54e4b` from `origin/pane/auto-mode`.
The rebase needed a prose-list conflict resolution that kept both branches' additions.

The review found that a different file URL could confirm saving and that deleting a value could
look like a degraded read. It also requested Chess element changes, shorter output and a CPU measurement.
Regression tests precede the code changes. No live app tasks are run in this branch.

## Evidence

The Chess fixture comes from `2026-10-10T01-18-07-983Z/sleight-chess-drag-1/trace-24573.jsonl`,
replies 3 and 10. The trace abbreviates long strings. Matching tool-use IDs locate the full replies
in Claude session `654541dc-0a65-43d7-b535-0c5e889be9ac`. The fixture's after-tree applies the
recorded compacted diff to the recorded full tree: the e2 pawn becomes an empty square and the
e4 square gains the pawn. It also retains the recorded document-action label changes.

TextEdit save and replacement fixtures match replies from the same pass, with session and trace
coordinates in `tests/fixtures/verified-results-review.json`. The Save-panel fixture keeps the
header and named controls. The document trees are complete, apart from the focused-element footer
and image references. The deletion regression clears the value in the recorded replacement tree,
which is a controlled variation. Owner names are scrubbed and paths normalized.
The Save-panel fixture normalizes the recorded folder and file URL to the same `/tmp` path.
The recorded `/var` folder and `/private/var` URL would remain unconfirmed in production.
The positive test covers an exact URL match and does not qualify filesystem alias resolution.

Independent review found that a leading string in a computed argument could be mistaken for a
literal Save target, and that the Chess test also depended on document-label changes. New failing
tests reproduce both cases. Complete literal arguments are now required, and the recorded pawn
square changes alone produce the element observation.

## Attempts

| Check | Result |
|---|---|
| First review regression suite | Exit 1, 0/12 passed. All six requested behavior changes were absent. |
| First CPU baseline run | Exit 1. Sandbox refused writing the worktree report with EPERM. Samples were not retained. The script now stages data under `/private/tmp`. |
| CPU baseline with temporary staging | Exit 0. Retained 5 samples for each of three 3,000-line cases. |
| Review regressions after fixes | Exit 0, 12/12 passed. |
| First affected suite after fixes | Exit 1, 236/265 passed. Twenty-nine assertions still expected the old output or the save-identity and renamed-label behavior rejected by the review. |
| Affected suite after updating assertions | Exit 1, 262/265 passed. The remaining assertions had escaped the wording and behavior update. They were corrected to retain the intended coverage. |
| Affected suite after correcting the remaining assertions | Exit 0, 265/265 passed. |
| Revised CPU run | Exit 0. Retained 5 samples for each case. |
| Compactor without the feature | Exit 0. Retained 5 samples for each case. |
| First prose check | Exit 1, 16 errors in 72 files. Wording corrected. |
| Independent-review regressions before fixes | Exit 1, 12/14 passed. Computed Save arguments and isolated Chess squares failed. |
| Independent-review regressions after fixes | Exit 0, 14/14 passed. |
| Compactor, result, lease, element and document-scope suites after review | Exit 0, 140/140 passed. |
| Revised CPU run after independent-review fixes | Exit 0. Retained 5 samples for each case. |
| Second prose check | Exit 1, 2 errors in 72 files. Wording corrected. |
| Required `npm run check` | Exit 0. All 1,178 unit tests and 11 mod tests passed, with both manifests validated. |
| Required `npm run lint:prose`, including report verification | Exit 0. No errors, warnings or suggestions in 72 files. |

## CPU measurement

`node bench/verified-results-process.mjs baseline`, `revised` and `pre-feature` ran without an
engine or apps. Each tree has 3,000 lines. Samples (5 per case) follow 20 warmup calls per sample.
Unchanged and one-value cases time 100 calls per sample. The all-label case times 10 calls.
Each call alternates the two input trees. The table reports median CPU milliseconds per `process()`
call, from user plus system CPU. Setup, imports, action classification and file writes are outside
the measurement. The wide-change case includes the existing quadratic alignment and full-tree fallback.

| Tree case | Without feature (`f7392be`) | Reviewed feature (`3a5fa3e`) | Revised feature |
|---|---:|---:|---:|
| Unchanged | 2.446 | 2.873 | 2.482 |
| One value changed | 2.514 | 2.705 | 4.455 |
| All element labels changed | 47.051 | 52.160 | 46.822 |

Raw user/system samples, source hashes and runtime details are in
[the CPU data](2026-10-10-verified-results-cpu.json). The first revised run measured the one-value
case at 2.525 ms. The final revision measured 4.455 ms, above the reviewed feature's 2.705 ms.
Variation between samples and separate processes prevents claiming a speedup or zero added cost.
This measures the compactor alone, not total relay
CPU, engine time or model turns. No extra engine read, screenshot or native probe was added.

Before release, sleight-arch runs Calculator, TextEdit, Chess and a Safari form with the revised output.
