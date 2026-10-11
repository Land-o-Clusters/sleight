# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-11 03:55 UTC, flushed before the owner's clear)

`pane/auto-mode` is at `4ee20df` plus this flush, pushed to private (`Land-o-Clusters/sleight-dev`),
nothing uncommitted. `npm run check` 1,744 tests. Merged on 2026-10-11, each reviewed and squashed:
icloud-textedit, panel-busy, chat-crash, chess-points, savelock-delivery, livechecks,
saveclose-research, shop-check, release-docs, richmove-format, savelock-engine, savesheet-recipe,
sim-readiness, speed-research, iphone-settle, richmove-paste, sim-scale-note, selectall-check (git log
has each). Not merged, on purpose: `codex/richmove-placement` (my brief misread the evidence).

**Running at the clear (survives it):** the first-call A/B, `nohup .dev/passes/ab-firstcall-0611.sh`
(pid 45717, started 03:47 UTC). It alternates default and `SLEIGHT_FIRST_CALL_BATCH=app` for 2 rounds, each
calculator-click, textedit-edit and textedit-save x2, `SLEIGHT_TRACE_CODE=1`, on the API key,
background only. Progress and results files are in `.dev/passes/ab-firstcall.log`, which ends with `done`.
Then compare per arm from the transcripts in
`~/Library/Caches/sleight-bench/claude-config/projects/`: share of runs whose first `js` call is a
bare `await cua.getState()` (50 of 80 recent runs before), turns, model time per turn, total time,
passes. If `app` wins with every run passing, make it the default with no opt-out (owner, 2026-10-11)
and drop the variant. The textedit-save runs also show whether Claude follows the save-sheet note
(`49356a7`): the share of runs where Go to Folder through the final Return share one call (0 of 3
before). The A/B is also the OpenUsage check below. An OpenUsage log watcher and the A/B waiter died
at the clear. Nothing else of sleight-arch's runs, and the live lock and hold are free.

**Lanes out** (each pushes `codex/<name>` to private and doesn't merge; briefs in `.dev/prompts/`;
the owner gets every lane as one paste-ready prompt with the model named, in a fresh chat):
- Grok: lease-select (Best Buy's lease refusals and the input lease refusing browser-tab handles).
  Relay core: review closely. Last lane before the away sitting.
- GLM: owner-present-mail (Mail, Mimestream and the chat tasks require `--owner-present`, not
  `--owner-away`, per LAWS 2026-10-11).
- Codex, when its quota resets: lease-broker and unsaved-review (ROADMAP 6), prompts in
  `.dev/prompts/lane-lease-broker.md` and `lane-unsaved-review.md` (also sent in chat).

Results that matter for the release gate (ROADMAP 3.5, 5b.1): speed-research found the clean-arms CPU
gap to Codex (51.8 s against 42.8 s) was 8.6 s from two failed textedit-save runs, and the seven runs
both arms passed differ by 0.4 s. Those failures were iCloud leftovers, fixed (`b09b792`), and
textedit-save then passed 3/3 twice. So the gate may be met. The away sitting's head-to-head decides.
The next lever is turns (model time is two thirds of a run): the first-call A/B and the save-sheet
note. `SLEIGHT_GUARD=batch` (about 1 s a pass, against a LAWS read) is not built.

Live on 2026-10-11 with the owner present: iPhone Mirroring 3/3 (`bench/results/2026-10-11T03-35-55-975Z.json`,
two runs through Settings in 40.1 s / 9 turns and 41.7 s / 10, no stray tap); `/sleight stop` on
installed 1.1.0 ended the turn at once (Calculator stopped at 208 of 1000); calculator-click 3/3 and
textedit-save and textedit-edit 3/3 each. The opt-in rich move stays off: macOS disables Paste in a
TextEdit that has never been frontmost (`323183d`).

Next, in order:
1. Finish the first-call A/B (above) and act on it.
2. Review and merge lease-select and owner-present-mail as they report.
3. Then ask the owner for the one away sitting (owner: no partial windows), with the run order and
   length (about 75 to 90 min): the Codex head-to-head with clean arms and the owner's setup,
   textedit-drag, Chess with computed points (waits live check), simulator-form x3 (checks the
   2000 px scale note and sim-readiness), the save-lock experiment (`--delivery-check`, then the
   full run), select-all (`bench/small-fixes-textedit.mjs --quick`), live-checks-1-1 (`stale-number`,
   `menu-bar`, which reports "needs Accessibility"), the shop smoke tasks with outcomes, Best Buy.
4. With the owner watching, after owner-present-mail merges, run Mail, Mimestream and the chat tasks
   once each with `--owner-present`.
5. If the gate is met, the full release pass and the release (ROADMAP 5b), including README's
   release-pass numbers, then update the owner's installed copy and confirm its `gitCommitSha`.

**Waiting on the owner:** whether to release if the gate isn't met. Parked by the owner: the
directory listing and the Windows spike. Once the release is installed on their Mac: "Always allow"
once, `/sleight stop` and turn end on the new build, recording from a demonstration, and optionally
`sleight-mcp setup` in a fresh macOS user. `menu_bar`'s Accessibility stays ungranted.

**Where work goes.** Work in progress is private between releases (LAWS): `remote.pushDefault
private` sends pushes to `Land-o-Clusters/sleight-dev`, and a pre-push hook refuses the public repo
without `SLEIGHT_RELEASE_PUSH=1`. Public `origin/pane/auto-mode` stays at `332e3ca`. The `codex/*`
branches already public stay there (owner).

**Benchmark.** Claude arms run on the owner's API key, Haiku 5.5 at high, capped at $200 a month
(LAWS), priced from token counts. The ledger read $4.53 for October at 03:24 UTC on 2026-10-11 (Console
showed $0.27 actually charged). Old runs move to
`~/Library/Caches/sleight-bench/runs-archive` before each pass. `--surfaces browser,computer` runs
the real suite with the extension browser API. Chains of live runs live in `.dev/passes/`
(`away-2026-10-10*.sh`, `evidence-2026-10-11.sh`).

Released: `v1.1.0` (`0b6a1c0`) on `main`. Everything since is on `pane/auto-mode`, in `CHANGELOG.md`.

Read first: `docs/known-problems.md`, `docs/benchmark.md`, `docs/design/guard-reads.md`.

Branches and worktrees (`~/Projects/sleight-wt/<name>`):
- `pane/auto-mode` in `~/Projects/sleight`: the working branch. A release fast-forwards `main` to it
  and pushes `origin`.
- Lane worktrees from 2026-10-11 under `~/Projects/sleight-wt/` are merged and safe to remove, except
  the open lanes' (lease-select, owner-present-mail).
- `perf/screenshot-scale` (`1aa574b`, `shots`): parked.

## Machine state outside the repo

- Daily launchd job `com.landoclusters.sleight-watch` (9:00, `scripts/watch.sh`), daily since
  2026-10-10 on the owner's OK because a competitor hinted at an engine change; weekly with
  `npm run watch:install`. It saves the engine's API docs, without sleight's skill since 2026-10-10
  (`~/Library/Logs/sleight/engine-api-26.1007.21159.md` is the latest), and diffs them on an engine
  update. Remove with `npm run watch:remove`.
- `~/Library/Application Support/sleight/preapproved.json` lists Calculator (owner, 2026-10-04) and
  Helium (`net.imput.helium` and `Helium`, all `high`). Helium was added on the owner's order on
  2026-10-05, and the owner kept it with no end date on 2026-10-08. The list before it is
  `.dev/tools/preapproved.before-helium.json`.
- `ComputerUseAllowForbiddenTargets` is on (`defaults write -g`, set by the owner 2026-10-05, kept on
  2026-10-08 so agents can drive terminals for tests). Terminals and OpenAI's apps go through the engine
  for every engine client, Codex included. Off: `defaults delete -g ComputerUseAllowForbiddenTargets`.
- `.dev/tools/`: probe and timing clients for sleight's launcher, the CNN trial, transcript
  dumpers, and `dialogs.swift` (lists permission dialogs on screen).
- LCU 0.11.2 runtime-only at `~/.local/share/lcu` (installed 2026-10-10 on the owner's OK, with 0.8.8 kept
  in `releases/`). The benchmark's arm is `~/Library/Caches/sleight-bench/lcu-arm`, made by
  `node bench/lcu-arm-setup.mjs`.
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
- The watch's baseline (`~/Library/Logs/sleight/watch-engine-version`) is 26.1007.21159 (2026-10-10).
- `~/.config/sleight-bench/anthropic-api-key` (0600): the owner's API key for benchmark runs
  (2026-10-10). Spend ledger: `~/Library/Logs/sleight/bench-api-spend.json`.
- `.git/hooks/pre-push` (shared by every worktree): refuses pushes to the public repo without
  `SLEIGHT_RELEASE_PUSH=1`.
- `~/Library/Caches/sleight-bench/runs-archive`: benchmark runs older than 6 hours, traces kept.
  `~/Library/Caches/sleight-bench/swift-module-cache`: the shared module cache for helper compiles.
- `.dev/passes/front-watch.sh`: logs every frontmost-app change during a pass.
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

- OpenUsage (owner's usage meter) was rate-limited from 2026-10-10 22:18 UTC through at least
  2026-10-11 03:42, with no bench run for long stretches of it. Bench arms had been inheriting the
  host desktop session's env, including its auth-refresh socket (fixed `72410f1`) and now use their
  own `CLAUDE_CONFIG_DIR` on the key. Check `grep "plugin:claude" ~/Library/Logs/OpenUsage/OpenUsage.log`
  during and after the first-call A/B: fresh reads throughout would clear the bench.

- Safari fixture windows, Preview `Pages-*.pdf`, Word and Excel fixture documents were left on
  their screen on 2026-10-09. Check the iCloud TextEdit files only by exact content, never by browsing.
- The OpenAI key note is theirs to handle. Don't raise it again (owner, 2026-10-09).

## Reading list

- `docs/status/ROADMAP.md`: everything we intend, in order. Any correction from the owner about the
  plan is written there in the same turn, and a question about the plan is answered from it whole.
- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
