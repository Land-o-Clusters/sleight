# Guard reads

Before the first native action of a call, and before every action on an element number, ID, label
or line, sleight's window guard reads the whole accessibility tree, unless Claude read the window
since the last action in the same call. It checks the window's title, app and URL, resolves
`{ id }` and `{ label }`, and stops a numbered action that an earlier one renumbered. After the call
it reads once more if nothing gave the relay a window header.

Since 2026-10-09 (owner's call), keys, typing, paste and coordinate actions that follow typing,
pasting or a plain key in the same call go ahead on the header the guard last checked, without a
read. After a click, a shortcut, Return, Escape, Tab or Space the next action still reads: the read
also waits for the panel or sheet that action opened, and a batch of Cmd+O, Cmd+Shift+G and a typed
path outran TextEdit's Open panel without it (textedit-drag, 2026-10-09). A read right after input
waits for the UI to settle: 389 to 427 ms against 38 to 83 ms for one before it at load 42 to 53,
and up to 118 s with 20 CPU workers added (`load-cost`). Codex doesn't make that read.
`SLEIGHT_GUARD=careful` and document scope keep every read.

## What changed (2026-10-07, Codex on gpt-6-astra)

- A `getAXStateAndScreenshot()` result counts as a read the guard can reuse, as `getAXState()`
  already did. It requests `disableDiffing: true` and is kept only when it has one full window header.
- Every action clears the call's saved reads for every handle. Before, an action through a second
  handle on the same window left the first handle's read in place, so a later action through the
  first handle could be checked against a stale tree.
- A read that started before an action can't refill the cache when it finishes after it.
- With `SLEIGHT_TRACE` set, each guard read writes a timing line (phase, ms, characters, failed),
  which the relay strips from the result and traces. The code that writes it is Claude's own
  JavaScript realm, so the record can be forged and is for measurement only.

The guard is cooperative JavaScript, not a security boundary, and it expects actions to be awaited.

## Measurements

`node bench/guard-reads.mjs <before|after> all`, no model calls, five repetitions per arm on engine
26.1002.52244, taken one after the other with the owner using the Mac about half the time. Medians:

| App | Sequence | Guard reads before / after | Guard ms before / after | Call ms before / after |
|---|---|---:|---:|---:|
| Calculator | click IDs One to Eight | 9 / 9 | 3330 / 3336 | 3645 / 3644 |
| TextEdit | select all, type, Cmd+S | 4 / 4 | 1376 / 1383 | 1448 / 1475 |
| Chess | full read with screenshot, Escape | 2 / 1 | 436 / 405 | 511 / 454 |

All 30 trials passed. Only the Chess sequence, which reads with a screenshot, saves a read. Raw
results, every repetition and the failed early attempts are in
[`2026-10-07-guard-reads.json`](../benchmarks/2026-10-07-guard-reads.json), and the patch that adds
timing to the old guard is [`2026-10-07-guard-reads-baseline.patch`](../benchmarks/2026-10-07-guard-reads-baseline.patch).

## Read cost

In the baseline the first guard read in a batch took a median of 51 ms in Calculator and 42 ms in
TextEdit. Later reads, each after an action, took 407 and 476 ms. Guard reads were 86 to 95% of
engine time in these sequences. The engine has no header-only or depth-limited read, and its reply
doesn't say how long the helper's AX walk, its wait for the UI to settle, the capture or the
transfer took. That a read after input waits for the UI to settle fits these numbers but isn't
measured. Parsing the tree in sleight took 0.01 to 0.04 ms.

## Native observation experiment (2026-10-09)

The requested per-action speedup is unfinished. The production guard keeps its full reads. A
persistent JXA observer in `bench/` reads the focused window, title, AXDocument, sheets and dialogs.
It identifies the process by PID and launch time, retains AX window references for equality, and
rejects multiple matching windows, missing required attributes and focus changes during a read.
It checks existing Accessibility trust without requesting permission. Multiple app processes are
ambiguous, never evidence that the benchmark launched the app.

Cold JXA observations took median 78.39 ms. Persistent observations took 2.06 ms at load 3.
The fuller socket observer took 3.85 and 12.97 ms in two low-load runs. With 20 workers at load
62 to 67, only 6/20 observations succeeded; 14 returned an AX error after the 100 ms messaging
deadline. The median across all 20 replies was 104.28 ms. Suspending the owned helper produced an
expired reply at about 251 ms, never a usable observation. This does not establish a fast observer
at load 100. A final 20-worker run at load 43 returned two AX errors, one expiry and 17 busy
refusals, with no usable observations.

The engine's JavaScript returned `connect EPERM` for the Unix socket. The prototype integration
and its guard-routing tests are retained in `bench/guard-speed-native.patch` for review. They are
not applied. The plugin has no native observer dependency. Further integration needs a supported
transport and reliable observation latency at the requested load. Engine and sandbox settings are
unchanged.

The proposed routing keeps the first full read and every tree-based selector check. Only later
keys, text, paste and coordinate actions could use a fresh matching native observation, with a
full-read fallback on failure. Lease checks, invalidation across handles and post-call reads stay
in place. A same-title replacement, a changed URL, a sheet or a late reply must never authorize
input. Future integration must meet these requirements.

A 100 ms `Promise.race` around the post-input read returned from the engine in 516 to 563 ms,
and the read had completed by the following call in all four trials. This failed to demonstrate
a bounded return or a following call while the read remained pending. Production reads
have no new abandonment deadline.

The compactor now folds a full button line and its bare ID form only when that ID is unique in
both trees. Missing descriptions and help are reported as unavailable. Lost values or state,
duplicate IDs and changed IDs still produce changes. Renumbering invalidates old numbers, and a remap must
find one current line with an unambiguous ID across the current tree and retained beliefs.
On a constructed degradation of a published live Calculator tree, output fell from 742 to 313
characters. This measures output size, not live action speed. The [report](../benchmarks/2026-10-09-guard-speed.md)
contains all attempts, load intervals, timing comparisons and remaining limits.
