# Input leases

The relay takes a lease before forwarding an action. A second session gets an
error naming the holder and seconds remaining. It never waits for that holder.
Start with a standalone `let app = await cua.getApp("TextEdit")` read. Any
identifier works with `let`, `const`, `var` or a plain reassignment. A bare
acquisition also restores the global `app` handle without assigning a lexical
`const app`.

Window keys hash the bundle ID and observed URL, or title when no URL exists.
The last completed full Window header and engine bundle ID identify the target.
Bundle IDs stay attached to known handles across full reads and screenshots.
After a guard stop, a full read restores the target. Reset clears handles and the
current target; an acquisition can reuse a bundle ID only for a known selector
and matching full window identity. Display names alone never supply a bundle ID.
Ambiguous or missing identity stops actions with exact recovery code.
Unknown JavaScript counts as an action. Standalone acquisition, inventory,
AX-state and screenshot reads take no lease and can read a held window.
Inventory expressions can inspect data with JSON output, filters, comparisons
and literal regex tests. Assignments, extra statements and unknown calls remain
actions. Each acquired handle receives the guard, including alternate and
`const` bindings. Reads and actions update the handle used for the final header.

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
Blank titles are valid full headers and share a conservative window key.
Equal unsaved titles share a key; Save As, dialogs and window changes can stop
valid actions. Checks cannot undo an event already delivered to the native helper.

`node bench/input-lease.mjs` uses two relays and a temporary TextEdit document
for five races. `--extended` also checks renewal, expiry, handoff and cleanup.
`--baseline` omits enforcement. Earlier attempts and raw replies are retained in
[the results](../benchmarks/2026-10-03-input-lease.json).

Before the rebase, macOS 27.0 (26A428) trials doubled 5/5 baseline markers;
enforcement left one marker and one refusal in 10/10 trials. Sandbox access stopped
two attempts before typing. A locked Mac stopped one. After integrating change review,
the fresh baseline doubled 5/5; enforcement left one marker and one refusal in
10/10. Final renewal (35 s), expiry (31 s), handoff and cleanup checks passed.
An earlier expiry check hit the autosave guard. An additional sandbox attempt failed.
Fresh sessions keep other sessions' saved edits outside their review attribution.

The October 4 repair passed 5/5 races after rebasing onto the opt-in change review
and flow rules. Both engines exited, snapshots were removed and no leases
remained. [Repair results](../benchmarks/2026-10-04-input-lease.md) include the failed attempts.
The general benchmark belongs to sleight-arch at merge.

The launcher and extended benchmark can force-kill an owned engine that does
not exit, but collecting that process leaves the shared native helper's health
unverified. The owner cleared the earlier helper timeouts by restarting ChatGPT.
We have no measurement that attributes that wedge to a shutdown.
