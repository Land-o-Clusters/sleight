# Simulator coordinates and focus, 2026-10-10

The first tap missed the phone itself in 6/6 stored resized runs, so they do not establish Safari
focus failures.
No live app was accessed in this investigation. The new note and probe await owner-away checks.

## Stored evidence

The [extracted rows](2026-10-10-simulator-focus.json) retain all nine simulator runs from
[shots-base](2026-10-09-shots-base.json), [shots-scaled](2026-10-09-shots-scaled.json), and
[shots-scaled-tap](2026-10-09-shots-scaled-tap.json). All nine eventually submitted the exact fixture
text, which does not validate the first tap.

The resized runs showed 1568 × 1140 images. Each first tap used `[895,201]`, inside the Message
field in that image (approximately x815 to 977, y191 to 212). Each next stored image showed the
pointer near `[639,144]`, in blank Device Hub space left of the phone. Those approximate coordinates
agree with `[895,201] / (2200/1568)` within the pointer overlay's size. This was visible in all six stored images, including the three
runs that separated tapping from typing. The inactive appearance of some first windows became active
after the tap, but the pointer remained outside the phone. Activation may matter separately; these
runs do not isolate it.

The base arm's transcript images were 2000 × 1455. Claude's image metadata explicitly names an
original 2200 × 1600 image and a 1.10 coordinate multiplier, confirmed by the saved JPEG header.
An initial rough calculation used 2196 × 1598. Inspecting that metadata corrected it before handoff.
Runs 1 and 3 first used `[627,141]`, then succeeded
at `[1254,282]`. Run 2 used `[1254,282]` first and succeeded. Claude's coordinate guesses explain
those two first misses without a Safari timing claim.

Capture Keyboard stayed off in 4/6 resized runs that succeeded. In the other two runs Claude enabled
it after misses and left it enabled. Those runs also changed tap coordinates, so they do not prove capture was needed.
The existing warning about Device Hub's stalled keyboard filter tap still applies.

## Scale association

The parked `perf/screenshot-scale` change, commit `1aa574b`, records the resize factor only when
`screenshotOf` sees an image and a Window/App header. A standalone first `getScreenshot()` result
in these traces has an image without that header. Its factor is not associated with the app.
The first tap runs without the factor. That action's response includes the guard's
Window header, allowing later screenshots to register their factor. In resized-tap run 1, the
identical `[895,201]` second tap then reaches the field.

This source path and the six pointer images agree. Trace code is truncated, so it cannot independently
show every injected scale value. A fresh instrumented reproduction is still needed before calling
this the complete native cause. This work leaves the resize branch parked. It does not change
`document-scope.mjs`, `compact-reads.mjs`, input coordinates, or engine/helper code.

## Advisory change

With `SLEIGHT_SIM_FOCUS_NOTE=1`, the relay adds actual transmitted image dimensions and simulator focus guidance to standalone
`getScreenshot()` or `getAXStateAndScreenshot()` replies on an acquired Simulator/Device Hub handle.
The note uses that exact handle, even if another app was acquired more recently. Unknown handles,
batches, browser replies, errors, contradictory headers, and multiple images don't receive a note. The note
asks Claude to check visible focus before typing and to leave Capture Keyboard unchanged. It adds
no tap, retry, sleep, clipboard action, or coordinate transform. No skill line changed.

The note is off by default until the affected task runs with it. This guidance has unit proof only. It does not establish fewer model turns, first-tap success, or a
fix for the release pass's later missed taps. Native Safari timing, activation, and keyboard routing
remain unisolated. The headerless association defect belongs to the parked resize branch; this
advisory change does not repair that branch's factor bookkeeping.

## Checks and failures

`node --test tests/simulator-focus.test.mjs` first failed 3/4 against the empty helper, then passed
4/4. A malformed JSON header test failed 1/4, then refusing that header passed 4/4. The actual relay reply
test then failed 1/5 before integration. After integration it reached a separate test setup error:
the ambiguous preceding reply had cleared the lease, so the coordinate action never forwarded.
Adding an event-loop wait did not change that failure. Reacquiring the test handle before the action
passed 5/5, exit 0. The test also checks that images and coordinate expressions are unchanged and
that an unrelated last-acquired app cannot supply the screenshot's note.

The probe passed `node --check` three times, each exit 0, after its initial draft, failure collection,
and cleanup-lock review. It has not been run. The parent lane will run the full suite and prose gates.
The JSON lists every test and syntax run in this lane, including the failed setup attempts.
The final focused run included `simulator-focus`, `relay-images`, and `relay-input-lease`: 72/72,
exit 0.
The report's direct Vale check first found 11 errors, exit 1. After editing it passed with zero
errors, exit 0.
An offline metadata extractor initially assumed every user message had an array content body and
failed with `some is not a function`, exit 1. Adding the array check succeeded, exit 0, and the saved
JPEG header check also exited 0. These commands read stored files only.
The metadata follow-up's Vale check found one error, exit 1, corrected in the final prose pass.

Probe review found that device boot preceded viewer ownership checks. Setup now refuses an existing
viewer before boot and records the chosen device before attempting boot. Hold checks cover setup
and cleanup boundaries. Its controlled setup tests first failed 4/4, exit 1, then passed
4/4, exit 0. A test for persisting boot ownership failed 1/4 before the recording callback was added.
The final setup and screenshot tests passed 9/9, exit 0. These tests use fake launch operations and
do not boot a device or open an app.

## Pending owner-away probe

sleight-arch can run `node bench/simulator-focus-live.mjs --owner-away --observation screenshot`,
then repeat with `--observation combined`. Each run takes `/tmp/sleight-live.lock` without waiting
and stops for `/tmp/sleight-hold`. It refuses an already-booted iPhone or an existing viewer, then
uses the benchmark's retained-window fixture lifecycle to own a new viewer and boot.

The script captures a fresh image to a private temporary bank and prints that bank's path. Inspect
the image, read `point-request.json`, and write `tap.json` beside it with the requested SHA-256 and
integer `x` and `y` inside the current Message field, measured in the saved image's dimensions.
It refuses a mismatched hash or out-of-bounds point. Supply the point within 120 seconds.

The local fixture records browser pointer, click, focus and viewport events. The script sends at
most two identical taps, taking screenshots and collecting telemetry after each. It doesn't send text
and never toggles Capture Keyboard. It closes its engine client, fixture viewer, server and owned
device boot. Unconfirmed cleanup retains the live lock and evidence. SIGINT begins owned engine
collection. Inspect the final result before treating cancellation as complete.

Publish the scrubbed `result.json`, including failed attempts and cleanup status. Keep screenshots
private until checked for device names. First-tap page telemetry distinguishes a coordinate miss
from a tap delivered to the field without focus. Comparing the two observation modes tests whether
the first image's missing header explains the parked branch's behavior. Run this only with the
owner away. A separate affected-task `simulator-form` run is needed to qualify the new advisory note.
The follow-up scrubs the device UDID and name from every JSON string, including nested ownership,
errors and rows, before writing the result. It retains the real identifiers only in memory for cleanup.
See the [follow-up handoff](2026-10-10-sim-savelock-2.md) for commands with the note enabled.
