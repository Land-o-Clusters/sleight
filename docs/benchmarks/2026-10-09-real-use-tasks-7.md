# Real-use tasks, round 7 (2026-10-09)

Twenty new tasks are registered in `--suite real`. Each requests one Sonnet 5.5 medium trial.
All desktop slots remain unstarted, awaiting the owner's explicit away confirmation. No target app
or model trial ran. [Full results](2026-10-09-real-use-tasks-7.json) retain both dry attempts.

| Task | Dry fixture | Live trial |
|---|---|---|
| safari-grid | Prepared | Unstarted |
| helium-grid | Prepared | Unstarted |
| safari-editor | Prepared | Unstarted |
| helium-editor | Prepared | Unstarted |
| safari-dense | Prepared | Unstarted |
| helium-dense | Prepared | Unstarted |
| safari-spa | Prepared | Unstarted |
| helium-spa | Prepared | Unstarted |
| safari-nested | Prepared | Unstarted |
| helium-nested | Prepared | Unstarted |
| safari-infinite | Prepared | Unstarted |
| helium-infinite | Prepared | Unstarted |
| word-edit | Prepared | Unstarted |
| excel-edit | Prepared | Unstarted |
| powerpoint-edit | Prepared | Unstarted |
| mail-folder | Prepared | Unstarted |
| mail-message | Prepared | Unstarted |
| mail-thread | Prepared | Unstarted |
| mail-attachment | Prepared | Unstarted |
| mail-search | Prepared | Unstarted |

The first dry pass could not write its results in the linked worktree and exited 1. The second
prepared all 20 fixtures and exited 0. Their checkers rejected the untouched outcomes. Dry runs
prove fixture preparation, not browser layout, Office opening, Mail import or app cleanup.

The web checkers read posted page state. Office checkers read saved OOXML, including preserved
text, cells and slide order. Mail builds 60 invented messages with nested folders, a thread and an
attachment. Its adapter requires retained local mailbox references and complete before/after app
data. It stops when ownership or mutation coverage is unavailable. An already-running Mail app is
required, because a fresh launch can expose account setup or restored mail. The native export path
lacks an independent receipt for current flags and read state, so it stops before a model task.
Native import controls and folder topology still need live evidence.

Office and Mail names and bundle IDs were added only to the real benchmark's approvals. Keyboard
tap checks include their process names. App-dialog stops record the category, suppress further app
actions and collect owned helpers. Cleanup retains window references and preserves pre-existing
apps. No app prompt or dialog was measured, and no newly launched app quit was confirmed.

Review fixes reject extra editor content and slide drawings, retain Mail helpers through safety
stops, and require complete mailbox topology. The initial full check exposed sandbox denials and
one missing inert test binding. Those were resolved. Final `npm run check` exited 0: 849 unit tests,
two plugin validations and 11 mod tests passed. `npm run lint:prose` exited 0.
Qualification remains incomplete.

Brief 7b adds five Mimestream tasks on the owner's signed-in Gmail: label, message, thread, scroll
and search. Each requests one Sonnet 5.5 medium trial. All five remain unstarted, awaiting owner-away
confirmation. Mimestream stays running. Only a window created by the task can be closed.

Targets and expected answers come from Accessibility and stay in memory. Setup requires explicit
already-read targets and mailbox counts before any window or selection action. Checkers require
unchanged unread and folder message counts, plus the requested navigation. Private runs use isolated
Claude settings, disable session, transcript, trace and content logging, and refuse conflicting
policy. The [dry results](2026-10-09-real-use-tasks-7b-dry.json) record failed preparations with null
hashes because this path doesn't read mail or establish targets.
Quiet literal grep checks addresses, the owner's name and every observed label before publication.

Sandbox read-only probes stopped at Accessibility unavailable, and the host retry couldn't find a
running Mimestream process for its confirmed bundle ID. These attempts collected their helpers
without reading mail or sending input, and the dedicated results passed the required grep before commit. Live navigation remains
unqualified. A cancelled review test lacks a detached compiler cleanup receipt and is recorded as
failed evidence. Final `npm run check` exited 0 with 883 unit tests, two plugin validations and
11 mod tests. `npm run lint:prose` exited 0.
