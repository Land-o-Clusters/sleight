# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-05, flushed before the owner's clear)

Public: `Land-o-Clusters/sleight`. `main` at `e381173`, CI green, clean tree, no open PRs, no
in-flight branches. Latest release `v0.12.0` (plugin code `b6638c2`), installed on this Mac at user
scope. Released on 2026-10-05: 0.7.0 through 0.12.0. The relay now sends the guard's read as changed
lines matched by text, refuses stale element numbers (at call start and inside a batch), reuses
Claude's reads for the guard, offers an opt-in engine path for terminals and OpenAI's apps, and the
README is rewritten for launch. Numbers are in the CHANGELOG and `docs/benchmarks/2026-10-05-*`.

Launch: licensing is fine (owner checked, 2026-10-05). The owner's Grok bot posts from
`~/Desktop/sleight-launch/`: `demo.mp4`/`demo.gif` (take 8 of 9, 16.6 s, made to the bot's brief),
`demo-v0.*` (first cut), `thread.md`, `sleight-version.txt`. The recorder is
`.dev/launch/rec/v2/` (`run.py`, `compose2.py`; per-window capture, Stickies in front). Codex could not
record it: a Notes automation prompt blocked it, and sleight-arch denied that prompt on the owner's
order.

Background jobs: none. No live lock held.

Next, in order:

- Another session got "native pipe startup failed" three times in a row on 2026-10-05 while doctor
  passed. The helper quits after about 20 s idle, and 0.10.0 tells Claude to retry, then `js_reset`.
  Why it repeated is unknown.
- When an app hangs (TextEdit's save-lock deadlock), the relay's message still blames the helper
  first. It could check whether the app answers before saying so.
- Chess square estimates (chess-drag 1/3 in the 0.7.0 check).
- Re-register LCU in `~/Library/Caches/sleight-bench/lcu-arm` before any new comparison.

Codex threads (worktrees under `~/Projects/sleight-wt/`, prompts in `.dev/prompts/`, untracked): no
open work. Every remote `codex/*` and `claude/blocked-apps` branch is squash-merged into `main` except
`codex/action-result-note`. The 24 worktrees can go with their branches once the owner closes those
threads.

Market research (Codex) is in `.dev/research/2026-10-04-competitors.md`, untracked.

## Machine state outside the repo

- Weekly launchd job `com.landoclusters.sleight-watch` (Mondays 9:00, `scripts/watch.sh`). It saves
  the engine's API docs (`~/Library/Logs/sleight/engine-api-26.930.31730.md` is the baseline) and
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

- Close the finished Codex threads, so their worktrees and branches can be deleted.
- Decide whether Helium stays on the pre-approved list and whether `ComputerUseAllowForbiddenTargets`
  stays on, when back on 2026-10-07.

## Reading list

- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
