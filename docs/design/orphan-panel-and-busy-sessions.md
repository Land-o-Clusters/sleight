# Orphan Save panel and busy desktop sessions

Research only, 2026-10-11. Two ROADMAP track-2 items. No live run, no engine start, no `/tmp/sleight-live.lock`.

## TextEdit's orphan Save panel

### Known

On 2026-10-06, after AppleScript `close every document saving no`, every engine read of TextEdit timed out. TextEdit still answered AppleScript. Its only remaining window was a CoreGraphics `Save Panel Accessory View` that Accessibility did not list. `--doctor` passed. Quitting TextEdit recovered it ([known problems](../known-problems.md)).

The health probe sets `savePanelOnly` only for `com.apple.TextEdit` when `AXWindows` is 0 and every remaining document-sized CG window is named exactly `Save Panel Accessory View` (`plugins/sleight/lib/app-health.js`). Document-sized means layer 0, width and height at least 100. A timed-out AX read, a normal document window, another matching app, or missing CG names (no Screen Recording) prevent the flag (`tests/app-health.test.mjs`). Diagnose treats it as `app-save-panel` before Space or helper advice (`plugins/sleight/lib/read-failure.mjs`). The relay prints the note once per process and window id (`plugins/sleight/lib/relay.mjs`).

The live reproduction is `bench/textedit-fixes.mjs --orphan`: empty background TextEdit, Cmd-Option-Shift-S (Save As), then `close({ saving: "no" })` of the owned document. Success is 0 AX windows and a CG panel. Every published `--orphan` attempt was skipped (live lock, off-Space, or another hold). The textedit-fixes JSON files with `"orphan": false` were other arms of that harness, not failed reproductions.

Tonight ([evidence](../benchmarks/2026-10-11-evidence.md)): textedit-save passed 3/3. The 2026-10-10 Save-sheet stall did not recur. The select-all check refused with "TextEdit has a dialog" while a later engine read showed one document window and no sheet. That refusal is `bench/small-fixes-textedit.js` (AXDialog, AXSystemDialog, modal, or sheet on a live window). It is a different detector from `savePanelOnly`.

Benchmark cleanup closes named bench documents with `saving: "no"`, then `quit saving no`. A leftover Save sheet blocked both on 2026-10-08 (`bench/tasks.mjs`). Cleanup then kills TextEdit when every document was the benchmark's. The 2026-10-06 command, `close every document`, is not in the current cleanup.

The guard and verified-results line recognize `ID: save-panel` on a live tree ([verified results](verified-results.md)). They do not open or close sheets.

### Inferred cause

Closing a TextEdit document with AppleScript `saving no` while a Save As sheet is attached leaves the accessory view as a CG window with no AX parent. Engine reads then time out because there is no document window. The `--orphan` sequence (Save As, then close the document) matches that. Unconfirmed: whether the 2026-10-06 close opened the sheet, or a sheet was already open.

### Ruled out

The relay, guard and verified-results line do not create the panel. Bench cleanup can leave or then kill a Save sheet from a failed run. That cleanup is not the 2026-10-06 command and has no published orphan. Tonight's "has a dialog" refusal is not an orphan: AX still listed a document window.

### Code already justified

The diagnosis and once-per-window note are already in, with unit tests. No further diagnosis code until a live `--orphan` run. Sleight must not Cancel, Escape, or quit TextEdit on its own. Localized panel titles remain unchecked.

### Smallest live check

TextEdit empty, background, current Space, `/tmp/sleight-live.lock` free: `node bench/textedit-fixes.mjs --orphan`. Required: `orphanReproduced` true (0 AX windows, CG panel present), then a sleight read of TextEdit includes the Save Panel Accessory View note once. Leave any visible panel for the owner. Do not quit ChatGPT or answer a prompt.

## Desktop sessions that stay busy

### Known

Before 0.3.1, the engine turn remained open until the session closed. Desktop sessions twice showed as busy after Claude finished. Sending `turn_ended` cleared it once ([known problems](../known-problems.md), CHANGELOG 0.3.1). The launcher sets `SLEIGHT_IDLE_TURN_END_MS` to 30,000 (0 disables). The relay starts that timer when no engine or local call is running (`plugins/sleight/lib/relay.mjs`). A used turn or a previously rejected cleanup arms it. Review and in-flight calls delay it. A comment in the relay still calls the desktop a host without the mod.

The mod, on Claude Code 2.1.287+, sends `turn_ended` from `turn.complete` after a main-agent turn that used `js`, after an optional pane snapshot (`plugins/sleight/hooks/register.tsx`). Subagents and turns with no tracked `js` skip that hook. Claude's own `turn_ended` is denied. `tool.check` allows this plugin's `turn_ended` and its own snapshot code. The desktop Code tab at 2.1.293 loaded the mod: `/sleight` opened the pane and showed Calculator. `/sleight stop` there is still unchecked.

A rejected `turn_ended` used to rotate the turn id and drop `turnUsed` before the engine answered, so idle had nothing to retry. The relay now keeps the original session, turn and hook event for up to three attempts ([turn lifecycle](../benchmarks/2026-10-10-turn-lifecycle.md)). Fake-engine tests: 0/3 before the change, 3/3 after. That path is not connected to the two historical incidents. The reply to explicit cleanup waits for a keyboard-tap scan after the session used an app. The scan has no relay deadline. Until 2026-10-11 a rejected pane list (`isPaneOpen`) skipped the hook's `turn_ended`, so only the 30 s idle timer ended the turn. It now counts as a closed pane, with a mod test.

Tonight's evidence has no desktop session and no `turn_ended` trace.

### Inferred cause

An open engine turn (the app badge and the desktop busy flag). Before 0.3.1 that was missing cleanup. If it still happens with the mod loaded, the hook did not send, the snapshot or keyboard-tap scan delayed the reply past the moment Claude looked idle, Auto mode refused `turn_ended` when `next.origin.plugin` was unset, or `running` never emptied so idle never fired.

### Ruled out

The retry change recovers from a JSON-RPC error or `isError` result. It does not explain the two historical incidents. Lost replies, a `js` call that does not finish, and a keyboard-tap scan without a deadline remain unmeasured.

### Code already justified

Idle cleanup (0.3.1), rejected-cleanup retries and the pane-list fix are already in. No further relay or hook change until a desktop run records whether `turn.complete` sent `turn_ended`, whether idle sent one 30 s later, and whether the session was still busy after an acknowledged cleanup.

### Smallest live check

In the desktop Code tab, Auto mode, one Calculator click through sleight, then wait until Claude is idle. The relay trace must show `turn_ended` from the hook, and from idle 30 s later if the hook does not send one. The session must leave the busy state after that acknowledged reply. If the busy flag remains after an acknowledged `turn_ended`, it is not sleight's open turn. Do not quit ChatGPT.
