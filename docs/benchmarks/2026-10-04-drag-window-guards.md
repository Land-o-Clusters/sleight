# TextEdit window selection and lost text

Branch `codex/drag-polish`, worktree `~/Projects/sleight-wt/text-drag-menu-names`, 2026-10-04.
This follows architect review of `a01e3d8`. The spacing and menu names remain on the branch.

## Findings and changes

The old helper chose the largest on-screen app window and added its origin to both relative
points. It did not bind the selection to that window or check the destination's content geometry.
With two TextEdit windows, that can move text in the other window. It also allowed releasing text
over a title bar. These source defects explain how the owner could see a release away from the
requested text line. The historical attempt 4 did not record window IDs, so that receipt cannot
show which windows were open.

The helper now accepts `windowId`, refuses ambiguous window-relative points with a window list,
raises that exact window, and refreshes its geometry before translating both points. It matches
the CG window to one AX window and checks both points against visible content, excluding toolbars.
Another window covering either endpoint refuses before mouse-down. TextEdit requires both points
inside the same clipped AX text area and a non-whitespace selection.

After the drop, the helper compares the full text snapshot. An absent selection after ignoring whitespace,
or fewer of any selected non-whitespace character, returns an error stating that text disappeared
and asking Claude to press Cmd+Z in the window it identifies. Character counts also catch a deletion
that joins surrounding fragments into a new copy of the selected word. The check runs again after
the spacing repair. An unconfirmed spacing write also returns an error rather than success.
Whitespace-only selections refuse because smart spacing changes cannot prove their conservation.
Concurrent edits remain a limitation of snapshot comparison.

## Attempts

| Attempt | Result | Exit |
| --- | --- | --- |
| Fetch `origin` | Updated `origin/main` to `56be713` | 0 |
| Rebase onto `origin/main` | README conflict between menu names and new refusal wording | 1 |
| Rebase continuation | Preserved both changes; replayed commit as `05cb3c7` | 0 |
| Rebased unit baseline | 166/166 | 0 |
| Initial window regressions against the old helper | 0/7; unsafe drags reported success | 1 |
| First window guards | 7/7 | 0 |
| Same-area and unavailable-geometry regressions | 9/9 | 0 |
| Loss conservation and repair-loss regressions before fixes | 10/12; both new cases reported success | 1 |
| Loss checks before and after repair, plus lock cleanup | 13/13 | 0 |
| Two-window fixture preparation | Compiled fixture and saved immutable `a01e3d8` helper; no app actions | 0 |
| First full `npm run check` | 178 unit tests, plugin validation and 8 mod tests | 0 |
| First followup prose lint | 4 wording errors | 1 |
| Overlapping partial-word regression before correction | 14/15; valid move incorrectly reported as lost text | 1 |
| Corrected loss check with Unicode and whitespace-only regressions | 15/15 | 0 |
| Smart-spacing selection regression before correction | 15/16; conserved text incorrectly reported as lost | 1 |
| Corrected check ignoring smart whitespace changes | 16/16 | 0 |
| Second followup prose lint | 1 wording error | 1 |
| Check before `origin/main` advanced | 182 unit tests, plugin validation and 8 mod tests | 0 |
| Prose lint after wording corrections | 0 errors, warnings or suggestions | 0 |
| Rebase onto newer `origin/main` at `3f280cd` | Fixture and prose script conflicts | 1 |
| Rebase continuation for spacing/menu commit | Replayed first commit; followup prose script conflict | 1 |
| Rebase continuation for window guards | Preserved both benchmark reports and AX research helper | 0 |
| Fixture preparation after preserving the research selection mode | Compiled; no app actions | 0 |
| Final `npm run check` after rebase | 192 unit tests, plugin validation and 8 mod tests | 0 |
| Prose lint after rebase | 0 errors, warnings or suggestions in 17 files | 0 |

Read-only review found no further concrete defect after the loss-check corrections. Native AX
matching and live behavior still require the owner's away window.

The focused live script uses the production relay, local handler, input lease and benchmark
allowlist. It opens two owned temporary TextEdit documents for each case and closes them by exact
path. The old-helper check runs only when its largest window is strictly the owned second document.
The shell holds `/tmp/sleight-live.lock` through cleanup of its child. Success, failure and interruption
all release it. The harness does not start a shared engine child or run `bench/run.mjs`.

Live checks are pending the owner's away window. The request for that window remains unanswered.
No pointer-moving run has started for this followup.

The fixture keeps the background research's original `select` coordinates and range bounds.
Focused foreground checks use `select-drag` for the corrected glyph coordinates.
