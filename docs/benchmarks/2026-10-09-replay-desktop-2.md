# Desktop replay review fixes, 2026-10-09

Branch `codex/replay-desktop`, rebased from `32cb3de` onto `origin/pane/auto-mode` at `6c54e4b`.
That base includes the review prompt's `7d880dc`. The first rebase, onto `f7392be`, preserved both
sides of conflicts in the changelog and the prose file list. The final rebase includes two later
documentation commits. No merge or change to the primary checkout was made.

## Changes

- The file field starts empty. Both pane buttons request a filename before reading, recording or
  replaying. `/sleight record` without a file still uses the session-specific default filename.
- Stop remains in force when replay is requested. A new prompt is required to resume computer use.
- A canceled replay identifies the stopped step in its result and pane log, warning that it may
  have sent input and that the window must be checked before repeating it.
- The failed-replay handoff timer is registered after the cleanup awaits finish. A regression
  test holds cleanup pending, advances the timer, then confirms exactly one handoff after release.
  A newer replay produces a toast instead of silently dropping the older handoff.
  Stop suppresses a handoff before submission. A prompt delayed in another plugin after submission
  can still arrive, but a regression confirms it cannot lift Stop: input stays refused until a
  new user message. This host skips the mod's own prompt hook for its automatic handoff.
- Replay stays in `tools/list` with `anthropic/alwaysLoad: false`. The pane calls it by name through
  the session connection. Relay and mod tests still cover that call and the existing approval path.
- The design now states that the pane's inner `js` steps do not pass through Claude Code's per-call
  permission rules or other plugins' hooks. The host grants the outer plugin MCP call. The relay
  still applies its app approvals, lease and guards.

## Token probe

`node bench/replay-desktop-tokens.mjs` starts two isolated Claude clients with a read-only MCP
fixture exposing the real replay description and input schema. It sends control requests only,
without model prompts, replay execution or an engine. Each client and its fixture exit before the
next arm starts, and the script removes its private temporary directory. Tool search is enabled
for both arms. `get_context_usage` uses `detail: full`, on `claude-sonnet-5-5`.

| Tool name | `alwaysLoad` | Reported schema tokens | `isLoaded` |
|---|---|---:|---|
| `mcp__plugin_sleight_computer__replay` | true | 496 | true |
| `mcp__plugin_sleight_computer__replay` | false | 496 | false |

Claude labels this figure an estimate. Both breakdowns reported the same aggregate total, 2,340
tokens, so that aggregate is not used as evidence of a billed-token saving. The per-tool flag
confirms schema deferral in this host. The earlier short fixture name reported 490 schema tokens.
The full [probe results](2026-10-09-replay-desktop-2.json) preserve both names and the failed first
attempt, which queried context before the MCP connection was ready.

Deferral does not remove the tool from discovery or alter the pane's direct named call. The
protocol test executes replay after reading the deferred definition, and the mod harness exercises
the pane's call through the session connection. Native desktop clicks remain unmeasured.

## Runs

The hold file was absent at the run preflights. There were no live app actions, system dialogs or
permission answers. The preceding report preserves the first branch's runs.

| Run | Command | Result | Exit |
|---|---|---|---:|
| 1 | `claude plugin details ./plugins/sleight --json` | Unsupported `--json` option. | 1 |
| 2 | `claude plugin details ./plugins/sleight` | A path is not accepted as the installed plugin name. | 1 |
| 3 | `claude --plugin-dir ./plugins/sleight plugin details sleight` | 87 projected always-on skill tokens. Runtime MCP schemas not counted. | 0 |
| 4 | `npm run test:mod` | New regressions reproduced: 20 passed, 4 failed. | 1 |
| 5 | `npm run test:mod` | Empty file field fixed: 21 passed, 3 failed. | 1 |
| 6 | `npm run test:mod` | Partial input warning fixed: 22 passed, 2 failed. | 1 |
| 7 | `npm run test:mod` | Stop preserved: 23 passed, 1 failed. | 1 |
| 8 | `npm run test:mod` | Cleanup ordering fixed: 24 passed. | 0 |
| 9 | `node --test tests/replay.test.mjs` | Deferred-schema regression: 30 passed, 1 failed. | 1 |
| 10 | `node bench/replay-desktop-tokens.mjs` | Both arms queried context before connection, so replay was absent. | 1 |
| 11 | `node --test tests/replay.test.mjs` | Deferred definition and relay replay: 31 passed. | 0 |
| 12 | `node bench/replay-desktop-tokens.mjs` | Waiting for connection produced 490 schema tokens under the short fixture name. | 0 |
| 13 | `node bench/replay-desktop-tokens.mjs` | Production tool name: 496 tokens, loaded true then false. | 0 |
| 14 | `npm run lint:prose` | 2 wording flags in the changed docs. | 1 |
| 15 | `npm run lint:prose` | 1 wording flag in the run table. | 1 |
| 16 | `npm run check` | 1,138 unit tests, both manifests and 24 mod tests passed. | 0 |
| 17 | `npm run lint:prose` | 71 files passed. | 0 |
| 18 | `npm run test:mod` | Delayed handoff regression expected suppression after submission: 24 passed, 1 failed. | 1 |
| 19 | `npm run test:mod` | Own-origin prompt guard did not change delivery: 24 passed, 1 failed. | 1 |
| 20 | `npm run test:mod` | Stop was visible before releasing the delayed prompt. Late delivery still failed the expectation. 24 passed, 1 failed. | 1 |
| 21 | `npm run test:mod` | Completion barrier confirmed late delivery: 24 passed, 1 failed. | 1 |
| 22 | `npm run test:mod` | Origin trace identified the handoff as Sleight's: 24 passed, 1 failed. | 1 |
| 23 | `npm run test:mod` | Prompt-hook diagnostic did not run for the own handoff: 24 passed, 1 failed. | 1 |
| 24 | `claude plugin validate plugins/sleight` | Manifest and hooks validated. | 0 |
| 25 | `npm run test:mod` | Awaiting the diagnostic confirmed the hook was absent: 24 passed, 1 failed. | 1 |
| 26 | `npm run test:mod` | A re-entry catch did not change delivery: 24 passed, 1 failed. | 1 |
| 27 | `npm run test:mod` | Dispatch trace contained no Sleight prompt hook: 24 passed, 1 failed. | 1 |
| 28 | `npm run test:mod` | Resubmission from inside a prompt hook was refused by the host. The test timed out. 24 passed, 1 failed. | 1 |
| 29 | `npm run test:mod` | Corrected regression verifies late delivery preserves Stop and a new user prompt resumes input. 25 passed. | 0 |
| 30 | `npm run check` | 1,138 unit tests, both manifests and 25 mod tests passed. | 0 |
| 31 | `npm run lint:prose` | 4 wording flags in the design and report. | 1 |
| 32 | `npm run check` | Final base `6c54e4b`: 1,138 unit tests, both manifests and 25 mod tests passed. | 0 |
| 33 | `npm run lint:prose` | Final base `6c54e4b`: 71 files passed. | 0 |

The additional review initially inferred that a delayed automatic handoff could lift a newer Stop.
The runtime trace disproved that inference, and the reviewer withdrew it. The temporary origin guard,
re-entry catch and tracing were removed. Runs 18 through 28 preserve the unsuccessful tests and diagnostics;
run 29 checks the supported contract without claiming that an already submitted prompt can be retracted.

## Manual desktop check

After the release owner publishes and updates the plugin, confirm the installed `gitCommitSha`
and start a fresh Claude desktop Code session. The feature is still on an unmerged branch.

1. Enter `/sleight` and confirm the file field is empty. Click Replay file, then Record session.
   Both must request a filename and leave workspace files untouched.
2. After a small successful background Calculator task, enter `/sleight record task.json`.
   Confirm the pane field now shows that file, then click Replay file.
3. Click Stop during a replay. Confirm the log identifies the stopped step and warns that it may
   have sent input. Click Replay file again and confirm it stays stopped without reading the file.
4. Send a new user message to resume. For a replay with a missing selector, confirm its failed step
   and wait appear, and Claude receives the stop details exactly once after replay cleanup.
5. Click Refresh after a successful replay with a literal Calculator acquisition. Check its window
   before repeating any action whose outcome was uncertain.
