# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-11 02:05 UTC)

`pane/auto-mode` is pushed to private. Merged tonight, each squashed in a scratch worktree after
review, check and lint at 0: from Grok, icloud-textedit (`b09b792`), panel-busy (`88564db`),
chat-crash (`1700c80`), chess-points (`31ec715`), savelock-delivery (`94960bf`); from GLM,
livechecks (`46c055c`), saveclose-research (`867f58c`), shop-check (`5a96105`), release-docs
(`2faee8d`). Review fixes:
- icloud-textedit's launch left TextEdit's iCloud Open panel up.
- A panel-busy finding became a mod fix: a failed pane list skipped `turn_ended`.
- chat-crash dropped stopped rows from private results. They now keep a bare failed phase.
- shop-check's human-check stop was still a failure string. It's now `outcome: "human-check"`.
- release-docs predated tonight's merges. Its conflicts were combined, and the chat pass is marked
  fixed but not rerun.

Not merged: richmove-placement. My brief misread the evidence. The fixture covers its window on
purpose, because the opt-in rich move only runs on the Accessibility path. In that run the move
pasted, then failed its formatting check. `codex/richmove-placement` stays on private, unused. The
follow-up is richmove-format. savelock-delivery's `--delivery-check` ran live
twice, and neither posted Cmd+S saved the background TextEdit. The follow-up is
savelock-engine. The bench arms get their own
`CLAUDE_CONFIG_DIR` in API mode (OpenUsage, below). The live lock and hold are free.

Lanes out (each pushes `codex/<name>` to private and doesn't merge; briefs in `.dev/prompts/`):
GLM's selectall-check and richmove-paste. Merged since: richmove-format (`edd09ee`), whose live check
then stopped at a disabled Paste item twice (richmove-paste is the follow-up), and savelock-engine
(`45f07e9`), with a review fix that refuses a TextEdit holding documents the probe didn't open.
The owner now gets each lane as one paste-ready prompt with the model named.
Merged 03:20 UTC from Grok: savesheet-recipe (`49356a7`, result note naming the one-call save),
sim-readiness (`37e2d8e`) and speed-research (`68cdc78`). speed-research found the clean-arms CPU gap
(51.8 s against 42.8 s) was 8.6 s from the two failed textedit-save runs; the seven runs both arms
passed differ by 0.4 s. So the gate may be met once textedit-save passes. Its proposed
`SLEIGHT_GUARD=batch` (skip before-click reads for unique IDs) would save about 1 s a pass and goes
against a LAWS read, so it isn't built. Merged since: iphone-settle (`6f5f1b9`, owner-present check pending) and richmove-paste
(`323183d`). Out: GLM's selectall-check and sim-scale-note.
iPhone Mirroring with iphone-settle, owner present (03:25 UTC, `bench/results/2026-10-11T03-25-00-216Z.json`):
2/3, 27.0.1 in 35.4 s and 8 turns, and 17.6 s and 5 turns, against 66.9 s and 16 before, with no tap
outside Settings. The third run started on the About page the previous run left. The failed run
stopped at the lock screen iPhone Mirroring shows while it unlocks itself; the prompt now says to wait
up to 30 s and never enter a password. An earlier set of 3 at 03:24 failed the same way. Codex keeps lease-select and, on the owner's word, the lease broker and the
unsaved-changes review (ROADMAP 6). saveclose-research found the next speed lever for speed-research.
Claude spends two or three calls inside the Save sheet, 6 to 9 s a run
(`docs/design/save-then-close-2026-10-11.md`).

Results on 2026-10-10 and 11 (`docs/benchmarks/2026-10-10-away.md`, `-away-2.md`,
`2026-10-11-evidence.md`). Against Codex with clean arms, sleight passed 7/9 in 263.7 s and Codex
9/9 in 265.8 s, own CPU 51.8 s against 42.8 s. With the owner's setup it was 8/9 in 262.4 s
against 9/9 in 229.6 s. Against LCU 0.11.2, sleight passed 8/8 in 210.6 s and LCU 7/8 in 299.2 s.
VS Code, Cursor and Firefox passed 5/5. textedit-save with code traces passed 3/3. The release gate
(ROADMAP 3.5) isn't met on time with the owner's setup or on own CPU.

Next, in order:
1. Review selectall-check when it reports. Squash it in a scratch worktree, run the full check
   there, and fast-forward `pane/auto-mode`. Hand out richmove-format and savelock-engine when lanes
   free up.
2. One owner-away sitting, asked for only once every lane is merged (owner, 2026-10-11: no partial
   windows), verifies the merged lanes live and reruns the Codex head-to-head. Done on the login 2026-10-11 with the new
   TextEdit launch: textedit-save 3/3 and textedit-edit 3/3 (`bench/results/2026-10-11T02-00-43-494Z.json`,
   `…T02-11-10-111Z.json`), with TextEdit quit after the second. Left: textedit-drag, the computed Chess points (waits live check), the chat
   pass's saved rows, `stale-number` and `menu-bar` (live-checks-1-1), the shop smoke outcomes,
   textedit-save with traces, Best Buy, select-all, simulator-form, the chat tasks, and the save-lock
   experiment (`node bench/textedit-save-lock.mjs --delivery-check`, then the full run; finishing its
   Open panel can bring TextEdit forward). The opt-in rich-text move is off the list: richmove-paste (`323183d`) found
   macOS disables Paste in a TextEdit that has never been frontmost, so it stays opt-in and off.
3. Act on speed-research to close the gate, then the full release pass and the release (ROADMAP 5b).
4. Confirm the bench arms' own config folder with one cluster once OpenUsage reads fresh (below).

Owner at the Mac, 2026-10-11 02:15 to 02:25 UTC:
- `/sleight stop` on installed 1.1.0 came mid-call in a Calculator loop. Claude Code marked the call
  interrupted and ended the turn at once. Calculator stopped at 208 of the loop's target 1000. Esc
  then had nothing to stop. The stop message now says to press Esc only if Claude keeps working.
- iPhone Mirroring (`--owner-present`): first run refused in 4.1 s, since headless runs can't prompt.
  The owner approved adding it for owner-present runs only (LAWS). The rerun read 27.0.1 in 66.9 s
  and 16 turns, scored a failure under the then-strict check, which now allows a note after a blank
  line. A tap opened Personal Hotspot by mistake. The owner was asked to check its compatibility
  switch.
- The iCloud `Untitled 10.txt` (contents `sleight bench 276874eb`) is in the Trash, on the owner's OK.

**Waiting on the owner:**
- Bench auth, settled 2026-10-11 03:05 UTC: the $200 is the Max plan's monthly API credit, which
  covers "Agent SDK, API, Batch API, Playground, Managed Agents". Arms started from a Claude desktop
  session inherited its `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, account IDs and messaging socket, so
  billing counted them as the desktop's Claude Code and refused them ("Credit balance is too low").
  From a clean environment the same key paid for the Agent SDK and `claude -p`. The runner now strips
  the host session's `CLAUDE*` variables, and calculator-click passed 3/3 on the key
  (`bench/results/2026-10-11T03-04-03-856Z.json`). Live runs are back on the key.
- Parked by the owner (2026-10-11): the directory listing and the Windows spike. sleight-arch's calls
  on the owner's "whatever you want": `menu_bar` stays at "needs Accessibility" (a macOS security
  setting), and "Always allow" and a fresh-user `setup` run wait until after the release.
- With the owner at the Mac, Mail and Mimestream. ("Always allow" needs the release: the owner's
  installed sleight is 1.1.0, `0b6a1c0`, without that button.)
- Whether to release if the gate (ROADMAP 3.5) isn't met.

**Where work goes.** Work in progress is private between releases (LAWS): `remote.pushDefault
private` sends pushes to `Land-o-Clusters/sleight-dev`, and a pre-push hook refuses the public repo
without `SLEIGHT_RELEASE_PUSH=1`. Public `origin/pane/auto-mode` stays at `332e3ca`. The `codex/*`
branches already public stay there (owner).

**Benchmark.** Claude arms run on the owner's API key, Haiku 5.5 at high, capped at $200 a month
(LAWS), priced from token counts. $4.41 is spent in October (2026-10-11 00:30 UTC). Old runs move to
`~/Library/Caches/sleight-bench/runs-archive` before each pass. `--surfaces browser,computer` runs
the real suite with the extension browser API. Chains of live runs live in `.dev/passes/`
(`away-2026-10-10*.sh`, `evidence-2026-10-11.sh`).

Released: `v1.1.0` (`0b6a1c0`) on `main`. Everything since is on `pane/auto-mode`, in `CHANGELOG.md`.

Read first: `docs/known-problems.md`, `docs/benchmark.md`, `docs/design/guard-reads.md`.

Branches and worktrees (`~/Projects/sleight-wt/<name>`):
- `pane/auto-mode` in `~/Projects/sleight`: the working branch. A release fast-forwards `main` to it
  and pushes `origin`.
- Every lane worktree from before 2026-10-11 is merged and safe to remove. Tonight's lanes create
  their own worktrees under the names above.
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

- OpenUsage's Claude reads still get 429s with the bench on the API key (disk-audit session,
  2026-10-11). Each throttle began 3 to 5 minutes after a cluster's first bench run, API key or
  login: 07:04 to 07:07, 10:27 to 10:30, 14:01 to 14:06 UTC on 2026-10-10. Done: in API mode each
  arm runs with `CLAUDE_CONFIG_DIR=~/Library/Caches/sleight-bench/claude-config`, which links the
  owner's settings, plugins, skills, commands, hooks and dev-mods. Without the key, Claude Code
  there didn't find a login (no key source, model call failed with 0 tokens). With it, the folder got a
  3-field `oauthAccount` for the owner's account, likely from the key's own lookup. Against the
  bench theory, OpenUsage has been limited since 2026-10-10 22:18 UTC without a break. That
  includes the 45 minutes before 01:43 with no bench run. Its throttles go back to 2026-10-04. Still to do: once OpenUsage
  reads fresh again (`grep "plugin:claude" ~/Library/Logs/OpenUsage/OpenUsage.log`), run one
  calculator-click cluster and check its reads during and after it.

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
