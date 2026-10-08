# App hangs and fresh Chess launches

The checks used engine 26.1002.52244 and held `/tmp/sleight-live.lock` while driving apps.
They used Calculator, Chess and an owned native fixture. The checks left the shared helper and
ChatGPT processes unmodified and didn't signal them. macOS displayed no permission prompt.
The operator authorized closing the leftover Chess game. Chess was already absent when the first authorized run acquired
the lock. Every game created by the completed series was closed before Chess exited.

## Hung app diagnosis

The fixture stopped its main event loop through a private file, then resumed cooperatively.
Every fixture exited 0.

| Arm | Completed runs | Actual read timeouts | Wrong ChatGPT restart advice |
|---|---:|---:|---:|
| Original relay | 1 | 2 | 1 |
| Revised diagnosis | 6 | 12 | 0 |

Native AX returned `cannotComplete` (-25204) while the fixture was blocked and responded after it
resumed. Calculator's engine read succeeded during the hang. The original second failed read
named the helper first. Revised replies named the unresponsive fixture. Reads took about 16.7 to 21.2 s.

The first three revised runs exposed a separate defect during review: their visible Calculator
refresh returned a compacted “no change.” The last three runs verified the full visible Calculator tree
and the recovered fixture tree after the automatic retry. Unit regressions cover hidden baselines,
expired approvals, late replies, resets and successful UI text mentioning `timeoutReached`.

No shared helper wedge was induced, so helper-only recovery remains unproved.

## Twenty fresh Chess launches

The completed series ran from 18:24:26 to 18:37:49 UTC. Every trial started a separate Chess process
with `open -g -a Chess --args -ApplePersistenceIgnoreState YES`, then created a new game. Engine
and local calls alternated, ten through each path. All twenty PIDs and game window IDs were distinct.

| Path | Drag calls | Tool errors | Engine read showed e4 | Independent AX verified e2 to e4 | Remaining unconfirmed moves |
|---|---:|---:|---:|---:|---:|
| Engine `app.drag` | 10 | 0 | 10 | 6 | 4 |
| Local `drag` | 10 | 2 | Not sampled | 3 | 5 |

The local tool acknowledged eight drags. All eight used foreground fallback because Grok Bot
covered the drag points. The other two calls returned errors:

- Trial 10 ended in an `osascript` command failure after 30.3 s. The local command's deadline is
  30 s, but its reply did not retain a termination code or stderr. The independent AX query then
  failed with “Can't get object” (-1728). Timeout is plausible. Its native cause remains unknown.
- Trial 16 refused because another window covered the source point. It reported that nothing was
  pressed, and independent AX confirmed the unchanged board. Being on screen does not imply that
  a window is uncovered.

Native AX left nine further move checks unconfirmed by showing an empty e2 while omitting e4. In four
engine trials the engine's own read still showed `white pawn, e4`. Local acknowledgments
had no board read in their reply. The movement outcome remains unknown for these nine checks.
The separate recovery control's immediate and later AX samples agreed. It did not reproduce
the missing label or establish its cause.

The historical `noWindowsAvailable`, off-screen and AX matching refusals occurred 0 times in these
twenty calls. Before each drag, the selected CG window was on screen at layer 0 with bounds
`x=46, y=80, width=1223, height=949`. Its AX window had matching bounds and was not minimized.
AX window numbers were unavailable. The initial and new games had identical bounds; the harness
identified the new CG ID by comparing the lists before and after creation. Space was unavailable.
This evidence does not establish the state or cause of the historical refused window.

All twenty launches succeeded on their first `open` call. Each launch followed confirmed process
absence. No native -600 retry was exercised. The launch helper waits for exit and retries only -600,
at most three times. Its unit boundaries pass. The historical LaunchServices cause remains unknown.

## Exact window recovery

A separate fresh game was minimized. Local `drag` refused it as off screen, with no input, and AX
confirmed that e2 and e4 were unchanged. The harness restored and raised that same game, acquired
Chess again, checked its current CG ID and AX bounds, and captured a fresh single-window image.
Both native AX samples and the engine read confirmed that the new drag moved the pawn to e4 and left e2 empty.
This is 1/1 verified minimized-window recoveries. Recovery from another Space remains untested.

Mutations bind to the recorded Chess PID. Cleanup closes the exact new game and checks that only
initial games remain. It requests a normal quit and waits for process absence. All twenty series
cleanups and the recovery cleanup confirmed Chess absence. Their 21 owned engine servers exited 0,
and both live commands exited 0 after releasing their locks.

## Failed attempts and evidence limits

Earlier setup receipts retain the disabled-guard failure, compacted New Game dialog, ambiguous
same-bounds CG selection and canceled attempts. One early engine drag showed e4 but could not finish
independent verification or cleanup because the game title changed from White to Black to Move.
Its owned engine exited 0. Recovery later verified its PID and lock identity before closing both owned
games. It then waited for exit and released the retained lock. Another early engine trial verified the move
before interruption during the next setup. The fixed twenty-trial series excludes those earlier runs.

An interrupted relaunch stopped during a retry sleep without retaining the native launch error. It is
not proof of -600. Its receipt records the terminal failure and later Chess-absence check before
releasing that run's retained lock. A canceled lock waiter posted no app input.

Some single-window captures returned black pixels despite matching on-screen CG/AX records. A clear
capture at the same bounds supplied the board coordinates. Chess's AX square Y positions were
inverted relative to that image. A supplementary content-surface capture failed before any drag;
that diagnostic was removed. The recovered game's fresh image was clear, while the cause of black
captures and their relationship to the historical availability refusal remain unknown.

An untitled New Game dialog exposed an evidence scrubber defect: replacing an empty title inserted
redaction text between every character. The affected receipt was repaired without restoring owner
titles. The receipt records the repair. Empty titles now leave receipt structure intact, with unit
coverage. Review also added a regression that prevents a turn change from falsely confirming closure.

One earlier fixture baseline hit the harness's initial 16 s response deadline before recording a
read result. Its failed receipt remains published. The corrected harness waits 90 s. Sandbox
preflights failed on worktree writes and a local test server. Host runs passed afterward.
Cold compilation exceeded a native test's 60 s deadline in two required checks. One check also exposed
a cache cleanup race. The test now allows 180 s and retries cache removal, with unchanged assertions.
The final `npm run check` exited 0: 630 unit tests, plugin validation and nine mod tests.

Raw receipts are `2026-10-08-reliability-*.json` in this directory. The fixed series is
`2026-10-08-reliability-chess-after-20261008182426735.json`. Recovery is
`2026-10-08-reliability-chess-recovery-20261008183913299.json`. They retain failed attempts and
replace Chess owner titles with `[Chess window]` and home paths with `~`. Screenshots are private
and use `screencapture -l`. No screen capture is published.
