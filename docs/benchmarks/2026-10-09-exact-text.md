# Exact replacement in TextEdit

The cause of the 2026-10-08 `Engine01engine01` result remains unconfirmed. The installed JavaScript
engine adapter forwards typing and paste as distinct native actions. It doesn't handle selection
replacement in that JavaScript layer. This does not identify the native failure.

`bench/small-fixes-textedit.mjs` prepares a unique temporary plain-text file, opens it in an
already-running TextEdit without activation and retains the exact document and AX window. It checks
the current main and focused window before input, refuses dialogs or unreadable dialog metadata,
and closes only its retained document. It doesn't post pointer events or request permissions.

The probe compares direct engine input, the default relay and the careful guard. It uses pasted and
key-typed seeds. Its conditions cover batched typing and observed selection before typing or paste.
An Escape control precedes select-all in another condition. It records the owned document's selection
and buffer, saved bytes, action timing and source hashes. Engine response bodies are omitted so a
wrong-window acquisition cannot publish unrelated text. A non-exact result counts as a failed case.

The only attempt on 2026-10-09 stopped before acquiring the live lock because `/tmp/sleight-hold`
existed: [the record](2026-10-09-exact-text-1791588276994.json) contains zero app actions. Repository
publication initially hit a sandbox write denial. Its private result was recovered unchanged into
that record. The probe didn't open TextEdit documents or engine processes.

The skill change is guidance for Mac apps, excluding the iOS simulator: select-all and paste for
exact replacement, then compare the document text before saving. The simulator can paste the Mac's
clipboard instead. A successful shortcut or typing call does not prove replacement.
The existing live evidence supports paste for exact case, but this new replacement sequence has not
been qualified. sleight-arch runs the affected `textedit-save` and `textedit-edit` model tasks before
release, as assigned in the follow-up brief. This branch isn't a release.

The menu-bar guard received unit tests only. No menu-bar approval or live click was requested.
