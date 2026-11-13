# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-19 20:50 UTC, 1.3.1 candidate live checks running, 1.4.0 fix lanes and studies in flight)

Goal (owner, 2026-10-19): push 1.3.1 public today when every check is done (release push approved, ETA ~9 PM ET), then
validate and release 1.4.0. Before the 1.4.0 B rounds every loss gets improved as far as we can (owner, ROADMAP). The ledger
(`~/Projects/sleight-wt/ledger/LEDGER.md`) records every result and ruling in time order. Builds, fixes and integrations go to
Sol codex lanes. Sonnet-high reviews and Fable studies stay on Claude.

**1.3.0, released 2026-10-19.** Tag `v1.3.0` on `ca2188b4`, public `main` and the private repo, GitHub release from the CHANGELOG.
Public CI runs on Node 24 (the Node ChatGPT bundles). The private repo's org ruleset 22105960 refuses workflow edits; the owner
okayed one toggle (disable, push, re-enable, verified active). Release line `pane/auto-mode` c4625506 (private, local, main
checkout). The owner's installed copy is 1.3.0 (`claude plugin update`, reads from the main checkout). Claim: native "fastest" 8 of
9 (251.2 s against 453.9 s), app 3 of 3, Chrome turbo "fastest" 10 of 13 on the release build (258.9 s against 447.8 s), Safari and
Firefox "fastest" 11 of 12 (592.1 s, 557.1 s), sleight inside Codex (luna) ahead of Codex on 9 and 8 of 12, release pass 13 of 13
on Haiku and on Opus. Helium on the release build (2026-10-19, rel130 r1-r5, owner's go): "fastest" on 10 of 13, 264.1 s
against FowlBrowser's 343.6 s, every pair within 20% at 5 runs (README updated, hub not regenerated yet). Known 1.3.0 problems found
since: the startup cache (HS1) and the promo-code Apply stop (PG2), both in known-problems.

**1.3.1 candidate, `claude/p131-integration` 6b75fc01 (pushed private, full check 9094 tests with 0 fail, version 1.3.1).**
Since 60fe1319: flag A/B verdicts (FL2: SLEIGHT_OPEN_SHOT and the screenshot skill sentence on by default, compact
confirmations removed, compact toolbars still opt-in, race-1017/flags-score.txt, docs/benchmarks/2026-10-19-flag-ab.md),
CF4 Safari fixtures bound to the benchmark profile (the compat check had opened its page in the owner's Personal Safari profile),
the compat title-window fix, CHANGELOG 1.3.1 lines. In the AS-3 A/B Haiku called browser_open 0 times in 30 tasks, so it
remains opt-in behind SLEIGHT_BROWSER_CORE=1 (CHANGELOG says so). Live today on the candidate: SW1b demoid passed 3/3 with popup and opener lines. In compat the engine tier and the
Calculator check passed and the browser read failed on the title window (fixed, rerun queued). H8 was inconclusive
(2 no-geometry skips, 0 hand drawn); H5 not proven and DR1 window-drag 0/3, both with a leftover bench Finder window on top
(closed by AX, reruns queued). Still to run: H6 (running), block-rel131b (compat, H5, DR1 reruns), Electron qualification
(cards are sleight-arch's on benchmark VS Code), Codex turbo cxt1 (maybe one hook-trust prompt for the owner), the Chrome
release pass with the TU1 census, then CHANGELOG date, history rewrite and public push (ruleset toggle is the owner's), tag,
GitHub release, the owner's installed copy. Film T1 retake on claude/p131-t1-cf4 0105a301 after the checks.

**1.4.0, `claude/p140` ab510184 (pushed private).** Everything listed in ledger 15:4xZ-17:44Z plus H7 (README, INSTALL,
known-problems top, static hub, with the owner's read as the last step). In flight for 1.4.0: X12 (merge the 1.3.1 candidate),
MTb (fixes to MT1-MT7 model-time wording, claude/p140-mt), studies done and queued for build after X12: RS (requested sign-ups,
owner ruled yes, LAWS), AO (browser_open adoption, AO1-AO7), NL1/NL2 (preview-read, Finder move chain). CK (claude/p140-ck
53bdfa1e) is BLOCKED by design because each shortcut skipped a proof. CK1-CK3 get a redesign with GR1 (Astra, Firefox guard read
cost, running). LB7 not merged (no measured win). 1.4.0 validation per ROADMAP after these merge.

**Running now.** `race-1017/block-rel131.command` (H6 last) then `block-rel131b.command` (compat, H5, DR1 reruns), Terminal.
Lanes: X12, MTb, GR1 (Astra). Worktrees: race-131 at 452c1aef (candidate before the compat bench fix), race-fx 1f6efff2 (1.3.0),
p131-int, p140, p140-mt, p140-ck, p131-cf4, p131-t1-cf4.

**Launch film.** T0b recorded and approved by loc arch (sRGB tagging and name scrubbing added). T1 runner built (plain "Thursday"
front window, Chess 1157x900, payment-free Tidewell checkout); three attempts stopped in setup (Chess open, Chess width, Safari
marker), all fixed. T2 race take (sleight turbo vs FowlBrowser, one task) not built yet. loc arch renders only while
`race-1017/CLEAR` exists and holds `/tmp/sleight-hold` per segment: ask loc arch before removing a hold.

**Opt-in flags after the A/Bs:** `SLEIGHT_FS=1` (FS1), `SLEIGHT_COMPACT_TOOLBARS=1` (replace-all +16%), `SLEIGHT_BROWSER_CORE=1`
(AS-3, never adopted). A/B off switches for the new defaults: `SLEIGHT_OPEN_SHOT=0`, `SLEIGHT_SCREENSHOT_READS=0`.

**Gotchas from 2026-10-17.** Never send Apple events to Office from this session (Excel had no Automation grant and a macOS prompt
appeared). Quit fixture apps with NSRunningApplication and answer their own Don't Save sheet or dialog by System Events. An
AX-opened menu loop releases with one Escape posted to the pid. Finder fixture windows left open held Finder at ~99% CPU for
hours, so close them after Finder passes. A leftover Calculator blocks Calculator fixture setup.

**Machine notes from 2026-10-16.** Office was cleared by hand three times: arms leave Word or Excel behind dialogs (Find and Replace)
and a force-quit leaves a "Recovered" fixture. Before an Office window, check that Word and Excel aren't running, and close any
`Report-*` or `Inventory-*` recovered document with Word scripting (`close ... saving no`), never AX presses. Puddle gives 10-minute
gaps between windows and wants 15 minutes' notice before a long one. Its spin guard renices spinning waiters (nice 20).

How work runs. Sol codex lanes build, Sonnet-high agents review, and sleight-arch integrates and runs one full check per merge (`npm run check`,
with `PATH="$HOME/.local/bin:$PATH"` so `claude plugin validate` uses 2.1.289). Every real-page test needs `SLEIGHT_LIVE_DOM_TEST=1`.
Benchmark windows come from Puddle's architect. Ask with a length and a cap, start on "HOLD live", and release with one fresh
touch of `/tmp/sleight-bench-done`. The scripts in `ledger/claims/GATE2/` (gate5.sh with `REPO`, `SPECS`, `PREFIX` and `MODEL`) do the touch.

This session works in `.claude/worktrees/boot-sleight-arch-*`, because a hook refuses edits in the main checkout: commit there,
`git push private HEAD:pane/auto-mode`, then `git -C ~/Projects/sleight merge --ff-only <branch>`. A release also pushes
`HEAD:refs/heads/main` and the tag to `origin` with `SLEIGHT_RELEASE_PUSH=1` (owner's call), then `gh release create` from the
CHANGELOG section. Public CI is Linux, without `npm install`, on Claude Code 2.1.288. Released so far: `v1.2.0` to `v1.2.5`
(2026-10-11) and `v1.3.0` (2026-10-19, public `main` `ca2188b4`). The owner's install is 1.3.0. Public `origin/pane/auto-mode`
stays at `332e3ca`. A workflow edit needs the org ruleset off for the private push (owner's call each time).

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

## Waiting on the owner

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
