# Session footprint, third review

Rebased `codex/footprint-spawns` onto `a64728e`, including `83188cf` and the replay bridge.
The [raw receipt](2026-10-09-footprint-spawns-3.json) contains every run, including failures.
Measurements ran on 2026-10-10 UTC, after the shared hold disappeared. No model calls ran.

## Corrections

Connected-extension results last six hours, and negative results last 24 hours. Every automatic session
refreshes after initialization. Its tool description remains fixed, so a newly connected extension
becomes available in the next session after a successful refresh. Failures preserve the previous
timestamp. Publication uses a short SQLite lock that releases on process death and prevents an older
completed discovery from overwriting a newer result. Explicit surface settings still skip discovery.

Lease transactions recreate a missing directory, check the coordinator's device and inode before
reuse, and reopen changed files. Opening is checked before and after, with another check after
`BEGIN IMMEDIATE`. Rollback failure closes the connection. Failed close blocks later transactions.
Callbacks never replay after starting. Ownership tokens and the zero busy timeout remain in force.
Path metadata checks cannot prevent arbitrary filesystem replacement throughout an action; removing
the coordinator during live use remains prohibited. SQLite warns that opening and closing a separate
verification descriptor can release process locks, so verification uses metadata alone.
See [SQLite's locking documentation](https://www.sqlite.org/howtocorrupt.html#posix_advisory_locks_canceled_by_a_separate_thread_doing_close).

Health probes, lease targets and tap scans use three lazy helper lanes. Targets and taps retain their
own 30-second deadlines. Probes retain two seconds. A stuck scan cannot delay a target.
If its helper fails, the error says reading the app again will not help.

## Before and after

The comparison used three alternating pairs against `a64728e`, with CPU in seconds and time in milliseconds.
Offline load was 5.49 to 5.53. Native helper load was 5.48 to 5.61.

| Probe | CPU before | CPU after | ms before | ms after |
|---|---:|---:|---:|---:|
| 1,000 lease acquire, renew, release cycles | 0.835658 | 0.679801 | 857.28 | 731.65 |
| 12 desktop PNG frames | 0.038164 | 0.000153 | 30.01 | 0.15 |
| 12 desktop JPEG frames | 0.079819 | 0.001257 | 69.02 | 0.72 |
| 12 terminal PNG frames | 0.041717 | 0.060526 | 35.12 | 47.17 |
| 12 terminal JPEG frames | 0.080449 | 0.083718 | 72.12 | 75.74 |
| Native helper worker, six health reads, five targets, five scans | 0.98 | 0.61 | 1,230 | 860 |

Native helper spawns fell from 11 to three in each pair. Across all 15 calls per side, median target
resolution fell from 82.80 to 41.51 ms and tap scanning from 46.09 to 7.65 ms, including each lane's
first call. Terminal frames didn't improve, and these small probes don't establish Codex footprint parity.

## Discovery and surfaces

Background discovery succeeded in 3/3 runs, finding one connected extension at load 6.21 to 6.32.
The timed worker and engine group used 0.18, 0.18 and 0.17 CPU seconds. Subtracting the worker's own
CPU gives estimates of 0.138, 0.137 and 0.126 seconds for the engine and its children. Median elapsed
time, including process collection, was 480.47 ms. This cost now occurs every automatic session.
`/usr/bin/time -p` prints hundredths, so the subtraction is an estimate.

The session comparison used three alternating pairs with a pure JavaScript marker and two warm markers, without
app acquisition, at load 5.76. Median group CPU was 0.16 seconds for `computer` and 0.15 seconds for
`browser,computer`. Initialization was 131.52 and 128.01 ms, first calls were 194.73 and 167.49 ms,
and warm calls were 0.88 and 0.89 ms. First replies were 21,093 text bytes in both settings. This probe
does not measure model behavior or browser actions.

## Native proof and failed attempts

The real production helper factory resolved Calculator in 113.29 ms and scanned taps in 80.01 ms,
returning its bundle ID and a successful list of three taps. Both helpers were collected and the
live lock released. The receipt retains only the tap count and Calculator's bundle ID.

The first proof stopped on a busy live lock before spawning. The sandboxed proof could not resolve
Calculator and returned `CGGetEventTapList failed`, while the host run above passed. Three sandboxed
discovery runs failed their inventory call. A sandboxed native pair returned denied health, and a
sandboxed surface pair could not execute its marker. Each stopped or collected its owned children
and released its lock when held.

Acquiring Calculator through the host engine failed after 1,044.63 ms with ScreenCaptureKit error `-3811`,
audio/video capture failure. The native timings cover helpers without engine acquisition. The capture failure
prevented screen and Space qualification. The probes didn't launch apps, move the pointer, answer macOS
or app dialogs, or restart ChatGPT. The user's existing Calculator preapproval handled the engine
prompt. The historical 29.5-second acquisition's native cause remains unknown: its trace
puts 27,683 ms inside the engine after acceptance, after browser discovery had ended.

## Checks

The first regression run exited 1, with 14 failures out of 62 tests. After the fixes and extra
cross-process and negative-cache coverage, 64 passed. Review found an abandoned publication lock;
its new regression failed, then all 65 focused tests passed with SQLite publication locking.
The sandboxed full check exited 1: 1,026 passed and 44 failed on socket permissions and permission
to write a compiled fixture. A host attempt at load 103.31 was cancelled through its owned terminal.
The next host check exited 1: 1,068 of 1,070 passed. PDF and Chess fixture compilation each timed out
at 180 seconds. The native drag fixture passed after 177.7 seconds. These attempts remain in the receipt.
The final bare `npm run check` exited 0 at a starting load of 10.90. All 1,070 tests passed in
89.95 seconds, both plugin validations passed, and all 11 mod tests passed. Bare `npm run lint:prose`
exited 0 across 62 files.
