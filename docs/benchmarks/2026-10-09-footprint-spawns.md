# Session and call footprint

This records the first patch at `2e3b887`. Review rejected unconditional browser startup
and the shared two-second deadline. The [follow-up](2026-10-09-footprint-spawns-2.md) records their
replacements and later checks. The measurements below remain the original receipts.

Branch `codex/footprint-spawns`, based on `37c6561`, engine 26.1002.52244. No model calls.
The [raw results](2026-10-09-footprint-spawns.json) include every measurement and historical
acquisition interval. The owner was away, according to the dispatch. These are development probes,
not a Codex comparison or release qualification.

## Changes

- Ordinary launch starts one engine with native apps and extension browsers. The session discovers
  connected extensions when asked. Doctor keeps its separate discovery probe; explicit surfaces
  and backend choices keep their meaning. Native/browser guards and approval routes are unchanged.
- App health, local-tool target resolution and the turn-end keyboard-tap scan share one helper.
  Queries keep their request IDs. A timeout refuses target resolution, retires the helper and lets
  the next request start another. Closing the session collects the helper, including forced exit.
- A lease manager keeps its SQLite connection until close. Each transaction still takes the same
  nonwaiting lock and rolls back before returning. Ownership, expiry and overlap checks remain.
- Small desktop screenshots read dimensions from their PNG or JPEG header and forward the original
  bytes. Terminal cells and larger desktop images still use the pixel decoder. Pane layout metadata
  stays the same. Two smaller JPEG fallbacks cover images that exceeded the old five-attempt budget.

## Spawn paths

The default `js` path already used a session helper for app-health and read-failure diagnosis.
Its extra `osascript` spawn was the keyboard-tap scan after a driven turn ended, which delayed the
turn-end reply. Lease-target resolution is a local-tool path and does not run for ordinary `js` calls.
Those target queries now share the health helper as well. Approval dialogs still need their own
helper when the configured approval route asks a person.

| Path | Before | After |
|---|---|---|
| Health and read-failure diagnosis | One helper per session | One shared helper per session |
| Keyboard-tap scan | One process per driven turn end | Query on the shared helper |
| Local-tool target resolution | One process per call | Query on the shared helper |
| Ordinary engine startup | Discovery engine, then session engine | Session engine only |

## Offline measurements

Alternating pairs use `node bench/footprint-spawns.mjs pairs BASELINE_WORKTREE OUTPUT.json`.
The following table gives medians across the three runs for each arm. Load ranged from 22.5 to 25.0,
with a median of 23.6 in both arms. CPU and wall medians are calculated separately.

| Operation | Count per run | Before CPU s | After CPU s | Before ms | After ms |
|---|---:|---:|---:|---:|---:|
| Lease acquire, renew, release | 1,000 | 0.941994 | 0.738510 | 1,064.0 | 907.1 |
| Desktop PNG | 12 | 0.050327 | 0.000328 | 38.3 | 0.3 |
| Desktop JPEG | 12 | 0.096480 | 0.000332 | 83.9 | 0.2 |
| Terminal PNG | 12 | 0.049883 | 0.086965 | 42.2 | 72.0 |
| Terminal JPEG | 12 | 0.134691 | 0.125070 | 112.9 | 103.2 |

The lease connection saved about 0.20 CPU seconds per 1,000 cycles. Header-only desktop panes
removed almost all decode cost for these small images. Terminal code is unchanged and the samples
do not show a consistent improvement. The initial pair below is also preserved.

`node bench/footprint-spawns.mjs OUTPUT.json`, synthetic 674 by 408 images, bundled codecs.
CPU is this Node process's user plus system time. Wall time includes scheduling. The first pair
overlapped Puddle's reserved window without driving an app or adding load workers. Load averages are
the one-minute values at each measurement's start. The JSON contains all three load values.

| Operation | Count | Before CPU s | After CPU s | Before ms | After ms | Load before / after |
|---|---:|---:|---:|---:|---:|---:|
| Lease acquire, renew, release | 1,000 | 1.154642 | 0.783635 | 1,412.6 | 1,038.0 | 32.8 / 33.4 |
| Desktop PNG | 12 | 0.087700 | 0.001379 | 114.9 | 3.4 | 33.5 / 33.4 |
| Desktop JPEG | 12 | 0.221166 | 0.000792 | 169.3 | 0.8 | 33.5 / 33.4 |
| Terminal PNG | 12 | 0.118778 | 0.106924 | 164.7 | 124.9 | 33.5 / 33.4 |
| Terminal JPEG | 12 | 0.169377 | 0.235362 | 167.8 | 315.7 | 33.5 / 33.4 |

The terminal JPEG path did not improve. Its decoding work is unchanged, and this pair varied in CPU time.
The desktop samples fit below 16,000 base64 characters (PNG 1,817 bytes, JPEG 8,197 bytes).
Their savings do not apply to large screenshots that still need resizing.

## First acquisition

The cited Calculator-menu trace is
`2026-10-09T22-11-00-141Z/sleight-calculator-menu-1/trace-5678.jsonl`.
The relay forwarded `sleight-acquire-0` at 22:11:16.336 UTC. The engine asked for approval at
22:11:18.126. Acceptance was forwarded at 22:11:18.128, and the acquisition answered at 22:11:45.811.
That is 1,790 ms before approval, 2 ms in the approval route, and 27,683 ms afterward, inside the
engine. The trace cannot split native acquisition from its first read. There was no second engine
running in that interval. `server-discover-probe-1` is Claude's MCP discovery request, rejected
locally with method-not-found, not the browser inventory probe. The dispatch reports load 21.

## Live probes

`node bench/footprint-spawns-live.mjs BASELINE_WORKTREE OUTPUT.json` alternates three pairs. It uses
an already-running Calculator in the background and takes the mkdir lock without waiting.
If Calculator is absent, it measures only engine startup and helper queries without launching an app.
The hold is checked before each probe. Each worker collects its own children and leaves Calculator
running. The parent forwards terminal cancellation through a private file and waits for worker
collection. A failed cleanup retains the lock. CPU comes from portable `time -p`, including the
worker's waited children. The engine's shared native helper and Calculator are outside that total.

The Puddle hold still existed at 23:45:18 UTC, after its stated approximate end. Live results are
deferred until its owner removes the file. This branch has no native timing or acquisition proof
from a new live run. The helper and startup changes have unit coverage and require live qualification.

## Verification and attempts

The first regression run failed four of five tests. Launch started a second engine and shared helper
methods were absent. Small PNG/JPEG snapshots also loaded a decoder. The terminal cell test passed.
Later tests exposed incomplete helper collection and the old JPEG size floor. Both have fixes and
regressions. Review caught the macOS-only test dependency; portable fixtures now cover metadata and
cell packing, and the real-codec resize test skips on hosts without ChatGPT. Review also reproduced
exit 13 while awaiting forced helper collection. Ref'ing the child and pipes fixed it. A separate
layout regression caught changed frame dimensions, which are now preserved.

The first trace-analysis attempt could not measure acquisition because truncated content was a string.
The published analyzer uses timestamps and metadata only. Detailed `time -lp` exited 1 because
the sandbox denied its clock-rate query. Portable `time -p` exited 0 and supplies CPU and wall time.

The first full check exited 1 after sandbox denials for local test sockets and worktree artifact
writes. The approved retry passed 996 of 997 unit tests, with the existing hover fixture's cold
Swift build exceeding its 60-second test deadline. `npm run build:hover-fixture` then exited 0
outside that deadline. The final bare `npm run check` exited 0 with 997 unit tests, both plugin
validations and 11 mod tests passing. Vale sync first exited 2 when the sandbox prevented
style setup, then exited 0 on the approved route. The first prose check exited 1 with 15 wording
errors, which have edits. The next bare `npm run lint:prose` exited 0 across 60 files. Adding the
paired table introduced one wording error, then corrected with another exit-0 prose check. A focused
run passed all 52 helper, lease, discovery and footprint tests. `git diff --check` exited 0.
