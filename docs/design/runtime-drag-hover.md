# Runtime drag and hover

RT12 keeps the local `drag` tool on `drag.js`. The Mac driver's pointer `drag` primitive has a narrower
contract and is separate. It must remain unregistered until its own safety and delivery gates pass.
`drag.js` retains its endpoint checks, text moves, timing, exposure checks, fallback rules
and cleanup, with the runtime adapter adding identity guards and release cleanup around its Shift settle.

## Adapter and integration

`createDragViaDriver({driver, runLocal, bindings, current})` returns a local-script runner. Import and
construction do nothing on the desktop. RT8 supplies it as the fourth argument to `callLocalTool` for
runtime local drags, after the existing approval and lease checks. The engine runner is unchanged.
Other scripts, including `drag-focus.js` capture, release and restoration, use the original runner.
The existing `performDrag` continues to own timeout cleanup and the optional after-drag read.

`bindings(request)` is a trusted parent callback. It returns `{source, destination?}` from the current
approved app's retained driver window records. Each record includes `windowId`, `pid`, `processStart`,
`bundleId`, `title` and `identityVerified`. For a cross-window request, both records must reference the same
app process and different windows. A null bundle ID is retained for apps whose resolved identity is
a canonical path. Their PID and process start must still match. Model arguments never supply these
records. The callback must check that the request's app resolves to the approved process. Inside the JXA child, the adapter checks
that drag.js selects that process and the bound source window before input. A missing source ID
keeps drag.js's ordinary ambiguity checks. Several candidates still refuse.
Admission requires a current lease and read, with a known app identity and unchanged process.

Before admission, the adapter snapshots the arguments. It resolves the requested app without
launching it and compares its process with the approved binding. It verifies each window through
`driver.verifyWindowIdentity(id, {processStart})`, checks `current()` after every await, then calls
`runLocal('drag.js', request, options)` exactly once. It forwards arguments without adding or replacing window
IDs, screenshot sizes, element lines, timing, DP flags or renderer exclusions. The launcher's runner
continues to set its deadline, feature flags and trusted hand PID. The parent runner must honor
`options.run`, the existing `runScript` execution hook. An admission exception has
`refused: true` and `delivery: not-sent`, so `performDrag` skips unnecessary focus cleanup.
An explicit stale source ID reaches the existing sole-window recovery only when fresh driver
inventory proves one visible window with the retained identity and no exact off-Space ID match.

The execution hook passes the current, unedited `drag.js` source to osascript, followed by a runtime
wrapper. The wrapper calls the original `findApp` and `resolveWindow`, then compares their actual
choices with the retained PID and window numbers. A different instance of the same app or a different
source window refuses before any AX write, window raise or event. Window IDs stay absent when the
request omitted them, so the wrapper cannot turn an ambiguous request into a chosen window.
Other launcher options, deadlines, trace handling and helper ownership stay with `runScript`.

The wrapper also replaces `settleAfterTextWrite` for runtime drags. It attempts Shift-up in `finally`
after every Shift-down step. A failed up attempt gets one more up attempt, then the original failure
propagates. Neither Shift-down nor the text move repeats. Persistent native failures can still leave
release unconfirmed, and drag.js still swallows settle exceptions. The engine path keeps the original
settle function, including its missing release cleanup. No live Shift fault was injected.

Legacy refusals return unchanged. After a success, the adapter checks both window identities again. Lost
identity changes the reply to unconfirmed delivery, with `retry: read-first`. A plain revocation
from `current()` maps to `USER_STOPPED` instead of a protocol error. Input is never repeated.
Executor exceptions also mean unknown delivery. The reply retains its reported path so
the existing launcher can decide which cleanup applies. A successful event post still does not prove
a non-text drop worked.

The checks before and after execution cannot close a process-replacement race inside the existing
JXA child. `drag.js` defines the checks during that interval. This adapter does not strengthen them into
a driver checkpoint before every AX write or event. A full Swift port would need to preserve those
checks, the text transaction and every refusal. Keeping one executor avoids maintaining two copies
of that behavior. RT8 wiring and live qualification remain separate gates.

## Build steps and offline checks

1. Add the adapter with injected driver, local runner, retained bindings and revocation check.
2. Exercise admission, both-window identity, immutable arguments, uncertain delivery and no replay.
3. Exercise the unchanged script with fake AX and event boundaries through the adapter. Check text
   moves, selection and content refusals, exposure, fallback, release failure and the Shift pair.
4. Keep one refusal transport test. The fake-native parity rows exercise the script's predicates.
   Check missing-ID and two-instance mismatches before input, and throws at every Shift step.
5. Run each focused file alone at nice 20 while the lane test marker exists. Run prose lint on this
   document and Vale on the lane report. The architecture lane runs all live gates.

## Background-hover probe plan

No probe ran in RT12. The earlier [hover study](hover.md) found that background mouse-moved events
did not show hover UI on 2026-10-04. RT1 proposes testing `mouseEntered` followed by `mouseMoved`,
using the same window-local subtype as the pointer driver. That combination remains unmeasured.

The architecture lane can run this only in its authorized quiet window, on its own fixture windows,
with app approval, the shared live lock, a retained input lease and capture permission already in
place. Use an owned AppKit fixture with a tooltip and counters for entered and moved events, then
Calculator's known tooltip as a second target. Never use a security prompt as a hover target.

1. Record the exact driver build, macOS build, fixture PID and process start, window number, bounds,
   screen scale, real pointer position and front app identity. Put a second owned app in front, away
   from the target point. Preserve the starting Space. Read Help and secondary actions first.
2. Construct both AppKit events without posting. Validate type, bound PID, window fields, private
   source, local coordinate round trip and absolute point. Record the entered-event constructor and
   whether it produces a CGEvent. Do not assume the pointer builder accepts that type. An invalid
   event ends the probe.
3. Post only to the bound PID. Compare mouse-moved alone with entered then moved, at dwell times
   400, 1000 and 1500 ms. Run three trials per arm per target and dwell, 36 total. Before each post,
   recheck identity, lease, real HID input, focus and coverage. Person input stops the run.
4. Capture only the owned target window. Record tooltip presence, fixture event counters, timing,
   pointer and focus deltas, and Space identity. A delivered event without visible hover UI fails
   the hover condition. A tooltip outside the captured window is unobserved, not absent.
5. A positive result needs 3/3 tooltip observations at a named dwell on each target with zero pointer,
   focus or Space changes. If either target fails, keep the Help, secondary-action, right-click and key routes.
   The existing real-pointer hover tool keeps its separate approval, idle rule, capture preflight
   and restoration. Do not enable a new background path from a construct-only result.
6. Retain failed trials and exact-fixture cleanup evidence. If the probe needs activation, a real
   pointer move, a display capture or a new TCC grant, stop and record the owner decision instead.

Proposed known-problems line: "The runtime's background-hover candidate, window-local mouse-entered
then mouse-moved events, has no live trials. Help text, secondary actions, right-click and keys remain
the first routes. The existing hover tool still takes the real pointer after its idle check."

## Drag live gates

The architecture lane must run textedit-drag 3/3 and Chess drag 3/3 against the product report's
cases, retaining every failure. TextEdit needs expected final text, spacing and saved bytes, a trace
of the Shift press and release after an AX write, exact window identity, and pointer/focus/Space
observations. Chess needs an uncovered move with a board readback, covered-point refusal or proven
same-element relocation, and a stacked same-app window case. A posted sequence alone is unverified.
Foreground fallback trials need the architecture lane's authorized away window. This lane ran none.
