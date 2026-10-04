# Changelog

## 0.2.0 (2026-10-03)

- New `menu_bar` and `notifications` tools for what the engine leaves out: apps' icons in the menu
  bar (read the menu or window, choose an item, press a button) and notification banners (read, press
  a button). They go through System Events UI scripting. Each app's icon needs the user's approval
  once per session, as do notifications. `SLEIGHT_MENU_BAR=0` turns them off.
- The approval panel opens on the display under the pointer, over full-screen apps, with a sound.
- Benchmark: each arm loads only its own tool (checked before every run), runs default to Sonnet 5.5
  at medium effort, and runs close the windows they leave behind.

## 0.1.1 (2026-10-03)

- App approvals work in the desktop app's Code tab. It declines MCP prompts without showing them, so
  there sleight asks with its own panel (Liquid Glass where macOS has it). `SLEIGHT_APPROVAL_PROMPT`
  picks `dialog` or `client`.
- Benchmark runs keep approvals on the benchmark's hook when started from a desktop app session, and
  the sleight arm runs from an empty folder like LCU's. A Chess drag task joins the benchmark.
- The skill covers saving to a path through Go to Folder, and apps whose bundle ID is ambiguous.

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
