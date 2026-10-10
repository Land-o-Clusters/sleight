# Session footprint follow-up

Branch `codex/footprint-spawns`, rebased onto `7644809`, which includes `08abe24`.
This corrects the two findings on `2e3b887`. No model calls or live app driving ran in this follow-up.
The [raw receipt](2026-10-09-footprint-spawns-2.json) records attempts and pending measurements.

## Browser selection

Automatic startup uses a connected-extension discovery result less than one minute old, stored at
`~/Library/Caches/sleight/extensions.json`. Missing, expired, invalid or negative results select
`computer`. The cache is bound to the installed engine and doesn't store browser identities or approvals.
Setting `SLEIGHT_SURFACES` retains the requested backend settings and skips discovery.

After the session engine initializes, a missing or expired cache refreshes in the background for the
next session. The current session keeps its tool description. A fresh cache skips the extra engine.
Shutdown cancels and collects owned discovery. Discovery still declines prompts and uses the
four-second deadline. Cache reads reject links, special files, unsafe permissions and entries over
1 KiB. Failed cache reads or writes leave native control available.

This uses the engine's supported inventory instead of relying on private extension transport files.
The short cache lifetime limits stale positives to one minute. A newly connected extension requires
a later session after discovery completes. Cold sessions still pay discovery CPU in the background;
this change removes its synchronous wait and skips it while the cache is fresh.

## Native helper deadlines

Lazy session helpers replace per-call spawns. App-health probes use their own process and a two-second
deadline. Lease targets and keyboard-tap scans share a separate process, each with its original
30-second deadline. Each lane dispatches one request at a time. Queued requests get their deadline
when dispatched. A timeout collects the active helper before starting queued work on a replacement.
It cannot kill another lane's work or discard a queued operation.

Fake-clock tests leave a target pending for 29,999 ms while a probe times out after 2,000 ms, then
complete the target successfully. Another test times out a target at 30,000 ms and completes queued
taps 29,999 ms after their own dispatch. Existing reply identity and forced-exit collection tests pass.

## Measurements

The following medians remain the accepted SQLite and pane measurements from the
[first report](2026-10-09-footprint-spawns.md), three alternating pairs, load 22.5 to 25.0.
CPU is the measurement process's user plus system time. These were measured against `37c6561`;
they are not new native measurements on the rebased branch.

| Work | Before CPU s | After CPU s | Before ms | After ms |
| --- | ---: | ---: | ---: | ---: |
| 1,000 lease acquire/renew/release cycles | 0.9420 | 0.7385 | 1,064.0 | 907.1 |
| 12 small PNG desktop panes | 0.0503 | 0.0003 | 38.3 | 0.3 |
| 12 small JPEG desktop panes | 0.0965 | 0.0003 | 83.9 | 0.2 |

The native helper and session-engine surface measurements remain pending because
`/tmp/sleight-hold` still exists. It names another project's reserved window and says sleight-arch
removes it. The probe refuses that hold before spawning a helper or engine. No live lock was taken.

The prepared native probe alternates three baseline/branch pairs with `computer` fixed on both,
using only background reads of an already-running Calculator. It measures initialization,
acquisition, read, turn end, one cold and five warm health queries, five targets and five tap scans.
The expected helper spawn counts are 11 before and two after, derived from code, not a live result.
A separate `surfaces` mode alternates three pairs of direct session engines set to `computer` and
`browser,computer`, executing a pure JavaScript readiness marker three times. It measures engine
initialization, first/warm JavaScript, and collected process-group CPU without touching an app.
Both modes take the live mkdir lock and publish failed arms as well as successful ones.

```sh
node bench/footprint-spawns-live.mjs /private/tmp/sleight-footprint-baseline-7644809 /private/tmp/sleight-footprint-live-2.json
node bench/footprint-spawns-live.mjs surfaces /private/tmp/sleight-footprint-surfaces-2.json
```

The historical 29,475 ms acquisition still splits into 1,790 ms before elicitation, 2 ms accepting it,
and 27,683 ms inside the session engine after acceptance. The discovery engine had already ended.
Without the gated live run, the native cause remains unknown. It cannot be attributed to discovery.

## Verification attempts

- First regression run: exit 1, four failures exposing browser startup and helper isolation.
- Cache regression run before the fix: exit 1, three failures.
- Focused browser/helper/cache/read-failure run: exit 0, 32 tests after the initialization observer fix.
- Cache filesystem cases: six tests passed with exit 0. They include a FIFO and linked cache directory.
- The reviewer found that closing a readline observer could pause shared engine output. A plain data
  listener now detaches without pausing it. A split initialize reply followed by a tool reply passes.
- First bare `npm run check`: exit 1, sandbox denied local TCP/Unix sockets and hover-fixture output.
- The host-access check hit 180-second compiler deadlines at load 68.4. It was interrupted once
  through its original terminal handle and returned exit 1. No replacement build started then.
- Review after the fixes passed without findings.
- `npm run lint:prose`: exit 0 across 61 files after two wording repair passes.
- Final bare `npm run check`: exit 0 after load fell to 30.6 before launch. Both plugin validations
  and all 11 mod tests passed. The native prototype compiled in 90,692 ms in that run.
- `git diff --check`: exit 0. Native timings remain pending on the live hold.
