# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-09 22:40 UTC)

The owner is away from the Mac and working from their phone. Their bar (ROADMAP track 3, 2026-10-09):
lightning quick, quick under any load, no noticeable load on the Mac, measured against Codex on the
same engine. `pane/auto-mode` matches origin, and there are no open PRs. Engine 26.1002.52244, doctor ok
(21:42 UTC). Nothing is running and the live lock is free.

**Puddle's window 1009o** (train 86's pairs) starts no earlier than about 23:00 UTC and ends about
23:45 UTC. Puddle arch messages this session (sleight arch, `local_314380cf`) with a firm start at
least 15 minutes ahead. sleight finished app driving at 22:32 UTC and told them. No app driving
during a window. Ask before any run that adds load (memory `shared-mac-quiet-windows`). At 21:49 UTC
the load average was 54, none of it ours: five `floati-codex-wait` Python processes from
`~/.codex/floati-wake` at a full core each (one 26 minutes old), Puddle's CI `swift-test`, and Finder
at 68%.

Tonight's quiet stretch (21:47 to 22:32 UTC, the owner away), all published:
- The open-menu note and guard stops passed live in Calculator. With the View menu open, element 0
  read as the bar item and element 1 as `menu Secondary Actions: Cancel`. The note pointed at
  element 1, and `performSecondaryAction(1, "Cancel")` closed the menu in 445 ms. Both guard stops
  returned the full tree. A popup menu at element 0 wasn't tried.
- Office passed with Excel 1/1 (100.4 s, 29 turns) and PowerPoint 1/1 on a second try (51.7 s, 16 turns) after a
  Microsoft 365 first-launch notice failed the first try's setup (`docs/known-problems.md`).
- Footprint against Codex, 6/6 per arm: sleight 51.9 CPU seconds (47.5 without the owner's plugins),
  Codex 37.1. The gap is in the engine's node process (guard reads), Claude Code and `osascript`.
- First-call batching, 24 runs a side in two rounds: on 24/24 in 168 turns and 780 s, off 23/24 in 208
  turns and 835 s. It's now the default (`SLEIGHT_FIRST_CALL_BATCH=0` turns it off).

Released: `v1.1.0` (`0b6a1c0`, 2026-10-09), on `main`. Unreleased on `pane/auto-mode`:
- Live-checked: full screen and Split View detection; one app-health helper per session
  (`818f7e7`, `025460d`); the guard's read skipped after typing, pasting or a plain key (`44700ee`,
  `db45c94`, owner's call); the reuse check that never checked now reads (`e66791a`); degraded reads
  under load (`7d63e48`, `674502d`); Sol's real-use suite through brief 11 (`874a280`) and the Codex
  arm for it (`768cbcd`); per-run CPU footprint (`2cf4394`, `2c30446`); a guard stop includes the
  current window (`94db208`); the open-menu note's call works (`202b184`, not yet run with Claude);
  first-call batching on by default (24/24 on four tasks).
- Unit-tested only, from a study of the slowest head-to-head runs. `drag` refuses an uncoverable drag
  before scanning (`94db208`). The first action checks its numbers against what Claude last saw, and
  Claude's read stands in only when it took over 2 s (`f76ee76`). Labels match settable fields and
  menu items named alone (`acf4b8d`).

Head-to-head (published in `docs/benchmark.md`): at normal load sleight 20/21 in 904 s against Codex
16/21 in 1,292 s on the default tasks, and 12/12 in 396 s against 11/11 in 429 s on six real-use
tasks. Under 20 CPU workers (9 runs, stopped early) both timed out on Calculator, and sleight's
reads before clicks by ID cost tens of seconds each.

Working in parallel since 22:59 UTC (owner: "spin subagents ... let's get this done"). Briefs are
in `.dev/prompts/`, for Sol threads the owner starts:
- `sol-footprint-spawns.md` (`codex/footprint-spawns`): per-call `osascript`, the browser-discovery
  engine at launch, the 29.5 s first acquisition, SQLite per lease operation, the turn-end tap scan,
  the pane snapshot.
- `sol-replay-next.md` (`codex/replay-next`): replay steps that wait for the app, and Claude taking
  over at the step that stopped.
- `sol-small-fixes.md` (`codex/small-fixes`): exact `typeText` after select-all, clipboard
  preservation's 205 to 236 ms, localized settings titles in `blocked_app`, `menu_bar` guard tests.
- `sol-doctor-flow.md` (`codex/doctor-flow`): doctor probes a per-app read, and per-site flow rules.
- `sol-other-hosts.md` (`codex/other-hosts`): sleight from Cursor, Codex CLI and plain MCP clients.
- Follow-ups after review: `sol-replay-next-2.md` (the bridge parses every message) and
  `sol-footprint-spawns-2.md` (browser surface always on, one 2 s helper for slow operations).
- The launch post's real-use line is filled (`~/Desktop/sleight-launch/thread-1.0.md`, 23:58 UTC).
- Merge study (subagent, 48 runs): with batching on, Claude chained past Cmd+N or Cmd+O and the lease
  stopped 10 of 12 TextEdit batches. `eb7c653` tells it to end the call there (needs benchmark runs).
  Asked the owner (00:05 UTC) whether the guard may accept a window the call's own shortcut opened or
  renamed in the same app (save and open panels, new untitled windows, a saved name). TextEdit save and edit would
  go from about 6 calls to 3. Risk: a window the user opens in that app at that moment is accepted.
- Live, 00:37 to 00:38 UTC (Calculator, relay at `e12aef4`, change review off as the launcher sets
  it): a split acquisition then `click({ id: "One" })` used the acquisition's read (`reused`, no
  read before the click). A call with only an acquisition wasn't split, so `565f369`'s no-action
  header is still unit-tested only. Merged: `codex/replay-next` as `e12aef4`. Follow-up for
  `codex/small-fixes`: `.dev/prompts/sol-small-fixes-2.md`. Puddle's next window 1009r starts about
  00:50 UTC for about 40 minutes, so `/tmp/sleight-hold` stays.
- Reviews (four code-review subagents, 00:40 UTC): `codex/doctor-flow` merged as `83188cf`, with a fix
  (a new tab's destination is the browser in the bracket form too). Follow-ups to paste:
  `sol-footprint-spawns-3.md` (extension cache too short, stale SQLite connection, a shared slow lane,
  no live check of the JXA loader) and `sol-other-hosts-2.md` (the owner's Claude-first wording and
  README move, no Codex CLI, plus six fixes). `sol-small-fixes-2.md` from before still applies.
  Puddle's 1009r runs about 00:55 to 01:50 UTC.
- More briefs (00:15 UTC on 2026-10-10): `sol-replay-desktop.md` (replay from the `/sleight` pane),
  `sol-verified-results.md` (input sent, UI changed, saved), `sol-scoped-approvals.md` (design only:
  read, control and sensitive scopes, expiry, irreversible confirms). sleight-arch: a published table of
  what works in the background. Puddle reruns any pair a Sol test burst touches, and installs Floati
  v0.1.3 (the `floati-codex-wait` CPU fix, a shared `~/.codex` hook) after 1009r.
- After 1009r (01:17 UTC on 2026-10-10): `--doctor Calculator` live declined without a prompt but ignored
  the user's pre-approved list (follow-up `sol-doctor-flow-2.md`). Affected tasks with Claude driving
  tonight's changes passed 15/15 at `7c8e357` (`docs/benchmark.md`): textedit-save 15 turns a round
  against 20 to 23. `docs/background.md` (what works in the background) published. Puddle: no Floati
  install on this host after all.
- Merged `codex/other-hosts` as `6ca6639` (01:45 UTC), with the claude* name match and the README's
  Claude Code requirement restored. Still out with Sol: footprint-3, small-fixes-2, doctor-flow-2,
  replay-desktop, verified-results, scoped-approvals.
- Merged `codex/small-fixes` as `05903fa`. Its skill bullet (compare before saving) passed 6/6 on
  textedit-save and textedit-edit, but textedit-save took 19 turns against 15 before. Watch it in the
  release pass and drop the compare step if it keeps costing a turn.
- 02:10 UTC: merged `codex/doctor-preapproved` (`ac9f0d2`, which read Calculator live in 156 ms with the grant
  audited), the scoped-approvals design note (`2cf81d0`, not built, the owner's call) and
  `codex/footprint-spawns` (`7d880dc`). Follow-ups to paste: `sol-replay-desktop-2.md`,
  `sol-verified-results-2.md`, `sol-footprint-spawns-4.md`.
- Footprint gate (02:10 UTC on 2026-10-10, `docs/benchmark.md`): sleight 45.8 CPU s of its own
  against Codex 38.7 (gap 7.1, was 10.4), 154 s against 239 s. Left: engine node +3.3 (guard reads)
  and `osascript` +2.2 (the per-read app probe). Not at parity, so ROADMAP 3.5 still holds the release.
- Briefs for the remaining rows: `sol-sim-savelock.md`, `sol-lease-broker.md`,
  `sol-review-receipts.md`, `sol-routines-demo.md`. Removing the helper's stale launchd job stays
  manual (doctor prints the command): it would change OpenAI's helper state (LAWS).
- sleight-arch: the guard's reads (`document-scope.mjs`, guard code in `relay.mjs`), with a
  background subagent studying guard-read phases across tonight's traces.
- `/tmp/sleight-hold` exists while another project's window runs. Every brief stops live probes
  while it's there. sleight-arch removes it when Puddle releases the Mac.

Guard reads (sleight-arch): `565f369` lets a call with no action after a split acquisition use that
read as its header (53 reads, 27 s in tonight's traces) and traces skipped reads, which the relay's
parser used to drop. Unit-tested, live check after 1009o. The owner agreed (23:20 UTC) to reuse a
split acquisition's read for the first action when the app was already running with a window:
`08abe24` (173 refusals, 98 s since `e66791a`), unit-tested, live check after 1009o.
Sol's `codex/replay-next` (`de4db37`) landed and was reviewed: the logic is right, but its bridge parses
and re-serializes every message of every session. Follow-up `.dev/prompts/sol-replay-next-2.md`, then merge. The trace study (227 runs) found reads before later numbered
actions caught 12 renumbers and 23 window changes in 924 reads (572 s). sleight-arch recommends
keeping them.

Next, in order:
1. Footprint: cut guard reads. Each call made about two (7 to 15 a run), the read after a call when
   nothing returned a header and the reads before each numbered action in a batch.
2. Review and squash the Sol branches as they land, with each one's live check.
3. A full release pass with the owner away, then reread README whole and release (LAWS). ROADMAP
   3.5 holds the release until the head-to-head shows Codex's footprint.

Branches and worktrees:
- `pane/auto-mode` in `~/Projects/sleight`: the working branch. A release fast-forwards `main` to it.
- `codex/real-use-tasks` (`1a73515`, `~/Projects/sleight-wt/real-use-tasks`, Sol, idle): applied
  through `1a73515`. Apply Sol's next commits as a diff the same way.
- Merged, safe to remove with their worktrees: `arch/codex-real-arm` (`~/Projects/sleight-wt/codex-real`),
  `codex/guard-speed` (`~/Projects/sleight-wt/guard-speed`), `fix/drag-chess`.
- `perf/screenshot-scale` (`1aa574b`, `~/Projects/sleight-wt/shots`): parked. Older `codex/*`
  worktrees: earlier rounds. Leave them.
- Proposed, not started: a session card "Replay: steps that wait for the app" (task `task_3df10eb3`).

Waiting on the owner: watching Mail and Mimestream (about 10 minutes). Left on their screen: about
seven Safari fixture windows, two Helium, six Preview `Pages-*.pdf`, Word and Excel with fixture
documents, and a TextEdit "Untitled 6" in their iCloud TextEdit folder, probably a benchmark
leftover (check it only by exact content, never by browsing their files).

Owner's plan after 1.0 (2026-10-09), run in order without check-ins: (1) the real-use pass and the
Codex head-to-head on it (done at normal load; see Next), (2) the launch post
(`~/Desktop/sleight-launch/thread-1.0.md`, whose real-use line is still [PENDING]), and (3) replay's
next steps. The full plan is `docs/status/ROADMAP.md`.

Read first: `docs/known-problems.md`, `docs/benchmark.md`, `docs/design/guard-reads.md`.

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
- The weekly watch's baseline (`~/Library/Logs/sleight/watch-engine-version`) is 26.1002.52244, set by
  hand on 2026-10-08 after the diff was captured.
- `~/Library/Caches/sleight-bench/sleight-arm`: the benchmark's sleight arm folder.
- Scratch clients from 2026-10-09, in the session's scratchpad (gone after the clear): rebuild a
  relay client with `bench/double-keys-client.mjs` (`probeClient`, `relay: true`), and a full-screen
  fixture with a small Swift app calling `toggleFullScreen` (see the 2026-10-09 notes in
  `docs/benchmark.md`).
- `.dev/` (untracked): test CLI, old `sleight-arm` and `lcu-arm` bench folders, `DragProbe.app`, the
  compiled `textedit-drag-fixture`, pseudo-terminal harnesses, research, prompts.
- Direct drag test: open a temp file with `open -g -a TextEdit`, run
  `.dev/textedit-drag-fixture <path> select-drag`, run `.dev/tools/drag-direct.mjs` with the from/to
  points and window id, then `<fixture> <path> read`. Use `select-drag`, never `select`: plain
  `select` drops in the title bar.

## Waiting on the owner

- Watching the Mail and Mimestream tasks.
- The OpenAI key note is theirs to handle. Don't raise it again (owner, 2026-10-09).

## Reading list

- `docs/status/ROADMAP.md`: everything we intend, in order. Any correction from the owner about the
  plan is written there in the same turn, and a question about the plan is answered from it whole.
- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
