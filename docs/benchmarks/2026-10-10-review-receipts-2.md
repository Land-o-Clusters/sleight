# Receipt review follow-up

Branch: `codex/review-receipts`. Rebased onto private `pane/auto-mode` at `e42b974`,
which includes `3f8cd55`. [Run results](2026-10-10-review-receipts-2.json) include failures.
The earlier report remains as historical evidence. Its acceptance claim has been removed.

Receipts now require `SLEIGHT_RECEIPTS=1`. Titles become length markers by default. The app
and file URL basename remain, with username and full name scrubbed from retained fields.
Single printable keys become length markers. Named keys and modified shortcuts remain.
Each write retains at most seven days or 200 regular, user-owned files with the writer's
timestamp and UUID name pattern. Other files, directories and symlinks are left alone.
Concurrent deletion during pruning no longer reports a failed write. A four-worker regression
covers 120 writes. Concurrent first writers now validate any directory created between lookup
and creation, refusing symlinks.

Turn cleanup reaches the engine before parsing or disk I/O. An immediate engine reply waits
for receipt metadata, preserving the original turn identity. stderr contains counts only.
Raw read text is dropped after each entry is built; later comparisons retain hashes and fixed
native control names. The installed host drops result metadata from mod calls, so a bounded JSON
content marker now carries the pane link and review. The mod regression uses that actual host
response shape and checks that both replay buttons remain present.

The title-based call exclusion is removed. The installed host exposes origin in mod hooks,
but does not forward it over MCP. All calls, including pane snapshots, remain in receipts.
This closes the caller-title hiding bug. Excluding only mod-origin calls remains pending an
authenticated transport origin. A caller-supplied argument or metadata field cannot establish it.

The `bench/real-fixture.js` changes remain because the receipt live harness must refuse app
dialogs during cleanup. Strict mode stops instead of answering a save dialog, another app dialog,
or the menu's Escape fallback. Its three regression tests failed before that change.
The `tests/fixtures/clipboard-lock.mjs` change retains the SQLite coordinator until child exit.
Without that reference, garbage collection could close the transaction before the parent checked
the lock. It fixes the test fixture, with production clipboard behavior and deadlines unchanged.

At 200 distinct synthetic reads of 64 KiB, five samples retained 13,107,200 raw read bytes.
Heap above baseline was 13,164,784 to 13,194,952 bytes while held, then 259,512 to 580,816 bytes
after receipt construction and GC. Zero raw read bytes remained even with call objects still
referenced. Construction took 53.8 to 65.6 ms. This measures journal retention with GC noise,
excluding engine and relay allocations and file I/O. It is not a live engine memory measurement.

The first focused regression run exited 1 with eight expected journal failures and an import
failure for the new settings helper. After adding the helper with the old defaults, the relay
selection exited 1 with four expected failures. The first corrected selection passed 40/40,
exit 0. Review then reproduced the concurrent pruning race and the missing pane link.
Their regression runs exited 1. After both fixes, focused tests passed 41/41 and mod tests
passed 28/28, both exit 0. The memory measurement exited 0.
A modified punctuation shortcut regression also failed before its fix, then passed 1/1.
A first-write directory race regression failed with `EEXIST`, then passed 1/1 after its fix.
Prose lint first exited 1 with five findings, then exited 0 with none across 75 files.
Both reports and their JSON records contain zero matches for the current full name, username
or home directory. Only counts were printed by that scan.

The first Calculator attempt stopped at the existing live lock, exit 1, with zero engine calls.
After the lock became free, a sandbox attempt stopped before acquisition because macOS process
inspection was denied. It didn't call the engine and released its own lock. The host retry
passed both background Calculator turns, exit 0, with engine `26.1007.21159`.
With `SLEIGHT_RECEIPTS=1`, it wrote one 0600 receipt with a hidden title and matching metadata.
With the setting absent, it didn't write a receipt or return receipt metadata. Each turn sent
two `js` calls and one `turn_ended`. Both engines exited 0, fixture cleanup was confirmed,
and the harness released its own live lock. These were read-only checks with no app input.
The pane link is covered by mod tests. This live run did not click it in Claude Code.

The sandbox full check exited 1 because local fixture sockets and a native fixture write were
denied, and truncated output prevented a reliable test total. The host retry of bare
`npm run check` exited 0: 1,194 tests, both plugin validations, and 28 mod tests passed.
Final report prose lint first exited 1 with six findings, then exited 0 with none across 75 files
after corrections. Both required checks now exit 0.
