# Known problems

What doesn't work, or works only partly, with the measurements behind it. We found all of these in
our own runs. Dates and engine versions are given where they matter.

- The real-use benchmark has 3 completed model trials against 18 requested, with 1 pass
  (2026-10-08). Safari wasn't running, so all three setups failed before a model call.
  Helium passed once and failed twice after browser permission requests were dismissed.
  The system-only observer missed those requests. The refusals were found after all three trials,
  and further live runs stopped. Their process and window title weren't observed.
  The streamed refusal stop gate and fresh observation before cleanup have passing unit tests,
  but no new live proof. Native setup and cleanup don't use Apple Events. Safari must already be
  running. Helium retains only its new fixture window, without reading the owner's existing windows.
  The cooperative lock is released on exit, even when helper collection remains unconfirmed.
  [The round-2 report](benchmarks/2026-10-08-real-use-tasks-2.md) retains all attempts and remaining
  qualification. [The initial report](benchmarks/2026-10-08-real-use-tasks.md) retains the earlier
  Safari Automation prompt and unconfirmed cleanup. Safari was absent at the round-2 preflights.

- Native `app.paste` temporarily changed the clipboard, then restored all measured bytes in 4/4
  fixtures. Text entry and engine drag left it unchanged in 4/4 each. Local drag did in 2/2.
  Copy/Cut use the user's clipboard by default, so deliberate copies remain available to menu Paste,
  `pbpaste` and browser pastes. Preservation is opt-in with `SLEIGHT_CLIPBOARD=preserve`. In that mode,
  Copy/Cut save a private session copy and restore the prior bytes. Their results say the copy is
  private. [The measurements](benchmarks/2026-10-04-clipboard.md) include every attempt and failure.
- Opt-in preservation added median call times of 236 ms for Copy, 205 ms for Cut and 226 ms for Paste
  in three trials each on this Mac. Clipboard helper and coordination time accounted for about
  180, 177 and 179 ms respectively. Separate runs include engine timing variation; larger payloads
  may cost more. Native sessions skip this work.
- Preservation cannot snapshot unreadable formats, file promises or more than 64 MiB. It falls back
  to the native shortcut and tells Claude the clipboard was not preserved. Claude must never modify
  the user's clipboard to get around that fallback. Menu actions and browser handles are outside
  preservation, so those pastes cannot use the private copy. Use a native session to copy for the user.
  In preservation mode use literal shortcut keys and one clipboard action per JavaScript request.
  Split calls and retry when the clipboard message asks. Ordinary native sessions have no such limit.
- A failed Copy/Cut cannot attribute new clipboard data, so preservation leaves that data alone.
  Two or more generations stop restoration. One generation could be an outside copy if the app did
  not copy. macOS has no atomic compare-and-restore, and arbitrary JavaScript can bypass the proxy.
  Private copies end with a successful reset or session exit. A process crash during private Paste
  can leave temporary data on the clipboard. File URLs preserve references, not deleted files or
  file-promise providers. Native sessions and other tools do not take the preservation lock.
- Exact window selection is unavailable on macOS. Engine 26.1002.52244's docs say `getApp({ windowId })`
  is for Linux and Windows and macOS takes an app name, path or bundle ID (not retested live). On
  26.930.31730 the API listed
  `cua.getApp({ windowId })`, but it rejects that selector with "macOS getApp requires an app name,
  path, or bundle ID." `cua.getState()` also omits window IDs. With two temporary TextEdit documents,
  3/3 exact selections were rejected before editing. `select_window` uses AXRaise/AXMain instead:
  3/3 with the plugin tool, plus 6/6 with the same approach in prototypes.
  The intended TextEdit document was edited and sampled foreground state was unchanged. This depends on the app supporting those Accessibility operations and
  exposing a unique title or AXDocument URL. Other apps remain untested. During an active selection, the relay marks changed or missing action
  window headers as "outcome unconfirmed". [Attempt results](benchmarks/2026-10-04-window-targeting.md) include the failures.
- Browser call text never turns off native guards. The engine must confirm `browserUse` on its reply
  before sleight learns browser handles. Candidates attempt the known native window lease and
  saved-file checks; when native access is unavailable, their runtime guard denies native access
  while browser operations remain usable. These guards remain cooperative, not JavaScript isolation.
  Flow rules use one `browser` source and destination
  for all tabs, with literal fills, typing and navigation URLs checked. They do not distinguish
  sites or tabs. Clipboard transfers and runtime strings remain outside those checks. Native
  document scope and saved-file change review do not cover browser tabs. Browser discovery runs
  once at startup; connecting an extension later requires a new sleight session or an explicit
  `SLEIGHT_SURFACES` override. An installed extension can be absent from the engine's live inventory.
- [Input leases](design/input-lease.md) let one sleight session act on a window at a time.
  Another session gets the holder's name and time left, while reads remain available. Leases expire
  after 30 seconds without renewal and end with the turn or session. Local drag and hover reserve the app,
  while menu and notification actions reserve the desktop. Other tools, including Codex,
  do not take these leases, and arbitrary JavaScript can bypass the injected guard.
- Anything moving your real pointer in the app interrupts it. The engine watches real mouse and keyboard
  input to notice a person taking over, then makes Claude re-read the app. Another agent driving in the
  foreground counts too. Background sessions share the helper, with leases coordinating sleight's actions.
  In one test where Codex was also driving in the foreground, keystrokes typed
  during the run showed up twice, and we still don't know why. A
  [two-engine probe](benchmarks/2026-10-04-double-keys.md) didn't reproduce it in 30/30 trials
  (engine 26.930.31730, 2026-10-04).
- The engine's `app.drag` failed TextEdit text moves 9/9. Local `drag` passed the benchmark 3/3
  before the window/content guards. Later [two-window checks](benchmarks/2026-10-04-drag-window-guards.md)
  passed 8/8 (four refusals, four exact moves), with about 4.5 s of foreground pointer use per call.
  Ambiguous windows require `windowId`. TextEdit endpoints must share a text area. AX scans refuse
  above 300 elements or 12 levels ([review fixes](benchmarks/2026-10-04-drag-round-2.md)).
  Lost-text errors require Cmd+Z; whitespace-only selections refuse.
  [Spacing repair](benchmarks/2026-10-04-drag-polish.md) covers unique whole words at line ends.
  Other selections need a spacing check, and concurrent edits can confuse snapshot comparisons.
  The old-helper live reproduction was blocked by another session's larger window.
  Both drag paths set AXMain and raise the window selected by `windowId`, then require it above same-app windows
  at both endpoints. Foreground fallback also refuses covering apps.
  Off-screen windows must be brought to the current desktop for drag or hover.
  [Stacked Chess checks](benchmarks/2026-10-04-drag-raise.md) moved the selected pawn 1/3
  submitted drags; two posts left both boards unchanged, and one later setup failed before posting.
  Screenshot points were used because AX square coordinates are reversed. Fixture cleanup was verified.
  Calculator content guards remain unmeasured.
  The [background prototype](benchmarks/2026-10-04-background-text-drag.md) moved TextEdit text
  4/4 after correcting its drop geometry, but joined `gammaalpha`. The product now uses that path
  first and repairs the verified space. It only works when no other app's window covers the drag
  points, because macOS picks the drop target from what's on screen there: 3/3 TextEdit moves with
  the window uncovered, 0/3 with this Claude window over it (2026-10-05). When another app covers
  either point, or the posted drag leaves the text unchanged, the tool moves the text through
  Accessibility instead, with no pointer or focus change. It maps the drop point to a character, puts
  the word there and takes it out at the source with TextEdit's spacing, then checks the whole text.
  After an Accessibility text write, TextEdit's next Cmd+S deadlocked on the document's save lock in 10
  of 13 probe trials with the file opened through the Open panel (0 of 3 opened with `open -g`), the
  same hang as `setValue` on 2026-10-05. One Shift press and release posted to TextEdit's process after
  the write prevents it: 0 hangs in 10 trials that edited, against 5 in 8 without it, and then 10
  `drag` moves in a row saved with no hang (2026-10-09). We don't know why the event helps, or what
  held the lock. The move inserts plain text, so a moved word in a rich text document takes the
  formatting at the drop point, and undoing it takes two Cmd+Z. Other apps' text areas haven't been
  tried. The foreground drag is the last resort. On 2026-10-08 it took the owner's focus mid-sentence
  during a pass, and a typed space went into TextEdit, so it now waits for 2 s without any input (up
  to 10 s), and stops if keys are typed once it has taken focus. Before the
  named-window raise guard,
  [product trials](benchmarks/2026-10-04-background-drag-product.md)
  passed 3/3 TextEdit moves, with TextEdit inactive and the front app unchanged. The owner moved the
  pointer during one trial; it was unchanged throughout the other two.
  `CGEventSetWindowLocation` is a private macOS API. Missing symbols, invalid events or coordinates that fail the
  round trip skip background posting and select foreground. Future macOS updates may
  break this path. A changed, unreadable or lost text snapshot never permits a second drag.
  Apps without a text snapshot report unverified background delivery and need a read to verify the
  move. They do not repeat the drag automatically. Calculator content guards remain unmeasured.
  Chess AX square coordinates were vertically reversed: two local posts and an engine control
  at those points left e2 unchanged. Screenshot coordinates moved e2 to e4 through the product's
  background path. Pointer and front app varied during that trial, so quiet Chess delivery remains
  unmeasured. Use the engine's `app.drag` first for Chess, and read the board after any local post.
  Chess save/close recovery selected another session's game even after the owned window's
  `AXMain` and `AXRaise`. It refused further engine input. The last native read still found the
  product fixture (window 240864) open on e4. Its save and close remain unverified.
- There's no background hover, since engine events go to the app and the real pointer never moves. The skill covers
  most cases: tooltips are readable as `Help:` text in the UI state, and hover menus usually open through
  an element's secondary actions, a right-click or a key. Mouse-moved events posted to a background app
  arrive, but they don't trigger hover: no enter or exit fired on the probe app's hover area, and a
  GitHub Desktop button looked the same pixel for pixel (2026-10-04). UI that only reacts to a real
  pointer can use sleight's local `hover`. The locked trials on 2026-10-04 support its 1500 ms default.
  Calculator's sidebar tooltip was absent in 1/1 capture at 400 ms and 1/1 at 1000 ms, then readable
  in 1/1 at 1500 ms. Chess's green-button hover menu was visible in 1/1 capture at 400 ms and 1/1
  at 1500 ms in the final trial. These small samples support the default. Exact onset remains unmeasured.
  Successful 1500 ms trials reported 1786 to 1798 ms for takeover. [All attempts](benchmarks/2026-10-04-local-hover.md)
  include the setup and capture failures too. Hover captures screen pixels in the selected window's rectangle.
  A window spanning displays can include another app in that rectangle, as a Chess trial showed.
  The point check does not guard the whole capture. Keep the window within one display and inspect
  screenshots before sharing them. The affected trial's PNGs were withheld after privacy review.
  Chess titles and TextEdit home-folder labels identified the user in published evidence. Those strings
  are now placeholders, and the four affected PNGs were removed. Future hover trials redact text on
  write and omit Chess and TextEdit PNGs. Historical Chess plans need a current title before reuse.
  A tooltip or menu outside the rectangle is clipped. Hover requires Screen Recording permission
  before takeover. It refuses coverage by another app or a different window of the same app;
  do not retry unchanged.
  Cleanup attempts to restore the pointer and front app on ordinary failures; forced helper termination
  can interrupt it. Hover's own pointer and front-app restoration has not been measured separately in
  live trials. The fixture also restores both, so its successful checks do not prove hover's restoration.
  It does not restore the full window order. Earlier fixture pointer mismatches remain unresolved.
  Since 0.16.0, hover and the `menu_bar` real click wait like the foreground drag for 2 s without
  input (up to 10 s), and hover fails if keys are typed while it holds focus. Hover's guard has unit
  tests. The `menu_bar` guard has none, and neither has had a live run.
- The desktop app's Code tab runs Claude Code 2.1.293 (2026-10-08), new enough for the mod. The owner
  checked it in Auto mode twice. On 0.15.2 the pane drew no picture, because Auto mode refused its
  snapshot. On `0.15.3-pane.2` it worked: `/sleight` opened the pane and sent the prompt, Claude
  used sleight from its first call, the pane showed Calculator's picture and 6 actions, and the
  status line showed `Calculator · 6 actions`. The desktop's own command picker still says
  "/sleight isn't a command here", though the mod handles it. `/sleight stop` hasn't been checked
  there.
- When you work in a full-screen or Split View Space, apps sleight drives in the background are on
  another Space. Clicks and typing still reach them, but the engine's `app.drag` answers
  `noWindowsAvailable`, sleight's `drag` refuses the off-screen window, and TextEdit's reads timed
  out. A pass with the Claude app in Split View failed 8 of 21 runs, all in TextEdit, Chess and the
  simulator (`docs/benchmarks/2026-10-08-await-split-view.json`). Moving a window into a full-screen
  Space needs private macOS APIs, so leave full screen while sleight drags.
- Without the mod, the relay ends the engine's turn once no sleight call has run for 30 seconds, which
  releases the app the engine was holding (its badge on the app's window). Before 0.3.1 nothing ended
  the turn until the session closed. Desktop sessions twice showed as busy after Claude had finished,
  and ending the turn cleared it once, so the open turn is the likely cause.
  `SLEIGHT_IDLE_TURN_END_MS` changes the wait, and 0 turns it off.
- Change review covers saved files observed before `js` actions. A file first seen after an action
  needs a fresh standalone read before editing. Undo then starts at that later copy.
  Unsaved buffers, Save As targets,
  menu bar and pointer tools have no before copy. Undo changes the saved file, so reopen it before
  editing again. Autosave or a user edit after an action makes undo refuse. Arbitrary JavaScript can
  bypass the window guard or forge headers. [The design](design/change-review.md) lists the limits.
- Flow rules check literals and text values observed earlier. Runtime-built strings, encoded values,
  clipboard shortcuts, screenshots and coordinate drags can pass without a match. Source attribution
  and UI parsing can miss values or block harmless text. This guards mistakes; arbitrary JavaScript
  can bypass it. [The design](design/flow-rules.md) lists the limits.
- The native guard still needs full AX reads after preceding actions. Engine 26.1002.52244 exposes
  no header-only read, and its reply does not split AX, settling, capture and transfer time.
  On 2026-10-08, Calculator reads after Escape took median 413 to 437 ms, against 29 to 48 ms idle.
  Even waiting 700 ms first left a 413 ms read. The [engine timing study](design/engine-time.md)
  points to a wait on the next capture, without separating the native phases. Screenshots now reuse
  the AX observation captured with the image. Each of two Chess sequences saved one read.
  Click-only and typing batches keep their existing read counts. The product retains every
  intermediate identity and selector check.
- In a TextEdit typing probe on 2026-10-08, select-all followed by `typeText("engine01")` and save
  left `Engine01engine01` instead of replacing the text. Part of it is macOS auto-capitalization,
  which `typeText` goes through: a later probe typed "sleight is here. it works" and TextEdit saved
  "Sleight is here. It works", while `paste` saved it exactly. We don't know why select-all didn't replace the old text.
  A separate digit probe passed all five key-by-key and five bulk replacements. The skill says to
  paste exact text and to read the result. [All attempts](benchmarks/2026-10-08-engine-time.json)
  include the failure and later fixture cleanup.
- After every `js` action without a later reusable observation, sleight's window guard reads the whole tree again so the input lease can
  check the window header. Since 0.9.0 Claude gets only the lines that changed since the last full
  tree it saw for that window ([measurements](benchmarks/2026-10-05-compact-reads.md)). A first
  read, a new window or dialog, or a page that re-renders and renumbers its elements still comes
  through whole. On TextEdit and Chess the result text per run fell 1 to 23%. In Helium, a click on
  a local page with a 120-item sidebar sent 428 characters instead of 35,532, and five scrolls on
  the CNN front page sent 39,655 instead of 203,160. When loaded content renumbers elements, Claude
  gets the count instead of the lines, and the relay refuses actions on numbers that changed until
  Claude reads them again (8 refusals, 6 correct passes and none wrong in CNN trials). Literal
  numbers only: a call that computes an element number is refused in that state. If Claude Code summarizes the conversation, Claude can lose the tree a diff refers
  to, as with the engine's own diffs. A read with `disableDiffing: true` comes through whole.
- TextEdit hung 3 times on 2026-10-05, each time after Claude set a document's text with `setValue`
  and then pressed a save shortcut (Cmd+Shift+S, which is Duplicate, twice and Cmd+S once). Its main
  thread waits forever on the document's save lock. Every read then times out, and the relay's
  message named a stuck helper. Quitting TextEdit recovered it every time. The relay now checks
  target AX and a fresh engine read of another acquired app before advising an app quit or helper
  restart. The skill tells Claude to select and type in TextEdit
  instead of using `setValue`, and to use Cmd+S or File > Save As.
- On 2026-10-06 TextEdit timed out every engine read after an AppleScript `close every document
  saving no`. It still answered AppleScript, but its only window was an orphan "Save Panel Accessory
  View" that Accessibility didn't list. The relay's message again named a stuck helper, while
  `--doctor` passed. Quitting TextEdit fixed it.
- On 2026-10-09 the owner's keyboard stopped working, while the trackpad still did, after a
  head-to-head pass ran the simulator task on both arms. Device Hub, left open after those runs,
  held a keyboard event filter tap whose last key had taken 40 s, and a filter tap holds up every
  key on the Mac. Quitting Device Hub fixed it at once. We don't know what stalled it. Codex's
  simulator run had sent it 24 tool calls in 123 s, sleight's 7 turns in 35 s. The benchmark now
  quits the simulator app after each simulator run, and stops a pass if any benchmark app still
  holds a keyboard filter tap after a run. A user driving a simulator through sleight could hit the
  same stall; if keys stop working, quit Device Hub or Simulator.
- In the iPhone simulator (2026-10-07), Claude's first `typeText` into a Safari field once came out
  garbled and uppercased, and its paste fallback inserted other text: the simulator shares the
  Mac's clipboard. Claude cleared the field both times and typed it right, so 3/3 runs passed, but a
  paste there can put whatever is on your clipboard into the app.
- An action called without `await` that fails can end the engine's JavaScript session, and every
  handle with it (`app.click(1); "x"` on a disabled Calculator element, 3/3 on 2026-10-07). sleight
  notices when the engine's first-call docs come back without a `js_reset` and tells Claude, but the
  call that restarted it may have done nothing. Since 0.16.0 the relay refuses a call whose action is
  a statement without `await` with more code after it. It doesn't see an un-awaited action inside an
  expression or a callback, and a last statement is left alone because the call returns its promise.
- On 2026-10-08 two calculator-click runs took 16 and 10 turns instead of 5. Right after Calculator
  launched, its first read took 7.1 s, the IDs `AllClear` and `Seven` were missing and then came
  back, and one button's line changed from `Description: 7, ID: Seven` to `Seven` between reads.
  Each change stopped an action and cost Claude a turn. The Mac was under heavy load from other
  processes that day. We don't know whether the load or Calculator's launch caused it. In the next
  full pass that evening, all 6 Calculator runs took 3 or 4 turns. In the 0.16.0 pass, the first run
  after Calculator launched took 10 turns and 99.5 s, 31 s of it in guard reads.
- On 2026-10-07 `drag` once refused a Chess window launched in the background seconds earlier,
  because it couldn't find that window among Chess's accessibility windows. It matches by the window's AX number, or by bounds and
  title, and neither matched. The same kind of window matched in another run. Why is unknown.
  On 2026-10-08 (engine 26.1002.52244) it happened again in 1 of 3 runs, in a new game's window: the
  engine's drag answered `-10005 noWindowsAvailable` while reads of the window still worked, and
  `drag` reported the window off screen. The screen was unlocked and the display on. Later that day
  the benchmark's relaunch of Chess, right after quitting it, failed with LaunchServices error -600.
  The [2026-10-08 investigation](benchmarks/2026-10-08-reliability.md) completed ten fresh launches
  through each drag path after the operator authorized closing the leftover game. The engine's
  reads showed e4 in 10/10 calls. Independent AX verified 6/10. Local `drag` acknowledged 8/10 calls,
  with 3/10 moves independently verified. One local call refused a covered source point without
  input. Another ended in a command failure near its 30 s deadline. Native AX omitted e4 in nine
  further move checks, leaving their outcomes unconfirmed. The historical availability refusals occurred 0/20 times.
  In the covered-drags pass that evening, chess-drag passed 3/3 with no window refusal.
  Every selected window was on screen at layer 0 with matching CG/AX bounds. All twenty launches
  succeeded after confirmed process absence, without a -600 retry. Space, the historical window
  state and the native command failure's cause remain unknown. Some window captures returned black
  pixels. Clear captures confirmed that Chess's AX square Y positions were inverted; this does not
  explain a window-availability refusal. An off-screen refusal now tells Claude to have the user show that exact window,
  reacquire the app, and take a fresh screenshot before using current window IDs and coordinates.
  It never retries the old drag or substitutes another window. In a separate minimized-window control,
  the refusal left the board unchanged, and restoring and reacquiring the same window led to a verified
  move (1/1). Recovery from another Space remains untested.
  The benchmark's force-quit fallback
  could return before process exit. Launch now waits for absence and retries only -600, at most
  three times. Unit boundaries pass. The historical -600 cause remains unproved.
- The engine's helper can stop answering. On 2026-10-04 every `cua.getApp` timed out
  (`-10005 timeoutReached`) for about 25 minutes, with the Mac unlocked and in use, until ChatGPT was
  restarted. We don't know the cause. It started right after a test that kills engine processes.
  In 18 completed SIGKILL trials, reads passed before and after cleanup. Killing a responding helper
  relaunched it, but no wedge was reproduced, so helper-only recovery from a wedge remains unproven.
  After two consecutive `timeoutReached` failures on standalone reads of one app, the relay checks
  target AX, another acquired app's AX and a fresh engine read of that control app. A responding
  control points to the target app. ChatGPT restart advice requires both AX processes to respond
  with windows and an actual engine control timeout. Missing evidence stays unknown.
  In [owned fixture trials](benchmarks/2026-10-08-reliability.md), the original relay misdiagnosed
  1/1 completed hang runs (two actual read timeouts). Revised diagnosis identified the app in 6/6
  runs (twelve timeouts), with no ChatGPT restart advice. The last three runs also verified full visible
  control and recovered fixture reads. The first three exposed a compactor defect now covered by tests.
  One earlier harness deadline failure remains in the receipts. No shared helper wedge was induced.
  Claude stops retrying. sleight retries by itself.
  For that app, `js` reads are refused between recovery attempts (at most one every 20 seconds),
  and `js` actions using its known handles are refused until a read succeeds. After hidden recovery,
  actions wait for a visible app read, which sleight makes a full read. Other apps, documentation,
  `js_reset`, and turn cleanup remain available. Inventory failures have their own retry counter.
  App identity comes from literal acquisitions, known handles and learned bundle aliases. Arbitrary
  JavaScript can bypass this advisory check. Independent checks establish evidence for the advice,
  not the native cause of a shared helper fault.
  Doctor probes inventory, which does not prove that every app's accessibility read works. Before
  0.7.0 it also reported "ok" when the helper couldn't start at all.
  [The investigation](benchmarks/2026-10-04-helper-health.md) records each live attempt.
- The helper quits about 20 seconds after it goes idle and relaunches on the next call. A call
  during that restart can fail with "native pipe startup failed" before it reaches any app; another
  session hit it three times in a row on 2026-10-05 while doctor passed, and we don't know why it
  repeated. sleight now tells Claude to retry once, then `js_reset` and retry.
- The helper can also fail to start. On 2026-10-05 it quit normally when doctor's session ended, and
  every later launch failed with "Sky Computer Use service startup request failed" for at least five
  minutes: launchd still held the old job and answered "Operation already in progress". Removing that
  job with `launchctl remove` fixed it at once, without restarting ChatGPT, and the next four helper
  launches worked. We don't know what left the job behind. Doctor now detects this and prints the
  command.
- ChatGPT updates can break it. The version lookup handles the folder moving around, but not the API
  changing. Run `--doctor` first when something stops working.
- The engine has no access to an app's icon in the menu bar or to notification banners: its inventory has
  no Control Center or Notification Center, and `getApp("com.apple.controlcenter")` times out (engine
  26.930.31730, 2026-10-03). sleight's `menu_bar` and `notifications` tools cover those instead (see
  [How it works](how-it-works.md)). They work in the foreground: an open menu shows on screen and takes
  the keyboard until sleight closes it. Icons that open a SwiftUI window (`MenuBarExtra` in window
  style) ignore the accessibility press, so sleight clicks them for real and puts the pointer back.
  Controls without a label, tooltip or identifier get names such as `Button at (10, 20)`, measured
  from the window's top-left corner, or `Button 3` if AX has no position. Their element numbers
  remain the arguments to `press`. The fallback names and press mapping have unit tests; an
  unnamed live popover button has not been checked with an approved app.
- The engine refuses some apps outright ("not allowed … for safety reasons"): terminals (Terminal,
  iTerm2) and OpenAI's own apps (ChatGPT, Codex, Atlas, with their beta builds). The list is built
  into the engine's helper, so no approval changes it. It also respects any app blocks your
  organization sets. To stop Codex asking for approvals, change Codex's own approval setting. With
  your opt-in, sleight can drive these apps through its own Accessibility path (see
  [Driving apps the engine refuses](settings.md#driving-apps-the-engine-refuses)); the engine's refusal itself
  stays. On that path, settings refusal checks the window title and the window's toolbar (Terminal
  titles its settings window after the open pane, like "General"), so a localized title and a pane
  name can pass it. Background scroll reaches the app's focused view. System Events' keystroke
  doesn't act on
  an embedded newline in Terminal, so blocked_app sends one Return key press per newline instead.
  The window screenshot needs Screen Recording for the app that runs Claude Code, on top of the
  Accessibility permission `menu_bar` and `drag` already need, and it captures only a window that is
  on screen. In the live check the Codex app's window exposed only its window-control buttons to the
  driver's walk (its UI is web content), so a harmless click there had no target; Claude refused the
  window controls and reported, which is the intended behavior.
- `claude -p` can't answer approval prompts. List apps in the user's [preapproval file](settings.md#preapproved-apps)
  before starting. Unlisted apps and requests above their listed risk still need a person.
- The preapproval loader proves file ownership, not who wrote it. Any process running as you,
  Claude included, can write the file. The skill tells Claude never to create or edit it, but this
  rule depends on Claude following the instruction.
- Calculator button indices changed during a [preapproval trial](benchmarks/2026-10-04-preapproved-apps.md),
  producing the wrong expression. A filtered read then lost the window header, and the input lease
  stopped the retry. Use current indices from full UI reads, and preserve their window headers.
  Since 0.13.0, `{ id }` and `{ label }` address Calculator's buttons without indices.
- Document scope checks the last observed window before forwarding a call and stops on changed or
  missing Window/URL headers. Its injected action guard checks again, but arbitrary JavaScript can
  bypass it or forge observations. Result checks cannot undo actions already taken. Discovery reads
  can expose other windows' contents, and equal titles without URLs are indistinguishable.
- It's macOS on Apple Silicon only. The engine's JavaScript has Linux and Windows instructions, but
  the helper that clicks and types comes only with the Mac ChatGPT app, and there's no ChatGPT desktop
  app for Linux (checked 2026-10-04). We haven't checked the Windows app.
