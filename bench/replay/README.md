# Recorded tool replay

Replay sends recorded MCP requests to a worktree's sleight server, in tool-use emission order. It does not start a model. Each iteration creates the benchmark fixture again and starts fresh servers. Elapsed tool time still varies with the engine, browser and host load.

Preview a check without starting fixtures, servers or a live lock. Planning validates the app and URL allowlist, native fixture definition, nonce, directory and string mappings. Each live iteration finishes the same validation before taking responsibility for fixture cleanup:

```sh
node bench/replay/run.mjs --check MC1 --plan
```

Live commands require the owner to be away. They acquire `/tmp/sleight-live.lock` and stop during `/tmp/sleight-hold`. The permission observer stops replay if a macOS permission prompt appears. Each iteration has a 300000 ms deadline. `--deadline-ms N` accepts 1 to 3600000 ms. Actions and mapping reads race the abort signal. A hold found by the call guard aborts that signal immediately. Fixture setup and cleanup also check it before app operations. They never answer those prompts. A hold or permission-prompt abort can leave the owned benchmark browser open and the lock held. Further app actions stop, including browser cleanup, so the qualification owner must resolve the retained browser and lock after inspecting the evidence. Example for the live qualification owner:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node bench/replay/run.mjs --check MC1 --owner-away --repeat 5 --env SLEIGHT_MC1=1 --compare SLEIGHT_MC1=0
```

`--env` and `--compare` take comma-separated boolean switches from this list: `SLEIGHT_DP1`, `SLEIGHT_DP2`, `SLEIGHT_DP7`, `SLEIGHT_CK2`, `SLEIGHT_CK3`, `SLEIGHT_MC1` and `SLEIGHT_LB12`. Other names are refused, including switches for leases, window selection and stuck-menu recovery. Both servers and the turbo worker enforce that list. The settings run A, B, A, B, with N iterations of each. Using `--env` alone runs one setting N times.

For a capability without a switch, use two distinct worktree roots. Set `MS1_OLD_WORKTREE` and `MS1_NEW_WORKTREE` to prepared baseline and candidate paths, then preview the comparison:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node bench/replay/run.mjs --check MS1 --old-worktree "$MS1_OLD_WORKTREE" --new-worktree "$MS1_NEW_WORKTREE" --plan
```

Both builds must include the original SR2 launcher injection (`bfe6cf44`), which supplies an empty approval store and suppresses the headless payment card. A launcher without those parameters is refused before startup. Both need their dependencies installed. The replay driver stays in the harness checkout; the selected worktree supplies the native launcher, turbo server and turbo worker. The harness supplies the same fixture lifecycle for both builds. Each iteration starts and collects its own servers before the next build starts.

Worktree mode alternates A (old) and B (new) against the same loaded recording. Its plan and results identify each build's canonical path, commit, tracked dirty state and tracked diff hash. These are checked again before each iteration. Untracked dependencies are outside that identity check. `--env` applies equally to both builds. Combining worktree mode with the switch-based `--compare` is refused. MS1 requires worktree mode. A future live command for the qualification owner is:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node bench/replay/run.mjs --check MS1 --old-worktree "$MS1_OLD_WORKTREE" --new-worktree "$MS1_NEW_WORKTREE" --owner-away --repeat 5
```

Inputs can be a race task folder containing `run.json` and `events.jsonl`, or a native results file:

```sh
node bench/replay/run.mjs ~/Projects/sleight-wt/race-1017/safari-sleight-b10-r3/form-checkout --plan
node bench/replay/run.mjs RESULTS.json --task textedit-window-drag --arm sleight --run 1 --evidence RETAINED_TASK_FOLDER --plan
```

Native `bench/run.mjs` runs save transcripts through `bench/driver.mjs` as `~/Library/Caches/sleight-bench/evidence/<stamp>/<arm>-<task>-<run>/transcript.jsonl` (`BENCH_ARM_HOME` overrides `~/Library/Caches/sleight-bench`). Results rows usually do not contain that path. The loader derives it from the results stamp, looking in the durable evidence folder first, then `$TMPDIR/sleight-real-evidence` and its realpath for older recordings. `--evidence` names a retained copy. Multiple matching rows require `--arm` and `--run`.

## Fixture and approval boundaries

Browser replay reuses `startGateSites`, `realBrowserPlan`, `launchRealBrowser`, `resetRealBrowser`, `checkBrowserOwner` and the browser's own `stop`. It uses a fresh benchmark profile and the original task definition from `run.json`. The pinned FowlBrowser fixture cache must already exist. The cache must be installed beforehand. Replay does not copy credentials or rewrite approval lists. It does not prepare other arms.

Native replay reuses `getTasks`, `genericTask` and `executeRealTask`, including its fixture setup, check, cleanup and permission observer. Supported native fixtures are the TextEdit save, edit, drag, two-window, replace and insert-line tasks. The recording must identify exactly one benchmark fixture directory and nonce. File names and contents use that nonce. The directory moves. Random calculator operands, external documents and real accounts need a saved fixture manifest and are refused.

The engine server uses the ordinary sleight launcher with an empty in-memory approval store. User preapproval files are neither read nor written. App and origin approvals come from the existing `answerElicitation` policies, `bench/approve.mjs` or the race's `origin-hook.mjs`, within the benchmark allowlist. Window selection and turbo's engine-browser restriction use the benchmark's existing guards. Only session or once answers are returned. Replay supplies no payment confirmation, consent-card answer or remembered approval. A gated result diverges immediately. The headless engine companion does not open a payment card.

Before transport, replay refuses app names and bundle IDs outside `BENCH_APPS` and `REAL_APPS`. URLs must use the race allowlist: HTTPS Wikipedia or MDN, or HTTP 127.0.0.1 on the benchmark ports. Credentials, other schemes, unknown ports and computed app or URL selectors refuse. The approval policies still decide each elicitation.

The turbo arm uses the benchmark's v3 server and privately binds the original task message. Turbo follows the product's task-message payment rule. A user message with the payment, amount and payment method is confirmation, so a local form-checkout replay can complete its purchase click without a new card. Payment guards remain active for requests that lack that confirmation. Both servers and the worker receive the replay switches. A validated benchmark data envelope forwards the requested boolean feature switches to the worker beside its existing LB12 setting. This does not enable installed turbo or read its opt-in file.

If server collection, fixture cleanup or permission observation leaves ownership uncertain, replay keeps the lock and artifacts. It writes the reason into the result. The harness owns and collects the processes it launches.

A server that exits before answering initialize still fails the iteration. Once its close event confirms collection, native cleanup closes the retained fixture windows and quits only apps the iteration launched. The fixture helper checks PID, bundle and launch time. An independent PID exit check must agree before cleanup permits lock release. An uncollected server or an app still running keeps the lock.

## Mapping and divergence

- Native element numbers match a unique role, label and full ancestor path in the recorded and current trees. Trees are keyed by receiver, app and window title. Numeric input must use the last-observed receiver. Selecting another window expires that tree until a new observation. Rebinding a handle or reacquiring another app refuses old numbers. A unique label in another ancestor path cannot supply a mapping. Values are excluded from identity matching but retained in result comparison. Compact diffs update existing numbers. New numbers remain uncertain until a full recorded tree establishes their path. A second Save in a diff cannot inherit the first Save's path. Literal numeric element arguments, including both drag endpoints, go through a JavaScript parser and mapper. Unsupported methods with numeric or computed arguments refuse before input. Typed text, timing options and key sequences keep their values.
- Coordinates require matching native selection receipts from the immediately preceding `select_window` call on the engine companion. Page text and JavaScript output cannot provide frame evidence. A receipt needs the app's bundle ID, window title and `identity.windowNumber`. Its `frame` contains finite `x`, `y`, `width` and `height` values in points. Origin and size must each differ by at most 2 pt. Cross-window input needs both frames in that observation. The request uses the same app bundle ID and explicit window IDs. Missing, ambiguous or expired frame evidence stops before input. Mapping reads expire frame evidence too. JavaScript handle coordinates and nested coordinate requests lack that proof and refuse.
- Existing native selection receipts omit frames. Such recordings, including the retained DP7 coordinate calls, stop before coordinate input. Screenshot dimensions cannot establish a window's origin or its point dimensions. Plans retain explicit frame receipts in `windowFrames`. Missing bounds remain unknown.
- Turbo ref maps are scoped to recorded tab handles. Snapshot and diff state is separate for each page, so overlapping `e5` refs cannot share mappings. Missing tab mappings or snapshots stop input. Removals and refreshes affect only the target tab.
- Tab handles match one header on each side with the same URL and title. Native window numbers map from matching `select_window` receipts, by app and title. `windowId` and `toWindowId` use those receipts too. Unknown IDs are refused.
- Acquired app handles map from one `Window handle` notice on each `open_file` result, with matching window and app headers. Later code and mapping reads use the fresh identifier. A missing or ambiguous notice stops when the recording supplied a handle. Identifier replacement preserves longer names. A/B output comparison uses the recorded handle name.
- The fixture directory and gate marker have explicit substitutions, including the encoded marker URL. Other window titles must match exactly. A missing element mapping triggers one read on the already acquired app handle, or `browser_read` on the mapped turbo tab, before input. A second ambiguity stops. Replay never resends an action after partial or uncertain input.
- Result comparison normalizes mapped handles, element numbering, runtime process IDs and line endings. With `--compare`, successful text changes from the recording continue and appear in each call's `recordingTextDifference`, with the normalized recorded and replay text. Later element arguments still need mappings through fresh trees. Refusals and errors in either result stop, including a recorded failure that now succeeds. Text-only results retain window and app identity checks. Structured results still compare exactly against the recording. Image items match by count, order, type, MIME type and pixel dimensions, with one matching window header after fixture path substitution. PNG and JPEG dimensions come from the image data, in either recorded or MCP format. Pixel bytes may differ. Missing dimensions or missing, changed or ambiguous window headers stop for visual interpretation. Other media still compare exactly. Single-arm and worktree replays retain strict text comparison against the recording.

Replay serializes requests even if the original host overlapped them. It cannot reproduce concurrency, model reasoning, unrecorded intermediate UI states or a model's response to a different result. Continuing through changed text tests the recorded actions against fresh mappings, without measuring how a model would respond to that text. A recording that guessed an unseen ref has no identity to map and can stop even against its own recorded responses.

## Evidence and checks

Pass a new directory to `--out`. Otherwise replay creates a private temporary output folder. Each iteration writes `trace.jsonl` with MCP traffic, approvals, mapping reads, recorded and submitted arguments, results and per-call milliseconds. The launcher also writes its ordinary `trace-<pid>.jsonl`. Turbo writes `turbo-metrics.jsonl`. `result.json`, the campaign's `plan.json` and `summary.json` retain failures as well as passes.

Server stderr goes to `computer.stderr.log` and, when present, `turbo.stderr.log`, capped at 65536 bytes each. The same cap applies to each server's stderr in `trace.jsonl`. A `stderr-truncated` event marks discarded bytes. The engine inherits the launcher's stderr pipe. Its startup errors reach that evidence too.

Check startup without creating a fixture or acquiring an app:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node bench/replay/startup-probe.mjs --out NEW_DIRECTORY
```

This sends only `initialize`, its initialized notification and `tools/list`, then closes stdin and collects the owned server. `startup.json` records the launcher Node, resolved engine runtime, handshake results and exit. It uses the replay environment with installed turbo and the ghost hand off. A startup pass does not qualify a live replay.

Each A/B pair includes a per-call result diff, with normalized A and B outputs, changed JSON paths and explicit missing results. Fixture aliases, changing handles and runtime IDs are normalized. Image comparisons contain MIME type and pixel dimensions. Raw images remain in each call's evidence. Values and errors remain.

Per-call medians include the reached prefixes, with sample counts. Total tool-time medians include complete passing replays only. Mapping-read milliseconds are reported separately. Setup, server startup, cleanup and model time do not enter tool time. Missing or divergent runs never appear as a faster total.

`checks/` pins recorded runs and assertions for DP1, DP2, DP7, CK2, CK3, MC1, MS1 and LB1. Run each with `--check ID`. The default sets its switch to 1 when the code has one. A check whose target was not reached is `inconclusive`. DP7 also requires the world fixture's saved-file check to pass. The selected MS1 recording contains the two-language array, whereas rel131-r1 used click and key recovery. LB1 times the viewport-only restore with `observe:none`, which excludes a full snapshot's cost. The candidate must pass its check. A baseline check failure is expected evidence and does not fail the comparison. The disabled switch identifies the baseline, even when supplied first. Worktree mode uses A (old) as baseline and B (new) as candidate. Skipped or inconclusive baseline evidence still stops qualification.

Both arms must complete replay and reach the check target. Each arm's assertion uses its own trace. The verdict compares A against B at every call. Differences outside the selected check target fail the campaign, even when both assertions pass. At the target, output differences remain visible and the candidate must pass its assertion. The disabled baseline may fail that assertion. A text difference from the recording alone cannot fail a switch comparison. Refusals, errors, missing elements, changed window or app identity, transport failures and unproved cleanup still stop qualification. A stopped prefix cannot pass through a check-target exemption. Comparisons without a check require complete matching results. DP2 and LB1 require a lower candidate median for each selected call than baseline, with samples from every iteration. A single-arm run cannot pass those timing checks.

DP2 checks Accessibility delivery, a lower call median than baseline, and the DPc phase events under `SLEIGHT_TRACE`. LB1 uses the same relative timing gate for its viewport-only call. The verdict uses the measured ratio between arms. The launcher writes `direction: "drag-phase"`, with `msg.phase` equal to `ax-move`, `raise`, `settle` or `posted-press`. `msg.edge` is `start` or `end`. `msg.monoMs` is monotonic milliseconds, and `msg.helperPid` identifies the helper. The helper's stderr prefix is `sleight-drag-phase `, which the launcher converts to those JSON trace entries. No document content belongs in a phase event.

For each selected drag call, phase pairs must nest correctly, use one helper and have nondecreasing monotonic times. Exactly one complete AX move must finish before any raise. An Accessibility result must have no posted press. Nested settle events during the AX write are allowed. A build without phase events reports `skip` and specifies the missing events. Partial, malformed, mixed-helper or reversed evidence fails. The `SLEIGHT_DP2=0` baseline keeps its old raise/settle-first behavior and can fail the candidate's path or ordering predicates. Its calls and timings remain in the evidence.

Offline unit coverage:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node --test tests/bench-replay.test.mjs
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node --test tests/bench-replay-safety.test.mjs
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node --test tests/bench-replay-sr2d.test.mjs
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node --test tests/bench-replay-audit.test.mjs
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node --test tests/bench-replay-sr2e.test.mjs
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node --test tests/bench-replay-sr2f.test.mjs
```

The feedback audit returns recorded responses through the mapper without launching fixtures or servers. It refuses an unrecorded mapping read rather than consuming the next action's response. It covers eight check IDs from seven retained recordings when installed. Absent recordings are named as skipped, and synthetic unit coverage runs on every machine. A feedback match establishes agreement with the recorded responses. Feature checks, trace ordering, fixture outcomes and live performance need separate qualification.
