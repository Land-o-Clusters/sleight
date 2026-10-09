# Replay

A run Claude finished can run again with no model. `record` reads the Claude Code transcript and
keeps the sleight calls that succeeded, in order. `replay` starts a fresh sleight relay, the same one
Claude Code runs, sends each call and stops at the first error it cannot safely wait through.

```bash
sleight-mcp record <transcript.jsonl | session id> task.json
sleight-mcp replay task.json
sleight-mcp replay task.json --wait-ms 2000
```

## Waiting

The default wait is 5 s per step. `--wait-ms` sets it from 0 to 60,000 ms. Zero disables it. Results and
CLI progress give each attempted step's `waitedMs`, including zero. Replay checks again every 250 ms
until that budget runs out. An engine call already in progress can outlast the budget; replay waits
for its result and never retries a timeout or an unknown outcome.

Only a guard stop for a missing ID, label or whole line can wait. The stopped window must match the
last observed title, app and URL. Replay must also prove that the stop came before the call's first
input. It recognizes sequences of awaited app calls with JSON arguments. The first input must name
the missing element, and no later input may produce the same stop message. A different missing
element, an ambiguous match, complex code, or an unknown window stops at once. This avoids repeating
input from a partly completed batch. It uses the existing guard.

`await app.click({"id":"Seven"}); await app.typeText("2");` can wait for its first button.
If that button was pressed and a later click stopped, the call never repeats. Loops and computed arguments
stop without waiting. Supporting them would need the guard to report whether any input was attempted
in the call, which it does not currently report.

## Claude taking over

The `replay` tool takes the recorded JSON as `script`, with optional `waitMs` and `allowPositions`.
Claude can read `task.json` with its file tools and pass its contents. A separate tool gives it a
structured stop result without putting script execution inside a `js` call.

The tool sends each step through the current relay. App handles, session approvals, leases, document
scope, flow rules and change review follow the same path as Claude's own calls. Approval requests go
to the current client. Replay never answers them. Concurrent tool calls are refused until replay
finishes. A turn-end or cancellation request prevents it from starting another step.

A stopped replay returns `ok: false`, the 1-based `step`, `error`, `waits`, and `remaining`, which
includes the stopped step. It also returns `window`, a fresh full accessibility read when the target
handle can be determined. When the read fails, `window: null` and `windowError` accompany the original
stop and remaining work. Replay never retries a refused acquisition for a snapshot. A flow-rule
refusal omits the snapshot so the user can still approve the pending call through `flow_exception`.

Claude should inspect that window and finish with `js`. A stopped batch may have sent input before
its failure, so its first step must not be repeated without checking what happened. The result stays
a normal tool result so Claude receives the takeover context. An invalid script is a tool error.
The desktop mod does not start replays yet.

## Safety

- An element number points at an element only in the tree Claude saw. Recording turns each literal number
  into what names that element in the tree Claude saw: its AX ID if no other element there has it,
  else its label, else its whole line. The window guard finds that element again in its own read
  before the action, and stops when it finds none or several.
- The guard still checks the window's title, app and URL before each action, and the input lease and
  approvals still apply.
- Screen coordinates, `drag` points and computed element numbers depend on where windows are. A
  script with any of them refuses to start unless you pass `--allow-positions`.
- Reads that only showed Claude the window are dropped. The guard reads for itself.
- CLI approvals go to the terminal you run it from. Without a terminal, only apps on your pre-approved
  list run.

## Measured

On Calculator (2026-10-09), a recorded run of 3 calls (open View, choose Scientific, compute 2^10)
replayed in 5.5 s against 17 s for the run Claude made. Starting from 0 it left 1,024 on the display.
Replays that started at 1,024 ended there too (2/2), which shows they ran, not that they computed it. Started with 7 entered, Calculator shows Clear instead of All
Clear, and the replay stopped at that click without pressing anything.

## Limits

- The app must start where the recorded run started. A different document, mode or entry stops the
  replay. A script repeats one run. It doesn't adapt the way Claude does.
- An element's line includes its value, so a line-matched element whose value changed stops the step.
- Only `js` and `drag` calls replay. Recording lists the other tools it skipped.

## Verification, 2026-10-09

These development runs used `node --test tests/replay.test.mjs`. The clock was fake. Guard and relay
integration tests used the production JavaScript with fake engine streams. They didn't send native input.

| Run | Passed / failed | Exit | Result |
| --- | --- | --- | --- |
| Baseline | 8 / 0 | 0 | Existing replay tests. |
| Wait tests | 8 / 4 | 1 | New tests failed before waiting was implemented. |
| First wait code | 11 / 1 | 1 | A drag step exposed an undefined call list. |
| Wait correction | 12 / 0 | 0 | Drag handling corrected. |
| Tool tests | 12 / 3 | 1 | New tests failed before the bridge existed. |
| First tool code | 15 / 0 | 0 | Same-session takeover and approvals passed. |
| Safety tests | 13 / 4 | 1 | Window identity, transport errors and position validation needed fixes. One test also filtered metadata incorrectly. |
| Safety corrections | 16 / 1 | 1 | Position validation reported drag points twice. |
| Position correction | 17 / 0 | 0 | Duplicate position descriptions removed. |
| Guard and relay integration | 19 / 1 | 1 | The fake approval request lacked required engine metadata. |
| Approval fixture correction | 20 / 0 | 0 | Fixture matched the real approval schema. |
| Review regressions | 20 / 4 | 1 | Review findings reproduced. |
| Review corrections | 24 / 0 | 0 | All four regressions passed. |

Review caught a snapshot targeting a later unrelated handle, a snapshot clearing a pending flow
exception, cancellation carrying the outer request ID, and a window lost between replay calls. Each
has a regression test. The fixes select the failed action's handle, preserve flow-exception context,
map cancellation to the active request, and retain windows observed through replay.

The first bare `npm run check` exited 1 under the workspace sandbox: local TCP and Unix sockets and
fixture-directory writes were denied. After host access was granted, the same bare command exited 0:
1,001 unit tests, both plugin validations and 11 mod tests passed. The branch then rebased onto
`origin/pane/auto-mode` at `6c90ee0`. The bare check after that rebase also exited 0: 1,002 unit tests,
both plugin validations and 11 mod tests passed.

Prose lint attempts exited 2 for missing styles, then 1 for six wording flags, then 1 for one remaining
wording flag, then 1 for eight flags in this run report, then 1 for a repeated sentence structure.
The first `vale sync` exited 2 because the sandbox refused the style directory write. The host retry
exited 0 and installed the pinned style pack.
The corrected report passed bare `npm run lint:prose` with exit 0 (59 files).

No live replay was attempted: `/tmp/sleight-hold` was present. The Calculator measurements above belong
to the original replay version. Native cancellation and delayed app elements remain unmeasured
in this change.
