# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-10 05:40 UTC, Sol branches reviewed)

The owner's bar (ROADMAP track 3): lightning quick under any load, no noticeable load on the Mac,
measured against Codex on the same engine. Engine 26.1002.52244. The owner started every Sol brief
at 05:20 UTC, and their checks pushed load past 200. `/tmp/sleight-hold` was set from 06:15 to
07:02 UTC at Puddle's request, then lifted when its window was cancelled. The live lock is free. No
open PRs.

**Where work goes.** Work in progress is private between releases (owner, 2026-10-10, LAWS): this
repo has `remote.pushDefault private`, which sends every worktree's pushes to the private
`Land-o-Clusters/sleight-dev` (Actions off, since spending is the owner's). Public
`origin/pane/auto-mode` stays at `332e3ca` and gets pushes only at release.
The `codex/*` branches already on the public repo (pushed 02:18 to 03:25 UTC, and `0d24316` at
07:10) stay there: the owner said to leave them (2026-10-10).

**Other projects.** Puddle arch messages this session before each timed window; when it says HOLD,
create `/tmp/sleight-hold` (stops live probes, and `npm run check` waits on it since `890faed`),
remove it at CLOSE. No window is announced now. Memory `shared-mac-quiet-windows`.

Released: `v1.1.0` (`0b6a1c0`) on `main`. Unreleased on `pane/auto-mode` since then, all in
`CHANGELOG.md`: first-call batching by default with the end-the-call clause, windows a call opens
itself, the split read's reuse, the no-action header, replay with Claude taking over, other hosts
(Claude first), doctor reading an app (pre-approved list), per-site flow rules, the clipboard helper,
settings windows by AX metadata, footprint cuts (helper lanes, cached extension check, lease
database reuse), `docs/background.md`, the daily watch. Live-checked with Claude driving: 15/15 on
five default tasks at `7c8e357`, 6/6 on the TextEdit tasks at `05903fa`.

**Release gate (ROADMAP 3.5) not met.** Footprint at `6e21846` (2026-10-10 02:10 UTC): sleight 45.8
CPU s of its own against Codex 38.7 over six runs, while sleight was faster (154 s against 239 s,
35 turns against 59). Left: the engine's node process +3.3 (guard reads) and `osascript` +2.2.
Brief for it: `.dev/prompts/astra-footprint-parity.md` (Astra, deep perf). If a competing plugin is
released first, releasing on speed is the owner's call (ROADMAP track 6).

**Sol branches, reviewed 2026-10-10 05:30 UTC.** Merged: `codex/lease-close-tests` (`0125ca7`),
`codex/windows-research` (`33c4ddd`), `codex/replay-desktop` with sleight-arch's fix for the
full-read note after a pane replay. Sent back, briefs for the owner to paste to Sol:
- `codex/textedit-fixes` `72437b7` → `sol-textedit-fixes-2.md`: the rich move is on by default,
  writes the clipboard, never finished live, and a timed-out paste holds the clipboard lock.
- `codex/waits-targeting` `e3f5a0b` → `sol-waits-targeting-2.md`, because Esc runs the checked stop and
  exits the relay (traced by sleight-arch), and window identity needs sleight's own Accessibility.
- `codex/verified-results` `62207a6` → `sol-verified-results-3.md`: retains every tree (heap 4.4 to
  110.6 MB over 400 actions, reproduced by the reviewer), and the stale guard is off after a reset.
  Merges before waits-targeting. Both edit `relay.mjs`.
Verified-results and waits change what Claude reads, so they need Calculator, TextEdit, Chess and a
Safari form before release. Replay-desktop needs the owner's check of the pane buttons in the Code
tab.

**Briefs written, not known to be started** (`.dev/prompts/`): `sol-sim-savelock.md`,
`sol-lease-broker.md`, `sol-review-receipts.md`, `sol-routines-demo.md`, `sol-plugin-arm.md`,
`sol-real-use-tasks-12.md` (DeviceHub replaces its process at launch; simulator-flow failed setup at
03:30 UTC), `astra-footprint-parity.md`. Ask the owner which are running.

Next, in order:
0. When Puddle's window closes: lift the hold, run `npm run check` once, and commit (in this order)
   the replay merge with the full-read fix, the benchmark's API key mode and connector switch, the
   shared Swift module cache, and the `SLEIGHT_FIRST_CALL_BATCH=merge` wording. Then, in the
   background with TextEdit only, run `bench/small-fixes-textedit.mjs --quick` (the select-all
   question) and the merge A/B on textedit-edit and textedit-save, 12 runs a side, about $14. The
   plan is in `.dev/research/2026-10-10-merged-calls.md`. Chess and simulator-form wait for the
   owner to be away. Done through the commits (`8e9e201`). The A/B started 07:04 UTC
   (`.dev/passes/merge-ab.sh`, log `.dev/passes/merge-ab.log`), and the select-all run is blocked
   by its helper (ROADMAP track 2).
1. Review Sol's next rounds of the three branches above as they land, and merge them.
2. The 1.1.0 live checks (helper resend, stale-number remap, keyboard-tap notice) and
   simulator-flow, with the owner away: they can take the pointer or keyboard.
3. The footprint gap (Astra's branch, then rerun `--arm sleight,codex --tasks
   calculator-click,textedit-edit,textedit-save --runs 2`).
4. A full release pass with the owner away, reread README whole, release (LAWS). Push the public
   repo only then. README lines tied to a release (checked 2026-10-10): the pass result and the
   13/21 and Chess 0/3 head-to-head mentions (lines 93 to 95), the roadmap checklist (add replay,
   verified results, other hosts; Windows now has `docs/design/windows.md`), and whether the
   Claude Code minimums (2.1.275, and 2.1.287 for the pane) still hold. The replay section was
   tightened on 2026-10-10.

Read first: `docs/known-problems.md`, `docs/benchmark.md`, `docs/design/guard-reads.md`.

Branches and worktrees (`~/Projects/sleight-wt/<name>`):
- `pane/auto-mode` in `~/Projects/sleight`: the working branch. A release fast-forwards `main` to it
  and pushes `origin`.
- Merged, worktrees safe to remove: `replay-next`, `doctor-flow`, `doctor-preapproved`,
  `footprint-spawns`, `small-fixes`, `other-hosts`, `scoped-approvals`, `codex-real`, `guard-speed`.
- `codex/real-use-tasks` (`1a73515`, Sol): applied through `1a73515`. Its brief 12 is pending.
- `perf/screenshot-scale` (`1aa574b`, `shots`): parked.

## Machine state outside the repo

- Daily launchd job `com.landoclusters.sleight-watch` (9:00, `scripts/watch.sh`), daily since
  2026-10-10 on the owner's OK because a competitor hinted at an engine change; weekly with
  `npm run watch:install`. It saves
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
- `.dev/passes/`: the pass scripts (`pass-one.sh <name>` runs one full pass under `nohup`) and logs.
- `~/.codex-bench`: the Codex arm's home, with the owner's bench login (2026-10-08) and a config with
  only the engine server. During a pass with the Codex arm, the runner sets ChatGPT's "Always allow"
  list to the benchmark apps (owner's OK, 2026-10-09) and restores it on exit; a killed runner leaves
  it changed, so restore from the newest `~/Library/Logs/sleight/ComputerUseAppApprovals.before-*`.
  The list holds 6 apps of the owner's (TextEdit among them, written 2026-07-26).
- `~/Library/Caches/sleight-bench/keyboard-taps`: compiled from `bench/keyboard-taps.swift`, lists
  keyboard filter taps. The runner builds it if missing.
- The watch's baseline (`~/Library/Logs/sleight/watch-engine-version`) is 26.1002.52244, set by hand
  on 2026-10-08 after the diff was captured.
- `~/Library/Caches/sleight-bench/sleight-arm`: the benchmark's sleight arm folder.
- Scratch clients are gone after the clear. A relay probe: `bench/double-keys-client.mjs`
  (`probeClient`, `relay: true`, and `relayOptions: { changeReview: false, spaceProbe }` to match the
  launcher, whose change review is off by default while the library's is on).
- `.dev/` (untracked): test CLI, old `sleight-arm` and `lcu-arm` bench folders, `DragProbe.app`, the
  compiled `textedit-drag-fixture`, pseudo-terminal harnesses, research, prompts.
- Direct drag test: open a temp file with `open -g -a TextEdit`, run
  `.dev/textedit-drag-fixture <path> select-drag`, run `.dev/tools/drag-direct.mjs` with the from/to
  points and window id, then `<fixture> <path> read`. Use `select-drag`, never `select`: plain
  `select` drops in the title bar.

## Waiting on the owner

- OpenUsage's usage reads get 429s, and all 6 throttle starts since 2026-10-08 came 1 to 5 minutes
  after a `bench/run.mjs` run began (the owner's other agent, 2026-10-10). Claude Code's docs don't
  mention a usage call from `claude -p`. Benchmark arms now run with
  `ENABLE_CLAUDEAI_MCP_SERVERS=false` and on the owner's API key (LAWS), checked 2026-10-10 06:00 UTC:
  `/v1/models` answered 200, and a stopped `claude -p` reported `apiKeySource: ANTHROPIC_API_KEY`.
  OpenUsage's hourly retry passing after the next pass would confirm the cause.

- Watching the Mail and Mimestream tasks (about 10 minutes).
- Which of the unstarted briefs above to run.
- Left on their screen from 2026-10-09, Safari fixture windows, Helium, Preview `Pages-*.pdf`, Word
  and Excel fixture documents, a TextEdit "Untitled 6" in their iCloud TextEdit folder (check it only
  by exact content, never by browsing their files).
- The OpenAI key note is theirs to handle. Don't raise it again (owner, 2026-10-09).

## Reading list

- `docs/status/ROADMAP.md`: everything we intend, in order. Any correction from the owner about the
  plan is written there in the same turn, and a question about the plan is answered from it whole.
- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
