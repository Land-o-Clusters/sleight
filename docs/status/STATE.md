# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-08 03:20 UTC)

0.13.0: element IDs and labels (`app.click({ id: "Seven" })`). Refused calls 14 to 7 and turns 300
to 281 against the timing baseline (`docs/benchmarks/2026-10-07-{timing,element-ids}.json`); model
time per turn rose in that pass (1.96 to 2.59 s), so total time did too. Next in the owner's perf
push is batching guidance and smaller results. The model passes come after that, with Haiku 5.5 as
`claude-haiku-5-5`, Sonnet at low effort, and Opus. Sonnet stays the default driver. At least 3 of
the 5 drag failures on 2026-10-07 came from the owner's windows covering the target app.

0.12.2 released. The input lease's recovery advice repeated an invalid app name as a bare
assignment, and a session failed 20 of its first 22 calls. Now the advice works, and an engine
session restart is detected and explained (CHANGELOG). Reported by the owner from another thread
on 2026-10-07. Reproduced and verified live against Calculator.

New benchmark task `simulator-form` (owner's order, 2026-10-07). Safari in an iPhone simulator,
type a nonce, tap Submit, checked by what a local server received. 3/3 on iPhone 18 Pro, iOS 27.0,
Xcode 27's DeviceHub (replaces Simulator.app, and its approval prompt names "Device Hub"), median
39.6 s. The first pass failed 0/3 on that missing allowlist name. Both are published. The iOS 27.0
runtime (8 GB) was downloaded on the owner's OK.

0.12.1 (2026-10-06): the pane's picture fits the pane and stays under Claude Code's MCP output
limit. The launch pane shot is `~/Desktop/sleight-launch/sleight-pane.png`.

Public: `Land-o-Clusters/sleight`. Open PRs: none. Latest release `v0.12.1`, installed on this Mac
at user scope from the repo folder. Released on 2026-10-05: 0.7.0 through 0.12.0. Numbers are in
the CHANGELOG and `docs/benchmarks/2026-10-05-*`. `~/.claude.json` now marks
`~/Library/Caches/sleight-bench/sleight-arm` trusted (set for the interactive pane session).

Launch: licensing is fine (owner checked, 2026-10-05). The owner's Grok bot posts from
`~/Desktop/sleight-launch/`: `demo.mp4`/`demo.gif` (take 8 of 9, 16.6 s, made to the bot's brief),
`demo-v0.*` (first cut), `thread.md`, `sleight-version.txt`. The recorder is
`.dev/launch/rec/v2/` (`run.py`, `compose2.py`; per-window capture, Stickies in front). Codex could not
record it: a Notes automation prompt blocked it, and sleight-arch denied that prompt on the owner's
order.

Background jobs: none. No live lock held.

Next, in order (owner asked for a perf and Codex-parity push, 2026-10-07; first step not yet chosen):

- Measure where a run's time goes (model, tool, engine) from traces on benchmark runs.
- Let the stale-number guard accept clicks by stable AX identifier, so Calculator's renumbering after
  All Clear stops costing refused calls.
- Another session got "native pipe startup failed" three times in a row on 2026-10-05 while doctor
  passed. The helper quits after about 20 s idle, and 0.10.0 tells Claude to retry, then `js_reset`.
  Why it repeated is unknown.
- When an app hangs (TextEdit's save-lock deadlock, or the orphan Save panel window of 2026-10-06),
  the relay's message still blames the helper first. It could check whether the app answers before
  saying so.
- Check the pane in the desktop app's Code tab, now that it offers Claude Code 2.1.288. The owner
  has to type `/sleight` there.
- Review `codex/browser-enforcement` (Codex, 2026-10-04, unreviewed): browser calls keep the native
  guards unless the engine's reply confirms `browserUse`. Merge it or close it.
- Chess square estimates (chess-drag 1/3 in the 0.7.0 check).
- Re-register LCU in `~/Library/Caches/sleight-bench/lcu-arm` before any new comparison.

Codex worktrees: the 22 under `~/Projects/sleight-wt/` and their local branches were removed on the
owner's request (2026-10-06). Each branch matched its copy on GitHub, and the remote branches stay.
The 23 files that existed only in those worktrees (drag probe results, fixture binaries, three bench
results) are in `.dev/worktree-archive/`. Every remote `codex/*` and `claude/blocked-apps` branch is
squash-merged into `main` except `codex/action-result-note` and `codex/browser-enforcement`. The
second one is unreviewed (one commit, 9 files), and its worktree is Codex's own at
`~/.codex/worktrees/browser-enforcement/sleight`, left in place. Codex prompts are in `.dev/prompts/`.

Market research (Codex) is in `.dev/research/2026-10-04-competitors.md`, untracked.

## Machine state outside the repo

- Weekly launchd job `com.landoclusters.sleight-watch` (Mondays 9:00, `scripts/watch.sh`). It saves
  the engine's API docs (`~/Library/Logs/sleight/engine-api-26.930.51102.md` is the latest) and
  diffs them on an engine update. Remove with `npm run watch:remove`.
- `~/Library/Application Support/sleight/preapproved.json` lists Calculator (owner, 2026-10-04) and
  Helium (`net.imput.helium` and `Helium`, all `high`). Helium was added by sleight-arch on the
  owner's explicit order on 2026-10-05, to stay until the owner is back on Wednesday 2026-10-07; the
  list before it is `.dev/tools/preapproved.before-helium.json`. The installed sleight reads it, so
  both apps are approved without a prompt in every session.
- `ComputerUseAllowForbiddenTargets` is on (`defaults write -g`, owner-approved test, 2026-10-05).
  Terminals and OpenAI's apps go through the engine for every engine client, Codex included, until
  `defaults delete -g ComputerUseAllowForbiddenTargets`.
- `.dev/tools/`: probe and timing clients for sleight's launcher, the CNN trial, transcript
  dumpers, and `dialogs.swift` (lists permission dialogs on screen).
- LCU 0.8.8 runtime-only at `~/.local/share/lcu`, registered only in `.dev/lcu-arm` (untracked),
  which the benchmark now refuses because it's inside the repo.
  `.dev/py/python3` links Homebrew Python 3.14 for it.
- Homebrew: `vale`, `ffmpeg`, and the `codex` cask 0.160 (0.153 rejected gpt-6.1-sol).
  `~/.local/bin/claude` 2.1.289. The desktop app's Code tab bundles Claude Code 2.1.286 (checked
  2026-10-04), too old for the mod.
- `~/Library/Caches/sleight-bench/sleight-arm`: the benchmark's sleight arm folder.
- `.dev/` (untracked): test CLI, old `sleight-arm` and `lcu-arm` bench folders, `DragProbe.app`, the
  compiled `textedit-drag-fixture`, pseudo-terminal harnesses, research, prompts.
- Direct drag test: open a temp file with `open -g -a TextEdit`, run
  `.dev/textedit-drag-fixture <path> select-drag`, run `.dev/tools/drag-direct.mjs` with the from/to
  points and window id, then `<fixture> <path> read`. Use `select-drag`, never `select`: plain
  `select` drops in the title bar.

## Waiting on the owner

- Decide whether Helium stays on the pre-approved list and whether `ComputerUseAllowForbiddenTargets`
  stays on, when back on 2026-10-07.

## Reading list

- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
