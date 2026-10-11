# Release audit, 2026-10-11

Lane release-audit. README.md, docs/how-it-works.md and docs/settings.md, read whole against the
code at `d21965c` (pane/auto-mode, this branch) and CHANGELOG's Unreleased section. Released is
v1.1.0 (`0b6a1c0`, main). Claims tied to a release or a pass name it. `bench/release-audit.md`
(2026-10-10, at `038cafa`) is the previous pass. Its two unsupported Claude Code minimums are fixed
in README since (2.1.288 for install, 2.1.287 tied to the turn-end hook, both sourced in the text).
Line numbers below are the files as of this audit.

## Changes

| File | Line | Change | Reason |
|---|---|---|---|
| README.md | 89 | named the lease trials' pass, "(0.6.0)" | LAWS: a claim tied to a pass names it (CHANGELOG 0.6.0) |
| README.md | 93 | "In the benchmark" became "In a 0.10.0 pass" | same (CHANGELOG 0.10.0: two of its three refusals) |
| README.md | 95 | named the CNN numbers' pass, "(0.10.0)" | same |
| README.md | 101 | release pass result is now "[PASS] (1.1.0: 20/21)" | the coming release pass replaces the number (STATE, next step 4). 1.1.0's 20/21 stays, named as history |
| README.md | 102 | named the 13/21 pass: the 2026-10-08 Split View pass | `2026-10-08-await-split-view.json` (8 of 21 failed). LAWS naming |
| README.md | 103 | named the Chess result: the 1.0.0 head-to-head | `2026-10-09-h2h-chess-simulator.json` via docs/benchmark.md |
| how-it-works.md | 21 | the relay's list now includes the rewritten first-call description, linked to its settings entry | relay behavior since the batching rewrite (2026-10-09) |
| how-it-works.md | 27 | the mod ends the turn "even when Claude Code's pane list fails" | CHANGELOG Unreleased (mod test. Hasn't run live) |
| how-it-works.md | 48 | browser surface: "cached discovery result", a negative result lasts 24 h, ChatGPT.app engines stay computer-only, refresh starts after the first call answers or 60 s | `surface-cache.mjs` (6 h positive, 24 h negative), `launch.mjs` `selectSurfaces`/`probeSurfaces`, `refreshAfterFirstCall` (delayMs 60000) |
| how-it-works.md | 60 | cut the final-run narration, kept the 2/2 result with its date | the linked attempts file records the detail. Docs get shorter |
| settings.md | 64 | cut the stray bullet "Approval memory stays in the relay and ends with the session." | duplicated the section's first sentence |
| settings.md | 43 | new Clipboard section: `SLEIGHT_CLIPBOARD=preserve`, off by default, about 230 ms a call | CHANGELOG 0.7.0. The code reads it, no settings doc did |
| settings.md | 186 | `SLEIGHT_TRACE` now described with its default (off. `1` writes `trace-<pid>.jsonl` under `~/Library/Logs/sleight/`, or a directory path) and the 300-character cut | `launch.mjs` `traceTo`. Each variable documented once with its default |
| settings.md | 209 | Careful guard rewritten. A first action that sends keys, text or coordinates now uses the prior read whenever it is under 10 s old. The old text kept a 2 s, loaded-Mac qualifier that the code dropped. The change also documents the `setValue` Return skip (1.85 s a save) and the about 50 ms settled read | `relay.mjs:1731` (`treeFreeFirstAction`), CHANGELOG Unreleased, LAWS (owner, 2026-10-10, about 0.35 s a run) |
| settings.md | 228 | `SLEIGHT_FIRST_CALL_BATCH=merge` documented: under A/B, 0 of 24 runs put save and close in one call | `relay.mjs` FIRST_CALL_MERGE, ROADMAP track 3 |
| settings.md | 232 | new Result size section: `SLEIGHT_RESULT_TRIM=1`, under A/B, spilled results about 56k to 16k characters | `relay.mjs:328`, commit `e212204` |
| settings.md | 137 | new Local tools section: `SLEIGHT_MENU_BAR=0`, `SLEIGHT_DRAG=0`, `SLEIGHT_HOVER=0`, each on by default | `launch.mjs:344-347`. how-it-works carried them, settings.md didn't |
| settings.md | 145 | new section on `SLEIGHT_SURFACES`: automatic by default, `computer` or `browser,computer` to fix it, computer-only from ChatGPT.app | `launch.mjs:68/95`, `surface-cache.mjs` |
| settings.md | 344 | new Benchmark and development settings section: `SLEIGHT_BENCH_API_CAP_USD` (default 200, a monthly cap), `SLEIGHT_ARM_DIR` (default `~/Library/Caches/sleight-bench/sleight-arm`), `SLEIGHT_STUB_OSASCRIPT=1`, `SLEIGHT_CHATGPT_APP` (default `/Applications/ChatGPT.app`) | `bench/api-auth.mjs` (DEFAULT_CAP_USD 200), `bench/run.mjs:91`, the startup-costs scripts, `bin/sleight-mcp` and `setup.mjs:21` |

## [PASS] markers

One: README.md line 101, "the release pass passed [PASS] (1.1.0: 20/21)". The release pass fills it
with the new pass result, and 1.1.0's 20/21 moves into the published-pass history the next sentence
points at. No other number in these three docs is replaced by the pass. The rest are tied to named
passes and stay as history.

## Variables the code reads that settings.md doesn't document

- `SLEIGHT_FRAME` (hooks/snapshot.ts) and `SLEIGHT_BENCH` (bench/startup-costs.mjs) are marker
  lines the code writes. Users don't set them.
- `SLEIGHT_PROMPT_UNAVAILABLE` (launch.mjs) is an error code the relay raises and catches itself.
  It is not an environment setting.
- `SLEIGHT_ACCESSIBILITY_MOVE` (drag.js:695) is a `globalThis` flag the tests set inside the drag
  script's runtime. Users never set it in the shell.
- `SLEIGHT_IGNORE_HOLD` (scripts/wait-hold.sh, documented in CLAUDE.md) and `SLEIGHT_WATCH_FORCE`
  (scripts/watch.sh header) are read outside this brief's plugins/ and bench/ grep and documented
  where they are used.
- No variable that settings.md documented has stopped being read. Each one turned up in the code.

## Checked and found true

- The 20/21, 13/21 and Chess 0/3 to 2/3 numbers, against their results files.
- Receipts: seven days or 200 files, the redactions, and the 2,000-call review cap
  (`turn-receipts.mjs`, limit 2000).
- `SLEIGHT_GUARD` accepts only `careful` now. The `batch` value is gone from the code (dropped
  2026-10-11), and settings.md never listed it.
- Idle turn end at 30,000 ms, with three cleanup attempts.
- `sleight-mcp allow list` and `allow remove` (launch.mjs:760-777).
- The `js` permission name `mcp__plugin_sleight_computer__js` (the mod's registration).
- Drag's 500 ms hold and hover's 1500 ms default.
- The setup, replay, routine and `record --watch` claims, against CHANGELOG and their design docs.

## Not fixed here

- ROADMAP track 2 still lists `/sleight stop` in the desktop app as open, and README's roadmap
  marks it checked (2026-10-11, the turn ended at once). STATE records that live result, so README
  stands. ROADMAP is not this lane's file.
- package.json's lint:prose list doesn't include this file, and package.json is not in this lane.
  This file was checked with vale directly.
