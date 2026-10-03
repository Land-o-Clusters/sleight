# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-03)

Private repo `Land-o-Clusters/sleight`, `main` green in CI (relay tests, plugin validation, mod tests,
Vale prose lint). We haven't published or released anything yet.

Verified live on Claude Code 2.1.288 with ChatGPT engine 26.930.31730:

- Background control in Calculator and TextEdit. The benchmark passed 12/12 (four tasks, three runs each).
- One approval prompt per app per session. The relay answered the repeats (8 of 9 in one run).
- Per-turn cleanup: the mod's `turn_ended` reaches the engine and succeeds.
- Pane: action log, status line and a 902-cell half-block picture in a terminal.
- `/sleight stop` mid-turn. The engine got `Interrupt` and saw no later call, and Claude's next call was
  refused.

Not verified: the pane's picture in the desktop app's Code tab. That needs desktop Claude Code 2.1.287 or
later, and the desktop app bundles 2.1.286.

## In flight

- Chess demo: recorded 2026-10-03 and in the README (`docs/assets/demo.gif`, 32 s at 6x, plus
  `demo.mp4` for posts). Claude played 15 moves by dragging and the game didn't finish. The recording
  showed the pane's action log cutting off its newest entries, fixed the same day (newest first).
- Launch prep done on 2026-10-03, except the parts that make the project public. `v0.1.0` is tagged
  (commit `04e97de`), `CHANGELOG.md` is in, and the repo has topics. The repo is still private.

## Waiting on the owner

- The icon's original PNG from ChatGPT, saved as `docs/assets/sleight-icon-source.png` (the repo has a
  compressed WebP), and optionally a simplified small-size version.
- Going public. When the owner does it, add sleight to the org profile README
  (`Land-o-Clusters/.github`, `profile/README.md`, under "What lives here", matching the Floati and
  Puddle entries). The owner pushes that change.
- Optional: remove `com.apple.TextEdit` from the engine's global approvals file
  (`~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json`).

## Next

1. Benchmark arm for LCU plus a drag task, for a measured comparison.
2. A weekly scheduled `--doctor` and one-task smoke run to catch ChatGPT updates breaking the engine.

## Reading list

- `README.md`: how it works, known problems, benchmark.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `bench/`: tasks, runner, and the approval hook that only benchmark runs load.
- `.dev/stop_test2.py` (untracked): how to drive an interactive session in a pseudo-terminal. Judge results
  from the relay trace and the session transcript, because the screen redraws too much to match on.
