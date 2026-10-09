# Real-use tasks, round 6

Desktop qualification has 15 requested slots, all unstarted. Live work awaits the owner's
owner-away reply. The earlier fixture-only attempts didn't call a model.
[Full results](2026-10-09-real-use-tasks-6.json) retain every attempt, including the sandbox refusal.

| Task | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| safari-form | Unstarted | Unstarted | Unstarted |
| helium-form | Unstarted | Unstarted | Unstarted |
| preview-pdf | Unstarted | Unstarted | Unstarted |
| finder-files | Unstarted | Unstarted | Unstarted |
| textedit-calculator | Unstarted | Unstarted | Unstarted |

Safari's profiles replace “New Window” with profile-specific commands, which explains round 5's
lookup failures. The native helper now selects a normal profile command, retains a creation-event
reference and opens the local page only in that window. Its first live attempt failed the blank-window check.
that remaining failure needs the new creation diagnostics. Creation events cannot establish causal
ownership while the owner creates windows concurrently, so this path requires `--owner-away`.

Foundation resolves `/private/tmp` to `/tmp`, but readiness compared the resolved document with
the unresolved fixture path. Normalizing both makes Preview ready in two fixture-only attempts.
Round 5's first Preview failure occurred on a fresh launch, so readiness was not limited to apps
already running. TextEdit had the same path mismatch; its repaired live path and Calculator remain
unchecked. Preview cleanup then failed: its document Close commands were disabled in the background.

Changes and why:

- Retain launched-app leases at pass scope and quit their exact PID and bundle even after a safety stop.
- Validate retained recovery references. Preserve mismatched or ambiguous owner windows.
- Shut down an owned simulator in `finally` and stop MobileSafari only on a device the task booted.
  No live Simulator or Device Hub run is part of round 6.
- Create the sleight arm directory for both suites. Add fixture-only diagnostics without model calls.
- Recheck document identity and focus immediately before Close, and before inspecting discard sheets.
  Use document Close. Activation for disabled commands requires an explicit owner-away boundary.
- Refuse Safari blank-window navigation before mutation without that same explicit boundary.

No newly launched app has a confirmed live quit in round 6. Existing apps remain running.
The revised source passed review and the pure concurrent-window and focus-switch regressions.
`npm run check` ran bare and exited 0 (768 unit tests, 11 mod tests and both validations).
`npm run lint:prose` ran bare and exited 0 (50 files), after correcting eight report findings.
