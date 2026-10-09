# Guard speed experiment, 2026-10-09

The native per-action speedup is unfinished. The branch keeps every production guard read and
adds a compactor fix for uniquely identified degraded button lines. The engine refused the
experimental Unix socket with `connect EPERM`. The observer also failed under load. Engine
binaries, permissions and sandbox policies are unchanged, and macOS permission prompts were left
untouched.

## Method

Base `pane/auto-mode` at `1bdfd39`, branch `codex/guard-speed`, engine 26.1002.52244. All live
runs held `/tmp/sleight-live.lock`. Calculator input used engine app handles, with no pointer
actions or foreground fallback. Desktop visibility and system dialogs were not independently
verified, so these are background API measurements. The owner has not reproduced them.

There were zero model turns and zero model milliseconds in every measurement; time per model
turn does not apply. Tool timings include engine and transport time. Resets and separate value
verification are outside the timed action. Each arm must return `0` after reset and the expected
current Calculator value afterward. Every run, including failures, is linked below. Paths use
`~`, and the evidence was checked for the owner's name.

`node bench/load-cost.mjs --workers 0,20 --reps 5 --warmup-ms 60000` alternates direct-engine and
sleight calls within each repetition. The direct arm is a cost reference with no sleight guard.
Later compactor ambiguity and benchmark cleanup corrections have unit coverage; this timing run
started before those review corrections. No timing improvement is attributed to them.
Medians use the upper middle sample when the count is even, matching the existing benchmark.

## Native observer

| Probe | Load | Successful observations | Median reply ms |
|---|---:|---:|---:|
| Cold JXA | 3 | 3/3 | 78.39 |
| Persistent JXA, after startup | 3 | 19/19 | 2.06 |
| Socket observer, first run | 6 | 20/20 | 12.97 |
| Socket observer, second run | 6 | 20/20 | 3.85 |
| Socket observer, 20 workers | 62 to 67 | 6/20 | 104.28 |
| Socket observer, final 20-worker run | 43 | 0/20 | 0.18 (refusals) |

The socket observer reads process lifetime, focused window identity, title, AXDocument, sheets,
dialogs and matching windows. Its median includes failed replies: 14/20 returned
`AXFocusedWindow: AX error -25204` after the 100 ms AX messaging timeout. Successful
replies ranged from 16.92 to 206.76 ms. These results do not qualify an observer at load 100.
The comparison covers cold and persistent JXA. A new helper binary was not tested.

The final attempt started after the live lock became free. Load had fallen by then and reached
43 with 20 workers, so native observations at load 100 remain unmeasured. It returned two AX
errors, one expired request and 17 `busy` refusals while the expired request was still pending.
Its low median measures refusal time. Every observation was unusable. All 20 workers
were collected, and Calculator was confirmed absent afterward.

The relay-side client could read the socket, but engine JavaScript could not connect. The raw
engine diagnostic was `connect EPERM`. The proposed integration and guard-routing tests are
archived as an unapplied [patch](../../bench/guard-speed-native.patch). Production does not load
the prototype. Further work needs a supported transport and reliable observation latency.

In three deliberate helper suspensions, the socket returned `expired` after 250.47, 251.43 and
251.46 ms. These were bounded refusals, not successful window checks. A reply received after its
deadline is refused even if the timer itself was delayed. Pending helper work is not queued behind
a timed-out request. Process identity and retained AX references distinguish same-title replacements;
ambiguous windows, multiple processes and missing required attributes fail closed.
The final suspension returned `busy` in 0.14 ms because earlier AX work was still pending.

## Abandoning the final read

Each trial pressed `1` before starting a full read. A 100 ms timer raced the unawaited read.
Across four trials the engine returned after 516.32 to 562.92 ms. Each result said
the read was pending at 100 ms. In the following pure call it was already complete. Those calls
took 1.14 to 1.31 ms, and the following input calls took 58.99 to 79.17 ms.

This did not demonstrate a 100 ms tool return or a next call running alongside a pending read.
The guard keeps the final state read without an abandonment deadline.

## Compactor before and after

The replay starts from the full live Calculator tree in the first socket probe, then changes
the digit button lines to the previously observed engine form `button Two`. This is constructed
attribute loss, not a claim that the new live run returned that exact degradation. The original
compactor at `1bdfd39` emitted 742 characters; the changed compactor emitted 313, a 58% reduction.
The [summary JSON](2026-10-09-guard-speed-summary.json) includes both trees, both outputs, 100-replay
median timings and the compactor source hash. Matching the lines takes fractions of a millisecond
in this fixture. Engine read time is unaffected.

Only unique button IDs fold. Rich and bare duplicate IDs in either tree prevent folding; lost
values and state still produce changes. Renumbering still becomes stale. A degraded remap checks
the current tree and retained beliefs for ambiguity before using one current line. Missing
descriptions and help are explicitly unavailable. Regression tests cover these cases.

## Interleaved timings

The earlier brief measured one click at load 20 as 87 ms direct and 841 ms through sleight;
eight clicks took 839 and 3,965 ms. At load 96 to 121, one click took 159 ms direct and 38,000 ms
through sleight. Those runs had different load and are context, not paired evidence of a speedup.

Current natural-load medians, five repetitions per arm:

| Call | Load | Direct ms | sleight ms | Failed trials, direct / sleight |
|---|---:|---:|---:|---:|
| Eight clicks | 17 to 20 | 684.16 | 3,422.09 | 0/5, 0/5 |
| One click | 15 to 16 | 94.88 | 487.43 | 0/5, 0/5 |
| Click then three keys | 14 to 15 | 295.44 | 1,727.92 | 0/5, 0/5 |
| Read without new input | 14 to 15 | 133.65 | 54.43 | 0/5, 0/5 |

With 20 workers:

| Call | Load | Direct ms | sleight ms | Failed trials, direct / sleight |
|---|---:|---:|---:|---:|
| Eight clicks | 41 to 101 | 4,959.25 | 42,599.99 | 2/5, 2/5 |
| One click | 87 to 106 | 99.02 | 19,418.16 | 2/5, 2/5 |
| Click then three keys | 85 to 125 | 265.96 | 5,574.77 | 0/5, 0/5 |
| Read without new input | 123 to 126 | 118.03 | 59.28 | 1/5, 1/5 |

These medians include every timed call, including unconfirmed results and guard refusals.
Five of the failed trials stopped during reset, before timing began. Timed sample counts are
4/5 for direct eight-click trials, 4/5 for both one-click arms, and 4/5 for both read arms. Every
other arm has five timed samples. The summary also gives medians for verified outcomes only:
the 20-worker one-click medians are 93.90 ms direct and 1,932.61 ms through sleight, each with 3/5
verified trials. Discarding the failures would conceal the unreliable reads.

70/80 trials verified their expected value. A missing or ambiguous current input field caused
nine failures. One sleight batch stopped before `click(14)`: its former `Four` button
had become `Multiply`. None of those ten trials counts as a successful action sequence.
Production still performs every per-action and post-call read. These data establish no guard
latency improvement.

The benchmark's older in-memory script returned exit 0 despite the failed trials. The final
script returns exit 1 when any trial fails. Its stdout also printed `NaN` load ranges for reset
failures, now fixed by filtering missing load values. The raw JSON and summary retain the valid
measurements. Direct-client shutdown recorded a missing `hook_event_name` error, then both engine
children exited 0. That protocol field is fixed and regression-tested. All 20 CPU workers were
collected and the native observer confirmed Calculator absent before the live lock was released.

## Every attempt and added-load intervals

Times below are UTC on 2026-10-09. The native probe's 20 workers ran from 17:43:45.169 to
17:44:50.043. The interleaved run's 20 workers ran from 17:47:22.385 to 18:02:36.963. The final
probe's 20 workers ran from 18:05:29.511 to 18:06:32.448. Only those runs added deliberate CPU
load. Unit checks, including a native fixture compilation, and prose
lint overlapped part of the interleaved run. Other projects may also have been running.

| Started | Evidence | Outcome |
|---|---|---|
| 17:28:33.945 | [Sandbox attempts](2026-10-09-guard-speed-sandbox-attempts.json) | Evidence write denied; no native observation retained |
| 17:28:47.297 | [Preflight](2026-10-09-guard-preflight-2026-10-09T17-28-47-297Z.json) | Early boxed-count comparison; no observation claim |
| 17:30:16.656 | [Sandbox attempts](2026-10-09-guard-speed-sandbox-attempts.json) | Nested sandbox startup and evidence write denied |
| 17:30:29.161 | [First cold/warm probe](2026-10-09-guard-native-2026-10-09T17-30-29-161Z.json) | Incorrect `absent` replies from boxed-count comparison; discarded as window timings |
| 17:31:10.106 | [Corrected cold/warm probe](2026-10-09-guard-native-2026-10-09T17-31-10-106Z.json) | 3 cold and 19 warm observations, plus startup |
| 17:38:55.176 | [First socket/read probe](2026-10-09-guard-probe-2026-10-09T17-38-55-176Z.json) | Relay reads succeeded; engine socket unavailable |
| 17:39:21.309 | [Socket diagnostic/read probe](2026-10-09-guard-probe-2026-10-09T17-39-21-309Z.json) | Exact engine `connect EPERM` diagnostic retained |
| 17:43:42.401 | [20-worker native/read probe](2026-10-09-guard-probe-2026-10-09T17-43-42-401Z.json) | 14/20 AX observations unavailable; workers collected; Calculator absent afterward |
| 17:46:10.378 | [Interleaved calls](2026-10-09-load-cost-guard-speed-2026-10-09T17-46-10-378Z.json) | 70/80 verified, 20 workers collected, Calculator absent afterward |
| 18:03:11.406 | [Final native-probe attempt](2026-10-09-guard-probe-2026-10-09T18-03-11-406Z.json) | Another run held the live lock. Stopped before adding load or accessing an app |
| 18:05:27.618 | [Final native/read probe](2026-10-09-guard-probe-2026-10-09T18-05-27-618Z.json) | 0/20 usable observations, 20 workers collected, Calculator absent afterward |

The early probes predated the corrected app-count ownership preflight and had no independent
native exit receipt. All four completed socket/read probes confirmed Calculator absent after quitting
their acquired app. Scripts now distinguish multiple processes from absence, collect failed worker
spawns, and retain the direct app handle through cancellation cleanup. Cancellation waits for the
current bounded engine call to finish before quitting Calculator and closing its clients.

## Validation

`npm run check` exited 0: 729 Node tests, both plugin validations and 11 mod tests passed.
The earlier sandbox run exited 1 with four socket/fixture access failures, followed by the passing
host-access run. `npm run lint:prose` exited 0 with zero flags after the local Vale style cache
was copied from the primary checkout and prose findings were fixed. A static review found
the duplicate-ID and cleanup cases described above. The corrections passed a second static review.
The native integration patch remains unapplied, and latency work is incomplete.
