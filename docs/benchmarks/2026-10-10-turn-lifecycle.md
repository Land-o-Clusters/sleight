# Desktop turn cleanup, 2026-10-10

Fake-engine tests found a path that could leave a desktop engine turn open. Both cleanup paths
rotated the relay's turn ID and cleared `turnUsed` as soon as they sent `turn_ended`. If the engine
returned an error, the relay forgot the original turn and the idle timer had nothing left to end.
All 3 regression tests failed before the change and passed afterward. The earlier two desktop
incidents were not reproduced, so this finding does not establish their cause.

## Paths checked

- The launcher gives `SLEIGHT_IDLE_TURN_END_MS` a default of 30,000 ms. Setting it to 0 disables
  idle cleanup. A relay constructed without an idle interval also has no idle cleanup.
- The mod's `turn.complete` hook ends a main-agent turn that used its `js` hook. It sends `Stop`,
  or `Interrupt` for an aborted turn. An open pane gets a snapshot first. Subagent completions
  and turns with no tracked `js` call do not send cleanup from this hook.
- The relay starts its idle timer after the last outstanding engine or local call finishes.
  A running call delays cleanup. A saved-file review also delays the timer until it finishes.
- Explicit hook cleanup and internal idle cleanup both rotated before the engine answered.
  Neither retained an engine rejection. The next action could use a fresh turn while the old
  one remained open.
- Shutdown sends cleanup and waits for an answer or its existing three-second grace period.
  With input leases, it first waits for outstanding calls to finish.

## Change

The relay now records the turn arguments of each cleanup request. A JSON-RPC error or an engine
result with `isError` retains those arguments for the next configured idle cleanup. The retry uses
the original session ID, turn ID and hook event, and the relay consumes its response. An acknowledged
cleanup does not retry.

If another turn starts before the retry, its outstanding work still delays the timer. Once idle,
the relay sends the old cleanup and the newer turn's cleanup with their separate identities.
Retries use the configured idle interval. A retry waits after each engine error. The follow-up caps
cleanup at three total attempts, including the initial explicit or idle request. A third rejection
emits one stderr warning and one abandonment trace, then drops the failed turn. A later turn has
its own budget. After abandonment, the engine's release of that turn's resources remains unconfirmed.
Turn rotation, app approval memory and input-lease release timing retain their existing behavior.
Closing the relay clears the retained cleanup state and prevents a later timer from being armed.

The change is in `plugins/sleight/lib/relay.mjs`. The tests exercise the real relay through
in-memory JSON-RPC streams, with a fake clock and engine replies. They do not launch or drive apps.

## Test record

1. Before the fix, `node --test tests/relay-turn-lifecycle.test.mjs` exited 1: 0/3 passed.
   The test for an explicit cleanup error expected a second cleanup request and got one. The idle
   cleanup error test also expected two and got one. The newer-turn test received cleanup for
   the newer turn where it expected a retry for the older turn. These were assertion failures.
2. After the fix, the same command exited 0: 3/3 passed. The newer-turn assertion now checks
   both cleanup identities in the same idle batch, since both turns are ready to end then.
3. `node --test tests/relay.test.mjs tests/relay-input-lease.test.mjs tests/other-hosts.test.mjs
   tests/relay-turn-lifecycle.test.mjs` exited 0: 217/217 passed. Existing coverage includes idle
   cleanup, session and turn metadata, pending-call holds, lease release and shutdown draining.
   The fake prompt failure test printed its expected no-GUI-session diagnostic.
4. `vale docs/benchmarks/2026-10-10-turn-lifecycle.md` exited 2 because the worktree's
   `.vale/styles` directory was absent. Using the primary checkout's same config and installed
   styles, `vale --config ~/Projects/sleight/.vale.ini docs/benchmarks/2026-10-10-turn-lifecycle.md`
   exited 1 with 10 prose flags. Each of its next three runs exited 1 with one prose flag.
   The flagged sentences were revised after each run. The final two runs exited 0 with zero flags.

The parent task runs the complete check and prose lint after combining its changes. Those results
are recorded in its task report. No live desktop run, engine probe, simulator or app input ran here.

## Limits

- We have no trace connecting an engine cleanup error to the historical desktop incidents.
  The regression proves recovery from two engine error shapes, not a desktop qualification.
- A request whose reply never arrives remains unconfirmed. The existing three-second shutdown
  grace period limits the wait without confirming cleanup or starting an idle retry.
- A `js` or local call that never finishes can keep the relay's running set occupied. This
  change does not invent cancellation, end a running turn, or release its lease early.
- With idle cleanup disabled, a rejection is retained for a later `endOpenTurn` or shutdown,
  but no timer retries it. Shutdown itself does not retry indefinitely after another rejection.
- A missing mod completion event, failure before the hook sends cleanup, or a pane snapshot
  that never finishes still relies on idle cleanup. `isPaneOpen` can reject outside the snapshot's
  error handler. The hook was inspected but not changed or exercised here.
- The reply to explicit cleanup waits for the keyboard-tap scan after the session used an app.
  That scan has no relay deadline. A scan that never returns can delay the hook and error handling.
- The real engine's behavior when an errored cleanup already released part of its state remains
  unmeasured. The retry targets only the original turn and does not repeat an app action.
