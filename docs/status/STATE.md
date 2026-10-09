# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-09 18:40 UTC)

The owner is away from the Mac. Their bar (ROADMAP track 3): lightning quick, quick under any load,
no noticeable load on the Mac, measured against Codex on the same engine. Other projects (Puddle,
SignalCraft) run timed tests here. Puddle's quiet window 1009m runs from about 18:35 UTC for up to
2 h: no sleight live or load runs until puddle arch says it closed.

Released: `v1.1.0` (`0b6a1c0`), `main` at `0b6a1c0`. Unreleased on `pane/auto-mode` (`2cf4394`,
pushed): full screen and Split View detection; the guard matching degraded reads (`7d63e48`) and no
longer trusting an empty inventory (`e66791a`); no read before keys, text, paste and coordinates
after a call's first action (`44700ee`, owner's call, `SLEIGHT_GUARD=careful` keeps it); one
long-lived app-health helper instead of an `osascript` per read (`818f7e7`); Astra's compactor fold
for degraded lines (`674502d`); the real-use suite with a Codex arm (`768cbcd`); per-run CPU
footprint in the benchmark (`2cf4394`). The guard change and the helper still need a live run.

Next, once Puddle's window closes:
- A live check of `44700ee` and `818f7e7` (`load-cost` click-then-keys, a full-screen note).
- The head-to-head, sleight against Codex, at the owner's normal load and with added load, with
  time, turns and CPU footprint per arm. Then cut what it shows.
- Office qualification after brief 10 and the owner's Excel click, then Mail and Mimestream with
  the owner watching.

Branches and worktrees:
- `pane/auto-mode` in `~/Projects/sleight`: the working branch. A release fast-forwards `main` to it.
- `codex/real-use-tasks` (`~/Projects/sleight-wt/real-use-tasks`, Sol): squash-merged through
  `b8f4b3f`. Sol works brief 10 there. Squash its next commits the same way.
- `arch/codex-real-arm` (`~/Projects/sleight-wt/codex-real`) and `codex/guard-speed`
  (`~/Projects/sleight-wt/guard-speed`): merged, safe to remove with their worktrees.
- `perf/screenshot-scale` (`1aa574b`, `~/Projects/sleight-wt/shots`): parked.
- `fix/drag-chess` and older `codex/*` worktrees: earlier rounds. Leave them.

Waiting on the owner: a click on "Start Using Excel" in Excel and brief 10 for Sol
(`.dev/prompts/sol-real-use-tasks-10.md`). Mail and Mimestream need them watching for about 10 minutes.
Qualification left fixture windows on their screen: about seven in Safari, two in Helium, six
Preview `Pages-*.pdf`, and Word and Excel running with fixture documents.

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

- Clicking "Start Using Excel" in Excel and pasting brief 10 to Sol.
- Watching the Mail and Mimestream tasks.
- The OpenAI key note is theirs to handle. Don't raise it again (owner, 2026-10-09).

## Reading list

- `docs/status/ROADMAP.md`: everything we intend, in order. Any correction from the owner about the
  plan is written there in the same turn, and a question about the plan is answered from it whole.
- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
