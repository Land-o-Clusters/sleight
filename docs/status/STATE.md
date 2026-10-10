# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-10 20:25 UTC, re-hydrated after the owner's clear)

Nothing of sleight-arch's is running, and the live lock is free. `pane/auto-mode` is pushed to
private. The waits live attempts from 16:11 to 16:14 UTC were left uncommitted. They're published
now in `docs/benchmarks/2026-10-10-waits-targeting-4.md`, and all failed setup. The Chess move
points in `bench/reliability-chess-points.json` are for a 1223 by 949 board, and a fresh Chess
opened at 667 by 532. The next try runs with `--inspect-chess`. STATE's Sol section was a round
behind and is corrected: every lane branch is merged. The test routine's launchd job
`com.landoclusters.sleight-routine-535e98589ef1a23ab711` is still installed and fires every 5 minutes and fails harmlessly
(the installed plugin is 1.1.0). `routine remove` waits in the owner's Terminal tab for `remove`. If
that tab is gone, run `plugins/sleight/bin/sleight-mcp routine remove 535e98589ef1a23ab711` in a
terminal and type `remove`.

Head-to-head at `d575dcf` (3 runs a task a side): sleight 313.3 s and 79 turns, Codex 340.2 s and 83,
9/9 each. sleight still loses calculator-click (24.3 s against 15.1 s, about 8 s a run of startup).
Shop tasks at `1421cf0`, 1 run each, all passed: helium-shop sleight 53 s and 19 turns, Codex 82 s
and 23; safari-shop sleight 95 s and 22 turns, Codex 84.2 s and 25. The CPU split puts sleight's own
processes at 0.25 to 0.29 s a run. The engine is about even, and the rest is the claude client and
the owner's plugins. Routines passed live (`docs/benchmarks/2026-10-10-routines-live.md`).

The 2026-10-10 lanes and turn fixes are merged (`git log` has the list), and no lane is out.

Next, in order:
1. The owner runs `zsh /Users/Shared/sleight-setup-probe.sh` as puddle-census. It writes its log to
   `/Users/Shared/sleight-setup-probe-puddle-census.log`. If it works, build `sleight-mcp setup`.
2. The calculator-click startup gap.
3. A quiet-box CPU run with `--clean-arms` and with the normal setup.
4. Live runs of the Electron and Firefox tasks, and the real-site shop smoke.
5. Owner-away runs (Chess, simulator, plugin-arm pair, the release pass, LCU), then the release
   (ROADMAP 5b).

**Where work goes.** Work in progress is private between releases (LAWS): `remote.pushDefault
private` sends pushes to `Land-o-Clusters/sleight-dev`, and a pre-push hook refuses the public repo
without `SLEIGHT_RELEASE_PUSH=1`. Public `origin/pane/auto-mode` stays at `332e3ca`. The `codex/*`
branches already public stay there (owner).

**Benchmark.** Claude arms run on the owner's API key, Haiku 5.5 at high, capped at $200 a month
(LAWS), priced from token counts. $2.58 is spent in October. Old runs move to
`~/Library/Caches/sleight-bench/runs-archive` before each pass. `--surfaces browser,computer` runs
the real suite with the extension browser API.

Released: `v1.1.0` (`0b6a1c0`) on `main`. Unreleased on `pane/auto-mode`, all in `CHANGELOG.md`.
Landed 2026-10-10: "Always allow" on app prompts (owner), `open_file` (owner), turn receipts
(opt-in), the rich TextEdit move (opt-in, not yet working live), footprint parity, the guard's
first-action reuse and echo-read, replay from the desktop pane, the JXA count fix.

**Release gate (ROADMAP 3.5) not met.** Latest head-to-head with Codex (2026-10-10 11:28 UTC,
`docs/benchmarks/2026-10-10-h2h-footprint-haiku-3.json`): 6/6 each, 190 s against 176 s, 44 turns
against 45, own CPU 58.4 s against 47.2 s. Guard reads were 23.3 s: 15.0 s on TextEdit's Save sheet
and 7.5 s before clicks in a Calculator batch. Pass `release-haiku-3`: 18/18 on the six
non-simulator tasks. simulator-form fails setup (below).

**Waiting on the owner:**
- Guard reads that could be skipped for speed, the owner's call: the read before Return after
  `setValue({ id })` (1.85 s a save), the read before a first action by ID or label (1.4 s), and
  reads before clicks by ID or label in a batch (about 3.5 s each Calculator run).
- Which browser has the ChatGPT extension, and allowing `127.0.0.1` there once. Then the
  browser-extension comparison can run (accessibility side 21/21 so far,
  `docs/benchmarks/2026-10-10-surface-ab.md`). Extension access to local pages is approved in LAWS.
- Trying "Always allow" in sleight's panel once (unit-tested only).
- Being away for the live runs in Next, step 2, and being at the Mac for Esc and `/sleight stop`.
- Keeping or reverting acquisition by bundle ID in routines and replay. It merged in `da78144`
  (bundle ID, then the window's exact title is confirmed, because this engine rejects
  `getApp({ windowId })`), and no record of the owner's OK for it exists.
- Deleting the benchmark's leftover "Untitled 6.txt" and "Untitled 9.txt" in the owner's iCloud
  TextEdit folder, from runs whose save failed (2026-10-10).

**Sol, Grok and GLM branches** (private remote): none open. Merged on 2026-10-10: sim-savelock
rounds 1 and 2 (`71f7e95`), routines-demo (`da78144`), real-use-tasks round 13 (`4aeec4e`),
electron-tasks, results-page, waits-targeting, plugin-arm, verified-results, footprint-parity,
real-use-tasks round 12, review-receipts, textedit-fixes, replay-desktop, lease-close-tests,
windows-research.

Next, in order:
1. With the owner away, rerun the waits live checks with `--inspect-chess`, which screenshots the
   board as it opened and waits for move points measured from that picture.
2. With the owner away, Chess and Safari-form with verified results, the waits live checks
   (`node bench/waits-targeting-live.mjs live --owner-away`), the paired plugin-arm Calculator run
   (`--arm mcp:sleight-plain,sleight --calculator-gate`, Calculator's window on the current Space),
   and sim-savelock's owner-away commands. With the owner at the Mac, Esc and `/sleight stop` in a
   real session.
3. The owner's read decisions, then the head-to-head again
   (`--arm sleight,codex --tasks calculator-click,textedit-edit,textedit-save --runs 2`).
4. A crowded Save or Open sheet: leave its browser rows out of reads (known problems).
5. simulator-form must pass before a release. Then a full release pass with the owner away once
   the gate is met. Recheck the README lines tied to a release: the pass result and the 13/21 and
   Chess 0/3 mentions. Add replay, `open_file` and other hosts to its roadmap checklist, and confirm
   the Claude Code minimums.

Read first: `docs/known-problems.md`, `docs/benchmark.md`, `docs/design/guard-reads.md`.

Branches and worktrees (`~/Projects/sleight-wt/<name>`):
- `pane/auto-mode` in `~/Projects/sleight`: the working branch. A release fast-forwards `main` to it
  and pushes `origin`.
- Merged, worktrees safe to remove: `replay-next`, `doctor-flow`, `doctor-preapproved`,
  `footprint-spawns`, `small-fixes`, `other-hosts`, `scoped-approvals`, `codex-real`, `guard-speed`,
  `replay-desktop`, `windows-research`, `textedit-fixes`, `review-receipts`, `footprint-parity`, `verified-results`, `waits-targeting`, `plugin-arm` (its stash is applied and committed).
- Merged too, worktrees safe to remove: `sim-savelock`, `routines-demo`, `real-use-tasks`.
- `perf/screenshot-scale` (`1aa574b`, `shots`): parked.

## Machine state outside the repo

- Daily launchd job `com.landoclusters.sleight-watch` (9:00, `scripts/watch.sh`), daily since
  2026-10-10 on the owner's OK because a competitor hinted at an engine change; weekly with
  `npm run watch:install`. It saves the engine's API docs, without sleight's skill since 2026-10-10
  (`~/Library/Logs/sleight/engine-api-26.1007.21159.md` is the latest), and diffs them on an engine
  update. Remove with `npm run watch:remove`.
- `~/Library/Application Support/sleight/preapproved.json` lists Calculator (owner, 2026-10-04) and
  Helium (`net.imput.helium` and `Helium`, all `high`). Helium was added on the owner's order on
  2026-10-05, and the owner kept it with no end date on 2026-10-08. The list before it is
  `.dev/tools/preapproved.before-helium.json`.
- `ComputerUseAllowForbiddenTargets` is on (`defaults write -g`, set by the owner 2026-10-05, kept on
  2026-10-08 so agents can drive terminals for tests). Terminals and OpenAI's apps go through the engine
  for every engine client, Codex included. Off: `defaults delete -g ComputerUseAllowForbiddenTargets`.
- `.dev/tools/`: probe and timing clients for sleight's launcher, the CNN trial, transcript
  dumpers, and `dialogs.swift` (lists permission dialogs on screen).
- LCU 0.8.8 runtime-only at `~/.local/share/lcu`, registered only in `.dev/lcu-arm` (untracked),
  which the benchmark now refuses because it's inside the repo.
  `.dev/py/python3` links Homebrew Python 3.14 for it.
- Homebrew: `vale`, `ffmpeg`, and the `codex` cask 0.160 (0.153 rejected gpt-6.1-sol).
  `~/.local/bin/claude` 2.1.289. The desktop app's Code tab offers Claude Code 2.1.288 (checked
  2026-10-06).
- Xcode 27 at `/Applications/Xcode.app` (xcode-select still points at the Command Line Tools, so
  `simctl` needs `DEVELOPER_DIR`; `bench/tasks.mjs` sets it). The iOS 27.0 simulator runtime (8 GB)
  was downloaded on the owner's OK, 2026-10-07. Xcode 27 shows simulators in DeviceHub, not
  Simulator.app. DeviceHub also lists the owner's own iPhone, so crop it out of any capture.
- `.dev/passes/`: the pass scripts (`pass-one.sh <name>` runs one full pass under `nohup`) and logs.
- `~/.codex-bench`: the Codex arm's home, with the owner's bench login (2026-10-08) and a config with
  only the engine server. During a pass with the Codex arm, the runner sets ChatGPT's "Always allow"
  list to the benchmark apps (owner's OK, 2026-10-09) and restores it on exit; a killed runner leaves
  it changed, so restore from the newest `~/Library/Logs/sleight/ComputerUseAppApprovals.before-*`.
  The list holds 6 apps of the owner's (TextEdit among them, written 2026-07-26).
- `~/Library/Caches/sleight-bench/keyboard-taps`: compiled from `bench/keyboard-taps.swift`, lists
  keyboard filter taps. The runner builds it if missing.
- The watch's baseline (`~/Library/Logs/sleight/watch-engine-version`) is 26.1007.21159 (2026-10-10).
- `~/.config/sleight-bench/anthropic-api-key` (0600): the owner's API key for benchmark runs
  (2026-10-10). Spend ledger: `~/Library/Logs/sleight/bench-api-spend.json`.
- `.git/hooks/pre-push` (shared by every worktree): refuses pushes to the public repo without
  `SLEIGHT_RELEASE_PUSH=1`.
- `~/Library/Caches/sleight-bench/runs-archive`: benchmark runs older than 6 hours, traces kept.
  `~/Library/Caches/sleight-bench/swift-module-cache`: the shared module cache for helper compiles.
- `.dev/passes/front-watch.sh`: logs every frontmost-app change during a pass.
- `~/Library/Caches/sleight-bench/sleight-arm`: the benchmark's sleight arm folder.
- Scratch clients are gone after the clear. A relay probe: `bench/double-keys-client.mjs`
  (`probeClient`, `relay: true`, and `relayOptions: { changeReview: false, spaceProbe }` to match the
  launcher, whose change review is off by default while the library's is on).
- `.dev/` (untracked): test CLI, old `sleight-arm` and `lcu-arm` bench folders, `DragProbe.app`, the
  compiled `textedit-drag-fixture`, pseudo-terminal harnesses, research, prompts.
- Direct drag test: open a temp file with `open -g -a TextEdit`, run
  `.dev/textedit-drag-fixture <path> select-drag`, run `.dev/tools/drag-direct.mjs` with the from/to
  points and window id, then `<fixture> <path> read`. Use `select-drag`, never `select`: plain
  `select` drops in the title bar.

## Waiting on the owner

- OpenUsage's usage reads get 429s, and all 6 throttle starts since 2026-10-08 came 1 to 5 minutes
  after a `bench/run.mjs` run began (the owner's other agent, 2026-10-10). Claude Code's docs don't
  mention a usage call from `claude -p`. Benchmark arms now run with
  `ENABLE_CLAUDEAI_MCP_SERVERS=false` and on the owner's API key (LAWS), checked 2026-10-10 06:00 UTC:
  `/v1/models` answered 200, and a stopped `claude -p` reported `apiKeySource: ANTHROPIC_API_KEY`.
  OpenUsage's hourly retry passing after the next pass would confirm the cause.

- Watching the Mail and Mimestream tasks (about 10 minutes).
- Safari fixture windows, Preview `Pages-*.pdf`, Word and Excel fixture documents were left on
  their screen on 2026-10-09. Check the iCloud TextEdit files only by exact content, never by browsing.
- The OpenAI key note is theirs to handle. Don't raise it again (owner, 2026-10-09).

## Reading list

- `docs/status/ROADMAP.md`: everything we intend, in order. Any correction from the owner about the
  plan is written there in the same turn, and a question about the plan is answered from it whole.
- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
