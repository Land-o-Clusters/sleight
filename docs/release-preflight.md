# Release preflight

Run from the release worktree on macOS or Linux. Docker is the default Linux runtime. The command
prints one JSON result and returns nonzero on any failure. Keep the private terms file
outside the repository as a nonempty JSON array of strings. Include the owner's username,
home path, full name, email addresses and other private terms in the notes. Terms and
matching lines stay out of the result.

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node scripts/release-preflight.mjs --tag v1.4.1 --private-terms /run/private/release-terms.json
```

Release mode requires an existing local tag at HEAD. The script reads that tag without
creating, moving, fetching or pushing it. It captures a clean tree and exact HEAD before
loading any release input, including private terms, documents and manifests. It checks
the tree and HEAD after document inspection and again after Linux testing, then checks
the tag again. Untracked files count as dirty. A nonzero command stops later steps.

Before tagging, use candidate mode:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node scripts/release-preflight.mjs --candidate 1.4.1 --private-terms /run/private/release-terms.json
```

On macOS with Colima installed, append `--linux-runtime colima` to either command. This
starts an owned VM through the Colima helper, runs the same exact-commit Linux producer,
then waits for container and VM cleanup. The helper keeps its 20-minute total budget.
A passing Linux receipt with failed VM teardown or an expired runtime budget fails A6.
`--linux-runtime docker` explicitly selects the default route. Other values are rejected
before source checks or commands run. Each flag takes one value and may appear only once.

Candidate mode skips tag lookup and always returns `releaseReady: false`. It accepts
`## 1.4.1 (unreleased)` or a dated release heading, with an optional preceding
`## Unreleased` or `## [Unreleased]` section. Both sections receive privacy and placeholder
checks. The numbered heading and every manifest must still agree on the candidate
version. Release mode requires the newest heading to have a real `YYYY-MM-DD` date.
Both modes reject duplicate headings for the requested version.

Run release mode again after the intended tag exists. `releaseReady: true` means these
preflight checks passed. The architect's full check, release pass, A/B, public CI and the
owner's publication decision retain their separate requirements.

## Plugin size

Before the release preflight, run `nice -n 20 node tools/characters/check.mjs` from the release worktree.
It checks all six built-in packs against the plugin's SHA-256 manifest and requires lossless VP8L sheets.
A character bank of 8,000,000 bytes or more (hash manifest included) fails the check. Record its per-pack bytes, total character bytes and
complete plugin bytes with the release evidence. The generator is included in the plugin at
`skills/make-character/tool/`. `tools/characters/` contains repository entry points and repository-only checks.
On macOS with the tested toolchain, also run `tests/character-rebuild.test.mjs`. It compares a fresh build's structure and alpha
with the committed packs, not their bytes, and skips with a reason on another toolchain.

## Checks

The preflight calls repaired A1's `inspectReleaseVersion({ root, expectedVersion, tag })`
directly. That inspector discovers production plugin and marketplace manifests, including
additional ones outside the six required paths. It checks marketplace entry versions,
local source containment and source manifests, and reads the same plugin version helper
used by doctor. Claude and Cursor entries require versions; Codex entries use their
local plugin manifest. The required host catalogs must each list sleight once. Inspector
errors produce a fixed failure code, without copying manifest values or private paths.

README and CHANGELOG receive full-file placeholder checks for TODO, TBD, FIXME, XXX,
CHANGEME, template versions, insertion markers and pending GB12, GB14 or Cursor comments.
There is no development override. The newest release notes receive private identity,
home path, email, common phone format and supplied-term checks. Findings contain only
`CHANGELOG.md` and line numbers. Review the notes for private details beyond those patterns.

The benchmark hub check runs before the history scan. It renders every page, chart, `explore.html` and the README's
generated blocks from `docs/results/data` in memory, with `node bench/results-hub.mjs --render-only --check`, and compares
the result with the files in the tree. A stale file fails with `hub` and `stale-output`, and the fix is
`node bench/results-hub.mjs --render-only` followed by a commit. A generator crash or a failed run fails with `hub` and `hub-error`. The generator must be tracked, like the other helpers.

The history base defaults to the local `origin/main`. Use `--history-base REF` to select
another local base. A missing base or one outside HEAD's ancestry fails. The existing
history scanner must return its exact zero-findings summary and exit 0 over the resolved
base-to-HEAD range. The result omits scanner output. That scanner checks its runtime home and
username, independently of the supplied notes terms. A generic Linux account does not
prove the owner's identity is absent from history; retain the owner-identity history
scan as a separate release requirement.

The Linux step calls the actual A5 `runLinuxPreflight` API with the captured HEAD and
source worktree. The Colima route calls `runColimaPreflight`, which runs the same producer
and handles VM cleanup. The history scanner and Linux helper must be tracked; selecting Colima
also requires its helper to be tracked. Docker runs a separate exact-commit
checkout with usable Git metadata, isolated dependencies and a fresh Claude configuration.
The complete receipt must pass A5's exported parser for that same commit and canonical
worktree. A failed install or test, absent counts, a plan, a Mac result or unconfirmed
cleanup fails. See [Linux preflight](linux-preflight.md) for the CLI and receipt fields.

A6 waits for A5's owned Docker child and container cleanup after cancellation, and for
VM cleanup when Colima is selected. Its CLI passes SIGINT and SIGTERM through an AbortSignal.
There is no synchronous helper wrapper
whose timeout could leave Docker uncollected. A6's successful result includes the tested
commit, counts and cleanup status while omitting the receipt's private host worktree path.

## Offline interfaces and qualification

`preflight(options)` accepts an injected `runner(request)` returning `{ status, stdout }`
and an optional document reader. Its operations are `status`, `head`, `tag`, `base`,
`ancestor`, `sources`, `history` and `linux`. The Linux request includes `head`.
Version inspection always uses the actual A1 API against the supplied root.

`createReviewedRunner(root, { execute, signal, linuxRuntime })` owns fixed Git reads, the history
scanner and the selected Linux runtime, defaulting to Docker. The shared process executor uses
argument arrays without a shell. Git/history calls use disposable Claude configurations and strip Git and Node
runtime overrides. Linux preparation uses its own isolated Git environment. Docker image
and dependency downloads require network access during actual qualification.

Offline tests run A6 through A1 and the actual A5 receipt producer/parser, replacing the
Docker/npm process boundary. Tests reject failed commands and receipts for another tree. Cancellation tests wait for
cleanup, and input-loading tests change the revision before the next HEAD check. A separate test prepares a real linked Git worktree
whose dependency symlink and dirty files never enter the snapshot. These results qualify
the offline interfaces only. Run the real Linux suite and Docker cancellation checks on
the final integrated commit before treating this preflight as release evidence.
