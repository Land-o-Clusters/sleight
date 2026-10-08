# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-08 03:40 UTC, sleight-arch rebooted after the owner's clear)

Checkout: `~/Projects/sleight` is on branch `perf/save-in-one-call`, which is now also `main`
(fast-forwarded) and released as 0.13.2: the relay keeps the input lease through guard stops, and the skill shows a
one-call Save As. Its Sonnet medium pass passed 20/21, 213 turns (from 260), 687 s (from 825), model
time per turn 2.05 s (from 1.81), textedit-save median 16 turns (from 27)
(`docs/benchmarks/2026-10-08-save-in-one-call.json`). The failure, chess-drag run 1, was the engine's
`noWindowsAvailable` on a fresh Chess window (`docs/known-problems.md`), not the branch's code. Switch
the checkout to `main` once the passes below finish. They read the plugin from this checkout.

Background job: `nohup .dev/passes/passes.sh`, started 2026-10-08T03:13:06Z, 3 runs per task per
pass. Sonnet medium is done (above). Haiku 5.5 started 03:26 UTC (`claude-haiku-5-5`, which Claude
Code 2.1.289 calls unrecognized, so its cost figures are suspect), then Sonnet low and Opus 5.5
medium, for the owner's model comparison. Each pass takes and releases `/tmp/sleight-live.lock`.
Progress: `.dev/passes/passes.log`, per-pass logs `.dev/passes/pass-*.log`. Publish each scrubbed as
`docs/benchmarks/2026-10-08-<model>-<effort>.json` with a note in `docs/benchmark.md`, then compare
pass rate, turns, model time per turn and total time.

Engine update: the helper is now 26.1002.52244 (was 26.930.51102), found at boot on 2026-10-08. Its
API diff (`~/Library/Logs/sleight/engine-api-26.1002.52244.diff`, captured by hand because
`watch.sh` would run a benchmark task during the pass) adds `click(…, { key, durationMs })`
(modifiers held through the click, timed press) and `pressKey(key, { durationMs })`. The relay passes
`click` options through untouched. Open: whether the skill should document Shift/Cmd-click and long
press. `watch-engine-version` still says 26.930.51102, so Monday's watch will run its benchmark task.

Owner's speed push (2026-10-07): make sleight fast. Sonnet stays the default driver. Timing per run
(model, engine, local tools, relay, Claude Code) is in the benchmark results since 2026-10-07; the
first pass was 65.4% model, 23.6% engine, 0.1% relay. Turns are the lever, and errors cost turns.
Released that day: 0.12.2 (lease recovery advice, engine session restarts), 0.12.3 (one copy per
screenshot), 0.13.0 (`app.click({ id })`/`{ label }`), 0.13.1 (errors 21.5% to 12.7% of calls). The
remaining error causes are in the 0.13.1 pass transcripts, and `docs/benchmark.md` has the history.

Codex: an Astra thread (gpt-6-astra, allowed for deep perf tuning only, LAWS) works on
`codex/guard-reads` in `~/Projects/sleight-wt/guard-reads`, from `1532ae9` (the owner pasted the
brief before its base was set, so it predates 0.13.1 and needs a rebase). Brief:
`.dev/prompts/astra-guard-reads.md` (make the guard's per-action full reads cheaper; six guarantees,
each with a test). Review and reproduce its numbers before merging. It takes the live lock for its
checks. `codex/browser-enforcement` (Codex, 2026-10-04) is still unreviewed; its worktree is Codex's
own at `~/.codex/worktrees/browser-enforcement/sleight`.

Public: `Land-o-Clusters/sleight`, latest release `v0.13.2`, installed at user scope from the repo
folder. Open PRs: none. The first outside user (the owner's friend) runs his iOS simulator tests
through sleight and finds it faster than Maestro. `~/.claude.json` marks
`~/Library/Caches/sleight-bench/sleight-arm` trusted (set for the interactive pane session,
2026-10-06). Launch files for the owner's Grok bot are in `~/Desktop/sleight-launch/`, including
`sleight-pane.png` (2026-10-06). `sleight-version.txt` says how each was made.

Next, in order:

- Finish the passes above: publish them, then compare the models on pass rate, turns, model time
  per turn and total time.
- Review the Astra branch when it reports.
- textedit-save and chess-drag are the slowest tasks (median 16 turns each on 2026-10-08). Trace
  their runs for the next cut.
- The engine's first-call docs are 56% of all result text (about 21,000 characters per session), but
  context is cached: a run re-reads about 668,000 cached tokens and writes about 1,500. Trimming
  them needs a measured case and care with OpenAI's safety guidance.
- `drag` once couldn't match a freshly launched Chess window to an accessibility window
  (`docs/known-problems.md`). Drag failures otherwise came from the owner's windows covering the app.
- When an app hangs, the relay's message still blames the helper first. It could check whether the
  app answers.
- "native pipe startup failed" three times in a row in one session on 2026-10-05. The cause is unknown.
- Check the pane in the desktop app's Code tab (it offers Claude Code 2.1.288). The owner types
  `/sleight` there.
- Review `codex/browser-enforcement`. Chess square estimates. Re-register LCU before any comparison.

Codex worktrees: `~/Projects/sleight-wt/` holds only `guard-reads` now; 22 finished ones were removed
on 2026-10-06. Their remote branches stay, and files only they had are in `.dev/worktree-archive/`. Codex
prompts are in `.dev/prompts/`, market research in `.dev/research/2026-10-04-competitors.md`.

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
  `~/.local/bin/claude` 2.1.289. The desktop app's Code tab offers Claude Code 2.1.288 (checked
  2026-10-06).
- Xcode 27 at `/Applications/Xcode.app` (xcode-select still points at the Command Line Tools, so
  `simctl` needs `DEVELOPER_DIR`; `bench/tasks.mjs` sets it). The iOS 27.0 simulator runtime (8 GB)
  was downloaded on the owner's OK, 2026-10-07. Xcode 27 shows simulators in DeviceHub, not
  Simulator.app. DeviceHub also lists the owner's own iPhone, so crop it out of any capture.
- `.dev/passes/`: the chained benchmark passes script and its logs.
- `~/Library/Caches/sleight-bench/sleight-arm`: the benchmark's sleight arm folder.
- `.dev/` (untracked): test CLI, old `sleight-arm` and `lcu-arm` bench folders, `DragProbe.app`, the
  compiled `textedit-drag-fixture`, pseudo-terminal harnesses, research, prompts.
- Direct drag test: open a temp file with `open -g -a TextEdit`, run
  `.dev/textedit-drag-fixture <path> select-drag`, run `.dev/tools/drag-direct.mjs` with the from/to
  points and window id, then `<fixture> <path> read`. Use `select-drag`, never `select`: plain
  `select` drops in the title bar.

## Waiting on the owner

- Decide whether Helium stays on the pre-approved list and whether `ComputerUseAllowForbiddenTargets`
  stays on. Both were due on 2026-10-07 and haven't been asked yet. Ask.

## Reading list

- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
