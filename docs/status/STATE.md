# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-10 08:45 UTC, owner asleep: overnight run)

The owner went to bed at about 08:15 UTC and said to handle things overnight. Owner away means live
runs that can take the pointer are allowed (LAWS), once Puddle's window is closed.

The owner's bar (ROADMAP track 3): lightning quick under any load, no noticeable load on the Mac,
measured against Codex on the same engine. Engine 26.1007.21159 since 05:44 UTC: the API docs are
identical to 26.1002.52244 once sleight's skill is left out, and the watch's calculator-click
passed (08:19 UTC). The 42 A/B runs ran on it too. `/tmp/sleight-hold` is set since 08:19 UTC for
Puddle's window 1010b (R16 pairs, attribution, OCR, about 100 to 120 min from ~08:45 UTC); lift it
at puddle arch's CLOSE message. The live lock is free. No open PRs.

**Where work goes.** Work in progress is private between releases (owner, 2026-10-10, LAWS): this
repo has `remote.pushDefault private`, which sends every worktree's pushes to the private
`Land-o-Clusters/sleight-dev` (Actions off, since spending is the owner's), and a pre-push hook
refuses the public repo without `SLEIGHT_RELEASE_PUSH=1`. Public `origin/pane/auto-mode` stays at
`332e3ca`. The `codex/*` branches already public stay there (owner, 2026-10-10).

**Benchmark.** Claude arms run on the owner's API key, Haiku 5.5 at high, capped at $200 a month
(LAWS). About $0.80 is spent this month. Runs are priced from token counts.

Released: `v1.1.0` (`0b6a1c0`) on `main`. Unreleased on `pane/auto-mode`, all in `CHANGELOG.md`.
Landed today: replay from the desktop pane, `open_file` (owner's call, after TextEdit's Open panel
took focus 3 times in about 21 runs), footprint parity's guard setup and native probe filters,
the JXA count fix, the shared Swift module cache, and test files 4 at a time.

**Release gate (ROADMAP 3.5) not met.** Footprint at `6e21846`: sleight 45.8 CPU s of its own
against Codex 38.7 over six runs, while sleight was faster (154 s against 239 s). Footprint parity
(`4082ae9`) cut guard and probe CPU. The task-level head-to-head on it hasn't run.

**Sol branches.** Briefs in `.dev/prompts/` wait for the owner to paste:
`sol-waits-targeting-3.md` (equal-title refusal, `/sleight stop` exits the relay, cost unmeasured),
`sol-sim-savelock-2.md` (retry cap, simulator note opt-in), `sol-plugin-arm-3.md` (same stop rules
for both arms, evidence trims), `sol-routines-demo-2.md` was answered by `210423b` (reviewed: routines
can't run on this engine, since its `getApp` rejects `{ windowId }`; recorder gates done; not
merged), `sol-verified-results-3.md` (no round 3 pushed yet). In review: `codex/textedit-fixes`
`cc1d7e6` (round 3, rich move opt-in). Reviewed, to merge with a fix: `codex/review-receipts`
`65a641b` (a Shift or Option key with a printable key is kept verbatim: record it as text).

Next, in order:
1. At Puddle's CLOSE: lift the hold, run `npm run check`, and commit the staged
   `codex/real-use-tasks` squash with sleight-arch's launch-date and overlap fixes, then the engine
   docs capture that leaves out sleight's skill.
2. Merge `codex/review-receipts` with the Shift fix, and `codex/textedit-fixes` after its review.
3. Live, owner away: textedit-fixes trials (`bench/textedit-fixes.mjs`), the select-all probe
   (`bench/small-fixes-textedit.mjs --quick`), the TextEdit tasks with `open_file`, the 1.1.0 live
   checks, simulator-flow and the DeviceHub handoff, waits-targeting and plugin-arm live checks if
   their Sol rounds are pushed.
4. The footprint head-to-head on `4082ae9` or later: `--arm sleight,codex --tasks
   calculator-click,textedit-edit,textedit-save --runs 2`.
5. A full release pass with the owner away, reread README whole, release (LAWS). Recheck the README
   lines tied to a release: the pass result and the 13/21 and Chess 0/3 mentions. Add replay,
   `open_file` and other hosts to its roadmap checklist, and confirm the Claude Code minimums.

Read first: `docs/known-problems.md`, `docs/benchmark.md`, `docs/design/guard-reads.md`.

Branches and worktrees (`~/Projects/sleight-wt/<name>`):
- `pane/auto-mode` in `~/Projects/sleight`: the working branch. A release fast-forwards `main` to it
  and pushes `origin`.
- Merged, worktrees safe to remove: `replay-next`, `doctor-flow`, `doctor-preapproved`,
  `footprint-spawns`, `small-fixes`, `other-hosts`, `scoped-approvals`, `codex-real`, `guard-speed`.
- `codex/real-use-tasks` (`1a73515`, Sol): applied through `1a73515`. Its brief 12 is pending.
- `perf/screenshot-scale` (`1aa574b`, `shots`): parked.

## Machine state outside the repo

- Daily launchd job `com.landoclusters.sleight-watch` (9:00, `scripts/watch.sh`), daily since
  2026-10-10 on the owner's OK because a competitor hinted at an engine change; weekly with
  `npm run watch:install`. It saves
  the engine's API docs (`~/Library/Logs/sleight/engine-api-26.1002.52244.md` is the latest) and
  diffs them on an engine update. Remove with `npm run watch:remove`.
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
- The watch's baseline (`~/Library/Logs/sleight/watch-engine-version`) is 26.1002.52244, set by hand
  on 2026-10-08 after the diff was captured.
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
- Which of the unstarted briefs above to run.
- Left on their screen from 2026-10-09, Safari fixture windows, Helium, Preview `Pages-*.pdf`, Word
  and Excel fixture documents, a TextEdit "Untitled 6" in their iCloud TextEdit folder (check it only
  by exact content, never by browsing their files).
- The OpenAI key note is theirs to handle. Don't raise it again (owner, 2026-10-09).

## Reading list

- `docs/status/ROADMAP.md`: everything we intend, in order. Any correction from the owner about the
  plan is written there in the same turn, and a question about the plan is answered from it whole.
- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
