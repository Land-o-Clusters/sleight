# App hangs and fresh Chess launches

The checks used engine 26.1002.52244 and held `/tmp/sleight-live.lock` while driving apps.
The app hang checks used Calculator and an owned native fixture. Chess was observed through AX
metadata and single-window captures without changing its game. No shared helper or ChatGPT process was
restarted, signaled or modified. The fixture stopped its main event loop through a private file,
then resumed cooperatively. Every fixture exited 0. No macOS permission prompt appeared.

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

The final native run passed on `b583c80`, after rebasing onto `b3de45f`. Both required commands
also exited 0 there. Check passed 620 unit tests and nine mod tests, including plugin validation.
Prose lint passed.

One earlier baseline attempt hit the harness's initial 16 s response deadline before recording a
read result. Its failed receipt remains published. The corrected harness waits 90 s. Sandbox
preflights also failed on worktree writes and a local test server. The host run passed afterward.

Chess inspection stopped on an existing game. Automatic approval review rejected discarding its
unsaved moves. Fresh-launch drag counts are 0 before and 0 after; the required ten trials through
each path remain pending permission to close that game. No Chess recovery is claimed verified.

The benchmark's quit fallback can send termination and return before process exit. The new launch
helper waits for process absence and retries only LaunchServices error -600, at most three times.
Unit tests cover these boundaries. Native -600 and the historical CG/AX mismatch remain unmeasured.
The existing game's CG record was on screen, layer 0, with matching AX bounds. Space was unavailable.
Chess's AX square Y positions were inverted relative to the screenshot. Screenshot measurements
are banked for the pending trials. AXEdited and close-button values were unavailable, so the
read-only inspection could not establish whether discarding the existing game would lose work.

Raw receipts are `2026-10-08-reliability-*.json` in this directory. They retain failed attempts and
replace Chess owner titles with `[Chess window]` and home paths with `~`. Screenshots remain private
and use `screencapture -l`. No screen capture is published.
