# Turn receipts and unsaved review

At turn end, build a receipt from the requests and results already passing through the relay.
Retain references during a call. Parse actions and compare observations only when the turn ends.
No new engine read, screenshot, timer or filesystem write runs for an individual action.

Receipts default to off and use private files in `~/Library/Logs/sleight/receipts/` when enabled.
Each receipt contains the app, window, actions, targets, call outcome and observed changes. Literal text
inputs and values become length markers. Computed inputs have unknown length. Raw code, trees, screenshots
and arbitrary result text never go into the receipt. Titles become length markers by default.
The app name and the document's file URL basename remain. Typed text is also removed from app, window
and document names, but only where it is the whole name or a whole word in one, because a name echoes
typed text whole (a file's Save panel takes its name from what was typed), while a minimum length
would leave short secrets in names and still mangle a name a short input merely sits inside.
The username and full name from `id -F`
are scrubbed from retained fields. Single printable keys become length markers; named keys and
shortcuts with modifiers remain.
Unknown JavaScript stays an opaque call, with no claim that every action was understood.
Titles can contain private data, including computed input that can't be recovered from the call.
Explicitly retaining titles can expose that data.

Unsaved review has a separate setting, off by default. For each window with an attempted action,
compare its first full read with later full reads or the engine's diffs. A missing,
ambiguous or failed observation reports uncertainty. A changed tree is an observation, not proof
that an action succeeded or that the app saved. The summary doesn't include value contents.

At turn end the user sees changed or modified windows, and can leave them or use an observed
native Undo or Revert To Saved control. The first version supplies the native control's name
for the user to use in the app. It does not send undo keys: multiple edits, autosave and a person's
intervening work make a blind undo unsafe without another read. Saved-file review keeps its
existing behavior. The pane links the latest receipt returned by turn cleanup.

The settings are `SLEIGHT_RECEIPTS=1` to write files, `SLEIGHT_STATE_REVIEW=1` to show review,
and `SLEIGHT_RECEIPT_REDACT_TITLES=0` to keep scrubbed titles. Files use mode 0600 in a 0700 directory.
Symlinked directories are refused. Each write prunes regular user-owned files matching the writer's
timestamp and UUID name pattern to seven days or 200 files, whichever is fewer. Other names,
directories, symlinks and files owned by another user are left alone. Failed storage reports an
unavailable receipt and still ends the engine turn.

A turn retains at most 2,000 calls. Anything after that makes its review partial and clears the
last observation. Pending mutations, failed batches and overlapping replies remain unknown.
Only observed enabled menu items or buttons can supply a native revert label. Document text
that mentions Undo can't do so. A call's title cannot exclude it. The installed host exposes
origin in mod hooks but doesn't forward it over MCP, so pane snapshots are conservatively included.
An authenticated transport origin is needed before the relay can safely exclude them.

Calls retain references to code and the text the relay already joined, with no extra engine read.
Keeping those references takes CPU time and allocates memory.
Turn cleanup is forwarded before parsing, comparison, redaction and file writing. Raw read text
is dropped after building each entry. Cross-turn observations keep hashes and fixed native
control names instead of accessibility text. stderr contains counts only. The evidence report measures
the bookkeeping separately from that work.

Build order:

1. Test action extraction, redaction, conservative window comparison and private receipt writes.
2. Add a turn journal, collect request/result references and flush it through every turn-end path.
3. Show the receipt link and review summary in the mod. Test lifecycle and tool ownership.
4. Scan recorded traces without publishing their contents. Publish counts and all run outcomes.
5. Run the affected live tasks if the hold is absent, then rebase, run both required checks,
   commit named files and push `codex/review-receipts`.

Review focus: partial failed batches, out-of-order replies, unknown windows, secrets echoed in
results, unreadable receipt storage and pane reads after a completed turn.
