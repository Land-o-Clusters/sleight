# Changelog

## 0.4.0 (2026-10-04)

- `SLEIGHT_APPROVAL_SCOPE=document` approves one window or document for the session instead of a
  whole app, through a new `document_scope` tool. The relay forwards actions only while the last
  observed window matches, and stops when a result shows a different window. It guards against
  mistakes; code running in the engine can get around it (`docs/design/document-scope.md`). Built by
  Codex; live check: the approved TextEdit document was edited and a write to a second one never
  reached the engine.
- Background drag research (`bench/background-drag/`, not in the plugin): full sequences reached the
  probe app in 5/5 quiet trials and 2/5 during real use, but TextEdit text moved 0/10.
- The weekly watch saves the engine's API docs and diffs them when the engine updates.

## 0.3.1 (2026-10-04)

- The relay ends the engine's turn after 30 s without a running call. In the desktop app, where the mod
  can't run, the engine used to hold the last app (its badge on the window) until the session closed.
  That's the likely cause of desktop sessions showing as busy after Claude finished. `SLEIGHT_IDLE_TURN_END_MS` sets the wait.
- Hover: mouse events posted to a background app don't trigger hover, measured with the probe app and
  GitHub Desktop.

## 0.3.0 (2026-10-04)

- A `drag` tool that holds the mouse down and moves in steps, for drags the engine's `app.drag` can't
  do, such as moving selected text. It works in the foreground and puts the pointer and the front
  app back. It refuses to press when another app's window covers the start point. Benchmark text drag:
  3/3 (Sonnet 5.5), against 0/9 for `app.drag`.

## 0.2.1 (2026-10-03)

- `menu_bar` opens SwiftUI window-style icons, which ignore the accessibility press, with a real
  click and puts the pointer back. `close` clicks them again to shut the window. Icon-only buttons
  report their tooltip or identifier when they have one.
- `menu_bar` op `apps` takes about 4 s instead of 5.5 s.
- Drag findings: a probe app (`bench/drag-probe/`) shows the engine's drag lasting 14 ms with two drag
  events, so text drags can't work.

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
