# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-09 12:00 UTC, overnight run)

Overnight (owner asleep from about 04:25 UTC, 2026-10-09, said "keep going until I wake up", work the
whole ROADMAP without stopping). Amphetamine keeps the Mac awake, so don't add caffeinate. Live runs
are fine all night (owner away). Review Sol's rounds as they land.

Released: `v1.0.0` (`ca4d017`) at 04:33 UTC, `main` fast-forwarded to it, GitHub release made. The
owner's install is 1.0.0 at `ca4d017`. CI on `ca4d017` was still running at release time, so check it.
Gate evidence: the release pass passed 19/21 in 165 turns and 912 s at 2.59 s of model time per turn
(`docs/benchmarks/2026-10-09-release-1.0.0.json`). The Chess and simulator head-to-head went
chess-drag sleight 0/3, Codex 2/3, simulator-form 3/3 each
(`docs/benchmarks/2026-10-09-h2h-chess-simulator.json`). Every failure was where the model pressed
(below the pawn's head) or a simulator tap that missed. The engine drag through sleight moved the pawn
in 2 of 3 release-pass runs, so no regression. One sleight bug showed: `drag.js` ran past its 30 s
limit and returned only "Command failed".

Since 1.0.0, on `pane/auto-mode` (each merged from `fix/drag-chess`, 707/707 tests):
- `7783fa1`: an un-awaited failed action keeps the engine session (1.0.0 reset it 1/1, fixed 3/3
  live); `drag.js` says when it timed out and releases a stuck posted button, won't press after 20 s,
  scans once; a covered drag with no selected text refuses and points to `app.drag` (sleight's posts
  missed a covered Chess pawn 0/2 where the engine's drag moved it 1/1); the skill says press a 3D
  piece at its head, and the benchmark counts split acquisitions as engine time.
- `fc1a1d3`: replay (`sleight-mcp record` and `replay`, `docs/design/replay.md`). A 3-call Calculator
  run replayed in 5.5 s against 17 s and stopped safely when Calculator was in another state.
- `1eda908`: a call that meets a restarting helper is resent once (unit-tested only). A first-call
  hint in the js description didn't change behavior (8/12 still called `getState` first) and was
  reverted and published (`docs/benchmarks/2026-10-09-first-call-hint.json`).
- `39bf90f`: a stale element number Claude saw goes out as that element's `{ line }` when one line
  matches (unit-tested only).
- `08f69a7`: when a turn ends, an app sleight acted on that holds a keyboard filter tap is named once
  per session, through the mod (unit-tested, and the JXA tap list matched the Swift one live).
The 1.1.0 release pass started 11:57 UTC on `08f69a7` (`.dev/passes/pass-one.sh release-1.1.0`).
Measured and dropped: trimming the engine's first-call docs (about 8,100 tokens, an estimated 0.1 s
saved per run). The launch draft's 1.0 lines are filled. Its real-use line waits for Sol's suite.

Owner's plan after 1.0 (2026-10-09), run in order without check-ins: (1) the real-use suite (Sol),
then the Codex head-to-head on it; (2) the launch post, draft at `~/Desktop/sleight-launch/thread-1.0.md`
with [PENDING] lines to fill from (1) and the 1.0 pass, and (3) replay. The full plan is
`docs/status/ROADMAP.md`.

Sol (`codex/real-use-tasks`, `~/Projects/sleight-wt/real-use-tasks`, head `1731df9`, not running):
brief 5 (`.dev/prompts/sol-real-use-tasks-5.md`) round 5 stopped at 16/18 slots
(`docs/benchmarks/2026-10-08-real-use-tasks-5.md` on the branch). All 6 model trials passed
(helium-form 3/3, finder-files 3/3); the other 10 failed in setup before a model started (Safari's
File-menu lookup 3/3, Preview and TextEdit readiness 3/3 each). Two simulator-flow slots wait on
DeviceHub being quit, and it was not running at 03:40 UTC. sleight-arch reran its checks (754/754,
lint 0 flags) and a review confirmed brief 5's six fixes in the code, but found the real suite's
end-of-pass tail quits nothing, so a permission stop can leave a launched Device Hub open, and that
Safari setup recovery can close a window without an identity check. Brief 6
(`.dev/prompts/sol-real-use-tasks-6.md`, ready to paste) fixes those and the setup failures, then
qualifies the five tasks without the simulator. simulator-flow's 3 slots run with the 1.0 runs while
the owner is away. Brief 7 (`.dev/prompts/sol-real-use-tasks-7.md`, after brief 6) adds localhost
web pages of six kinds, Word, Excel and PowerPoint, and Mail navigation on a fixture mailbox
(owner, 2026-10-09). Brief 7b adds Mimestream on the owner's Gmail, opening and reading only, with
published results that leave out all mail content. Rebase onto
`pane/auto-mode` at merge. Safari, Preview, TextEdit, Calculator and
Helium were running at 03:40 UTC. Leave them running.

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

- `docs/status/ROADMAP.md`: everything we intend, in order. Any correction from the owner about the
  plan is written there in the same turn, and a question about the plan is answered from it whole.
- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
