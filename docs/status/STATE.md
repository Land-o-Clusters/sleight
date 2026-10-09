# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-09 01:30 UTC, releasing 0.16.0)

0.16.0 is the batch on `pane/auto-mode`: the desktop pane in Auto mode, the `await` check, pause
guards for the foreground drag, `hover` and `menu_bar`, `drag` reading screenshot pixels, the
`noWindowsAvailable` hint, the guard fix for lease-free clients, and the docs on ChatGPT's "Always
allow" list. The Accessibility text move is in the code but off (TextEdit save deadlock, see
known-problems). Release pass `docs/benchmarks/2026-10-09-release-0.16.0.json`: 20/21, textedit-drag
3/3, chess-drag 2/3 (a second untitled Chess window covered the game). Release steps: fast-forward
`main`, tag `v0.16.0`, GitHub release from the changelog, then update the owner's install.

Benchmark side, not in the plugin: the Codex arm (`bench/codex-arm.mjs`, `a8f2010`), dry runs only.
`~/.codex-bench` holds the owner's bench login (done 2026-10-08) and a config with only the engine
server. The owner allowed setting the engine's "Always allow" list to the benchmark apps during
passes with the Codex arm; the runner saves the list to `~/Library/Logs/sleight/` and restores it on
exit (a killed runner leaves it changed: restore from the newest `ComputerUseAppApprovals.before-*`).

Research in `.dev/research/`: the Codex head-to-head protocol and the TextEdit save lock (next
experiment: launch TextEdit with `-NSDocumentDebugSerialization YES
-NSDocumentSerializationLoggingDelay 3` and read AppKit's log of the task holding the lock; candidate
fix: post one Shift event after an Accessibility edit).

Next:

1. Next batch: per-window screenshot sizes for `drag` (3 of 13 Chess drags went unscaled); the TextEdit
   save-lock experiments, then turn the Accessibility move back on if one fix shows 0 hangs in 10;
   a Codex pilot (one calculator-click per arm), then the core-task head-to-head.
2. Owner's plan, step 3 (better). Sol's `codex/real-use-tasks` (`7420d18`, round two) completed 3 of 18
   trials, 1 passed. Cause found 2026-10-08: `selectSurfaces` turns on the engine's browser surface
   when it finds the browser extension (this Mac's Helium has it), so Claude drove Helium as a
   browser and hit browser-access requests. A raw engine probe with only the `computer` surface
   (`.dev/tools/helium-native-probe.mjs`) got only Helium's app approval and typed into the form (1/1).
   Brief for round three: `.dev/prompts/sol-real-use-tasks-3.md` (runner sets `SLEIGHT_SURFACES=computer`,
   Safari setup launches Safari, rerun 18 trials). The owner pastes it to Sol. Then review, merge, and
   the Codex head-to-head. Research (`.dev/research/2026-10-08-codex-head-to-head.md`): `codex exec`
   should load the same engine, but no headless run has used it yet. Headless Codex can't limit approvals to an
   app list except through the engine's "Always allow" file. A fair run needs (owner) a separate
   `CODEX_HOME=~/.codex-bench codex login` with only computer use enabled, and (owner) that file set
   to the benchmark apps for the run, with a backup. Codex must run with `--disable shell_tool`, or it
   can pass the checks without touching the apps.
3. Owner's plan, step 4, known problems. Done in 0.16.0: the `noWindowsAvailable` message, pause guards,
   drag coordinates. Open: (a) TextEdit's save lock after Accessibility text writes (research running);
   (b) Calculator's AX churn after launch; (c) `drag` refusing a fresh Chess window; (d) TextEdit's
   orphan Save Panel window; (e) `/sleight stop` in the desktop app; (h) "reading 'title'" from the
   relay for a test client (agent fixing it in a worktree). (f) done: the watch's baseline is now
   26.1002.52244. (g) inconclusive: a probe of `click({ key: "shift" })` and `pressKey(…, { durationMs })`
   on macOS (`.dev/tools/click-options-probe.mjs`) read the same selection whatever it did, so its
   readings can't be trusted. The engine documents both for Linux only. Then step 5, the 1.0 decision.

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
press. The watch's baseline was set to 26.1002.52244 by hand on 2026-10-08.

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
- Codex head-to-head setup. It needs a separate Codex login for the bench. The engine's "Always allow"
  file lists 6 apps (TextEdit among them, written 2026-07-26). Whether it may hold
  only the benchmark apps during runs is the owner's call.

## Reading list

- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
