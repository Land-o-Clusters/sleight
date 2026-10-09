# Changelog

## Unreleased

- A result whose window shows an open menu (`0 menu Secondary Actions: Cancel`) says how to close it.
  Escape left such menus open in 3 of 3 tries in the head-to-head, and their Cancel action closed
  one in Finder. Not yet checked live on a menu at element 0, and this changes what Claude does, so
  the affected tasks run with it before release.
- `{ label }` matches a field whose line has states before its title (`text field (settable) Email`)
  and a menu bar item named alone (`Edit`). Both stopped calls in the head-to-head.
- A guard stop (a renumbered element, or no element with an ID or label) carries the window as it is
  now, so Claude can retry with current numbers without a turn spent reading again. Each stop cost
  safari-form a turn in the head-to-head.
- `drag` refuses a drag another app covers and that has no selected text before raising or scanning
  the window, outside TextEdit. It took 10 to 13 s to reach the same refusal in Chess and Finder.
- On a loaded Mac, the first action of a call uses the full read Claude made in the call just before,
  if that read took over 2 s and is less than 10 s old. Otherwise the guard reads again, about 50 ms
  when the app has settled, and checks every number the call acts on against the line Claude last
  saw: in the head-to-head a saved TextEdit document renumbered after Claude's read, and a click
  meant for Format opened File. Under 20 CPU workers that read took 17 to 57 s, seconds
  after Claude's own took 1.9 s. Document scope, change review and `SLEIGHT_GUARD=careful` keep it.
  A lookup by ID or label that finds nothing in a read that dropped attributes now takes the one
  bare line with that name (`button One`).
- App probes (the full-screen check on each app read, and read-failure diagnosis) go to one
  long-lived helper per session instead of starting `osascript` each time: about 33 ms a probe after
  a 190 ms start, against about 180 ms for each spawn. The helper runs its run loop before each
  probe, since otherwise it never saw an app launched after it started, and an app the acquisition
  launched is probed again after the engine answers. Both were found and checked live with a
  full-screen fixture.
- Keys, typing, paste and coordinate actions after typing, pasting or a plain key in the same call
  no longer wait for a window read first. After a click, a shortcut, Return, Escape, Tab or Space
  the read stays: it also waits for a panel the action opened, and without it Cmd+O, Cmd+Shift+G and
  a typed path outran TextEdit's Open panel in a head-to-head run. That read waited about 400 ms for the UI to settle, and tens of seconds on a
  loaded Mac, where Codex doesn't make that read (owner's call). The first action and actions on
  element numbers, IDs or labels are still checked. `SLEIGHT_GUARD=careful` keeps every read.
- The guard's check before reusing an acquisition's read never checked anything: engine
  26.1002.52244 doesn't list windows, and two empty lists matched. Since 1.0.0 the first action after an
  acquisition ran on that read unchecked. Now the guard reads instead, about 50 ms on a settled app.
- On a busy Mac the engine can read an element without its attributes (`button Two` for
  `button Description: 2, ID: Two`). The guard took that as a renumbered window and stopped 5 of 5
  batched Calculator calls under load. It now matches such a bare line to the element by role and
  ID or label. Unit-tested only.
- When the user is in a full-screen or Split View Space and the app Claude reads has no window on
  it, the read says so, once per app per turn: clicks and typing still work there, and
  drags and some reads don't. A second read timeout in a row on such an app gets the same advice instead
  of "cause unknown". A Split View pass failed 8 of 21 runs this way, with Claude spending up to 19
  turns before it gave up. With a full-screen fixture in front of TextEdit, a textedit-drag run got
  the note on its first read and stopped after 12 turns, asking the user to leave full screen.

## 1.1.0 (2026-10-09)

Its release pass passed 20/21 ([results](docs/benchmarks/2026-10-09-release-1.1.0.json)), and
chess-drag passed 3/3 after the last two changes below.

- When a turn ends, sleight names any app it acted on that holds a keyboard event tap, once per
  session, in a notice. Device Hub kept a tap after simulator runs and stalled every key on the Mac
  for 40 s.
- When a page renumbers its elements and Claude acts on a number from the tree it saw, sleight finds
  that element by its line in the current tree and tells Claude, instead of refusing the action and
  costing a read. If the line isn't on exactly one element, the refusal stays. Unit-tested only.
- When the engine's helper is restarting after 20 s idle and a call fails with "native pipe startup
  failed", the relay sends it again once, a second later. Unit-tested only: no live idle gap hit the
  race (0 of 6).
- Replay: `sleight-mcp record <transcript or session id> task.json` turns a finished run into a
  script, and `sleight-mcp replay task.json` runs it again through sleight with no model. Element
  numbers become IDs, labels or whole lines the guard finds again, and a script that depends on
  screen positions needs `--allow-positions`. A 3-call Calculator run replayed in 5.5 s against 17 s,
  and stopped without clicking when Calculator wasn't in the recorded state
  ([design](docs/design/replay.md)).
- An action Claude didn't await that fails no longer ends the engine's JavaScript session. The guard
  handles each action's promise and tells Claude which action failed. 1.0.0 lost the session and
  its handles (1/1), and the fix kept them (3/3).
- A `drag` that runs past its 30 s limit says it timed out, instead of returning only "Command
  failed", and a mouse button it left pressed is released. It won't start a press after 20 s, and it
  reads the window's elements once instead of twice. Chess took 9.4 s per read.
- A covered drag with no selected text presses nothing and tells Claude to use the engine's
  `app.drag`, which moved a covered Chess pawn where `drag`'s posts didn't.
- Benchmark runs disallow Glob, Grep and Read too. Claude's Glob for a saved Chess game never
  returned, and runs that had passed hit the 5-minute limit.
- The skill says to press another visible part of a piece when a drag moved nothing, instead of
  repeating the point or switching to `drag`. Telling Claude to press a pawn's head backfired in a
  small Chess window, where the e-pawn's head sits behind the king.
- The benchmark counts an acquisition the relay sends ahead of a call's actions as engine time. It
  had counted as relay time: 9.6 of the 9.98 s of relay time in the background head-to-head.

## 1.0.0 (2026-10-09)

sleight's first stable release. Its release pass passed 19/21 in 165 turns and 912 s, at 2.59 s of
model time per turn ([results](docs/benchmarks/2026-10-09-release-1.0.0.json)). 0.16.0's passed 20/21 in
178 turns and 1,355 s.

- The first action after an acquisition no longer reads the app's whole tree again. The guard reuses
  the acquisition's read when the app's windows are unchanged, checked through the engine's inventory
  in 11 to 30 ms. Right after Calculator launched under load, that second read had taken 16.7 s.
- When a drag point is covered, `drag` says by which window. A window of the same app with no title is
  named as a likely dialog to finish or close first. Chess's New Game dialog stopped 9 drags in one
  run.
- Text moves in other apps' text areas and fields try the Accessibility move first. Safari's web
  text areas ignore those writes, so `drag` falls back there; other apps' native text views are
  untested. A move whose writes leave the text as it was now says so and tries the next path, where it used to
  ask for Cmd+Z.
- A text drag into a TextEdit window you've covered no longer takes your pointer. `drag` moves the
  text through Accessibility, then posts one Shift press and release to TextEdit's process. Without
  that event, TextEdit's next Cmd+S deadlocked in 10 of 13 probe trials; with it, 0 in 10, and 10
  `drag` moves in a row saved cleanly. The background mouse drag's spacing repair gets the same event.

- Benchmark runs disallow Bash, Write, Edit and the web tools for Claude, like the Codex arm's
  disabled shell. No run used them to pass a check, but Claude often opened task files from Bash.
- The benchmark quits Device Hub or Simulator after each simulator run, and stops a pass when a
  benchmark app still holds a keyboard event tap afterwards. On 2026-10-09 Device Hub's tap stalled
  every key on the owner's Mac until it quit.

- `drag` scales Claude's points by the screenshot of the window it drags in, not only the app's latest
  screenshot. In a 0.16.0 pass, Chess had a second, untitled window, and 3 of 13 drags went in
  unconverted because the latest screenshot was of the other window.

## 0.16.0 (2026-10-08)

- `drag` takes `from` and `to` in the engine screenshot's pixels, as its description always said. It
  read them as window points, which are half that on a Retina display, so drops landed a line below
  the text. In 3 textedit-drag runs on 2026-10-08, Claude's first 2 or 3 drags each left the text as it was,
  and one run never found the cause. The relay now tells `drag` the size of the app's latest engine
  screenshot, and the result says the scale it used.
- The foreground drag waits for 2 s without typing or mouse use (up to 10 s), and stops if you type
  once it has taken focus. macOS drops a background drag on whatever is on screen at the drop point, so
  a TextEdit window you've covered still needs the real pointer. In a pass on 2026-10-08 that caught
  the owner typing, and a space went into TextEdit. `hover` and the `menu_bar` real click wait the same way.
- The docs say that apps marked "Always allow" in Codex or ChatGPT are approved by the engine itself,
  with no prompt in sleight. They used to say every app asks once per session; TextEdit, on that list
  here, never asked (2026-10-08).
- `noWindowsAvailable` from the engine now comes with what it means: the app's window is on another
  Space (full screen or Split View), minimized or hidden. Claude asks you to show it instead of retrying.
- The pane shows the app's picture in the desktop app's Code tab, Auto mode included. Auto mode
  refused the pane's between-turn snapshot because no request asked for it. A `tool.check` hook now
  allows exactly the snapshot code the mod built, and `turn_ended`, when Claude Code says the call
  came from sleight itself. Claude's own calls still go through the normal check. The picture also
  re-encodes until it's 16,000 base64 characters or less. At 51,135 it went over Claude Code's MCP
  output limit and was dropped. In the owner's Auto mode check, the pane showed Calculator's picture and 6
  actions, and the status line showed sleight.
- `/sleight <prompt>` waits for sleight's tools to load before it sends the prompt. In a new session
  Claude used to start with `open` and `osascript` because they hadn't loaded yet.
- The relay refuses an action written without `await` when more code follows it. A failed action
  without `await` can end the engine's JavaScript session and every app handle with it (3/3 on
  2026-10-07).
- The benchmark closes the documents a failed run left in TextEdit before the next run, and records
  whether each task's app had a window on the current Space.
- The release pass ([`release-0.16.0`](docs/benchmarks/2026-10-09-release-0.16.0.json)) passed 20/21
  in 178 turns and 1,355 s, at 2.34 s of model time per turn. textedit-drag passed 3/3. One
  chess-drag run hit the 5-minute limit with its game unsaved. A second, untitled Chess window sat over
  the game, so 6 of its drags were refused as covered.

## 0.15.2 (2026-10-08)

- A window that retitles itself keeps its lease. Chess renames its window when a game starts, on each
  move and on save. The guard still stops the next action, and the stop now includes the window it
  saw, which the relay leases, so Claude's retry goes through. Before, the retry was refused
  again and Claude had to acquire the app anew. Document scope and change review stay strict, and
  another session holding the window still refuses.
- Every sleight tool loads at session start, local tools included. Claude searched for `drag` before
  each drag.
- The skill says the window title is the confirmation of a save, not `ls` or `cat`.
- The benchmark runner holds the live lock itself.
- The next pass (`docs/benchmarks/2026-10-08-retitle.json`) passed 21/21 in 123 turns instead of 140,
  with 101 calls. None were refused or tool searches, and one was a Bash check. It took 582 s, at 2.64 s of
  model time per turn against 1.93.

## 0.15.1 (2026-10-08)

- The skill is 7,528 characters instead of 17,549, with every safety rule kept. Claude reads it on
  every turn now. It adds what a trace of 12 slow-task runs found: exact text by `paste`, because
  `typeText` goes through macOS auto-capitalization ("sleight" was saved as "Sleight" in 6/6 runs);
  the whole Save, final Return included, in one call; the result's title as the save's confirmation
  instead of a Bash check; menu shortcuts; and `menu_bar` only for menu bar icons.
- An action whose result shows another window of the same app says which window it acted on and
  which it shows. After closing a Chess game, Claude used to probe for it.
- A call that starts with an acquisition is split for the app the lease already holds too. In one
  call, the guard's setup referred to `app` before Claude's `let app` and threw.
- The next pass (`docs/benchmarks/2026-10-08-skill-trim.json`) passed 21/21 in 140 turns instead of
  156 and 531 s instead of 638, with 271 s of model time at 1.93 s per turn. textedit-save took 6 to
  8 turns instead of 9 to 14.

## 0.15.0 (2026-10-08)

- Claude can acquire an app and act on it in one call:
  `let app = await cua.getApp("TextEdit"); await app.pressKey("super+n")`. The lease used to refuse
  that until the app was acquired in a call of its own. Now the relay sends the acquisition alone and
  takes the lease from its reply. Then it sends the rest under the guard and returns one result. A failed
  acquisition stops before any action, and another session's lease refuses the rest as before. The
  skill says to combine them when the first actions don't depend on the UI.
- The next pass (`docs/benchmarks/2026-10-08-acquire-and-act.json`) passed 21/21 in 156 turns and 638
  s. Claude didn't combine a call in any of its runs, so it measures that nothing broke, not a saving.
  The benchmark has no task that switches apps, where this saves the most.

## 0.14.1 (2026-10-08)

- When an app's reads time out twice, sleight asks the app over Accessibility (500 ms, no prompts)
  and reads another approved app as a control before advising anything. It tells Claude to have
  the user restart ChatGPT only when the helper itself is stuck, and to quit the app when the app is.
  Restarting ChatGPT ends every Codex thread. Wrong restart advice fell from 1/1 to 0/6 runs with a
  hung fixture app (`docs/benchmarks/2026-10-08-reliability.md`).
- `drag`'s refusal for a window that's off screen or minimized says how to recover.
- The benchmark waits for Chess to exit before relaunching it and retries LaunchServices -600.
- The next pass (`docs/benchmarks/2026-10-08-reliability-pass.json`) passed 21/21 in 157 turns and
  586 s, with no refused calls.

## 0.14.0 (2026-10-08)

Fewer turns. In the 0.13.4 pass, 20 of 155 tool calls only loaded the skill, and without it Claude
spent the turn searching for the `js` tool instead.

- The relay adds the skill to the engine's first result, which Claude waits for anyway, and Claude
  no longer invokes the skill itself (`/sleight:drive-mac-apps` still shows it).
- `js` loads at session start (`_meta` `anthropic/alwaysLoad`), so Claude doesn't search for it before
  its first call. sleight's other tools load on demand, as before.
- `getAXState({ disableDiffing: true })` comes back whole, as sleight's own advice promises. Before,
  it could say "no change", and Claude took a screenshot to check.
- Each pre-approval grant appears once per result, where a batch of Calculator clicks used to repeat
  it 12 times.
- The next pass (`docs/benchmarks/2026-10-08-turns.json`) passed 21/21 in 157 turns instead of 195,
  with 426 s of model time instead of 490 and 717 s in total instead of 756. Model time per turn
  rose from 2.51 s to 2.71 s. Every task took fewer turns.

## 0.13.5 (2026-10-08)

- `getScreenshot()` takes the engine's combined capture and keeps its AX half as the guard's read,
  with the same image. A screenshot then an action took 469 ms instead of 501, and an action then a
  screenshot 468 instead of 520 (`docs/design/engine-time.md`).
- The skill says to type contiguous text with one `typeText` instead of a `pressKey` per character.
  Typing 8 digits in TextEdit took 1.4 s instead of 4.2 s.
- Reads after any input cost about 415 ms however long the caller waits first. The skill says not to
  sleep before a read.
- The next pass (`docs/benchmarks/2026-10-08-engine-time-pass.json`) passed 21/21 in 212 turns and
  877 s. Two calculator-click runs took 16 and 10 turns while Calculator's AX tree changed under them
  (`docs/known-problems.md`). The other tasks matched the previous pass.

## 0.13.4 (2026-10-08)

- Every action clears the window guard's saved reads for all handles in the call. Before, an action
  through a second handle on the same window left the first handle's read in place, so that
  handle's next action was checked against a stale tree.
- A `getAXStateAndScreenshot()` read counts as the guard's read until the next action, which saves
  one read per call that reads that way (Chess, 2 to 1). Other calls read as often as before.
- With `SLEIGHT_TRACE` set, the trace times each guard read (`docs/design/guard-reads.md`). Reads
  after an action take about 400 ms, against about 50 ms for the first in a call.
- The next pass (`docs/benchmarks/2026-10-08-guard-reads.json`) passed all 20 runs that started, in
  195 turns and 121 calls. Engine time was 190 s against 191 s. chess-drag's first run didn't start,
  because macOS failed to relaunch Chess right after the benchmark quit it (error -600).

## 0.13.3 (2026-10-08)

- `let app = await cua.getApp("X"); app` counts as an acquisition. The input lease knew only the
  form without the trailing `app`, refused Haiku 5.5's three tries at it as actions, and advised
  `await cua.getState()`, which acquires nothing (a textedit-save failure, 2026-10-08). When a
  refused first call names its app, the advice is now that app's acquisition. Unit tests cover both.
  Neither came up in the passes after the fix. Sonnet 5.5 medium passed 21/21 in 226 turns and 738 s
  (`docs/benchmarks/2026-10-08-acquisition-echo.json`), and Haiku 5.5 passed textedit-save 3/3.
- `docs/benchmark.md` compares Sonnet 5.5 at medium and low effort, Haiku 5.5 and Opus 5.5 on 0.13.2.

## 0.13.2 (2026-10-08)

- sleight keeps the input lease when it stops an action (a renumbered batch, or an AX ID that
  doesn't match). The stop message includes the window header from the read it took, so Claude
  retries without acquiring the app again. Before, a textedit-save run's correct retry was refused and cost
  a turn and a 21,043-character tree.
- The skill shows a Save As in one call (Go to Folder, the folder, Return, the name by ID, Return).
- The next pass (`docs/benchmarks/2026-10-08-save-in-one-call.json`) passed 20/21 and took 213 turns
  instead of 260, and 687 s instead of 825, at 2.05 s of model time per turn against 1.81.
  textedit-save's median fell from 27 turns to 16. The failure was a Chess window the engine
  couldn't drag in (`docs/known-problems.md`).

## 0.13.1 (2026-10-07)

- Fewer errors, so fewer turns. In two benchmark passes 94 of 437 calls failed. A Save panel's Go to
  Folder sheet has no title, and the input lease stopped the call that opened it (18 errors); an
  untitled sheet or panel of the same app now passes. `js` accepts `command` for `code`, which Claude
  sent 6 times. Reading after ⌘W closed the last window reports that instead of a
  `noWindowsAvailable` error (7). Inventory reads may pass `{ emit: false }`. The next pass passed
  21/21 with 12.7% of calls failing instead of 21.5%, and took 260 turns instead of 300 and 825 s
  instead of 902 (`docs/benchmarks/2026-10-07-errors.json`).
- `menu_bar` says it isn't for an app's own menus, and its error points to `js` (Claude used it for
  File and Format 3 times). Not measured yet.
- Benchmark runs record token usage and allow every sleight tool.

## 0.13.0 (2026-10-07)

- Claude can address an element by its AX ID or label instead of its number:
  `await app.click({ id: "Seven" })` or `{ label: "Multiply" }`, also for `scroll`, `selectText`,
  `setValue` and `performSecondaryAction`. sleight finds the element in the read it already takes
  before each action. A batch addressed this way keeps working when an earlier action renumbers
  the window. All
  Clear and then 1234 × 5 = ran as one Calculator call and showed 6,170. A name that matches no
  element or several stops the action. Over the benchmark (7 tasks, 3 runs each, Sonnet 5.5),
  refused calls fell from 14 to 7 and turns from 300 to 281
  (`docs/benchmarks/2026-10-07-element-ids.json`).
- Benchmark answers have the user's full name replaced, because Chess window titles include it.

## 0.12.3 (2026-10-07)

- Claude gets each screenshot once. The skill told Claude to pass `getScreenshot()` to
  `nodeRepl.emitImage`, but `getScreenshot()` already shows its picture, so every step sent two
  copies: 64 images over one iPhone Mirroring session. The skill now says to call it alone, and the
  relay drops an exact repeat within a result and tells Claude why (checked live: 2 images before,
  1 after). The skill also says to keep one handle between actions instead of acquiring the app
  again before each one.
- Benchmark results split each run's time into model, engine, sleight's local tools, the relay and
  Claude Code (`docs/benchmark.md`).

## 0.12.2 (2026-10-07)

- The input lease's recovery advice works. A session asked for `getApp("grokbot")`, and no app
  has that name. Every later refusal told Claude to send exactly that call again, as `app = …`. A failed
  `let app` leaves no `app`, so the assignment failed with "app is not defined", and the session
  failed 20 of its first 22 calls. The advice now uses the last app that was read successfully
  (or `cua.getState()`), and declares the handle with `let`, which the engine accepts again for a
  name it already has.
- A refused `cua.listApps()` or `cua.getState()` statement is told the one-expression form that
  passes the lease.
- When the engine's JavaScript session restarts on its own, sleight now tells Claude that its
  handles are gone and forgets them too. An action without `await` that fails can end the session:
  `app.click(1); "x"` on a disabled Calculator element did it 3/3 times on 2026-10-07. The skill's
  example now awaits its click, and the skill says how to look up an app's name.
- Benchmark: `simulator-form`, a mobile end-to-end task in the iPhone simulator, 3/3
  (`docs/benchmarks/2026-10-07-simulator-form.json`).

## 0.12.1 (2026-10-06)

- The pane's picture fits the pane. It was sized to half the terminal, but a pane above the prompt
  gets about a third, so the picture pushed Refresh, Stop and the action log out of view. It now
  uses the rows the pane has and leaves room for the buttons and three log lines.
- The pane's snapshot holds half-block cells in a terminal and an image in the desktop app, never
  both. Claude Code replaces an MCP result over about 100,000 characters with a
  notice, and a docked terminal pane's snapshot of Calculator came to 107,707 with both, so the
  pane showed "no frame in the result". Now it's 62,710 characters at 120 × 33 cells. The desktop
  image is a JPEG at most 640 px wide, 53,536 characters for Calculator.
- The update watch captures the engine's API docs without touching an app, so a pre-approved
  Calculator no longer puts its window in the snapshot.
- Checked live in a fullscreen terminal session: the docked pane showed Calculator with the full
  log. The benchmark runs headless without the pane, so it wasn't rerun.

## 0.12.0 (2026-10-05)

- A batch of clicks stops when an earlier action in the same call renumbers its target. Before each
  action the guard compares the element at that number with the one at the call's first action.
  Recording the demo, two takes garbled Calculator: the first click closed its history sidebar,
  every button shifted, and the rest of an 11-click batch hit the wrong keys. In the next take
  sleight stopped the batch at the second click, and Claude read again and got 1234 × 5678 right.
  Benchmark 12/12 (`docs/benchmarks/2026-10-05-release-0.12.0.json`), though no run there batched clicks.

## 0.11.0 (2026-10-05)

- Fewer reads per call. A read Claude makes is now a full read the relay turns into changed lines,
  and the window guard reuses it instead of reading the whole tree again after the call. Time added
  per call fell from 242 to 332 ms to 10 to 14 ms on the CNN front page, and from 46 to 88 ms to
  6 to 11 ms in Calculator (`docs/benchmarks/2026-10-05-guard-reads.md`).
- An untitled document that autosave gives a URL mid-call counts as the same window, outside
  document scope and change review. No change in turns was measurable.
- When an app stops answering, the message adds that the app itself may be hung if other apps still
  answer, before suggesting a ChatGPT restart. The skill tells Claude not to set TextEdit text with
  `setValue`, after three TextEdit hangs that followed it.
- README rewritten for first-time readers. The in-session install command it gave wasn't valid; it
  now gives `/plugin marketplace add` and `/plugin install`, checked on a fresh Claude config.
  Known problems, settings, how it works and the benchmark moved to `docs/`.
- Benchmark: 12/12 in two full passes. Two TextEdit-only reruns in between went 0/9 and 7/9, one
  TextEdit hang and its aftermath (`docs/benchmarks/2026-10-05-release-0.11.0.json`).

## 0.10.0 (2026-10-05)

- Compaction handles pages that renumber. Lines are matched by their text without the element
  number, and elements whose only change is a new number are counted instead of listed. The relay
  refuses actions on numbers that changed until Claude reads them again, and on computed numbers in
  that state. On the CNN front page, five scrolls sent 39,655 characters instead of 203,160; in
  click trials the relay refused 8 stale numbers and let 6 current ones through, none wrong
  (`docs/benchmarks/2026-10-05-compact-reads.md`). Benchmark 12/12. Two of its three refusals stopped a
  click that would have hit the next menu item, because an open menu had shifted the numbers by one.
- When the engine's helper fails to start ("native pipe startup failed"), the result says no app got
  the call and tells Claude to retry once, then `js_reset` and retry.

## 0.9.1 (2026-10-05)

- Guard-read compaction works when a `js` call writes its own output before the guard's read. In
  0.9.0 those reads went whole with the relay's internal mark visible. Benchmark 12/12. In Helium, a
  click on a page with a 120-item sidebar sent 428 characters instead of 35,532; scrolls on the CNN
  front page still go whole, because lazy loading renumbers the elements
  (`docs/benchmarks/2026-10-05-compact-reads.md`).

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
