# Helper read failures

The 2026-10-04 incident lasted about 25 minutes and ended after the owner restarted ChatGPT. A lease
test had killed engine processes just before it began. That ordering suggests a cause; it does not
prove one.

The relay counts consecutive `timeoutReached` errors on standalone helper reads. It uses the existing
read grammar, excluding documentation refreshes. Successful reads and other read errors clear the
count. Action errors, server requests, and successful UI text mentioning a timeout do not count.
After two failures, the second result includes recovery guidance and later `js` and `js_reset` calls
are refused before forwarding. Turn cleanup remains available. A new relay resets the diagnosis.

The guidance names SkyComputerUseService and tells Claude to stop retrying. It asks the user to restart
ChatGPT. The relay never kills the shared helper or restarts ChatGPT. An app hang can produce the same
symptom. The message says the helper appears stuck. Approval, document, and input lease rules still
apply. This detector covers the narrow read grammar. Arbitrary JavaScript remains outside it.

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
The shell forwards cancellation to its child and waits for cleanup before removing the lock.
Cancellation prevents any further helper signal. An in-call trial counts only if a signal was sent
while a request was pending. A completed-before-kill attempt is published as incomplete.
The smoke arm tries three Calculator reads and three doctor probes. The kill arm tries helper-only
relaunch first, then SIGKILL during getApp, Select All in a private TextEdit document,
and idle (three trials each, for the engine parent and its whole owned process group).
Parent kills reproduce the lease harness's force deadline. Group kills also stop its NodeREPL
descendants. The trace records approval, request, signal, result,
descendants, cleanup, and a fresh session's read before and after cleanup. Request overlap proves a
call was pending. It cannot establish the exact native instruction running at the instant of a kill.

The kill arm stops on a wedge. It verifies the exact helper executable before a helper-only recovery
attempt. A failed recovery ends live work and tells the owner to restart ChatGPT. A successful recovery
also ends the kill run so the failure can be reviewed. No path targets ChatGPT, another session's
engine, or another TextEdit document. The only unattended approvals come from the benchmark allowlist.
