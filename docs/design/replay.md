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
title, app and URL observed within this replay. Replay must also prove that the stop came before the call's first
input. It recognizes sequences of awaited app calls with JSON arguments. The first input must name
the missing element, and no later input may produce the same stop message. A different missing
element, an ambiguous match, complex code, or an unknown window stops at once. This avoids repeating
input from a partly completed batch. It uses the existing guard.

Replay takes its expected window from its first step's result. That can be a successful acquisition
or the guard's first missing-element refusal, after proving that input hasn't run. Later refusals
must match that window. Ordinary results outside replay aren't inspected or cached for it.

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
The desktop mod starts replay through this same tool.

## Desktop commands

`/sleight record [file]` gets the current session's ID and runs the plugin's recorder with that ID,
using an argument vector with no shell. The recorder reads the full saved transcript, including
calls before compaction. The mod refuses empty recordings, existing output files and stdout cut at
the host's 4 MiB output limit. Omitting the file argument uses `sleight-<session id>.json`.

`/sleight replay <file>` opens the pane, reads the script and calls `replay` on the session's connected
MCP server. It starts only while Claude is idle and the user's Stop is not in force.
Replay never clears Stop, which remains until a new prompt. There is one replay call for the whole script;
the relay retains its concurrency, waiting and cancellation checks across steps. The pane shows that
it is running and keeps Stop available. When the call returns it lists every attempted step's outcome
and `waitedMs`, newest first. The file field starts empty, and both pane buttons require a filename.
The Record session button does not use the command's default filename.

On a stop, the mod sends Claude the structured result, including remaining steps, the window or its
read error, and a reminder to inspect any partial input. It does not snapshot the pane or end the
engine turn between that stop and handoff, because either could discard a pending flow exception.
A user Stop sends `turn_ended` and suppresses handoff before submission. If another plugin delays
a prompt already submitted, it can still arrive after Stop. In this host, the automatic handoff
skips this mod's own prompt hook and cannot lift Stop; computer input is blocked until a new
user message. The result and log identify the stopped step and warn that it may have sent input.
Refresh waits until replay finishes.
Invalid files, refused tools and transport errors are reported without asking Claude to bypass them.
The handoff timer is registered after the replay cleanup awaits finish and the active flag clears.
If a newer replay overtakes it, a toast reports the missed handoff.

The mod's `tool.check` allowance still covers only its own exact pane snapshot and `turn_ended`.
The host treats `$.mcp.call` as a plugin call, with the plugin itself providing the grant.
The outer replay call can be seen by hooks above this mod. Its inner `js` steps run inside the relay:
they do not pass through Claude Code's per-call permission rules or other plugins' hooks.
The relay's app approvals, input lease and guards still apply to each step. App approvals go to the user.
Positional scripts remain refused in the pane. Claude's tool and the CLI keep their explicit opt-in.
Recording and replay add no
transcript reads, file work, timers or engine reads to calls that do not use them. The bridge's existing
tests still check zero JSON parses and serializations for ordinary messages, including a 1 MiB image.

Replay is listed with `anthropic/alwaysLoad: false`. A host with tool search can defer its schema,
while the pane calls the tool directly by name on the connected server without a model search.
Claude Code's full context breakdown reports 496 estimated schema tokens for the production tool name,
loaded with `alwaysLoad: true` and deferred with `false`. Billed-token usage was not measured.
Hosts with tool search disabled may load it regardless. The
[probe and its limits](../benchmarks/2026-10-09-replay-desktop-2.md) record both arms.

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
The follow-up below replaces that last fix with an observation from each replay's own result.

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

## Bridge CPU follow-up, 2026-10-09

The bridge now passes unchanged lines through verbatim. It parses internal replay replies, matching
pending `tools/list` replies, tool-list requests, replay requests, and cancellation or tool calls while
replay is active. Only modified tool lists, remapped cancellations and new replay messages are
serialized. Escaped envelope fields take a conservative parse fallback. Framing preserves CRLF,
split UTF-8 characters and the final line even when it lacks a delimiter.
Ordinary tool results aren't parsed for windows. The existing relay still refuses input
while another engine call is pending, covered by the approval-and-lease integration test.

The recorded source was `$TMPDIR/sleight-bench/2026-10-09T22-25-01-496Z/sleight-chess-drag-2/trace-38602.jsonl`:
215 trace records, 79,701 bytes, SHA-256
`09efbb6d936149cc0bdd45a8e09a490aa0268899d2a11ad977301198c8ee81a7`.
The harness selected `to-server` and `to-client` messages, serialized them once before timing, and fed
82 lines (37,085 UTF-8 bytes) through the two bridge streams. The trace's 10 image fields each
contained 309 characters. A separate unit test uses a 1 MiB image payload and asserts zero parses,
zero serializations and unchanged output bytes.

Each CPU sample used 1,000 runs after 100 warm-up runs on Node v26.4.0. A run created and closed the
bridge streams and discarded their output. CPU means `process.cpuUsage()` user plus system time.
No engine or app was started.

| Source | CPU ms per run, samples | Median ms per run | Exit |
| --- | --- | --- | --- |
| Before, `de4db37` | 0.726831, 0.612140, 0.607557, 0.580360, 0.598345 | 0.607557 | 0 |
| First fast path | 0.362462, 0.300997, 0.284789, 0.280142, 0.280523 | 0.284789 | 0 |
| Final, with framing and escaped-field handling | 0.351655, 0.333688, 0.294278, 0.323893, 0.298552 | 0.323893 | 0 |

Median CPU fell 46.7% for this trace. That measures the bridge and stream harness, not the whole
plugin's CPU footprint. The harness didn't time trace parsing, module loading, engine work or live app
behavior. The follow-up unit runs were 24 passed / 4 failed (exit 1), then 28 / 0 (exit 0), then 28 / 0
(exit 0) after extending the relay concurrency test. Review regressions then gave 25 / 5 (exit 1)
and 30 / 0 (exit 0). Escaped slash tests gave 29 / 2 (exit 1), followed by 31 / 0 (exit 0).
Review caught an initial read consuming an approved flow exception. The first refused step's own
window now supplies the expected window without inserting a read. Unicode and slash escapes in
envelope fields, and unchanged CRLF lines, also have regression coverage.

An interim bare `npm run check` hit 180 s compiler timeouts in the native prototype, Helium, Mail,
Mimestream, PDF and Chess fixture tests. It was interrupted once through its retained terminal and
exited 1, with 998 passed, 6 failed and 1 cancelled. A diagnostic `codex-macos-inspect help` exited 64
because that operation is unsupported. The supported `memory-pressure` operation returned 2.
Prose lint exited 1 for two wording flags in the report, then 1 for two flags in the final receipt.
The branch rebased onto `origin/pane/auto-mode` at `8aff828`, which includes `08abe24`.
The final bare `npm run check` exited 0: 1,010 unit tests, both plugin validations and 11 mod tests
passed. Bare `npm run lint:prose` exited 0 across 59 files. The final focused review is complete.

The measurement runner takes a module path and trace path. The before module is `de4db37`'s
`replay.mjs`, with its relative document-scope import pointed at the same worktree dependency.

```js
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
const [modulePath, tracePath] = process.argv.slice(2);
const { replayBridge } = await import(pathToFileURL(modulePath));
const lines = readFileSync(tracePath, 'utf8').trim().split('\n').map(JSON.parse)
  .filter(r => ['to-server', 'to-client'].includes(r.direction))
  .map(r => ({ client: r.direction === 'to-server', line: JSON.stringify(r.msg) + '\n' }));
async function run() {
  const input = new PassThrough(), output = new PassThrough();
  const bridge = replayBridge({ input, output });
  output.on('data', () => {});
  bridge.clientIn.on('data', () => {});
  for (const { client, line } of lines) (client ? input : bridge.clientOut).write(line);
  input.end(); bridge.clientOut.end(); output.end();
  await setImmediate();
}
for (let i = 0; i < 100; i++) await run();
for (let sample = 0; sample < 5; sample++) {
  const started = process.cpuUsage();
  for (let i = 0; i < 1000; i++) await run();
  const used = process.cpuUsage(started);
  console.log((used.user + used.system) / 1000 / 1000);
}
```
