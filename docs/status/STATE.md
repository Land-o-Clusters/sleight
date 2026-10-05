# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-05, 0.7.0 release in progress)

Public: `Land-o-Clusters/sleight`. Latest release `v0.6.0`. The marketplace installs from the default
branch, so users installing now get `main`, not the tag. Installed on this Mac at user scope: 0.6.0
from the local directory marketplace.

This session (owner asleep, asked for the release, docs and testing):

- CI had been red on `main` since `b5f109c`: two tests hard-coded `/private/tmp` and one needed
  `swiftc`, neither on Linux. Fixed in `d9db1d9`, CI green.
- The `blocked_app` squash merge had cut CHANGELOG to 24 lines. 0.6.0 and earlier restored (`867a0a1`).
- The first benchmark attempt failed every task: the engine's helper wouldn't launch ("Sky Computer
  Use service startup request failed", launchd "Operation already in progress"). Doctor said "ok"
  all along. `launchctl remove` of the stale job fixed it without restarting ChatGPT. Doctor now
  fails on that and prints the command (`170fb21`). The aborted runs (3 tasks, all failed for this
  reason) get published with the full benchmark.
- Full benchmark (`--runs 3`, Sonnet 5.5 medium) running under the live lock. Then: 0.7.0 CHANGELOG
  (drafted in the working tree), bump, tag, release, update the installed plugin.

Codex threads (the owner runs them in worktrees under `~/Projects/sleight-wt/`; prompts in
`.dev/prompts/`, untracked, latest `round-4.md` and `backlog.md`): all reported work is merged. No
thread has open work. Every remote `codex/*` and `claude/blocked-apps` branch is squash-merged into
`main` except `codex/action-result-note`. Git counts them as ahead because squash merges leave no
shared commits. The 24 worktrees can be deleted with their branches once the owner closes those Codex threads.

Background jobs: the benchmark (`node bench/run.mjs`, holding `/tmp/sleight-live.lock`).

Market research (Codex, gpt-6.1-sol) is in `.dev/research/2026-10-04-competitors.md`, untracked.
Publishing it is the owner's call.

## Machine state outside the repo

- Weekly launchd job `com.landoclusters.sleight-watch` (Mondays 9:00, `scripts/watch.sh`). It saves
  the engine's API docs (`~/Library/Logs/sleight/engine-api-26.930.31730.md` is the baseline) and
  diffs them on an engine update. Remove with `npm run watch:remove`.
- `~/Library/Application Support/sleight/preapproved.json` lists Calculator at `high`, written by the
  owner for Codex 9's live check on 2026-10-04. Only builds from `main` read it. The installed 0.6.0
  ignores it.
- LCU 0.8.8 runtime-only at `~/.local/share/lcu`, registered only in `.dev/lcu-arm` (untracked).
  `.dev/py/python3` links Homebrew Python 3.14 for it.
- Homebrew: `vale`, `ffmpeg`, and the `codex` cask 0.160 (0.153 rejected gpt-6.1-sol).
  `~/.local/bin/claude` 2.1.289. The desktop app's Code tab bundles Claude Code 2.1.286 (checked
  2026-10-04), too old for the mod.
- `.dev/` (untracked): test CLI, `sleight-arm` and `lcu-arm` bench folders, `DragProbe.app`, the
  compiled `textedit-drag-fixture`, pseudo-terminal harnesses, research, prompts.
- Direct drag test scripts from 2026-10-05 live only in this session's scratchpad. To repeat: open a
  temp file with `open -g -a TextEdit`, run `.dev/textedit-drag-fixture <path> select-drag`, call
  `callLocalTool('drag', {app, from, to, windowId}, async () => true)` from `plugins/sleight/lib/launch.mjs`,
  then `<fixture> <path> read`. Use `select-drag`, never `select`: plain `select` drops in the title bar.

## Waiting on the owner

- Close the finished Codex threads, so their worktrees and branches can be deleted.

## Reading list

- `README.md`: how it works, known problems, benchmark, update watch.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
