# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-09 14:55 UTC)

The owner is away from the Mac for a few hours from about 14:00 UTC, 2026-10-09, and asked the next
session to work through the roadmap. Live runs are fine while they're away (LAWS). Amphetamine keeps
the Mac awake, so don't add caffeinate. The Mac's load average was about 100 at 14:40 UTC from other
projects' Python processes, which slows Accessibility answers (see known-problems).

Released: `v1.1.0` (`0b6a1c0`, 2026-10-09 13:12 UTC), `main` at `0b6a1c0`, CI green, the owner's install
1.1.0 at `0b6a1c0`. Unreleased on `pane/auto-mode` (`bc223c1`, pushed): full screen and Split View
detection, checked live with a scratch full-screen fixture and published as `full-screen-first` and
`full-screen-every-read`. Also unreleased are the benchmark disallowing Skill and the published
screenshot A/B.

In flight. Sol finished brief 8 (`4323a41` on `codex/real-use-tasks`, pushed). sleight-arch reviews it,
then reruns real-use qualification with the owner away.

Branches and worktrees:
- `pane/auto-mode` in `~/Projects/sleight`: the working branch. A release fast-forwards `main` to it.
- `perf/screenshot-scale` (`1aa574b`, pushed, `~/Projects/sleight-wt/shots`): parked. 9/9 against
  1.1.0's 9/9 but 92 turns against 85 (`docs/benchmark.md`). Don't merge without a new reason.
- `fix/drag-chess` (`08f69a7`, `~/Projects/sleight-wt/drag-chess`): merged into `pane/auto-mode`, safe
  to remove with its worktree.
- `codex/real-use-tasks` (`4323a41`, pushed, `~/Projects/sleight-wt/real-use-tasks`, Sol, idle).
  Earlier qualification: helium-form, preview-pdf, finder-files and textedit-calculator 3/3 each;
  safari-form, helium-dense and word-edit blocked by harness problems that brief 8 addresses.
- Older `codex/*` worktrees (browser-enforcement, engine-time, guard-reads, reliability) are earlier
  rounds. Leave them.

Next, in order (ROADMAP tracks 2, 3 and 5):
- Review `4323a41`, then requalify the real suite with the owner away.
- A Codex arm for the real suite (`bench/codex-arm.mjs` refuses `--suite real` today), built on
  `codex/real-use-tasks` once it's merged.
- A cheaper window-identity check for guard reads on coordinate, key and text actions. The engine's
  inventory answers in 11 to 30 ms, against about 410 ms for a read after an action.
- The AX check's 0.5 s deadline misses on a loaded Mac and can call an app that answers in 0.3 s hung.
- Live checks of the three unit-tested 1.1.0 changes, then replay's next steps.

Waiting on the owner: watching the Mail and Mimestream tasks (about 10 minutes). Qualification left
about six blank Safari Start Page windows, two Helium fixture windows, six Preview `Pages-*.pdf`
windows and Word with an unsaved fixture document (Report-5bc037d2) on their screen. TextEdit was
relaunched by today's runs and has no windows. The scratch `FullScreenFixture` app is quit.

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

- Being at the Mac to watch the Mail and Mimestream tasks.
- The OpenAI key note is theirs to handle. Don't raise it again (owner, 2026-10-09).

## Reading list

- `docs/status/ROADMAP.md`: everything we intend, in order. Any correction from the owner about the
  plan is written there in the same turn, and a question about the plan is answered from it whole.
- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
