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

[Results](2026-10-04-change-review-reread.json) contain the full results for attempts 1 through 4.
Attempt 1 waited for another thread's lock and was interrupted through its owned
terminal, exiting 1. It didn't open windows or start the engine.
The Chess thread retained the lock during cleanup and
was waiting on an approval card. Attempt 2 failed to find TextEdit in the sandbox
(-2700). Cleanup with host access confirmed that the fixtures were closed before
the lock was released.

Attempt 3 passed 4/4 overlapping Open/re-read trials on `24af5a3`, with reassignment,
`let`, `const` and a bare call. Each saved `alpha delta gamma` with a trailing newline
and showed a later copy in review. The live Open button was 134. Unit tests use 64
from the failed benchmark transcripts.
Attempt 4 passed the owner's Undo, then Keep choices. The files contained
`UNDO ORIGINAL` and `KEEP AGENT CHANGE`, each with a trailing newline.
Both checks exited 0. Fixture windows were closed before the lock was released.
The session backups were deleted. ChatGPT wasn't restarted.

`npm run check` exited 0, with 298 unit tests and 8 mod tests passing.
`npm run lint:prose` exited 0 across 25 files. Its earlier exits were 2 for
missing Vale styles and 1 for prose flags. Those were corrected before committing.
Open panel inventory and vendor API docs stay in local
traces. Published results retain the dialog header and Open/Cancel buttons.
Home paths use `~`. `bench/run.mjs` is reserved for sleight-arch at merge.
