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

- Chess demo for the README and launch post (owner chose it 2026-10-03). Claude plays macOS Chess behind
  the owner's editor while the pane shows the board. A feasibility run on 2026-10-03 worked. Claude
  started a game and dragged e2-e4, d2-d4 and Nb1-c3, the computer answered each, and the owner saw one
  approval prompt (the relay answered 18 repeats). Before recording, the Chess window title shows the
  owner's real name ("Chris Menendez - Computer"), so change the player name in Chess or crop it.
  Recording hasn't started.
- Launch prep: `v0.1.0` tag and changelog, repo topics, a line on the Land-o-Clusters profile README.

## Waiting on the owner

- The icon's original PNG from ChatGPT, saved as `docs/assets/sleight-icon-source.png` (the repo has a
  compressed WebP), and optionally a simplified small-size version.
- Going public.
- Optional: remove `com.apple.TextEdit` from the engine's global approvals file
  (`~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json`).

## Next

1. Chess demo.
2. Launch prep above.
3. Benchmark arm for LCU plus a drag task, for a measured comparison.
4. A weekly scheduled `--doctor` and one-task smoke run to catch ChatGPT updates breaking the engine.

## Reading list

- `README.md`: how it works, known problems, benchmark.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `bench/`: tasks, runner, and the approval hook that only benchmark runs load.
- `.dev/stop_test2.py` (untracked): how to drive an interactive session in a pseudo-terminal. Judge results
  from the relay trace and the session transcript, because the screen redraws too much to match on.
