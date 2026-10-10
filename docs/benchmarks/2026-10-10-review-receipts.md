# Turn receipts and unsaved review

Branch: `codex/review-receipts`. Base: `332e3ca` on `pane/auto-mode`.
Publication target: private `Land-o-Clusters/sleight-dev`, per the current project rule.
[Raw results](2026-10-10-review-receipts.json) include the failed and blocked attempts.

## Scope

Receipts record recognized actions, targets, call outcomes and changes from existing reads.
They redact literal inputs and keep their lengths. Unsaved review is off by default. It names
observed native Undo or Revert controls for the user to use in the app, with the review also
available through the pane's receipt link.

## Privacy and review tests

The recorded trace audit read 27 files and 229 calls. It didn't find leaked literal input, but all
229 code fields were truncated before their input literals. There were zero inputs to check,
and the audit couldn't verify their redaction. Synthetic tests cover typing, paste, values,
computed inputs, error echoes, owner-name normalization and optional title redaction.

The focused receipt and relay tests passed 30/30. Earlier regression tests failed before the
fixes for pending first-call mutations, omitted calls and method-like text in regular expressions.
Pane tests passed 12/12 after their initial expected failure. Review also caught stale final
reads, wrong app attribution and document text mistaken for a native Undo control; tests cover
those cases. Idle cleanup keeps its receipt metadata for the pane's later cleanup call, without
writing a duplicate. Fixture tests verify that strict cleanup refuses save-dialog answers,
other app dialogs and the menu's Escape fallback. They failed before the fixes, then passed.
Receipt writes are tested for private modes and symlink refusal.
Reused request IDs count toward the retention limit, and duplicate replies don't retain extra
events. Both regression tests failed before the fix and passed afterward.
The existing clipboard-lock test also failed in isolation. Retaining its SQLite transaction
owner until child exit fixed the fixture, with 2/2 tests passing. Assertions and deadlines
remain unchanged. This correction came from the verified-results lane.

## Cost

The offline measurements used seven samples of 2,000 calls after one warmup in each run. The first median
CPU time to retain request and result references was 0.21 microseconds per call (range 0.15 to
0.60). After fixing the retention bound, the median was 0.36 microseconds (range 0.09 to 1.28).
Parsing, comparison and redaction run at turn end. They used 55 to 95 ms of CPU per sample in
the first run and 45 to 80 ms in the second. Wall time was 620 to 1,532 ms in the first run,
while another run held the live lock, and 46 to 112 ms in the second. These runs aren't a
controlled comparison. The capture cost is nonzero. It misses the prompt's literal CPU bar.
These samples measure capture and turn-end parsing only.
Engine work and disk writes are outside the measurement, and we haven't measured Codex here.
The relay tests return the same engine-call count with receipts enabled and disabled.

## Live attempts

The first attempt stopped at an existing `/tmp/sleight-live.lock`, exited 1 and made zero
engine calls. After the hold cleared, a sandbox attempt exited 1 because its permission
observer couldn't inspect processes. It didn't call the engine.

The host run then exited 0, with all nine assertions passing in six seconds on engine
26.1007.21159. It read Calculator and edited a temporary TextEdit document after checking its
file URL. The receipt kept the input length and omitted both text values. Its mode was 0600.
The run detected the changed window and returned the pane's receipt metadata. A second turn restored the
buffer with Undo. The harness reported cleanup complete and engine exit 0.
A repeat after the retention fix also exited 0, with all nine assertions passing in 3.9 seconds.
Its fixture cleanup and engine exit were clean too. Both runs held the live lock.
This checks the link's metadata, not a click in the rendered pane. No native revert label was
present in these reads. That offer has unit coverage only.

## Required checks

The initial sandbox baseline exited 1 after native compilation timeouts and denied worktree
writes and sockets. It was interrupted once through its original terminal, and the final exit
was collected. The output was truncated, so no test total is claimed for that run. A second check
was stopped through its terminal to apply the final review fixes. Its exit was 1 too. The first
prose lint exited 2 because the worktree lacked its style package. `vale sync` then installed the
repository's pinned package, after its sandbox attempt failed.
The first completed full check exited 1: 1,151 tests passed and 18 failed, with none cancelled.
Failures included native compilation and process timing tests during heavy host load. The
receipt tests passed. A later retry overlapped other suites that restarted and exited 1, with
1,159 tests passed and 12 failed. The raw results retain the failure names and errors.

After coordinating one full suite at a time, the final bare `npm run check` exited 0.
All 1,171 tests passed in 140.5 seconds. Both manifest validations and all 12 mod tests passed.
Prose lint exited 0 with no findings across 71 files before this final result update. The raw
results record every check and prose-lint exit code, including validation of this final text.
