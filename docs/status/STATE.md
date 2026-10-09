# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-09 14:00 UTC, flushed before the owner's clear)

The owner is away from the Mac for a few hours from about 14:00 UTC, 2026-10-09, and asked the next
session to work through the roadmap. Live runs are fine while they're away (LAWS). Amphetamine keeps
the Mac awake, so don't add caffeinate. No background jobs are running, the live lock is free, there are
no open PRs, and the checkout is clean with every commit pushed.

Released: `v1.1.0` (`0b6a1c0`, 2026-10-09 13:12 UTC), `main` at `0b6a1c0`, CI green, the owner's install
1.1.0 at `0b6a1c0`. Its pass went 20/21 (`docs/benchmarks/2026-10-09-release-1.1.0.json`). `v1.0.0`
(`ca4d017`) was released at 04:33 UTC the same day. Unreleased on `pane/auto-mode` (`67ff71c`): the
benchmark disallows Skill too, the parked screenshot A/B is published, ROADMAP and STATE updates.

Branches and worktrees:
- `pane/auto-mode` in `~/Projects/sleight`: the working branch. A release fast-forwards `main` to it.
- `perf/screenshot-scale` (`1aa574b`, pushed, `~/Projects/sleight-wt/shots`): parked. 9/9 against
  1.1.0's 9/9 but 92 turns against 85 (`docs/benchmark.md`). Don't merge without a new reason.
- `fix/drag-chess` (`08f69a7`, `~/Projects/sleight-wt/drag-chess`): merged into `pane/auto-mode`, safe
  to remove with its worktree.
- `codex/real-use-tasks` (`3ac2a33`, pushed, `~/Projects/sleight-wt/real-use-tasks`, Sol, idle).
  Qualification sleight-arch ran with the owner away (results in that worktree's `bench/results/`):
  helium-form, preview-pdf, finder-files and textedit-calculator 3/3 each. safari-form failed in setup
  every time: `3ac2a33` (sleight-arch's) fixed the profile Start Page title check, then setup failed on
  the address field. helium-grid 1/2 (one real miss), helium-editor 1/1, helium-dense opened the right
  article and then a cleanup stop ended the suite, word-edit stopped on Word's own Replace All dialog.
  Brief 8 (`.dev/prompts/sol-real-use-tasks-8.md`) covers those, and the owner hasn't pasted it yet.
- Older `codex/*` worktrees (browser-enforcement, engine-time, guard-reads, reliability) are earlier
  rounds. Leave them.

Next, in order (ROADMAP tracks 2, 3 and 5):
- A Codex arm for the real suite (`bench/codex-arm.mjs` refuses `--suite real` today).
- Full screen and Split View detection.
- A cheaper window-identity check for guard reads on coordinate, key and text actions. The engine's
  inventory answers in 11 to 30 ms, against about 410 ms for a read after an action.
- Live checks of the three unit-tested 1.1.0 changes, then replay's next steps.
- Requalify the real suite after Sol finishes brief 8.

Waiting on the owner: pasting brief 8 to Sol, and watching the Mail and Mimestream tasks (about 10
minutes). Qualification left about six blank Safari Start Page windows and two Helium fixture
windows on their screen. Word is open with an unsaved fixture document (Report-5bc037d2).

Owner's plan after 1.0 (2026-10-09), run in order without check-ins: (1) the real-use suite, then the
Codex head-to-head on it, (2) the launch post (`~/Desktop/sleight-launch/thread-1.0.md`, where only
the real-use line is still [PENDING]), and (3) replay's next steps. The full plan is `docs/status/ROADMAP.md`.

Read first: `docs/known-problems.md` (grouped by area), `docs/benchmark.md` (every pass with caveats),
`.dev/research/` (the Codex head-to-head protocol, the TextEdit save lock).

## Machine state outside the repo

- Weekly launchd job `com.landoclusters.sleight-watch` (Mondays 9:00, `scripts/watch.sh`). It saves
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
- The weekly watch's baseline (`~/Library/Logs/sleight/watch-engine-version`) is 26.1002.52244, set by
  hand on 2026-10-08 after the diff was captured.
- `~/Library/Caches/sleight-bench/sleight-arm`: the benchmark's sleight arm folder.
- `.dev/` (untracked): test CLI, old `sleight-arm` and `lcu-arm` bench folders, `DragProbe.app`, the
  compiled `textedit-drag-fixture`, pseudo-terminal harnesses, research, prompts.
- Direct drag test: open a temp file with `open -g -a TextEdit`, run
  `.dev/textedit-drag-fixture <path> select-drag`, run `.dev/tools/drag-direct.mjs` with the from/to
  points and window id, then `<fixture> <path> read`. Use `select-drag`, never `select`: plain
  `select` drops in the title bar.

## Waiting on the owner

- Pasting brief 8 to Sol, and being at the Mac to watch the Mail and Mimestream tasks.
- The OpenAI key note is theirs to handle. Don't raise it again (owner, 2026-10-09).

## Reading list

- `docs/status/ROADMAP.md`: everything we intend, in order. Any correction from the owner about the
  plan is written there in the same turn, and a question about the plan is answered from it whole.
- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
