# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-05, flushed before the owner's clear)

Public: `Land-o-Clusters/sleight`. `main` is at `7775ed7`, CI green, 531 unit tests. Latest release
`v0.6.0` (input leases). The marketplace installs from the default branch, so users installing now get
`main`, not the tag. Installed on this Mac at user scope: 0.6.0 from the local directory marketplace.

Merged to `main` since 0.6.0, unreleased (all squashed from Codex branches):

- Drag: it tries a background drag posted to the app's process before the foreground fallback. It
  also raises the chosen window and refuses unsafe drops. Lost text is reported, and TextEdit
  spacing repaired. `7775ed7` skips the background attempt when
  another app covers the drag points. Measured by sleight-arch on 2026-10-05, calling the drag tool
  directly on TextEdit: covered by the Claude window 0/3 background (all foreground, text right),
  uncovered 3/3 background. After the fix, covered drags went straight to foreground, 2/2 correct.
- Hover tool, pre-approved apps (`preapproved.json`), blocked_app (prompt is the opt-in; terminal
  commands shown every time), select_window, browser surface (on when the ChatGPT extension is
  connected; native guards stay on until the engine's `browserUse` reply confirms a browser call),
  engine-stall recovery, change review re-read fix (opt-in), clipboard preservation (opt-in),
  doubled-keys probe, flaky-test fixes.
- Not merged: `codex/action-result-note` (#3). Turns with and without its note were equal.

Next, as the owner asked: run the full benchmark right after this clear. Blocker: the headless
`claude` CLI the benchmark uses has an expired login ("OAuth session expired"). The owner logs in with
`~/.local/bin/claude` then `/login`. Then: `node bench/run.mjs --arm sleight --runs 3`, under the live
lock, checking every result against the transcripts. Chess drag is unverified by sleight-arch (Codex 6
reported 1/3 on stacked games, AX square coordinates reversed). Before the run, close leftover Chess
games and put TextEdit's window on the current desktop. If it holds up, write the 0.7.0 CHANGELOG (the
`Unreleased` section has only blocked_app's entry), bump, tag, GitHub release, update the installed
plugin with `claude plugin marketplace update sleight` and `claude plugin update sleight@sleight`.

Codex threads (the owner runs them in worktrees under `~/Projects/sleight-wt/`; prompts in
`.dev/prompts/`, untracked, latest `round-4.md` and `backlog.md`): all reported work is merged. No
thread has open work. Every remote `codex/*` and `claude/blocked-apps` branch is squash-merged into
`main` except `codex/action-result-note`. Git counts them as ahead because squash merges leave no
  shared commits. The 24
worktrees can be deleted with their branches once the owner closes those Codex threads.

Background jobs: none. An orphaned `node --test` runner from a timed-out check was stopped on
2026-10-05.

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

- Log the headless CLI back in (`~/.local/bin/claude`, then `/login`), so the benchmark can run.
- Close leftover Chess games before the benchmark.
- Close the finished Codex threads, so their worktrees and branches can be deleted.

## Reading list

- `README.md`: how it works, known problems, benchmark, update watch.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
