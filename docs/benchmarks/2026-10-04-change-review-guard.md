# Change review guard, 2026-10-04

Branch `codex/change-review-guard` starts at `8723d80`. The guard permits
same-app dialogs without file URLs. A fresh read can capture a later undo copy
for a file first discovered after an action. Regression tests replay the two
failed TextEdit sequences from the `945ccf6` benchmark.
It was then rebased onto `b1a0556`, retaining input leases and their read classifier.
The combined regression opens an Open dialog, types a path in its sheet, and
refuses further input if its lease token has been replaced.

`node bench/change-review.mjs` uses the default setting and two temporary
TextEdit files. The user chooses Undo for the UNDO file and Keep for the KEEP
file. The harness checks saved contents and deletion of session backups.

The first attempt failed before opening TextEdit, with sandbox error -2700.
The second changed both files and showed their diffs. The Undo panel timed out
without a user decision. The remaining Keep panel was interrupted through the
owned terminal. Session backup deletion passed.
The third attempt, after the rebase, timed out on its first TextEdit read before
any approval panel appeared. No file changed. The launcher collected its engine.
The live Undo/Keep check is pending a restart of ChatGPT.

[Results](2026-10-04-change-review-guard.json) preserve attempts 1, 2 and 3, including
their full harness results and relevant relay events. Home paths use `~`.
Vendor API documentation is omitted. Dialog recovery is covered by unit tests.
`bench/run.mjs` was not run, because sleight-arch runs that pass at merge.
