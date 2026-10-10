# Startup and per-call costs of the code-audit candidates (2026-10-10)

ROADMAP track 3, step 3 lists five candidates from a code audit whose costs were never measured.
`bench/startup-costs.mjs` measures each with no model, 10 repetitions, reporting median ms and
child processes. Engine sections hold /tmp/sleight-live.lock. The bench starts the engine or reads
the screen only. It drives no app and moves no pointer or keyboard. Engine 26.1007.21159, node
v26.4.0, one Mac, the evening of 2026-10-10. Other lanes' live probes burst through part of the
window (the lock was taken and freed repeatedly between 22:40 and 23:10 UTC), which the launch
numbers below are quoted around. Raw results: [startup-costs.json](2026-10-10-startup-costs.json)
(after the fix, with the other sections from the first pass),
[startup-costs-before.json](2026-10-10-startup-costs-before.json) (first pass, before the fix),
[startup-costs-control.json](2026-10-10-startup-costs-control.json) (before the fix on a quiet
machine, the comparison the fix is judged on).

## Measured costs

- The launch-time extension discovery overlaps the first call. On a quiet machine the first js
  answer took 1270 ms with automatic surface selection, 1147 ms with the browser,computer setting
  and no discovery, and 1020 ms with computer only (medians of 10). The discovery adds about 0.12 s
  to the first call, and its engine (about 20 more child processes during the launch window) runs
  while that call is in flight. The overlap amplifies whatever else runs. Under the evening's
  concurrent load the same code reached 2352 ms median and 3637 ms at worst in the first pass.
- The pane snapshot at turn end takes 130.8 ms a call (123.6 to 155.3) end to end through the relay
  for Calculator's 1348x816 window. Of that, the engine's capture takes 53 ms and jpeg decode with
  the downsample together take 41. The call runs inside the mod's turn.complete before the engine
  turn ends, so a turn with the pane open waits for it. Decode scales with window size.
- Local tools add 32 ms per osascript spawn (30 to 39). Steady state, one call spawns one osascript
  for menu_bar, notifications and blocked_app, two for a background drag (focus capture and drag)
  and two for open_file (resolve and open). The first local call of a session adds one spawn for
  the app-health helper's target lane. Its probe answers in 33 ms warm, 193 ms cold. The counts come
  from a stubbed child process, so no tool ran for real.
- The input lease opens SQLite once per session, not per operation: acquire 0.4 ms, renew 0.3,
  release 0.2, and no opens after the first. The clipboard coordinator opens once per action and
  takes 0.2 ms to acquire, 0.1 to release. The audit's "each lease operation opens SQLite" is not
  true of this code.
- The keyboard-tap scan holds the turn_ended reply until it answers. Warm it takes 8.3 ms (7.4 to
  8.9). The first scan of a session includes the helper spawn, 117 ms.
- probeSurfaces, which doctor runs synchronously, takes 527.8 ms (476 to 882) and 13 to 21 children.

## The fix: refresh the extension cache after the first call

The inventory refresh started when initialize came back, which put the second engine on the machine
during the first call of every session. `refreshAfterFirstCall` (surface-cache.mjs) starts it when
the engine's first call has answered instead, with a 60 s fallback for clients that never call js.
The CUA_REPL_ENABLED_SURFACES value still comes from the cache before the engine spawns. A newly connected
extension still reaches the following session. The setting the running session started with is
unchanged.

On the interleaved rerun (fixed code, 10 repetitions of each condition back to back) the first js
call with automatic selection answered in 1205.7 ms (1092.6 to 1400.1), within noise of the
browser,computer setting without discovery (1269 ms, 1005.1 to 1360.8), against 1270 ms before the
fix on the quiet machine. The cache refreshed after the first call in 10 of 10 runs (verified from
the cache file's checkedAt). In loaded windows the first pass without the fix reached 2352 ms
median. No loaded run with the fix was measured long enough to claim the same comparison there.

## Dropped candidates

- The pane snapshot's decode: 38 of its 131 ms is jpeg decoding, and the pane's cells are the
  product of a full decode. A pure-JS decoder cannot decode part of an image, so any cheaper path
  changes what the pane draws. Dropped per the lane rule (no measured gain without a behavior
  change).
- One long-lived osascript for the local tools: this removes 32 ms a call, but the drag,
  blocked_app and menubar scripts are one-shot safety paths, and a persistent process changes their
  failure modes. Dropped.
- Lease and clipboard SQLite handles: the lease already keeps one handle per session and the
  clipboard's per-action open takes 0.2 ms. Nothing to fix.
- The synchronous defaults read at launch: 7 ms. Nothing to fix.

## Limits of these numbers

- These numbers cover one Mac, one engine version and one evening. The engine's own startup with
  the browser,computer setting adds about 0.1 to 0.3 s over computer-only (1147 against 1020 before
  the fix, 1269 against 972 after). sleight turns those surfaces on when the cache records a
  connected extension. Changing that default is the owner's call, not a lane fix.
- The launch probe's first call is the standalone read `await cua.getState()`, which the input
  lease accepts without a lease. A real task's first call can differ.
- The computer-use helper was not running during the launch runs. A warm helper changes the first
  js call.
- The snapshot numbers are one window (Calculator's). Bigger windows decode proportionally more.
