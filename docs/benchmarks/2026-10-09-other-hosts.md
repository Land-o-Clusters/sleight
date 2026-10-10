# Other hosts checks, 2026-10-09

Branch: `codex/other-hosts`, based on `origin/pane/auto-mode`. Host model trials were skipped.

## Attempts

1. Baseline `npm test`, exit 1 inside the workspace sandbox. Local web fixture tests in
   `bench-real-web`, `bench-real` and `bench-simulator`, plus `window-observer` socket tests, hit
   `listen EPERM`. `hover-fixture` also hit `EPERM` creating `bench/results` in the new worktree.
   These sandbox failures preceded the changes. They do not measure host compatibility.
2. First approval regression run, exit 1: five missing-fallback cases failed and four existing
   capability/idle cases passed. The missing-field assertions were corrected, and the same five
   cases then failed on missing behavior.
3. After the changes, relay and approval checks passed 140/140, exit 0.
4. The first stdio-client test run, exit 1, preceded creation of its module and failed to import it.
   After adding the client and protocol fixture, the focused checks passed 13/13, exit 0.
5. The app-free live probe stopped at `/tmp/sleight-hold`, before acquiring the live lock or starting
   an engine. Receipt publication then failed with `EPERM` in the worktree, exit 1. The script now
   prints the receipt before saving it so a publication failure cannot hide the original refusal.
   [Preserved refusal](2026-10-09-other-hosts-held.json).
6. Added launcher-override and interruption checks, exit 0, 15/15. Review then found that a failed
   preapproval audit could bypass unsupported-client cancellation. Its regression failed once,
   exit 1, then passed after fixing the route. The focused suite passed 16/16, exit 0.
7. First prose check, exit 1, 26 flags in the new text. The second check had one wording flag,
   also exit 1. The text was revised without suppressing rules.
8. First host-access `npm run check`, exit 1: 992 passed, seven failed and one was cancelled.
   Native compiler timeouts affected background drag, Helium, Mail, Mimestream, PDF, Chess and
   hover fixture tests. The cancelled Helium file followed its compiler timeout. A Ctrl-C was
   sent through the retained terminal handle as the run ended, and that handle returned exit 1.
   Manifest and mod checks were not reached. These fixture self-tests did not acquire apps.
9. The background-drag native fixture passed alone, exit 0, in 56 seconds. This confirms that
   fixture can compile successfully. The cause of the full-run timeouts remains unknown.
10. After rebasing onto `origin/pane/auto-mode` at `8aff828`, bare `npm run check` passed,
    exit 0: 1003/1003 tests, both plugin validations and 11/11 mod tests. The test suite took
    48 seconds. Bare `npm run lint:prose` also passed, exit 0, with no errors or warnings.
11. Updating this report added one prose flag, exit 1. The wording was revised without suppressing
    rules, and the final bare `npm run lint:prose` passed, exit 0.

## What this proves

The separate client initializes with empty capabilities. Through the real relay, its protocol
fixture receives form support, an approval answer and generated session
and turn IDs. After idle cleanup, a second call keeps the session, changes the turn and reuses the
accepted approval. The client refuses optional server requests and collects its owned server after
EOF, timeout, spawn failure and interruption.

The native approval callback is replaced only in the protocol fixture. No real panel was shown or
answered. The hold prevented a live engine result. Cursor and Codex model trials remain with
sleight-arch. The install instructions were checked against their official documentation and local
`codex mcp add --help`.
