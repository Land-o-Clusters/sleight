# Guard reads

Before every native action, sleight's window guard reads the whole accessibility tree, unless Claude
read the window since the last action in the same call. It checks the window's title, app and URL,
resolves `{ id }` and `{ label }`, and stops a numbered action that an earlier one renumbered. After
the call it reads once more if nothing gave the relay a window header.

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
