# Changelog

## 0.1.0 (2026-10-03)

First release. Tested on Claude Code 2.1.288 with ChatGPT engine 26.930.31730, on macOS (Apple Silicon).

- Claude Code can drive Mac apps in the background through the computer-use engine bundled with the
  ChatGPT desktop app. The launcher finds the newest engine version on every start.
- One approval prompt per app per session. The relay replies to the engine's repeat requests itself, and
  `SLEIGHT_APPROVAL_SCOPE=once` asks every time instead.
- `/sleight` opens a pane with the app's latest picture, an action log and Refresh and Stop buttons.
  Text after `/sleight` goes to Claude as a prompt. `/sleight stop` halts it mid-turn.
- The engine's turn ends after each Claude turn, as in Codex (Claude Code 2.1.287 or later).
- A skill tells Claude when to use sleight and how to work around the missing hover.
- Benchmark: four Calculator and TextEdit tasks, 12/12 on the first run.
