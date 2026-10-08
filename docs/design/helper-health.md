# Helper read failures

The 2026-10-04 incident lasted about 25 minutes and ended after the owner restarted ChatGPT. A lease
test had killed engine processes just before it began. That ordering suggests a cause; it does not
prove one.

The relay counts consecutive `timeoutReached` errors on standalone helper reads per app. It uses the
existing read grammar, excluding documentation refreshes. App selectors, saved handles and learned
bundle aliases identify the app. Inventory and unidentified handles get separate counters.
Successful reads and other read errors clear the count. Action errors, server requests, and
successful UI text mentioning a timeout do not count. After two failures for one app, its second
result includes recovery guidance. Its `js` actions are refused, and its standalone reads pass at
most once every 20 seconds. Other apps, documentation, `js_reset`, and turn cleanup remain available.
A reset does not erase faults. Once latched, only a successful read clears that app's fault.

The relay schedules its own standalone recovery read after 20 seconds. It waits while another call,
approval or review is pending. A foreground recovery read consumes the same retry slot. Each automatic
read has a five-second execution timeout and a response deadline 500 ms later. Failed probes keep
the fault, and later probes remain at least 20 seconds apart. Cleanup cancels their timers.
Automatic results remain internal. Because they advance the engine's UI diff baseline, actions on
the recovered app wait for a visible app read. That read disables diffing or appends a full AX read
to an acquisition or screenshot. It must succeed before actions resume. Automatic observations do
not replace the relay's current document, selected window or lease target. Browser calls stay on
the browser path. A native helper fault does not block browser acquisitions or saved tab handles.

The guidance tells Claude to stop retrying and says sleight will retry by itself. Independent
[app and control checks](read-failure.md) distinguish an app fault from a stuck engine read path
before advising an app quit or ChatGPT restart. Incomplete evidence stays unknown. The relay never
kills the shared helper or restarts ChatGPT. Approval, document, and input lease rules still apply.
This detector covers the narrow read grammar. Arbitrary JavaScript remains outside it.

Doctor checks files first, then starts an owned engine and calls `cua.getState()`. Startup has a
ten-second deadline. The live inventory read has a five-second execution timeout and another 500 ms
for the response. Any approval request is declined. A read timeout prints the stuck-helper advice
and exits 1. Missing files, startup failures, and other engine errors exit 1 with their own reason.
Doctor uses inventory so it can test the shared helper without app approval. An inventory success
does not establish that an app's accessibility tree is responsive.
Doctor owns a detached process group, with EOF followed by TERM at two seconds and KILL at five
seconds if needed. Collection has a six-second limit after EOF. It reports collection failure
rather than waiting indefinitely for a descendant that retained an output pipe.

`scripts/live-helper-check.sh` holds `/tmp/sleight-live.lock` only during a live run and removes it on
exit. `bench/helper-health.mjs` publishes every run, including failures, with home paths as `~`.
Chess game titles are replaced with `[Chess window]` throughout receipts, including repeated AX
labels. The same scrubber handles future writes and the published recovery receipts.
The shell forwards cancellation to its child and waits for cleanup before removing the lock.
Cancellation prevents any further helper signal. An in-call trial counts only if a signal was sent
while a request was pending. A completed-before-kill attempt is published as incomplete.
The smoke arm tries three Calculator reads and three doctor probes. The recovery arm injects two
timeout replies after successful native Calculator reads, checks that Chess still responds, and
waits for the real automatic recovery read. It does not reproduce a native wedge or kill a helper.
The kill arm tries helper-only
relaunch first, then SIGKILL during getApp, Select All in a private TextEdit document,
and idle (three trials each, for the engine parent and its whole owned process group).
Parent kills reproduce the lease harness's force deadline. Group kills also stop its NodeREPL
descendants. The trace records approval, request, signal, result,
descendants, cleanup, and a fresh session's read before and after cleanup. Request overlap proves a
call was pending. It cannot establish the exact native instruction running at the instant of a kill.

The kill arm is owner-run only. Killing the shared helper interrupts every other session connected
to it. The owner must coordinate those sessions before running it. The live lock serializes these
runners, but cannot protect sessions that drive apps outside the runner.
The kill arm stops on a wedge. It verifies the exact helper executable before a helper-only recovery
attempt. A failed recovery ends live work and tells the owner to restart ChatGPT. A successful recovery
also ends the kill run so the failure can be reviewed. Engine signals target only owned processes,
and fixture cleanup targets only the temporary TextEdit document. The only unattended approvals
come from the benchmark allowlist.
