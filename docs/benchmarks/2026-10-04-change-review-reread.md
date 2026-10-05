# Change review re-read, 2026-10-04

Branch `codex/change-review-reread` starts at `2598a1b`. Change review remains
opt-in through `SLEIGHT_CHANGE_REVIEW=1`.

The failed TextEdit edit and drag transcripts from 23:24 UTC sent a standalone
re-read before the preceding Open click returned. The read completed after
the click, but the relay retained its earlier concurrency flag and skipped
the later snapshot. The fix checks pending actions when the read completes.
A read that finishes first tells Claude to read again after the action.

Regression tests cover reassignment, `let`, `const`, a bare read and the
reverse response order, with input leases and change review both enabled.
The live harness has four overlapping Open/re-read trials and a separate
Undo/Keep check. It holds `/tmp/sleight-live.lock` through document cleanup,
and verifies that the session backups were deleted. Only the owner chooses Undo and Keep.

[Results](2026-10-04-change-review-reread.json) will preserve every attempt,
including failures. Open panel inventory and vendor API docs stay in local
traces. Published results retain the dialog header and Open/Cancel buttons.
Home paths use `~`. `bench/run.mjs` is reserved for sleight-arch at merge.
