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
follow-up is `.dev/prompts/lane-richmove-format.md`. savelock-delivery's `--delivery-check` ran live
twice, and neither posted Cmd+S saved the background TextEdit. The follow-up is
`.dev/prompts/lane-savelock-engine.md`. Both briefs wait for a free lane. The bench arms get their own
`CLAUDE_CONFIG_DIR` in API mode (OpenUsage, below). The live lock and hold are free.

Lanes out: GLM's selectall-check (brief in `.dev/prompts/lane-selectall-check.md`, after
`lane-rules-2026-10-11.md`), which pushes `codex/selectall-check` to private and doesn't merge.
Codex hasn't started lease-select (Best Buy's lease refusals), sim-readiness or speed-research. They
wait for its quota to reset. saveclose-research found the next speed lever for speed-research.
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
2. One owner-away window verifies the merged lanes live: the TextEdit tasks with the new launch
   (only the helper ran live, 1.6 s warm), the computed Chess points (waits live check), the chat
   pass's saved rows, `stale-number` and `menu-bar` (live-checks-1-1), the shop smoke outcomes,
   textedit-save with traces, Best Buy, select-all, simulator-form, the chat tasks. The rich-text
   move (`SLEIGHT_RICH_TEXT_MOVE=1 node bench/textedit-fixes.mjs --move --open-background`) waits for
   richmove-format.
3. Act on speed-research to close the gate, then the full release pass and the release (ROADMAP 5b).
4. Confirm the bench arms' own config folder with one cluster once OpenUsage reads fresh (below).

**Waiting on the owner:**
- Bench auth (owner, 2026-10-11 02:10 UTC): live runs use the owner's login (`--auth login`) until
  they decide. The key's $200 is a promotional grant (the "API credit (Max 20x)", $199.73 left,
  expires 2026-11-08) that covers "Agent SDK, API, Batch API, Playground, Managed Agents". Direct
  Messages API calls on the key work (Haiku and Sonnet, 2026-10-11). Anything sent through the
  `claude` binary gets "Credit balance is too low": `claude -p` and the Agent SDK 0.3.296 alike. Bench
  runs on the key passed until 00:43 UTC and fail from about 01:00 at $0 (inferred: billing began
  counting that traffic as Claude Code). Owner's choice: buy a little credit, or stay on the login.
  Faking the traffic's product or a bare-API arm are out (the latter isn't Claude Code plus sleight).
  textedit-save on the login passed 3/3 (93.4, 40.2, 45.6 s, `bench/results/2026-10-11T02-00-43-494Z.json`).
- `Untitled 10.txt` in the iCloud TextEdit folder, a benchmark leftover: move it to the Trash or keep.
- Windows (ROADMAP track 6): on the 2020 Intel MacBook Pro, register for the Windows 11 Enterprise
  evaluation, download it and VMware Fusion, install ChatGPT, turn on OpenSSH. Then sleight-arch
  runs the spike over SSH.
- The directory listing (ROADMAP 5b.6).
- With the owner at the Mac, Esc and `/sleight stop` in a real session, Mail and Mimestream,
  iPhone Mirroring (`--owner-present`), trying "Always allow" once, a live `sleight-mcp setup` in a
  fresh macOS user, and Accessibility for the process that runs `menu_bar`'s osascript.
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
