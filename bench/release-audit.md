# Release audit: README.md

For the release (ROADMAP 5b, LAWS: every release rereads README.md whole). Every claim in README.md
with a number, a version, a pass result or a behavior, checked against the repo at `038cafa`
(`codex/release-prep`, 2026-10-10). Evidence is docs/benchmarks/ and CHANGELOG's Unreleased section
unless another file is named. README itself is unchanged. Verdicts: true, stale (current figure and
its source), unsupported (no source in the repo).

## Every release

After saving the release pass and A/B results, run `nice -n 20 node bench/results-hub.mjs` to collect and render the hub.
Review the changed numbers and commit `docs/results/` and the root README's generated blocks before tagging.
Then run `nice -n 20 node bench/results-hub.mjs --check`. A difference fails the release preflight with `hub: stale-output`.
Prefix each command with `CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX)` on the benchmark Mac.
The check reads results and draws files only. It does not launch apps or run benchmarks.

Confirm that every family page links a static SVG in `docs/results/charts/`, and that the interactive page offers all seven
families. Record which families have no new raw results. Missing external folders keep their saved data; they do not prove
that a new release was measured. See [release preflight](../docs/release-preflight.md) for the automated check.

## Claims

| README claim | Evidence today | Verdict |
|---|---|---|
| The engine sends clicks, drags and keystrokes to the app itself, which can be behind other windows the whole time (L29-32) | LAWS, The engine. docs/background.md | true |
| Demo caption: "at 6× speed" (L35) | no provenance in the repo | unsupported (cosmetic) |
| Needs macOS on Apple Silicon (L39) | known-problems, Hosts and platform. The Linux case was checked 2026-10-04 and Windows is unchecked | true |
| Claude Code 2.1.275 or later (L39) | stated only in README. No changelog line, test or doc records what needs it | unsupported (see the version gap below) |
| The first Computer Use run in Codex installs the helper and gets the macOS grants. Signing out afterwards is fine (L40-42) | ROADMAP 5b.7 (installer status "OK", install asked admin and exited 0). The puddle-census engine ran without a sign-in | true |
| The setup section on `sleight-mcp setup` (L59-63): it finds ChatGPT and runs OpenAI's installer when the status isn't OK. It opens the Accessibility and Screen Recording panes and runs `--doctor`. The installer needs admin. A never-signed-in user's engine listed apps (2026-10-10) | CHANGELOG Unreleased. ROADMAP 5b.7 probes v1 to v3. A full setup run hasn't been tried live | true (full run pending) |
| First approval covers the app for the session. "Always allow" covers it from then on. Codex and ChatGPT approvals are honored (L71-74) | CHANGELOG Unreleased (prompt button, unit-tested). LAWS (ComputerUseAppApprovals.json is read to sleight) | true |
| Update commands. A running session keeps its version (L76-77) | documented claude CLI behavior, not checked here | true |
| Also runs as a plain MCP server (L79) | docs/other-hosts.md. Stdio discovery passed 2026-10-10. The paired live run is pending | true |
| Background actions measured. Few pointer fallbacks, each asks first (L84-85) | docs/background.md, runs dated 2026-10-05 to 2026-10-10 | true |
| With two sessions typing into one document, text doubled in 5/5 trials without leases and appeared once in 5/5 with them (L86-88) | CHANGELOG (0.x, "once with one refusal in 5/5"). 2026-10-03-input-lease.json. 2026-10-04-input-lease-final.json | true. README drops "with one refusal" |
| Never clicks a stale element. A renumbered batch click follows the same element. It caught two clicks that would have hit the menu item next to the intended one (L89-92) | CHANGELOG 0.10.0 ("Two of its three refusals stopped a click that would have hit the next menu item") and 0.12.0 (an 11-click batch stopped at the second click). 2026-10-05-compact-reads.md. The Unreleased renumbered-click bullet | true |
| CNN front page, five scrolls: 39,655 characters instead of 203,160 (L93-94) | 2026-10-05-compact-reads.md. CHANGELOG 0.10.0 | true |
| One approval per app per session. Terminals and OpenAI's apps stay off. Each terminal command shown (L95-98) | LAWS, Approvals and safety. docs/settings.md | true |
| Tasks in Calculator, TextEdit, Chess and an iPhone simulator, three runs each (L99-100) | docs/benchmark.md. The release results files each list 21 runs (7 tasks × 3) | true |
| The 1.1.0 release pass passed 20/21 (L100) | 2026-10-09-release-1.1.0.json: 20 of 21 | true |
| A 13/21 pass run from another Space is published (L101) | 2026-10-08-await-split-view.json: 13 of 21 | true |
| The Chess head-to-head sleight lost 0/3 to 2/3 (L102) | 2026-10-09-h2h-chess-simulator.json: chess-drag sleight 0/3, Codex 2/3 | true |
| sleight drags text the engine's own drag fails to move, and reaches menu bar icons and notification banners. Each needs its own approval (L104-105) | known-problems (engine app.drag failed 9/9). The menu_bar and notifications tools. LAWS | true |
| The Claude comparison section quotes Anthropic's documentation, read 2026-10-04 (L109-113) | the citation is in place. Not re-read for this audit | true (as a citation) |
| README says two sleight sessions ran together and sleight ran next to Codex (L116-117) | the input-lease races ran two relays. Every Codex h2h runs both arms on one Mac | true |
| The pane, status line and receipts arrive on Claude Code v2.1.287 or later (L127) | 2.1.287 is sourced only for the mod's turn-end hook (how-it-works L25, CHANGELOG). No source ties the watching features to 2.1.287 | unsupported (see the version gap below) |
| Pane: /sleight, prompt passthrough, refresh, half-blocks, the Code tab screenshot (L129-133) | known-problems (0.15.3-pane.2 desktop check: pane, picture, 6 actions, status line). LAWS 1.0 conditions | true |
| Status line shows the app and action count (L135) | the same desktop check | true |
| Receipts: off by default. Text inputs, printable keys and titles redacted. At most seven days or 200 files. Pane link. Optional unsaved review (L137-142) | plugins/sleight/lib/turn-receipts.mjs (200 files, 7 days). CHANGELOG Unreleased. 2026-10-10-review-receipts-2.md | true |
| /sleight stop works mid-turn and refuses further calls until the next message (L144-145) | CHANGELOG Unreleased (waits-targeting). Unit tests. Live checks pending | true (live checks pending) |
| The pane snapshots only between turns. The engine diffs against the latest read (L147-150) | LAWS, The engine | true |
| record never replaces a file. Replay uses the session's approvals and lease, stops at the first unready step and hands off to Claude. Stop cancels (L154-165) | CHANGELOG Unreleased (replay-desktop, replay-next). docs/design/replay.md. Mod and relay tests. Desktop clicks await the owner | true (desktop check pending) |
| CLI record/replay. The session id is the transcript's file name. The shell replay asks in the terminal (L167-178) | CHANGELOG Unreleased. docs/design/replay.md | true |
| `routine add --every 15m`. Install asks in the terminal. Removal asks for "remove". Two minutes idle. Existing windows. Preapproved apps only. A stop pauses with a notification (L182-186) | CHANGELOG Unreleased (routines). 2026-10-10-routines-live.md (run-now passed 10/10 behind the idle gate). known-problems Routines | true. A launchd-scheduled run needs a release that contains routines (routines-live, item 3) |
| `record --watch` for Calculator or TextEdit runs 60 seconds or until Ctrl-C, and doesn't ask for a new permission (L188-191) | plugins/sleight/lib/demonstration.mjs (seconds = 60). 2026-10-10-routines-demo.md | true. It has never run live (routines-live) |
| `js` runs as you. Claude Code asks per call unless allowed. Per-app approvals still apply (L195-198) | docs/settings.md. LAWS | true |
| Pointer fallbacks wait for 2 s without input. Drag goes through Accessibility first and refuses covered or out-of-content endpoints. Hover refuses covered points, about 2 s dwell (L199-206) | CHANGELOG 0.16.0 and Unreleased. known-problems, drags and hover | true |
| Every part of the inventory line (launcher, relay, mod, skill, two manifests, macOS scripts) is in the tree (L207-208) | all present. plugins/sleight has bin/sleight-mcp, lib/relay.mjs and skills/drive-mac-apps. The manifests are .claude-plugin/marketplace.json and plugins/sleight/.claude-plugin/plugin.json. drag.js, hover.js and menubar.js are the macOS scripts | true |
| Troubleshooting rows on the missing plugin, the MISSING helper, the timeoutReached diagnosis, the two responsive AX apps, 0.1.1, 0.3.1, the launchctl remove advice and post-update breakage (L214-222) | CHANGELOG 0.1.1 and 0.3.1 cover the version rows. known-problems covers the rest (helper health, the 6/6 revised diagnosis, the launchd job) | true |
| Troubleshooting: "Claude Code too old for form elicitation" (L218) | no version or source recorded anywhere | unsupported (see the version gap below) |
| Development commands (L229-234) | package.json scripts | true |
| Update watch: engine-api snapshots, a diff on version change, Mondays at 9:00, `--daily`, a first-run baseline, Calculator auto-approved (L239-254) | scripts/watch.sh. scripts/watch-install.sh ("weekly (Mondays at 9:00) or daily"). package.json | true |
| Roadmap checkboxes (L261-286) | spot-checked: document scope (2026-10-03-document-scope.json), change review (2026-10-03-change-review.json), the LCU h2h (2026-10-03-sleight-vs-lcu.json). Stop in the desktop Code tab is still open (known-problems) | true, with two notes below |
| The Windows line's date, Codex computer use there since 2026-05-29, foreground only (L280) | docs/design/windows.md research. The date is not verifiable in the repo | true (as research) |

Notes on the roadmap:

- "Review unsaved changes and app state without backing files" (L285) is open, and
  `SLEIGHT_STATE_REVIEW=1` merged a partial step: it lists changed windows and names native Undo and
  Revert controls without activating them. The checkbox is defensible. The release notes should
  carry the partial.
- Every number in README matched its source today: 20/21, 13/21, 5/5, 39,655 and 203,160, 0/3 to
  2/3, 0.1.1, 0.3.1, 60 seconds, seven days or 200 files. The unsupported claims are the two Claude
  Code minimums without a recorded source, and the 6× caption.

## Results page, regenerated (2026-10-10)

- Rebuilt docs/results from 15 published results files: the seven release passes,
  2026-10-03-sleight-vs-lcu.json, 2026-10-10-h2h-guard-2.json, -h2h-save-check.json, -h2h-3.json,
  -h2h-4.json, -h2h-5.json, -shop-1.json and -shop-2.json. The afternoon runs are described in
  2026-10-10-h2h-afternoon.md.
- 2026-10-10-calculator-turns.json is left off the page. results-page.mjs crashes on it
  (`TypeError: Cannot read properties of undefined (reading 'split')` in byVersion), because a
  single-arm file without `-release-<version>` in its name is classed as a release pass with no
  version. The file is published in docs/benchmarks. Fixing the generator is outside this lane.
- The generator keeps only the newest head-to-head per rival, by stamp. shop-2 (19:52 UTC,
  safari-shop, 1 run a side) is now the page's Codex head-to-head. The 18-run h2h-5 (19:07, 9/9 a
  side, the pass ROADMAP 5b.1 rests on) and shop-1 (helium-shop passed both arms, safari-shop
  failed fixture setup on both before the title-nonce fix) are published in docs/benchmarks but no
  longer on the page. Whether to keep the latest full-suite h2h, or list shop runs separately, is
  a generator policy decision for sleight-arch.

## Release checklist gaps

- Replay. Desktop button delivery and automatic handoff need the owner's check in the Code tab
  (known-problems, Desktop replay). A pane replay is untested in Auto mode. A script over 4 MiB
  needs the CLI. A launchd-scheduled routine needs a release containing routines
  (2026-10-10-routines-live.md, item 3). `record --watch` has never run live.
- `open_file`. CHANGELOG: "unit-tested, and the TextEdit tasks run with it before release". The
  TextEdit tasks have now run with open_file in the build: 4/4 at `979b4c2` (h2h-save-check), 8/9
  and 9/9 at `80b5abc` and `d575dcf` (h2h-4, h2h-5), 6/6 at `f3d2790` (verified-results-live). The
  results files don't record whether Claude used open_file. The traces would show it.
- Other hosts. The generic MCP arm passed local discovery (ten tools) and 64/64 focused tests. The
  paired live Calculator comparison is unmeasured (the committed attempt could not take
  /tmp/sleight-live.lock) and the full package check is pending (2026-10-10-plugin-arm.md). The
  approval panel still names Claude under Claude Code, and codex/panel-name is out.
- `sleight-mcp setup`. "A full setup run hasn't been tried live" (CHANGELOG). ROADMAP 5b.7: "Left:
  a live setup run in a fresh macOS user". STATE's next step 1 is the owner's probe as
  puddle-census. macOS permissions always need the user's click.
- Claude Code minimum versions. What is stated now, and where:
  - README L39: 2.1.275 or later, the install requirement. The only occurrence in the repo.
    The repo doesn't say which feature needs it or how it was tested.
  - README L127: v2.1.287 or later for the three ways to watch. how-it-works L25 and CHANGELOG
    source 2.1.287 only for the mod's turn-end hook.
  - known-problems L694: the desktop Code tab runs Claude Code 2.1.293 (2026-10-08), "new enough
    for the mod".
  - STATE L140: ~/.local/bin/claude 2.1.289, and the desktop app offered 2.1.288.
  - docs/benchmark.md: 2.1.288 and 2.1.289 as historical run versions.
  The gap: either cite what 2.1.275 and 2.1.287 were tested against, or align the statements.
- Also open in ROADMAP 5b as written there: the verified-results away runs (Chess and safari-form)
  and the panel-named save line, the quiet-box CPU comparison with both arm setups published, and
  the LCU rerun.

## known-problems.md against CHANGELOG Unreleased

This lane reports the overlaps below without editing known-problems.md. First, entries a merged fix
or a newer run now covers:

- Waits and targeting: "TextEdit Save, equal titles and CPU comparisons remain pending under a live
  hold, as recorded in the third follow-up report". A fourth follow-up exists
  (2026-10-10-waits-targeting-4.md). The hold is gone, live attempts ran 16:11 to 16:14 UTC and
  failed setup, the identity cost measured neutral with one window, and what remains is the
  equal-title live check and the idle CPU run (load under 3).
- Doctor app reads: "the app's timing and header remain unmeasured". CHANGELOG's doctor bullet
  records a live run that read Calculator in 156 ms with a header (2026-10-10). No results file
  carries the 156 ms. It rests on the changelog alone.
- Desktop replay: "Demonstration and routine qualification remains incomplete: the native preflight
  on 2026-10-10 didn't have Accessibility or Input Monitoring access". Routines have since
  qualified live in part (2026-10-10-routines-live.md): record, replay (2/2 steps), routine add,
  run-now (10/10 behind the idle gate) and remove. Demonstration recording still hasn't run live.
- The real-use harness: "The local Harbor Market tasks have unit-tested state checks only".
  safari-shop and helium-shop ran live on 2026-10-10 (2026-10-10-shop-1.json, -shop-2.json).
  Helium passed both arms. Safari failed fixture setup on both in shop-1 and passed both in
  shop-2 after the title-nonce fix.
- Compact reads: "Otherwise the relay refuses the action until Claude reads again" now describes
  only half the behavior. The Unreleased renumbered-click change sends a batch click to the same
  element at its new number when its line appears exactly once in the new tree.

Second, Unreleased fixes with no known-problems line:

- `sleight-mcp setup`: "A full setup run hasn't been tried live" is CHANGELOG-only.
- The "Always allow" prompt button: unit-tested only, and that caveat is CHANGELOG-only.
- The other-hosts approval panel: "still names Claude under Claude Code" and unit-tested-only are
  CHANGELOG-only.
- The `let app` declaration fix and the acquisition-after-failure fix were made the same day they
  were found in the head-to-heads, and neither was released, so a missing line is
  defensible. Noted for completeness.
