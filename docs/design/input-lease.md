# Input leases

The relay takes a lease before forwarding an action. A second session gets an
error naming the holder and seconds remaining. It never waits for that holder.
Start with a standalone `let app = await cua.getApp("TextEdit")` read.

Window keys hash the bundle ID and observed URL, or title when no URL exists.
The last completed full Window header and engine bundle ID identify the target.
Ambiguous or missing identity stops actions until another standalone read.
Unknown JavaScript counts as an action. Standalone acquisition, inventory,
AX-state and screenshot reads take no lease and can read a held window.

Leases live in `~/Library/Application Support/sleight/leases/`. Each JSON file
stores a random ownership token, session name, target and expiry. A shared SQLite
coordinator serializes file changes with zero busy timeout. It remains on disk
after JSON removal so processes always lock the same inode. This needs `node:sqlite`,
available in the current ChatGPT bundled Node 24 runtime.

Actions renew at admission, every five seconds while running, and on completion.
Without renewal the lease expires after 30 seconds. Turn end and normal process
exit remove owned JSON files. Abrupt crashes leave files that expire. Cleanup
checks ownership, so an old holder cannot remove its successor's lease.
Transient renewal contention retries, while persistent failures stop the owned engine.
Shutdown bounds draining and collects the engine before releasing active leases.

The injected app guard checks window identity and lease token before each usual
engine action. Local drag reserves its resolved app since its helper can select
another window. A native read resolves the name or path to one running bundle ID.
Menu and notification actions reserve the desktop and conflict with all leases.
Change review reserves the desktop while the user decides, then releases it.
Inventory reads still pass. These broader reservations can block unrelated work.

Only cooperating sleight relays using this directory participate. Codex computer
use, other tools, older relays and the user do not take these leases. The guard
runs in mutable JavaScript and can be bypassed or its observations forged.
Equal unsaved titles share a key; Save As, dialogs and window changes can stop
valid actions. Checks cannot undo an event already delivered to the native helper.

`node bench/input-lease.mjs` uses two relays and a temporary TextEdit document.
`--baseline` omits enforcement. All attempts and raw replies are retained in
[the results](../benchmarks/2026-10-03-input-lease.json).

Before the rebase, macOS 27.0 (26A428) trials doubled 5/5 baseline markers;
enforcement left one marker and one refusal in 10/10 trials. Sandbox access stopped
two attempts before typing. A locked Mac stopped one. After integrating change review,
the fresh baseline doubled 5/5; enforcement left one marker and one refusal in
10/10. Final renewal (35 s), expiry (31 s), handoff and cleanup checks passed.
An earlier expiry check hit the autosave guard. An additional sandbox attempt failed.
Fresh sessions keep other sessions' saved edits outside their review attribution.
