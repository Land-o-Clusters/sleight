# Exact window selection, October 4

Branch: `codex/window-targeting`, rebased onto `27b0528`. Worktree:
`~/Projects/sleight-wt/window-targeting`.

The revised branch removes unsupported `windowId` guidance and routine window
notes. `select_window` matches one exact title or AXDocument file URL, applies
AXRaise/AXMain without activation, then requires a matching standalone `getApp`
read before editing. Selection holds an app lease. Recovery hints repeat the
same selector. During an active selection, action replies add a short note
when the result window changes or its full header is missing. Reset, failed
reselection or a confirmed window change clears the selection. The note marks the outcome unconfirmed.

macOS engine 26.930.31730 still rejects `getApp({ windowId })` and omits windows
from inventory. The Accessibility alternative worked in nine edits across three
runs with two temporary TextEdit documents. Each alternated left, right, left,
using URL, title, URL. Both buffers and saved files matched the intended edits.
TextEdit was inactive and the foreground PID unchanged before selection, after
engine acquisition and after each action. These are sampled observations, not
continuous focus monitoring. No other app has been tested.

The Swift prototype passed three edits. The C bridge in JXA failed before raising
with "Ref has incompatible type". System Events' AXRaise/AXMain interface passed
three edits, then the integrated tool, approval and lease path passed three more.
The runtime tool uses System Events and does not need a compiler. To repeat the bounded
probe, run `sh bench/window-targeting.sh docs/benchmarks/NEW-ATTEMPT.json` with a
fresh lowercase filename. The wrapper compiles its observer before taking the
live lock. The probe needs Swift and stops at the first ignored selection.

## Attempts

Runs that opened fixtures held `/tmp/sleight-live.lock` only while opening, checking
and closing their own two temporary TextEdit documents. Host runs used `bench/approve.mjs`,
the existing benchmark allowlist, for approvals. Owned engine exit codes were 0 in eight runs through turn cleanup and stdin EOF,
without signaling the shared helper.
ChatGPT stayed running. The general benchmark was not run.

| Attempt | Exit | Result |
|---|---|---|
| [1](2026-10-04-window-targeting-attempt-1.json) | 1 | Sandbox automation could not resolve TextEdit. No document opened. Cleanup hit the same error. |
| [2](2026-10-04-window-targeting-attempt-2.json) | 1 | Host opened both documents. Window inventory was absent. No edit trials ran. Both documents closed. |
| [3](2026-10-04-window-targeting-attempt-3.json) | 1 | Logged TextEdit's inventory fields to confirm windows were absent. Both documents closed. |
| [4](2026-10-04-window-targeting-attempt-4.json) | 1 | Read both fixture window IDs natively. All three exact engine selections were rejected. Both documents closed. |
| [5](2026-10-04-window-targeting-attempt-5.json) | 1 | Canceled a final repeat while waiting for the shared lock. Its Node harness had not started. Sent one Ctrl-C and collected the terminal exit. |
| [6](2026-10-04-window-targeting-attempt-6.json) | 1 | Sandbox automation could not resolve TextEdit. No document opened. Cleanup hit the same error. |
| [7](2026-10-04-window-targeting-attempt-7.json) | 0 | Swift AXRaise/AXMain, 3/3 intended edits, unchanged sampled foreground state. Both documents closed. |
| [8](2026-10-04-window-targeting-attempt-8.json) | 1 | JXA C bridge returned "Ref has incompatible type" before raising or editing. Both documents closed. |
| [9](2026-10-04-window-targeting-attempt-9.json) | 0 | System Events AXRaise/AXMain, 3/3 intended edits, unchanged sampled foreground state. Both documents closed. |
| [10](2026-10-04-window-targeting-attempt-10.json) | 0 | Integrated tool with approval and app lease, 3/3 intended edits, unchanged sampled foreground state. Both documents closed. |
| [11](2026-10-04-window-targeting-attempt-11.json) | 1 | Round-2 sandbox automation could not resolve TextEdit. No document opened. Cleanup hit the same error. |
| [12](2026-10-04-window-targeting-attempt-12.json) | 0 | Revised tool, 3/3 intended edits and recovery after closing the selected document. Both documents closed, TextEdit inactive at each sample. |

Raw relay requests, replies and failures are retained. Inventory responses are
redacted because they include other sessions' apps and document titles. Fixture
inventory and all relevant replies are retained. Home paths are shown as `~`.

## Checks

After rebasing onto `27b0528`, `npm run check` exited 0: 196 unit tests, plugin
validation and eight mod tests passed. `npm run lint:prose` exited 0 with zero
flags across 17 files. Round-2 live attempt 12 exited 0, including three targeted
edits and a successful edit after closing the selected document.
