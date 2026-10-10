# Waits, window identity and checked stop

Work on `codex/waits-targeting`, based on `origin/pane/auto-mode`, covers element waits,
window identity and checked stop. `compact-reads.mjs` is outside this work.

## Element waits

`waitFor` checks the window header from each full engine read. It requires exactly one matching
element. Duplicate matches, changed windows and read errors stop it. It returns the tree on
success and includes the last tree on timeout. The polling deadline is at most 10 s; an engine
read already dispatched must finish, so a hung read can exceed it. No read is abandoned.

The guard changes install this helper on acquired app handles and route its reads through
the existing timing function with phase `wait`. Each poll updates the guard's observation and
emits its tree, provided another action or read hasn't superseded it. Waits follow the default
guard's allowed window transitions, including Open panels this call opened. Document scope and
change review stay strict. The action guard itself is unchanged. The skill's new line changes
Claude's behavior. Affected-task benchmarking is pending with sleight-arch. Speed hasn't been measured.

## Checked stop

Interrupt can arrive during a call. It denies new work, cancels pending consent and waits up to
3 s for the calls to finish. A drained turn gets a bounded `turn_ended` request. The launcher then
closes its owned engine's input. If needed, it sends SIGTERM and SIGKILL, then waits for the
child's close event. It also collects owned native helpers and browser discovery. Shared native
services stay running.

Only after collection does it settle interrupted requests and release leases. It reads the lease
bank to verify that its tokens are gone. It then observes pointer button state through CoreGraphics
and scans enabled keyboard filter taps. A pressed button, remaining tap or failed scan prevents a
clear receipt. A missing process-close result also stays unconfirmed. A checked stop closes the
MCP connection after flushing its reply. Subsequent use requires reconnection and a fresh app read.

Mocked relay tests cover calls finishing during stop, calls cut off, delayed local targeting and
delayed post-read identity checks. The latter may not send a second reply after stop. An actual owned
Node fixture ignores EOF and SIGTERM and is collected with SIGKILL. No host input was posted.
The pointer and tap observations still need live qualification. They describe the instant checked,
not future input from shared services. The JavaScript guard remains a cooperative mistake guard.

## Runs

Window identity uses retained AX references, rather than position or a presumed engine window ID.
The selection regression projects a published untitled TextEdit tree from
`2026-10-04-input-lease-window-attempt.json` onto two native windows with equal headers. Neither
selection nor input may choose one from those headers. Native callback tests cover a replacement
window and a pending admission check, including acquisition and input in one call.

The test attempts below include failures. These are unit checks, with no app input.

| Attempt | Command | Result |
|---|---|---|
| 1 | `node --test tests/element-wait.test.mjs` | Exit 1, three expected failures before the helper existed |
| 2 | `node --test tests/element-wait.test.mjs tests/document-scope.test.mjs` | Exit 0, 19 passed |
| 3 | `npm run check` | Exit 1, sandbox denied fixture output creation and Unix sockets |
| 4 | `npm run lint:prose` | Exit 2, missing Vale styles |
| 5 | `vale sync` | Exit 2, sandbox denied style directory creation |
| 6 | `vale sync`, host access | Exit 0, pinned pack installed |
| 7 | `npm run lint:prose` | Exit 1, six prose flags corrected |
| 8 | `npm run lint:prose` | Exit 0, 70 files |
| 9 | `npm run check`, host access | Exit 1, 1140 passed, hover fixture compile exceeded 60 s |
| 10 | `npm run build:hover-fixture`, host access | Exit 0 |
| 11 | `node --test tests/window-identity.test.mjs` | Exit 1, missing module |
| 12 | Same command with a stub | Exit 1, two expected assertion failures |
| 13 | Wait, window identity, relay lease and selection tests | Exit 1, 77 passed, malformed test replacement identity |
| 14 | `npm run check`, host access | Exit 1, 1142 passed, eager helper load broke mocked JXA loader |
| 15 | Window identity, relay lease and selection tests | Exit 1, 77 passed, split reply assertion inspected only its first block |
| 16 | Native identity regressions | Exit 0, five passed |
| 17 | Footprint, identity, relay lease and selection tests | Exit 0, 93 passed |
| 18 | `npm run check`, host access | Exit 0, 1146 unit tests, two validations and 11 mod tests |
| 19 | `node --test tests/checked-stop.test.mjs` | Exit 0, three passed, including forced exit of an owned fake engine |
| 20 | `npm run lint:prose` | Exit 1, three prose flags corrected |
| 21 | `npm run lint:prose` | Exit 0, 70 files |
| 22 | Waits with late observation regression | Exit 1, three passed and one expected cache-race failure |
| 23 | Wait, document scope and guard read tests | Exit 0, 42 passed |
| 24 | Stop, wait and relay lease tests | Exit 0, 74 passed |
| 25 | Stop, wait, relay and input lease tests | Exit 1, 111 passed, panel test omitted the default mode option |
| 26 | Same tests with the corrected mode option | Exit 0, 112 passed |
| 27 | Relay lease and checked stop tests, including late identity completion | Exit 0, 75 passed |
| 28 | `npm run check`, host access | Exit 0, 1157 unit tests, two validations and 12 mod tests |
| 29 | `npm run lint:prose` | Exit 1, two prose flags corrected |
| 30 | `npm run lint:prose` | Exit 1, one parallel-verb flag corrected |
| 31 | `npm run lint:prose` | Exit 0, 70 files |
| 32 | Native relay and window identity tests while separating commits | Exit 0, 71 passed |
| 33 | `npm run lint:prose` | Exit 1, final validation wording flagged |
| 34 | Late document approval regression | Exit 1, expected duplicate-reply failure |
| 35 | Relay lease and checked stop tests | Exit 0, 76 passed |
| 36 | `npm run lint:prose` | Exit 1, validation summary still flagged |
| 37 | `npm run check`, host access | Exit 0, unit suite, both validations and 12 mod tests |
| 38 | `npm run lint:prose` | Exit 1, one negation flag corrected |
| 39 | `npm run lint:prose` | Exit 0, 70 files |

Independent review found a stale
wait observation, a missing native baseline on metadata-free reads, browser admission blocked by
native ambiguity, and a refused Open-panel wait. Their regressions pass. Stop review also found
late duplicate replies and skipped discovery collection. Both were corrected and reviewed again.
The final cancellation test also covers a document approval that returns after its request was
cancelled. The relay suppresses its duplicate reply.

The read-only inspector's unsupported `--help` argument returned exit 64 with
`CODEX_MACOS_INSPECT_APPROVAL_REQUIRED`. Its documented operations were read from the installed
gateway. No alternate inspector or app probe ran.

The live lock was already taken at initial inspection. No live check started.
