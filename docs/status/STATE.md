# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-08 23:20 UTC, flushed before the owner's clear)

Released: `main` and `v0.15.2` at `2d2eb60`, CI green. No background jobs are running, and
`/tmp/sleight-live.lock` is free.

Checkout: `~/Projects/sleight` is on `pane/auto-mode` (`dc5a016` plus the STATE flush, pushed). It has
two unreleased changes on top of 0.15.2:

- `known/unawaited` (`49604cf`, pushed): the relay refuses an action written without `await` when more
  code follows it. 659/659 unit tests. Known-problems entries 5, 16, 21 and 32 updated.
- `pane/auto-mode`: the desktop pane. A `tool.check` hook lets Auto mode run the mod's own snapshot
  (matched by `next.origin.plugin === 'sleight'` and the exact snapshot code) and `turn_ended`
  (owner approved, LAWS); `/sleight` awaits `$.mcp.connect` before sending the prompt; the desktop
  image re-encodes until it's 16,000 base64 characters or less (51,135 was dropped, likely by Claude
  Code's MCP token limit); and a local `h` that shadowed JSX's `h` broke the drawing. 11/11 mod tests.
  `plugin.json` says `0.15.3-pane.2` so the owner's install picks it up: set it to 0.15.3 at release.

Next:

1. Ask the owner to check the desktop pane once more. In a new Code tab session in Auto mode,
   `/sleight open Calculator in the background and work out 12 × 12 by clicking its buttons`, should show
   Calculator's picture. The owner's install is `0.15.3-pane.2` (`installed_plugins.json`).
2. Run one pass on `pane/auto-mode` with a regular desktop showing (no full screen or Split View,
   LAWS), then release 0.15.3 and run `claude plugin marketplace update sleight` and
   `claude plugin update sleight@sleight` so the owner's install matches.
3. Benchmark runner: restart TextEdit between runs when only benchmark documents are open (a
   leftover "Untitled 6" kept a stale Save sheet alive), and record per run whether the task's app
   window is on the current Space.
4. Owner's plan, step 3 (better). Sol's `codex/real-use-tasks` (`7420d18`, round two) passed 1 of 18
   qualifying runs. Safari wasn't running; Helium failed twice because the engine's browser-access
   request can't be answered in `claude -p`, and sleight never pre-approves browser requests (LAWS).
   Decide how Helium runs headless (as a native app through the engine, or with the owner answering live), then finish
   qualification, review and merge, then the head-to-head with native Codex computer use.
5. Owner's plan, step 4: the rest of `docs/known-problems.md`, including the Accessibility text-move
   experiment for drags into covered windows, and a clearer message than `noWindowsAvailable` when
   an app is on another Space. Then step 5, the 1.0 decision with the owner.

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
`claude plugin update` (now `0.15.3-pane.2`). Open PRs: none. The first outside user (the owner's friend) runs his iOS simulator tests
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

- The desktop pane check on `0.15.3-pane.2` (Next, item 1).
- How Helium runs in the headless real-use suite (Next, item 4).
- Rotating the OpenAI API key kept in plain text in an iCloud TextEdit note (told 2026-10-08).

## Reading list

- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
