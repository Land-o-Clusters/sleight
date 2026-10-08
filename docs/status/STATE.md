# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-08 23:55 UTC, building 0.16.0)

Released: `main` and `v0.15.2` at `2d2eb60`, CI green. The owner's desktop pane check on
`0.15.3-pane.2` passed (screenshot, about 23:03 UTC), with Calculator's picture, 6 actions and the
status line. No pass is running, and `/tmp/sleight-live.lock` is free.

Owner's call (2026-10-08): batch several fixes and features per release, one full pass per release,
and only the affected tasks during development. So 0.15.3 became 0.16.0 and holds more.

Checkout: `~/Projects/sleight` is on `pane/auto-mode`. 0.16.0 so far, on top of 0.15.2:

- The relay refuses an action written without `await` when more code follows it (`49604cf`).
- The desktop pane works in Auto mode (`0bfc4e9`, `e14f0cd`, `dc5a016`). LAWS has the `tool.check` rule.
- Benchmark runner: closes a failed run's TextEdit documents between runs, and samples whether the
  task's app has a window on the current Space (`d7f7833`, live-tested).
- `drag` into a covered TextEdit window moves the text through Accessibility, with no pointer or focus
  change (1/1 live, Claude covering TextEdit). The foreground drag, now the last resort, waits for 2 s
  without input (up to 10 s) and stops on keys typed after it takes focus. 45/45 drag-window tests,
  670/670 in all. Uncommitted when this banner was written.
- Published: `covered-drags` (18/21; textedit-drag 0/3 because the owner's windows covered TextEdit
  and the foreground drag took their focus) and `await-stopped` (2/5).
- `plugin.json` still says `0.15.3-pane.2`. Set it to 0.16.0 at release. CHANGELOG still has a
  `PASS_LINE` placeholder.

Next:

1. Commit the drag change, then check textedit-drag 3 runs with TextEdit covered. Then more 0.16.0
   items from Next 3, then one full pass (best while the owner is away), release 0.16.0 and update
   the owner's install (`claude plugin marketplace update sleight`, `claude plugin update sleight@sleight`).
2. Owner's plan, step 3 (better). Sol's `codex/real-use-tasks` (`7420d18`, round two) completed 3 of 18
   trials, 1 passed (report in `~/Projects/sleight-wt/real-use-tasks/docs/benchmarks/`). Safari's setup
   failed 3/3 because Safari wasn't running (setup should launch it). Helium failed 2/3 because the
   engine's browser-access request can't be answered in `claude -p`, and sleight never pre-approves
   browser requests (LAWS). Owner agreed (2026-10-08): probe Helium as a native app through the engine,
   one live call with no model. If no browser request appears, Sol switches `helium-form` to that and
   adds the Safari launch; otherwise Helium leaves the qualifying suite with a known-problems entry.
   Then qualification, review, merge, and the head-to-head with native Codex computer use.
3. Owner's plan, step 4, the rest of `docs/known-problems.md`. First a clearer message than
   `noWindowsAvailable` when an app is on another Space. The input guard should also cover `hover` and
   the `menu_bar` fallback. Then step 5, the 1.0 decision with the owner.

Read first, published today: `docs/benchmark.md` (every pass since 0.13.1, with caveats),
`docs/known-problems.md` (Split View, the desktop pane, Calculator's AX churn after launch).

Owner's plan (2026-10-08), run in order without check-ins: (1) acquire-and-act, done in 0.15.0;
(2) faster, done: 0.15.2 took 123 turns against 195 on 0.13.4, 101 calls, none refused; (3) better:
the real-use suite, then the Codex head-to-head (the owner approved Codex usage for it). (4) Known
problems. (5) The 1.0 decision.

Engine update: the helper is now 26.1002.52244 (was 26.930.51102), found at boot on 2026-10-08. Its
API diff (`~/Library/Logs/sleight/engine-api-26.1002.52244.diff`, captured by hand because
`watch.sh` would run a benchmark task during the pass) adds `click(…, { key, durationMs })`
(modifiers held through the click, timed press) and `pressKey(key, { durationMs })`. The relay passes
`click` options through untouched. Open: whether the skill should document Shift/Cmd-click and long
press. `watch-engine-version` still says 26.930.51102, so Monday's watch will run its benchmark task.

Codex: `codex/guard-reads` (0.13.4), `codex/engine-time` (0.13.5) and `codex/reliability` (0.14.1) are
merged. Their worktrees in `~/Projects/sleight-wt/` can go once Codex is done with them.
`codex/real-use-tasks` (Sol) is open, see Next. Briefs are in `.dev/prompts/`.

Public: `Land-o-Clusters/sleight`, latest release `v0.15.2`. The owner's install is a
version-keyed copy in `~/.claude/plugins/cache/sleight/sleight/`, refreshed only by
`claude plugin update` (now `0.15.3-pane.2`). Open PRs: none. The first outside user (the owner's friend) runs their iOS simulator tests
through sleight and finds it faster than Maestro. `~/.claude.json` marks
`~/Library/Caches/sleight-bench/sleight-arm` trusted (set for the interactive pane session,
2026-10-06). Launch files for the owner's Grok bot are in `~/Desktop/sleight-launch/`, including
`sleight-pane.png` (2026-10-06). `sleight-version.txt` says how each was made.

Later:

- The engine's first-call docs are about 21,000 characters per session, cached after the first turn.
  Trimming them needs a measured case and care with OpenAI's safety guidance.
- "native pipe startup failed" three times in a row in one session on 2026-10-05. Cause unknown.
- Whether the skill should document the engine's Shift/Cmd-click and long press.
- Re-register LCU before any comparison with it.

Codex worktrees: `~/Projects/sleight-wt/` holds only `guard-reads` now; 22 finished ones were removed
on 2026-10-06. Their remote branches stay, and files only they had are in `.dev/worktree-archive/`. Codex
prompts are in `.dev/prompts/`, market research in `.dev/research/2026-10-04-competitors.md`.

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
- `.dev/passes/`: the chained benchmark passes script and its logs.
- `~/Library/Caches/sleight-bench/sleight-arm`: the benchmark's sleight arm folder.
- `.dev/` (untracked): test CLI, old `sleight-arm` and `lcu-arm` bench folders, `DragProbe.app`, the
  compiled `textedit-drag-fixture`, pseudo-terminal harnesses, research, prompts.
- Direct drag test: open a temp file with `open -g -a TextEdit`, run
  `.dev/textedit-drag-fixture <path> select-drag`, run `.dev/tools/drag-direct.mjs` with the from/to
  points and window id, then `<fixture> <path> read`. Use `select-drag`, never `select`: plain
  `select` drops in the title bar.

## Waiting on the owner

- Rotating the OpenAI API key kept in plain text in an iCloud TextEdit note (told 2026-10-08).

## Reading list

- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
