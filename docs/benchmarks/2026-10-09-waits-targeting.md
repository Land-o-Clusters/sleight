# Waits, window identity and checked stop

Work on `codex/waits-targeting`, based on `origin/pane/auto-mode`, covers element waits,
window identity and checked stop. `compact-reads.mjs` is outside this work.

## Element waits

`waitFor` checks the window header from each full engine read. It requires exactly one matching
element. Duplicate matches, changed windows and read errors stop it. It returns the tree on
success and includes the last tree on timeout. The polling deadline is at most 10 s; an engine
read already dispatched must finish, so a hung read can exceed it. No read is abandoned.

The only guard changes install this helper on acquired app handles and route its reads through
the existing timing function with phase `wait`. Each poll updates the guard's observation and
emits its tree. The skill's new line changes Claude's behavior. Affected-task benchmarking is
pending with sleight-arch. Speed hasn't been measured.

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

The live lock was already taken at initial inspection. No live check started.
