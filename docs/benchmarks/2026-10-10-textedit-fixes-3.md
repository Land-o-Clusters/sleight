# TextEdit third review

The branch rebased cleanly onto private upstream `e42b974`, later than the required `80996ac`.

Rich moves require the exact environment value `SLEIGHT_RICH_TEXT_MOVE=1`, while the default
keeps the existing plain Accessibility edits, and a prepared rich child refuses if the setting is disabled.
Missing foreground color compares equal to opaque black. Foreground red and transparent black
still differ. Save-panel advice uses the process and native window IDs to appear once per window.

The launcher supplies the 30-second deadline before spawning a child. The second child refuses
Paste with less than five seconds remaining and sets a one-second native AX messaging timeout.
The `-25204` response reports unconfirmed Paste without source deletion.

Unconfirmed Paste recovery starts final cleanup at nine seconds. It gives conditional
restoration 250 ms, then gives helper collection up to 750 ms before releasing the shared
clipboard reservation. Restoration requires the exact staged bytes and generation. Newer
copies, even identical bytes, are preserved. A stalled status or read cannot prolong the
reservation, and late replies cannot write after release. The relay reports restoration or
contents left and discards its private snapshot. Queued Paste consumption remains unconfirmed;
TextEdit may consume the restored original after the limit.

The first regression pass failed on the new behavior. After the fixes, 182 focused tests
passed. Adding the recovery waiter regression exposed an existing-promise path that bypassed
the deadline. That run was interrupted and collected with exit 1; the waiter now races recovery
completion too. All 15 clipboard regressions then passed.

Independent review found two more issues. Diagnostic and blocked-input replies bypassed the
Save-panel deduplication. Its regression counted three full notes for one window before the
fix and one afterwards. The first color conversion cast an already wrapped Objective-C value,
so it failed despite passing the mock. A pure native test initially crashed its own script
process while constructing a CGColor through a raw bridge reference. Typed message dispatch
fixed the fixture, and removing the extra cast fixed the comparison. The native test now
passes for RGB black, grayscale black, red and transparent black without app or clipboard
access. It skips on Linux, where CI runs the remaining tests. No target app was driven by these
native checks. The first prose checks failed on wording. Bare prose lint then exited 0 with no
findings in 77 files. All 184 focused tests passed after those fixes. Independent review found
no remaining issue to fix, with live behavior reserved for the architect's trials.
The required bare `npm run check` exited 0 with host access: all 1,194 Node tests passed,
with no failures, cancellations or skips. Both manifests validated and all 26 mod tests passed.
Node tests took 19.0 seconds. Terminal 92608 was collected, and no process referencing this
worktree remained. The full-check slot was released to the verified-results chat.

At 08:04 UTC the one-minute load was 11.28, but the shared live lock was occupied and had been
modified seconds earlier. The brief requires skipping trials in that case. No app operation
was attempted, and `pasteWaitMs` remains unmeasured. The
[skip record](2026-10-10-textedit-fixes-3.json) contains the observed load and lock state.
The architect will run the rich, misspelled plain and orphan-panel qualification trials. Enable
`SLEIGHT_RICH_TEXT_MOVE=1` when running the rich harness trial.

Publication uses one squashed feature commit on private upstream `e42b974`. The history check
verifies that the old digest commit is absent and the feature commit contains no clipboard
digests. Reports retain source-code hashes and clipboard match booleans. No merge is authorized.
