# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-08 17:55 UTC)

Checkout: `~/Projects/sleight` is on `main`, released as 0.13.5. The Sol thread holds the live lock
for its Chess trials.

- 0.13.5 is Astra's `codex/engine-time`, reproduced 25/25 and squash-merged. `getScreenshot()` reuses
  the engine's AX read, and the skill says to type contiguous text at once. Its pass ran 21/21 in 212
  turns and 877 s. Two calculator-click runs took 26 turns and 83 s of engine time while Calculator's
  AX tree kept changing after launch (known problems). Astra's finding: any read after input costs
  about 415 ms, however long the caller waits. Its proposal to skip the guard's checks between
  actions in a batch stays out (43.9 s of a 756 s pass, and it would send input to a dialog that
  opened mid-batch).
- `codex/reliability` (Sol 6.1, `38a8ded`) is reviewed, not merged. The hang diagnosis works (wrong
  "restart ChatGPT" advice 1/1 before, 0/6 after) and the benchmark waits for Chess to exit before
  relaunching. Its fresh-Chess drag trials were blocked on a leftover Chess game, which the owner
  says isn't theirs (2026-10-08). Merge after it reports, with one pass.
- Turns are the owner's priority now (native Codex computer use felt faster). In the 0.13.4 pass, 20
  of 155 tool calls loaded the skill and 16 acquired the app alone: about 2 overhead turns per run.
  sleight-arch is building, in this order: the skill's essentials in the `js` tool description (no
  Skill turn), the engine's first-call docs fetched by the relay at startup (no docs turn), then a
  design for acquiring and acting in one call, to show the owner before building it.
- Earlier on 2026-10-08: 0.13.2 to 0.13.4 (lease kept through guard stops, one-call Save As, the
  echoed-handle acquisition, guard reads cleared for every handle; `CHANGELOG.md`), and a four-model
  comparison on 0.13.2's code (`docs/benchmark.md`). The owner kept Sonnet 5.5 medium (LAWS).

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

Codex: `codex/guard-reads` is merged (0.13.4). `codex/browser-enforcement` (Codex, 2026-10-04) is
still unreviewed. Its worktree is Codex's own at `~/.codex/worktrees/browser-enforcement/sleight`.

Public: `Land-o-Clusters/sleight`, latest release `v0.13.3`, installed at user scope from the repo
folder. Open PRs: none. The first outside user (the owner's friend) runs his iOS simulator tests
through sleight and finds it faster than Maestro. `~/.claude.json` marks
`~/Library/Caches/sleight-bench/sleight-arm` trusted (set for the interactive pane session,
2026-10-06). Launch files for the owner's Grok bot are in `~/Desktop/sleight-launch/`, including
`sleight-pane.png` (2026-10-06). `sleight-version.txt` says how each was made.

Next, in order:

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
- `.dev/passes/`: the chained benchmark passes script and its logs.
- `~/Library/Caches/sleight-bench/sleight-arm`: the benchmark's sleight arm folder.
- `.dev/` (untracked): test CLI, old `sleight-arm` and `lcu-arm` bench folders, `DragProbe.app`, the
  compiled `textedit-drag-fixture`, pseudo-terminal harnesses, research, prompts.
- Direct drag test: open a temp file with `open -g -a TextEdit`, run
  `.dev/textedit-drag-fixture <path> select-drag`, run `.dev/tools/drag-direct.mjs` with the from/to
  points and window id, then `<fixture> <path> read`. Use `select-drag`, never `select`: plain
  `select` drops in the title bar.

## Waiting on the owner

Nothing.

## Reading list

- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
