# Verified results

Recognized native actions add a short line when it adds evidence or explains uncertainty:

```text
sleight: UI changed (value).
```

An error says `sleight: call failed (partial input possible).` Routine engine acceptance is omitted.
An accepted call doesn't establish that every expression ran or the task succeeded.
Caught failures, engine restarts and overlapping calls prevent confirmation.
Literal method calls identify actions. Computed calls and aliases aren't classified.
Arbitrary JavaScript can forge the headers and action reports.

## Evidence already available

The relay has the original action code, the engine's reply, the last window header and the
compactor's cached trees. The guard usually returns a full read after input. The compactor already
aligns that tree with its previous tree, ignoring element numbering. Reuse that alignment to
compare values, selection flags and changed element lines, and recognize newly visible sheets or dialogs. A same-app window
transition after a click or shortcut is reported as a window change. Numbers moving alone,
descriptions disappearing are insufficient. Renamed element labels, such as Chess piece squares,
are reported as element changes. A deletion key can explain a text-entry Value disappearing when
the same numbered entry retains its other attributes. Other missing values remain degraded evidence.
Failed actions, absent observations and ambiguous headers invalidate the observation chain until
a complete read restores it. Headers without a numeric root and unterminated guard output are incomplete.

`UI unverified` includes a reason. Possible reasons are `no read after input`,
`no earlier read`, `incomplete read`, `degraded read`,
`comparison unavailable`, `another app` and `overlapping calls`.
Unchanged and numbering-only trees don't add redundant action lines.
Plain engine diffs and screenshots do not establish a complete baseline.
An unchanged tree cannot rule out a change outside Accessibility, such as a canvas or disk write.
Concurrent user activity can produce the same changes; the line reports observations after the
call and cannot prove causality. A batch gets one summary, not receipts for its individual actions.

Save detection covers Cmd+S and explicit Save buttons, including a numbered button whose cached
line says Save. Return in a Save panel also counts as its default Save action. Confirmation
requires the same file URL before and after, or the exact URL named by this call's Save-panel workflow.
The supported naming sequence is Go to Folder, a literal absolute folder, and a literal name set
through `saveAsNameTextField`, followed by Save or Return on the same handle. Computed paths and
filesystem aliases aren't resolved. A new URL or title alone cannot establish document identity.
Opening a Save sheet alone is not confirmation. A save with an unchanged
URL and no exposed modified state says `saved: not confirmed (no document save state change seen)`.
Only save calls get a saved field. It specifies the observed file URL:
`saved: observed "file:///tmp/a.txt" (modified state cleared; cause unknown)`.
Since autosave can clear an Edited title or modified flag, the line doesn't credit Claude for that change.
Filesystem checks remain outside this feature, so the observation doesn't prove durable storage or file contents.
Errors, partial trees and overlapping calls cannot confirm saving.
Batches that also switch windows, act after Save or read another handle report `mixed save targets`.
They cannot establish that the final window is the document whose save state changed.

## Build and checks

1. Add trace-derived fixtures and failing tests for Calculator values, TextEdit Save panels and
   document headers, errors, missing reads, numbering, degradation and overlapping calls.
2. Extend `compact-reads.mjs` with action contexts and observations from its existing alignment.
   Keep element validity, remapping and the full-read override unchanged. Don't add another diff,
   engine read, screenshot, subprocess, timer or native probe. Small relay bookkeeping and
   formatting are unavoidable. Measure `process()` CPU on 3,000-line trees in the review report.
3. In `relay.mjs`, retain action contexts at forwarding and append the summary after result checks
   and compaction. Preserve the engine's original failure even when another handler rewrites it.
   Read-only calls, browser calls and internal diagnostics aren't summarized.
4. Publish every check attempt, including failures, add the changelog and limitations, then run
   `npm run check` and `npm run lint:prose` separately. Rebase onto `origin/pane/auto-mode`, repeat
   required checks if code changes, and push `codex/verified-results`. Never merge.

The source traces abbreviate long strings as `…(length)`. Fixtures retain that limitation; a
truncated tree is incomplete evidence for values and saves. Complete headers still explain window changes.
Additional controlled cases exercise complete trees and modified state without claiming live proof.
The unit checks use recorded data. Before release, sleight-arch runs the affected Calculator and
TextEdit, Chess and Safari-form benchmark tasks with the new summaries to check their effect on Claude's actions.
