# Guard reads (2026-10-07)

The guard can reuse the full state returned by `getAXStateAndScreenshot()`. It previously discarded
that state and read the window again before input, or after the call. This saves one full read in
the measured Chess sequence. Calculator clicks and TextEdit typing still need a fresh observation
after each preceding action.

## What changed

The combined method requests `disableDiffing: true` and caches its returned `state` only when it
contains a complete, unambiguous window header. The screenshot and `emit` option retain their
meaning. A final hidden observation supplies the header the lease needs; an emitted observation
already supplies it. Missing state, a failed combined read and a screenshot-only observation cannot
reuse an earlier tree.

Every native action clears all cached observations in the call, including alternate handles for
the same app. A read started before that input cannot refill the replaced cache when it finishes.
Each read also has its own cache entry, so a screenshot or a newer read invalidates older pending
observations on that handle.
A new call starts empty. Title, app and URL checks still precede input. Numbered
actions compare element identities with the first action's tree; ID and label selectors resolve
against the current tree. Both input-lease checks remain, including when a combined read is reused.
The guard is cooperative JavaScript, not a security boundary.
The proxy expects callers to `await` native actions and does not make observation and input atomic
or serialize concurrent JavaScript inside a call.

The branch starts at `1532ae9097c17aaf791330efdeff3e32a4c00fce`. Its existing change-review cancel,
file-dialog and URL-adoption exceptions are unchanged. Integration must preserve the later
untitled-panel exception on main, which is outside this base. New regressions
cover combined reads, every native input method, identity drift, stale numbers, fresh ID and label
resolution, alternate handles, delayed reads, expiry and replacement of a lease, and full final headers. Existing
document-scope, change-review, flow-rule and lease tests remain in the full check.

With `SLEIGHT_TRACE` enabled, each guard-owned read emits a timing record containing its phase,
duration, character count and failure flag. The relay removes these records from tool results and
traces them by call ID. `bench/timing.mjs` reports their sum as a subset of engine time. Caller-owned
reads are outside that sum. Arbitrary JavaScript can forge the telemetry, so it cannot provide
trustworthy audit evidence against that code.

## Engine and parser costs

The installed engine was `26.1002.52244`. Read-only inspection of `bind_mac_app.js`, `get_app_state`,
`window_result` and the native client showed that `getAXState` accepts diffing and emission options,
but no header-only or depth-limited read. The client requests a helper skyshot, then returns text
and a screenshot reference. Native actions return no observation for sleight to reuse.

The timing surrounds the whole awaited `raw.getAXState` call. It includes engine permission handling,
native IPC, helper work and reply delivery, before sleight parses the result. The reply lacks
component timestamps, so these measurements cannot separate the helper's AX walk, screenshot
capture, settling or transfer. Reads following input are much slower than initial reads in these
samples. That is consistent with settling work but does not isolate its cost.

The parse probe runs `windowFromText` and `elementLines` 1,000 times on an actual full tree inside the
engine. It excludes read time and averages a warm loop, omitting identifier matching, lease-file
reads and the rest of the proxy. Baseline parsing averaged 0.0125 ms for TextEdit's 837-character tree
and 0.0348 ms for Chess's 1,915-character tree, small fractions of whole read time. The code retains
the existing parser and documented read API.

## Live protocol

`node bench/guard-reads.mjs before all` and `node bench/guard-reads.mjs after all` are targeted probes,
without model calls. The phase argument labels the report. Run the first on the base guard with timing instrumentation
and the second on the changed guard, using the same harness. Reports record the guard source SHA-256.
The [baseline patch](../benchmarks/2026-10-07-guard-reads-baseline.patch)
adds timing to the base guard and reproduces the recorded baseline source hash. Each process
waits for `/tmp/sleight-live.lock` and takes it with `mkdir`. It collects the engine child it started
before releasing the lock. ChatGPT and the shared helper were not restarted or killed.

Each arm runs five repetitions in order:

- Calculator: press Escape outside the measured call, then click IDs One through Eight. The final
  result must contain 12345678.
- TextEdit: open one owned temporary text file, wait 500 ms outside measurement for its new window,
  and confirm the exact URL. Each measured call selects all, types `Guard timing N`, and presses
  Cmd+S. Disk contents must match exactly. The fixture closes once after all five repetitions.
- Chess: read full state and screenshot, then press Escape on the existing game without moving a piece.
  The result must retain a full window header. Chess titles and URLs are redacted; screenshots
  are not retained or published.

The owner described Mac usage as "half and half". There is no per-repetition activity log. The
engine helper is shared with other sessions. The arms are sequential, not randomized or paired;
five repetitions cannot separate small latency changes from host load. Guard-read counts establish
the removed work more directly than the wall-time difference. These samples do not establish a
change to whole benchmark runs, model time or the earlier 21-run timing percentages.

## Measurements

The final comparison and every earlier attempt are recorded below and in the
[raw evidence](../benchmarks/2026-10-07-guard-reads.json). Guard time is part of engine time; total
time runs from the probe's call to the relay reply and excludes disk verification and fixture setup.

The final baseline (`b70Aba`) and final changed guard (`a3kDXG`) each passed 15/15 trials and
confirmed TextEdit cleanup. Both engine children were collected and the live lock was released.
The final guard source hash is `acf4b1ae31d936f6c82c09f8d9137687209b26d9a500dacb268f0d68ec4e286c`.

Medians of five repetitions, in milliseconds:

| App | Guard reads before / after | Guard ms before / after | Engine ms before / after | Total ms before / after |
|---|---:|---:|---:|---:|
| Calculator | 9 / 9 | 3330.4 / 3335.5 | 3643.0 / 3641.1 | 3644.9 / 3643.5 |
| TextEdit | 4 / 4 | 1376.2 / 1382.7 | 1445.3 / 1472.7 | 1448.2 / 1475.3 |
| Chess | 2 / 1 | 436.4 / 404.9 | 508.4 / 451.8 | 511.4 / 454.0 |

Chess removes one read in every repetition. Its median guard time fell 7.2% and total call time
fell 11.2%. Calculator's median call time was 1.4 ms lower and TextEdit's was 27.2 ms higher,
with both read counts unchanged.
These short samples establish the removed read, but do not establish a precise latency saving
under other host loads.

In the baseline, the median first guard read took 51.1 ms in Calculator and 42.1 ms in TextEdit.
Later reads in those batches had medians of 407.3 and 475.6 ms. Guard reads accounted for roughly
86 to 95% of engine time in these short sequences. They are only part of the earlier benchmark's
23.6% engine share, so that percentage cannot be treated as recoverable time.

Every final comparison repetition, in milliseconds. All passed:

| App | Arm | Repetition | Guard reads | Guard ms | Engine ms | Total ms |
|---|---|---:|---:|---:|---:|---:|
| Calculator | before | 1 | 9 | 3319.0 | 3643.0 | 3644.9 |
| Calculator | before | 2 | 9 | 3333.6 | 3648.5 | 3650.8 |
| Calculator | before | 3 | 9 | 3330.4 | 3623.0 | 3625.8 |
| Calculator | before | 4 | 9 | 3336.2 | 3693.2 | 3696.2 |
| Calculator | before | 5 | 9 | 3268.3 | 3573.3 | 3577.2 |
| TextEdit | before | 1 | 4 | 1376.2 | 1445.3 | 1448.2 |
| TextEdit | before | 2 | 4 | 1379.6 | 1470.8 | 1473.9 |
| TextEdit | before | 3 | 4 | 1455.5 | 1552.7 | 1555.7 |
| TextEdit | before | 4 | 4 | 1374.0 | 1437.4 | 1440.6 |
| TextEdit | before | 5 | 4 | 1366.6 | 1439.8 | 1442.7 |
| Chess | before | 1 | 2 | 546.7 | 638.0 | 641.2 |
| Chess | before | 2 | 2 | 422.6 | 480.6 | 483.9 |
| Chess | before | 3 | 2 | 436.4 | 508.4 | 511.4 |
| Chess | before | 4 | 2 | 443.1 | 512.9 | 516.0 |
| Chess | before | 5 | 2 | 435.5 | 501.0 | 503.8 |
| Calculator | after | 1 | 9 | 3368.6 | 3617.3 | 3619.7 |
| Calculator | after | 2 | 9 | 3319.4 | 3641.1 | 3643.5 |
| Calculator | after | 3 | 9 | 3287.2 | 3535.5 | 3539.6 |
| Calculator | after | 4 | 9 | 3335.5 | 3734.3 | 3736.5 |
| Calculator | after | 5 | 9 | 3377.1 | 3660.4 | 3662.7 |
| TextEdit | after | 1 | 4 | 1359.7 | 1416.3 | 1418.0 |
| TextEdit | after | 2 | 4 | 1380.9 | 1438.1 | 1440.0 |
| TextEdit | after | 3 | 4 | 1516.6 | 1581.7 | 1584.1 |
| TextEdit | after | 4 | 4 | 1604.1 | 1714.5 | 1717.8 |
| TextEdit | after | 5 | 4 | 1382.7 | 1472.7 | 1475.3 |
| Chess | after | 1 | 1 | 498.5 | 576.4 | 578.2 |
| Chess | after | 2 | 1 | 404.9 | 451.8 | 454.0 |
| Chess | after | 3 | 1 | 384.2 | 425.2 | 429.4 |
| Chess | after | 4 | 1 | 400.1 | 446.5 | 449.6 |
| Chess | after | 5 | 1 | 408.9 | 453.2 | 455.2 |

Warm parse averages per iteration, measured once per app per arm with 1,000 iterations:

| App | Tree characters | Before ms | After ms |
|---|---:|---:|---:|
| Calculator | 4501 | 0.0443 | 0.0232 |
| TextEdit | 837 | 0.0125 | 0.0138 |
| Chess | 1915 | 0.0348 | 0.0187 |

TextEdit used a small plain-text file. Larger documents and trees were not timed.

## Earlier attempts

The protocol was corrected during these attempts. The table includes successful repetitions from
incomplete runs. These early samples are excluded from the final comparison. Every process that
started an engine reports that child collected.

| Attempt | Outcome |
|---|---|
| Tua4id | Sandbox engine startup failed before a trial. |
| SZOWRm | Wrong Calculator ID Add. Timing framing was incomplete. |
| g54V4K | Wrong Calculator ID AllClear after the UI changed. |
| 28K0Ye | Calculator passed. TextEdit verification expected lowercase while the typed text was capitalized. Timing records were not framed correctly. |
| t5IOOy | Cleanup closed the owned TextEdit document but treated noWindowsAvailable as failure. |
| LahG1o | Fixed timing framing. TextEdit's first repetition passed, then cleanup misclassified noWindowsAvailable. |
| 0y1bWl | The first TextEdit repetition passed. Opening a second fixture raced window creation and returned a zero-size capture. |
| V1A67B | The first TextEdit repetition passed. Cleanup expected window inventory that listApps does not expose. |
| XRPTW4 | The first TextEdit repetition passed. A second fixture again returned a zero-size capture. |
| jkVdVw | Cleanup reported success after a timeout and another document. Review found this insufficient proof, so that receipt is unconfirmed. The final baseline later received `noWindowsAvailable` from TextEdit. |
| XgkuEP | Interrupted while waiting for another session's lock, before acquiring it or starting an engine. |
| vTji3w | Interrupted while waiting for another session's lock, before acquiring it or starting an engine. |
| uEv76U | Interrupted while waiting for the lock to load the final delayed-read fix. It had not acquired the lock or started an engine. |

Every measured pilot repetition, in milliseconds. A dash means the telemetry framing was incomplete,
not a zero-cost read. Pilot engine intervals are in the raw file but may end early on a colliding
server request ID. Use their total call time instead.

| Attempt | App | Repetition | Guard reads | Guard ms | Total ms | Result |
|---|---|---:|---:|---:|---:|---|
| SZOWRm | calculator | 1 | - | - | n/a | failed |
| g54V4K | calculator | 1 | 1 | 51.8 | n/a | failed |
| 28K0Ye | calculator | 1 | - | - | 3640.0 | passed |
| 28K0Ye | calculator | 2 | - | - | 3623.1 | passed |
| 28K0Ye | calculator | 3 | - | - | 3630.5 | passed |
| 28K0Ye | calculator | 4 | - | - | 3657.2 | passed |
| 28K0Ye | calculator | 5 | - | - | 3641.3 | passed |
| 28K0Ye | textedit | 1 | - | - | 1426.8 | failed |
| LahG1o | calculator | 1 | 9 | 3324.2 | 3583.9 | passed |
| LahG1o | calculator | 2 | 9 | 3321.1 | 3558.8 | passed |
| LahG1o | calculator | 3 | 9 | 3325.7 | 3579.4 | passed |
| LahG1o | calculator | 4 | 9 | 3371.8 | 3614.7 | passed |
| LahG1o | calculator | 5 | 9 | 3288.4 | 3522.7 | passed |
| LahG1o | textedit | 1 | 4 | 1456.8 | 1548.9 | passed |
| 0y1bWl | calculator | 1 | 9 | 3295.3 | 3555.1 | passed |
| 0y1bWl | calculator | 2 | 9 | 3274.0 | 3527.4 | passed |
| 0y1bWl | calculator | 3 | 9 | 3273.3 | 3539.8 | passed |
| 0y1bWl | calculator | 4 | 9 | 3352.5 | 3599.2 | passed |
| 0y1bWl | calculator | 5 | 9 | 3311.0 | 3558.0 | passed |
| 0y1bWl | textedit | 1 | 4 | 1370.4 | 1434.1 | passed |
| V1A67B | calculator | 1 | 9 | 3293.3 | 3555.4 | passed |
| V1A67B | calculator | 2 | 9 | 3280.4 | 3529.5 | passed |
| V1A67B | calculator | 3 | 9 | 3425.5 | 3798.8 | passed |
| V1A67B | calculator | 4 | 9 | 3306.1 | 3572.8 | passed |
| V1A67B | calculator | 5 | 9 | 3298.0 | 3533.6 | passed |
| V1A67B | textedit | 1 | 4 | 1363.8 | 1424.8 | passed |
| XRPTW4 | textedit | 1 | 4 | 1360.6 | 1446.7 | passed |

## Earlier optimized revision

Attempt `H2ChNF` completed 15/15 trials before the final screenshot invalidation fix. Its code
already prevented delayed reads from refilling the cache after input, but a screenshot could still
be followed by an older pending read. Review reproduced that case in unit tests. These live calls
awaited each operation and did not exercise the race. The final comparison uses the later revision.

| App | Repetition | Guard reads | Guard ms | Engine ms | Total ms |
|---|---:|---:|---:|---:|---:|
| calculator | 1 | 9 | 3367.8 | 3611.2 | 3612.9 |
| calculator | 2 | 9 | 3346.0 | 3592.8 | 3594.3 |
| calculator | 3 | 9 | 3322.8 | 3575.3 | 3577.7 |
| calculator | 4 | 9 | 3309.0 | 3593.3 | 3594.9 |
| calculator | 5 | 9 | 3373.9 | 3613.8 | 3615.3 |
| textedit | 1 | 4 | 1373.1 | 1430.3 | 1431.7 |
| textedit | 2 | 4 | 1399.9 | 1455.7 | 1457.4 |
| textedit | 3 | 4 | 1394.1 | 1446.4 | 1448.2 |
| textedit | 4 | 4 | 1376.0 | 1428.5 | 1430.0 |
| textedit | 5 | 4 | 1361.6 | 1413.4 | 1415.6 |
| chess | 1 | 1 | 497.4 | 582.0 | 583.9 |
| chess | 2 | 1 | 408.9 | 462.9 | 465.1 |
| chess | 3 | 1 | 396.6 | 449.7 | 451.6 |
| chess | 4 | 1 | 407.1 | 456.5 | 458.6 |
| chess | 5 | 1 | 411.0 | 454.8 | 456.8 |

The corrected harness keeps all five TextEdit repetitions in one document. Cleanup requires a fresh
exact URL and refuses a second close after an uncertain result. Server requests and client
requests have independent JSON-RPC IDs. Only a response without `method` ends engine timing. The
published final traces retain message direction, ID and method, plus numeric guard metrics. They
contain no screenshot data or AX contents.
