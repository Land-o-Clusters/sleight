# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-09 21:40 UTC, flushed before the owner's clear)

The owner is away from the Mac and working from their phone. Their bar (ROADMAP track 3, 2026-10-09):
lightning quick, quick under any load, no noticeable load on the Mac, measured against Codex on the
same engine. Nothing is running and the live lock is free. The checkout is clean with every commit
pushed, and there are no open PRs.

**Before any live run, ask puddle arch.** Puddle's window 1009n (render and scroll-FPS timing in a real
app window) started about 21:15 UTC on 2026-10-09 and should close about 22:00 to 22:10 UTC. Its end
notice goes to the previous sleight session, so a fresh one must ask: `SendMessage` to
`uds:/tmp/cc-socks/9177.sock` (from-name "puddle arch"). No app driving during a window. Ask before
any run that adds load (memory `shared-mac-quiet-windows`).

Released: `v1.1.0` (`0b6a1c0`, 2026-10-09), on `main`. Unreleased on `pane/auto-mode` at `874a280`:
- Live-checked: full screen and Split View detection; one app-health helper per session
  (`818f7e7`, `025460d`); the guard's read skipped after typing, pasting or a plain key (`44700ee`,
  `db45c94`, owner's call); the reuse check that never checked now reads (`e66791a`); degraded reads
  under load (`7d63e48`, `674502d`); Sol's real-use suite through brief 11 (`874a280`) and the Codex
  arm for it (`768cbcd`); per-run CPU footprint (`2cf4394`, `2c30446`).
- Unit-tested only, from a study of the slowest head-to-head runs. A guard stop includes the current
  window (`94db208`); `drag` refuses an uncoverable drag before scanning (`94db208`); the first action
  checks its numbers against what Claude last saw, and Claude's read stands in only when it took over
  2 s (`f76ee76`); labels match settable fields and menu items named alone (`acf4b8d`); a note on
  closing an open menu (`202b184`, changes what Claude does). Off by default, an experiment:
  `SLEIGHT_FIRST_CALL_BATCH=1` (`6cd41ba`).

Head-to-head (published in `docs/benchmark.md`): at normal load sleight 20/21 in 904 s against Codex
16/21 in 1,292 s on the default tasks, and 12/12 in 396 s against 11/11 in 429 s on six real-use
tasks. Under 20 CPU workers (9 runs, stopped early) both timed out on Calculator, and sleight's
reads before clicks by ID cost tens of seconds each.

Next, in order, after Puddle's window:
1. Live checks: `performSecondaryAction(0, "Cancel")` closes an open menu at element 0 (Calculator,
   `.dev`-style relay client), and a guard stop shows its tree.
2. Office qualification: `node bench/run.mjs --suite real --arm sleight --owner-away --runs 1 --tasks
   excel-edit,powerpoint-edit`. Word passed 1/1 at `6f88fb3`.
3. CPU footprint rerun with `2c30446` (Codex's engine now counts): calculator-click, textedit-edit,
   textedit-save, `--arm sleight,codex --runs 2`.
4. Batching A/B: sleight only, textedit-save, textedit-edit, calculator-menu, chess-drag, 3 runs each,
   with `SLEIGHT_FIRST_CALL_BATCH` unset, then `=1`. Compare turns.
5. A full release pass with the owner away, then reread README whole and release (LAWS).

Branches and worktrees:
- `pane/auto-mode` in `~/Projects/sleight`: the working branch. A release fast-forwards `main` to it.
- `codex/real-use-tasks` (`1a73515`, `~/Projects/sleight-wt/real-use-tasks`, Sol, idle): applied
  through `1a73515`. Apply Sol's next commits as a diff the same way.
- Merged, safe to remove with their worktrees: `arch/codex-real-arm` (`~/Projects/sleight-wt/codex-real`),
  `codex/guard-speed` (`~/Projects/sleight-wt/guard-speed`), `fix/drag-chess`.
- `perf/screenshot-scale` (`1aa574b`, `~/Projects/sleight-wt/shots`): parked. Older `codex/*`
  worktrees: earlier rounds. Leave them.
- Proposed, not started: a session card "Replay: steps that wait for the app" (task `task_3df10eb3`).

Waiting on the owner: watching Mail and Mimestream (about 10 minutes). Left on their screen: about
seven Safari fixture windows, two Helium, six Preview `Pages-*.pdf`, Word and Excel with fixture
documents, and a TextEdit "Untitled 6" in their iCloud TextEdit folder, probably a benchmark
leftover (check it only by exact content, never by browsing their files).

Owner's plan after 1.0 (2026-10-09), run in order without check-ins: (1) the real-use pass and the
Codex head-to-head on it (done at normal load; see Next), (2) the launch post
(`~/Desktop/sleight-launch/thread-1.0.md`, whose real-use line is still [PENDING]), and (3) replay's
next steps. The full plan is `docs/status/ROADMAP.md`.

Read first: `docs/known-problems.md`, `docs/benchmark.md`, `docs/design/guard-reads.md`.

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
- Scratch clients from 2026-10-09, in the session's scratchpad (gone after the clear): rebuild a
  relay client with `bench/double-keys-client.mjs` (`probeClient`, `relay: true`), and a full-screen
  fixture with a small Swift app calling `toggleFullScreen` (see the 2026-10-09 notes in
  `docs/benchmark.md`).
- `.dev/` (untracked): test CLI, old `sleight-arm` and `lcu-arm` bench folders, `DragProbe.app`, the
  compiled `textedit-drag-fixture`, pseudo-terminal harnesses, research, prompts.
- Direct drag test: open a temp file with `open -g -a TextEdit`, run
  `.dev/textedit-drag-fixture <path> select-drag`, run `.dev/tools/drag-direct.mjs` with the from/to
  points and window id, then `<fixture> <path> read`. Use `select-drag`, never `select`: plain
  `select` drops in the title bar.

## Waiting on the owner

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
