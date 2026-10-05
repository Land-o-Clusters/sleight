# Changelog

## 0.9.0 (2026-10-05)

- Smaller results after actions. The window guard's read after each `js` action now reaches Claude
  as the lines that changed since the last full tree it saw for that window, or one "no change"
  line, instead of the whole tree again (`docs/benchmarks/2026-10-05-compact-reads.md`). The relay
  keeps that tree, so the engine's next diff still starts from what Claude knows. Benchmark 12/12;
  46 guard reads were cut down, and result text per run fell 1 to 23% on TextEdit and Chess. Busy
  browser pages, where the complaint came from, are unmeasured.

## 0.8.0 (2026-10-05)

- Fewer prompts for terminals and OpenAI's apps, opt-in. If you turn off the helper's refusal
  yourself with `defaults write -g ComputerUseAllowForbiddenTargets -bool YES`, these apps go
  through the engine with one approval per app for the session, and Claude types in the background.
  sleight's prompt says a yes lets Claude run terminal commands without asking again, and actions
  in these apps' settings windows are refused. `--doctor` shows whether the setting is on. sleight
  never sets it. In the live check Terminal ran `echo` in the background 2/2, and its settings
  window was refused 1/1.
- The skill says a built-in browser is usually faster for public pages, and sleight's browser
  surface fits pages that need the user's logged-in browser.
- Known problems added: the window guard adds a full, non-diffed tree to every action result, and
  TextEdit hung 2/2 on Cmd+Shift+S (Duplicate) right after its text was set. The skill now steers
  Claude to Cmd+S or File > Save As, and the benchmark's TextEdit setup times out on a hung TextEdit.
- Benchmark: 6/6 TextEdit runs after the skill hint, and 1/1 each on the other tasks
  (`docs/benchmarks/2026-10-05-release-0.8.0.md`, the hung runs included).

## 0.7.0 (2026-10-05)

Benchmark: 16/18 from a clean arm folder (Sonnet 5.5, medium). Every task passed 3/3 except
chess-drag, 1/3; both failures dragged the pawn to e5, an illegal move
(`docs/benchmarks/2026-10-05-release-0.7.0.md`, every run included).

- `drag` tries a background drag first. It posts the drag to the app's process, with no activation
  and no pointer move, and falls back to the foreground drag only when the text didn't change
  (`docs/design/background-drag.md`). When another app's window covers either drag point, it goes
  straight to the foreground drag and names that app, because macOS picks the drop target from
  what's on screen: 0/3 background moves covered, 3/3 uncovered, on TextEdit. Both paths raise the
  window chosen by `windowId` and refuse before pressing if it isn't on top at both points. Drags
  that land outside the window's content, or in an ambiguous window, are refused. Lost text is
  reported with a Cmd+Z hint, and TextEdit gets back the space after a verified one-word move to a
  line end. Built by Codex. Locked window checks passed 8/8 (four refusals, four exact moves).
  Stacked Chess games moved the chosen game 1/3, with the covering game unchanged in all three.
- `hover`: a short real-pointer hover with a screenshot, for UI that only reacts to a real pointer,
  after the skill's background options fail (`docs/design/hover.md`). It asks once per app and holds
  the pointer for about 1.8 s. A point another window covers is refused. Built by Codex. A tooltip was absent at
  1000 ms and readable at 1500 ms in one trial each, so 1500 ms is the default.
- Pre-approved apps: a list you write at `~/Library/Application Support/sleight/preapproved.json`
  approves apps up to a risk level without a prompt, in every session (`docs/design/preapproved-apps.md`).
  No setting can point at another file. Grants go to a small audit log. Built by Codex. Live: listed
  Calculator worked out 12 × 12 with audited grants, and was refused once taken off the list.
- `select_window` raises one window of an app through Accessibility, since the engine rejects
  `cua.getApp({ windowId })` on macOS. Built by Codex. 3/3 with the tool on TextEdit.
- Browser surface: sleight turns on the engine's browser control when a ChatGPT browser extension is
  connected at startup (`docs/design/browser-surface.md`). Native guards stay on for every call
  until the engine's reply confirms a browser call. Built by Codex. In the live check Chrome and
  Helium each opened a tab and clicked a link in it, and turn end closed both tabs.
- Engine stall: after two read timeouts for an app, the relay stops sending its calls and tells
  Claude to ask the user to restart ChatGPT, retrying one read itself at most every 20 s
  (`docs/design/helper-health.md`). Built by Codex. 3/3 recovery trials.
- Doctor runs a bounded live read. It now fails when the helper can't start, which it used to report
  as "ok", and prints the `launchctl remove` command for the stale launchd job that caused that on
  2026-10-05.
- Clipboard preservation, opt-in with `SLEIGHT_CLIPBOARD=preserve`. Copy and Cut go to a private
  session clipboard and the user's is put back (`docs/design/clipboard.md`). Off by default, since a
  copy meant for the user wouldn't reach menu Paste or `pbpaste`. Built by Codex. 19/19 live, then
  2/2 on the merged code. Each call takes about 230 ms longer.
- Change review (still opt-in) takes its snapshot on a standalone re-read, so a file opened through
  the Open dialog can be edited. Live: 4/4.
- Benchmark harness: arm folders live outside any git repo, and `bench/run.mjs` refuses one inside.
  Until now both arms ran from inside this repo and loaded its CLAUDE.md and project memory. The
  approval hook also takes the three apps' bundle IDs, and TextEdit tasks quit an empty TextEdit
  first so its windows open on the current desktop.
- `blocked_app`: drives the apps the engine's helper refuses (Terminal, iTerm2, ChatGPT, Codex, Atlas
  and beta builds) through sleight's own macOS Accessibility path, the one `menu_bar` and `drag` use
  (`docs/design/blocked-apps.md`). The engine's refusal is OpenAI's code and is untouched, and
  sleight's prompt is the whole opt-in. When Claude reaches a refused app, the relay says so in the
  result and offers the tool. Allow puts the app on the session allowlist like any other app
  approval, and the prompt says it covers approval buttons. In a terminal, every key or text that can
  run a command (any typing, Return, paste, most chords; only arrows, Tab, Escape and ctrl+c are
  inert) is shown exactly as it will be sent, with Allow Once and Don't Allow. The relay forgets
  each answer, and the preapproved list cannot cover these sends. Settings windows of these apps are
  refused by title plus a toolbar check, because the Terminal app titles its settings window after
  the open pane. Actions take app-scope input leases and pass through the flow rules. The driver is
  pinned to the consented app's bundle ID and pid, and checks the frontmost switch before sending
  keystrokes. Clicks on buttons named like Approve, Allow, Run or Accept are named in the result.
  `npm run check` passes (22 tests on this path). Live runs, with the owner clicking Allow, went as
  follows. Terminal passed 1/1 (read, exact-text prompt, echo, output visible); three other runs
  stopped on a declined or timed-out consent. The Codex window read passed 1/1; its harmless click
  had no target, because the window exposed only window-control buttons to the walk.
  `docs/benchmarks/` has all the attempts, timeouts included, with personal paths scrubbed.
- The CHANGELOG entries for 0.6.0 and earlier, lost in a merge, are back.

## 0.6.0 (2026-10-04)

- Input leases: one sleight session acts on a window at a time. A second session gets the holder's
  name and seconds left, and reads still work. Before acting, Claude reads the window with
  `cua.getApp`, and a refusal gives the exact call to send. Leases end with the turn, or after 30 s
  without renewal (`docs/design/input-lease.md`). Built by Codex. With two relays typing into one
  TextEdit document, text doubled in 5/5 trials without leases and appeared once with one refusal in
  5/5 with them. Benchmark with leases on: 11/11 over two passes (Sonnet 5.5, medium). A Save sheet
  stops the next action until Claude reads again, so textedit-save took 27 and 30 turns, against 13
  without leases.

## 0.5.0 (2026-10-04)

- `review_changes`, opt-in with `SLEIGHT_CHANGE_REVIEW=1`: lists the saved files Claude changed this
  session and lets the user choose Keep or Undo for each one in a prompt. The relay copies a `file://`
  document before a `js` call that may edit it and deletes the copies when the session ends
  (`docs/design/change-review.md`). Built by Codex. In the live check, Undo restored one TextEdit
  file and Keep left the other in 1/5 attempts. The sandbox and a locked Mac stopped the first two,
  and the user chose Keep for both files in the next two. It's off by default because its window
  guard failed both benchmark tasks that open a TextEdit file.
- Flow rules, opt-in with `SLEIGHT_FLOW_RULES=1`: user-written rules for text moving between apps,
  checked in the relay before a call is forwarded, with a one-call exception only the user can grant
  (`docs/design/flow-rules.md`). Built by Codex. It guards against mistakes, since code can build
  strings at runtime. The live TextEdit check passed in 2/5 attempts. One failure forwarded a
  protected value, and the parser fix that followed has a regression test.

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
