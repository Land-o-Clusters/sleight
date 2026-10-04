# Background drag prototype

Measured on macOS 27.0 (26A428), Apple Silicon, 2026-10-03. Background event delivery
is possible in DragProbe. Moving selected text in TextEdit remains unproven.
The existing MCP `drag` tool keeps its foreground code.

A [2026-10-04 follow-up](2026-10-04-background-text-drag.md) corrected the TextEdit drop
point, measured longer holds and compared PID and PSN posting. Its raw results include
successful background text moves. The counts below describe the original attempts.

## Mechanism

`bench/background-drag/helper.mjs` compiles the Swift helper on its first call
in a process. It uses a private temporary directory and removes that directory when
the launcher exits. Xcode Command Line Tools and Accessibility access are required.

The default mode constructs an NSEvent with the target window number, converts it
to a CGEvent, supplies screen coordinates and window-local coordinates through
`CGEventSetWindowLocation`, and posts it to the target PID. It sets window fields
91/92, mouse subtype 3 and the Command modifier. It requests a 500 ms hold and 25 steps
20 ms apart, then releases. Sampling adds time to those intervals.
The helper never activates the target, posts HID events
or warps the pointer. It refuses a foreground target and stops when the front app
changes. An interrupted burst posts a prepared, window-targeted release.

The window-local setter was the missing piece in this experiment. The default path
doesn't use SkyLight key-window records. Diagnostic modes retain those records for
comparison. This approach was informed by [Lakr233's background-click research](https://github.com/Lakr233/bgclick-rev-skill/blob/main/bgclick-rev-skill.md)
and [yabai's key-window code](https://github.com/asmvik/yabai/blob/master/src/window_manager.c).
We have not established how the installed ChatGPT helper sends its clicks.

Run the standalone prototype explicitly, after selecting a target app's content:

```sh
node bench/background-drag/helper.mjs '{"app":"DragProbe","from":[60,80],"to":[300,150],"steps":12}'
```

Coordinates start at the top-left of the largest on-screen normal window. An optional
`windowTitle` requires an exact title match. `windowId` selects a specific window
owned by the target process. `ok` means posting completed.
`deliveryVerified` remains false. An application log or its resulting state must
verify receipt. `samples` contains real pointer positions from `CGEventGetLocation`
and front-app PIDs throughout the hold and movement. NSWorkspace's notification
run loop is processed before reading its front-app state.

## Measurements

The probe was built with `bench/drag-probe/build.sh` and launched using `open -g`.
Each full trial requested down, 12 dragged events and up. Its log shows the type,
coordinates, modifier flags, application activity and whether the window is key. Received
events in both successful batches had `active=false`, `key=false`, and Command flags.

| Batch | Complete sequences | Pointer stayed identical in complete trials | Raw results |
|---|---:|---:|---|
| Bare PID, fields 91/92, key-window records, NSEvent, NSEvent with Command, five each | 0/25 | 0 | [Controls](2026-10-03-background-drag-nsevent.json) |
| Window-local setter | 5/5 | 2/5 | [First batch](2026-10-03-background-drag-window-location.json) |
| Final first-use launcher, refreshed front-app observations | 2/5 | 1/5 | [Final batch](2026-10-03-background-drag-final.json) |
| Longer hold, after review fixes | 1/1 | 1/1 | [Long hold](2026-10-03-background-drag-long-hold.json) |

The final batch stopped two trials when the front app changed. One completed posting
without a full received sequence during real pointer activity. Successful final trial
2 kept every pointer sample at `(4965.08203125, 249.8984375)` and the front PID at
2311. Successful trials with stable pointer samples demonstrate delivery without cursor
movement. Trials with pointer movement cannot establish that property.

Earlier attempts are retained: [15 trials with a reporting crash](2026-10-03-background-drag-initial.json),
[11 completed trials before the worktree move interrupted the next one](2026-10-03-background-drag-interrupted.json),
and [five attempts refused by an unavailable global Accessibility front-app query](2026-10-03-background-drag-front-read-refusal.json).
The crash was a CGFloat-to-Double cast in the result formatter, after posting. Initial
launch failures inside the sandbox posted no events. Host runs used the same repository
scripts. Compilation first rejected a direct deprecated Carbon call, which is now
resolved at runtime in the diagnostic key-window modes.

An [interrupted-burst check](2026-10-03-background-drag-abort.json) received down,
one dragged event and up after a deliberate error (1/1). An earlier interrupted trial
had exposed a missing release: its fallback used a bare CGEvent, which the inactive
app dropped. The helper now prepares a fully window-targeted release before pressing.
The same guard covers optional mouse selection. Another [front-change interruption](2026-10-03-background-drag-cancel-front-change.json)
received down and up. SIGINT/SIGTERM handlers request a release through the same
error path. Terminal signal handling remains unverified: the planned cancellation
attempts ended on a front-app change or completed before an interrupt was captured.

TextEdit moved the selected word in 0/10 attempts: [five with window-local events](2026-10-03-background-textedit.json)
and [five adding key-window records and mouse selection](2026-10-03-background-textedit-key.json).
Accessibility confirmed `alpha` selected before every trial. The readback held
`alpha beta gamma` in nine trials. One readback failed. Pointer samples were stable
in three failed moves. One later read showed TextEdit active during concurrent Mac use.
The cause of the failed moves is unknown. Trials stopped at the owner's request.
One cleanup call failed. Its exact temporary document path remains in the raw result.
We made no further TextEdit calls after that request.
The original fixture matched a document by its basename. A retained document with
the same name could have confused selection or readback, which limits these observations.
Review fixes now bind the fixture to its exact document URL and window ID, and report
close errors. Those fixture changes compiled but have not had another live TextEdit run.

## Limits

`CGEventSetWindowLocation` is an undocumented ABI resolved at runtime. Subtype 3 and
the Command flag also rely on behavior outside the documented mouse-event contract.
macOS updates or application input handling can break this path without a posting
error. Command flags may change an app's interpretation of a gesture. SkyLight's
event-record bytes are more fragile and remain diagnostic only.

These results cover one macOS build and a custom AppKit view that accepts first mouse.
They do not establish general drag-and-drop support or dependable delivery while a
person uses the Mac. Multiple simultaneous drags to the same app are untested.
The TextEdit trials do not prove successful native drag-and-drop, so this prototype
is not enabled in the MCP tool.

To repeat only the probe batch:

```sh
bench/drag-probe/build.sh
node bench/background-drag.mjs .dev/background-drag-results.json window-location 5
```

The runner preserves attempted results and closes only a probe it launched.
The TextEdit runner is retained for later work. It should remain paused while the owner
uses the Mac.

Checks after rebasing onto `origin/main`: `npm run check` exited 0 (43 Node tests, manifest validation,
8 mod tests). `npm run lint:prose` exited 0 with zero flags, including this report.
