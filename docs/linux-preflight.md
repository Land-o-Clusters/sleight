# Linux preflight

Run this helper on the final integrated commit before a public push. Docker must be running
on the local host, with network access for `node:24` and npm. macOS and Linux callers use
the same Docker path. A macOS focused test pass does not qualify the Linux suite.

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node scripts/linux-preflight.mjs --run --json --commit FULL_SHA
```

Replace `FULL_SHA` with the full commit at HEAD. Use `--worktree PATH` for an explicit
source worktree. Execution requires `--run` and an exact commit. There is no passing dry
plan. The command returns the test failure status, or another nonzero status
when preparation, receipt validation or cleanup fails. It prints one JSON receipt to
stdout. Test output goes to stderr, so stdout can feed the release parser.

## Source and dependencies

The helper creates a private temporary Git repository and fetches only the requested
commit's shallow history through the local file transport. It verifies the source HEAD
and checkout HEAD. The prepared repository has its own objects, index and detached HEAD.
It has no remote or FETCH_HEAD naming the source. Host Git configuration, credentials,
hooks, uncommitted edits, untracked files and the host's `node_modules` symlink are absent.
Git uses an isolated home and disables global and system configuration during preparation.
The helper only reads the source worktree.

Docker receives a read-only bind mount of the prepared repository at `/source`. Node copies
it into the container's writable `/w`, including Git metadata. Inside Linux, the helper
requires `process.platform === "linux"`, the requested Git HEAD and a nonempty
`/usr/bin/git ls-files -z` result before running npm. Dependencies live in the container's
writable layer. No host dependency bank, home directory, credential store, Docker socket
or host environment variables are mounted or forwarded into the container.

Docker creates the container with `--init` to forward signals and reap orphaned child
processes. Process-exit assertions and cleanup checks remain required.

The container runs exactly `npm test` from the committed checkout, without installing packages,
matching public CI. It refuses a checkout containing `node_modules`. It uses argument arrays
and no shell. Git and npm use a fresh disposable directory as both `HOME` and
`CLAUDE_CONFIG_DIR` inside Linux. The inherited image home is replaced for these children.
The helper removes that configuration after the checks. The public-tree privacy test
continues to run with usable Git metadata.

The Word fixture tests use `/usr/bin/python3` and its standard `zipfile` module to build
their handwritten compressed archives independently of the production document writer.

## Receipt and cleanup

The exported `runLinuxPreflight({ worktree, commit, execute, signal })` is the producer.
`execute(command, args, options)` is the injectable process boundary. Production uses
`runOwnedCommand`, which retains its ChildProcess until `close`. A6 calls this producer
directly and awaits it, including cleanup. It does not put a synchronous subprocess
wrapper around Docker.

A success receipt has schema version 1 and includes:

- `platform: "linux"`, `command: ["npm", "test"]`, `executed: true`, `exitCode: 0`
  and `dependencyMode: "checkout-only"`.
- The exact `commit`, canonical source `worktree`, unique `runId`, Docker `containerId`
  and actual `imageId`. Keep the full receipt private because `worktree` is a host path.
- `trackedFiles` and npm's reported `counts`: tests, suites, pass, fail, cancelled,
  skipped and todo. Missing, inconsistent or empty counts fail. Failed, cancelled
  or todo tests prevent success. Explicitly skipped tests remain in the counts.
- `childCollected: true` and `cleanupConfirmed: true`.

`parseLinuxReceipt(text, { commit, worktree })` validates that complete contract. It
rejects another commit or source tree, a plan, a local Mac result and incomplete cleanup.
The container program produces its test receipt after npm exits. The outer producer
adds container identity and cleanup evidence. Failed runs retain available test counts
and statuses, and always return nonzero.

Each run uses a unique named container. The helper retains its Docker client, forwards
cancellation to that child and waits for collection. SIGINT, SIGTERM and the 20-minute
run deadline stop later work. Cleanup addresses only the owned container name with
`docker rm --force --volumes`, then requires a successful container-list query showing
that exact name absent. Cleanup has its own bounded commands and continues after an
abort. An uncollected child or unconfirmed container cleanup fails the run and retains
private staging, whose path goes to stderr. Review that retained bank before removal.

The source guard in `tests/test-path-portability.test.mjs` scans every file under `tests/`,
including fixtures and comments, for hardcoded macOS temporary and home roots. It has
no file exemptions. Use `os.tmpdir()` and register real allocations with the existing
temporary cleanup helper. Construct platform-specific adversarial data from components.

Offline tests exercise the real checkout and receipt producers with injected Docker/npm
process boundaries, plus the serialized container program. They do not establish Linux
execution, actual Docker cancellation or daemon cleanup. Those checks remain required
on the final integrated commit, with counts, image identity and cleanup evidence retained.
