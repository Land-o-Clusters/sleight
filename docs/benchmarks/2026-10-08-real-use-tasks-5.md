# Real-use tasks, round 5

Qualification stopped at 16 of 18 slots: 6 passed, 10 failed during setup and 2 remain unstarted.
All 6 model trials passed. Sonnet 5.5, medium, native computer surface, on 2026-10-08 (EDT).
[Full results](2026-10-08-real-use-tasks-5.json) retain every pass, including the sandbox write refusal.

| Task | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| safari-form | Setup failed | Setup failed | Setup failed |
| helium-form | Pass, 18.2 s | Pass, 17.6 s | Pass, 19.4 s |
| preview-pdf | Setup and quit unconfirmed | Setup failed | Setup failed |
| finder-files | Pass, 47.7 s | Pass, 52.2 s | Pass, 71.6 s |
| textedit-calculator | Setup failed | Setup failed | Setup failed |
| simulator-flow | Setup and identity unconfirmed | Unstarted | Unstarted |

Safari's File-menu lookup failed 3/3. All three recorded AXCancel. Preview and TextEdit failed
readiness 3/3 each, before a model started. Calculator was never reached. Missing owned references
left window cleanup unconfirmed, and those ordinary failures continued.

Preview's first slot stopped live work when its launched-app quit was unconfirmed. A native
regression reproduced a bridged bundle-string comparison failure. Unwrapping it passed the test.
The owner then said Preview was closed. Only the two remaining slots resumed; their raw run numbers
1 and 2 map to requested slots 2 and 3. Both reported Preview already running and left it running.

Simulator's first slot timed out opening its local page. The helper had waited for that launch
to finish before recording a PID, so cleanup refused to quit an unidentified app. The owner reported
Device Hub still open. Simulator slots 2 and 3 await confirmation that it is quit.

The pass used `65872cd` through Preview's first slot, then `d5fef3d`. The later PID and ownership
fix (`efafe9d`) has unit proof only. No successful native app quit was recorded. The desktop Space, system
dialogs and owner presence were not independently recorded. Qualification remains incomplete.

Changes and why:

- Keep each lease's initial running state, collect its helper, then quit only the exact app it launched.
- Run the keyboard-tap check after every real trial and call the common cleanup tail for every outcome.
  The real tail preserves apps that were already running.
- Keep core approvals unchanged. Add the four real apps only for `BENCH_SUITE=real`.
- Close only retained, proven owned window references. Missing references remain unconfirmed.
- Continue ordinary failures, stop on safety errors, and cancel Safari's failed File-menu lookup.
- Reject the unsupported Codex real arm before constructing it or changing approvals.
- Inline arm-env and replace rounds 2, 3 and 4 prose with short Known problems entries. Keep their JSON.
- Unwrap native bundle identity. Capture a PID during the actual viewer launch, pump the AppKit loop,
  preserve a viewer opened during boot preparation, and refuse unconfirmed ownership probes.

Both checks ran bare: `npm run check` exited 0 (754 unit tests, 11 mod tests and both validations).
`npm run lint:prose` exited 0 (49 files).
