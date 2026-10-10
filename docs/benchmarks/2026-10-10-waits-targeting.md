# Waits and targeting follow-up

The branch is rebased onto private `pane/auto-mode` at `e42b974`. `verified-results` has not landed
there. No merge or public push is part of this work.

Esc sends a plain `turn_ended` Interrupt. Only `/sleight stop` and the pane's Stop button send the
checked-stop marker. Esc keeps the engine and session approvals. An unconfirmed explicit stop
clears closing at the next user message, invalidates old handles and keeps active reservations.
Delayed input, approvals, reviews and observations from before stop remain cancelled. When engine stdin is closed, the relay
returns reconnect advice. Subsequent use requires a fresh connection.

Native identity applies only to multiple matching titles without a URL. Candidate titles come
from the engine inventory, or the existing health probe when it finds several windows. One
window doesn't add title reads or identity requests. A sheet skips native identity because its header
names a child of the document window. Missing helper trust falls back to existing engine and
window guards and warns once. Unknown candidate counts also skip the check. Replacement detection
is unavailable on those paths. Helper failures still refuse when duplicate candidates require a check.

`waitFor` returns one full tree and doesn't emit poll trees. The skill uses a late Save sheet example.
A regression loads the recorded `Window: "Save"` sheet from the published hover-discovery trace.
It admits input with an unavailable identity helper. The JavaScript guard is cooperative and
cannot enforce a security boundary.

## Attempts

All live attempts below ran with the owner's away confirmation. The runner takes the mkdir lock
and stops on a busy lock or hold. It doesn't generate load. Published protocol results omit images,
home paths, Chess titles and unrelated folder listings in Open and Save panels.

| Attempt | Result |
|---|---|
| Focused regressions before fixes | Exit 1, five expected failures |
| Focused regressions after fixes | Exit 0, 84 passed |
| Independent review regressions before fixes | Exit 1, three expected failures |
| Independent review regressions after fixes | Exit 0, three passed |
| Follow-up review regressions before fixes | Exit 1, five expected failures, including delayed Undo after stop |
| Follow-up review regressions after fixes | Exit 0, five passed |
| Lease, clipboard and wait regressions | Exit 0, 101 passed |
| Client approval and recovery regressions | Exit 1 before fixes, then exit 0, two passed |
| Broader relay, lease, clipboard and wait regressions | Exit 0, 235 passed |
| Plugin validation | Exit 0, both manifests and hooks passed |
| Mod tests | Exit 0, 12 passed |
| First sandboxed live launch | Exit 1, fixture access and report output denied |
| First host live attempt | Exit 1, unsupported Calculator key, restored Chess windows and fixture argument error; all owned apps collected |
| Second host live attempt | Exit 1, Calculator returned 56 with zero identity calls; Chess geometry differed, so no drag; TextEdit Open panel kept Cmd+N from creating a document; cleanup passed |
| Chess inspection attempt | Exit 1, another run held the live lock; no app input |
| First bare check | Exit 1 after cancellation through its owned terminal; sandbox denied sockets and fixture output, plus a corrected error-message assertion |
| Interrupted check and lint | Terminal handles unavailable after interruption, final outcomes unknown |
| Resumed bare host check | Exit 1, 1,155 of 1,168 tests passed, nine native compile timeouts and four process-deadline failures |
| Process-deadline rerun | Exit 1, 43 of 46 tests passed under heavy host load |
| Prose lint after wording corrections | Exit 0, zero flags across 72 files |
| Final diagnostic barrier regression | Exit 0 after the hold cleared |
| Resumed relay, lease, clipboard dispatch and wait tests | Exit 0, 225 passed |
| Rebase onto latest private pane | Exit 0, preserved both replay documents in prose lint |
| Rebased stop, recovery, diagnostic and batching regressions | Exit 0, four passed |
| Resumed sandboxed Calculator measurement | Exit 1, host fixture access and report output denied |
| Resumed host Calculator measurement | Exit 1, another run held the live lock; no app input |
| Latest bare host check | Exit 1, 1,178 of 1,183 tests passed; two 180 s Swift compile deadlines and three process or lock failures |
| Stop, clipboard lock and helper tests in the sandbox | Exit 1, 19 of 20 passed; only the cross-process SQLite-lock test failed |
| Isolated host clipboard-lock rerun | Exit 0, two passed |
| Latest prose lint | Exit 0, zero flags across 74 files |
| Diagnostic barrier without its fix | Exit 1, the regression detected input forwarded after a late reply |
| Diagnostic barrier with its fix restored | Exit 0, one passed |
| Plugin validation after the rebase | Exit 0, both manifests and hooks passed |
| Mod tests after the rebase | Exit 0, 27 passed |
| Native checks in isolation with fresh module caches | Exit 1, both reached their 180 s compile deadlines |
| Shared-cache native checks and retained clipboard fixture in the sandbox | Exit 1, three of four passed; Carbon module-cache write denied |
| Shared-cache native checks and retained clipboard fixture with host access | Exit 0, four passed. Native compiles took 11.8 s and 3.5 s |
| Warm CPU accounting regression before the fix | Exit 1, startup CPU inflated the group total from 3 s to 16 s |
| Warm CPU accounting regression after the fix | Exit 0, three sampler tests passed, including the unchanged whole-run calculation |
| Serialized bare host check | Exit 0, 1,185 Node tests, both plugin validations and 27 mod tests passed |
| Missing CPU baseline regression before the fix | Exit 1, three passed and the missing-baseline rejection failed |
| Measurement cleanup regressions before fixes | Exit 1, both Calculator cleanup and worker-spawn cases failed |
| Expanded measurement cleanup regressions before fixes | Exit 1, all three cases failed, including unconfirmed worker collection |
| Measurement failure regressions after fixes | Exit 0, seven passed |
| Failed final CPU sample without its fix | Exit 1, the expected refusal was missing |
| All measurement regressions after fixes | Exit 0, eight passed; no real app, engine or live lock used |
| Final serialized bare host check after measurement fixes | Exit 0, the complete Node suite, both plugin validations and 27 mod tests passed |

Live and performance qualification remains in progress. Idle measurements require an idle Mac;
the first two live runs began at one-minute loads 67.69 and 59.51. These are not idle results.
Host load was 300.99 while other Sleight chats ran checks. The earlier lock belonged to the
simulation save-lock task, which retained it after cleanup of its TextEdit fixture was unconfirmed.
This task has not removed or reused that lock.

At 06:15:30 UTC, sleight-arch set `/tmp/sleight-hold` for Puddle's timed work. It cleared before
07:07 UTC. The resumed bare check exited 1. The live lock cleared, then another run acquired it
at 07:08 UTC, before this task could start its Calculator comparison. The TextEdit A/B pass is
running during this interval. This task has sent no further live input.
The final serialized bare check passed with the measurement-runner corrections. Calculator passed
one live calculation. Chess hasn't moved a piece, TextEdit Save remains unverified live, and neither
CPU comparison has run. The owner's speed and load bar remains unqualified.
The last review preserved the existing refresh barrier after a late diagnostic reply and added
coverage for expiry before a visible refresh. That final regression passed after the hold cleared.
The earlier full check's failures did not establish a clean run. The serialized run passed after the
isolated stop and helper tests passed. A fixture correction from the verified-results lane keeps the clipboard transaction
owner reachable until process exit, so garbage collection cannot release it early. Native compile
checks now reuse the repository's shared Swift module cache. Their assertions and deadlines are
unchanged. Another chat is coordinating subsequent full checks in sequence.

The timing runner requires one Calculator window across Spaces, checked through Window Server
metadata. It compares the direct engine, the relay with identity disabled and the conditional
identity path, reversing order for a second repetition. Each worker warms up, then sends eight
actions. It records action latency and Node CPU. The existing footprint sampler also measures warm
CPU for the worker group, its descendants, the shared engine service and Calculator. The runner
waits for its initial sample after warmup, then divides the phase's CPU by eight actions. This
sampling adds the same observer work to each arm. Processes that exit between samples lose up to
their last second, and shared-service activity can include other clients. `/usr/bin/time` records
worker and descendant CPU across startup and actions separately. The measurements have not run
yet, and this direct-engine comparison cannot establish the owner's full Codex speed bar.
Missing initial or final CPU samples refuse the measurement. Unconfirmed app or worker cleanup
retains the lock and evidence bank. Worker-spawn failures clear the cancellation timer.
