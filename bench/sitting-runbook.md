# Owner-away sitting commands

Run from the source worktree after sleight-arch confirms the owner is away and coordinates the quiet window.
These sittings collect diagnostic evidence. They cannot qualify the runtime.
Use a clean checkout of one commit for the build, observation and sitting. Run `/usr/bin/git status --porcelain`
first and require empty output, including untracked files. The harness prints source.sleightCommit and source.sleightDirty
before starting either live command and refuses a dirty checkout with CLEAN_SOURCE_REQUIRED.
Keep outputs outside the checkout. Rebuild the tools and rerun observation after any source or native change.

Build into an absent tools directory. Keep the compiled tools with their source commit.

```sh
export SITTING_BANK=$(mktemp -d /private/tmp/sleight-sitting-XXXXXX)
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/runtime-owner-away.mjs --build-only --tools "$SITTING_BANK/tools"
```

All result parents must exist without symlink parents. Result files must be absent.
TextEdit, Calculator and the witness must be closed before the runtime arm starts.
Existing Accessibility and Screen Recording grants are required. The guard never requests them.
Keep another app and its focused window in front, and park the pointer inside the future owned cover area.
The cover must contain the witness and the unchanged pointer for the drag and scroll probes.

## Glide preview with the owner present and hands off

Until a hardware-input observer is qualified, run the Glide preview's live input gates with the owner
present and hands off, during the same sitting as the owner-present Windows rows in
[the Windows runbook](windows/driver-sitting-runbook.md#uc3f-mac-entry-points).
The unattended observation command below remains refused with `HID_SOURCE_UNCONFIRMED`.
A stable positive reset count never qualifies unattended input.

Build the tools from the reviewed clean commit as above. From a real local Apple Terminal window,
the owner types this command, with a new output path. An agent shell, SSH session, multiplexer,
redirected stdin, different controlling terminal or background process group refuses before arming.

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/runtime-probe-live.mjs --owner-present-hands-off --sitting --tools "$SITTING_BANK/tools" --out "$SITTING_BANK/present.json"
```

Before asking for exact `go`, the command prints the selected rows' planned duration and tells the owner
to keep hands off the keyboard, mouse and trackpad. The 9 rows total 1,800 seconds (30 minutes), with
an existing 35 minute guard limit, plus cleanup. With `--measurements-only`, the 3 rows total 240 seconds
(4 minutes), with a 10 minute runner limit. These allocations are estimates, not measured durations.
The owner stays at the Mac, watches the block and presses Control-C in that same Terminal to stop at any time.
An empty answer, EOF or any answer other than exact `go` refuses. After `go`, confirm with Touch ID or
the account password in macOS's own sheet. A locked Mac or 120 seconds of idle refuses before the sheet.
A failed, unreadable or timed-out presence check also refuses before the sheet, with a 5 second limit.
The build has a 330 second cap. The sheet withdraws after 60 seconds. Cancel, Control-C, a missing host,
a mismatched binary or any nonzero helper exit refuses with `OWNER_PERSON_CONFIRMATION_REQUIRED` before
a guard, lock or ChatGPT engine starts. Control-C records `OWNER_STOPPED`.

Terminal ancestry and `go` cannot tell a person from a script. Terminal's AppleScript `do script` can
start the command and type `go` without a person there. The Touch ID or password step proves presence
only at the start. The owner stays at the Mac as the observer for the whole block by rule. Do not supply `--observation`,
`--observe-only` or `--owner-away` with this mode. This mode starts without an unattended calibration file.

HID resets are recorded without stopping this mode. The JSON marks every admitted probe attempt and nested latency trial
as `ownerObserved: true` only after an admitted confirmation. The report has this marker only when at least
one row was attempted. A probe that throws immediately still counts as an attempt. The guard marker means
this mode was armed. The report's `inputObservation` gives the reset count, estimated input uptime, offsets from each
posted action's start and reply, and whether each reset was inside any posted-action window, including the
150 ms reply tail. An unfinished call retains a null end. Timing associates samples with calls but cannot
identify hardware or count individual events without a hardware observer.

Identity, cover, pointer, front app, foreign windows, permission prompts, hold, lock and guard faults still stop
the block. Foreign window records include owner and layer, with a name only for the fixed StatusIndicator and
Software Cursor labels. Personal titles are excluded from dedupe identities. The counter retains at most
256 identities and counts further observations in one overflow row. New foreign windows still stop the block.
The final counts appear only on clean stdin EOF. A crash or forced exit can omit that summary. Records retain their first
observation uptime and a count per stable window identity, so bounds and alpha changes don't create
extra records. Existing exempt overlays, including the ChatGPT software cursor, skip this foreign-window log. An unknown StatusIndicator layer remains foreign and stops if newly seen.
This evidence records the layer for review. The command never exempts it from a guessed value.
`OWNER_STOPPED` records Control-C, stops further ChatGPT engine work and runs owned fixture and child cleanup.
A second Control-C requests input release from the owned clients before killing their process groups.
It releases the live lock and exits 130. A forced exit does not certify fixture cleanup or input release.
Check `cleanupConfirmed` and `lockReleased` before considering ordinary cleanup complete.
The offline tests leave live acceptance and physical stop latency unverified.

## Observe the current engine first

This legacy recipe remains documented for its evidence format. The current unattended observation refuses
with `HID_SOURCE_UNCONFIRMED` before input or launch. Use the owner-present block above for the live gates.

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/runtime-probe-live.mjs --owner-away --sitting --observe-only --tools "$SITTING_BANK/tools" --out "$SITTING_BANK/observe.json"
```

Observation lasts at least 60 seconds, plus cleanup, with a 5 minute guard deadline.
It runs 3 rounds of getApp, click, double-click, key, type, scroll, drag, screenshot, read, combined read and open -g.
Each round makes 10 engine calls on the witness and opens 1 TextEdit fixture, then closes that fixture.
The fixture opens first. Each round places it over the witness, re-acquires the witness and verifies the pointer
against the guard's original position before scroll or drag. Probes 1 and 3 use the same sequence.
The guard logs observed HID resets with their call label, idle value and ordinal within the window.
HID resets alone do not stop observation. Pointer, frontmost, foreign-window, permission, hold and stale-guard checks still stop it.
Exit 0 requires equal reset counts across all 3 calls of each kind, no resets outside call windows, and confirmed cleanup.
Counts may differ between kinds, including zero resets. The JSON records all 3 counts and the accepted count per kind.
A different count exits 1 with HID_PULSE_MODEL_UNCONFIRMED. The command also prints perKind, resetCounts and sittingReady
as JSON. The sitting reads resetCounts from that observation file and recomputes them from the reset records.
A kind that measures a stable 0 is accepted, and the guard then doesn't accept any reset during that kind's calls.
All 11 measured kinds are used by the sitting. Read their counts before proceeding.
No sitting command replays an action.

## Runtime sitting

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/runtime-probe-live.mjs --owner-away --sitting --observation "$SITTING_BANK/observe.json" --tools "$SITTING_BANK/tools" --out "$SITTING_BANK/runtime.json"
```

The planned allocation is 30 minutes for 9 probes, with a 35 minute guard deadline. Live durations remain unmeasured.
The probe order is 1, 6, 2, 3, 4, 5, 8, 9, 10. Probe 7 stays skipped because unlocking requires the owner.
Probe 6 writes the latency JSON and Markdown beside the main output.

Add `--measurements-only` to run probes 8, 9 and 10 with a 4 minute allocation and a 10 minute limit.
It requires the same matching observation and cleanup as the full sitting.
Probe 8 samples 25 coordinates each in owned TextEdit, Calculator and witness windows, 75 points total.
Chrome is skipped by default with `PROMPT_FREE_LAUNCH_UNVERIFIED`. Its flags request a basic password store
and suppress sync, background networking and first-run paths. Prompt-free startup has no live verification.
After prompt-free startup is qualified, `--include-chrome` permits an installed, closed Chrome with a fresh
temporary profile, adding 25 points. A running Chrome is never acquired or quit.
`--include-chrome` cannot be used with `--observe-only`.
The guard adopts only the PID reported by `chrome-fixture-ready` and removes its launch permit.
Another Chrome process, even without a window, stops the sitting. Cleanup refuses to quit an unbound Chrome.
Unconfirmed cleanup retains that profile under the reported fixture bank. Leave retained profiles for the owner to review.
Probe 9 never moves windows between Spaces or arranges Split View. On the active Space it records both states
as attended skips with 0 attempts, `deliveryMeasured: false` and `unmeasured: ["off-space", "split-view"]`.
The main result repeats `deliveryMeasured` and `unmeasured`, including partial evidence after a stop.
`completed: true` means the planned probes ended, including skips. It does not prove delivery was measured.
Probe 10 requests 3 read-only context-menu parent samples from the owned witness.

Each engine call and each harness open -g starts a guard window before dispatch.
The window ends 150 ms after the reply, including an error reply.
Run both commands on the same Mac. The runtime command requires successful observation JSON at most 6 hours old,
with matching source commit, engine, OS kernel and architecture. The sitting refuses a dirty source worktree.
Each window accepts up to the reset count measured for that kind and rebases the expected idle line on each reset.
Any extra reset, a reset outside a window, or a later idle drop below the rebased line stops with PERSON_ACTIVE.
An unmeasured kind refuses before dispatch. Double-click and combined read have their own counts.
The HID timestamp is taken immediately after reading idle, so frontmost AX latency does not shift that baseline.
The idle comparison allows 5 ms of sampling jitter. Other detectors keep running during every window.
A physical event inside a call window can be indistinguishable from the engine pulse.
Events between 20 ms samples can coalesce, which can hide physical activity.

The original frontmost PID, focused AX window and pointer remain pinned.
A positive different focus stops immediately. The guard stops after 3 consecutive unavailable focus reads. A successful read clears the miss count.
Foreign-window records include PID, bundle, window number, owner, name and layer.
Probe 2 has a planned allocation of 3 minutes. A stop sends secure-off before relay shutdown.
The witness also releases secure input on quit, EOF or loss of its parent process. A live but hung harness can retain it until the witness exits at 30 minutes.

After a stop, engine work ends and owned fixture cleanup continues, including during a hold and after person-presence stops.
Guest close also skips the hold check. Cleanup can close owned windows during another project's timed window.
The harness announces each fixture launch. The guard refuses unannounced apps and pre-existing TextEdit processes.
The guard uses NSRunningApplication normal quit on its bound Calculator and witness processes and unwritten clean TextEdit fixtures.
TextEdit documents must match a registered fixture path or the AX window bound immediately after that file's launch.
When AXDocument is hidden, binding requires a new window number, unique AX/window-server geometry and the expected file name.
A matching title alone cannot authorize quit. Cleanup uses retained AX identity and the registered document path,
without rechecking the title, so an Edited suffix does not reject the document. A conflicting path still refuses.
Before any TextEdit input dispatch, the harness records potential edits, even when the engine reply fails.
Normal quit requires an explicit false AXDocumentEdited or AXEdited value for every bound document and is refused when write intent is recorded.
Any recorded write intent forces fixture discard, including a stale false edited flag after an error or lost reply.
Any true edited flag overrides a false flag. Cleanup rechecks the current document set before discarding or quitting.
When edited state is dirty or unavailable, the guard uses NSRunningApplication.forceTerminate() only after confirming
that every current TextEdit document is a retained fixture. This discards pending fixture changes without requesting a save sheet.
The cleanup.guardRecords entry cleanup-edited-state gives unavailableDocuments and a note when neither edited-state
attribute returns a Boolean. On a Mac where both attributes are absent, cleanup keeps the discard path even for an unwritten fixture.
The process must still match its PID, bundle and launch date. A new or unbound document refuses all termination and retains the lock.
The same rule applies after a person-presence stop. Normal quit is used only for unwritten, confirmed clean documents.
Only an already present Don't Save sheet attached to a retained fixture window can be answered, with exactly one discard button and only known save buttons.
Other sheets stay refused. Cleanup does not activate an app or move the pointer. The final comparison is recorded in cleanup.desktop.
A real owner takeover can change that comparison. The harness never warps the owner's pointer or activates an app to undo their input.
The lock is released after child collection and owned-app exit are confirmed. Uncertain cleanup retains it and the fixture bank.

## VM fixture preflight and sitting

Set SLEIGHT_VM_ID to the verified VM identifier and SITTING_SSH_CONFIG to the existing operator-owned SSH config.
The host alias defaults to vm, the guest user to Sleight, and the kit to C:\sleight.
No command creates credentials or changes VM preferences.
Leave exactly one UTM window uncovered and in the background, with capture and auto-capture already off.
The guest needs one US-layout display, a logged-in interactive Limited task session and no running Notepad.

Run the fixture preflight first to check whether task-launched Notepad becomes foreground in the guest:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/windows/rt31-sitting.mjs --owner-away --fixture-check-only --tools "$SITTING_BANK/tools" --ssh-config "$SITTING_SSH_CONFIG" --vm-id "$SLEIGHT_VM_ID" --out "$SITTING_BANK/vm-fixture.json"
```

Its planned allocation is 1 minute. It performs one host inspection and zero input posts.
GUEST_NOTEPAD_NOT_FRONTMOST refuses before any input. Cleanup still attempts to close the bound fixture through a Limited scheduled task.
No foreground workaround is attempted.

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node bench/windows/rt31-sitting.mjs --owner-away --tools "$SITTING_BANK/tools" --ssh-config "$SITTING_SSH_CONFIG" --vm-id "$SLEIGHT_VM_ID" --out "$SITTING_BANK/vm.json"
```

The planned allocation is 9 minutes, with a 10 minute guard deadline.
The plan contains 2 moves, 2 clicks, 6 mapped key pairs and 1 belief interval. Unicode and foreground rows remain omitted.
Move delivery remains unknown without a guest hover effect.
UTM's Capture Input item is bound from its menu bar once. The 2 Hz reads target that item and skip the application tree.
A missing or changed item refuses. The capture cache can be up to 500 ms old.
Live freshness of the retained menu mark remains unverified: UTM may refresh it only when the menu opens.
A stale off mark could miss capture being on. The helper also refuses capture or foreground input, and the harness reads guest effects after each row.
The VM has no HID observation or allowance. Whether private-source postToPid resets host HID idle remains unverified.
If it does, the first posting row stops with PERSON_ACTIVE. The zero-input preflight cannot test this.

At normal completion, restore verifies the guest text and caret, then a close task uses UIA WindowPattern.Close.
It can discard only the bound fixture's own save dialog. Guest process exit is required before lock release.
After a host stop, close still runs when prior tasks are collected and key releases are confirmed.
An uncertain key release or task collection prevents further guest writes and retains the lock.
A failed guest close also retains it. Notepad session restore, extra tabs and save prompts inside the same window remain unverified.
Those cases can refuse close or fail the next fixture preflight. Do not remove a retained lock to retry.

Add `--dry-run` to an observe, runtime or VM command to print its plan without loading the live backend.
