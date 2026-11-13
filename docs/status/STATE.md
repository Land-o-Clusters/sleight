# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-11-01 16:46 UTC)

**16:46Z.** **int22 is now a099698b** (pushed). Merged since 13:31Z, each reviewed MERGE-OK with nits: CB1O, OS2 to OS2C,
FL3, FL4 with FL4B and FL4C, OS1D, OS1E, RT18A, RT18B, DT1D to DT1G, AH1 with AH1B, RT17 to RT17D, CB1M with CB1P, CB1Q,
CB1R, CB1S, CH1, SG2 to SG2D. The 15:20Z full check's 34 failures are fixed (CH1, OS1E). On the last merge, the rule
tests plus 149 turn and clipboard files passed 8,349 of 8,439 (90 skips, 0 failures). **Second full check: 17:30Z**
in Puddle's slot (no Puddle push or suite from 17:25Z until "window done").
**Security finding, pre-existing (MB1).** Sessions without sleight's mod include `claude -p` and the Agent SDK. In
those, a model's own `turn_ended` bootstrap call returns the nonce, so the model could forge `begin` frames holding typed
`allow <app>` approvals. With the mod loaded it can't. Fable is writing `ledger/vc/MB1-mod-bootstrap-invariant.md`, including whether 1.5.1 is affected.
An advisory is the owner's call. Lanes have pids in `lanes160/<id>.pid`:
- WCB1C fixes WCB1B's BLOCK (a Windows clipboard stop never cleared) and merges int22. WCB1's C# compiles only on the
  Windows VM, before the Windows driver sitting.
- Before any `--include-chrome` sitting, OS2D binds Chrome by its `--user-data-dir`. The native Windows wire waits until
  after the Windows driver sitting (RT17B). SEM1: the semantic adapter sets `pasteRefusal` when it is built.
Rulings in `PLAN.md` from 13:38Z. Re-arm after a clear with `zsh night/lane-waiter2.sh wcb1c`.

OWNER ASLEEP since 2026-11-01T07:20:11Z (/goodnight). OWNER AWAKE 2026-11-01T12:03Z (/goodmorning). Night Shift off.

**Owner, 2026-11-01.** Build every remaining 1.6.0 and 2.0 item now, in parallel, keeping review quality ("Building is free
on machine load". At 12:15Z the owner asked to get the small items and 2.0 builds moving, and make lanes clean up their worktrees). Safety
logic gets its invariant from Fable or Astra first (LAWS). Today's owner decisions are in LAWS. This morning the owner added the runtime clipboard rule (Fable's CB1G
answers) and sealed settings (Fable's SG2 answers, also ROADMAP 12b).
sleight-arch's rulings are in `ledger/vc/PLAN.md` from 2026-11-01 02:30Z on.

**The 1.6.0 line is `codex/int22` 79fcaba9** (`~/Projects/sleight-wt/int22`, pushed). It is int19 (int14 b54d5ac9 and rti1
29593c43) plus rti1 5e307eb8 (FT1, IM1, OS1), API1D, ID1, DT1C, RT32C, OS1C, CB1F, WDR8E, SIT1F, ID1B, HL1D (HL1 to HL1C),
CB1H (CB1G), the INT21B scan change, CB1I, SCN1, CB1J, CB1K, FL2, CB1L, and KP1/KP1B (known-problems for 1.6.0 and an
unreleased 1.6.0 changelog). Reviews of every merged branch are MERGE-OK with nits (`ledger/vc/lanes160/reviews/`).
Full checks (Puddle slots, `night/check-wt-nohup.sh <worktree>`): int20 34 of 34,007 failed, int22 19 of 34,299, then
1 of 34,345, then at e4027343 (12:34 to 13:03Z) 2 of 34,359. Those two: tests/mac-driver-errors.test.mjs's no-provider-text
guard (CB1L keys the ancestry refusal on `source.message`; CB1O moves it to a typed envelope field) and two direct-browser
real-page tests in the FD2 family (one timed out at 60 s under Puddle's CI load, and FL3 fixes the family). Logs:
`lanes160/int22-fullcheck*.log`. After CB1O, FL3 and the other lanes below are reviewed and merged, a full check runs in a
Puddle slot. A green one completes critical path step (1).

**Lanes running under nohup (they keep running after a clear), all based on int22.** Briefs and reports in `ledger/vc/lanes160/<id>.md`,
`<id>-REPORT.md`. Each gets a Sonnet-high review before merge.
- CB1O (pid 62447): typed field for the ancestry refusal, client.mjs included (CB1N stopped on my file list).
- CB1M (37528) allows Control+C and Control+X on the runtime, Command chords still refused (owner's CB1G answer).
- FL3 (6618) fixes the G3G/G3H and FD2 flakes so fixture servers ignore stray requests.
- AH1 (6611): AD3Z stale pinned-window advice, HG3 setup timeout message.
- DT1D (6625): measure DT1C's structure block on recorded reads, then send only structure the tree lacks.
- OS1D (91881): stuck Escape and real click bound to the lease's verified window (multi-window apps admitted again),
  own-host gate before any AXPress.
- RT17 (91874): one driver client, one safety dispatcher and one protocol doc for Mac and Windows, behavior-preserving.
- OS2 (8628): away-sitting probes for coordinate-hit parent gaps, off-Space and Split View delivery, context-menu parents.
- RT18A (8635) prepares signing and distribution for the Apple Developer signup, offline with ad hoc signing only.
- SG2 (77561): sealed-settings plumbing from Fable's `ledger/vc/SG2-sealed-settings-invariant.md`, reporting only until a
  signed build enables enforcement.
After a clear, re-arm `cd ~/Projects/sleight-wt/ledger/vc && zsh night/lane-waiter.sh cb1o cb1m fl3 ah1 dt1d os1d rt17 os2 rt18a sg2`.

**Other background jobs (all nohup, they keep running after a clear).** `night/lane-sweeper.sh` (pid 11193, `night/lane-sweeper.pid`)
runs `lanes160/lane-sweep.sh` every 10 minutes: it removes a finished lane's `/private/tmp/sleight-lane-<id>` and its
worktree when clean and pushed (keep list: rti1, int10, int22, cu12, sit1d, sit1f, ad2, race-1017).
`night/gate-after-puddle-rerun.sh` (pid 76662) reopens the lanes' test gate (`night/lanes-may-test.paused-puddle-rerun`
back to `lanes-may-test`) once `/tmp/fable-builders-go` exists again, which Puddle's detached job creates when its CI rerun
41307086490 finishes (verdict in `~/Projects/.fable-s43/rerun-41307086490.result`). It gives up after 3 h. If the gate is
still closed at boot and that marker exists, move the file back by hand. `ledger/p160/night/wip-snapshot.sh` (pid 27289).
Puddle's architect is clearing too, and the next puddle arch seat answers window requests.

**Away run (owner's "go" 2026-11-01 07:19Z), stopped 07:45Z with no sitting completed.** Live attempts found harness bugs
that sleight-arch fixed on `codex/sit1f` (merged into int22): the witness's identity from its kernel start, UTM 5.0.8's
Capture Input toolbar checkbox, stdin read with `availableData`, realpath for /private/tmp, `SLEIGHT_REMOTE_APPROVALS=0` for
the sitting's engine clients. The last attempt stopped on a "Python quit unexpectedly" alert from ZCode (dev.zcode.app),
which only the owner answers. To resume, the owner dismisses it and sleight-arch asks Puddle for a window. Then `zsh night/away1f.sh` (observe,
then the runtime sitting if sittingReady) and `zsh night/away2f.sh` (VM fixture check, then the VM sitting) run from
`~/Projects/sleight-wt/ledger/vc`, with tools in `/private/tmp/sleight-sit1f-live-HBdCPs` (rebuild from int22 if gone, with
`node bench/runtime-owner-away.mjs --build-only --tools <bank>/tools` in a clean int22 checkout). A stopped attempt
leaves `/tmp/sleight-live.lock`. Remove it only when no sitting process runs. Unverified: whether UTM's checkbox AXValue
turns 1 when it captures input. Cursor bank: CE9 (in harness worktree cu12 c445e7c4) handles Cursor's Agents window; the
arm needs one supervised entry task with the owner, then the bank resumes from textedit-drag-r3. Window 9 never ran.

**2.0 status (2026-11-01 12:15Z).** About 19 of 22 runtime-owned parity rows built offline, plus ID1's identity bridge and
HL1's helper inspection. Live proof 0 of 44 (input stays off until the live 10/10 gates, which need the owner away).
Building: RT17, OS1D, OS2, RT18A, SG2. Waiting on the owner's Apple Developer signup: RT18 proper and sealed-settings
enforcement. Parity gap until a live check: row 35's off-Space and Split View cases prove refusal, not engine parity.
Speed against the engine: unmeasured until the runtime sitting.

**Critical path to 1.6.0.** (1) Merge the reviewed lanes, then a green full check of int22. (2) The away run's runtime
sitting and VM sitting, then the live input gates. (3) With the owner at the Mac: the Windows driver sitting and the
5-minute screen-lock step. (4) The squashed release history (`night/release-160.sh`). (5) The release A/B against 1.5.1
(about 6 h, a long Puddle gap). (6) The owner's go, the push-rule toggle, the advisory.

**Disk (2026-11-01 13:10Z).** About 190 GiB free. At the owner's request sleight-arch removed its old TMPDIR test dirs
(3.66 GiB), its /private/tmp leftovers (2.45 GiB) and every finished, clean, pushed lane worktree from the night. Records are in
`ledger/vc/disk-prune-20261101/`. Dirty or unpushed worktrees from before the night, the bench and turbo caches,
`~/Downloads/sleight-vm` (13.3 GiB) and `~/Movies/sleight-film` (13.5 GiB) are the owner's call. The UTM VM reads
`~/Downloads/Windows11_InsiderPreview_Client_ARM64_en-us_26200.VHDX` as a drive, so that file stays. A cache size cap is GV2.

**Harness facts.** A lane brief's file list must include every file the change needs (CB1G, INT21, CB1N blocked on mine).
Safety tests from Sol lanes must be shown to fail against a broken variant. sleight's write guard refuses Bash text that
names sleight beside `$(...)` or heredocs: write text with the Write tool and append it with cat.

**Open follow-ups without a lane.** WG1 (Windows probe) and GE2's Windows engine questions. GV2 cache cap.

**Shell guard.** 1.6.0 includes GD7. GD8 (`codex/gd6` 9386cffd) was BLOCK and is stopped: its closes were spelling-exact and it
refused 24 of 35 ordinary `eval "$(tool init)"` lines. ROADMAP 12b (settings sealed with a key only the signed helper can use)
replaces the chase after the Apple Developer signing.

**Own runtime (ROADMAP 12: opt-in preview in 1.6.0, default in 2.0).** The banner has the line's state. Plan sources:
`ledger/vc/RT1-runtime-architecture.md` (items and the parity checklist), `RT1C-ge2-into-runtime.md` (RT26 to RT30, the sitting
plan in section 3, and section 5's engine bars from the owner's live sitting). GE2 (`ledger/vc/GE2-engine-open-questions.md`): the owner answered 27
questions, sleight-arch added Q31 to Q42. Still open live: covered-window drag, offscreen classification, secure-input
delivery, lock mid-turn, two sessions, event fields. RT31's study (`lanes160/rt31-REPORT.md`) found UTM's likely input limits
(inactive-window first click, a cleared first responder) and a UTM scripting input suite; its UTM-adapter and foreground-mode
questions are still the owner's (sleight-arch recommends no adapter, decide the foreground mode after the probe).

**agent-desktop head-to-head** (vercel-labs 1.0.2, raced from branch `codex/ad2` at c732fdd8 in `~/Projects/sleight-wt/ad2`). Windows 7
and 8: sleight passed 24 of 24 valid cells, agent-desktop 15 of 27. Where both passed, sleight's median was 2.1 to 10.2 times
faster (`ledger/vc/AD2-race-window7.md`). Race window 9 (`night/window9.sh`, never ran; set `END` and `AD4_BY`, whose defaults
0715 and 0700 are stale): sleight finder-move x3, agent-desktop finder-move x1, then AD4's 10-repetition per-action run. Needs
Finder with no windows, the owner away and Puddle's go. Then the published comparison.

**RA2 (typed `allow <app>` fails in the desktop app), a hypothesis, not proven.** The transcript row says `origin.kind:
human`, `promptSource: sdk`. The mod's own origin kind is unmeasured. Trace 0 (one owner-typed message in a desktop session
whose relay runs with `SLEIGHT_TRACE`) shows it. Traces 1 to 3 come before any decision on `SLEIGHT_DESKTOP_TURNS`
(`lanes160/reviews/ra3b-review.md`).

**Releases and public repo.** v1.5.0 and v1.5.1 (2026-10-30). The owner's install `~/Projects/sleight` is on main, plugin
cache 1.5.1. Public main is 68efb315 (CI pin to Claude Code 2.1.293). sleight-dev's push rule refuses branches containing its
`.github/workflows` change until the owner switches the rule off for one push. Public PR 1 (LDevine15) is open with
sleight-arch's review posted. Advisory draft `codex/di1b` ca160830 (publishing is the owner's). Engine 26.1027.30824.

**Owner items.** Dismiss ZCode's crash alert, then a new away window for the sittings. One supervised Cursor entry task.
Apple Developer Program signup (weekend of 2026-11-01), then the signing steps in `lanes160/rt18a-REPORT.md` (Owner
questions). Numbers on the benchmark allowlist (OS2). MB1's questions (`ledger/vc/MB1-mod-bootstrap-invariant.md` section 5): the live check of the mod's calls, mod-less sessions
in scope, an advisory for 1.5.0 and 1.5.1. WCB1's seven Windows clipboard questions (section 5 of
`ledger/vc/WCB1-windows-clipboard-invariant.md`), built with Fable's recommendations until answered. Keep or delete `~/Downloads/sleight-vm` and `~/Movies/sleight-film`.
RT31's two mode questions. RA2 Trace 0. RT24's locked-screen probe (needs registered input). The release calls above. UTM
clipboard sharing is off (owner confirmed three times). Never ask again.

**Background jobs, conventions.** Full checks run through `night/check-wt-nohup.sh <worktree>`, which stops on
`/tmp/sleight-hold` or at 60 min and reopens `night/lanes-may-test` and `/tmp/fable-sleight-window-done` when done.
`night/hold-quiet.sh` pauses lanes when a hold appears. Run `night/lane-waiter.sh` as `zsh night/lane-waiter.sh <ids>`; it
exits when one finishes. Puddle protocol: "window start" removes `/tmp/fable-sleight-window-done`, "window done" touches it.
Close `night/lanes-may-test` during Puddle's timed suites. Lanes: `ledger/vc/lanes160/startlane2.sh <id>` with `<id>.md`.
Reviews: `ledger/vc/lanes160/reviews/` (rules in `REVIEW-RULES.md`). Untracked and left alone: `.playwright-mcp/`, `cnt`,
`cnt.swift`, `tests/zz-probe.mjs` in this worktree, `docs/results/explore.html` modified in the ad2 worktree, and
`docs/benchmarks/2026-10-22-agent-install-public*` in `~/Projects/sleight`. Record: `ledger/vc/PLAN.md`.

**How work runs.** Sol codex lanes build, Sonnet-high agents review every branch, Fable does design studies, and sleight-arch
integrates and runs one full check per merge batch (`PATH="$HOME/.local/bin:$PATH"`, `SLEIGHT_LIVE_DOM_TEST=1`). This session
works in `.claude/worktrees/boot-sleight-arch-*` and pushes `private HEAD:pane/auto-mode`. Releases: `night/release-150.sh`,
`release-151.sh` and the squashed `release-160.sh`. Private terms: `ledger/vc/night/release-terms.json`.

**Opt-in flags after the A/Bs:** `SLEIGHT_FS=1` (FS1), `SLEIGHT_COMPACT_TOOLBARS=1` (replace-all +16%), `SLEIGHT_BROWSER_CORE=1`
(AS-3, never adopted). A/B off switches for the new defaults: `SLEIGHT_OPEN_SHOT=0`, `SLEIGHT_SCREENSHOT_READS=0`.

**Gotchas.** Never send Apple events to Office. Quit fixture apps with NSRunningApplication. Before an Office window, check
that Word and Excel aren't running. Finder fixture windows left open hold Finder at ~99% CPU. A leftover Calculator blocks
Calculator fixture setup. sleight's write guard refuses a Bash command that names "sleight" as a bare word beside `$(...)`:
write the text with the Write tool and append it with cat. HID idle 0 for 30 s means a person is at the Mac.

Bench setup: every Claude arm runs on the owner's login in its own config (`node bench/world/login-readiness.mjs` reads all five
native arms as logged in, 2026-10-16). The gate uses `--world` (both arms on the pinned Claude Code 2.1.289). Hand-run arm CLIs need
`DISABLE_AUTOUPDATER=1`: an arm's updater most likely removed `~/.local/bin/claude` on 2026-10-16 (restored as a symlink to
`~/.local/share/claude/versions/2.1.289`). FowlBrowser's extension is unpacked in Chrome's "sleight benchmark" profile and in Helium.

The away-sitting tool reads its steps from the list below, pinned by hash in `bench/away-sitting.mjs`.
Its first step (live checks with the owner present) is older than the Next list above.

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

## Machine state outside the repo

- The native claude-cu arm root `~/Library/Caches/sleight-bench/claude-cu` (Claude Code 2.1.289, installed 2026-10-16) is logged in
  on the owner's account, with onboarding, folder trust and `/mcp` computer-use enabled in its `work` folder.
- `~/Library/Application Support/sleight/turbo.json` (0600, Helium, enabled) was written 2026-10-16 12:49 UTC by the dev build.
- The FowlBrowser world arm's pinned Claude Code 2.1.289 is at `~/.config/sleight-bench/world/arms/fowlbrowser` (installed
  2026-10-14 for the prototype rounds, `node bench/world/arms/install.mjs fowlbrowser claude-only @anthropic-ai/claude-code@2.1.289`).
- Benchmark arms installed 2026-10-14 (owner's 2026-10-12 OK, pinned with checksums). Cua 0.34.0 is at
  `~/Library/Caches/sleight-bench/mcp-cua-arm` (the grants are on CuaDriver.app itself). Peekaboo
  4.9.2 is at `mcp-peekaboo-arm`, and its grants go to Terminal.app (owner's pick), so Peekaboo passes run from a Terminal window. Runtime
  folders `~/.cua-driver` and `~/.peekaboo`. Removal steps are in each arm's setup plan (`bench/world/native-setup.mjs`).
- Playwright's Chromium 1248 and its headless shell in `~/Library/Caches/ms-playwright` (installed 2026-10-14 on the owner's OK)
  for real-page tests with FowlBrowser's playwright-core 1.64. Builds 1228 and 1234 are still there.
- Remote debugging is on in the Chrome "sleight benchmark" profile and in Helium (`chrome://inspect/#remote-debugging`, turned on
  by the owner 2026-10-13) for turbo's qualification. The owner turns it off on the same page.
- The Claude in Chrome arm's pinned Claude Code 2.1.289 (`~/.config/sleight-bench/world/arms/claude-in-chrome/node_modules`) was
  rebuilt with its install script approved (`npm approve-scripts @anthropic-ai/claude-code`, 2026-10-13). Its login is stored
  in that arm's `claude-config` (Max plan).
- `~/.codex/browser/config.toml` `[origins] allowed` holds `http://127.0.0.1:*` (owner's request, 2026-10-13), the engine's own
  store for "always" site approvals, read for every browser it drives. Backup: `config.toml.before-localhost-20261013T031052Z`
  beside it. Remove that line to undo.
- Daily launchd job `com.landoclusters.sleight-watch` (9:00, `scripts/watch.sh`), daily since
  2026-10-10 on the owner's OK because a competitor hinted at an engine change; weekly with
  `npm run watch:install`. It saves the engine's API docs, without sleight's skill since 2026-10-10
  (`~/Library/Logs/sleight/engine-api-26.1007.30912.md` is the latest), and diffs them on an engine
  update. Remove with `npm run watch:remove`.
- `~/Library/Application Support/sleight/preapproved.json` lists Calculator (owner, 2026-10-04), Helium (`net.imput.helium` and
  `Helium`, owner's order 2026-10-05, kept 2026-10-08) and five always-allow entries from the owner's clicks: `dev.zcode.app`,
  `com.todesktop.230313mzl4w4u92` (2026-10-11), `com.apple.ScreenContinuity`, `com.anysphere.sand`, `com.google.Chrome` (2026-10-12).
  The list before Helium is `.dev/tools/preapproved.before-helium.json`.
- `ComputerUseAllowForbiddenTargets` is on (`defaults write -g`, set by the owner 2026-10-05, kept on
  2026-10-08 so agents can drive terminals for tests). Terminals and OpenAI's apps go through the engine
  for every engine client, Codex included. Off: `defaults delete -g ComputerUseAllowForbiddenTargets`.
- `.dev/tools/`: probe and timing clients for sleight's launcher, the CNN trial, transcript
  dumpers, and `dialogs.swift` (lists permission dialogs on screen).
- LCU 0.11.2 runtime-only at `~/.local/share/lcu` (installed 2026-10-10 on the owner's OK, with 0.8.8 kept
  in `releases/`). The benchmark's arm is `~/Library/Caches/sleight-bench/lcu-arm`, made by
  `node bench/lcu-arm-setup.mjs`.
- Chrome profile "sleight benchmark" (account-less, made by the owner 2026-10-12 18:40 EDT) holds Claude in Chrome, signed in
  with the owner's Claude account, for the benchmark's Claude in Chrome arm. Never drive the owner's main Chrome profile.
- REA (`rea-agents` 6.4.0, CLI only, `npm install --global`, no `rea setup`, so no agent configs changed) and Homebrew `ghidra`
  12.1.4 with `openjdk@21`, on the owner's OK (2026-10-12). `~/.zprofile` exports `GHIDRA_INSTALL_DIR`. Hopper and IDA aren't
  installed. Clean-room rule in LAWS.
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
  It has listed only Word and Codex since 2026-10-11. The owner's 6 apps are in
  `ComputerUseAppApprovals.before-2026-10-11T14-19-10-653Z.json`, and the owner will restore it later (owner, 2026-10-17).
- `~/Library/Caches/sleight-bench/keyboard-taps`: compiled from `bench/keyboard-taps.swift`, lists
  keyboard filter taps. The runner builds it if missing.
- The watch's baseline (`~/Library/Logs/sleight/watch-engine-version`) is 26.1007.71326 (checked 2026-10-14).
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

## Waiting on the owner (older)

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
