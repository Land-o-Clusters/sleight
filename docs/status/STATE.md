# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-11 05:55 UTC, written for the owner's fresh context)

`pane/auto-mode` is at `5829bb3` plus this banner, pushed to private, nothing uncommitted.
`npm run check` 1,867 tests plus 31 mod tests, `lint:prose` clean.

**Direction (owner, 2026-10-11, in LAWS):** sleight is app-agnostic, like Codex. What users run adds
generic mechanisms, never rules or code paths for one app. Benchmark checks are generic too. The owner
wants what already exists cleaned up, the skill slimmed and hardened for apps nobody tests, and a
side-by-side battery against Codex on about 25 popular apps (apps approved, in LAWS). The owner will
start that work in a fresh context. Don't start the battery before they say so.

**Running at the clear:** `nohup .dev/passes/ab-skill.sh` (started 05:47 UTC, about 20 min): the current
skill against `SLEIGHT_SKILL=slim` (`plugins/sleight/skills/drive-mac-apps/SKILL-slim.md`, 79 lines,
40% shorter, no app names) and `SLEIGHT_SKILL=none` (no sleight rules, as Codex), on calculator-click
and textedit-edit x3, 2 rounds. Log `.dev/passes/ab-skill.log`. Compare per arm: passes, turns, model
time per turn, total. textedit-save joins in the away sitting (Go to Folder flashes the sheet over the
owner's window, so save runs need the owner away). If slim matches or beats current, it replaces
SKILL.md. If none is close, the skill was mostly weight.

**Ready to paste, Codex gpt-6.1-sol, in `.dev/prompts/`:** `lane-generic-drag.md` (delete the TextEdit
rich-text move, about 400 lines; one drag path for every app), `lane-generic-mechanisms.md` (screenshot
scale note, orphan Save panel, demonstration recorder, browser detection and the setValue settle for
any app), `lane-battery-harness.md` (generic fixture and check kinds: doc-file, self-message, web-page,
app-state; window order recorded per run), `lane-battery-report.md` (parity table, Codex call diff,
rules mined on half the apps and proven on the other half). The audit behind the cleanup lanes found
about 15 app-specific places, the biggest being the rich-text move.

Measured since the clear (docs/benchmark.md): the `cua.getApp` first-call wording is the default
(27.0 s against 30.6 s); `open_file` naming its `getApp` call and saves observed from the file on disk
are the default (textedit-edit 6/6, 18.5 s against 20.0 s); the Save-panel list trim lost and is gone;
the acquisition-tree drop tied and stays off; `SLEIGHT_FIRST_CALL_BATCH=sheet` (no Cmd+S stop, menu
clicks in one call) waits for the save A/B. With the owner present, Mail, Mimestream and the chat tasks failed
in setup in their per-app helpers (known problems); the engine itself read Slack (161 elements) and
Discord (223). Slack takes the front on launch with no click; Electron trees build seconds after
launch. Lanes chat-tasks-2, mail-fixtures, unsaved-review-2 and launch-focus were withdrawn by the
owner; launch-focus's idea (give the user's front app back after a launch takes it) is still wanted,
as a generic mechanism.

Worktrees: 66 old lane worktrees removed tonight. Left: panel-rows, codex-diff, mirroring-turns,
launch-flake (owner told those lanes to remove themselves; check, then remove if still there) and
plugin-arm (its last commit `f7486d0` was never pushed).

Results that matter for the release gate (ROADMAP 3.5, 5b.1): speed-research found the clean-arms CPU
gap to Codex (51.8 s against 42.8 s) was 8.6 s from two failed textedit-save runs, and the seven runs
both arms passed differ by 0.4 s. Those failures were iCloud leftovers, fixed (`b09b792`), and
textedit-save then passed 3/3 twice. The away sitting's head-to-head decides.

Live on 2026-10-11 with the owner present: iPhone Mirroring 3/3 (`bench/results/2026-10-11T03-35-55-975Z.json`),
`/sleight stop` on installed 1.1.0 ended the turn at once, calculator-click 3/3 and textedit-save and
textedit-edit 3/3 each. The opt-in rich move stays off: macOS disables Paste in a TextEdit that has
never been frontmost (`323183d`).

Next, in order:
1. Live checks of the merged lanes (lease-broker with Codex, unsaved-review) with the owner present.
2. Then ask the owner for the one away sitting (owner: no partial windows), with the run order and
   length (about 75 to 90 min): the Codex head-to-head with clean arms and the owner's setup,
   textedit-drag, Chess with computed points, simulator-form x3, the save-lock experiment
   (`--delivery-check`, then the full run), select-all (`bench/small-fixes-textedit.mjs --quick`),
   live-checks-1-1 (`stale-number`, `menu-bar`), the shop smoke tasks, Best Buy (lease-select's live
   check), the quiet-box CPU comparison.
3. With the owner watching, run Mail, Mimestream and the chat tasks once each with `--owner-present`,
   and lease-select's Helium Console check.
4. If the gate is met, the full release pass and the release (ROADMAP 5b), including README's
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
