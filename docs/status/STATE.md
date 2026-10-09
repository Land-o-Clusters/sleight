# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-09 03:45 UTC, flushed before the owner's clear)

Released: `v0.16.0` (`fa23007`), `main` at `dcad210` (the release badge on top), CI green. The
owner's install is 0.16.0 at `9952faa`. sleight-arch's background jobs have all ended, the live lock
is free, and the working tree is clean with every commit pushed. There are no open PRs.

Checkout: `~/Projects/sleight` on `pane/auto-mode` at `03d9af7`, pushed. Unreleased on it, all with
unit tests and live checks, 688/688 tests:

- The Accessibility text move for covered TextEdit windows, settled with a Shift event posted to the
  app (`8947b12`): 10 edits and 10 `drag` moves saved with no hang, against 5 hangs in 8 without.
- Text moves in any app's text field try Accessibility first; Safari's web fields ignore the writes,
  so `drag` falls back there (`011aec4`).
- `drag` scales by its own window's screenshot (`2f3b512`) and names the window covering a point,
  flagging an untitled same-app window as a dialog (`a6c0632`).
- The guard reuses an acquisition's read for the next first action when the app's windows are
  unchanged (`03d9af7`): 11 to 30 ms instead of a full read (16.7 s once under load).
- In the benchmark, Claude arms run without Bash, Write, Edit or web tools, the simulator app quits
  after its runs, and a pass stops when a benchmark app still has a keyboard tap. There's a Codex arm.
- `main`'s badge commit is already merged into the branch (`01a6217`), so a release fast-forwards.

1.0. The owner approved 1.0.0 (2026-10-09) once these have run with the owner away from the Mac,
without a new failure that's sleight's fault: (1) the Chess and simulator head-to-head,
`node bench/run.mjs --arm sleight,codex --tasks chess-drag,simulator-form --runs 3`; (2) a release
pass, `node bench/run.mjs --arm sleight --runs 3`. Then set `plugin.json` to 1.0.0, turn CHANGELOG's
"Unreleased" into 1.0.0, drop "early" from the README status badge, update the LAWS line "sleight
launches at 0.x", reread the README whole (LAWS), fast-forward `main`, tag, GitHub release, and run
`claude plugin marketplace update sleight` and `claude plugin update sleight@sleight`. All four 1.0
conditions in LAWS are met (two engine updates, the friend's install from GitHub, the desktop pane's
picture, comparisons with LCU and Codex).

Head-to-head so far, Sonnet 5.5 against gpt-6.1-sol at medium. On Calculator and TextEdit sleight
passed 15/15 in 446 s and Codex 12/15 in 732 s, with Codex 0/3 on textedit-drag
(`docs/benchmarks/2026-10-09-h2h-background.json`). The earlier core run stopped at 19/42 when Device
Hub's keyboard tap stalled the owner's keyboard (`2026-10-09-h2h-core-stopped.json`).

Owner's plan after 1.0 (2026-10-09), run in order without check-ins: (1) the real-use suite (Sol),
then the Codex head-to-head on it; (2) the launch post, draft at `~/Desktop/sleight-launch/thread-1.0.md`
with [PENDING] lines to fill from (1) and the 1.0 pass; (3) replay: a successful run turned into a
script that replays through the engine with no model. Known-problems work fills the time the owner
is at the Mac. Left there: keeping a moved word's own formatting in rich text, `/sleight stop` in the
desktop app, TextEdit's orphan Save Panel window, the engine's 21,000-character first-call docs.

Sol (`codex/real-use-tasks`, `~/Projects/sleight-wt/real-use-tasks`, head `efafe9d`, not running):
working through brief 5 (`.dev/prompts/sol-real-use-tasks-5.md`). Runs so far: helium-form 3/3 (as a
native app with `SLEIGHT_SURFACES=computer`), finder-files 3/3, preview-pdf failing in fixture setup;
Safari, TextEdit with Calculator and simulator-flow not run. Before merging, review it against the
review in brief 5 (quit launched apps, keyboard-tap check for real runs, `REAL_APPS` out of the core
allowlist, recovery only through owned references, one failure doesn't stop the suite) and rebase it
onto `pane/auto-mode`. Safari has been running since Sol's setup launched it at 01:14 UTC. Leave it running.

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

- Stepping away from the Mac, so the Chess and simulator head-to-head and the 1.0 pass can run.
- Rotating the OpenAI API key kept in plain text in an iCloud TextEdit note (told 2026-10-08).

## Reading list

- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
