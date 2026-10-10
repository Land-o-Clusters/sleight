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

The live lock was already taken at initial inspection. No live check started.
