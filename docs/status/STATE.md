# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-05, 0.7.0 released)

Public: `Land-o-Clusters/sleight`. Latest release `v0.7.0` (`2bd3a00`, CI green), with GitHub release
notes from the CHANGELOG. The marketplace installs from the default branch, so users get `main`.
Installed on this Mac at user scope: 0.7.0 from the local directory marketplace (doctor ok).

Done this session, owner asleep:

- CI was red on `main` since `b5f109c` (Linux has no `/private/tmp` or `swiftc`). Fixed, green.
- The `blocked_app` squash merge had cut CHANGELOG to 24 lines. 0.6.0 and earlier restored.
- The helper wouldn't launch (launchd kept a quit helper's job, "Operation already in progress")
  while doctor said ok. `launchctl remove` fixed it without restarting ChatGPT. Doctor now fails on
  it and prints the command.
- Benchmark arm folders were inside this repo since 2026-10-03, so both arms loaded the repo's
  CLAUDE.md and project memory. They now live in `~/Library/Caches/sleight-bench/<arm>`, and
  `bench/run.mjs` refuses a folder inside a repo. The README says so for the LCU comparison.
- Release check 16/18 from the clean folder, every run published in
  `docs/benchmarks/2026-10-05-release-0.7.0.*`. chess-drag passed 1/3. In both failures Claude
  aimed at e5 (y ≈ 475) instead of e4 (y ≈ 545), an illegal move. All three clean text drags went foreground
  because this Claude window covers TextEdit on the second display.

Next, Chess square estimates are the weakest task. A skill hint or reading square positions would
help, though AX square coordinates are vertically reversed. The LCU arm needs re-registering in
`~/Library/Caches/sleight-bench/lcu-arm` before any new comparison.

Codex threads (the owner runs them in worktrees under `~/Projects/sleight-wt/`; prompts in
`.dev/prompts/`, untracked, latest `round-4.md` and `backlog.md`): all reported work is merged. No
thread has open work. Every remote `codex/*` and `claude/blocked-apps` branch is squash-merged into
`main` except `codex/action-result-note`. Git counts them as ahead because squash merges leave no
shared commits. The 24 worktrees can be deleted with their branches once the owner closes those Codex threads.

Background jobs: none.

Market research (Codex, gpt-6.1-sol) is in `.dev/research/2026-10-04-competitors.md`, untracked.
Publishing it is the owner's call.

## Machine state outside the repo

- Weekly launchd job `com.landoclusters.sleight-watch` (Mondays 9:00, `scripts/watch.sh`). It saves
  the engine's API docs (`~/Library/Logs/sleight/engine-api-26.930.31730.md` is the baseline) and
  diffs them on an engine update. Remove with `npm run watch:remove`.
- `~/Library/Application Support/sleight/preapproved.json` lists Calculator at `high`, written by the
  owner for Codex 9's live check on 2026-10-04. The installed 0.7.0 reads it, so Calculator is
  approved without a prompt in every session until the owner edits the file.
- LCU 0.8.8 runtime-only at `~/.local/share/lcu`, registered only in `.dev/lcu-arm` (untracked),
  which the benchmark now refuses because it's inside the repo.
  `.dev/py/python3` links Homebrew Python 3.14 for it.
- Homebrew: `vale`, `ffmpeg`, and the `codex` cask 0.160 (0.153 rejected gpt-6.1-sol).
  `~/.local/bin/claude` 2.1.289. The desktop app's Code tab bundles Claude Code 2.1.286 (checked
  2026-10-04), too old for the mod.
- `~/Library/Caches/sleight-bench/sleight-arm`: the benchmark's sleight arm folder.
- `.dev/` (untracked): test CLI, old `sleight-arm` and `lcu-arm` bench folders, `DragProbe.app`, the
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
