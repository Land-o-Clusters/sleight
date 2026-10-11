# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-11 15:45 UTC, the away sitting done as far as its harnesses allow)

Measured today, owner away (docs/benchmark.md): clean-arms head-to-head 9/9 each, sleight 22.0 s a
run against Codex 44.6 s at 4.68 against 4.84 CPU seconds; normal setup 9/9 each, 27.1 s against
36.2 s at 5.94 against 4.30 CPU seconds; browser head-to-head 24/24 each, 28.5 s against 41.8 s;
textedit-drag 3/3 and menu-bar passed. The app-agnostic skill replaced the old one after two A/Bs.
Failed or blocked: stale-number (display 7, not 56), simulator-form (simctl shutdown error 405 at
cleanup), both shop smoke checks (titles differ from the retailers' listings; carts filled), and the
Chess, save-lock and select-all harnesses at their own setup. The battery and the 40 native browser
tasks stopped on harness cleanup. Lanes web-cleanup, owned-abort and prune-budget
(`.dev/prompts/`) are with the owner for Codex. Guest carts with test items are left in Safari on
Target and Best Buy, and one benchmark Helium window on 127.0.0.1 is open, for the owner to close.

**Owner's OK, 13:54 UTC:** sleight-arch allows `127.0.0.1` in the Codex extension's site settings in Helium
and Chrome, through the browsers' own UI, once no live run holds the lock. The extension's own
site prompt dismissed the first extension task (it isn't an MCP elicitation). Lane browser-tasks-2
(Safari setup fix, an `--extension-sites-allowed` gate) is running in Codex.


**Running now, owner's OK at 12:33 UTC (sitting plus the battery's no-seed half):** the skill A/B
rerun (`.dev/passes/ab-skill-r2.log`). After it, `.dev/passes/away-2026-10-11.sh` from this worktree
runs two Save A/Bs (sheet and skill), `bench/away-sitting.mjs` (12 steps) and
`bench/run.mjs --suite battery --owner-away` (17 tasks, 34 runs). Progress is in
`.dev/passes/away-2026-10-11.log`. Don't change plugin files in the main checkout until it ends.
Nothing ran from 07:15 to 12:30 UTC: sleight-arch ended its turn without asking for the sitting.
Results so far: the skill A/B rerun (slim matches current, 14.5 s against 15.6 s), the Save-sheet
A/B (sheet lost, 29.7 s against 21.5 s, to be removed after the sitting) and the skill A/B on
textedit-save (slim 38.9 s, current 44.7 s), all in docs/benchmark.md. Slim replaces SKILL.md after
the sitting. The sitting's first start failed without `--owner-away` (sleight-arch's error). The
battery stopped after 1 run at 13:14 UTC: the TextEdit task passed on disk, but cleanup left the
fixture window open (CLEANUP_UNCONFIRMED). sleight-arch closed that one document and released the
lock. Its fix is lane battery-cleanup (`.dev/prompts/lane-battery-cleanup.md`). Now running: sleight against Codex on the
12 web tasks (2 runs each), then the 12-step sitting
(`.dev/passes/away-2026-10-11-sitting.sh`). Lane browser-tasks (Codex gpt-6.1-sol, `.dev/prompts/lane-browser-tasks.md`) started
about 12:50 UTC from the owner's phone, so this sitting's CPU and timing numbers overlap its checks.


`pane/auto-mode` at `ff03fbc` is pushed to private (`Land-o-Clusters/sleight-dev`), and the main
checkout is fast-forwarded to it. `npm run check` 1,938 tests plus 31 mod tests, `lint:prose` clean.
Live lock and hold are free. Lanes generic-drag, generic-mechanisms, battery-harness and battery-report are merged, and
`~/Projects/sleight-wt/` is empty. This session
works in its worktree (`claude/boot-sleight-arch-6d0629`), because a hook refuses edits in the main
checkout. It pushes with `git push private HEAD:pane/auto-mode`, then fast-forwards the main checkout.

**Direction (owner, 2026-10-11, in LAWS and ROADMAP track 0):** sleight is app-agnostic, like Codex.
What users run adds generic mechanisms, never rules or code paths for one app. Benchmark checks are
generic too. A side-by-side battery against Codex follows the cleanup. The owner starts it. Don't
start the battery before they say so.

**Merged 2026-10-11:** generic-drag (`702cf3b`), generic-mechanisms (`97dd734`), battery-harness
(`d0175cd`) and battery-report (`ff03fbc`). The generic-mechanisms lane's Shift press after `setValue`
was dropped (`6ac66d5`): the engine refuses a modifier-only key (`-10005`, 2/2 live), so it would have
failed every `setValue` on a text area. Its unit tests mocked `pressKey`.

Live with the owner present, 2026-10-11, background TextEdit opened with `open -g`: `drag` moved a
bold red word 3/3 through Accessibility (the window was covered), with the text, spacing, front app
and pointer right, about 6.6 s a drag, and the formatting lost 3/3. `setValue` then the engine's Cmd+S
saved 3/3 (about 1.0 s and 0.6 s). sleight answered that save "saved: not confirmed (degraded read)"
3/3 although the file had changed, because the file wasn't opened through `open_file`.

Live checks still open: an uncovered TextEdit move and a move in a second native text app (owner away,
since the posted path can take the pointer), Chess, a large non-simulator screenshot's scale note, an
orphan panel in a second AppKit app, a recording in a third app, a flow rule in a browser outside the
old list, and `setValue` in a document opened through the Open panel (the save-lock run).

**Battery, ready for the owner** (`node bench/run.mjs --suite battery --dry-run`): 17 tasks and 34
runs without the owner, 31 tasks and 62 runs with `--owner-present`. That needs the owner to seed 10
items first (self-messages in Slack, Discord, WhatsApp, Messages and Mail, and items in Music, Maps,
Photos, Spotify and Zoom), passed with `--markers`, and a `--local-fixtures` file naming local
Notes, Reminders and Calendar containers. `bench/battery-report.mjs` turns the results into the
parity tables.

**Skill A/B, done** (docs/benchmark.md, `docs/benchmarks/2026-10-11-skill-ab.json`): current 11/11 at
14.5 s a run, slim 12/12 at 16.0 s, and the arm with no sleight rules 11/11 at 19.5 s. With no rules
calculator-click took 5 to 9 turns against 3. Slim lost a turn in 2 of 6 calculator-click runs,
likely from dropping the `{ id }` and `{ label }` examples. `SKILL-slim.md` now shows an ID and a label click with
placeholders, no app names (owner: no Calculator example either). Next: rerun (`.dev/passes/ab-skill.sh`, owner present is fine),
then textedit-save in the away sitting. Slim replaces SKILL.md only when it matches or beats current.
Compare A/Bs with `node .dev/tools/ab-compare.mjs <log name>`.

Measured on 2026-10-11 (docs/benchmark.md): the `cua.getApp` first-call wording is the default
(27.0 s against 30.6 s a run). `open_file` naming its `getApp` call and saves observed from the file on
disk are the default (textedit-edit 6/6, 18.5 s against 20.0 s). The Save-panel list trim lost and is
gone. The acquisition-tree drop tied and stays off. `SLEIGHT_FIRST_CALL_BATCH=sheet` (no Cmd+S stop,
menu clicks in one call) waits for the save A/B in the away sitting.

With the owner present, Mail, Mimestream and the chat tasks failed in setup in their per-app helpers
(known problems). The engine itself read Slack (161 elements) and Discord (223). Slack takes the front
on launch with no click, and Electron trees build seconds after launch. Go to Folder in a Save panel
puts TextEdit's windows over the owner's for about 0.4 s, so textedit-save runs need the owner away.
Lanes chat-tasks-2, mail-fixtures, unsaved-review-2 and launch-focus were withdrawn by the owner.
Giving the user's front app back after a launch takes it is still wanted, as a generic mechanism
(ROADMAP track 0). The chat helper no longer sets the Accessibility switch (`5827c2d`).

Worktrees: on 2026-10-11 the withdrawn lanes panel-rows (`4642150`), codex-diff (`227ca30`),
mirroring-turns (`00546c1`) and launch-flake (`1147230`) were removed with their branches. The merged
lanes' worktrees went too. plugin-arm round 3 (`f7486d0`) is on private and its files match the
working branch.

**Away sitting** (owner asks once): first the sheet and skill A/Bs on textedit-save. Then
`node bench/away-sitting.mjs` runs its 12 steps, about 38 min by its dry run.

Results that matter for the release gate (ROADMAP 3.5, 5b.1): speed-research found the clean-arms CPU
gap to Codex (51.8 s against 42.8 s) was 8.6 s from two failed textedit-save runs, and the seven runs
both arms passed differ by 0.4 s. Those failures were iCloud leftovers, fixed (`b09b792`), and
textedit-save then passed 3/3 twice. The away sitting's head-to-head decides.

Live on 2026-10-11 with the owner present: iPhone Mirroring 3/3 (`bench/results/2026-10-11T03-35-55-975Z.json`),
`/sleight stop` on installed 1.1.0 ended the turn at once, calculator-click 3/3 and textedit-save and
textedit-edit 3/3 each. The opt-in rich move stays off: macOS disables Paste in a TextEdit that has
never been frontmost (`323183d`).

Next, in order:
1. Live checks with the owner present: lease-broker with Codex, unsaved-review, and track 0's
   background ones (scale note, orphan panel, recording, flow rule). The skill A/B rerun.
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
- `~/Projects/sleight-wt/` is empty (2026-10-11).
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
