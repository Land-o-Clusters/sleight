# Engine time

The 21-run acquisition pass spent 456.3 s in the model, 190.8 s in the engine and 737.9 s overall.
Relay work was 0.37 s, local work 42.5 s and the remaining time 47.9 s. These are the existing
`2026-10-08-acquisition-echo.json` totals. This study didn't run model calls or a full benchmark pass.

## Where reads wait

Engine 26.1002.52244 on 2026-10-08, five repetitions per case, Calculator, session approval caching
as in the relay. Times below measure the awaited API method, in ms:

| Read | Idle | After Escape | Repeat without input |
|---|---:|---:|---:|
| AX | 48 | 416 | 45 |
| AX and screenshot | 29 | 413 | 42 |
| Screenshot | 32 | 437 | 64 |

Escape itself took 3 to 5 ms. Waiting 0, 100, 350 or 700 ms before the next AX read still left
median read times of 419, 423, 423 and 413 ms. A caller sleep adds time without paying down this
cost. The installed Mac binding sends all three reads through the same native state capture;
AX-only discards the image. Its JavaScript has no settling option or delay. The helper contains
`needsUISettleBeforeSkyshot`. Together these suggest a wait charged on the next capture after
input. The measurements cannot separate that wait from native AX, image capture or scheduling.
They do rule out a cheap screenshot-only path and an elapsed-time debounce in these cases.

The Mac API has no `listWindows`; `listApps` returned app identity and use count, without a title,
URL or window list. Actions returned `undefined`. None can replace the guard's header read.
Reading in parallel with the next action cannot validate that action before it runs; a read begun
before input also cannot validate the changed window. Parsing these small trees cost under 0.1 ms.

## What changed

`getScreenshot()` now asks for the combined capture and reuses its full AX observation. Image
bytes and emission stay the same. The guard gets the header and selectors the engine already read.
Missing combined support falls back to the original screenshot and a separate guard read.
Every action still checks title, app and URL, with the existing exceptions. Numbers still stop on
changed elements, IDs and labels resolve freshly, and every call finishes with a full lease header.
An action through any handle invalidates cached reads. Late reads cannot put old state back.
Tests cover these paths, invalid headers, capture failure, denied native access and lease loss.

The sequential app blocks ran five repetitions per row and version. All 50 calls completed:

| Sequence | Guard reads before / after | Guard ms before / after | Call ms before / after |
|---|---:|---:|---:|
| Calculator, eight IDs | 9 / 9 | 4091 / 3614 | 4510 / 4100 |
| TextEdit, select, type, save | 4 / 4 | 1370 / 1354 | 1435 / 1423 |
| Chess, combined read, Escape | 1 / 1 | 402 / 413 | 451 / 483 |
| Chess, screenshot, Escape | 2 / 1 | 441 / 412 | 501 / 468 |
| Chess, Escape, screenshot | 2 / 1 | 92 / 36 | 520 / 467 |

Only the last two rows remove work. The other differences measure run variation. Guard time omits
explicit screenshot calls. Engine time for the last two rows fell from 499 to 467 and 517 to 466 ms.
For contiguous typing, the skill now recommends one `typeText` call. TextEdit verified 5/5 saved
replacements per method, in alternating order, with a distinct eight-digit value per trial. Keys took
4088 ms and text took 1411 ms (engine 4086 / 1410, guard reads 11 / 4). An earlier word pair
failed bulk replacement, leaving `Engine01engine01` instead of `engine01`. Its cause is unknown;
the successful digit cases don't establish general replacement correctness. Verify the content.

## Proposal for review, kept out of the product

A Calculator-only probe checked identity and resolved eight IDs once, clicked the saved numbers,
then read the final window. Both arms verified distinct eight-digit results (5/5 each), in alternating
order. Median engine time was 3775 ms with strict checks and 801 ms with this sequence (79% less).
This prices a possible per-call mode for known stable controls, pending sleight-arch's decision.
It gives up intermediate identity checks, stale-number detection and fresh ID/label resolution.
A dialog, user edit or renumbering could send later input to the wrong document or control before
the final read notices. The product retains every check. Its guard remains cooperative JavaScript.

## Evidence and limits

Run `node bench/engine-time.mjs latency` or `floor`, and `node bench/guard-reads.mjs after all`
or `after typing`. The before source is commit `968398c`. Each live probe holds the shared lock.
[Raw results](../benchmarks/2026-10-08-engine-time.json) retain all 16 attempts, including sandbox
failures, uncached approval overhead, failed word replacement and uncertain fixture cleanup.
Exact-fixture recovery later confirmed both TextEdit fixtures closed.
The first Calculator runs matched text anywhere. The final floor probe checked the current input
field after a verified zero reset, with a distinct expected value per trial, and passed 10/10.
Native phase timings and large trees remain unmeasured. We tested three apps, without recording
owner activity or concurrent drivers. Workflow savings await sleight-arch's full benchmark pass.
