# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-05, 0.12.0 released)

Public: `Land-o-Clusters/sleight`. Latest release `v0.12.0` (CI green). Installed on this Mac at user
scope: 0.12.0, which also stops a batch of clicks once an earlier click renumbered its target. Since 0.9.0 the relay sends Claude the guard's read as changed lines, matched by text, with
stale-number refusals. 0.11.0 reuses Claude's reads for the guard (CNN 242 to 332 ms per call down
to 10 to 14 ms) and has the launch README. A fresh-config install from GitHub worked. Launch files
are in `.dev/launch/` (untracked): `demo.mp4` and `demo.gif` (recorded by sleight-arch from window
captures only, no desktop), `thread.md`. Copies are in `~/Desktop/sleight-launch/` for the owner's social-media bot to post (owner, 2026-10-05).
Promotion starts next (owner, 2026-10-05).

0.8.0 adds the opt-in engine path for terminals and OpenAI's apps: the user sets the helper's own
`ComputerUseAllowForbiddenTargets` default, and sleight warns in the prompt and refuses settings
windows. The owner approved setting it on this Mac for the test, and it is still on
(`defaults delete -g ComputerUseAllowForbiddenTargets` turns it off; Codex loses the refusal too
while it's on). In the live check Terminal ran an echo in the background 2/2 and its settings window
was refused 1/1. For OpenAI's apps the engine shows its approval prompt instead of a refusal, but driving them is untested.

0.7.0 was released earlier today with the CI and doctor fixes, the restored CHANGELOG and the benchmark
arms moved out of the repo (release check 16/18). 0.8.0 runs: TextEdit hung 2/2 on Cmd+Shift+S (Duplicate) after
`setValue`. After a skill hint, TextEdit went 6/6.

Next, in order:

- Another session got "native pipe startup failed" three times in a row on 2026-10-05 while doctor
  passed. The helper quits after about 20 s idle, and 0.10.0 tells Claude to retry, then `js_reset`.
  Why it repeated is unknown.
- The relay reads an app hang (TextEdit's Duplicate deadlock) as a stuck helper and tells Claude to
  ask for a ChatGPT restart. It could check whether the app answers before saying so.
- Chess square estimates (chess-drag 1/3 in the 0.7.0 check).
- Re-register LCU in `~/Library/Caches/sleight-bench/lcu-arm` before any new comparison.

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
- `~/Library/Application Support/sleight/preapproved.json` lists Helium (`net.imput.helium` and
  `Helium`, `high`), added by sleight-arch on the owner's explicit order on 2026-10-05 for testing
  while away, to stay until the owner is back on Wednesday 2026-10-07. Backup of the earlier list
  in this session's scratchpad. It also lists Calculator at `high`, written by the
  owner for Codex 9's live check on 2026-10-04. The installed 0.9.0 reads it, so Calculator is
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

- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
